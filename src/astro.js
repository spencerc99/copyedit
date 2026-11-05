// Astro integration: adds the Vite plugin and the overlay script in `astro dev`, and in
// `astro build` when the build is a preview deploy (see the `preview` option).
import directedit from './vite.js';
import { detectPreview } from './preview.js';

/** @param {Parameters<typeof directedit>[0]} [options] */
export default function directeditAstro(options = {}) {
  return {
    name: 'directedit',
    hooks: {
      'astro:config:setup': ({ command, updateConfig, injectScript }) => {
        if (command === 'build') {
          if (!detectPreview({ preview: options.preview, productionBranch: options.productionBranch })) return;
        } else if (command !== 'dev') {
          return;
        }
        updateConfig({ vite: { plugins: [directedit({ ...options, injectClient: false })] } });
        injectScript('page', 'import "virtual:directedit-client";');
      },
    },
  };
}
