import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

// Served from Cloudflare Workers at https://mssbleague.com.
//
// `output: 'server'` because the whole point of the rebuild is that a league manager
// uploads a game in the browser and sees standings change immediately — a static build
// would put a deploy pipeline back in the middle of that.
/**
 * Changes on every build. It is part of the page cache key and ETag, so deploying new
 * markup or CSS invalidates already-cached pages. Without it both were keyed only to the
 * season's data version, and a pure code change could not reach a cached page until
 * somebody happened to edit the league.
 */
const BUILD_ID = Date.now().toString(36);

export default defineConfig({
  vite: { define: { __BUILD_ID__: JSON.stringify(BUILD_ID) } },
  site: 'https://mssbleague.com',
  output: 'server',
  adapter: cloudflare({
    // Gives `astro dev` the real bindings (a local D1 via Miniflare) instead of stubs.
    platformProxy: { enabled: true },
  }),
});
