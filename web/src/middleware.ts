// Per-request wiring: resolve the season, expose the view to pages, and serve repeat
// visitors from the edge cache.

import { defineMiddleware } from 'astro:middleware';
// Astro 7 removed Astro.locals.runtime.env; bindings come from the Workers runtime.
import { env } from 'cloudflare:workers';

import type { Actor } from './lib/auth/access.ts';
import {
  ACCESS_JWT_HEADER,
  isSameOrigin,
  MUTATING_METHODS,
  verifyAccessJwt,
} from './lib/auth/access.ts';
import { d1 } from './lib/db/d1.ts';
import { getSeasonVersion, getSnapshot, listSeasons } from './lib/db/snapshot.ts';
import { makeLinks } from './lib/links.ts';
import { makeView } from './lib/view.ts';

/**
 * The Workers runtime adds `caches.default`, which the DOM's CacheStorage type does not
 * describe. One narrow cast here beats loosening types across the file.
 */
const edgeCache = (caches as unknown as { default: Cache }).default;

/** Everything behind Cloudflare Access. */
const PROTECTED = /^\/(admin|api\/admin)(\/|$)/;

/** Paths that are never a season page. */
const PASSTHROUGH = /^\/(admin|api|_astro|_image|portraits|404|favicon\.ico|robots\.txt)(\/|$)/;

const seasonSlugOf = (pathname: string): string | null => {
  const seg = pathname.split('/')[1];
  return seg ? seg : null;
};

export const onRequest = defineMiddleware(async (context, next) => {
  const { locals, request } = context;
  const url = new URL(request.url);

  if (!env?.DB) {
    // No binding usually means `astro dev` without platformProxy, or a missing
    // d1_databases entry. Fail loudly rather than rendering an empty league.
    return new Response(
      'No D1 binding. Run `npm run dev` (platformProxy) and check wrangler.jsonc.',
      { status: 500, headers: { 'content-type': 'text/plain' } },
    );
  }

  const db = d1(env.DB);
  locals.db = db;

  if (PROTECTED.test(url.pathname)) {
    const gate = await guardAdmin(request);
    if ('response' in gate) return gate.response;
    // Every admin action is attributable: the audit log records this email.
    locals.actor = gate.actor;
    return next();
  }

  if (PASSTHROUGH.test(url.pathname)) return next();

  const isGet = request.method === 'GET' || request.method === 'HEAD';
  const slug = seasonSlugOf(url.pathname);

  // The bare domain is not a page; send it to whichever season is current. A redirect
  // rather than a rewrite so the address bar shows the permanent, season-scoped URL.
  if (!slug) {
    const seasons = await listSeasons(db);
    const current = seasons.find((s) => s.isCurrent) ?? seasons[0];
    if (!current) return next();
    return context.redirect(`/${current.slug}`, 302);
  }

  const loaded = await getSnapshot(db, slug);
  // Not a season at all. Hand off to the 404 page, which is in PASSTHROUGH so this
  // rewrite does not come straight back here.
  if (!loaded) return context.rewrite('/404');

  // --- edge cache -----------------------------------------------------------------
  // The key carries the season's version, so a write that bumps the version makes every
  // previously cached URL unreachable at once. That is the only invalidation that works
  // for a Worker: caches.default.delete() only affects the colo that runs it.
  const version = await getSeasonVersion(db, slug);
  // NOTE: measured in production, Cloudflare strips this ETag from Worker-generated
  // responses on this plan — on the cache-hit path, `x-cache` and `cache-control` set on
  // the same Headers object arrive intact while `etag` does not. So browsers currently
  // re-download rather than getting a 304. It is kept because it costs nothing, is
  // correct, and the edge cache (below) is what actually matters: a repeat request is
  // served from cache for ~1 ms of CPU without re-rendering.
  //
  // Strong rather than weak (W/): for a given season version the bytes are identical.
  const etag = `"${slug}-${version}"`;
  const cacheKey = new Request(`${url.origin}${url.pathname}?__v=${version}`, {
    method: 'GET',
  });
  const useCache = isGet && import.meta.env.PROD;

  if (isGet && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  if (useCache) {
    const hit = await edgeCache.match(cacheKey);
    if (hit) {
      const fresh = new Response(hit.body, {
        status: hit.status,
        statusText: hit.statusText,
        headers: new Headers(hit.headers),
      });
      fresh.headers.set('etag', etag);
      fresh.headers.set('cache-control', 'public, max-age=0, must-revalidate');
      fresh.headers.set('x-cache', 'hit');
      return fresh;
    }
  }

  locals.seasonSlug = slug;
  locals.view = makeView(loaded.snapshot);
  locals.links = makeLinks(slug);
  locals.seasons = await listSeasons(db);

  const response = await next();

  if (response.status === 200 && isGet) {
    if (useCache) {
      // Headers are rebuilt explicitly rather than relying on `new Response(body, res)`
      // to carry them across — in the Workers runtime that did NOT copy headers set
      // before the call, which silently dropped the ETag.
      const stored = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      stored.headers.set('etag', etag);
      // Long-lived on purpose: the cache key already contains the season version, so a
      // write makes this entry unreachable rather than stale.
      stored.headers.set('cache-control', 'public, max-age=31536000, immutable');

      const write = edgeCache.put(cacheKey, stored);
      // Astro 7 renamed locals.runtime.ctx to locals.cfContext.
      const ctx = locals.cfContext;
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }

    // What the browser gets: always revalidate, but a matching ETag costs a 304 rather
    // than a render.
    response.headers.set('etag', etag);
    response.headers.set('cache-control', 'public, max-age=0, must-revalidate');
  }

  return response;
});

/**
 * Gate the admin surface. Returns a Response to refuse, or null to allow.
 *
 * In production Access authenticates at the edge and a request without a valid token
 * should be impossible — so a missing token means something is misconfigured, and this
 * fails closed rather than assuming the edge already checked.
 */
async function guardAdmin(
  request: Request,
): Promise<{ response: Response } | { actor: Actor }> {
  const deny = (status: number, message: string) => ({
    response: new Response(message, { status, headers: { 'content-type': 'text/plain' } }),
  });

  // Cross-site posts are refused before authentication is even considered: the Access
  // cookie is ambient, so a valid token proves who, not that they meant to.
  if (MUTATING_METHODS.has(request.method) && !isSameOrigin(request)) {
    return deny(403, 'Cross-origin request refused.');
  }

  // Local development has no Access in front of it. Both conditions are required, so
  // this cannot be switched on in a deployed Worker by setting a var alone.
  // String() because `wrangler types` narrows vars to their literal configured value.
  if (import.meta.env.DEV && String(env.DEV_BYPASS_AUTH) === 'true') {
    return { actor: { email: 'dev@localhost', dev: true } };
  }

  const result = await verifyAccessJwt(request.headers.get(ACCESS_JWT_HEADER), {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
  });

  if (!result.ok) {
    console.warn(`admin request refused: ${result.reason}`);
    return deny(403, 'Not authorized. Sign in through Cloudflare Access.');
  }

  return { actor: result.actor };
}
