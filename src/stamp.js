// Dev-only transform: add data-de-src="file:line:col" to every stampable element.
import MagicString from 'magic-string';
import { analyze, ATTR } from './analyze.js';

/**
 * @param {string} code  source text
 * @param {string} file  absolute path (used to pick the parser)
 * @param {string} rel   path relative to the project root (written into the attribute)
 * @returns {Promise<{code: string, map: any} | null>}
 */
export async function stamp(code, file, rel) {
  let result;
  try {
    result = await analyze(code, file);
  } catch {
    return null; // unparseable files pass through untouched
  }
  if (!result.elements.length) return null;
  const s = new MagicString(code);
  let n = 0;
  for (const el of result.elements) {
    if (el.alreadyStamped) continue;
    s.appendLeft(el.nameEnd, ` ${ATTR}="${escapeAttr(rel)}:${el.line}:${el.col}"`);
    n++;
  }
  if (!n) return null;
  return { code: s.toString(), map: s.generateMap({ hires: 'boundary', source: file, includeContent: true }) };
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
