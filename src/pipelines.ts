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
import { loadSkills, skillsDir } from "./skills.js";
import { setMemorySession } from "./tools/memory.js";
import { setBrowseSession } from "./tools/browse.js";
import { setConversationSession } from "./conversation-attachments.js";
import { setPlanSession } from "./tools/desktop.js";
import type { Registry } from "./tools/index.js";
import type { Message, ToolDef } from "./types.js";
export { extractArtifacts, type Artifact } from "./artifacts.js";
import { extractArtifacts, type Artifact } from "./artifacts.js";

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


export interface NodeResult {
  nodeId: string;
  status: "finished" | "failed" | "skipped";
  reply: string;
  artifacts: Artifact[];
  error?: string;
}

export type RunEvent =
  // First out of the gate: tells the client which id to stop and which run
  // to adopt if this was a draft the user saves afterwards.
  | { type: "run_started"; runId: string; pipelineId: string }
  | { type: "node_started"; nodeId: string }
  | { type: "node_content"; nodeId: string; content: string }
  | { type: "node_tool"; nodeId: string; tool: string }
  | { type: "node_finished"; nodeId: string; artifacts: Artifact[]; reply: string }
  | { type: "node_failed"; nodeId: string; error: string }
  | { type: "node_skipped"; nodeId: string }
  | { type: "run_finished"; status: "succeeded" | "failed" | "cancelled"; runId: string };

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
    // Renaming onto another pipeline's name would leave two rows answering
    // to one name, and every by-name consumer resolves first-match.
    const collision = listPipelines().find((p) => p.name === name && p.id !== input.id);
    if (collision) throw new Error(`A pipeline named "${name}" already exists.`);
    // tasks.pipeline stores the NAME, so a rename must cascade or every
    // schedule pointing here rots silently until 3am. CLI-authored tasks
    // cascade too -- they reference by the same name. The SQL lives here
    // rather than in tasks.ts because tasks.ts already imports this module.
    db.transaction(() => {
      db.prepare(`UPDATE pipelines SET name = ?, description = ?, graph = ? WHERE id = ?`).run(
        name,
        input.description?.trim() ?? existing.description,
        graph,
        input.id,
      );
      if (existing.name !== name) {
        db.prepare(`UPDATE tasks SET pipeline = ? WHERE pipeline = ?`).run(name, existing.name);
      }
    })();
    return getPipeline(input.id)!;
  }
  // No id but a name that already exists: the user means THAT pipeline.
  // Blind inserts multiplied rows on every re-save, and every by-name
  // consumer (run_pipeline, scheduled tasks) resolves first-match, so
  // duplicates make "run X" ambiguous. Same name, same pipeline -- the
  // shadowing rule skills and examples already follow.
  const sameName = listPipelines().find((p) => p.name === name);
  if (sameName) return savePipeline({ ...input, id: sameName.id });

  const id = randomUUID();
  db.prepare(
    `INSERT INTO pipelines (id, name, description, graph, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, input.description?.trim() ?? "", graph, Date.now());
  return getPipeline(id)!;
}

/**
 * Re-parents a draft run onto a just-saved pipeline, so "run it, see it
 * work, then save it" produces a pipeline that is already vouched -- the
 * green run the user watched IS the proof, and demanding a second identical
 * run to earn trust would be ritual. Only orphan runs can be adopted: a run
 * already belonging to a saved pipeline is history, not a transferable
 * credential.
 */
export function adoptRun(runId: string, pipelineId: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE pipeline_runs SET pipeline_id = ?
         WHERE id = ? AND pipeline_id NOT IN (SELECT id FROM pipelines)`,
      )
      .run(pipelineId, runId).changes > 0
  );
}

export interface PipelineRunRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  nodeResults: NodeResult[];
}

/**
 * The execution log: what each step actually replied and produced, straight
 * from the run row the executor wrote. Without this a run's only trace was
 * the status rings — "it worked" with no way to read WHAT worked.
 */
export function listRuns(pipelineId: string, limit = 10): PipelineRunRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT id, started_at AS startedAt, finished_at AS finishedAt, status, node_results
       FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(pipelineId, limit) as Array<Record<string, unknown> & { node_results: string }>;
  return rows.map((r) => {
    let nodeResults: NodeResult[] = [];
    try {
      nodeResults = JSON.parse(r.node_results);
    } catch {
      // A malformed row loses its detail, never the listing.
    }
    return {
      id: r.id as string,
      startedAt: r.startedAt as number,
      finishedAt: (r.finishedAt as number) ?? null,
      status: r.status as string,
      nodeResults,
    };
  });
}

/**
 * Exports a vouched pipeline as a skill: the discoverability layer.
 *
 * The skill catalogue rides every prompt, so after this a natural-language
 * ask ("give me my news brief") finds the flow without the user naming it --
 * the skill's body triggers run_pipeline with the exact saved name, and
 * carries the step outline as context. Vouching is the same rule as
 * run_pipeline itself: only a pipeline reality has tested may teach agents
 * to reach for it. Never overwrites: a skill is the user's document once it
 * exists, and an export must not silently replace their edits.
 */
export function exportPipelineSkill(pipelineId: string): { name: string; dir: string } {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) throw new Error(`No pipeline with id ${pipelineId}.`);
  if (!hasSuccessfulRun(pipelineId)) {
    throw new Error("Run it successfully once first — a skill points agents at a flow that works.");
  }

  const slug = pipeline.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new Error(`"${pipeline.name}" does not reduce to a usable skill name.`);
  }

  const dir = join(skillsDir(), slug);
  if (existsSync(dir)) {
    throw new Error(`A skill named "${slug}" already exists — it will not be overwritten.`);
  }

  const valid = validatePipeline(pipeline.nodes, pipeline.edges);
  const order = valid.ok ? valid.order : pipeline.nodes.map((n) => n.id);
  const steps = order
    .map((id, i) => {
      const node = pipeline.nodes.find((n) => n.id === id)!;
      const title = getAbility(node.abilityId)?.title ?? node.abilityId;
      const firstLine = node.prompt.split("\n")[0]!.slice(0, 100);
      return `${i + 1}. ${title}${firstLine ? ` — ${firstLine}` : ""}`;
    })
    .join("\n");

  const purpose = pipeline.description || pipeline.name;
  const body = `---
name: ${slug}
description: >-
  Runs the saved pipeline "${pipeline.name}". Use when the user wants
  ${purpose.replace(/\s+/g, " ").slice(0, 160)}.
---

# ${slug}

Call the \`run_pipeline\` tool with \`name: "${pipeline.name}"\` — the exact
name, verbatim. The pipeline runs each step itself; do not perform the steps
by hand.

## What it does

${steps}

## Rules

- Every step runs under its own approval gates (email stays dry-run, desktop
  actions still propose plans), so triggering this is safe to do directly.
- If run_pipeline answers that no pipeline has that name, it was renamed or
  deleted. Tell the user and stop — its refusal lists what IS available.
`;

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  return { name: slug, dir };
}

export function deletePipeline(id: string): void {
  const db = getDb();
  // Read the row before deleting: tasks reference the pipeline by NAME, and
  // a schedule is meaningless without its flow, so linked tasks go with it
  // (their task_runs follow via FK cascade).
  const existing = getPipeline(id);
  db.transaction(() => {
    db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM pipeline_runs WHERE pipeline_id = ?`).run(id);
    if (existing) db.prepare(`DELETE FROM tasks WHERE pipeline = ?`).run(existing.name);
  })();
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

/** Whether this pipeline has ever finished a run with every step green.
 *  The vouching rule for everything a pipeline is trusted with beyond its
 *  own canvas: teaching the composer, being runnable by an agent. Same
 *  reasoning as recipe promotion -- a graph that never worked would be
 *  imitated verbatim forever. */
export function hasSuccessfulRun(pipelineId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM pipeline_runs WHERE pipeline_id = ? AND status = 'succeeded' LIMIT 1`)
    .get(pipelineId);
  return row !== undefined;
}

/**
 * The composer's few-shot library. Shipped examples are the quality floor;
 * on top of them, **the user's own saved pipelines teach the composer --
 * but only after a successful run**. There is no user-facing "example"
 * concept: saving a flow and having it work is what makes Enio better at
 * composing the next one, with nothing to manage. Iterated shipped → user
 * files → saved pipelines into a Map, so later shadows earlier by name (the
 * skills rule). Examples are guidance the composer adapts, never scripts it
 * replays.
 */
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
  for (const pipeline of listPipelines()) {
    if (!hasSuccessfulRun(pipeline.id)) continue;
    byName.set(pipeline.name, {
      name: pipeline.name,
      // The compose prompt rides in description; a hand-built pipeline falls
      // back to its name, which stems well enough ("ai-news-brief").
      prompt: pipeline.description || pipeline.name,
      nodes: pipeline.nodes,
      edges: pipeline.edges,
    });
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

/** Paths the fs tools can re-resolve: workspace-absolute becomes relative;
 *  anything already relative is passed through untouched. */
function addressablePath(path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(config.workspace, path);
  return rel.startsWith("..") ? path : rel;
}

/* --------------------------------------------------------------- executor */

const running = new Set<string>();
const stopRequested = new Set<string>();

export function pipelineIsRunning(id: string): boolean {
  return running.has(id);
}

/**
 * Asks a running pipeline to stop; returns false when nothing is running.
 * The stop lands at the next safe boundary: the in-flight node's model
 * stream is aborted and the node fails with "Stopped by the user.", every
 * node after it is skipped, and the run is recorded as cancelled -- which,
 * like failed, never vouches the pipeline.
 */
export function stopPipeline(id: string): boolean {
  if (!running.has(id)) return false;
  stopRequested.add(id);
  return true;
}

/** True while any pipeline run is executing nodes. The run_pipeline tool
 *  refuses while set: a pipeline step starting another pipeline is the
 *  compounding hand-off the one-hop invariant exists to prevent, wearing a
 *  different hat. */
let inPipelineRun = false;

/**
 * The MCP servers an ability's node turns may use: the ability's declared
 * requiredServer, prefix-matched against what is actually connected -- the
 * same rule abilityAvailability applies. An ability without a declaration
 * inherits nothing, so an ordinary node's tool set is exactly its
 * specialist's.
 */
function abilityServers(ability: { requiredServer?: string }, registry: Registry): string[] {
  if (!ability.requiredServer) return [];
  const prefix = ability.requiredServer.toLowerCase();
  return [
    ...new Set(
      registry.all
        .map((t) => t.server)
        .filter((s): s is string => !!s && s.toLowerCase().startsWith(prefix)),
    ),
  ];
}

export async function runPipeline(
  pipeline: Pipeline,
  registry: Registry,
  emit: (event: RunEvent) => void,
): Promise<{ runId: string; status: "succeeded" | "failed" | "cancelled" }> {
  const valid = validatePipeline(pipeline.nodes, pipeline.edges);
  if (!valid.ok) throw new Error(valid.reason);
  if (running.has(pipeline.id)) throw new Error("This pipeline is already running.");
  running.add(pipeline.id);
  inPipelineRun = true;

  const runId = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO pipeline_runs (id, pipeline_id, started_at, status) VALUES (?, ?, ?, 'running')`,
  ).run(runId, pipeline.id, Date.now());
  emit({ type: "run_started", runId, pipelineId: pipeline.id });

  // One session for the whole run: every node's turn lands in the ordinary
  // trace tables, so a pipeline is inspectable exactly like a conversation.
  const sessionId = startSession();
  setMemorySession(sessionId);
  setPlanSession(sessionId);
  setBrowseSession(sessionId);
  setConversationSession(sessionId);

  const results = new Map<string, NodeResult>();
  const skills = loadSkills().skills;
  let wasStopped = false;

  try {
    for (const nodeId of valid.order) {
      const node = pipeline.nodes.find((n) => n.id === nodeId)!;
      const ability = getAbility(node.abilityId)!;

      // A requested stop skips everything from here on; the results map keeps
      // what already finished, so a stopped run is honest about how far it got.
      if (stopRequested.has(pipeline.id)) {
        results.set(nodeId, {
          nodeId,
          status: "skipped",
          reply: "",
          artifacts: [],
          error: "stopped by the user",
        });
        emit({ type: "node_skipped", nodeId });
        continue;
      }

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
            // Lets a stop land inside the node: the turn aborts its stream
            // and throws, the node fails, everything downstream skips.
            shouldStop: () => stopRequested.has(pipeline.id),
          },
          {
            specialist: ability.specialist,
            skills: skill ? skills.filter((s) => s.name === skill) : [],
            files: incomingFiles.slice(0, 5),
            // The ability's declared server need, resolved against what is
            // actually connected. Abilities declare, nodes inherit -- a
            // per-node server field would be the model (or a draft) widening
            // its own reach; this stays a closed list.
            servers: abilityServers(ability, registry),
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
    wasStopped = stopRequested.has(pipeline.id);
    running.delete(pipeline.id);
    stopRequested.delete(pipeline.id);
    inPipelineRun = false;
  }

  const failed = [...results.values()].some((r) => r.status !== "finished");
  const status = wasStopped
    ? ("cancelled" as const)
    : failed
      ? ("failed" as const)
      : ("succeeded" as const);
  db.prepare(
    `UPDATE pipeline_runs SET finished_at = ?, status = ?, node_results = ? WHERE id = ?`,
  ).run(Date.now(), status, JSON.stringify([...results.values()]), runId);
  db.prepare(`UPDATE pipelines SET last_run_at = ? WHERE id = ?`).run(Date.now(), pipeline.id);

  emit({ type: "run_finished", status, runId });
  return { runId, status };
}

/* ------------------------------------------------------------------ tool */

/**
 * run_pipeline: an agent runs one of the user's saved pipelines by NAME.
 *
 * Selection, never authoring -- the recipes rule. The eligible list is
 * pipelines that have already run successfully (the same vouching that
 * makes one teach the composer), so what the model can trigger is only a
 * graph the user built and reality has tested. Each node still runs as an
 * ordinary turn, which means every gate holds: this tool grants
 * orchestration convenience, not one new capability.
 *
 * A function, not a const (the buildDesktopTools lesson): the eligible set
 * changes as pipelines are saved and run, and descriptions are static, so
 * eligibility is checked inside run().
 */
export function buildPipelineTools(registry: () => Registry): ToolDef[] {
  return [
    {
      name: "run_pipeline",
      description:
        "Run one of the user's saved automations by name. Use when the user asks to run an automation, pipeline or flow they created. Only automations that have run successfully before are eligible.",
      origin: "builtin",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The saved automation's exact name." },
        },
        required: ["name"],
      },
      async run(args: Record<string, unknown>) {
        const wanted = String(args.name ?? "").trim().toLowerCase();
        if (!wanted) return "Error: no pipeline name given.";
        if (inPipelineRun) {
          return "Refused: a pipeline step cannot start another pipeline.";
        }

        const eligible = listPipelines().filter((p) => hasSuccessfulRun(p.id));
        const pipeline = eligible.find((p) => p.name.toLowerCase() === wanted);
        if (!pipeline) {
          const names = eligible.map((p) => p.name).join(", ") || "none yet";
          return (
            `No pipeline named "${args.name}" is eligible. Pipelines that can be run: ${names}. ` +
            `(A pipeline becomes eligible after the user runs it successfully once.)`
          );
        }
        if (pipelineIsRunning(pipeline.id)) {
          return `"${pipeline.name}" is already running.`;
        }

        const lines: string[] = [];
        const outcome = await runPipeline(pipeline, registry(), (event) => {
          if (event.type === "node_finished") {
            const paths = event.artifacts
              .filter((a) => a.path)
              .map((a) => a.path)
              .join(", ");
            lines.push(
              `- step ${event.nodeId}: done${paths ? ` (${paths})` : ""} — ${event.reply.slice(0, 200).replace(/\s+/g, " ")}`,
            );
          } else if (event.type === "node_failed") {
            lines.push(`- step ${event.nodeId}: FAILED — ${event.error}`);
          } else if (event.type === "node_skipped") {
            lines.push(`- step ${event.nodeId}: skipped`);
          }
        });
        return (
          `Pipeline "${pipeline.name}" ${outcome.status === "succeeded" ? "finished" : "failed"}.\n` +
          lines.join("\n")
        );
      },
    },
  ];
}

/* --------------------------------------------------------- suggest drafts */

/**
 * The closed tool→ability map. Suggested drafts are assembled from what
 * actually ran, but the assembly itself is a lookup, never a judgement --
 * a tool with no entry drops out rather than guessing a home. The default
 * prompt is a placeholder the user rewrites on the canvas; a draft is a
 * starting point, not a finished flow.
 */
const TOOL_TO_ABILITY: Record<string, { ability: string; prompt: string }> = {
  web_search: { ability: "web-search", prompt: "search the web for it" },
  web_fetch: { ability: "web-search", prompt: "search the web for it" },
  browse: { ability: "web-search", prompt: "search the web for it" },
  search_code: { ability: "file-search", prompt: "find the relevant files" },
  read_file: { ability: "file-search", prompt: "find the relevant files" },
  list_dir: { ability: "file-search", prompt: "find the relevant files" },
  write_file: { ability: "create-document", prompt: "write it up as a document" },
  edit_file: { ability: "develop-app", prompt: "make the change" },
  run_command: { ability: "develop-app", prompt: "run the build or script" },
  search_email: { ability: "read-email", prompt: "find the relevant email" },
  read_email: { ability: "read-email", prompt: "find the relevant email" },
  send_email: { ability: "send-email", prompt: "draft the email" },
  take_screenshot: { ability: "screenshot", prompt: "capture the screen" },
  propose_plan: { ability: "control-mac", prompt: "propose the desktop steps" },
  mac_recipe: { ability: "control-mac", prompt: "propose the desktop steps" },
  open_app: { ability: "control-mac", prompt: "propose the desktop steps" },
  remember: { ability: "remember", prompt: "remember the outcome" },
};

export interface PipelineDraft {
  title: string;
  reason: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

/**
 * One repeated tool sequence → one linear draft, or null when the mapping
 * cannot make an honest one: fewer than two mapped steps is not a chain, and
 * a chain the validator rejects (port mismatch) would open broken on the
 * canvas. Consecutive duplicates collapse because read_file three times is
 * one file-search step, not three.
 */
export function draftFromToolSequence(
  title: string,
  reason: string,
  tools: string[],
  seedPrompt?: string,
): PipelineDraft | null {
  const abilities: { ability: string; prompt: string }[] = [];
  for (const tool of tools) {
    const mapped = TOOL_TO_ABILITY[tool];
    if (!mapped) continue;
    if (abilities.at(-1)?.ability === mapped.ability) continue;
    abilities.push(mapped);
  }
  if (abilities.length < 2) return null;

  const nodes: PipelineNode[] = abilities.map((a, i) => ({
    id: `n${i + 1}`,
    abilityId: a.ability,
    // The first step carries what the user actually asked those times; the
    // rest are placeholders to rewrite.
    prompt: i === 0 && seedPrompt ? seedPrompt : a.prompt,
    position: { x: 80 + i * 260, y: 120 },
  }));
  const edges: PipelineEdge[] = nodes
    .slice(1)
    .map((n, i) => ({ from: nodes[i]!.id, to: n.id }));

  if (!validatePipeline(nodes, edges).ok) return null;
  return { title, reason, nodes, edges };
}

/**
 * Mines the trace history for repeated tool sequences and returns them as
 * unsaved drafts. On demand only -- analyse() embeds up to 2000 questions,
 * which is seconds of work the user should choose to spend, never a
 * background loop. The user names and saves a draft, and only a successful
 * run afterwards makes it teach the composer or become runnable by agents:
 * suggestion is the least trusted rung of the same ladder.
 */
export async function suggestPipelines(): Promise<PipelineDraft[]> {
  const { analyse } = await import("./suggest.js");
  const { proposals } = await analyse();
  const drafts: PipelineDraft[] = [];
  for (const p of proposals) {
    if (!p.tools || p.tools.length < 2) continue;
    const draft = draftFromToolSequence(
      p.title.replace(/^Repeated sequence: /, "").trim(),
      p.reason,
      p.tools,
      p.evidence[0],
    );
    if (draft) drafts.push(draft);
  }
  return drafts;
}
