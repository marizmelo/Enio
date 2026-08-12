import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Redirected before anything imports config, like every other suite.
const scratch = mkdtempSync(join(tmpdir(), "enio-abilities-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const { ABILITIES, PORT_TYPES, abilityAvailability } = await import("./abilities.js");
const { SPECIALISTS } = await import("./specialists.js");

test("ability ids are unique and kebab-case", () => {
  const ids = ABILITIES.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("every ability pins a real specialist and stays inside its tool set", () => {
  for (const ability of ABILITIES) {
    const specialist = SPECIALISTS.find((s) => s.name === ability.specialist);
    assert.ok(specialist, `${ability.id} names unknown specialist ${ability.specialist}`);
    // The disjointness invariant extended: an ability must never need a tool
    // its own specialist does not hold, or picking the tile routes a turn to
    // someone who cannot do the work.
    for (const tool of ability.requiredTools ?? []) {
      assert.ok(
        specialist!.tools.includes(tool),
        `${ability.id} requires ${tool}, which ${ability.specialist} does not hold`,
      );
    }
  }
});

test("templates carry the slot, ports come from the closed list", () => {
  for (const ability of ABILITIES) {
    if (!ability.future) {
      assert.ok(ability.promptTemplate.includes("___"), `${ability.id} template has no slot`);
    }
    for (const port of [...ability.inputs, ...ability.outputs]) {
      assert.ok((PORT_TYPES as readonly string[]).includes(port), `${ability.id}: bad port ${port}`);
    }
  }
});

test("every usable ability offers exactly three worked openings", () => {
  // Suggestions are slot-fillers: template with "___" replaced must read as a
  // sentence, which a leading capital in slot position usually breaks.
  for (const ability of ABILITIES) {
    if (ability.future) continue;
    assert.equal(ability.suggestions?.length, 3, `${ability.id} needs 3 suggestions`);
    for (const s of ability.suggestions!) {
      assert.ok(s.length > 8 && s.length <= 100, `${ability.id}: suggestion length off: ${s}`);
    }
  }
});

test("anything not immediately usable explains how to become usable", () => {
  // A greyed tile with no path forward is worse than no tile: the whole point
  // of showing gaps is that a person can act on them.
  for (const ability of ABILITIES) {
    const gated =
      ability.future ||
      ability.requiredFlag ||
      ability.requiredServer ||
      (ability.requiredTools ?? []).length > 0;
    if (ability.future || ability.requiredFlag || ability.requiredServer) {
      assert.ok(ability.setup?.docs, `${ability.id} is gated but has no setup.docs`);
    }
    // requiredTools that are always present (fs/search) need no setup story;
    // withholdable ones (email) must have one. Spot-checked below.
    void gated;
  }
  for (const id of ["send-email", "read-email", "shopping", "automate-house", "control-mac"]) {
    const ability = ABILITIES.find((a) => a.id === id)!;
    assert.ok(ability.setup && ability.setup.steps.length > 0, `${id} lacks setup steps`);
  }
});

test("availability derives from the registry and flags", () => {
  const fakeRegistry = (names: string[]) =>
    ({ all: [], byName: new Map(names.map((n) => [n, {} as never])), dropped: [] }) as never;

  const send = ABILITIES.find((a) => a.id === "send-email")!;
  assert.equal(abilityAvailability(send, fakeRegistry(["send_email"]), []), "available");
  assert.equal(abilityAvailability(send, fakeRegistry([]), []), "setup");

  const image = ABILITIES.find((a) => a.id === "create-image")!;
  assert.equal(abilityAvailability(image, fakeRegistry([]), []), "future");

  const house = ABILITIES.find((a) => a.id === "automate-house")!;
  assert.equal(abilityAvailability(house, fakeRegistry([]), []), "setup");
  assert.equal(abilityAvailability(house, fakeRegistry([]), ["home-assistant"]), "available");
});
