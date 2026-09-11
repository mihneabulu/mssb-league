import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

// Served from Cloudflare Workers at https://mssbleague.com.
//
// `output: 'server'` because the whole point of the rebuild is that a league manager
// uploads a game in the browser and sees standings change immediately — a static build
// would put a deploy pipeline back in the middle of that.
export default defineConfig({
  site: 'https://mssbleague.com',
  output: 'server',
  adapter: cloudflare({
    // Gives `astro dev` the real bindings (a local D1 via Miniflare) instead of stubs.
    platformProxy: { enabled: true },
  }),
});
