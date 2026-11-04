import { defineConfig } from 'astro/config';
import copyedit from '@spencerc99/copyedit/astro';

export default defineConfig({ integrations: [copyedit()] });
