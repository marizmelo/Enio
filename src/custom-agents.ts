import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * User-defined agents: the same shape as a built-in specialist, stored on
 * disk instead of in code.
 *
 * The six-tool ceiling and the closed tool list are not relaxed here — they
 * are enforced at save time, the way project fields are: refuse, never
 * truncate. What a custom agent adds is a new *slice* of the registry with
 * its own prompt and routing description, which is exactly the operation the
 * built-ins perform; nothing about being user-authored changes what the
 * model sees per turn. Built-ins stay uneditable: their tool sets are pinned
 * by tests and their router examples were each earned by a measured failure,
 * so "edit" for them would mean silently un-fixing bugs.
 *
 * Only the user creates these — over the authed HTTP routes, like projects.
 * No tool writes this file, so an agent can never mint itself a colleague
 * with tools it was not given.
 */
export interface StoredAgent {
  name: string;
  /** Shown to the router. Written as the user would describe their request. */
  description: string;
  systemPrompt: string;
  /** A request that should route here — becomes a router example, which at
   *  this model size is worth more than the description itself. */
  example?: string;
  /** Built-in or MCP tool names; read_skill is always included. */
  tools: string[];
  /** Skills pinned to this agent by name. See skillsFor() for the rule. */
  skills?: string[];
}

/** Sized like project fields: against the smallest context budget, because
 *  the description rides every routing call and the prompt every turn. */
const CAPS = { name: 30, description: 300, systemPrompt: 2000, example: 120 } as const;

/** In the registry so the approval endpoint can execute it, but never on any
 *  agent: the model proposes scripts, a person runs them. A custom agent is
 *  still the model, so the same line holds. */
const NEVER_HELD = new Set(["run_applescript"]);

/**
 * The read/act boundary, enforced on custom agents at save exactly as the
 * disjointness test enforces it on the built-ins: no agent both reads
 * untrusted web content and holds a tool that acts. No wording defends
 * against a page's instructions reliably — capability does — and a
 * user-assembled agent with web_fetch and run_command would hand any page
 * it reads a shell. web.test.ts keeps its own copy of these lists on
 * purpose: independent duplication is the tripwire if either side is
 * quietly weakened.
 */
const READS_UNTRUSTED = new Set(["browse", "web_fetch", "web_fetch_rendered", "web_search"]);
const MUTATES = new Set([
  "write_file",
  "edit_file",
  "run_command",
  "send_email",
  "propose_plan",
  "run_applescript",
  "open_app",
  "mac_recipe",
  "remember",
  "set_preference",
  "take_screenshot",
]);

const NAME_RE = /^[a-z][a-z0-9-]{1,29}$/;

const agentsFile = () => join(config.dataDir, "agents.json");
/** Skills pinned to BUILT-IN agents. Built-ins are code, and their tool sets
 *  are not editable -- but know-how is not capability, so attaching skills
 *  to them is allowed, and this overlay is where that lives. */
const overlayFile = () => join(config.dataDir, "agent-skills.json");

export function listCustomAgents(): StoredAgent[] {
  try {
    if (!existsSync(agentsFile())) return [];
    const raw = JSON.parse(readFileSync(agentsFile(), "utf8"));
    if (!Array.isArray(raw)) return [];
    // A hand-edited file with a malformed entry loses that entry, not the
    // panel: every consumer (router menu, turn loop) assumes these fields.
    return raw.filter(
      (a): a is StoredAgent =>
        a &&
        typeof a.name === "string" &&
        typeof a.description === "string" &&
        typeof a.systemPrompt === "string" &&
        Array.isArray(a.tools) &&
        a.tools.every((t: unknown) => typeof t === "string"),
    );
  } catch {
    return [];
  }
}

/** What the caller knows that this leaf module must not duplicate: the
 *  registry's live tool names, the built-in specialist names, the installed
 *  skills. Passed in, so this file imports nothing that imports it. */
export interface SaveContext {
  knownTools: string[];
  builtinNames: string[];
  knownSkills?: string[];
}

/**
 * Validate and persist one agent. Saving an existing name replaces it — that
 * is the edit path, and only custom agents live in this file so a built-in
 * can never be shadowed by it (the name collision is refused instead).
 */
export function saveCustomAgent(
  input: {
    name?: unknown;
    description?: unknown;
    systemPrompt?: unknown;
    example?: unknown;
    tools?: unknown;
    skills?: unknown;
  },
  { knownTools, builtinNames, knownSkills = [] }: SaveContext,
): StoredAgent {
  const name = String(input.name ?? "").trim();
  if (!NAME_RE.test(name)) {
    throw new Error(
      "Agent names are 2-30 characters: lowercase letters, digits and dashes, starting with a letter.",
    );
  }
  if (builtinNames.includes(name)) {
    throw new Error(`"${name}" is a built-in agent — pick another name.`);
  }

  const description = String(input.description ?? "").trim();
  if (description.length < 8) {
    throw new Error(
      "The description is what routing reads — say what requests this agent should get.",
    );
  }
  const systemPrompt = String(input.systemPrompt ?? "").trim();
  if (!systemPrompt) {
    throw new Error("Instructions are required — they are the agent.");
  }
  const example = String(input.example ?? "").trim();
  for (const [field, cap] of Object.entries(CAPS)) {
    const value = { name, description, systemPrompt, example }[field]!;
    if (value.length > cap) {
      // Refuse, never truncate: a silently shortened prompt behaves like a
      // different agent than the one the user wrote.
      throw new Error(`${field} is ${value.length} characters; the limit is ${cap}.`);
    }
  }

  const picked = [...new Set((Array.isArray(input.tools) ? input.tools : []).map(String))].filter(
    (t) => t !== "read_skill",
  );
  const existing = listCustomAgents();
  // Editing tolerance: a tool this agent already holds stays choosable even
  // if its grant lapsed since — the registry withholds it at runtime anyway,
  // and forcing its removal to save an unrelated edit would be hostile.
  const already = new Set(existing.find((a) => a.name === name)?.tools ?? []);
  const known = new Set(knownTools);
  for (const t of picked) {
    if (NEVER_HELD.has(t)) {
      throw new Error(`${t} is never held by an agent — scripts are proposed, then a person runs them.`);
    }
    if (!known.has(t) && !already.has(t)) {
      throw new Error(`No tool named "${t}" exists right now.`);
    }
  }
  const reads = picked.filter((t) => READS_UNTRUSTED.has(t));
  const acts = picked.filter((t) => MUTATES.has(t));
  if (reads.length > 0 && acts.length > 0) {
    throw new Error(
      `An agent cannot both read the web (${reads.join(", ")}) and act (${acts.join(", ")}) — ` +
        `a page could tell it what to do and it would be able to. Split it into two agents.`,
    );
  }

  // read_skill rides along like it does on every built-in: know-how is one
  // shared slot. It counts toward the ceiling, so the user picks up to five.
  const tools = [...picked, "read_skill"];
  if (tools.length > 6) {
    throw new Error(
      "An agent holds at most six tools, and read_skill is always one of them — pick up to five.",
    );
  }
  if (picked.length === 0) {
    throw new Error("Pick at least one tool — an agent that can only read skills does nothing.");
  }

  const agent: StoredAgent = { name, description, systemPrompt, tools };
  if (example) agent.example = example;
  const skills = validSkillPins(input.skills, knownSkills);
  if (skills.length > 0) agent.skills = skills;
  const next = existing.filter((a) => a.name !== name).concat(agent);
  writeFileSync(agentsFile(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return agent;
}

/** Remove one custom agent. False when no custom agent has that name —
 *  including built-in names, which the caller refuses separately. */
export function deleteCustomAgent(name: string): boolean {
  const existing = listCustomAgents();
  const next = existing.filter((a) => a.name !== name);
  if (next.length === existing.length) return false;
  writeFileSync(agentsFile(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return true;
}

function validSkillPins(input: unknown, knownSkills: string[]): string[] {
  const picked = [...new Set((Array.isArray(input) ? input : []).map(String))];
  const known = new Set(knownSkills);
  for (const name of picked) {
    if (!known.has(name)) throw new Error(`No skill named "${name}" is installed.`);
  }
  return picked;
}

function readOverlay(): Record<string, string[]> {
  try {
    if (!existsSync(overlayFile())) return {};
    const raw = JSON.parse(readFileSync(overlayFile(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string[]> = {};
    for (const [agent, skills] of Object.entries(raw)) {
      if (Array.isArray(skills)) out[agent] = skills.map(String);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Pin skills to one agent by name. A built-in's pins go to the overlay; a
 * custom agent's go into its own record. Either way the rule the prompt
 * applies is the same -- see skillsFor() in skills.ts.
 */
export function setAgentSkills(
  agent: string,
  input: unknown,
  { knownSkills, builtinNames }: { knownSkills: string[]; builtinNames: string[] },
): string[] {
  const skills = validSkillPins(input, knownSkills);
  if (builtinNames.includes(agent)) {
    const overlay = readOverlay();
    if (skills.length > 0) overlay[agent] = skills;
    else delete overlay[agent];
    writeFileSync(overlayFile(), JSON.stringify(overlay, null, 2) + "\n", "utf8");
    return skills;
  }
  const existing = listCustomAgents();
  const found = existing.find((a) => a.name === agent);
  if (!found) throw new Error(`No agent named ${agent}.`);
  if (skills.length > 0) found.skills = skills;
  else delete found.skills;
  writeFileSync(agentsFile(), JSON.stringify(existing, null, 2) + "\n", "utf8");
  return skills;
}

/** Every explicit pin, by agent: the overlay for built-ins, the records
 *  for custom agents. What skillsFor() reads. */
export function agentSkillPins(): Record<string, string[]> {
  const pins = readOverlay();
  for (const a of listCustomAgents()) {
    if (a.skills && a.skills.length > 0) pins[a.name] = a.skills;
  }
  return pins;
}
