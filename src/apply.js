// Write-back: turn edits from the browser into source changes.
//
// Each edit says "the text node rendered by <element at file:line:col> changed from
// BEFORE to AFTER". We look for the literal that produced BEFORE, widening the search
// until exactly one literal matches:
//   1. a direct text child of that element
//   2. any literal in the same file           (const label = "Save" … {label})
//   3. any literal in the project             (<Button>Save</Button> in another file,
//                                              data arrays, .md content, .json strings)
// Anything that can't be pinned to exactly one literal is appended to a queue file
// (.directedits.md) with location context for a coding agent to pick up.

import fs from 'node:fs';
import path from 'node:path';
import { analyze, langOf, norm, lineIndex } from './analyze.js';

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.astro', '.next', '.nuxt', '.svelte-kit',
  '.vercel', '.netlify', '.turbo', '.cache', 'coverage', 'public',
]);
const IGNORE_FILE = /^(readme|changelog|license|contributing|code_of_conduct)\b|^\.directedits\.md$|\.config\.|^package(-lock)?\.json$|^tsconfig.*\.json$|\.lock$/i;
const MAX_FILES = 4000;

export function parseLoc(loc) {
  const m = /^(.*):(\d+):(\d+)$/.exec(loc || '');
  return m ? { rel: m[1], line: +m[2], col: +m[3] } : null;
}

export function createApplier({ root, queueFile = '.directedits.md', ignoreDirs = [] } = {}) {
  root = path.resolve(root);
  const ignore = new Set([...DEFAULT_IGNORE_DIRS, ...ignoreDirs]);
  const cache = new Map(); // abs path -> { mtime, code, analysis }

  const inRoot = (abs) => {
    const r = path.relative(root, abs);
    return r && !r.startsWith('..') && !path.isAbsolute(r) && !r.split(path.sep).includes('node_modules');
  };
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');

  async function load(abs) {
    const st = fs.statSync(abs);
    const hit = cache.get(abs);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const code = fs.readFileSync(abs, 'utf8');
    const lang = langOf(abs);
    let analysis = { lang, elements: [], literals: [] };
    if (lang === 'md' || lang === 'json') analysis.raw = true;
    else {
      try { analysis = await analyze(code, abs); } catch {}
    }
    const entry = { mtime: st.mtimeMs, code, analysis };
    cache.set(abs, entry);
    return entry;
  }

  function projectFiles() {
    const files = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files.length >= MAX_FILES) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!ignore.has(e.name) && !e.name.startsWith('.')) walk(abs);
        } else if (e.isFile() && langOf(e.name) && !IGNORE_FILE.test(e.name) && !/\.d\.ts$/.test(e.name)) {
          files.push(abs);
        }
      }
    };
    walk(root);
    return files;
  }

  // ---- matching ----------------------------------------------------------

  const matchLiterals = (lits, before) => {
    const want = norm(before);
    return lits.filter((l) => norm(l.value) === want);
  };

  function rawMatches(entry, abs, before) {
    const out = [];
    if (entry.analysis.lang === 'json') {
      const needle = JSON.stringify(before);
      let i = -1;
      while ((i = entry.code.indexOf(needle, i + 1)) !== -1) out.push({ kind: 'json', start: i, end: i + needle.length, value: before, file: abs });
    } else if (entry.analysis.lang === 'md') {
      // Markdown is often hard-wrapped, so match the words with any whitespace between them.
      const words = norm(before).split(' ');
      if (words.join(' ').length < 4) return out;
      const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
      for (const m of entry.code.matchAll(re)) out.push({ kind: 'md', start: m.index, end: m.index + m[0].length, value: m[0], file: abs });
    }
    return out;
  }

  async function resolve(edit) {
    const loc = parseLoc(edit.loc);
    const before = edit.before ?? '';
    if (!norm(before)) return { reason: 'the original text was empty or whitespace' };
    if (edit.kind === 'structure') return { reason: "the edit spanned several text pieces (e.g. a {variable} next to literal text, or across inline tags), so it isn't a single literal swap" };

    let ownerFile = null;
    if (loc) {
      const abs = path.resolve(root, loc.rel);
      if (inRoot(abs) && fs.existsSync(abs)) ownerFile = abs;
    }

    // 1 + 2: the owning element, then its file
    if (ownerFile) {
      const entry = await load(ownerFile);
      let el;
      if (edit.locMode === 'after-open-tag') {
        // Astro's data-astro-source-loc: the position just after the opening tag.
        const starts = [0];
        for (let i = 0; i < entry.code.length; i++) if (entry.code.charCodeAt(i) === 10) starts.push(i + 1);
        const idx = (starts[loc.line - 1] ?? Infinity) + loc.col - 1;
        el = entry.analysis.elements.filter((e) => e.start < idx).sort((a, b) => b.start - a.start)[0];
      } else {
        el = entry.analysis.elements.find((e) => e.line === loc.line && e.col === loc.col);
      }
      if (el) {
        const m = matchLiterals(el.textChildren, before);
        if (m.length === 1) return { file: ownerFile, lit: m[0], via: 'element' };
      }
      const m = matchLiterals(entry.analysis.literals, before);
      if (m.length === 1) return { file: ownerFile, lit: m[0], via: 'file' };
      if (m.length > 1) return { reason: `${m.length} identical literals in ${rel(ownerFile)}, so the right one is ambiguous`, candidates: m.map((l) => ({ file: ownerFile, lit: l })) };
    }

    // 3: the whole project
    const hits = [];
    for (const abs of projectFiles()) {
      if (abs === ownerFile) continue;
      let entry;
      try { entry = await load(abs); } catch { continue; }
      if (entry.analysis.raw) hits.push(...rawMatches(entry, abs, before).map((lit) => ({ file: abs, lit })));
      else for (const lit of matchLiterals(entry.analysis.literals, before)) hits.push({ file: abs, lit });
      if (hits.length > 5) break;
    }
    if (hits.length === 1) return { ...hits[0], via: 'project' };
    if (hits.length > 1) return { reason: `the text appears as a literal in ${hits.length}+ places`, candidates: hits };
    return { reason: 'no literal produces this text — it likely comes from a prop, variable, i18n key, or external data' };
  }

  // ---- apply -------------------------------------------------------------

  async function apply(edits, { page } = {}) {
    const results = [];
    const ops = []; // { file, start, end, text, editIndex }
    const resolved = [];

    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      let r;
      try { r = await resolve(e); } catch (err) { r = { reason: `error: ${err.message}` }; }
      resolved.push(r);
      if (r.lit) {
        const entry = cache.get(r.file);
        const clash = ops.find((o) => o.file === r.file && o.start < r.lit.end && r.lit.start < o.end);
        if (clash) { resolved[i] = { reason: 'another edit in this batch already targets the same literal' }; continue; }
        ops.push({ file: r.file, start: r.lit.start, end: r.lit.end, text: replacement(entry.code, r.lit, e.after ?? ''), editIndex: i });
      }
    }

    // Write each file once, splicing bottom-up so earlier ranges stay valid.
    const byFile = new Map();
    for (const op of ops) {
      if (!byFile.has(op.file)) byFile.set(op.file, []);
      byFile.get(op.file).push(op);
    }
    const lines = new Map();
    for (const [file, fileOps] of byFile) {
      const entry = cache.get(file);
      let code = entry.code;
      const lc = lineIndex(code);
      for (const op of fileOps) lines.set(op.editIndex, lc(op.start).line);
      fileOps.sort((a, b) => b.start - a.start);
      for (const op of fileOps) code = code.slice(0, op.start) + op.text + code.slice(op.end);
      fs.writeFileSync(file, code);
      cache.delete(file);
    }

    const queued = [];
    edits.forEach((e, i) => {
      const r = resolved[i];
      if (r.lit) {
        results.push({ id: e.id, status: 'applied', file: rel(r.file), line: lines.get(i), via: r.via });
      } else {
        queued.push({ edit: e, reason: r.reason, candidates: r.candidates });
        results.push({ id: e.id, status: 'queued', reason: r.reason, queue: queueFile });
      }
    });
    if (queued.length) appendQueue(queued, page);
    return results;
  }

  function appendQueue(items, page) {
    const qpath = path.join(root, queueFile);
    let out = '';
    if (!fs.existsSync(qpath)) {
      out += '# Pending copy edits\n\n'
        + '<!-- Written by directedit. Agent: apply each edit to the source that renders it (follow the\n'
        + '     location and any props/data it passes through), then delete that edit\'s section.\n'
        + '     Leave this header. -->\n';
    }
    for (const { edit, reason, candidates } of items) {
      const c = edit.context || {};
      out += `\n## ${edit.loc || '(unknown location)'}${c.tag ? ` · <${c.tag}>` : ''}\n\n`;
      if (page) out += `- page: ${page}\n`;
      if (c.heading) out += `- under heading: ${JSON.stringify(c.heading)}\n`;
      out += `- why not applied: ${reason}\n`;
      if (candidates?.length) {
        out += `- candidates: ${candidates.slice(0, 6).map((h) => `${rel(h.file)}:${lineIndex(cache.get(h.file)?.code ?? '')(h.lit.start).line}`).join(', ')}\n`;
      }
      out += `- before: ${JSON.stringify(edit.before)}\n`;
      out += `- after: ${JSON.stringify(edit.after)}\n`;
      if (c.text && c.text !== edit.before) out += `- element text now: ${JSON.stringify(c.text)}\n`;
    }
    fs.appendFileSync(qpath, out);
  }

  return { apply, resolve, projectFiles };
}

// ---------------------------------------------------------------------------
// building the replacement source text for a literal

function splitWs(raw) {
  const lead = raw.match(/^[\s]*/)[0];
  const trail = raw.slice(lead.length).match(/[\s]*$/)[0];
  return { lead, trail };
}

export function replacement(code, lit, after) {
  const raw = code.slice(lit.start, lit.end);
  // Keep the file's style: if it already wrote &amp;, keep writing &amp;.
  const strictAmp = /&amp;/.test(raw);
  const escapeHtmlText = (s) => (strictAmp ? s.replace(/&/g, '&amp;') : s.replace(/&(?=[#\w]+;)/g, '&amp;')).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  switch (lit.kind) {
    case 'jsxtext': {
      const { lead, trail } = splitWs(raw);
      return lead + escapeHtmlText(after.trim()).replace(/[{}]/g, (c) => `{'${c}'}`) + trail;
    }
    case 'html': {
      const { lead, trail } = splitWs(raw);
      return lead + escapeHtmlText(after.trim()) + trail;
    }
    case 'astro': {
      const { lead, trail } = splitWs(raw);
      return lead + escapeHtmlText(after.trim()).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;') + trail;
    }
    case 'attr': {
      // HTML/JSX attribute values have no backslash escapes; use entities instead.
      const q = code[lit.start - 1];
      return after.replace(/&(?=[#\w]+;)/g, '&amp;').replace(new RegExp(q, 'g'), q === '"' ? '&quot;' : '&#39;');
    }
    case 'string': {
      const q = code[lit.start - 1];
      return after.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(/\n/g, '\\n');
    }
    case 'template':
      return after.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    case 'json':
      return JSON.stringify(after);
    case 'md':
      return after.trim();
    default:
      return after;
  }
}
