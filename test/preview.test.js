import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectPreview } from '../src/preview.js';
import { formatApplyCommand } from '../src/client.js';
import { parsePayload, apply } from '../src/cli.js';

test('detectPreview: hosts and production branches', () => {
  assert.equal(detectPreview({ env: {} }), null);
  assert.equal(detectPreview({ env: { CF_PAGES: '1', CF_PAGES_BRANCH: 'main' } }), null);
  assert.deepEqual(detectPreview({ env: { CF_PAGES: '1', CF_PAGES_BRANCH: 'fix-hero', CF_PAGES_COMMIT_SHA: 'abc' } }), { host: 'cloudflare', branch: 'fix-hero', commit: 'abc' });
  assert.equal(detectPreview({ env: { CF_PAGES_BRANCH: 'prod' }, productionBranch: 'prod' }), null);
  assert.equal(detectPreview({ env: { WORKERS_CI_BRANCH: 'x' } }).host, 'cloudflare');
  assert.equal(detectPreview({ env: { VERCEL_ENV: 'production' } }), null);
  assert.equal(detectPreview({ env: { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'b' } }).branch, 'b');
  assert.equal(detectPreview({ env: { NETLIFY: 'true', CONTEXT: 'production' } }), null);
  assert.equal(detectPreview({ env: { NETLIFY: 'true', CONTEXT: 'deploy-preview', HEAD: 'b' } }).host, 'netlify');
  assert.ok(detectPreview({ env: { DIRECTEDIT_PREVIEW: '1' } }));
  assert.equal(detectPreview({ env: { DIRECTEDIT_PREVIEW: '0', CF_PAGES_BRANCH: 'x' } }), null);
  assert.equal(detectPreview({ preview: false, env: { CF_PAGES_BRANCH: 'x' } }), null);
  assert.ok(detectPreview({ preview: true, env: {} }));
});

const payload = {
  v: 1, branch: 'fix-hero', commit: null, root: 'site', page: 'https://fix-hero.example.pages.dev/',
  edits: [
    { loc: 'index.html:3:1', before: 'Small tools', after: "Tiny tools — $HOME `x` 'q' \"dq\"\nline", context: { tag: 'h1' } },
    { loc: null, before: 'Only in data', after: 'Changed data' },
  ],
};

test('clipboard text round-trips through parsePayload', () => {
  const text = formatApplyCommand(payload);
  assert.match(text, /^Apply 2 copy edits from the preview of `fix-hero`\./);
  assert.match(text, /npx directedit apply <<'DIRECTEDIT'\n\{/);
  assert.deepEqual(parsePayload(text), payload);
  assert.deepEqual(parsePayload(JSON.stringify(payload)), payload);
  assert.throws(() => parsePayload('hello'), /couldn't find/);
});

test('the clipboard command runs in a real shell', () => {
  const text = formatApplyCommand(payload);
  const cmd = text.slice(text.indexOf('npx directedit apply')).replace('npx directedit apply', 'cat');
  const out = execFileSync('bash', ['-c', cmd]).toString();
  assert.deepEqual(parsePayload(out), payload);
});

function repo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'directedit-cli-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'site'));
  fs.writeFileSync(path.join(dir, 'site/index.html'), '<html><body>\n<h1>Small tools</h1>\n<p>x</p>\n</body></html>\n');
  fs.writeFileSync(path.join(dir, 'site/data.json'), '{"t": "Only in data"}\n');
  g('add', '-A');
  g('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init');
  if (branch) g('switch', '-q', '-c', branch);
  return dir;
}

test('apply: writes edits under the payload root on the right branch', async () => {
  const dir = repo('fix-hero');
  const lines = [];
  const r = await apply(formatApplyCommand(payload), { cwd: dir, log: (l) => lines.push(l) });
  assert.equal(r.applied, 2);
  assert.match(fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8'), /<h1>Tiny tools — \$HOME `x` 'q' "dq" line<\/h1>|<h1>Tiny tools — \$HOME `x` 'q' "dq"\nline<\/h1>/);
  assert.match(fs.readFileSync(path.join(dir, 'site/data.json'), 'utf8'), /"Changed data"/);
  assert.match(lines.join('\n'), /✓ site\/index\.html:2/);
  assert.match(lines.at(-1), /^2 applied\.$/);
});

test('apply: refuses the wrong branch unless forced, and reports queued edits', async () => {
  const dir = repo('other');
  await assert.rejects(apply(formatApplyCommand(payload), { cwd: dir, log: () => {} }), /git switch fix-hero/);
  const lines = [];
  const p2 = { ...payload, edits: [{ loc: null, before: 'Nowhere to be found', after: 'x' }] };
  const r = await apply(formatApplyCommand(p2), { cwd: dir, force: true, log: (l) => lines.push(l) });
  assert.equal(r.queued, 1);
  assert.match(lines.at(-1), /0 applied, 1 queued in site\/\.directedits\.md/);
  assert.ok(fs.existsSync(path.join(dir, 'site/.directedits.md')));
});
