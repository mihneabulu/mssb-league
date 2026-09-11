// Cloudflare Access identity.
//
// Access authenticates people at the edge before a request ever reaches this Worker, and
// forwards a signed JWT. Our job is only to verify that JWT and read the email out of it
// — no passwords, no sessions, no account table.
//
// Verification uses `jose` rather than hand-rolled RS256: this is the one piece of the
// system where a subtle mistake is a silent authentication bypass.

import { createRemoteJWKSet, jwtVerify } from 'jose';

export type Actor = {
  /** Who to show and record. For a service token this is a label, not a mailbox. */
  email: string;
  /**
   * A person who logged in, or a machine presenting a service token. Machines are
   * read-only: see MUTATING_METHODS in the middleware.
   */
  kind: 'user' | 'service';
  /** Access's stable user id, when present. */
  userId?: string;
  /** True when this is the local dev bypass rather than a real Access login. */
  dev?: boolean;
};

export type AccessConfig = {
  /** e.g. "mssbleague.cloudflareaccess.com" */
  teamDomain: string;
  /** The application's Audience (AUD) tag. */
  aud: string;
};

/** Access forwards the token in this header. */
export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

// One JWKS per team domain, cached in module scope. jose handles the fetch, the caching
// and the re-fetch on unknown key id.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export type VerifyResult =
  | { ok: true; actor: Actor }
  | { ok: false; reason: string };

/**
 * Verify an Access JWT and return who it belongs to.
 *
 * Checks the signature against the team's published keys, plus issuer and audience.
 * `jwtVerify` enforces expiry itself. Anything that fails is a refusal — this never
 * falls back to "probably fine".
 */
export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: 'no Access token on the request' };
  if (!config.teamDomain || config.teamDomain.startsWith('REPLACE_WITH')) {
    return { ok: false, reason: 'ACCESS_TEAM_DOMAIN is not configured' };
  }
  if (!config.aud || config.aud.startsWith('REPLACE_WITH')) {
    return { ok: false, reason: 'ACCESS_AUD is not configured' };
  }

  try {
    const { payload } = await jwtVerify(token, jwksFor(config.teamDomain), {
      issuer: `https://${config.teamDomain}`,
      audience: config.aud,
    });

    // Two shapes come through this header. A person who logged in via the identity
    // provider gets an `email` claim. A service token gets no email at all — it carries
    // `common_name` (the token's client id) and an empty `sub`. Requiring email rejected
    // every machine request, which is what broke the backup job.
    const email = typeof payload.email === 'string' ? payload.email : null;
    if (email) {
      return {
        ok: true,
        actor: {
          email,
          kind: 'user',
          userId: typeof payload.sub === 'string' && payload.sub ? payload.sub : undefined,
        },
      };
    }

    const commonName = typeof payload.common_name === 'string' ? payload.common_name : null;
    if (commonName) {
      return {
        ok: true,
        actor: {
          // Prefixed so it can never be confused with a person in the audit log.
          email: `service-token:${commonName}`,
          kind: 'service',
        },
      };
    }

    return { ok: false, reason: 'Access token identifies neither a person nor a service' };
  } catch (e) {
    return { ok: false, reason: `invalid Access token: ${(e as Error).message}` };
  }
}

/**
 * Reject cross-site form posts.
 *
 * Access's session cookie is ambient, so without this any page on the internet could
 * drive the admin API inside a logged-in admin's browser. Same-origin is required for
 * every state-changing request.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === new URL(request.url).origin;

  // Some browsers omit Origin on same-origin form posts; fall back to Referer.
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  return false;
}

export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Whether the local-development auth bypass applies.
 *
 * Two independent conditions, and neither can hold on the deployed site:
 *
 *  1. DEV_BYPASS_AUTH must be exactly "true". The committed wrangler config sets
 *     "false", so this differs only in an untracked local .dev.vars.
 *  2. CF-Connecting-IP must be a loopback address. `wrangler dev` sets it to 127.0.0.1;
 *     at the edge Cloudflare sets it from the actual connection, and a client on the
 *     internet cannot present a loopback source address.
 *
 * Two earlier attempts at this were wrong and are worth recording. Checking
 * import.meta.env.DEV fails because `wrangler dev` serves a production build, so the
 * real runtime could not be exercised locally at all. Checking the URL hostname fails
 * because `wrangler dev` rewrites the request to the configured custom domain, so a
 * local request arrives claiming to be mssbleague.com.
 *
 * Note this is defence in depth rather than the lock itself: Cloudflare Access
 * authenticates /admin at the edge, and an unauthenticated request never reaches the
 * Worker at all.
 */
export function devBypassAllowed(request: Request, flag: string | undefined): boolean {
  if (String(flag) !== 'true') return false;
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return false;
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.');
}
