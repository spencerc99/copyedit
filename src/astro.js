// Astro integration: adds the Vite plugin and the overlay script in `astro dev` only.
import directedit from './vite.js';

/** @param {Parameters<typeof directedit>[0]} [options] */
export default function directeditAstro(options = {}) {
  return {
    name: 'directedit',
    hooks: {
      'astro:config:setup': ({ command, updateConfig, injectScript }) => {
        if (command !== 'dev') return;
        updateConfig({ vite: { plugins: [directedit({ ...options, injectClient: false })] } });
        injectScript('page', 'import "virtual:directedit-client";');
      },
    },
  };
}
