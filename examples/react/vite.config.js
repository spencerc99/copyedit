import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import copyedit from '@spencerc99/copyedit';

export default defineConfig({ plugins: [copyedit(), react()] });
