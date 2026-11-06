import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stamp } from '../src/stamp.js';
import { createApplier } from '../src/apply.js';

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directedit-'));
  for (const [rel, code] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), code);
  }
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  return { root, read, applier: createApplier({ root }) };
}

const locOf = async (code, file, tag) => {
  const out = await stamp(code, file, file);
  const m = new RegExp(`<${tag} data-de-src="([^"]+)"`).exec(out.code);
  return m[1];
};

test('stamps intrinsic JSX elements only', async () => {
  const code = `export const A = () => <main><h1 className="t">Hi</h1><Button>Go</Button><>x</></main>`;
  const out = await stamp(code, '/p/src/A.tsx', 'src/A.tsx');
  assert.match(out.code, /<main data-de-src="src\/A\.tsx:1:24">/);
  assert.match(out.code, /<h1 data-de-src="src\/A\.tsx:1:30" className="t">/);
  assert.match(out.code, /<Button>Go<\/Button>/);
});

test('JSX: direct text child is rewritten, whitespace kept', async () => {
  const src = `export default function App() {\n  return (\n    <p>\n      Hello there {name}!\n    </p>\n  );\n}\n`;
  const { root, read, applier } = project({ 'src/App.jsx': src });
  const loc = await locOf(src, 'src/App.jsx', 'p');
  const [r] = await applier.apply([{ id: 1, loc, before: 'Hello there ', after: 'Hi {friend} & co ' }]);
  assert.equal(r.status, 'applied');
  assert.equal(r.via, 'element');
  assert.equal(read('src/App.jsx'), `export default function App() {\n  return (\n    <p>\n      Hi {'{'}friend{'}'} & co {name}!\n    </p>\n  );\n}\n`);
  fs.rmSync(root, { recursive: true });
});

test('JSX: text passed as children to a component in another file', async () => {
  const button = `export const Button = ({children}) => <button className="b">{children}</button>;\n`;
  const app = `import {Button} from './Button';\nexport default () => <div><Button>Sign up</Button></div>;\n`;
  const { read, applier } = project({ 'src/Button.tsx': button, 'src/App.tsx': app });
  const loc = await locOf(button, 'src/Button.tsx', 'button');
  const [r] = await applier.apply([{ id: 1, loc, before: 'Sign up', after: 'Join the club' }]);
  assert.equal(r.status, 'applied');
  assert.equal(r.via, 'project');
  assert.match(read('src/App.tsx'), /<Button>Join the club<\/Button>/);
});

test('JSX: string from a data array in the same file', async () => {
  const src = `const links = [{ label: "About me", href: "/about" }];\nexport default () => <nav>{links.map(l => <a href={l.href}>{l.label}</a>)}</nav>;\n`;
  const { read, applier } = project({ 'src/Nav.jsx': src });
  const loc = await locOf(src, 'src/Nav.jsx', 'a');
  const [r] = await applier.apply([{ id: 1, loc, before: 'About me', after: `Spencer's "about"` }]);
  assert.equal(r.status, 'applied');
  assert.equal(r.via, 'file');
  assert.match(read('src/Nav.jsx'), /label: "Spencer's \\"about\\""/);
});

test('ambiguous and dynamic text is queued with context', async () => {
  const src = `export default ({t}) => <div><p>Same</p><p>Same</p><h2>{t('x')}</h2></div>;\n`;
  const { root, read, applier } = project({ 'src/X.jsx': src });
  const loc = await locOf(src, 'src/X.jsx', 'h2');
  const res = await applier.apply([
    { id: 1, loc, before: 'Translated title', after: 'New title', context: { tag: 'h2', heading: 'Intro' } },
  ], { page: 'http://localhost:5173/' });
  assert.equal(res[0].status, 'queued');
  const q = read('.directedits.md');
  assert.match(q, /## src\/X\.jsx:1:\d+ · <h2>/);
  assert.match(q, /- after: "New title"/);
  fs.rmSync(root, { recursive: true });
});

test('HTML: text node with entities and inline element', async () => {
  const html = `<!doctype html>\n<html><body>\n  <p class="lede">Tom &amp; Jerry <em>forever</em> and ever</p>\n</body></html>\n`;
  const { read, applier } = project({ 'index.html': html });
  const loc = await locOf(html, 'index.html', 'p');
  const res = await applier.apply([
    { id: 1, loc, before: 'Tom & Jerry ', after: 'Tom & Jerry <3 ' },
    { id: 2, loc, before: ' and ever', after: ' and always' },
  ]);
  assert.deepEqual(res.map((r) => r.status), ['applied', 'applied']);
  assert.match(read('index.html'), /<p class="lede">Tom &amp; Jerry &lt;3 <em>forever<\/em> and always<\/p>/);
});

test('Astro: element text, frontmatter string, non-ASCII offsets', async () => {
  const src = `---\nconst title = "Héllo wörld 🎉";\n---\n<h1>{title}</h1>\n<p>Café ☕ time <b>now</b></p>\n`;
  const { read, applier } = project({ 'src/pages/index.astro': src });
  const out = await stamp(src, 'src/pages/index.astro', 'src/pages/index.astro');
  assert.match(out.code, /<p data-de-src="src\/pages\/index\.astro:5:1">Café/);
  const h1 = /<h1 data-de-src="([^"]+)"/.exec(out.code)[1];
  const p = /<p data-de-src="([^"]+)"/.exec(out.code)[1];
  const res = await applier.apply([
    { id: 1, loc: h1, before: 'Héllo wörld 🎉', after: 'Bonjour {monde}' },
    { id: 2, loc: p, before: 'Café ☕ time ', after: 'Tea 🍵 time ' },
  ]);
  assert.deepEqual(res.map((r) => r.via), ['file', 'element']);
  assert.equal(read('src/pages/index.astro'), `---\nconst title = "Bonjour {monde}";\n---\n<h1>{title}</h1>\n<p>Tea 🍵 time <b>now</b></p>\n`);
});

test('Markdown and JSON content in the project', async () => {
  const { read, applier } = project({
    'src/content/post.md': '# A post\n\nThis is the first paragraph.\n',
    'src/data/site.json': '{ "tagline": "Making toys for the internet" }\n',
  });
  const res = await applier.apply([
    { id: 1, loc: 'src/layouts/Base.astro:3:1', before: 'This is the first paragraph.', after: 'This is the opening.' },
    { id: 2, loc: 'src/layouts/Base.astro:4:1', before: 'Making toys for the internet', after: 'Making "toys" for the internet' },
  ]);
  assert.deepEqual(res.map((r) => r.status), ['applied', 'applied']);
  assert.match(read('src/content/post.md'), /This is the opening\./);
  assert.match(read('src/data/site.json'), /"Making \\"toys\\" for the internet"/);
});

test('rejects paths outside the root', async () => {
  const { applier } = project({ 'a.html': '<p>x</p>' });
  const [r] = await applier.apply([{ id: 1, loc: '../../etc/passwd:1:1', before: 'root', after: 'x' }]);
  assert.equal(r.status, 'queued');
});

test('Astro: native data-astro-source-loc (after opening tag) and component attributes', async () => {
  const page = `---\nimport Card from '../components/Card.astro';\n---\n<body>\n    <p>Café <b>bold</b> text</p>\n    <Card title="Things I make" class="x" />\n</body>\n`;
  const card = `---\nconst { title } = Astro.props;\n---\n<article><h2>{title}</h2></article>\n`;
  const { read, applier } = project({ 'src/pages/index.astro': page, 'src/components/Card.astro': card });
  const res = await applier.apply([
    { id: 1, loc: 'src/pages/index.astro:5:8', locMode: 'after-open-tag', before: 'Café ', after: 'Tea ' },
    { id: 2, loc: 'src/pages/index.astro:5:18', locMode: 'after-open-tag', before: 'bold', after: 'loud' },
    { id: 3, loc: 'src/components/Card.astro:4:14', locMode: 'after-open-tag', before: 'Things I make', after: 'Things I "make"' },
  ]);
  assert.deepEqual(res.map((r) => r.via), ['element', 'element', 'project']);
  assert.match(read('src/pages/index.astro'), /<p>Tea <b>loud<\/b> text<\/p>/);
  assert.match(read('src/pages/index.astro'), /<Card title="Things I &quot;make&quot;" class="x" \/>/);
});

test('JSX attribute strings use entities, not backslashes', async () => {
  const card = `export const Card = ({title}) => <section><h2>{title}</h2></section>;\n`;
  const app = `export default () => <Card title="Hello there" />;\n`;
  const { read, applier } = project({ 'src/Card.jsx': card, 'src/App.jsx': app });
  const loc = await locOf(card, 'src/Card.jsx', 'h2');
  const [r] = await applier.apply([{ id: 1, loc, before: 'Hello there', after: 'Say "hi"' }]);
  assert.equal(r.via, 'project');
  assert.match(read('src/App.jsx'), /title="Say &quot;hi&quot;"/);
});

test('Markdown: hard-wrapped paragraph', async () => {
  const { read, applier } = project({ 'src/content/a.md': 'Some intro text that is\nwrapped across two lines.\n' });
  const [r] = await applier.apply([{ id: 1, loc: null, before: 'Some intro text that is wrapped across two lines.', after: 'A shorter intro.' }]);
  assert.equal(r.status, 'applied');
  assert.equal(read('src/content/a.md'), 'A shorter intro.\n');
});

test('hard-wrapped text is re-wrapped the same way, so only edited lines change', async () => {
  const src = `export default () => (
  <main>
    <section>
      <div>
        <div>
          <article>
            <p>
              One of my favorite things about walking around in the real world
              is the causal sharing of space with other people. We share a look
              when something funny happens or help out when a stranger trips.
              Sometimes these spontaneous encounters become meaningful
              encounters that stay with us.
            </p>
          </article>
        </div>
      </div>
    </section>
  </main>
);
`;
  const { read, applier } = project({ 'src/App.tsx': src });
  const loc = await locOf(src, 'src/App.tsx', 'p');
  const before = 'One of my favorite things about walking around in the real world is the causal sharing of space with other people. We share a look when something funny happens or help out when a stranger trips. Sometimes these spontaneous encounters become meaningful encounters that stay with us.';
  const [r] = await applier.apply([{ id: 1, loc, before, after: before + ' There is so much life around us!' }]);
  assert.equal(r.status, 'applied');
  const out = read('src/App.tsx');
  const changed = out.split('\n').filter((l, i) => l !== src.split('\n')[i]);
  assert.deepEqual(changed, ['              encounters that stay with us. There is so much life around us!']);
});

test('single-line text stays on one line', async () => {
  const src = `export default () => <p>Short line here</p>;\n`;
  const { read, applier } = project({ 'src/A.jsx': src });
  const loc = await locOf(src, 'src/A.jsx', 'p');
  await applier.apply([{ id: 1, loc, before: 'Short line here', after: 'A much longer line of text that goes well past eighty characters wide, for sure' }]);
  assert.match(read('src/A.jsx'), /<p>A much longer line of text that goes well past eighty characters wide, for sure<\/p>/);
});
