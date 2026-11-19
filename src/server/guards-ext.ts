import type {Context, MiddlewareHandler} from 'hono';
import {createMiddleware} from 'hono/factory';

import {forbidden, requirePermission} from '../platform/guards';
import {PERMISSIONS} from './permissions';

/**
 * Route guards built ONLY from the platform's `requirePermission` (so the answer, the wildcard
 * handling and the per-request memoized access are exactly the platform's). Same place in the
 * chain: `validator → withViewer → requireAuth → requireAnyPermission(...) → withDb`.
 */

/**
 * Users holding AT LEAST ONE of `codenames`; everyone else gets the standard `403 forbidden`.
 * Each codename is asked through `requirePermission` without letting it answer: it either calls
 * its `next` (granted) or returns its 403 (not granted, nothing written to the context).
 */
export const requireAnyPermission = (...codenames: string[]): MiddlewareHandler =>
  createMiddleware(async (c, next) => {
    for (const codename of codenames) if (await holdsPermission(c, codename)) return next();
    return forbidden(c);
  });

/** Does the signed-in viewer hold `codename` (all of it, not only `_own`)? The same answer `requirePermission` gives, inside a handler. */
export async function holdsPermission(c: Context, codename: string): Promise<boolean> {
  let granted = false;
  await requirePermission(codename)(c, async () => {
    granted = true;
  });
  return granted;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** For a `.use('*')` on a router: reads (GET/HEAD) take any of `read`, every other method any of `write`. */
export const requireReadOrWrite = (read: readonly string[], write: readonly string[]): MiddlewareHandler => {
  const readGuard = requireAnyPermission(...read);
  const writeGuard = requireAnyPermission(...write);
  return createMiddleware(async (c, next) => (SAFE_METHODS.has(c.req.method) ? readGuard(c, next) : writeGuard(c, next)));
};

/**
 * THE events-admin read guard: see-only (`site:event:read`, the store's read-only demo role) or
 * manage. Only on GET routes; every write stays on `requirePermission(PERMISSIONS.EVENT_MANAGE)`.
 * Exports of guests' personal data (CSV) stay manage-only.
 */
export const EVENT_READERS = [PERMISSIONS.EVENT_READ, PERMISSIONS.EVENT_MANAGE] as const;
export const requireEventRead = (): MiddlewareHandler => requireAnyPermission(...EVENT_READERS);

/** Door reads: door staff, managers, or see-only admins. */
export const requireDoorRead = (): MiddlewareHandler =>
  requireAnyPermission(PERMISSIONS.EVENT_CHECKIN, PERMISSIONS.EVENT_MANAGE, PERMISSIONS.EVENT_READ);
