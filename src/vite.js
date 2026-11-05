// Vite plugin: stamps source locations, serves the overlay, and writes edits back.
// In dev, Save writes straight to source. In preview builds (Cloudflare, Vercel, Netlify
// previews), the same overlay ships with the build and Save copies a `directedit apply` command.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stamp } from './stamp.js';
import { createApplier } from './apply.js';
import { langOf } from './analyze.js';
import { detectPreview, previewInfo } from './preview.js';

const CLIENT_ID = 'virtual:directedit-client';
const RESOLVED_CLIENT_ID = '\0' + CLIENT_ID;
const CLIENT_FILE = fileURLToPath(new URL('./client.js', import.meta.url));
const API = '/__directedit';

/**
 * @param {object} [options]
 * @param {string} [options.queueFile='.directedits.md']  where unresolved edits go (relative to root)
 * @param {string[]} [options.ignoreDirs]  extra directory names to skip when searching the project
 * @param {boolean} [options.injectClient=true]  add the overlay to served HTML pages
 * @param {string} [options.shortcut='alt+e']  keyboard shortcut that toggles edit mode
 * @param {boolean | 'auto'} [options.preview='auto']  include the editor in builds: 'auto' turns it on
 *   for preview deploys only (Cloudflare non-production branches, Vercel/Netlify previews)
 * @param {string | string[]} [options.productionBranch]  branches never treated as previews (default main, master)
 */
export default function directedit(options = {}) {
  const { queueFile = '.directedits.md', ignoreDirs = [], injectClient = true, shortcut = 'alt+e' } = options;
  let root = process.cwd();
  let applier;
  let mode = 'dev';
  let preview = null;

  const relTo = (abs) => path.relative(root, abs).split(path.sep).join('/');
  const shouldStamp = (id) => {
    if (id.startsWith('\0') || id.includes('/node_modules/')) return false;
    const file = id.split('?')[0];
    if (id.includes('?') && !/\?(v=|t=)/.test(id)) return false; // ?raw, ?astro&type=style, …
    // .astro files aren't stamped here: Astro's own plugin compiles them first, and in dev it
    // already emits data-astro-source-file / data-astro-source-loc, which the client uses.
    if (langOf(file) !== 'jsx') return false;
    const r = path.relative(root, file);
    return r && !r.startsWith('..') && !path.isAbsolute(r);
  };

  return {
    name: 'directedit',
    enforce: 'pre',
    apply(_config, { command }) {
      if (command === 'serve') return true;
      return !!detectPreview({ preview: options.preview, productionBranch: options.productionBranch });
    },

    configResolved(config) {
      root = config.root;
      if (config.command === 'build') {
        mode = 'preview';
        preview = previewInfo(detectPreview({ preview: true }), root);
        if (!globalThis.__directeditLogged) {
          globalThis.__directeditLogged = true;
          config.logger.info(`[directedit] preview build for ${preview.branch || 'unknown branch'}: copy editing enabled`);
        }
      } else {
        applier = createApplier({ root, queueFile, ignoreDirs });
      }
    },

    configureServer(server) {
      server.middlewares.use(API, (req, res, next) => {
        if (req.method !== 'POST' || req.url !== '/apply') return next();
        // Only accept writes from pages served by this dev server.
        const origin = req.headers.origin;
        if (origin) {
          try {
            if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin write refused' });
          } catch { return send(res, 403, { error: 'bad origin' }); }
        }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', async () => {
          try {
            const { edits, page } = JSON.parse(body || '{}');
            if (!Array.isArray(edits)) return send(res, 400, { error: 'edits must be an array' });
            const results = await applier.apply(edits, { page });
            send(res, 200, { results, queueFile });
          } catch (err) {
            server.config.logger.error(`[directedit] ${err.stack || err}`);
            send(res, 500, { error: String(err.message || err) });
          }
        });
      });
    },

    resolveId(id) {
      if (id === CLIENT_ID) return RESOLVED_CLIENT_ID;
    },

    load(id) {
      if (id === RESOLVED_CLIENT_ID) {
        const config = { api: API, shortcut, queueFile, mode, preview };
        if (mode === 'dev') config.root = root; // used to shorten Astro's absolute source paths
        return `${fs.readFileSync(CLIENT_FILE, 'utf8')}\ninit(${JSON.stringify(config)});`;
      }
    },

    async transform(code, id) {
      if (!shouldStamp(id)) return null;
      const file = id.split('?')[0];
      return stamp(code, file, relTo(file));
    },

    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        let out = html;
        // Only stamp when the HTML we're handed is exactly the file on disk, so offsets line up.
        const file = ctx.filename;
        if (file && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === html) {
          const stamped = await stamp(html, file, relTo(file));
          if (stamped) out = stamped.code;
        }
        if (!injectClient) return out;
        const tag = mode === 'dev'
          ? { tag: 'script', attrs: { type: 'module', src: `/@id/__x00__${CLIENT_ID}` }, injectTo: 'body' }
          : { tag: 'script', attrs: { type: 'module' }, children: `import ${JSON.stringify(CLIENT_ID)};`, injectTo: 'body' };
        return { html: out, tags: [tag] };
      },
    },
  };
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
}

export { directedit };
