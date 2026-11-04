// Source analysis shared by the stamping transform and the write-back endpoint.
//
// analyze(code, file) returns:
//   elements: intrinsic elements we can stamp, each with the char index right after
//             the tag name (where the attribute is inserted), its line:col, and its
//             direct literal text children.
//   literals: every editable literal in the file (text nodes, string literals,
//             template quasis) — used for the same-file / project-wide fallback.
//
// Every range is a UTF-16 char range into `code`, so edits are plain string splices.

import { parse as babelParse } from '@babel/parser';
import { parse as parseHtml } from 'parse5';

export const ATTR = 'data-ce-src';

// Elements we never stamp: document scaffolding, non-visual, or framework-special.
const SKIP_TAGS = new Set([
  'html', 'head', 'meta', 'link', 'script', 'style', 'noscript', 'template',
  'base', 'slot', 'fragment', 'br', 'hr', 'wbr', 'img', 'input', 'source',
  'track', 'area', 'col', 'embed', 'param', 'iframe', 'svg', 'path', 'g',
  'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'defs',
  'clippath', 'mask', 'lineargradient', 'radialgradient', 'stop', 'symbol',
]);

export function isStampable(tag) {
  if (!tag || !/^[a-z][a-z0-9]*(-[a-z0-9-]+)?$/.test(tag)) return false;
  return !SKIP_TAGS.has(tag.toLowerCase());
}

// ---------------------------------------------------------------------------
// text helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Collapse whitespace the way rendered text does, so source and DOM text compare. */
export function norm(s) {
  return String(s).replace(/[\s ]+/g, ' ').trim();
}

export function lineIndex(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return (index) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: index - starts[lo] + 1 };
  };
}

export function langOf(file) {
  const ext = file.split('?')[0].split('.').pop().toLowerCase();
  if (ext === 'jsx' || ext === 'tsx') return 'jsx';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'ts';
  if (ext === 'astro') return 'astro';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'md';
  if (ext === 'json') return 'json';
  return null;
}

// ---------------------------------------------------------------------------
// JS / JSX via babel

function babel(code, lang) {
  const plugins = [];
  if (lang === 'jsx' || lang === 'js' || lang === 'tsx') plugins.push('jsx');
  if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') plugins.push('typescript');
  const tries = [plugins, plugins.filter((p) => p !== 'typescript'), plugins.filter((p) => p !== 'jsx')];
  for (const p of tries) {
    try {
      return babelParse(code, { sourceType: 'module', plugins: p, errorRecovery: true });
    } catch {}
  }
  return null;
}

function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent, key) === false) return;
  for (const k in node) {
    if (k === 'loc' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) walk(c, visit, node, k);
    else if (v && typeof v.type === 'string') walk(v, visit, node, k);
  }
}

// String literals that are never rendered copy.
function isNonCopyString(parent, key) {
  if (!parent) return false;
  const t = parent.type;
  if (key === 'source' || t === 'ImportDeclaration' || t === 'ExportAllDeclaration' || t === 'ImportExpression') return true;
  if (t === 'Directive' || t === 'DirectiveLiteral') return true;
  if (t.startsWith('TS')) return true;
  if ((t === 'ObjectProperty' || t === 'ObjectMethod' || t === 'ClassProperty') && key === 'key') return true;
  if (t === 'CallExpression' && parent.callee?.type === 'Identifier' && parent.callee.name === 'require') return true;
  if (t === 'MemberExpression' && key === 'property') return true;
  if (t === 'JSXAttribute') {
    const n = parent.name?.name;
    return typeof n === 'string' && /^(className|class|id|key|style|href|src|type|rel|target|role|name|for|htmlFor|lang|dir|method|action|as|ref)$|^(data-|aria-(?!label))/.test(n);
  }
  return false;
}

function analyzeBabel(code, lang, base = 0, lc, out) {
  const ast = babel(code, lang);
  if (!ast) return out;
  walk(ast.program, (node, parent, key) => {
    if (node.type === 'JSXElement') {
      const name = node.openingElement.name;
      if (name.type === 'JSXIdentifier' && isStampable(name.name)) {
        const start = base + node.start;
        const textChildren = [];
        for (const c of node.children) {
          const lit = jsxChildLiteral(c, base);
          if (lit) textChildren.push(lit);
        }
        const { line, col } = lc(start);
        const alreadyStamped = node.openingElement.attributes.some((a) => a.name?.name === ATTR);
        out.elements.push({ tag: name.name, start, nameEnd: base + name.end, line, col, textChildren, alreadyStamped });
      }
    } else if (node.type === 'JSXText') {
      if (norm(node.value)) out.literals.push({ kind: 'jsxtext', start: base + node.start, end: base + node.end, value: node.value });
    } else if (node.type === 'StringLiteral') {
      if (norm(node.value) && !isNonCopyString(parent, key)) {
        out.literals.push({ kind: parent?.type === 'JSXAttribute' ? 'attr' : 'string', start: base + node.start + 1, end: base + node.end - 1, value: node.value });
      }
    } else if (node.type === 'TemplateLiteral') {
      if (parent?.type === 'TaggedTemplateExpression') return false;
      for (const q of node.quasis) {
        const v = q.value.cooked ?? q.value.raw;
        if (norm(v)) out.literals.push({ kind: 'template', start: base + q.start, end: base + q.end, value: v });
      }
    }
  });
  return out;
}

function jsxChildLiteral(c, base) {
  if (c.type === 'JSXText') {
    if (!norm(c.value)) return null;
    return { kind: 'jsxtext', start: base + c.start, end: base + c.end, value: c.value };
  }
  if (c.type === 'JSXExpressionContainer') {
    const e = c.expression;
    if (e.type === 'StringLiteral') return { kind: 'string', start: base + e.start + 1, end: base + e.end - 1, value: e.value };
    if (e.type === 'TemplateLiteral' && e.expressions.length === 0) {
      const q = e.quasis[0];
      return { kind: 'template', start: base + q.start, end: base + q.end, value: q.value.cooked ?? q.value.raw };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML via parse5

function analyzeHtml(code, lc, out) {
  const doc = parseHtml(code, { sourceCodeLocationInfo: true });
  const visit = (node, skipText) => {
    for (const child of node.childNodes || []) {
      const loc = child.sourceCodeLocation;
      if (child.nodeName === '#text') {
        if (!skipText && loc && norm(child.value)) {
          out.literals.push({ kind: 'html', start: loc.startOffset, end: loc.endOffset, value: decodeEntities(code.slice(loc.startOffset, loc.endOffset)) });
        }
        continue;
      }
      if (!child.tagName) continue;
      const isRaw = /^(script|style|noscript|textarea|title)$/.test(child.tagName);
      if (loc?.startTag && isStampable(child.tagName)) {
        const start = loc.startTag.startOffset;
        const textChildren = [];
        for (const t of child.childNodes || []) {
          const tl = t.sourceCodeLocation;
          if (t.nodeName === '#text' && tl && norm(t.value)) {
            textChildren.push({ kind: 'html', start: tl.startOffset, end: tl.endOffset, value: decodeEntities(code.slice(tl.startOffset, tl.endOffset)) });
          }
        }
        const { line, col } = lc(start);
        out.elements.push({
          tag: child.tagName, start, nameEnd: start + 1 + child.tagName.length, line, col, textChildren,
          alreadyStamped: (child.attrs || []).some((a) => a.name === ATTR),
        });
      }
      visit(child, isRaw);
      if (child.content) visit(child.content, isRaw);
    }
  };
  visit(doc, false);
  return out;
}

// ---------------------------------------------------------------------------
// Astro via @astrojs/compiler (optional dependency, loaded on demand)

let astroCompiler;
async function loadAstroCompiler() {
  if (astroCompiler === undefined) {
    try { astroCompiler = await import('@astrojs/compiler'); } catch { astroCompiler = null; }
  }
  return astroCompiler;
}

async function analyzeAstro(code, lc, out) {
  const compiler = await loadAstroCompiler();
  if (!compiler) return out;
  const { ast } = await compiler.parse(code, { position: true });

  // The compiler reports UTF-8 byte offsets; convert them to string indexes.
  const buf = Buffer.from(code, 'utf8');
  const cache = new Map();
  const toChar = (byte) => {
    if (!cache.has(byte)) cache.set(byte, buf.subarray(0, byte).toString('utf8').length);
    return cache.get(byte);
  };
  const textLit = (t) => {
    const start = toChar(t.position.start.offset);
    const end = t.position.end ? toChar(t.position.end.offset) : start + t.value.length;
    return { kind: 'astro', start, end, value: decodeEntities(code.slice(start, end)) };
  };

  const visit = (node, inExpression) => {
    for (const child of node.children || []) {
      if (child.type === 'frontmatter') {
        const start = toChar(child.position.start.offset) + 3; // skip the opening ---
        if (code.slice(start, start + child.value.length) === child.value) analyzeBabel(child.value, 'ts', start, lc, out);
        continue;
      }
      if (child.type === 'text') {
        // Text directly inside {…} is JavaScript, not copy.
        if (!inExpression && child.position && norm(child.value)) out.literals.push(textLit(child));
        continue;
      }
      // Quoted attribute values, e.g. <Card title="Hello"> — often the real source of rendered text.
      for (const a of child.attributes || []) {
        if (a.kind !== 'quoted' || !a.position || !norm(a.value) || /^(class|id|href|src|style|type|rel|name|lang|slot)$|^(data-|client:|set:|is:)/.test(a.name)) continue;
        const from = toChar(a.position.start.offset);
        const at = code.indexOf('=' + a.raw, from);
        if (at === -1 || at - from > a.name.length + 2) continue;
        const start = at + 2;
        out.literals.push({ kind: 'attr', start, end: start + a.raw.length - 2, value: decodeEntities(code.slice(start, start + a.raw.length - 2)) });
      }
      if (child.type === 'element' && isStampable(child.name) && child.position) {
        const start = toChar(child.position.start.offset);
        if (code[start] === '<') {
          const textChildren = (child.children || [])
            .filter((t) => t.type === 'text' && t.position && norm(t.value))
            .map(textLit);
          const { line, col } = lc(start);
          out.elements.push({
            tag: child.name, start, nameEnd: start + 1 + child.name.length, line, col, textChildren,
            alreadyStamped: (child.attributes || []).some((a) => a.name === ATTR),
          });
        }
      }
      const skipChildren = child.type === 'element' && /^(script|style)$/.test(child.name);
      if (!skipChildren) visit(child, child.type === 'expression');
    }
  };
  visit(ast, false);
  return out;
}

// ---------------------------------------------------------------------------

export async function analyze(code, file) {
  const lang = langOf(file);
  const lc = lineIndex(code);
  const out = { lang, elements: [], literals: [] };
  if (lang === 'jsx') return analyzeBabel(code, file.endsWith('.tsx') ? 'tsx' : 'jsx', 0, lc, out);
  if (lang === 'js' || lang === 'ts') return analyzeBabel(code, lang, 0, lc, out);
  if (lang === 'html') return analyzeHtml(code, lc, out);
  if (lang === 'astro') return analyzeAstro(code, lc, out);
  return out;
}
