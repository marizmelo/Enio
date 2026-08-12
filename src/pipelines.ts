import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import {
  ABILITIES,
  abilitySkill,
  composableAbilityIds,
  getAbility,
  type PortType,
} from "./abilities.js";
import { runTurn } from "./agent.js";
import { config, projectRoot } from "./config.js";
import { getDb } from "./memory/db.js";
import { startSession } from "./memory/store.js";
import { contextBudget } from "./model-settings.js";
import { complete, repairJson } from "./model.js";
import { loadSkills } from "./skills.js";
import { setMemorySession } from "./tools/memory.js";
import { setBrowseSession } from "./tools/browse.js";
import { setPlanSession } from "./tools/desktop.js";
import type { Registry } from "./tools/index.js";
import type { Message } from "./types.js";

/**
 * Pipelines: abilities composed into a graph the *harness* owns.
 *
 * The one-hop invariant survives intact. Each node is one ordinary narrow
 * turn -- runTurn with the ability's specialist pinned -- and no node ever
 * talks to another; what flows between them is artifacts, moved by this
 * module. The model's only structural role is composePipeline, which is
 * classification into a closed vocabulary (ability ids), zod-refused on
 * anything it invents, and its output is a *draft on an editable canvas*,
 * never something that executes.
 *
 * Node prompts are guidance, not scripts: inside a node the specialist keeps
 * its whole tool loop, exactly as it would in chat. Which also means every
 * gate applies unchanged -- email stays dry-run, desktop actions still
 * propose plans for approval -- because there is no pipeline-shaped side
 * door into any tool. Deliberately NOT built on the plans table: planSteps()
 * coerces unknown kinds to applescript and runScript falls through to bash,
 * and a prompt executed as shell is the sharpest failure this design avoids.
 */

/* ------------------------------------------------------------------ model */

export interface PipelineNode {
  id: string;
  abilityId: string;
  prompt: string;
  note?: string;
  /** Canvas position; stored verbatim, never interpreted server-side. */
  position?: { x: number; y: number };
}

export interface PipelineEdge {
  from: string;
  to: string;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  createdAt: number;
  lastRunAt: number | null;
}

export interface Artifact {
  type: PortType;
  /** Present for file-kind artifacts; a path the fs tools can re-resolve. */
  path?: string;
  /** Present for text artifacts. */
  text?: string;
}

export interface NodeResult {
  nodeId: string;
  status: "finished" | "failed" | "skipped";
  reply: string;
  artifacts: Artifact[];
  error?: string;
}

export type RunEvent =
  | { type: "node_started"; nodeId: string }
  | { type: "node_content"; nodeId: string; content: string }
  | { type: "node_tool"; nodeId: string; tool: string }
  | { type: "node_finished"; nodeId: string; artifacts: Artifact[]; reply: string }
  | { type: "node_failed"; nodeId: string; error: string }
  | { type: "node_skipped"; nodeId: string }
  | { type: "run_finished"; status: "succeeded" | "failed"; runId: string };

/* ------------------------------------------------------------- validation */

const FILE_KINDS: PortType[] = ["file", "document", "image", "email_draft"];

export function validatePipeline(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
): { ok: true; order: string[] } | { ok: false; reason: string } {
  if (nodes.length === 0) return { ok: false, reason: "A pipeline needs at least one step." };
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return { ok: false, reason: `Duplicate node id ${node.id}.` };
    ids.add(node.id);
    const ability = getAbility(node.abilityId);
    if (!ability) return { ok: false, reason: `Unknown ability "${node.abilityId}".` };
    if (ability.future) {
      return { ok: false, reason: `"${ability.title}" is not built yet and cannot run.` };
    }
  }
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      return { ok: false, reason: "An edge references a node that does not exist." };
    }
    if (edge.from === edge.to) return { ok: false, reason: "A step cannot feed itself." };
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) return { ok: false, reason: "Duplicate edge." };
    seen.add(key);
    // The port rule: something the upstream produces must be something the
    // downstream accepts. This is the compile-time face of "results match
    // expectations" -- a chain that cannot typecheck never gets to surprise
    // anyone at run time.
    const from = getAbility(nodes.find((n) => n.id === edge.from)!.abilityId)!;
    const to = getAbility(nodes.find((n) => n.id === edge.to)!.abilityId)!;
    if (!from.outputs.some((p) => to.inputs.includes(p))) {
      return {
        ok: false,
        reason: `"${from.title}" produces ${from.outputs.join("/")}, which "${to.title}" does not accept.`,
      };
    }
  }

  // Kahn's: the order is the executor's schedule, and a leftover node is a
  // cycle -- refused, because a cycle can only mean the composer or the
  // canvas produced something no schedule satisfies.
  const indegree = new Map<string, number>([...ids].map((id) => [id, 0]));
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const queue = [...ids].filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of edges) {
      if (e.from !== id) continue;
      const left = (indegree.get(e.to) ?? 1) - 1;
      indegree.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }
  if (order.length !== ids.size) return { ok: false, reason: "The steps form a loop." };
  return { ok: true, order };
}

/* ------------------------------------------------------------------- crud */

interface PipelineRow {
  id: string;
  name: string;
  description: string;
  graph: string;
  created_at: number;
  last_run_at: number | null;
}

function hydrate(row: PipelineRow): Pipeline {
  const graph = JSON.parse(row.graph) as { nodes: PipelineNode[]; edges: PipelineEdge[] };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
  };
}

export function listPipelines(): Pipeline[] {
  const rows = getDb()
    .prepare(`SELECT * FROM pipelines ORDER BY created_at DESC`)
    .all() as PipelineRow[];
  return rows.map(hydrate);
}

export function getPipeline(id: string): Pipeline | null {
  const row = getDb().prepare(`SELECT * FROM pipelines WHERE id = ?`).get(id) as
    | PipelineRow
    | undefined;
  return row ? hydrate(row) : null;
}

export function savePipeline(input: {
  id?: string;
  name: string;
  description?: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}): Pipeline {
  const name = input.name?.trim();
  if (!name) throw new Error("A pipeline needs a name.");
  const valid = validatePipeline(input.nodes, input.edges);
  if (!valid.ok) throw new Error(valid.reason);

  const db = getDb();
  const graph = JSON.stringify({ nodes: input.nodes, edges: input.edges });
  if (input.id) {
    const existing = getPipeline(input.id);
    if (!existing) throw new Error(`No pipeline with id ${input.id}.`);
    db.prepare(`UPDATE pipelines SET name = ?, description = ?, graph = ? WHERE id = ?`).run(
      name,
      input.description?.trim() ?? existing.description,
      graph,
      input.id,
    );
    return getPipeline(input.id)!;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO pipelines (id, name, description, graph, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, input.description?.trim() ?? "", graph, Date.now());
  return getPipeline(id)!;
}

export function deletePipeline(id: string): void {
  getDb().prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
  getDb().prepare(`DELETE FROM pipeline_runs WHERE pipeline_id = ?`).run(id);
}

/* --------------------------------------------------------------- examples */

export interface PipelineExample {
  name: string;
  prompt: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

function userExamplesDir(): string {
  return join(config.dataDir, "pipelines", "examples");
}

/** Shipped first, then the user's -- iterated in that order into a Map so a
 *  user example shadows a shipped one by name, the skills rule again. These
 *  feed the composer as few-shot guidance: patterns it adapts to the request
 *  at hand, never scripts it replays. */
export function loadPipelineExamples(): PipelineExample[] {
  const byName = new Map<string, PipelineExample>();
  for (const dir of [join(projectRoot, "examples", "pipelines"), userExamplesDir()]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as PipelineExample;
        if (parsed.name && parsed.prompt && Array.isArray(parsed.nodes)) {
          byName.set(parsed.name, parsed);
        }
      } catch {
        // One malformed example must not take the library down.
      }
    }
  }
  return [...byName.values()];
}

export function saveExample(example: PipelineExample): void {
  const slug = example.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("The example needs a name.");
  mkdirSync(userExamplesDir(), { recursive: true });
  writeFileSync(join(userExamplesDir(), `${slug}.json`), JSON.stringify(example, null, 2) + "\n");
}

/** Crude stemming, the lexical-fallback lesson: people rephrase, so
 *  "summarise"/"summarize"/"summary" must collapse or matching finds nothing. */
function stems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
      .map((w) => w.replace(/(ise|ize|ing|ed|es|s)$/, "")),
  );
}

export function nearestExamples(prompt: string, k = 3): PipelineExample[] {
  const want = stems(prompt);
  return loadPipelineExamples()
    .map((example) => {
      const have = stems(example.prompt);
      let overlap = 0;
      for (const w of want) if (have.has(w)) overlap++;
      return { example, overlap };
    })
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, k)
    .map((x) => x.example);
}

/* --------------------------------------------------------------- composer */

export interface ComposeResult {
  ok: boolean;
  nodes?: PipelineNode[];
  edges?: PipelineEdge[];
  reason?: string;
}

/**
 * Prompt -> draft graph, as classification. The menu is the closed list of
 * *available* ability ids; examples are few-shot guidance; the zod enum makes
 * an invented ability a refusal rather than a coercion. The result renders on
 * the canvas for the user to edit -- a bad compose costs a glance.
 */
export async function composePipeline(
  prompt: string,
  registry: Registry,
  servers: string[],
): Promise<ComposeResult> {
  const want = prompt.trim();
  if (!want) return { ok: false, reason: "Say what the pipeline should do." };

  const ids = composableAbilityIds(registry, servers);
  if (ids.length === 0) return { ok: false, reason: "No abilities are configured yet." };

  const menu = ABILITIES.filter((a) => ids.includes(a.id))
    .map((a) => `- ${a.id}: ${a.description}`)
    .join("\n");
  const fewShot = nearestExamples(want)
    .map(
      (e) =>
        `Request: ${e.prompt}\n` +
        JSON.stringify({
          nodes: e.nodes.map((n) => ({ id: n.id, ability: n.abilityId, prompt: n.prompt })),
          edges: e.edges,
        }),
    )
    .join("\n\n");

  const messages: Message[] = [
    {
      role: "system",
      content:
        `Break the user's request into steps, each using exactly one ability.\n\n` +
        `Abilities:\n${menu}\n\n` +
        `Reply with ONLY this JSON, nothing else:\n` +
        `{"nodes": [{"id": "n1", "ability": "<ability id>", "prompt": "what this step should do"}], ` +
        `"edges": [{"from": "n1", "to": "n2"}]}\n\n` +
        `Rules:\n` +
        `- Use as few steps as the request needs; one is fine.\n` +
        `- An edge means the later step uses what the earlier one produced.\n` +
        `- Each step's prompt is guidance in plain words, not code.\n\n` +
        (fewShot ? `Examples:\n${fewShot}` : ""),
    },
    { role: "user", content: want.slice(0, 500) },
  ];

  const schema = z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().min(1),
          ability: z.enum(ids as [string, ...string[]]),
          prompt: z.string().min(1),
        }),
      )
      .min(1)
      .max(8),
    edges: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  });

  try {
    const result = await complete(messages, [], {}, undefined, { temperature: 0 });
    const match = /\{[\s\S]*\}/.exec(result.content);
    if (!match) return { ok: false, reason: "The composer returned nothing usable." };
    const parsed = schema.safeParse(JSON.parse(repairJson(match[0])));
    if (!parsed.success) {
      return { ok: false, reason: "The composer named an ability that does not exist." };
    }

    const nodes: PipelineNode[] = parsed.data.nodes.map((n) => ({
      id: n.id,
      abilityId: n.ability,
      prompt: n.prompt,
    }));
    // Invalid edges are dropped rather than failing the compose: a partially
    // wired graph on an editable canvas is still useful, where a refusal is
    // a blank one.
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = parsed.data.edges.filter((e) => {
      if (!nodeIds.has(e.from) || !nodeIds.has(e.to) || e.from === e.to) return false;
      const from = getAbility(nodes.find((n) => n.id === e.from)!.abilityId)!;
      const to = getAbility(nodes.find((n) => n.id === e.to)!.abilityId)!;
      return from.outputs.some((p) => to.inputs.includes(p));
    });
    const valid = validatePipeline(nodes, edges);
    if (!valid.ok) return { ok: false, reason: valid.reason };
    return { ok: true, nodes, edges };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/* -------------------------------------------------------------- artifacts */

/**
 * Recover artifacts from what tools actually said -- the sources.ts pattern.
 * Artifact locations exist nowhere else today; these regexes are pinned by
 * verbatim-string tests so a reworded tool message fails loudly here instead
 * of silently dropping a pipeline's hand-off.
 */
export function extractArtifacts(tool: string, output: string): Artifact[] {
  const artifacts: Artifact[] = [];
  if (tool === "write_file") {
    const m = /^Wrote \d+ bytes to (.+)$/m.exec(output);
    if (m) artifacts.push({ type: "document", path: m[1]!.trim() });
  } else if (tool === "take_screenshot") {
    const m = /Screenshot saved to (.+?\.png)/.exec(output);
    if (m) artifacts.push({ type: "image", path: m[1]!.trim() });
  } else if (tool === "send_email") {
    const m = /^Saved to (.+?\.eml)$/m.exec(output);
    if (m) artifacts.push({ type: "email_draft", path: m[1]!.trim() });
  } else if (tool === "propose_plan") {
    if (/^Proposed, not run\./.test(output)) artifacts.push({ type: "plan" });
  }
  return artifacts;
}

/** Paths the fs tools can re-resolve: workspace-absolute becomes relative;
 *  anything already relative is passed through untouched. */
function addressablePath(path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(config.workspace, path);
  return rel.startsWith("..") ? path : rel;
}

/* --------------------------------------------------------------- executor */

const running = new Set<string>();

export function pipelineIsRunning(id: string): boolean {
  return running.has(id);
}

export async function runPipeline(
  pipeline: Pipeline,
  registry: Registry,
  emit: (event: RunEvent) => void,
): Promise<{ runId: string; status: "succeeded" | "failed" }> {
  const valid = validatePipeline(pipeline.nodes, pipeline.edges);
  if (!valid.ok) throw new Error(valid.reason);
  if (running.has(pipeline.id)) throw new Error("This pipeline is already running.");
  running.add(pipeline.id);

  const runId = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO pipeline_runs (id, pipeline_id, started_at, status) VALUES (?, ?, ?, 'running')`,
  ).run(runId, pipeline.id, Date.now());

  // One session for the whole run: every node's turn lands in the ordinary
  // trace tables, so a pipeline is inspectable exactly like a conversation.
  const sessionId = startSession();
  setMemorySession(sessionId);
  setPlanSession(sessionId);
  setBrowseSession(sessionId);

  const results = new Map<string, NodeResult>();
  const skills = loadSkills().skills;

  try {
    for (const nodeId of valid.order) {
      const node = pipeline.nodes.find((n) => n.id === nodeId)!;
      const ability = getAbility(node.abilityId)!;

      // A failed upstream poisons everything downstream of it -- running a
      // step whose inputs never arrived would produce exactly the ungrounded
      // generation pipelines exist to avoid.
      const upstream = pipeline.edges.filter((e) => e.to === nodeId).map((e) => e.from);
      if (upstream.some((id) => results.get(id)?.status !== "finished")) {
        results.set(nodeId, {
          nodeId,
          status: "skipped",
          reply: "",
          artifacts: [],
          error: "an earlier step failed",
        });
        emit({ type: "node_skipped", nodeId });
        continue;
      }

      emit({ type: "node_started", nodeId });

      // Assemble the node's input: its own guidance plus what flowed in.
      // Text is clipped per artifact against the *current* model's budget --
      // never a constant, the model is switchable at runtime.
      const clip = contextBudget();
      const incomingText: string[] = [];
      const incomingFiles: string[] = [];
      for (const id of upstream) {
        for (const artifact of results.get(id)!.artifacts) {
          if (artifact.type === "text" && artifact.text) {
            incomingText.push(artifact.text.slice(0, clip));
          } else if (FILE_KINDS.includes(artifact.type) && artifact.path) {
            incomingFiles.push(addressablePath(artifact.path));
          }
        }
      }
      const input =
        node.prompt +
        (incomingText.length > 0
          ? `\n\nResults from the previous steps:\n\n${incomingText.join("\n\n---\n\n")}`
          : "");

      const artifacts: Artifact[] = [];
      const skill = abilitySkill(ability);
      try {
        const result = await runTurn(
          input,
          [],
          registry,
          sessionId,
          {
            onContent: (delta) => emit({ type: "node_content", nodeId, content: delta }),
            onToolStart: (name) => emit({ type: "node_tool", nodeId, tool: name }),
            onToolEnd: (name, output) => artifacts.push(...extractArtifacts(name, output)),
          },
          {
            specialist: ability.specialist,
            skills: skill ? skills.filter((s) => s.name === skill) : [],
            files: incomingFiles.slice(0, 5),
          },
        );
        artifacts.push({ type: "text", text: result.reply });
        results.set(nodeId, { nodeId, status: "finished", reply: result.reply, artifacts });
        emit({ type: "node_finished", nodeId, artifacts, reply: result.reply });
      } catch (err) {
        results.set(nodeId, {
          nodeId,
          status: "failed",
          reply: "",
          artifacts: [],
          error: (err as Error).message,
        });
        emit({ type: "node_failed", nodeId, error: (err as Error).message });
      }
    }
  } finally {
    running.delete(pipeline.id);
  }

  const failed = [...results.values()].some((r) => r.status !== "finished");
  const status = failed ? ("failed" as const) : ("succeeded" as const);
  db.prepare(
    `UPDATE pipeline_runs SET finished_at = ?, status = ?, node_results = ? WHERE id = ?`,
  ).run(Date.now(), status, JSON.stringify([...results.values()]), runId);
  db.prepare(`UPDATE pipelines SET last_run_at = ? WHERE id = ?`).run(Date.now(), pipeline.id);

  emit({ type: "run_finished", status, runId });
  return { runId, status };
}
