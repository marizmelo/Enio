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
