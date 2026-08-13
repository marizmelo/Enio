// A minimal, dependency-free force-directed layout (Fruchterman-Reingold
// style): repulsion between all node pairs, spring attraction along edges,
// mild centering gravity, cooling over a fixed number of iterations. Good
// enough for a few hundred nodes and avoids pulling in d3 just for this.
//
// Deterministic: initial placement uses a seeded PRNG, not Math.random, so
// the same graph produces the same layout every time it's computed. Callers
// should compute this once per graph dataset (e.g. in a useMemo/useEffect
// keyed on the fetched data) and reuse the result across re-renders.

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function computeForceLayout(nodes, edges, opts = {}) {
  const positions = new Map();
  const n = nodes.length;
  if (n === 0) return positions;

  const iterations = opts.iterations ?? 200;
  const rand = seededRandom(1337);

  // Deterministic initial placement on a ring, radius scaled to node count.
  const initialRadius = Math.max(220, Math.sqrt(n) * 140);
  nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    const r = initialRadius * (0.35 + 0.65 * rand());
    positions.set(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  });

  const idSet = new Set(nodes.map((node) => node.id));
  const edgeList = (edges || [])
    .filter((e) => e && idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target)
    .map((e) => ({ a: e.source, b: e.target }));

  const area = Math.max(500 * 500, n * 50000);
  const k = Math.sqrt(area / Math.max(n, 1)); // ideal edge length

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Map();
    for (const node of nodes) disp.set(node.id, { x: 0, y: 0 });

    // Repulsion between every pair (O(n^2) — fine for the few-hundred-node
    // scale this UI expects; run once, not per frame).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const pa = positions.get(a.id);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const pb = positions.get(b.id);
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.01) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          dist = 0.01;
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const da = disp.get(a.id);
        const db = disp.get(b.id);
        da.x += fx;
        da.y += fy;
        db.x -= fx;
        db.y -= fy;
      }
    }

    // Spring attraction along edges.
    for (const e of edgeList) {
      const pa = positions.get(e.a);
      const pb = positions.get(e.b);
      let dx = pa.x - pb.x;
      let dy = pa.y - pb.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const da = disp.get(e.a);
      const db = disp.get(e.b);
      da.x -= fx;
      da.y -= fy;
      db.x += fx;
      db.y += fy;
    }

    // Gentle pull toward the origin so the whole graph doesn't drift.
    for (const node of nodes) {
      const p = positions.get(node.id);
      const d = disp.get(node.id);
      d.x -= p.x * 0.02;
      d.y -= p.y * 0.02;
    }

    // Apply displacement, capped and cooling over time.
    const temperature = Math.max(k * 0.15 * (1 - iter / iterations), 1);
    for (const node of nodes) {
      const d = disp.get(node.id);
      const dlen = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      const capped = Math.min(dlen, temperature);
      const p = positions.get(node.id);
      p.x += (d.x / dlen) * capped;
      p.y += (d.y / dlen) * capped;
    }
  }

  return positions;
}

/**
 * Layout with disconnected components packed side by side.
 *
 * Separate clusters share no springs, so a single force pass lets mutual
 * repulsion drift them to the corners and fitView zooms out until nothing
 * is readable. Laying each component out alone and then packing bounding
 * boxes into rows keeps every cluster's internal shape and puts the whole
 * picture inside one screenful — biggest first, so the eye lands on the
 * richest structure.
 */
export function computePackedLayout(nodes, edges, opts = {}) {
  const positions = new Map();
  if (nodes.length === 0) return positions;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges || []) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adjacency.get(e.source).push(e.target);
    adjacency.get(e.target).push(e.source);
  }

  const seen = new Set();
  const components = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const queue = [n.id];
    const ids = [];
    seen.add(n.id);
    while (queue.length) {
      const id = queue.pop();
      ids.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    components.push(ids);
  }
  components.sort((a, b) => b.length - a.length);

  const GAP = 90;
  // Aim for a roughly square overall canvas: wrap rows once they pass the
  // width the biggest component sets, times a small factor.
  let rowLimit = 0;
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const ids of components) {
    const memberSet = new Set(ids);
    const members = ids.map((id) => byId.get(id));
    const memberEdges = (edges || []).filter(
      (e) => memberSet.has(e.source) && memberSet.has(e.target),
    );
    const local = computeForceLayout(members, memberEdges, opts);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of local.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (rowLimit === 0) rowLimit = Math.max(900, width * 1.6);

    if (cursorX > 0 && cursorX + width > rowLimit) {
      cursorX = 0;
      cursorY += rowHeight + GAP;
      rowHeight = 0;
    }
    for (const [id, p] of local) {
      positions.set(id, { x: cursorX + (p.x - minX), y: cursorY + (p.y - minY) });
    }
    cursorX += width + GAP;
    rowHeight = Math.max(rowHeight, height);
  }

  return positions;
}
