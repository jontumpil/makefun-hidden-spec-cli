// mend: one patch tool for every AI edit format (see SPEC.md).
// Node 22+, standard library only. When MAKEFUN_ENV_URL is set the trial is
// handed to runTrial from runner.ts and the CLI does not run.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

/* ---------------- files as lines (SPEC section 3) ---------------- */

interface FileState {
  lines: string[];
  lb: string; // '\n' or '\r\n'
  fin: boolean; // ends with a line break
}

function parseText(text: string): FileState {
  let lb = '\n';
  const idx = text.indexOf('\n');
  if (idx > 0 && text[idx - 1] === '\r') lb = '\r\n';
  if (text === '') return { lines: [], lb, fin: false };
  const parts = text.split(lb);
  let fin = false;
  if (text.endsWith(lb)) {
    fin = true;
    parts.pop();
  }
  return { lines: parts, lb, fin };
}

function serialize(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.lb) + (f.fin ? f.lb : '');
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/* ---------------- errors and edit results ---------------- */

class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

interface Fail {
  code: string;
  path: string;
}

interface ApplyRes {
  f: Fail | null;
  m?: { o: string; n: string }; // a successful move
}

interface Edit {
  apply: (work: Map<string, FileState>, strict: boolean) => ApplyRes;
}

const okRes = (m?: { o: string; n: string }): ApplyRes => (m ? { f: null, m } : { f: null });
const failRes = (code: string, path: string): ApplyRes => ({ f: { code, path } });

function firstUnsafe(paths: string[]): string | null {
  for (const p of paths) if (!isSafe(p)) return p;
  return null;
}

/* ---------------- matching (SPEC section 5) ---------------- */

type EntType = 'ctx' | 'del' | 'add' | 'old';
interface Ent {
  t: EntType;
  s: string;
  nn?: boolean; // a `\ No newline at end of file` line follows this body line
}

const rstripST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierText(tier: number, s: string): string {
  if (tier === 0) return s;
  if (tier === 1) return rstripST(s);
  return trimST(s);
}

interface Found {
  tier: number;
  positions: number[];
}

function findAll(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    const ot = o.map((s) => tierText(tier, s));
    for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let match = true;
      for (let k = 0; k < o.length; k += 1) {
        if (tierText(tier, lines[i + k]) !== ot[k]) {
          match = false;
          break;
        }
      }
      if (match) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function findAnchor(lines: string[], anchor: string, strict: boolean, cursor: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = tierText(tier, anchor);
    for (let i = Math.max(0, cursor); i < lines.length; i += 1) {
      if (tierText(tier, lines[i]) === want) return i;
    }
  }
  return -1;
}

// Resolve the new lines of a match: context lines come from the file itself,
// and at tier 2 the other lines are re-indented from O's first line to the
// file's first matched line (SPEC section 5).
function resolveN(ne: Ent[], oe: Ent[], fileLines: string[], pos: number, tier: number): string[] {
  const oCtx: number[] = [];
  oe.forEach((e, i) => {
    if (e.t === 'ctx') oCtx.push(i);
  });
  let ci = 0;
  return ne.map((e) => {
    if (e.t === 'ctx') {
      const oi = oCtx[ci];
      ci += 1;
      return fileLines[pos + oi];
    }
    let s = e.s;
    if (tier === 2 && oe.length > 0) {
      const f = leadST(fileLines[pos]);
      const p = leadST(oe[0].s);
      if (s !== '' && !/^\s*$/.test(s) && s.startsWith(p)) s = f + s.slice(p.length);
    }
    return s;
  });
}

function spliceLines(lines: string[], pos: number, remove: number, insert: string[]): string[] {
  return [...lines.slice(0, pos), ...insert, ...lines.slice(pos + remove)];
}

/* ---------------- unified diffs (SPEC section 6) ---------------- */

interface Hunk {
  a: number;
  ents: Ent[];
}

interface Section {
  pairOld?: string | null;
  pairNew?: string | null;
  diffOld?: string;
  diffNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile?: boolean;
  delFile?: boolean;
  hasPair: boolean;
  header: boolean;
  hunks: Hunk[];
}

function pathArg(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.replace(/^ +/, '').replace(/ +$/, '');
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseDiffGit(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  if (!m || m[1] === '' || m[2] === '') throw new ParseErr(lineNo);
  return [m[1], m[2]];
}

function isDiffGitLine(line: string): boolean {
  return line.startsWith('diff --git ') || line === 'diff --git';
}

function parseUnified(L: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const startSection = (): Section => {
    const s: Section = { hasPair: false, header: true, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < L.length) {
    const line = L[i];
    if (isDiffGitLine(line)) {
      const [o, n] = parseDiffGit(line, i + 1);
      const s = startSection();
      s.diffOld = o;
      s.diffNew = n;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new ParseErr(i + 1);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!hm) throw new ParseErr(i + 1);
      cur.header = false;
      const a = parseInt(hm[1], 10);
      i += 1;
      const raw: string[] = [];
      while (i < L.length) {
        const bl = L[i];
        if (isDiffGitLine(bl)) break;
        if (bl.startsWith('--- ') && i + 1 < L.length && L[i + 1].startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          raw.push(bl);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const ents: Ent[] = [];
      for (const r of raw) {
        if (r === '') ents.push({ t: 'ctx', s: '' });
        else if (r[0] === ' ') ents.push({ t: 'ctx', s: r.slice(1) });
        else if (r[0] === '-') ents.push({ t: 'del', s: r.slice(1) });
        else if (r[0] === '+') ents.push({ t: 'add', s: r.slice(1) });
        else if (r[0] === '\\') {
          if (ents.length > 0) ents[ents.length - 1].nn = true;
        }
      }
      cur.hunks.push({ a, ents });
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextOk = i + 1 < L.length && L[i + 1].startsWith('+++ ');
      if (cur && cur.header) {
        if (!nextOk) throw new ParseErr(i + 2);
        const target = cur.hasPair ? startSection() : cur;
        target.pairOld = pathArg(line);
        target.pairNew = pathArg(L[i + 1]);
        target.hasPair = true;
        i += 2;
        continue;
      }
      if (nextOk) {
        const s = startSection();
        s.pairOld = pathArg(line);
        s.pairNew = pathArg(L[i + 1]);
        s.hasPair = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur && cur.header) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).replace(/^ +/, '').replace(/ +$/, '');
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).replace(/^ +/, '').replace(/ +$/, '');
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => makeUnifiedEdit(s));
}

function makeUnifiedEdit(sec: Section): Edit {
  const oRaw = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const nRaw = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const creation = oRaw === null || sec.newFile === true;
  const deletion = !creation && (nRaw === null || sec.delFile === true);
  const oldP = typeof oRaw === 'string' ? oRaw : typeof nRaw === 'string' ? nRaw : '';
  const newP = typeof nRaw === 'string' ? nRaw : typeof oRaw === 'string' ? oRaw : '';
  const kind = creation ? 'create' : deletion ? 'delete' : oldP !== newP ? 'move' : 'change';
  return {
    apply(work, strict) {
      const paths = kind === 'create' ? [newP] : kind === 'delete' ? [oldP] : kind === 'move' ? [oldP, newP] : [oldP];
      const bad = firstUnsafe(paths);
      if (bad !== null) return failRes('unsafe', bad);
      if (kind === 'create') {
        if (work.has(newP)) return failRes('exists', newP);
        const lines: string[] = [];
        let lastAdd: Ent | undefined;
        for (const h of sec.hunks) {
          for (const e of h.ents) {
            if (e.t === 'add') {
              lines.push(e.s);
              lastAdd = e;
            }
          }
        }
        const fin = lines.length > 0 ? !(lastAdd && lastAdd.nn) : false;
        work.set(newP, { lines, lb: '\n', fin });
        return okRes();
      }
      if (kind === 'delete') {
        if (!work.has(oldP)) return failRes('missing', oldP);
        work.delete(oldP);
        return okRes();
      }
      const st = work.get(oldP);
      if (!st) return failRes('missing', oldP);
      if (kind === 'move' && work.has(newP)) return failRes('exists', newP);
      let lines = [...st.lines];
      let fin = st.fin;
      let d = 0;
      for (const h of sec.hunks) {
        const oe = h.ents.filter((e) => e.t === 'ctx' || e.t === 'del');
        const ne = h.ents.filter((e) => e.t === 'ctx' || e.t === 'add');
        if (oe.length === 0) {
          const pos = Math.min(Math.max(0, h.a + d), lines.length);
          const atEnd = pos === lines.length;
          const ins = ne.map((e) => e.s);
          lines = spliceLines(lines, pos, 0, ins);
          if (atEnd && ins.length > 0) fin = !ne[ne.length - 1].nn;
          d += ne.length;
        } else {
          const found = findAll(lines, oe.map((e) => e.s), strict);
          if (!found) return failRes('no-match', oldP);
          const target = h.a - 1 + d;
          let pos = found.positions[0];
          for (const p of found.positions) {
            if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
          }
          const matchedEnd = pos + oe.length === lines.length;
          const resolved = resolveN(ne, oe, lines, pos, found.tier);
          lines = spliceLines(lines, pos, oe.length, resolved);
          if (matchedEnd) {
            const lastN = ne[ne.length - 1];
            fin = lastN ? !lastN.nn : true;
          }
          d += ne.length - oe.length;
        }
      }
      const nst: FileState = { lines, lb: st.lb, fin };
      if (kind === 'move') {
        work.delete(oldP);
        work.set(newP, nst);
        return okRes({ o: oldP, n: newP });
      }
      work.set(oldP, nst);
      return okRes();
    },
  };
}

/* ---------------- SEARCH/REPLACE blocks (SPEC section 7) ---------------- */

const rtrimWS = (s: string): string => s.replace(/\s+$/, '');

function parseSearchReplace(L: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | undefined;
  let i = 0;
  while (i < L.length) {
    if (rtrimWS(L[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | undefined;
    for (let b = searchIdx - 1; b > prevEnd; b -= 1) {
      const t = L[b].trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === undefined) {
      if (prevPath !== undefined) path = prevPath;
      else throw new ParseErr(searchIdx + 1);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < L.length; j += 1) {
      if (rtrimWS(L[j]) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseErr(searchIdx + 1);
    let rep = -1;
    for (let k = eq + 1; k < L.length; k += 1) {
      if (rtrimWS(L[k]) === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(searchIdx + 1);
    const oldLines = L.slice(searchIdx + 1, eq);
    const newLines = L.slice(eq + 1, rep);
    edits.push(makeSREdit(path, oldLines, newLines));
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    apply(work, strict) {
      const bad = firstUnsafe([path]);
      if (bad !== null) return failRes('unsafe', bad);
      if (oldLines.length === 0) {
        if (work.has(path)) return failRes('exists', path);
        work.set(path, { lines: [...newLines], lb: '\n', fin: newLines.length > 0 });
        return okRes();
      }
      const st = work.get(path);
      if (!st) return failRes('missing', path);
      const found = findAll(st.lines, oldLines, strict);
      if (!found) return failRes('no-match', path);
      if (found.positions.length > 1) return failRes('ambiguous', path);
      const pos = found.positions[0];
      const oe: Ent[] = oldLines.map((s) => ({ t: 'old' as EntType, s }));
      const ne: Ent[] = newLines.map((s) => ({ t: 'add' as EntType, s }));
      const resolved = resolveN(ne, oe, st.lines, pos, found.tier);
      work.set(path, { lines: spliceLines(st.lines, pos, oldLines.length, resolved), lb: st.lb, fin: st.fin });
      return okRes();
    },
  };
}

/* ---------------- V4A patches (SPEC section 8) ---------------- */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  ents: Ent[];
}

interface VLine {
  s: string;
  no: number;
}

const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

function v4aHeader(line: string): { kind: 'add' | 'del' | 'upd'; path: string } | null {
  const prefixes: [string, 'add' | 'del' | 'upd'][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'del'],
    ['*** Update File: ', 'upd'],
  ];
  for (const [pre, kind] of prefixes) {
    if (line.startsWith(pre)) return { kind, path: trimSpaces(line.slice(pre.length)) };
  }
  return null;
}

function parseV4A(L: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < L.length; i += 1) {
    if (L[i].trim() !== '') {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new ParseErr(1);
  if (L[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  if (L[last].trim() !== '*** End Patch') throw new ParseErr(L.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = L[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const hdr = v4aHeader(line);
    if (!hdr) throw new ParseErr(i + 1);
    const secLine = i + 1;
    i += 1;
    const content: VLine[] = [];
    while (i < last && !v4aHeader(L[i])) {
      content.push({ s: L[i], no: i + 1 });
      i += 1;
    }
    while (content.length > 0 && content[content.length - 1].s.trim() === '') content.pop();
    if (hdr.kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.s.startsWith('+')) fileLines.push(c.s.slice(1));
        else if (c.s === '') fileLines.push('');
        else throw new ParseErr(c.no);
      }
      edits.push(makeV4AAdd(hdr.path, fileLines));
    } else if (hdr.kind === 'del') {
      if (content.length > 0) throw new ParseErr(content[0].no);
      edits.push(makeV4ADelete(hdr.path));
    } else {
      edits.push(makeV4AUpdate(hdr.path, content, secLine));
    }
  }
  return edits;
}

function makeV4AAdd(path: string, fileLines: string[]): Edit {
  return {
    apply(work) {
      const bad = firstUnsafe([path]);
      if (bad !== null) return failRes('unsafe', bad);
      if (work.has(path)) return failRes('exists', path);
      work.set(path, { lines: [...fileLines], lb: '\n', fin: fileLines.length > 0 });
      return okRes();
    },
  };
}

function makeV4ADelete(path: string): Edit {
  return {
    apply(work) {
      const bad = firstUnsafe([path]);
      if (bad !== null) return failRes('unsafe', bad);
      if (!work.has(path)) return failRes('missing', path);
      work.delete(path);
      return okRes();
    },
  };
}

function makeV4AUpdate(path: string, content: VLine[], secLine: number): Edit {
  let moveTo: string | undefined;
  let idx = 0;
  if (content.length > 0 && content[0].s.startsWith('*** Move to:')) {
    moveTo = trimSpaces(content[0].s.slice('*** Move to:'.length));
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (let k = idx; k < content.length; k += 1) {
    const c = content[k];
    const s = c.s;
    if (s.startsWith('@@')) {
      const anchorText = s.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, ents: [] };
      chunks.push(cur);
    } else if (s === '*** End of File') {
      if (!cur) {
        cur = { anchor: null, eof: false, ents: [] };
        chunks.push(cur);
      }
      cur.eof = true;
      cur = null;
    } else if (s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+') {
      if (!cur) {
        if (chunks.length > 0) throw new ParseErr(c.no);
        cur = { anchor: null, eof: false, ents: [] };
        chunks.push(cur);
      }
      if (s === '') cur.ents.push({ t: 'ctx', s: '' });
      else if (s[0] === ' ') cur.ents.push({ t: 'ctx', s: s.slice(1) });
      else if (s[0] === '-') cur.ents.push({ t: 'del', s: s.slice(1) });
      else cur.ents.push({ t: 'add', s: s.slice(1) });
    } else {
      throw new ParseErr(c.no);
    }
  }
  if (chunks.length === 0 && moveTo === undefined) throw new ParseErr(secLine);
  return {
    apply(work, strict) {
      const paths = moveTo !== undefined ? [path, moveTo] : [path];
      const bad = firstUnsafe(paths);
      if (bad !== null) return failRes('unsafe', bad);
      const st = work.get(path);
      if (!st) return failRes('missing', path);
      if (moveTo !== undefined && work.has(moveTo)) return failRes('exists', moveTo);
      let lines = [...st.lines];
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const p = findAnchor(lines, ch.anchor, strict, cursor);
          if (p < 0) return failRes('no-match', path);
          cursor = p + 1;
        }
        const oe = ch.ents.filter((e) => e.t === 'ctx' || e.t === 'del');
        const ne = ch.ents.filter((e) => e.t === 'ctx' || e.t === 'add');
        if (oe.length === 0) {
          const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
          const ins = ne.map((e) => e.s);
          lines = spliceLines(lines, pos, 0, ins);
          cursor = pos + ins.length;
        } else {
          const found = findAll(lines, oe.map((e) => e.s), strict, cursor, ch.eof);
          if (!found) return failRes('no-match', path);
          const pos = found.positions[0];
          const resolved = resolveN(ne, oe, lines, pos, found.tier);
          lines = spliceLines(lines, pos, oe.length, resolved);
          cursor = pos + resolved.length;
        }
      }
      const nst: FileState = { lines, lb: st.lb, fin: st.fin };
      if (moveTo !== undefined) {
        work.delete(path);
        work.set(moveTo, nst);
        return okRes({ o: path, n: moveTo });
      }
      work.set(path, nst);
      return okRes();
    },
  };
}

/* ---------------- JSON edits (SPEC section 9) ---------------- */

type JsonEdit =
  | { kind: 'create'; path: string; fileText: string }
  | { kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; insertLine: number; newStr: string };

function validateJsonEdit(o: unknown, lineNo: number): JsonEdit {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new ParseErr(lineNo);
  const rec = o as Record<string, unknown>;
  if (typeof rec.path !== 'string') throw new ParseErr(lineNo);
  const path = rec.path;
  if (rec.command === 'create') {
    if (typeof rec.file_text !== 'string') throw new ParseErr(lineNo);
    return { kind: 'create', path, fileText: rec.file_text };
  }
  if (rec.command === 'str_replace') {
    if (typeof rec.old_str !== 'string' || rec.old_str === '') throw new ParseErr(lineNo);
    if (rec.new_str !== undefined && typeof rec.new_str !== 'string') throw new ParseErr(lineNo);
    return { kind: 'str_replace', path, oldStr: rec.old_str, newStr: typeof rec.new_str === 'string' ? rec.new_str : '' };
  }
  if (rec.command === 'insert') {
    if (typeof rec.insert_line !== 'number' || !Number.isInteger(rec.insert_line)) throw new ParseErr(lineNo);
    if (typeof rec.new_str !== 'string') throw new ParseErr(lineNo);
    return { kind: 'insert', path, insertLine: rec.insert_line, newStr: rec.new_str };
  }
  throw new ParseErr(lineNo);
}

function parseJSON(text: string, L: string[]): Edit[] {
  const raw: JsonEdit[] = [];
  if (text.trimStart().startsWith('[')) {
    let startLine = 1;
    for (let i = 0; i < L.length; i += 1) {
      if (L[i].trim() !== '') {
        startLine = i + 1;
        break;
      }
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ParseErr(startLine);
    }
    if (!Array.isArray(data)) throw new ParseErr(startLine);
    for (const o of data) raw.push(validateJsonEdit(o, startLine));
  } else {
    for (let i = 0; i < L.length; i += 1) {
      if (L[i].trim() === '') continue;
      let o: unknown;
      try {
        o = JSON.parse(L[i]);
      } catch {
        throw new ParseErr(i + 1);
      }
      raw.push(validateJsonEdit(o, i + 1));
    }
  }
  return raw.map((e) => makeJsonEdit(e));
}

function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function countOccurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) return out;
    out.push(idx);
    from = idx + 1;
  }
}

function makeJsonEdit(e: JsonEdit): Edit {
  return {
    apply(work) {
      const bad = firstUnsafe([e.path]);
      if (bad !== null) return failRes('unsafe', bad);
      if (e.kind === 'create') {
        if (work.has(e.path)) return failRes('exists', e.path);
        work.set(e.path, parseText(e.fileText));
        return okRes();
      }
      const st = work.get(e.path);
      if (!st) return failRes('missing', e.path);
      if (e.kind === 'str_replace') {
        const crlf = st.lb === '\r\n';
        let text = serialize(st);
        let oldS = e.oldStr;
        let newS = e.newStr;
        if (crlf) {
          text = text.replace(/\r\n/g, '\n');
          oldS = oldS.replace(/\r\n/g, '\n');
          newS = newS.replace(/\r\n/g, '\n');
        }
        const occ = countOccurrences(text, oldS);
        if (occ.length === 0) return failRes('no-match', e.path);
        if (occ.length > 1) return failRes('ambiguous', e.path);
        text = text.slice(0, occ[0]) + newS + text.slice(occ[0] + oldS.length);
        if (crlf) text = text.replace(/\n/g, '\r\n');
        work.set(e.path, parseText(text));
        return okRes();
      }
      // insert
      if (e.insertLine < 0 || e.insertLine > st.lines.length) return failRes('no-match', e.path);
      const ins = splitNewStr(e.newStr);
      work.set(e.path, { lines: spliceLines(st.lines, e.insertLine, 0, ins), lb: st.lb, fin: st.fin });
      return okRes();
    },
  };
}

/* ---------------- format detection (SPEC section 4) ---------------- */

function detectFormat(L: string[]): string | null {
  const firstNonBlank = L.find((l) => l.trim() !== '');
  if (firstNonBlank !== undefined && firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  if (firstNonBlank !== undefined) {
    const t = firstNonBlank.trimStart();
    if (t[0] === '[' || t[0] === '{') return 'json';
  }
  if (L.some((l) => rtrimWS(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < L.length; i += 1) {
    if (L[i].startsWith('diff --git ')) return 'unified';
    if (L[i].startsWith('--- ') && i + 1 < L.length && L[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ---------------- patch lines (SPEC section 3) ---------------- */

function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/* ---------------- the tree ---------------- */

function snapshot(): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, pre: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = pre === '' ? ent.name : `${pre}/${ent.name}`;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full, p);
      else if (ent.isFile()) map.set(p, readFileSync(full, 'utf8'));
    }
  };
  walk(process.cwd(), '');
  return map;
}

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/* ---------------- CLI (SPEC sections 1, 2 and 10) ---------------- */

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  let format = 'auto';
  let check = false;
  let strict = false;
  const seen = new Set<string>();
  const positional: string[] = [];
  let afterDashDash = false;
  let usage = false;
  for (const arg of argv) {
    if (!afterDashDash) {
      if (arg === '--') {
        afterDashDash = true;
      } else if (arg === '--check') {
        if (seen.has('check')) usage = true;
        seen.add('check');
        check = true;
      } else if (arg === '--strict') {
        if (seen.has('strict')) usage = true;
        seen.add('strict');
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seen.has('format')) usage = true;
        seen.add('format');
        const v = arg.slice('--format='.length);
        if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(v)) usage = true;
        else format = v;
      } else if (arg === '-') {
        positional.push(arg);
      } else if (arg.startsWith('-')) {
        usage = true;
      } else {
        positional.push(arg);
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) usage = true;
  if (usage) {
    emit('error: usage');
    process.exitCode = 2;
    return;
  }

  let patchText: string;
  const patchArg = positional[0];
  if (patchArg === undefined || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      emit('error: no-patch');
      process.exitCode = 2;
      return;
    }
  }

  const L = patchLines(patchText);
  let fmt = format;
  if (fmt === 'auto') {
    const detected = detectFormat(L);
    if (detected === null) {
      emit('error: format');
      process.exitCode = 2;
      return;
    }
    fmt = detected;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(L);
    else if (fmt === 'search-replace') edits = parseSearchReplace(L);
    else if (fmt === 'v4a') edits = parseV4A(L);
    else edits = parseJSON(patchText, L);
    if (edits.length === 0) throw new ParseErr(1);
  } catch (err) {
    if (err instanceof ParseErr) {
      emit(`error: parse ${err.line}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const initial = snapshot();
  let virt = new Map<string, FileState>();
  for (const [p, text] of initial) virt.set(p, parseText(text));

  const failures: Fail[] = [];
  const moves: { o: string; n: string }[] = [];
  for (const edit of edits) {
    const work = new Map(virt);
    const res = edit.apply(work, strict);
    if (res.f) {
      failures.push(res.f);
    } else {
      virt = work;
      if (res.m) moves.push(res.m);
    }
  }

  if (failures.length > 0) {
    for (const f of failures) emit(`error: ${f.code} ${f.path}`);
    emit(`failed: ${failures.length} of ${edits.length} edits`);
    process.exitCode = 1;
    return;
  }

  // Compare the tree before and after, in UTF-8 byte order of the paths.
  const allPaths = new Set<string>([...initial.keys(), ...virt.keys()]);
  const rByNew = new Map<string, string>();
  const rOlds = new Set<string>();
  for (const m of moves) {
    if (initial.has(m.o) && !virt.has(m.o) && !initial.has(m.n) && virt.has(m.n)) {
      rByNew.set(m.n, m.o);
      rOlds.add(m.o);
    }
  }
  interface ChangeLine {
    key: string;
    line: string;
    path: string;
    after?: string;
  }
  const changes: ChangeLine[] = [];
  for (const p of allPaths) {
    const before = initial.get(p);
    const afterState = virt.get(p);
    const after = afterState === undefined ? undefined : serialize(afterState);
    if (rByNew.has(p)) {
      changes.push({ key: p, line: `R ${rByNew.get(p)} -> ${p}`, path: p, after });
    } else if (rOlds.has(p)) {
      // covered by the R line for its new path
    } else if (before === undefined && after !== undefined) {
      changes.push({ key: p, line: `A ${p}`, path: p, after });
    } else if (before !== undefined && after === undefined) {
      changes.push({ key: p, line: `D ${p}`, path: p, after });
    } else if (before !== undefined && after !== undefined && before !== after) {
      changes.push({ key: p, line: `M ${p}`, path: p, after });
    }
  }
  changes.sort((x, y) => byteCmp(x.key, y.key));

  if (!check) {
    for (const c of changes) {
      const full = join(process.cwd(), ...c.path.split('/'));
      if (c.after === undefined) {
        rmSync(full, { force: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, c.after);
      }
    }
    // Deletions that are the old half of a move have no entry of their own.
    for (const o of rOlds) {
      if (!changes.some((c) => c.path === o)) {
        rmSync(join(process.cwd(), ...o.split('/')), { force: true });
      }
    }
  }

  for (const c of changes) emit(c.line);
  const n = changes.length;
  emit(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
  process.exitCode = 0;
}

/* ---------------- hand-over ---------------- */

if (process.env.MAKEFUN_ENV_URL) {
  void runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}

