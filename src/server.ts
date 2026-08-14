import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { readBody, sendJson } from "./http-util.js";
import { FEATURE_ROUTES } from "./routes/index.js";
import { runTurn } from "./agent.js";
import { claimModelServer } from "./runtime.js";
import { buildRegistry, type Registry } from "./tools/index.js";
import { setMemorySession } from "./tools/memory.js";
import { setBrowseSession } from "./tools/browse.js";
import {
  builtinRecipes,
  desktopEnabled,
  recipesEnabled,
  setPlanSession,
} from "./tools/desktop.js";
import { probeAssistiveAccess } from "./tools/ax.js";
import { availableModels, currentModelId } from "./model-settings.js";
import {
  ATTACH_DIR,
  FileRefused,
  listStorage,
  removeConversationFiles,
  removeFile,
} from "./files.js";
import { CATALOGUE, fitFor, machineChip, machineMemory, recommendUpgrade, speedFor } from "./model-catalogue.js";
import {
  DownloadRefused,
  cancelDownload,
  downloadState,
  startDownload,
} from "./model-download.js";
import { switchModel } from "./runtime.js";
import { autoRunEnabled, setAutoRun, setDesktopControl } from "./automation.js";
import { revisePlan } from "./revise.js";
import {
  approvePlan,
  forgetRecipe,
  getPlan,
  listPendingPlans,
  listSavedRecipes,
  normalizeRecipeName,
  planSteps,
  PLAN_KINDS,
  replacePlanSteps,
  runAppleScript,
  runScript,
  type PlanKind,
  saveRecipe,
  settlePlan,
} from "./plans.js";

/** Built-in names, so a saved recipe cannot shadow one. */
const BUILTIN_NAMES: Record<string, true> = Object.fromEntries(
  builtinRecipes().map((r) => [r.name, true as const]),
);
import {
  conversationKnowledge,
  conversationMessages,
  discardConversation,
  listConversations,
  startSession,
} from "./memory/store.js";
import { ABILITIES, abilityAvailability } from "./abilities.js";
import {
  adoptRun,
  composePipeline,
  exportPipelineSkill,
  extractArtifacts,
  hasSuccessfulRun,
  deletePipeline,
  getPipeline,
  listPipelines,
  listRuns,
  pipelineIsRunning,
  runPipeline,
  savePipeline,
  stopPipeline,
  suggestPipelines,
  type PipelineEdge,
  type PipelineNode,
} from "./pipelines.js";
import { addServer, readMcpConfig, removeServer, setServerDisabled } from "./mcp-config.js";
import { scanLibrary } from "./library.js";
import { startScheduler } from "./tasks.js";
import { mcpStatus } from "./tools/mcp.js";
import {
  attachToConversation,
  detachFromConversation,
  listConversationAttachments,
  setConversationSession,
} from "./conversation-attachments.js";
import { ensureToken, isAuthorized } from "./auth.js";
import {
  activeProject,
  attachPath,
  closeProject,
  createProject,
  deleteProject,
  detachPath,
  findProject,
  lastOpenedProjectId,
  listProjects,
  openProject,
  updateProject,
  type Project,
} from "./project.js";
import { buildIndexInBackground } from "./project-index.js";
import { latestSessionForProject } from "./memory/store.js";
import { embeddingsDegraded } from "./memory/embed.js";
import { mentionContext, parseMentions } from "./mentions.js";
import { SPECIALISTS } from "./specialists.js";
import { extractSources } from "./sources.js";
import { loadSkills } from "./skills.js";
import { synthesize, transcribeWav, warmVoice, whisperInstalled } from "./voice.js";
import type { Message } from "./types.js";

/**
 * An OpenAI-compatible endpoint that wraps the *agent*, not the raw model.
 *
 * The distinction matters: mlx_lm.server on :8080 already speaks this protocol,
 * but it has no tools and no memory. This sits in front of it on :8787 so
 * anything that can point at an OpenAI base URL — Open WebUI, a script, an
 * editor extension — gets the full agent, tool execution and recall included,
 * without knowing anything about how it works.
 */

export async function serve(): Promise<void> {
  process.title = "Enio Agent";

  // The agent endpoint is a long-lived user of the model server, so it counts
  // toward keeping it alive -- and shuts it down if it is the last one out.
  claimModelServer();

  // A ref rather than a const: enabling desktop control at runtime changes
  // which tools exist, and the registry is otherwise built once. Each request
  // dereferences, so a rebuild takes effect on the next request with no
  // restart.
  const registryRef = { current: await buildRegistry((m) => console.log(m)) };
  const rebuildRegistry = async () => {
    registryRef.current = await buildRegistry((m) => console.log(m));
    return registryRef.current.all.length;
  };
  const sessionId = startSession();
  setMemorySession(sessionId);
  setPlanSession(sessionId);
  setBrowseSession(sessionId);
  setConversationSession(sessionId);
  const token = ensureToken();

  // The document library keeps itself fresh on search (throttled), so this
  // timer is not correctness -- it embeds new drops ahead of the first query
  // instead of making that query pay the extraction. It stays off the tasks
  // scheduler because the library should not depend on holding the lease.
  void scanLibrary().catch(() => {});
  setInterval(() => void scanLibrary().catch(() => {}), 5 * 60_000).unref();

  // The desktop is the usual scheduler host: a schedule set in the UI must
  // fire while the app is open, without asking anyone to also run a daemon.
  // The lease inside startScheduler keeps this safe when `enio daemon` runs
  // too -- one of them holds, the other stands by.
  const scheduler = startScheduler((m) => console.log(m));
  // stop() releases the lease so a standby daemon takes over within a tick
  // instead of waiting out staleness. The signal handlers route Ctrl-C
  // through "exit" -- without them a default-handled SIGINT skips the exit
  // event entirely (claimModelServer installs them too, but only for Maple).
  process.on("exit", () => scheduler.stop());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => process.exit(0));
  }

  const server = createServer((req, res) => {
    handle(req, res, registryRef.current, sessionId, token, rebuildRegistry).catch((err) => {
      sendJson(res, 500, { error: { message: (err as Error).message } });
    });
  });

  server.listen(config.agentPort, config.agentHost, () => {
    const shown = config.agentHost === "0.0.0.0" ? "<this-machine>" : config.agentHost;
    console.log(`\nenio listening on http://${shown}:${config.agentPort}/v1`);
    console.log(`  ${registryRef.current.all.length} tools · upstream ${config.modelBaseUrl}`);
    console.log(`\n  API key: ${token}`);
    console.log(`  ${DIM}paste that into any OpenAI-compatible client's API key field${RESET}`);

    if (config.agentHost !== "127.0.0.1" && config.agentHost !== "localhost") {
      console.log(
        `\n  ${YELLOW}Bound to ${config.agentHost}, so this is reachable from your network.${RESET}` +
          `\n  ${YELLOW}This agent can run shell commands. Keep the key secret, and prefer${RESET}` +
          `\n  ${YELLOW}a tunnel (see docs/remote-access.md) over exposing the port directly.${RESET}`,
      );
    }
    console.log("");
  });
}

const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** The chip's view: enough to display and to filter conversations by. */
function projectSummary(project: Project | null) {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    // The absolute path rides along so the desktop's file picker can tell
    // "this file is already in the project" from "this file needs copying
    // in" -- a file inside an attached folder is referenced by its alias,
    // never duplicated into the workspace.
    attachments: project.attachments.map((a) => ({
      alias: a.alias,
      kind: a.kind,
      note: a.note,
      path: a.path,
    })),
    // What "open this project" should resume, so the client needs no second
    // round-trip to decide.
    latestConversation: latestSessionForProject(project.id),
  };
}

/** The editor's view: everything project.json holds, paths included. */
function projectDetail(project: Project) {
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    description: project.description,
    instructions: project.instructions,
    attachments: project.attachments,
    createdAt: project.createdAt,
    lastOpenedAt: project.lastOpenedAt,
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Registry,
  sessionId: string,
  token: string,
  rebuildRegistry?: () => Promise<number>,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.agentPort}`);

  // Preflight, so browser-based clients can send the Authorization header.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin ?? "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");

  // Deliberately unauthenticated and deliberately empty: clients need a way to
  // tell whether the server is up before they have a token, and this reveals
  // nothing — not the tool count, not the model, not the version.
  if (req.method === "GET" && url.pathname === "/ping") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req, token)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="enio"');
    sendJson(res, 401, {
      error: {
        message:
          "Missing or invalid API key. Send it as 'Authorization: Bearer <key>'. " +
          "Find yours with: enio token",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [{ id: "enio", object: "model", owned_by: "local" }],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, tools: registry.all.length });
    return;
  }

  /**
   * What this agent can do, as data.
   *
   * A client that wants to show the user their options should not have to ask
   * the model. The model only ever sees one specialist's slice of the registry,
   * so it answers "what tools do you have" with two when there are eleven —
   * accurate for the turn, wrong as an answer. This is the whole picture, it
   * costs no tokens, and it cannot hallucinate.
   */
  if (req.method === "GET" && url.pathname === "/capabilities") {
    const ctx = mentionContext(registry);
    sendJson(res, 200, {
      tools: registry.all.map((t) => ({
        name: t.name,
        description: t.description,
        origin: t.origin,
        server: t.server ?? null,
      })),
      skills: loadSkills().skills.map((s) => ({
        name: s.name,
        description: s.description,
      })),
      agents: SPECIALISTS.map((s) => ({
        name: s.name,
        description: s.description,
        tools: s.tools,
      })),
      servers: ctx.servers,
      // Split so the file menu can stay a view of the *workspace*. Attachments
      // still have to be listed, because an @mention naming one has to resolve
      // after a restart -- but a menu that grows by one row every time anyone
      // attaches a screenshot stops being a way to find a file.
      files: ctx.files.filter((f) => !f.startsWith(`${ATTACH_DIR}/`)),
      attachments: ctx.files.filter((f) => f.startsWith(`${ATTACH_DIR}/`)),
      // So a client can decide whether to offer a microphone at all, rather
      // than offering one that returns 503 when pressed.
      voice: { transcription: whisperInstalled(), speech: config.ttsEngine !== "off" },
      // The active project, so the chip and the file menu can reflect it
      // without a second request. Null is a real answer: nothing open.
      project: projectSummary(activeProject()),
      // semanticRecall false means memory search is running keyword-only --
      // a degradation the user would otherwise diagnose as "worse answers".
      // Null means nothing has tried to embed yet this session.
      memory: { semanticRecall: embeddingsDegraded() === null ? null : !embeddingsDegraded() },
      // The launcher's tile list. Availability is derived per request from
      // the live registry, so a tile flips to available the moment its
      // backing configuration exists -- nothing stored, nothing stale.
      abilities: ABILITIES.map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        icon: a.icon,
        promptTemplate: a.promptTemplate,
        suggestions: a.suggestions ?? [],
        inputs: a.inputs,
        outputs: a.outputs,
        availability: abilityAvailability(a, registry, ctx.servers),
        launcherHidden: a.launcherHidden ?? false,
        requiredFlag: a.requiredFlag ?? null,
        setup: a.setup ?? null,
      })),
    });
    return;
  }

  /**
   * Dictation. Takes raw 16kHz mono WAV bytes and returns the text.
   *
   * Raw rather than multipart because both ends are ours and a multipart parser
   * is a dependency this does not need. WAV rather than the browser's native
   * webm/opus because decoding webm needs ffmpeg, and a feature that only fails
   * on machines without it is worse than one that never needs it.
   */
  if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
    if (!whisperInstalled()) {
      sendJson(res, 503, {
        error: { message: "Speech recognition is not installed. Run: enio voice --install" },
      });
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const audio = Buffer.concat(chunks);

    if (audio.length < 44) {
      sendJson(res, 400, { error: { message: "No audio received." } });
      return;
    }

    const file = join(tmpdir(), `enio-dictation-${randomUUID()}.wav`);
    try {
      await writeFile(file, audio);
      // Interim passes during live dictation ask for the quicker model: being
      // a second closer to the speaker is worth more than a proper noun that
      // the final pass will correct anyway.
      const result = await transcribeWav(file, { fast: url.searchParams.get("fast") === "1" });
      if (result.error) {
        sendJson(res, 500, { error: { message: result.error } });
        return;
      }
      sendJson(res, 200, { text: result.text });
    } finally {
      // The recording is the user's voice. It exists for as long as one
      // transcription takes and no longer, whatever the outcome.
      await rm(file, { force: true }).catch(() => {});
    }
    return;
  }

  /**
   * Speech. Text in, WAV out.
   *
   * Synthesised here rather than in the desktop app so every client gets the
   * same voice, and so the model is loaded once in one process instead of once
   * per window. A client that cannot play audio simply never calls it.
   */
  /**
   * Load the voice model ahead of needing it.
   *
   * Called when the desktop turns speech on, so the first sentence of the
   * first reply is not preceded by a model load. Returns immediately rather
   * than waiting for the load: the caller has nothing to do with the answer,
   * and holding the request open would only give it something to time out.
   */
  // Feature routes, one module each — see src/routes/index.ts.
  for (const handleFeature of FEATURE_ROUTES) {
    if (await handleFeature(req, res, url)) return;
  }
  if (req.method === "POST" && url.pathname === "/v1/audio/warm") {
    void warmVoice();
    sendJson(res, 202, { warming: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
    const body = await readBody(req);
    let text = "";
    try {
      text = String(JSON.parse(body)?.input ?? "");
    } catch {
      sendJson(res, 400, { error: { message: "Invalid JSON body" } });
      return;
    }

    const wav = await synthesize(text);
    if (!wav) {
      // 503 rather than 500: nothing is broken, the voice is just unavailable,
      // and the caller should fall back rather than retry.
      sendJson(res, 503, { error: { message: "Speech synthesis unavailable." } });
      return;
    }

    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
    res.end(wav);
    return;
  }

  /**
   * Stored conversations.
   *
   * The desktop app owns its thread in memory but every message is logged
   * here, so restoring after a restart is a read, not a migration. Discard is
   * the one write with judgement in it: the caller must say what happens to
   * the facts learned from the conversation, because a fact whose transcript
   * is deleted cannot survive a reindex — keeping it means pinning it, and
   * that decision belongs to the user, not to a default.
   */
  /**
   * Approving, saving or declining a proposed action.
   *
   * Execution lives here rather than in the tool on purpose: the model writes
   * the script and never runs it, so the only path from "the model composed
   * some AppleScript" to "AppleScript ran" goes through a person. Approving
   * runs it once; saving also promotes it to a named recipe, after which it is
   * selected rather than re-authored.
   */
  /**
   * Whether macOS will let *this* process read the accessibility tree.
   *
   * Answered from the agent, deliberately, because the agent is what runs
   * osascript. The desktop app can ask Electron the same question, but Electron
   * answers for Enio.app, and the agent is a child process — those two answers
   * are usually the same and the one that matters is this one.
   *
   * Re-probed on every call rather than served from the cache the tool
   * descriptions use. The entire purpose is to be asked again after a trip to
   * System Settings, and a cached "no" would leave the capability dark until a
   * restart, which is exactly the confusing part of macOS permissions.
   */
  /**
   * Which model the machine runs, switchable while everything stays up.
   *
   * Switching restarts the model server underneath the agent; the agent
   * itself never goes down, so the desktop's session, pending plans and
   * conversations all survive.
   *
   * Two lists, and the split is the point. `available` is what can be served
   * right now -- the bundled default plus what is already in the cache -- so
   * switching stays instant and cannot fail on a download. `catalogue` is what
   * could be fetched, which is a different and much slower decision, kept
   * behind its own endpoint so it can never be taken by accident.
   *
   * `machineMemory` goes out with them because whether a model fits is a fact
   * about this machine, not about the model, and the client should not have to
   * guess at it.
   */
  if (req.method === "GET" && url.pathname === "/model") {
    const installed = new Set(availableModels());
    sendJson(res, 200, {
      current: currentModelId(),
      available: availableModels(),
      machineMemory: machineMemory(),
      // Which chip the estimates were made FOR rides along, so the dialog
      // can say "estimated for Apple M4" instead of implying measurement.
      machineChip: machineChip(),
      catalogue: CATALOGUE.map((m) => ({
        ...m,
        installed: installed.has(m.id),
        fit: fitFor(m.bytes),
        speed: speedFor(m),
      })),
      // The one model worth escalating to locally, or null. Computed here so
      // the client never re-derives capability ordering from the list.
      upgrade: recommendUpgrade(currentModelId()),
      download: downloadState(),
    });
    return;
  }

  /**
   * Fetching a model that is not here yet.
   *
   * Returns as soon as the download is running, because a 17GB transfer
   * outlives any request worth holding open; the client polls this same path
   * for progress. Only ids in the catalogue are accepted -- see
   * model-catalogue.ts for why that is a boundary and not just curation.
   *
   * Nothing here switches to what it just downloaded. Finishing a download and
   * restarting the model server are separate acts, and doing both on one click
   * would take the machine down mid-conversation as a side effect of "get me
   * this model".
   */
  if (url.pathname === "/model/download") {
    if (req.method === "GET") {
      sendJson(res, 200, { download: downloadState() });
      return;
    }
    if (req.method === "DELETE") {
      sendJson(res, 200, { cancelled: cancelDownload(), download: downloadState() });
      return;
    }
    if (req.method === "POST") {
      let wanted = "";
      try {
        wanted = String(JSON.parse((await readBody(req)) || "{}")?.model ?? "").trim();
      } catch {
        wanted = "";
      }
      try {
        sendJson(res, 202, { download: startDownload(wanted) });
      } catch (err) {
        const refused = err instanceof DownloadRefused;
        sendJson(res, refused ? 400 : 500, { error: { message: (err as Error).message } });
      }
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/model") {
    let wanted = "";
    try {
      wanted = String(JSON.parse((await readBody(req)) || "{}")?.model ?? "").trim();
    } catch {
      wanted = "";
    }
    if (!availableModels().includes(wanted)) {
      sendJson(res, 400, {
        error: { message: `Not an available model. One of: ${availableModels().join(", ")}` },
      });
      return;
    }
    if (wanted === currentModelId()) {
      sendJson(res, 200, { current: wanted, switched: false });
      return;
    }
    try {
      await switchModel(wanted, {
        log: (m) => console.log(`[model] ${m}`),
        // The list is pre-downloaded models only, so nothing here should ever
        // ask; an endpoint has nobody to ask anyway.
        confirm: async () => false,
      });
      sendJson(res, 200, { current: wanted, switched: true });
    } catch (err) {
      sendJson(res, 500, { error: { message: (err as Error).message } });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/permissions") {
    sendJson(res, 200, {
      // null rather than false where the question does not apply, so a client
      // can tell "not granted" apart from "not a Mac" and stay quiet.
      accessibility: recipesEnabled() ? await probeAssistiveAccess() : null,
      desktopActions: desktopEnabled(),
    });
    return;
  }

  // The cards a client needs to re-draw after a restart: the approval widget
  // otherwise only ever travelled over the live stream, so a pending plan
  // proposed before a restart had no surface left to decide it from.
  if (req.method === "GET" && url.pathname === "/plans/pending") {
    sendJson(res, 200, { plans: listPendingPlans() });
    return;
  }

  /**
   * Recipes: the closed list the model chooses from, managed by a person.
   *
   * Built-ins are code and read-only here, but they are still listed — the
   * whole point of this list is that it is *curated*, and curating a set you
   * can only see half of is guesswork.
   */
  if (req.method === "GET" && url.pathname === "/recipes") {
    sendJson(res, 200, {
      builtin: builtinRecipes(),
      saved: listSavedRecipes(),
      autoRun: autoRunEnabled(),
      // So the editor can say why a saved recipe would not run, rather than
      // letting the user write one that silently never fires.
      desktopActions: desktopEnabled(),
    });
    return;
  }

  const recipeMatch = url.pathname.match(/^\/recipes\/([A-Za-z0-9_-]{1,64})$/);
  if (recipeMatch) {
    const rawName = recipeMatch[1]!;

    if (req.method === "DELETE") {
      sendJson(res, 200, { removed: forgetRecipe(rawName) });
      return;
    }

    if (req.method === "PUT") {
      if (!desktopEnabled()) {
        sendJson(res, 409, {
          error: {
            message:
              "Saving a recipe runs it first, and running needs desktop mode. " +
              "Start enio with ENIO_DESKTOP=1.",
          },
        });
        return;
      }

      const name = normalizeRecipeName(rawName);
      if (!name) {
        sendJson(res, 400, { error: { message: "Name is too short." } });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(BUILTIN_NAMES, name)) {
        // Shadowing a built-in would make the same name mean two things
        // depending on which lookup won, which is the kind of ambiguity the
        // model has no way to see.
        sendJson(res, 409, { error: { message: `"${name}" is a built-in recipe.` } });
        return;
      }

      let body: { summary?: unknown; script?: unknown; kind?: unknown; safe?: unknown } = {};
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        sendJson(res, 400, { error: { message: "Body must be JSON." } });
        return;
      }
      const script = String(body.script ?? "").trim();
      const summary = String(body.summary ?? "").trim();
      const kind = PLAN_KINDS.includes(body.kind as PlanKind)
        ? (body.kind as PlanKind)
        : ("applescript" as PlanKind);
      const safe = body.safe === true;
      if (!script || !summary) {
        sendJson(res, 400, { error: { message: "A recipe needs a summary and a script." } });
        return;
      }

      // Run before promoting — the same rule approving a plan obeys. A recipe
      // is selected rather than re-authored from then on, so one that never
      // worked would be re-run verbatim forever. Skipped only when the script
      // is byte-identical to what is already stored, so renaming or reworded
      // summaries do not re-fire something with a side effect.
      const existing = listSavedRecipes().find((r) => r.name === name);
      // Marking an unchanged recipe safe must not re-run it: vouching for a
      // script is a judgement about one already known to work, not a reason
      // to fire something with a side effect again.
      if (!existing || existing.script !== script || existing.kind !== kind) {
        const run = await runScript(script, kind);
        if (!run.ok) {
          sendJson(res, 400, {
            error: { message: "That script failed, so it was not saved." },
            output: run.output,
          });
          return;
        }
        const result = saveRecipe({ name, summary, script, kind, safe });
        sendJson(res, 200, { name: result.ok ? result.name : name, output: run.output, ran: true });
        return;
      }

      saveRecipe({ name, summary, script, kind, safe });
      sendJson(res, 200, { name, ran: false });
      return;
    }
  }

  /**
   * Whether a vouched-for recipe may run unattended.
   *
   * Separate from ENIO_DESKTOP on purpose: one says whether this can act at
   * all, the other whether it may act without stopping to ask. Turning both
   * on in a single gesture would be bundled consent.
   */
  if (req.method === "GET" && url.pathname === "/automation") {
    sendJson(res, 200, { autoRun: autoRunEnabled(), desktopActions: desktopEnabled() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/automation") {
    let on = false;
    try {
      on = JSON.parse((await readBody(req)) || "{}")?.autoRun === true;
    } catch {
      on = false;
    }
    setAutoRun(on);
    sendJson(res, 200, { autoRun: autoRunEnabled() });
    return;
  }

  /**
   * Run one step of a pending plan, without settling it.
   *
   * Approving a whole plan to find out whether its third step works is a bad
   * trade when the steps have side effects, and it is worse now that a step
   * can be Python. Testing is the same consent as approving, scoped to one
   * step the user is looking at: it runs what is in the editor, which may not
   * be what was proposed, and the plan stays pending either way.
   */
  const testMatch = url.pathname.match(/^\/plans\/([0-9a-f-]{8,})\/test$/);
  if (testMatch && req.method === "POST") {
    const plan = getPlan(testMatch[1]!);
    if (!plan) {
      sendJson(res, 404, { error: { message: "No such plan." } });
      return;
    }
    if (!desktopEnabled()) {
      sendJson(res, 409, {
        error: { message: "Desktop control is off. Start enio with ENIO_DESKTOP=1." },
      });
      return;
    }
    let body: { index?: unknown; script?: unknown; kind?: unknown } = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      /* an empty body just means "the step as stored" */
    }
    const steps = planSteps(plan);
    const index = Number(body.index ?? 0);
    const stored = steps[index];
    if (!stored) {
      sendJson(res, 400, { error: { message: `No step ${index + 1} in this plan.` } });
      return;
    }
    const script = typeof body.script === "string" && body.script.trim() ? body.script : stored.script;
    const kind = PLAN_KINDS.includes(body.kind as PlanKind)
      ? (body.kind as PlanKind)
      : (stored.kind ?? "applescript");
    const out = await runScript(script, kind);
    sendJson(res, 200, { ok: out.ok, output: out.output });
    return;
  }

  /**
   * Revise a pending plan by describing the change.
   *
   * Returns the revised steps rather than storing them: the user reads them
   * in the same editor they could have typed, and nothing is committed until
   * they approve. A bad revision costs a glance, not an action -- which is
   * what makes it safe to let the model rewrite its own proposal at all.
   */
  const reviseMatch = url.pathname.match(/^\/plans\/([0-9a-f-]{8,})\/revise$/);
  if (reviseMatch && req.method === "POST") {
    const plan = getPlan(reviseMatch[1]!);
    if (!plan) {
      sendJson(res, 404, { error: { message: "No such plan." } });
      return;
    }
    let body: { instruction?: unknown; steps?: unknown } = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      /* an empty body is caught by the instruction check below */
    }
    // Revise what is on screen, including edits not yet approved -- otherwise
    // "now make it Python" would silently discard the line just typed.
    const base = Array.isArray(body.steps) && body.steps.length > 0
      ? (body.steps as Array<Record<string, unknown>>).map((st) => ({
          summary: String(st?.summary ?? ""),
          script: String(st?.script ?? ""),
          kind: PLAN_KINDS.includes(st?.kind as PlanKind)
            ? (st.kind as PlanKind)
            : ("applescript" as PlanKind),
        }))
      : planSteps(plan);

    const out = await revisePlan(base, String(body.instruction ?? ""), plan.summary);
    if (!out.ok) {
      sendJson(res, 400, { error: { message: out.reason ?? "Could not revise that." } });
      return;
    }
    sendJson(res, 200, { steps: out.steps });
    return;
  }

  const planMatch = url.pathname.match(/^\/plans\/([0-9a-f-]{8,})\/(approve|save|decline)$/);
  if (planMatch && req.method === "POST") {
    const [, id, action] = planMatch;
    const plan = getPlan(id!);
    if (!plan) {
      sendJson(res, 404, { error: { message: "No such plan." } });
      return;
    }
    if (plan.status !== "pending") {
      // Re-approving a plan would run it twice, which for anything with a side
      // effect is the difference between one email and two.
      sendJson(res, 409, { error: { message: `This plan was already ${plan.status}.` } });
      return;
    }

    if (action === "decline") {
      settlePlan(plan.id, "declined");
      sendJson(res, 200, { status: "declined" });
      return;
    }

    // The flag gates execution, not just proposal. A plan proposed while
    // ENIO_DESKTOP was on must not run after the user turns it off — the plan
    // stays pending rather than settling, so re-enabling the flag revives it.
    if (!desktopEnabled()) {
      sendJson(res, 409, {
        error: {
          message:
            "Desktop control is switched off, so this plan cannot run. " +
            "Start enio with ENIO_DESKTOP=1 to approve it.",
        },
      });
      return;
    }

    // Both approve and save may carry edited steps: what the user reads in the
    // sheet is what they are consenting to, so if they changed it, the changed
    // text is the plan. Stored before running so the record, the approval and
    // the execution are the same thing rather than three versions of it.
    let body: { name?: unknown; safe?: unknown; steps?: unknown } = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      /* no body is the ordinary case: approve exactly what was proposed */
    }

    if (Array.isArray(body.steps) && body.steps.length > 0) {
      const edited = (body.steps as Array<Record<string, unknown>>)
        .map((st) => ({
          summary: String(st?.summary ?? "").trim(),
          script: String(st?.script ?? ""),
          kind: PLAN_KINDS.includes(st?.kind as PlanKind)
            ? (st.kind as PlanKind)
            : ("applescript" as PlanKind),
        }))
        .filter((st) => st.script.trim());
      if (edited.length === 0) {
        sendJson(res, 400, { error: { message: "Every step was emptied." } });
        return;
      }
      replacePlanSteps(plan.id, edited);
      plan.payload = JSON.stringify(edited);
    }

    // The name is checked before anything runs: execution is one-shot, and
    // discovering the name was invalid after the steps ran would leave a
    // successful run unsaveable.
    let saveAs: string | undefined;
    if (action === "save") {
      const name = normalizeRecipeName(String(body.name ?? ""));
      if (!name) {
        sendJson(res, 400, { error: { message: "Name is too short." } });
        return;
      }
      saveAs = name;
    }

    sendJson(res, 200, await approvePlan(plan, { saveAs, safe: body.safe === true }));
    return;
  }

  /**
   * What is on disk and whose it is: workspace files, and attachments grouped
   * by the conversation they were attached to.
   *
   * A read and a delete, and nothing else. Reusing a file is re-mentioning it,
   * which needs no endpoint, and saving one out is the desktop's own save
   * dialog -- routing a copy of the bytes through HTTP to land them somewhere
   * the agent is not allowed to write would be theatre.
   */
  if (req.method === "GET" && url.pathname === "/files") {
    sendJson(res, 200, listStorage());
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/files") {
    const path = url.searchParams.get("path");
    const conversation = url.searchParams.get("conversation");
    try {
      const freed = conversation
        ? removeConversationFiles(conversation)
        : removeFile(String(path ?? ""));
      sendJson(res, 200, { freed });
    } catch (err) {
      const refused = err instanceof FileRefused || /escapes the workspace/.test(String(err));
      sendJson(res, refused ? 400 : 500, { error: { message: (err as Error).message } });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/conversations") {
    const project = url.searchParams.get("project") ?? undefined;
    sendJson(res, 200, { conversations: listConversations(50, project) });
    return;
  }

  /**
   * Projects. Every write here is a user act arriving through the desktop or
   * CLI -- no tool definition reaches these routes, which is what keeps the
   * sandbox something the user grants rather than something the model widens.
   * All behind the same bearer auth as everything else: attach + open moves
   * where run_command executes, so an unauthenticated caller must not reach
   * it (a web page can POST to loopback).
   */
  if (url.pathname === "/projects" && req.method === "GET") {
    sendJson(res, 200, {
      projects: listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        description: p.description,
        attachments: p.attachments.length,
        lastOpenedAt: p.lastOpenedAt,
      })),
    });
    return;
  }

  if (url.pathname === "/projects" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; type?: string; description?: string };
      const project = createProject({
        name: String(body?.name ?? ""),
        type: body?.type,
        description: body?.description,
      });
      sendJson(res, 200, { project: projectDetail(project) });
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return;
  }

  const projMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{8,})(\/(open|attachments)(\/(.+))?)?$/);
  if (projMatch) {
    const [, id, , sub, , aliasRaw] = projMatch;
    try {
      if (req.method === "GET" && !sub) {
        const project = findProject(id!);
        if (!project) {
          sendJson(res, 404, { error: { message: `No project with id ${id}.` } });
          return;
        }
        sendJson(res, 200, { project: projectDetail(project) });
        return;
      }
      if (req.method === "PATCH" && !sub) {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, string>;
        sendJson(res, 200, { project: projectDetail(updateProject(id!, body)) });
        return;
      }
      if (req.method === "DELETE" && !sub) {
        deleteProject(id!);
        sendJson(res, 200, { deleted: id });
        return;
      }
      if (req.method === "POST" && sub === "open") {
        const project = openProject(id!);
        buildIndexInBackground(project);
        sendJson(res, 200, { project: projectDetail(project) });
        return;
      }
      if (req.method === "POST" && sub === "attachments") {
        const body = JSON.parse((await readBody(req)) || "{}") as { path?: string; note?: string };
        const attachment = attachPath(id!, String(body?.path ?? ""), body?.note ?? "");
        // A new root while this project is open should be searchable now,
        // not after the next open.
        const current = activeProject();
        if (current && current.id === id) buildIndexInBackground(current);
        sendJson(res, 200, { attachment });
        return;
      }
      if (req.method === "DELETE" && sub === "attachments" && aliasRaw) {
        detachPath(id!, decodeURIComponent(aliasRaw));
        sendJson(res, 200, { detached: decodeURIComponent(aliasRaw) });
        return;
      }
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
      return;
    }
  }

  /**
   * Pipelines. The graph is data the user edits and the harness executes;
   * the model's only role was drafting it in /pipelines/compose. All behind
   * the same bearer auth as everything else -- a node can reach run_command,
   * so an unauthenticated run endpoint would be remote code execution.
   */
  if (url.pathname === "/pipelines" && req.method === "GET") {
    sendJson(res, 200, {
      pipelines: listPipelines().map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        nodeCount: p.nodes.length,
        lastRunAt: p.lastRunAt,
        // What the Save-as-skill button (and run_pipeline eligibility) hang
        // on: has reality tested this graph at least once.
        vouched: hasSuccessfulRun(p.id),
      })),
    });
    return;
  }

  if (url.pathname === "/pipelines" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const pipeline = savePipeline(body);
      // The dialog's run-then-save flow: saving after a watched draft run
      // brings that run along, so the new pipeline is born vouched.
      if (typeof body?.adoptRunId === "string") adoptRun(body.adoptRunId, pipeline.id);
      sendJson(res, 200, { pipeline });
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return;
  }

  if (url.pathname === "/pipelines/run-draft" && req.method === "POST") {
    // Runs an unsaved graph: the canvas proves a flow works BEFORE it earns
    // a name. The ephemeral id exists only so the run can be stopped and,
    // if the user saves afterwards, adopted. Every executor guard (running
    // set, recursion flag, node gates) applies exactly as for a saved run.
    let draft: { nodes: PipelineNode[]; edges: PipelineEdge[] };
    try {
      draft = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { error: { message: "Body must be JSON." } });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    try {
      await runPipeline(
        {
          id: randomUUID(),
          name: "(draft)",
          description: "",
          nodes: draft.nodes ?? [],
          edges: draft.edges ?? [],
          createdAt: Date.now(),
          lastRunAt: null,
        },
        registry,
        (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      );
    } catch (err) {
      res.write(
        `data: ${JSON.stringify({ type: "run_finished", status: "failed", error: (err as Error).message })}\n\n`,
      );
    }
    res.end();
    return;
  }

  if (url.pathname === "/pipelines/compose" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const composed = await composePipeline(
      String(body?.prompt ?? ""),
      registry,
      mentionContext(registry).servers,
    );
    // Stores nothing: the draft goes straight to the canvas, where a bad
    // compose costs a glance and an edit rather than an action.
    sendJson(res, composed.ok ? 200 : 422, composed);
    return;
  }

  if (url.pathname === "/pipelines/suggest" && req.method === "POST") {
    // Mines the trace history for repeated tool sequences. POST, not GET,
    // and user-triggered only: analyse() embeds up to 2000 questions, which
    // is real work the user chooses to spend, never a background loop.
    // Returns unsaved drafts -- the canvas is where they become pipelines.
    sendJson(res, 200, { drafts: await suggestPipelines() });
    return;
  }

  const pipeMatch = url.pathname.match(/^\/pipelines\/([0-9a-f-]{8,})(\/(run|stop|runs|skill))?$/);
  if (pipeMatch) {
    const [, id, , sub] = pipeMatch;
    if (req.method === "POST" && sub === "stop") {
      // Before the row lookup: a draft run has no pipelines row, but its id
      // is just as stoppable.
      const stopped = stopPipeline(id!);
      sendJson(res, stopped ? 200 : 409, stopped
        ? { stopped: true }
        : { error: { message: "That pipeline is not running." } });
      return;
    }
    const pipeline = getPipeline(id!);
    if (!pipeline) {
      sendJson(res, 404, { error: { message: `No pipeline with id ${id}.` } });
      return;
    }
    if (req.method === "GET" && !sub) {
      sendJson(res, 200, { pipeline });
      return;
    }
    if (req.method === "GET" && sub === "runs") {
      sendJson(res, 200, { runs: listRuns(id!) });
      return;
    }
    if (req.method === "POST" && sub === "skill") {
      try {
        sendJson(res, 200, { skill: exportPipelineSkill(id!) });
      } catch (err) {
        const message = (err as Error).message;
        sendJson(res, /already exists/.test(message) ? 409 : 400, { error: { message } });
      }
      return;
    }
    if (req.method === "POST" && !sub) {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        sendJson(res, 200, { pipeline: savePipeline({ ...body, id: id! }) });
      } catch (err) {
        sendJson(res, 400, { error: { message: (err as Error).message } });
      }
      return;
    }
    if (req.method === "DELETE" && !sub) {
      deletePipeline(id!);
      sendJson(res, 200, { deleted: id });
      return;
    }
    if (req.method === "POST" && sub === "run") {
      if (pipelineIsRunning(id!)) {
        // The same reasoning as the plans 409: for anything with side
        // effects, refusing a double run is the difference between one email
        // and two.
        sendJson(res, 409, { error: { message: "This pipeline is already running." } });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      try {
        await runPipeline(pipeline, registry, (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
      } catch (err) {
        res.write(
          `data: ${JSON.stringify({ type: "run_finished", status: "failed", error: (err as Error).message })}\n\n`,
        );
      }
      res.end();
      return;
    }
  }

  /**
   * The launcher's "Enable desktop control" button. The same consent
   * ENIO_DESKTOP=1 records, made one deliberate click instead of a shell —
   * persisted machine-wide, still followed by macOS's own per-app prompts.
   * The registry rebuilds so the desktop tools exist on the next request
   * without a restart. Behind auth like everything else; no tool reaches
   * this route.
   */
  /**
   * MCP connection management. The same file the user could always hand-edit
   * (~/.enio/mcp.json), with the reload built in: every write rebuilds the
   * registry, so tools appear and vanish without a restart. No tool reaches
   * this module -- the model can never add itself a server -- and adding one
   * runs its command on reload, which is exactly what hand-editing did.
   */
  const mcpMatch = url.pathname.match(/^\/mcp\/servers(\/([A-Za-z0-9_-]+))?$/);
  if (mcpMatch) {
    const serverName = mcpMatch[2];
    const merged = () => {
      const { servers } = readMcpConfig();
      const status = new Map(mcpStatus().map((s) => [s.name, s]));
      return Object.entries(servers).map(([name, cfg]) => ({
        name,
        command: cfg.command,
        args: cfg.args ?? [],
        tools: cfg.tools ?? null,
        disabled: cfg.disabled === true,
        connected: status.get(name)?.connected ?? false,
        toolCount: status.get(name)?.toolCount ?? 0,
        error: status.get(name)?.error ?? null,
      }));
    };
    try {
      if (req.method === "GET" && !serverName) {
        sendJson(res, 200, { servers: merged() });
        return;
      }
      if (req.method === "POST" && !serverName) {
        const body = JSON.parse((await readBody(req)) || "{}");
        addServer(String(body?.name ?? ""), {
          command: String(body?.command ?? ""),
          ...(Array.isArray(body?.args) ? { args: body.args.map(String) } : {}),
          ...(body?.env && typeof body.env === "object" ? { env: body.env } : {}),
          ...(Array.isArray(body?.tools) && body.tools.length > 0
            ? { tools: body.tools.map(String) }
            : {}),
        });
        if (rebuildRegistry) await rebuildRegistry();
        sendJson(res, 200, { servers: merged() });
        return;
      }
      if (req.method === "PATCH" && serverName) {
        const body = JSON.parse((await readBody(req)) || "{}");
        setServerDisabled(serverName, body?.disabled === true);
        if (rebuildRegistry) await rebuildRegistry();
        sendJson(res, 200, { servers: merged() });
        return;
      }
      if (req.method === "DELETE" && serverName) {
        removeServer(serverName);
        if (rebuildRegistry) await rebuildRegistry();
        sendJson(res, 200, { servers: merged() });
        return;
      }
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/settings/desktop") {
    const body = JSON.parse((await readBody(req)) || "{}");
    setDesktopControl(body?.enabled === true);
    const tools = rebuildRegistry ? await rebuildRegistry() : registry.all.length;
    sendJson(res, 200, { enabled: desktopEnabled(), tools });
    return;
  }

  if (req.method === "GET" && url.pathname === "/project") {
    // lastOpenedId is what the user last chose to have open. A client
    // restoring a session reopens THAT (through this endpoint, like any
    // other open) rather than inferring a project from the newest
    // conversation's tag -- which made closing a project un-survivable
    // across a relaunch.
    sendJson(res, 200, {
      project: projectSummary(activeProject()),
      lastOpenedId: lastOpenedProjectId(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/project/close") {
    closeProject();
    sendJson(res, 200, { project: null });
    return;
  }

  if (req.method === "POST" && url.pathname === "/conversations") {
    sendJson(res, 200, { id: startSession() });
    return;
  }

  const convMatch = url.pathname.match(
    /^\/conversations\/([0-9a-f-]{8,})(\/(messages|knowledge|attachments)(\/(.+))?)?$/,
  );
  if (convMatch) {
    const [, id, , sub, , subArg] = convMatch;

    if (req.method === "GET" && sub === "messages") {
      sendJson(res, 200, { messages: conversationMessages(id!) });
      return;
    }
    // Standing attachments for one conversation. User-only routes, exactly
    // like a project's: no tool reaches this module, so the sandbox stays
    // something the user grants rather than something the model widens.
    if (sub === "attachments") {
      if (req.method === "GET" && !subArg) {
        sendJson(res, 200, { attachments: listConversationAttachments(id!) });
        return;
      }
      if (req.method === "POST" && !subArg) {
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const attachment = attachToConversation(
            id!, String(body?.path ?? ""), String(body?.note ?? ""),
          );
          // Attaching IS working in this conversation: make its mounts the
          // active ones now, so the file listings (mention menu, folders)
          // include the new root before any message is sent -- without this
          // the mount only surfaced after the conversation's next turn.
          setConversationSession(id!);
          sendJson(res, 200, { attachment });
        } catch (err) {
          sendJson(res, 400, { error: { message: (err as Error).message } });
        }
        return;
      }
      if (req.method === "DELETE" && subArg) {
        detachFromConversation(id!, decodeURIComponent(subArg));
        setConversationSession(id!);
        sendJson(res, 200, { detached: decodeURIComponent(subArg) });
        return;
      }
    }
    if (req.method === "GET" && sub === "knowledge") {
      sendJson(res, 200, { facts: conversationKnowledge(id!) });
      return;
    }
    if (req.method === "DELETE" && !sub) {
      const keepFacts = url.searchParams.get("facts") !== "forget";
      // The files go with it. Keeping them would leave bytes on disk that
      // nothing can name any more -- the conversation that grouped them is the
      // only record of what they were for.
      const freed = removeConversationFiles(id!);
      sendJson(res, 200, {
        discarded: id,
        freed,
        ...discardConversation(id!, { keepFacts }),
      });
      return;
    }

    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  const body = await readBody(req);
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const incoming: Message[] = Array.isArray(payload?.messages) ? payload.messages : [];
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    sendJson(res, 400, { error: { message: "No user message provided" } });
    return;
  }

  // Prior turns become history; the final user message drives this turn.
  const history: Message[] = incoming
    .filter((m) => m !== lastUser && m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content ?? "" }));

  // Resolve /skill and @mentions here rather than only in the REPL. Without
  // this the grammar existed but only one client could speak it: "@notes.txt"
  // typed into the desktop app reached the model as literal text, which looks
  // like the feature is broken rather than absent. Anything unrecognised is
  // left verbatim, so an email address is still never eaten.
  const ctx = mentionContext(registry);
  // What "@canvas" means this turn: the file the desktop has pinned beside
  // the thread. Client-supplied, never inferred -- and it resolves through
  // the same sandbox every attachment does, so a bad path is a refusal.
  ctx.canvasPath =
    typeof payload?.canvas_path === "string" && payload.canvas_path.trim()
      ? payload.canvas_path.trim()
      : null;
  const mentions = parseMentions(String(lastUser.content ?? ""), ctx);
  const prompt = mentions.text;
  const overrides = {
    specialist: mentions.specialist,
    skills: mentions.skills,
    files: mentions.files,
    servers: mentions.servers,
  };

  // A client may pin the turn to a stored conversation. Without it, the boot
  // session applies — which is what keeps plain OpenAI clients working.
  // setMemorySession follows so a `remember` during this turn carries the
  // conversation's provenance rather than the boot session's.
  const conversationId =
    typeof payload?.conversation_id === "string" && payload.conversation_id
      ? payload.conversation_id
      : sessionId;
  setMemorySession(conversationId);
  setPlanSession(conversationId);
  setBrowseSession(conversationId);
  setConversationSession(conversationId);

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (payload?.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const emit = (delta: Record<string, unknown>) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: "enio",
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`,
      );
    };

    emit({ role: "assistant", content: "" });

    // Throttled: a reasoning delta can arrive per token, and a frame each would
    // be more traffic than the answer.
    let thoughtChars = 0;
    let lastThinkAt = 0;
    let lastArgs: Record<string, unknown> = {};

    try {
      const result = await runTurn(
        prompt,
        history,
        registry,
        conversationId,
        {
          onContent: (d) => emit({ content: d }),
          // Reasoning is stripped before it reaches any client, which is right
          // -- it is not the answer. But it is also the entire wait: the model
          // can spend a minute in <think> while the window shows nothing, and
          // a spinner that cannot say how long it has been spinning is
          // indistinguishable from one that is stuck. Only the running size is
          // sent, never the text.
          onReasoning: (d) => {
            thoughtChars += d.length;
            const now = Date.now();
            if (now - lastThinkAt >= 250) {
              lastThinkAt = now;
              res.write(`: think ${thoughtChars}\n\n`);
            }
          },
          // Surfaced as a comment frame so clients that don't understand it ignore
          // it, rather than rendering tool chatter as assistant text.
          onToolStart: (name, args) => {
            lastArgs = args;
            res.write(`: tool ${name}\n\n`);
          },
          // The pages this turn actually read. Recovered from the tool's own
          // output, so what is cited is exactly what the model was given --
          // see sources.ts. Tool calls run one at a time, which is what makes
          // pairing the end with the args from the start safe.
          onToolEnd: (name, result) => {
            const found = extractSources(name, lastArgs, result);
            if (found.length > 0) {
              res.write(`: sources ${JSON.stringify({ tool: name, items: found })}\n\n`);
            }
            // What the turn CREATED, recovered from the tool's own words --
            // the same contract as sources: the model announces nothing, the
            // harness parses what actually happened. A comment frame, so
            // clients with no canvas lose nothing.
            const made = extractArtifacts(name, result);
            if (made.length > 0) {
              res.write(`: artifact ${JSON.stringify({ tool: name, items: made })}\n\n`);
            }
          },
          // Same channel, same reason. A widget is decoration for a client that
          // can draw it; the tool's text has already gone to the model and to
          // every client that cannot, so dropping this loses nothing.
          // Which agent took the turn. It decides which tools existed, so a
          // reply that could not do something is only explicable with it --
          // and it was already computed and handed to the CLI, reaching every
          // client except the one most people use.
          onRoute: (specialist) => res.write(`: route ${specialist}\n\n`),
          onWidget: (widget) => res.write(`: widget ${JSON.stringify(widget)}\n\n`),
          // Addressed to the user, not the model — which is the whole point of
          // keeping it out of the prompt. Newlines are escaped because an SSE
          // comment ends at one.
          onNotice: (text) =>
            res.write(`: notice ${text.replace(/\r?\n/g, " ")}\n\n`),
          // How full the window is after any folding. On the comment channel
          // like the rest, so a client that does not render it is unaffected
          // and the CLI needs no fallback.
          onContext: (usage) => res.write(`: context ${usage.tokens} ${usage.budget}\n\n`),
        },
        overrides,
      );
      // The file the HARNESS saved, announced through the same frame as one
      // a tool wrote — the client cares that a document exists, not which
      // half of the system persisted it.
      if (result.handoffFile) {
        res.write(
          `: artifact ${JSON.stringify({ tool: "harness", items: [{ type: "document", path: result.handoffFile }] })}\n\n`,
        );
      }
    } catch (err) {
      emit({ content: `\n[error: ${(err as Error).message}]` });
    }
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: "enio",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const result = await runTurn(prompt, history, registry, conversationId, {}, overrides);

  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: "enio",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.reply },
        finish_reason: "stop",
      },
    ],
    // Not part of the OpenAI schema, but useful and ignored by clients that
    // don't look for it.
    x_tools_used: result.toolsUsed,
  });
}


