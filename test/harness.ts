/**
 * A zero-token, deterministic host for an extension under test.
 *
 * Every live test in this suite spawns a real `pi` against openrouter: it
 * burns tokens, takes half a minute, and its assertions ride on whatever a
 * real model felt like doing that run — the sweep-wire lesson, where the model
 * inventing an extra task turned a passing test into a failing one. pi ships
 * the cure and does not advertise it: `fauxProvider()` (re-exported from
 * `@earendil-works/pi-ai`) scripts assistant turns — text and tool calls —
 * and an in-process `AgentSession` runs the real agent loop against it with no
 * network at all.
 *
 * This drives the ACTUAL extension factory through pi's real ExtensionRunner,
 * so it exercises the shipped `execute`/event handlers, not a reimplementation.
 * What it cannot vouch for is the model's judgement (does the model choose to
 * call the tool) — that is the one thing a faux provider removes, and the one
 * thing genuinely worth a live test. Everything else — did the tool run, what
 * did the extension inject, what reached the model on the next turn — is now
 * a free unit assertion.
 *
 * Built only on published exports; the three test-only internals pi's own
 * harness leans on are swapped for their public substitutes
 * (InMemoryCredentialStore, extensionFactories, modelsPath:null), so this
 * tracks pi through npm rather than a source copy. See
 * [[pi-child-session-gotchas]] for why loader.reload() is not optional.
 */
import {
  getCurrentTools,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { fauxAssistantMessage, fauxToolCall };

/** One scripted assistant turn: literal message or a factory over the Context. */
export type Turn = AssistantMessage | ((context: Context) => AssistantMessage);

export interface Host {
  /** Run one user prompt through the agent loop against the next scripted turn(s). */
  prompt(text: string): Promise<void>;
  /** The Context pi assembled for each provider call, in order — what the model saw. */
  readonly contexts: Context[];
  /** The messages field of the Nth context, stringified, for `.includes` checks. */
  contextText(index: number): string;
  /** Tool names offered on the Nth context. */
  toolNames(index: number): string[];
  /** The working directory (a throwaway temp dir). */
  readonly cwd: string;
  dispose(): void;
}

/**
 * Stand up a host with `extension` loaded and `turns` queued. Each `prompt()`
 * consumes turns until the assistant stops calling tools, exactly as a real
 * loop does; queue one trailing text turn per prompt so the loop can settle.
 */
export async function createHost(
  extension: (pi: ExtensionAPI) => void,
  turns: Turn[],
  options: { env?: Record<string, string | undefined> } = {},
): Promise<Host> {
  const cwd = mkdtempSync(join(tmpdir(), "pify-host-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pify-host-agent-"));

  const savedEnv: Record<string, string | undefined> = {};
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      savedEnv[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const model = (await faux.provider.getModels())[0]!;

  const contexts: Context[] = [];
  faux.setResponses(
    turns.map((turn) => (context: Context) => {
      contexts.push(context);
      return typeof turn === "function" ? turn(context) : turn;
    }),
  );

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension],
  } as never);
  await loader.reload();

  const created = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
  } as never);

  return {
    contexts,
    get cwd() {
      return cwd;
    },
    async prompt(text: string) {
      await created.session.prompt(text);
    },
    contextText(index: number) {
      return JSON.stringify(contexts[index]?.messages ?? []);
    },
    toolNames(index: number) {
      // Since pi 0.86 a provider receives a TranscriptContext: the tool
      // declarations ride inside the messages (the leading system message and
      // later tool patches), and `context.tools` is no longer populated. Read
      // them the way a provider must, so this asserts what the model saw.
      const ctx = contexts[index];
      if (!ctx) return [];
      return getCurrentTools(ctx.messages as never).map((t) => t.name);
    },
    dispose() {
      try {
        created.session.dispose();
      } catch {
        // best effort
      }
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
