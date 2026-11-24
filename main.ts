// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements SPEC.md in full: the command line, the output
// and exit codes, safe paths and format detection (sections 1 to 4, 9 and 10), line matching at three tiers
// (section 5: exact lines, then lines ignoring trailing whitespace, then lines ignoring all whitespace), and
// readers for all four edit formats — unified diffs whose hunk line numbers may be wrong (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8) and JSON tool-call edits. Every change is
// gathered first and written all-or-nothing. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Sections 3, 5, 6, 7, 8: file lines, tiered matching, unified, SEARCH/REPLACE, V4A ----
// Matching is tiered (section 5): a block of old lines is searched at tier 0 (exact), then tier 1
// (trailing whitespace ignored), then tier 2 (all leading/trailing whitespace ignored), and the first
// tier that finds it anywhere wins; a tier that finds it more than once is an ambiguity error, never a
// guess. Replacement lines written at tier 2 keep the file's own indentation where the patch's differs.

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

const trailST = (s: string): string => s.replace(/[ \t]+$/, '');
const bothST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function matchTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailST(a) === trailST(b);
  return bothST(a) === bothST(b);
}

interface Found {
  tier: number;
  pos: number[];
}

function findOcc(lines: string[], o: string[], from: number, strict: boolean, eofOnly = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (!matchTier(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

interface OLine {
  text: string;
  ctx: boolean;
}
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function buildRepl(lines: string[], pos: number, o: OLine[], n: NLine[], tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((l, i) => {
    if (l.ctx) oCtx.push(i);
  });
  let ctxSeen = 0;
  const f = o.length > 0 ? leadST(lines[pos]!) : '';
  const p = o.length > 0 ? leadST(o[0]!.text) : '';
  return n.map((l) => {
    if (l.ctx) {
      const oi = oCtx[ctxSeen]!;
      ctxSeen += 1;
      return lines[pos + oi]!;
    }
    if (tier === 2 && l.text.trim() !== '' && l.text.startsWith(p)) return f + l.text.slice(p.length);
    return l.text;
  });
}

interface BodyEntry {
  type: 'ctx' | 'old' | 'new' | 'slash';
  text: string;
}

function toEntries(raw: string[]): BodyEntry[] {
  return raw.map((l) => {
    if (l === '') return { type: 'ctx', text: '' };
    if (l[0] === ' ') return { type: 'ctx', text: l.slice(1) };
    if (l[0] === '-') return { type: 'old', text: l.slice(1) };
    if (l[0] === '+') return { type: 'new', text: l.slice(1) };
    return { type: 'slash', text: l.slice(1) };
  });
}

function toON(entries: BodyEntry[]): { o: OLine[]; n: NLine[]; slashAfter: boolean } {
  const o: OLine[] = [];
  const n: NLine[] = [];
  for (const e of entries) {
    if (e.type === 'ctx') {
      o.push({ text: e.text, ctx: true });
      n.push({ text: e.text, ctx: true, oIdx: o.length - 1 });
    } else if (e.type === 'old') o.push({ text: e.text, ctx: false });
    else if (e.type === 'new') n.push({ text: e.text, ctx: false, oIdx: -1 });
  }
  let last = -1;
  entries.forEach((e, i) => {
    if (e.type === 'ctx' || e.type === 'new') last = i;
  });
  const slashAfter = last >= 0 && entries[last + 1]?.type === 'slash';
  return { o, n, slashAfter };
}

// ---- Section 6: unified diffs ----

interface UHunk {
  a: number;
  body: string[];
}
interface USection {
  diffOld?: string;
  diffNew?: string;
  headOld?: string;
  headNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function headPath(l: string): string {
  let s = l.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.replace(/^ +/, '').replace(/ +$/, '');
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function applyHunks(state: FileParts, hunks: UHunk[], errPath: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n, slashAfter } = toON(toEntries(h.body));
    if (o.length > 0) {
      const found = findOcc(state.lines, o.map((x) => x.text), 0, strict);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let pos = found.pos[0]!;
      for (const cand of found.pos) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const runsEnd = pos + o.length === state.lines.length;
      const repl = buildRepl(state.lines, pos, o, n, found.tier);
      state.lines.splice(pos, o.length, ...repl);
      if (runsEnd) state.final = !slashAfter;
      d += n.length - o.length;
    } else {
      const at = Math.max(0, Math.min(h.a + d, state.lines.length));
      const atEnd = at === state.lines.length;
      state.lines.splice(at, 0, ...n.map((x) => x.text));
      if (atEnd) state.final = !slashAfter;
      d += n.length;
    }
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const num = i + 1;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/') : -1;
      if (sep < 0 || rest.slice(2, sep) === '' || rest.slice(sep + 3) === '') throw new Exit2(`error: parse ${num}`);
      cur = { diffOld: rest.slice(2, sep), diffNew: rest.slice(sep + 3), newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0 && l.startsWith('--- ')) {
      if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) throw new Exit2(`error: parse ${num + 1}`);
      cur.headOld = headPath(l);
      cur.headNew = headPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      cur = { headOld: headPath(l), headNew: headPath(lines[i + 1]!), newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${num}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => {
    const oldP = s.headOld ?? s.renameFrom ?? s.diffOld;
    const newP = s.headNew ?? s.renameTo ?? s.diffNew;
    const creation = s.headOld === '/dev/null' || s.newFile;
    const deletion = s.headNew === '/dev/null' || s.delFile;
    return (tree: Tree): void => {
      if (creation) {
        const p = newP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const content: string[] = [];
        let lastSlash = false;
        for (const h of s.hunks) {
          h.body.forEach((raw, k) => {
            if (raw.startsWith('+')) {
              content.push(raw.slice(1));
              lastSlash = (h.body[k + 1] ?? '').startsWith('\\');
            }
          });
        }
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + (lastSlash ? '' : '\n'));
        return;
      }
      if (deletion) {
        const p = oldP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const o = oldP!;
      const move = newP !== undefined && newP !== o;
      const nw = move ? newP! : o;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (move && !safe(nw)) throw new Fail('unsafe', nw);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (move && tree.get(nw) !== null) throw new Fail('exists', nw);
      const state = splitFile(before);
      applyHunks(state, s.hunks, o, strict);
      const result = joinFile(state);
      if (move) {
        tree.now.set(o, null);
        tree.now.set(nw, result);
        tree.moves.push([o, nw]);
      } else tree.now.set(o, result);
    };
  });
}

// ---- Section 7: SEARCH/REPLACE ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldL: string[];
    newL: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k -= 1) {
      const lk = lines[k]!;
      if (blank(lk)) continue;
      if (lk.trim().startsWith('```')) continue;
      path = lk.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let sep = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (sep < 0 && lines[j]!.trimEnd() === '=======') sep = j;
      else if (sep >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (sep < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldL: lines.slice(searchIdx + 1, sep), newL: lines.slice(sep + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldL.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const state = splitFile(before);
    const found = findOcc(state.lines, b.oldL, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.pos[0]!;
    const o: OLine[] = b.oldL.map((t) => ({ text: t, ctx: false }));
    const n: NLine[] = b.newL.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const repl = buildRepl(state.lines, pos, o, n, found.tier);
    state.lines.splice(pos, b.oldL.length, ...repl);
    tree.now.set(b.path, joinFile(state));
  });
}

// ---- Section 8: V4A ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHead = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isHead(l)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : 'upd';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const path = l.slice(prefix.length).trim();
    const headNum = i + 1;
    const raw: { num: number; line: string }[] = [];
    let j = i + 1;
    while (j < last && !isHead(lines[j]!)) {
      raw.push({ num: j + 1, line: lines[j]! });
      j += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.line.trim() === '') raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.line.startsWith('+')) addLines.push(r.line.slice(1));
        else if (r.line === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [] });
    } else if (kind === 'del') {
      for (const r of raw) {
        if (r.line !== '') throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (raw.length > 0 && raw[0]!.line.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.line.slice('*** Move to: '.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let curC: (VChunk & { closed: boolean }) | null = null;
      for (let k = start; k < raw.length; k += 1) {
        const r = raw[k]!;
        if (r.line.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.num}`);
        if (r.line.trim() === '*** End of File') {
          if (curC === null) {
            curC = { anchor: null, eof: true, body: [], closed: true };
            chunks.push(curC);
          } else {
            curC.eof = true;
            curC.closed = true;
          }
          continue;
        }
        if (r.line.startsWith('@@')) {
          const anchor = r.line.slice(2).trim();
          curC = { anchor: anchor === '' ? null : anchor, eof: false, body: [], closed: false };
          chunks.push(curC);
          continue;
        }
        if (r.line === '' || r.line[0] === ' ' || r.line[0] === '-' || r.line[0] === '+') {
          if (curC === null || curC.closed) {
            curC = { anchor: null, eof: false, body: [], closed: false };
            chunks.push(curC);
          }
          curC.body.push(r.line);
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNum}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks });
    }
    i = j;
  }
  return sections.map((s) => (tree: Tree): void => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const state = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let ap = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < state.lines.length; k += 1) {
            if (matchTier(state.lines[k]!, ch.anchor, tier)) {
              ap = k;
              break;
            }
          }
          if (ap >= 0) break;
        }
        if (ap < 0) throw new Fail('no-match', s.path);
        cursor = ap + 1;
      }
      const { o, n } = toON(toEntries(ch.body));
      if (o.length === 0) {
        const at = ch.eof ? state.lines.length : Math.min(cursor, state.lines.length);
        state.lines.splice(at, 0, ...n.map((x) => x.text));
        cursor = at + n.length;
      } else {
        const found = findOcc(state.lines, o.map((x) => x.text), cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.pos[0]!;
        const repl = buildRepl(state.lines, pos, o, n, found.tier);
        state.lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const result = joinFile(state);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, result);
      tree.moves.push([s.path, s.moveTo]);
    } else tree.now.set(s.path, result);
  });
}


function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const claimedOld = new Set<string>();
  const claimedNew = new Set<string>();
  const movePairs: [string, string][] = [];
  for (const [o, nw] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(nw) === null && tree.now.get(nw) !== null && tree.now.get(nw) !== undefined && !claimedOld.has(o) && !claimedNew.has(nw)) {
      movePairs.push([o, nw]);
      claimedOld.add(o);
      claimedNew.add(nw);
    }
  }
  const rowObjs: { key: string; text: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (claimedOld.has(p) || claimedNew.has(p)) continue;
    rowObjs.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, nw] of movePairs) rowObjs.push({ key: nw, text: `R ${o} -> ${nw}` });
  rowObjs.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowObjs.map((r) => r.text);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
