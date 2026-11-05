# directedit

Edit the words on your running site, in the browser, and have them land in your source files.

Turn on edit mode, click any text, type, press Enter. When you hit save, each change is written back to the literal that produced it: JSX text, an HTML text node, a string in a data array, a component prop, a Markdown paragraph, a JSON value. Anything that can't be pinned to exactly one literal goes into `.directedits.md` with enough context for a coding agent to finish the job.

It also works on **preview deploys** (Cloudflare, Vercel, Netlify): edit the preview, click **Copy edits**, and paste the result into your coding agent or a terminal. One command writes the edits into your checkout.

Works with **Vite 5+** (React, plain HTML, anything JSX) and **Astro**. Production builds never include it.

## Install

```sh
npm i -D directedit
# or: bun add -d directedit
# or: pnpm add -D directedit
```

Then add it to your config.

**Vite (React, plain HTML, …)**

```js
// vite.config.js
import directedit from 'directedit';
import react from '@vitejs/plugin-react';

export default { plugins: [directedit(), react()] };
```

Put `directedit()` before your framework plugin.

**Astro**

```js
// astro.config.mjs
import directedit from 'directedit/astro';

export default { integrations: [directedit()] };
```

Add `.directedits.md` to your `.gitignore` unless you want the agent queue in version control.

### Running it

Start your dev server the way you normally do (`npm run dev`, `vite`, `astro dev`). Open the page, press <kbd>Alt</kbd>+<kbd>E</kbd>, and start editing. Nothing else needs to run.

Production builds are unaffected. Preview builds get the editor automatically, as described in the next section.

## Preview deploys

When you build on a preview deploy, the editor ships with the preview. Nothing to configure: directedit detects these builds and turns itself on:

| Host | Counts as a preview |
|---|---|
| Cloudflare Pages / Workers Builds | any branch except `main` / `master` |
| Vercel | `VERCEL_ENV=preview` |
| Netlify | deploy previews and branch deploys |

On a preview there's no dev server to write to, so **Save** becomes **Copy edits** (<kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>S</kbd> works too). The clipboard gets a short instruction and one shell command with the edits inline:

````
Apply 2 copy edits from the preview of `fix-hero` (a1b2c3d). Run this command exactly as
written from the repo root, then handle only the edits it reports as queued.

npx directedit apply <<'DIRECTEDIT'
{"v":1,"branch":"fix-hero","commit":"a1b2c3d…","root":"website","page":"https://…","edits":[
  {"loc":"index.html:12:7","before":"Small tools","after":"Tiny tools","context":{"tag":"h1"}},
  …
]}
DIRECTEDIT
````

Paste it wherever is handy:

- **Into any coding agent** (Claude Code, Codex, Cursor, …). It's one shell call, and the agent doesn't need to open your files. The edits are applied by the same deterministic matcher as in dev, not by the model, so it's quick and cheap on any model. The agent only has to think about edits the command reports as queued.
- **Into Claude Code with a `!` prefix**, to run it as a shell command without involving the model.
- **Into a terminal** in your checkout. Or use `pbpaste | npx directedit apply`.

`directedit apply`:

- checks you're on the branch the preview was built from, and stops if not (pass `--force` to override);
- warns if your checkout doesn't include the commit the preview was built from;
- writes what it can place, puts the rest in `.directedits.md`, and prints a one-line summary like `3 applied, 1 queued in website/.directedits.md`.

Edits are matched by their text, so they still apply if the branch has moved on a few commits since the preview was built. Astro preview builds don't carry source locations (Astro only adds those in dev). Unique text still applies, and text that appears in several places goes to the queue.

The preview page only copies to your clipboard and never writes anywhere, so a public preview URL can't change your code.

To turn this off, pass `preview: false`. To force it on for a build, set `DIRECTEDIT_PREVIEW=1`; `DIRECTEDIT_PREVIEW=0` forces it off. If your production branch isn't `main`/`master`, set `productionBranch`.

### Opt-in instead of always-on

To keep directedit out of everyone's default dev server, load it only when an env var is set:

```js
// vite.config.js
const directedit = process.env.DIRECTEDIT ? (await import('directedit')).default : null;

export default { plugins: [directedit && directedit(), react()] };
```

```json
"scripts": { "dev:directedit": "DIRECTEDIT=1 vite" }
```

### Using a local checkout

If you're hacking on directedit itself, point a project at your clone instead of the npm package:

```sh
git clone https://github.com/spencerc99/directedit ~/Projects/directedit
cd ~/Projects/directedit && npm i
```

```js
// vite.config.js in the other project
import path from 'node:path';
const directedit = (await import(/* @vite-ignore */ path.resolve(__dirname, '../directedit/src/vite.js'))).default;
// Astro: (await import(/* @vite-ignore */ new URL('../directedit/src/astro.js', import.meta.url).href)).default
```

Run `npm i` in the directedit folder first; its parsers are loaded from there. Restart the dev server after changing directedit's code.

## Use

| | |
|---|---|
| <kbd>Alt</kbd>+<kbd>E</kbd> or the pill in the corner | toggle edit mode |
| click text | edit it in place |
| <kbd>Enter</kbd> / <kbd>Esc</kbd> | keep / revert this edit |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>S</kbd> | save all pending edits to source (on previews: copy them) |
| hold <kbd>Alt</kbd> while clicking | click through to the page normally |

While edit mode is on, the page's own click, submit and key handlers are paused, so you can edit a link or button label without following or pressing it. Buttons and other elements that can't hold a caret open a small inline field instead.

## How it maps back to source

In dev, every element gets a `data-de-src="file:line:col"` attribute (Astro already emits `data-astro-source-file`/`-loc`, which are used as-is). When you save, each changed text node is matched to a literal, widening the search until exactly one matches:

1. a direct text child of that element: `<h1>Hello</h1>`
2. any literal in the same file: `const label = "Save"` … `{label}`
3. any literal in the project: `<Button>Save</Button>` from another file, `<Card title="…">`, an array in Astro frontmatter, a sentence in a `.md` file, a value in a `.json` file

The change is a plain splice of that literal. Whitespace and indentation are kept, and the text is escaped for where it's going (JSX braces, HTML entities, string quotes, attribute quotes). Vite HMR then refreshes the page.

## What it can't do (and the agent hand-off)

Text that has no single literal behind it, such as `{count} joined`, `t('hero.title')`, CMS content, or the same string in three places, is appended to `.directedits.md`:

```md
## src/App.jsx:25:78 · <span>
- page: http://localhost:5173/
- under heading: "Small tools for shared rooms"
- why not applied: the edit spanned several text pieces (e.g. a {variable} next to literal text…)
- before: "0 joined"
- after: "1 joined"
```

The save toast has a **Copy agent prompt** button. Paste it into Claude Code, Cursor, etc., and it applies and clears the queue.

## Options

```js
directedit({
  shortcut: 'alt+e',            // toggle key
  queueFile: '.directedits.md',   // where unresolved edits go (relative to root)
  ignoreDirs: ['fixtures'],     // extra dirs to skip when searching the project
  injectClient: true,           // add the overlay to served HTML
  preview: 'auto',              // include in preview builds: 'auto' | true | false
  productionBranch: ['main', 'master'], // branches never treated as previews
})
```

## Safety

- Production builds: the plugin does nothing. It only runs in dev and in builds it detects as previews.
- The write endpoint refuses cross-origin requests and paths outside the project root or in `node_modules`.
- It only ever replaces one literal's contents per edit. It never reformats or moves code.

## Troubleshooting

- **No pill in the corner.** Check that the plugin is in the config of the dev server you're running, and that you're on a page served by that dev server. On a preview deploy, check the build log for `[directedit] preview build for …`. If it's missing, the build wasn't detected as a preview (see the table above, or set `DIRECTEDIT_PREVIEW=1`).
- **`directedit apply` says you're on the wrong branch.** Switch to the preview's branch and run it again, or pass `--force`.
- **An edit went to `.directedits.md` instead of the file.** The text has no single literal behind it (see above), or its source is outside the project root, e.g. a shared package in a monorepo. The queue entry says which.
- **Clicking a link or button does nothing.** That's edit mode. Press <kbd>Alt</kbd>+<kbd>E</kbd> or <kbd>Esc</kbd> to leave it, or hold <kbd>Alt</kbd> while clicking.

## Develop

```sh
npm i
npm test                                   # write-back unit tests (node:test)
```

The `examples/` folder has a React, a plain HTML and an Astro site wired up to the local package:

```sh
cd examples/react && npm i && npx vite --port 5171
cd examples/html  && npm i && npx vite --port 5172
cd examples/astro && npm i && npx astro dev --port 4321
```

`test/e2e_preview.py` covers preview builds. Build each example with `CF_PAGES=1 CF_PAGES_BRANCH=preview-test`, serve the `dist` folders on ports 4173–4175, then run it. It edits each preview, copies, and runs `directedit apply`.

With all three dev servers running, `test/e2e.py` drives a real browser through editing and saving on each one (it rewrites the example sources, so reset them with git afterwards):

```sh
pip install playwright && playwright install chromium
python3 test/e2e.py
```

## License

MIT
