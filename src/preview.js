// Decide whether a build is a preview deploy, and collect what `directedit apply` needs to
// line the edits up with a local checkout: branch, commit, and where the project sits in the repo.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_PRODUCTION_BRANCHES = ['main', 'master'];

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {boolean | 'auto'} [opts.preview='auto']  true/false to force; 'auto' reads the CI environment
 * @param {string | string[]} [opts.productionBranch]  branches that are never previews (default main, master)
 * @param {Record<string, string | undefined>} [opts.env]
 * @returns {{ host: string, branch: string | null, commit: string | null } | null}
 */
export function detectPreview({ preview = 'auto', productionBranch, env = process.env } = {}) {
  if (preview === false) return null;
  const flag = env.DIRECTEDIT_PREVIEW;
  if (flag === '0' || flag === 'false') return null;
  const prod = [].concat(productionBranch ?? DEFAULT_PRODUCTION_BRANCHES);

  let found = null;
  if (env.CF_PAGES_BRANCH || env.CF_PAGES === '1') {
    // Cloudflare Pages
    found = { host: 'cloudflare', branch: env.CF_PAGES_BRANCH || null, commit: env.CF_PAGES_COMMIT_SHA || null };
    found.isPreview = !!found.branch && !prod.includes(found.branch);
  } else if (env.WORKERS_CI_BRANCH || env.WORKERS_CI === '1') {
    // Cloudflare Workers Builds
    found = { host: 'cloudflare', branch: env.WORKERS_CI_BRANCH || null, commit: env.WORKERS_CI_COMMIT_SHA || null };
    found.isPreview = !!found.branch && !prod.includes(found.branch);
  } else if (env.VERCEL_ENV) {
    found = { host: 'vercel', branch: env.VERCEL_GIT_COMMIT_REF || null, commit: env.VERCEL_GIT_COMMIT_SHA || null };
    found.isPreview = env.VERCEL_ENV === 'preview';
  } else if (env.NETLIFY === 'true' || env.CONTEXT) {
    found = { host: 'netlify', branch: env.HEAD || env.BRANCH || null, commit: env.COMMIT_REF || null };
    found.isPreview = env.CONTEXT === 'deploy-preview' || env.CONTEXT === 'branch-deploy';
  }

  const forced = preview === true || flag === '1' || flag === 'true';
  if (!forced && !found?.isPreview) return null;
  const { host = 'local', branch = null, commit = null } = found || {};
  return { host, branch, commit };
}

/** Fill in branch/commit from git when the CI env didn't, and find the project's path in the repo. */
export function previewInfo(detected, projectRoot) {
  const top = git(['rev-parse', '--show-toplevel'], projectRoot);
  let branch = detected.branch;
  if (!branch) {
    const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot);
    branch = b && b !== 'HEAD' ? b : null;
  }
  const commit = detected.commit || git(['rev-parse', 'HEAD'], projectRoot);
  const root = top ? path.relative(top, projectRoot).split(path.sep).join('/') : '';
  return { host: detected.host, branch, commit, root };
}
