# mend

`mend` is a single-file command-line tool that applies an edit written by an AI
model to a tree of text files. Models produce edits in several different
formats; `mend` reads all of them, applies them to the working directory, and
either changes every file the patch touches or — if any edit fails — changes
nothing at all and reports every failure.

It runs on Node 22+ using only the standard library. There are no
dependencies to install.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent, or is `-`, the patch is read from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or
  `json`. The default, `auto`, detects the format from the patch text.
- `--check` does everything except write: same output and exit code, but no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only, see below).
- `--` ends the options; every argument after it is positional.

On success `mend` prints one line per changed path (`A` added, `D` deleted,
`M` modified, `R <old> -> <new>` moved), sorted in UTF-8 byte order, followed
by `ok: <n> files`. On failure it prints one `error: <code> <path>` line per
failed edit in patch order, then `failed: <k> of <n> edits`, and exits 1 with
nothing written. Usage errors, an unreadable patch file, an undetectable
format and parse errors exit 2 with a single line (`error: usage`,
`error: no-patch`, `error: format`, `error: parse <N>`).

Paths in a patch must be safe: relative, with no backslashes and no empty,
`.` or `..` segments. An edit naming an unsafe path fails with `unsafe`
before anything else about that edit is considered.

## The four formats

1. **Unified diff** — `diff --git` sections with `---`/`+++` headers, rename
   lines, `new file mode` / `deleted file mode`, and `@@` hunks. Hunk line
   numbers are treated as hints only: each hunk's old lines are located by
   matching, and the occurrence nearest the stated position is taken. A
   section is one edit: a creation, a deletion, a move (old and new path
   differ, with the hunks applied on the way), or a change.
   `\ No newline at end of file` markers control whether the result ends
   with a final line break when a hunk reaches the end of the file, and
   whether a created file ends with one.
2. **SEARCH/REPLACE** — a path line followed by `<<<<<<< SEARCH`, the old
   lines, `=======`, the new lines and `>>>>>>> REPLACE`. An empty old side
   creates the file; otherwise the old lines must occur exactly once at
   their matching tier, or the block fails as `ambiguous`.
3. **V4A** — `*** Begin Patch` … `*** End Patch` with `*** Add File:`,
   `*** Delete File:` and `*** Update File:` sections. Update sections may
   start with `*** Move to:` and hold `@@`-anchored chunks applied in order
   behind a cursor; a `*** End of File` line anchors its chunk to the last
   line of the file.
4. **JSON** — either one JSON array of edit objects, or JSON Lines with one
   object per line. Commands: `create` (writes `file_text` byte for byte),
   `str_replace` (exact text match, exactly once, with CRLF files handled by
   translating line breaks both ways) and `insert` (inserts `new_str`'s
   lines after a given line number).

## Matching: three tiers

Unified hunks, SEARCH/REPLACE blocks and V4A chunks name old lines that are
found in the file at the first tier where they occur at least once:

- **Tier 0** — every line exactly equal;
- **Tier 1** — equal once trailing spaces and tabs are removed;
- **Tier 2** — equal once leading and trailing spaces and tabs are removed.

At tier 2 the replacement is re-indented: context lines are always written
as the file's own matched lines, and every other new line that starts with
the old block's indentation has that indentation replaced by the file's.
`--strict` restricts matching to tier 0. Line breaks are preserved per file:
a CRLF file stays CRLF, and a changed file keeps its original final-break
state unless a unified hunk's `\ No newline` marker says otherwise.

## Atomicity

Edits apply in patch order, each one seeing the tree as the earlier edits
left it, and each edit is simulated in memory before anything is written.
A failed edit changes nothing, later edits still run so every failure is
reported, and if any edit failed no file is written at all.

## make.fun

This entry was built for the make.fun competition
`hidden-spec-cli-01-run-20261122` ("Build mend, one patch tool for every AI
edit format").

![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jontumpil/makefun-hidden-spec-cli/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jontumpil/makefun-hidden-spec-cli/reward.svg)
