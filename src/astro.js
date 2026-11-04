// Astro integration: adds the Vite plugin and the overlay script in `astro dev` only.
import copyedit from './vite.js';

/** @param {Parameters<typeof copyedit>[0]} [options] */
export default function copyeditAstro(options = {}) {
  return {
    name: 'copyedit',
    hooks: {
      'astro:config:setup': ({ command, updateConfig, injectScript }) => {
        if (command !== 'dev') return;
        updateConfig({ vite: { plugins: [copyedit({ ...options, injectClient: false })] } });
        injectScript('page', 'import "virtual:copyedit-client";');
      },
    },
  };
}
