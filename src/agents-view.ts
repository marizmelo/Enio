import { SPECIALISTS, allSpecialists } from "./specialists.js";
import { agentSkillPins, listCustomAgents } from "./custom-agents.js";
import { loadSkills, skillsFor } from "./skills.js";
import { listPipelines } from "./pipelines.js";
import { getAbility } from "./abilities.js";
import type { Registry } from "./tools/index.js";

/**
 * One agent, as the management panel shows it.
 *
 * Everything here is DERIVED, never stored: the tools are the specialist's
 * declared set intersected with what the registry actually holds right now
 * (a mail tool without an account, a desktop tool without the flag, simply
 * is not there); the skills are what skillsFor() says the prompt will list;
 * and the automations are the saved graphs with at least one step that runs as this
 * agent. Deriving it is what keeps the panel honest -- a stored copy of any
 * of this would drift the first time a grant or a flag changed.
 *
 * Skills are the one place with a stored half: the pins a user set are
 * data, and `skills` is what the prompt will actually list once the rule
 * in skillsFor() has combined pins, front matter and the everyone default.
 *
 * Custom agents get the same derivation -- only their *definition* is stored,
 * and the flag is what tells the panel which cards carry Edit and Delete.
 */
export interface AgentView {
  name: string;
  description: string;
  tools: Array<{ name: string; available: boolean; description: string }>;
  mcpServers: string[];
  /** What this agent's prompt lists: the effective set after skillsFor(). */
  skills: string[];
  /** The explicit pins only -- what the picker shows as checked. */
  pinnedSkills: string[];
  automations: string[];
  /** User-defined: editable and deletable. Built-ins are neither. */
  custom: boolean;
  /** The stored routing example, custom agents only — shown in the editor
   *  and worth a warning when absent, since the router routes by example. */
  example?: string;
  /** The instructions. Stored text for a custom agent (the editor needs it
   *  back); the code's prompt for a built-in, carried so Duplicate can
   *  start a custom agent from it. Cards do not display it either way. */
  systemPrompt: string;
}

export function agentsView(registry: Registry): AgentView[] {
  const skillSet = loadSkills();
  const pipelines = listPipelines();
  const byName = new Map(registry.all.map((t) => [t.name, t]));
  const builtinNames = new Set(SPECIALISTS.map((s) => s.name));
  const stored = new Map(listCustomAgents().map((a) => [a.name, a]));
  const pins = agentSkillPins();

  return allSpecialists().map((s) => ({
    name: s.name,
    description: s.description,
    tools: s.tools.map((name) => {
      const tool = byName.get(name);
      return {
        name,
        available: Boolean(tool),
        // The first sentence is the honest summary; the rest is model-facing
        // instruction that reads as noise in a management panel.
        description: tool ? (tool.description.split(". ")[0] ?? "").slice(0, 110) : "Not configured — withheld.",
      };
    }),
    mcpServers: s.mcpServers ?? [],
    skills: skillsFor(s.name, skillSet).map((skill) => skill.name),
    pinnedSkills: pins[s.name] ?? [],
    automations: pipelines
      .filter((p) => p.nodes.some((n) => getAbility(n.abilityId)?.specialist === s.name))
      .map((p) => p.name),
    custom: !builtinNames.has(s.name),
    systemPrompt: stored.get(s.name)?.systemPrompt ?? s.systemPrompt,
    ...(stored.has(s.name) ? { example: stored.get(s.name)!.example ?? "" } : {}),
  }));
}
