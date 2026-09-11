// Shared plumbing for the admin form handlers.
//
// Every editing screen is an ordinary HTML form that POSTs and gets redirected back,
// so the whole admin works with JavaScript disabled and the browser's back button
// behaves. JS only ever adds convenience on top.

import type { Executable } from '../db/queries.ts';

/**
 * Redirect after a successful POST.
 *
 * 303 specifically: it makes the browser follow up with a GET, so a refresh re-reads
 * the page instead of re-submitting the form.
 */
export function seeOther(location: string, message?: string): Response {
  const url = message
    ? `${location}${location.includes('?') ? '&' : '?'}ok=${encodeURIComponent(message)}`
    : location;
  return new Response(null, { status: 303, headers: { location: url } });
}

/** Redirect back with an error banner. */
export function failed(location: string, message: string): Response {
  const url = `${location}${location.includes('?') ? '&' : '?'}err=${encodeURIComponent(message)}`;
  return new Response(null, { status: 303, headers: { location: url } });
}

/** A validation problem the user can fix, as opposed to a bug. */
export class InputError extends Error {}

export const str = (form: FormData, key: string): string =>
  String(form.get(key) ?? '').trim();

export function required(form: FormData, key: string, label = key): string {
  const value = str(form, key);
  if (!value) throw new InputError(`${label} is required.`);
  return value;
}

export function int(form: FormData, key: string, label = key): number {
  const raw = str(form, key);
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) throw new InputError(`${label} must be a number.`);
  return Math.trunc(n);
}

export function optionalInt(form: FormData, key: string): number | null {
  const raw = str(form, key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Turn a name into a URL-safe slug, matching the style of the existing team slugs. */
export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** A hex colour, or a fallback — never trust a colour straight into a style attribute. */
export const safeColor = (value: string, fallback = '#888888'): string =>
  /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;

export const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Record who did what. Every mutation calls this — it is the only history the database
 * has, now that changes no longer arrive as git commits.
 */
export async function audit(
  db: Executable,
  actorEmail: string,
  action: string,
  detail: { seasonId?: number | null; entity?: string; entityId?: string | number; detail?: string } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO audit_log (at, actor, action, season_id, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      now(),
      actorEmail,
      action,
      detail.seasonId ?? null,
      detail.entity ?? null,
      detail.entityId === undefined ? null : String(detail.entityId),
      detail.detail ?? null,
    ],
  );
}

/** Wrap a handler so InputError becomes a friendly redirect rather than a 500. */
export async function handle(
  backTo: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InputError) return failed(backTo, e.message);
    console.error('admin action failed:', e);
    return failed(backTo, `Something went wrong: ${(e as Error).message}`);
  }
}
