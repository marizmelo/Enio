import { getDb } from "./memory/db.js";

/**
 * The scheduler lease: exactly one process fires cron jobs.
 *
 * The desktop's serve() and a headless `enio daemon` both want to run the
 * scheduler, and running it twice fires every task twice. The lease is one
 * row in the shared database, claimed and refreshed by a single guarded
 * UPSERT: the update only lands when the row is already mine or has gone
 * stale. `changes > 0` therefore answers "am I the holder" atomically --
 * there is no read-then-write gap for a second process to slip through,
 * which is what a lock file could not offer without a create/stat/unlink
 * dance.
 *
 * Demotion is the same statement failing: a holder whose refresh reports no
 * changes has been superseded (or its clock skewed far enough to look dead)
 * and must stop firing jobs. Fires missed during a handover gap are dropped,
 * not replayed -- croner has no catch-up, and a task designed around "runs
 * at 9am" degrades acceptably to "missed one 9am" but not to "ran twice".
 */

/** Three sync intervals: a holder misses two refreshes before losing the
 *  lease, so one slow tick does not cause a spurious handover. */
export const LEASE_FRESH_MS = 90_000;

interface LeaseClock {
  pid: number;
  now: () => number;
}

const real: LeaseClock = { pid: process.pid, now: () => Date.now() };

/**
 * Claim or refresh the lease. Returns true when this process holds it after
 * the call. One statement, so acquisition and refresh cannot race each other
 * across processes.
 */
export function tryAcquireLease(clock: LeaseClock = real): boolean {
  const at = clock.now();
  const result = getDb()
    .prepare(
      `INSERT INTO scheduler_lease (id, pid, at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, at = excluded.at
       WHERE scheduler_lease.pid = excluded.pid OR scheduler_lease.at < ?`,
    )
    .run(clock.pid, at, at - LEASE_FRESH_MS);
  return result.changes > 0;
}

/** Release only our own claim, so a standby's release cannot evict the
 *  holder. Clean shutdown calls this; after a SIGKILL the row just goes
 *  stale and the standby steals it within LEASE_FRESH_MS. */
export function releaseLease(clock: LeaseClock = real): void {
  getDb().prepare(`DELETE FROM scheduler_lease WHERE id = 1 AND pid = ?`).run(clock.pid);
}

/** For the routes: is anyone scheduling right now, and who. */
export function leaseInfo(clock: LeaseClock = real): { fresh: boolean; pid: number | null } {
  const row = getDb().prepare(`SELECT pid, at FROM scheduler_lease WHERE id = 1`).get() as
    | { pid: number; at: number }
    | undefined;
  if (!row) return { fresh: false, pid: null };
  return { fresh: clock.now() - row.at < LEASE_FRESH_MS, pid: row.pid };
}
