import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import directedit from 'directedit';

export default defineConfig({ plugins: [directedit(), react()] });
