/**
 * What you can do now, then what you could set up, then what is coming.
 *
 * Declaration order put "set up" and "soon" tiles in the middle of the grid,
 * so the first read of the page was a mix of live capability and tiles that
 * do nothing when clicked — and a greyed tile costs as much attention as a
 * working one. Ranked instead, with the order inside each band left alone:
 * that order is the deliberate one in abilities.ts, and only the banding is a
 * display decision.
 *
 * Pure and dependency-free so the Node suite can test it.
 */

const RANK = { available: 0, setup: 1, future: 2 };

export function launcherOrder(abilities) {
  return abilities
    .filter((a) => !a.launcherHidden)
    .map((a, i) => ({ a, i }))
    // An unrecognised state sorts with the working ones rather than sinking
    // to the bottom: a tile the client does not understand is still a tile,
    // and quietly demoting it is how a capability disappears.
    .sort((x, y) => (RANK[x.a.availability] ?? 0) - (RANK[y.a.availability] ?? 0) || x.i - y.i)
    .map(({ a }) => a);
}
