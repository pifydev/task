/**
 * Does the completion sweep actually reach the model — once?
 *
 * The sweep is injected through the `context` hook, which rewrites the
 * outgoing request without persisting anything. That makes it invisible to
 * the session file, so the only place to check is the provider payload
 * itself. This drives the real extension and reads every request pi sends.
 *
 *   bun run test/live/sweep-wire.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

const home = mkdtempSync(join(tmpdir(), "pify-sweep-wire-"));
const repo = mkdtempSync(join(tmpdir(), "pify-sweep-repo-"));
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const messages = (event.payload && event.payload.messages) || [];",
  "    const text = JSON.stringify(messages);",
  "    appendFileSync(process.env.SWEEP_OUT, JSON.stringify({",
  '      sweep: text.includes("proves the plan was followed"),',
  '      nudge: text.includes("task list has open items"),',
  "    }) + String.fromCharCode(10));",
  "  });",
  "}",
].join(NL);

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);

  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "task.ts"),
      "-p",
      "Call task_add once with a single task subject 'greet the user'. Then call task_update to set " +
        "that task to completed with evidence 'greeting written'. Then reply with the word HELLO.",
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, SWEEP_OUT: out },
    },
  );

  const requests = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  const withSweep = requests.filter((r) => r.sweep).length;
  console.log(`requests: ${requests.length}, carrying the sweep: ${withSweep}`);

  check("requests were captured", requests.length > 0, `${requests.length}`);
  check("the sweep reaches the model once the list is complete", withSweep > 0);
  check("it is sent once, not on every following turn", withSweep <= 1, `${withSweep} request(s)`);
  check(
    "the stale-list nudge does not fire alongside it",
    !requests.some((r) => r.sweep && r.nudge),
  );

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
