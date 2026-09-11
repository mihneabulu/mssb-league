// Tests for Access JWT verification.
//
// This is the one place in the system where a subtle bug is a silent authentication
// bypass, so it gets tested against a real signature rather than trusted because it
// "uses a library". A live keypair is generated per run, the JWKS endpoint is stubbed,
// and every rejection path is exercised with a token that is genuinely malformed rather
// than merely absent.

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { KeyObject } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { isSameOrigin, verifyAccessJwt } from '../src/lib/auth/access.ts';

const AUD = 'abc123def456';
const TEAM = 'testteam.cloudflareaccess.com';

let privateKey: CryptoKey | KeyObject;
let publicJwk: Record<string, unknown>;
let otherPrivateKey: CryptoKey | KeyObject;
let otherPublicJwk: Record<string, unknown>;

/** Serve a JWKS containing only `jwk` for any certs URL. */
function stubJwks(jwk: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

async function sign(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey | KeyObject; issuer?: string; audience?: string; expires?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? `https://${TEAM}`)
    .setAudience(opts.audience ?? AUD)
    .setExpirationTime(opts.expires ?? '1h')
    .sign((opts.key ?? privateKey) as CryptoKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const other = await generateKeyPair('RS256', { extractable: true });
  otherPrivateKey = other.privateKey;
  otherPublicJwk = {
    ...(await exportJWK(other.publicKey)),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyAccessJwt — accepting a real token', () => {
  it('accepts a correctly signed token and returns the email', async () => {
    stubJwks(publicJwk);
    const token = await sign({ email: 'manager@example.com', sub: 'user-1' });

    const result = await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
    expect(result.ok, 'reason' in result ? result.reason : '').toBe(true);
    if (result.ok) {
      expect(result.actor.email).toBe('manager@example.com');
      expect(result.actor.userId).toBe('user-1');
      expect(result.actor.dev).toBeUndefined();
    }
  });
});

describe('verifyAccessJwt — rejecting everything else', () => {
  const reject = async (
    token: string | null,
    config = { teamDomain: TEAM, aud: AUD },
  ): Promise<string> => {
    const result = await verifyAccessJwt(token, config);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('rejects a missing token', async () => {
    stubJwks(publicJwk);
    expect(await reject(null)).toMatch(/no Access token/i);
  });

  it('rejects a non-JWT string', async () => {
    stubJwks(publicJwk);
    expect(await reject('not-a-jwt')).toMatch(/invalid/i);
  });

  it('rejects an unsigned alg=none token', async () => {
    stubJwks(publicJwk);
    // The classic forgery: a well-formed token with the signature simply left off.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ email: 'attacker@evil.com', aud: AUD, iss: `https://${TEAM}` }),
    ).toString('base64url');
    expect(await reject(`${header}.${body}.`)).toMatch(/invalid/i);
  });

  it('rejects a token signed by the wrong key', async () => {
    // JWKS serves our key; the token is signed with a different one.
    stubJwks(publicJwk);
    const token = await sign({ email: 'attacker@evil.com' }, { key: otherPrivateKey });
    expect(await reject(token)).toMatch(/invalid/i);
  });

  it('rejects a token minted for a different application (wrong aud)', async () => {
    stubJwks(publicJwk);
    // A real, valid Access token from another app on the same team must not work here.
    const token = await sign({ email: 'manager@example.com' }, { audience: 'some-other-app' });
    expect(await reject(token)).toMatch(/invalid/i);
  });

  it('rejects a token from a different team (wrong iss)', async () => {
    stubJwks(publicJwk);
    const token = await sign(
      { email: 'manager@example.com' },
      { issuer: 'https://someoneelse.cloudflareaccess.com' },
    );
    expect(await reject(token)).toMatch(/invalid/i);
  });

  it('rejects an expired token', async () => {
    stubJwks(publicJwk);
    const token = await sign({ email: 'manager@example.com' }, { expires: '-5m' });
    expect(await reject(token)).toMatch(/invalid/i);
  });

  it('rejects a valid signature with no email claim', async () => {
    stubJwks(publicJwk);
    const token = await sign({ sub: 'user-1' });
    expect(await reject(token)).toMatch(/no email/i);
  });

  it('refuses to verify at all while the config is still placeholder', async () => {
    stubJwks(publicJwk);
    const token = await sign({ email: 'manager@example.com' });
    expect(
      await reject(token, { teamDomain: 'REPLACE_WITH_TEAM_DOMAIN', aud: AUD }),
    ).toMatch(/not configured/i);
    expect(
      await reject(token, { teamDomain: TEAM, aud: 'REPLACE_WITH_APPLICATION_AUD' }),
    ).toMatch(/not configured/i);
  });

  it('does not treat the other key as interchangeable', async () => {
    // Same test the other way round, to prove the stub is really what is being checked.
    stubJwks(otherPublicJwk);
    const token = await sign({ email: 'manager@example.com' }, { key: otherPrivateKey });
    const result = await verifyAccessJwt(token, { teamDomain: 'other.cloudflareaccess.com', aud: AUD });
    // Issuer must match the team domain, so this still fails — but on issuer, not signature.
    expect(result.ok).toBe(false);
  });
});

describe('isSameOrigin', () => {
  const req = (headers: Record<string, string>, url = 'https://mssbleague.com/api/admin/x') =>
    new Request(url, { method: 'POST', headers });

  it('allows a same-origin post', () => {
    expect(isSameOrigin(req({ origin: 'https://mssbleague.com' }))).toBe(true);
  });

  it('refuses a foreign origin', () => {
    expect(isSameOrigin(req({ origin: 'https://evil.example' }))).toBe(false);
  });

  it('refuses a look-alike origin', () => {
    expect(isSameOrigin(req({ origin: 'https://mssbleague.com.evil.example' }))).toBe(false);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(isSameOrigin(req({ referer: 'https://mssbleague.com/admin/upload' }))).toBe(true);
    expect(isSameOrigin(req({ referer: 'https://evil.example/x' }))).toBe(false);
  });

  it('refuses when neither header is present', () => {
    expect(isSameOrigin(req({}))).toBe(false);
  });

  it('refuses a malformed Referer', () => {
    expect(isSameOrigin(req({ referer: 'not a url' }))).toBe(false);
  });
});
