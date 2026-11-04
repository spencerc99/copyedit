import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import copyedit from 'copyedit';

export default defineConfig({ plugins: [copyedit(), react()] });
