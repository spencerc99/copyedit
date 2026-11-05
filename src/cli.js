#!/usr/bin/env node
// directedit apply: write copy edits made on a preview deploy into the local checkout.
//
//   npx directedit apply <<'DIRECTEDIT' … DIRECTEDIT   (what "Copy edits" puts on the clipboard)
//   pbpaste | npx directedit apply
//   npx directedit apply edits.json
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createApplier } from './apply.js';

const HELP = `directedit apply [file] [--force]

Applies copy edits copied from a directedit preview build to this checkout.
Reads the edits from [file], or from stdin. Accepts the whole "Copy edits" text.

  --force   apply even if you're on a different branch than the preview
`;

/** Pull the JSON payload out of whatever was pasted: the full clipboard text, the heredoc body, or raw JSON. */
export function parsePayload(text) {
  const here = /<<\s*'?DIRECTEDIT'?\s*\n([\s\S]*?)\n\s*DIRECTEDIT\s*(?:\n|$)/.exec(text);
  const body = here ? here[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("couldn't find directedit edits in the input. Paste the whole text from \"Copy edits\".");
  }
  if (!payload || !Array.isArray(payload.edits)) throw new Error('the input has no "edits" list.');
  return payload;
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const short = (s, n = 48) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return JSON.stringify(one.length > n ? one.slice(0, n - 1) + '…' : one);
};

export async function apply(text, { cwd = process.cwd(), force = false, log = console.log } = {}) {
  const payload = parsePayload(text);
  const top = git(['rev-parse', '--show-toplevel'], cwd) || cwd;
  const commit = payload.commit ? String(payload.commit) : null;
  const label = payload.branch ? `the preview of ${payload.branch}${commit ? ` (${commit.slice(0, 7)})` : ''}` : 'a preview';

  // The preview was built from one branch; make sure we're writing to that branch.
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], top);
  if (payload.branch && current && current !== 'HEAD' && current !== payload.branch && !force) {
    const err = new Error(
      `these edits are from ${label}, but this checkout is on "${current}".\n`
      + `Switch first (git switch ${payload.branch}), then run the same command again. Or pass --force to apply here anyway.`,
    );
    err.code = 'BRANCH_MISMATCH';
    throw err;
  }
  if (commit && current) {
    const r = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: top, stdio: 'ignore' });
    if (r.status !== 0) {
      log(`warning: this checkout doesn't include ${commit.slice(0, 7)}, the commit the preview was built from. If edits don't match, pull and run again.`);
    }
  }

  const root = path.resolve(top, payload.root || '');
  const queueFile = payload.queueFile || '.directedits.md';
  const applier = createApplier({ root, queueFile });
  const edits = payload.edits.map((e, i) => ({ ...e, id: i }));
  const results = await applier.apply(edits, { page: payload.page });

  const fromTop = (rel) => path.relative(top, path.join(root, rel)).split(path.sep).join('/');
  log(`directedit: ${edits.length} edit${edits.length === 1 ? '' : 's'} from ${label}`);
  results.forEach((r, i) => {
    const e = edits[i];
    if (r.status === 'applied') log(`  ✓ ${fromTop(r.file)}:${r.line}  ${short(e.before)} → ${short(e.after)}`);
    else log(`  ↳ queued  ${short(e.before)} → ${short(e.after)}  (${r.reason})`);
  });
  const applied = results.filter((r) => r.status === 'applied').length;
  const queued = results.length - applied;
  const qpath = fromTop(queueFile);
  if (!queued) log(`${applied} applied.`);
  else log(`${applied} applied, ${queued} queued in ${qpath}: edit the source that renders each queued text by hand, then delete its section from ${qpath}.`);
  return { applied, queued, results };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'apply' || rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return cmd === 'apply' || cmd === undefined || cmd === '-h' || cmd === '--help' ? 0 : 1;
  }
  const force = rest.includes('--force');
  const file = rest.find((a) => !a.startsWith('-'));
  let text;
  if (file) text = fs.readFileSync(file, 'utf8');
  else if (!process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
  else {
    process.stderr.write('directedit: no edits given. Paste the "Copy edits" text, or pipe it in: pbpaste | npx directedit apply\n');
    return 1;
  }
  try {
    await apply(text, { force });
    return 0;
  } catch (err) {
    process.stderr.write(`directedit: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
