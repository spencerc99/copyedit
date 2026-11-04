import { defineConfig } from 'astro/config';
import copyedit from 'copyedit/astro';

export default defineConfig({ integrations: [copyedit()] });
