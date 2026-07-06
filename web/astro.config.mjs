import { defineConfig } from 'astro/config';

// Deployed to GitHub Pages as a project site:
//   https://mihneabulu.github.io/mssb-league/
// If you rename the repo, update `base` to match ("/<repo-name>").
export default defineConfig({
  site: 'https://mihneabulu.github.io',
  base: '/mssb-league',
  output: 'static',
});
