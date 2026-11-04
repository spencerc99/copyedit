import { defineConfig } from 'astro/config';
import directedit from 'directedit/astro';

export default defineConfig({ integrations: [directedit()] });
