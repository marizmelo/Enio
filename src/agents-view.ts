import { SPECIALISTS, allSpecialists } from "./specialists.js";
import { listCustomAgents } from "./custom-agents.js";
import { loadSkills } from "./skills.js";
import { listPipelines } from "./pipelines.js";
import { getAbility } from "./abilities.js";
import type { Registry } from "./tools/index.js";

/**
 * One agent, as the management panel shows it.
 *
 * Everything here is DERIVED, never stored: the tools are the specialist's
 * declared set intersected with what the registry actually holds right now
 * (a mail tool without an account, a desktop tool without the flag, simply
 * is not there); the skills are the ones whose allowed-tools overlap this
 * agent's, because a skill the agent cannot act on is not its skill; and the
 * automations are the saved graphs with at least one step that runs as this
 * agent. Deriving it is what keeps the panel honest -- a stored copy of any
 * of this would drift the first time a grant or a flag changed.
 *
 * Custom agents get the same derivation -- only their *definition* is stored,
 * and the flag is what tells the panel which cards carry Edit and Delete.
 */
export interface AgentView {
  name: string;
  description: string;
  tools: Array<{ name: string; available: boolean; description: string }>;
  mcpServers: string[];
  skills: string[];
  automations: string[];
  /** User-defined: editable and deletable. Built-ins are neither. */
  custom: boolean;
  /** The stored routing example, custom agents only — shown in the editor
   *  and worth a warning when absent, since the router routes by example. */
  example?: string;
  /** The stored instructions, custom agents only — the editor needs them
   *  back; built-in prompts are code, not data to display. */
  systemPrompt?: string;
}

export function agentsView(registry: Registry): AgentView[] {
  const skills = loadSkills().skills;
  const pipelines = listPipelines();
  const byName = new Map(registry.all.map((t) => [t.name, t]));
  const builtinNames = new Set(SPECIALISTS.map((s) => s.name));
  const stored = new Map(listCustomAgents().map((a) => [a.name, a]));

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
    skills: skills
      .filter((skill) => (skill.allowedTools ?? []).some((t) => s.tools.includes(t)))
      .map((skill) => skill.name),
    automations: pipelines
      .filter((p) => p.nodes.some((n) => getAbility(n.abilityId)?.specialist === s.name))
      .map((p) => p.name),
    custom: !builtinNames.has(s.name),
    ...(stored.has(s.name)
      ? { example: stored.get(s.name)!.example ?? "", systemPrompt: stored.get(s.name)!.systemPrompt }
      : {}),
  }));
}
