/// <reference path="../.astro/types.d.ts" />
/// <reference path="../worker-configuration.d.ts" />

import type { Actor } from './lib/auth/access.ts';
import type { Executable } from './lib/db/queries.ts';
import type { SeasonListEntry } from './lib/db/snapshot.ts';
import type { Links } from './lib/links.ts';
import type { View } from './lib/view.ts';

// `declare global` is required: this file has imports, so it is a module, and a bare
// `declare namespace App` would be local to it rather than augmenting Astro's.
declare global {
  namespace App {
    interface Locals {
      db: Executable;
      /**
       * Set for every season page; absent on /admin, /api and static assets, which the
       * middleware passes straight through.
       */
      seasonSlug: string;
      view: View;
      links: Links;
      seasons: SeasonListEntry[];
      /** Who is making this admin request; only set on protected routes. */
      actor: Actor;
      /** Astro 7's replacement for locals.runtime.ctx. */
      cfContext?: { waitUntil(promise: Promise<unknown>): void };
    }
  }
}

export {};
