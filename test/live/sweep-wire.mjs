/**
 * Does the completion sweep actually reach the model — once per completion
 * episode?
 *
 * The sweep is injected through the `context` hook, which rewrites the
 * outgoing request without persisting anything. That makes it invisible to
 * the session file, so the only place to check is the provider payload
 * itself. This drives the real extension and reads every request pi sends.
 *
 * The driving model improvises, so the assertions check the contract's
 * invariants rather than a fixed count — see the comments at each check.
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
  // The quoted "name" form counts structured tool calls and not the model
  // merely talking about a tool. The counts run over the whole conversation,
  // so they are cumulative — which is the point: a strictly larger count at a
  // later request means a task tool actually ran in between.
  "    appendFileSync(process.env.SWEEP_OUT, JSON.stringify({",
  '      sweep: text.includes("proves the plan was followed"),',
  '      nudge: text.includes("task list has open items"),',
  // If Windows quoting ever eats the prompt again, it arrives one word per
  // message and this phrase never appears contiguously in any single one.
  '      promptIntact: text.includes("Do not create any other tasks"),',
  "      turns: messages.length,",
  // No whitespace tolerance needed: `text` is JSON.stringify output, which
  // never puts a space after a colon.
  '      creates: (text.match(/"name":"task_create"/g) || []).length,',
  '      updates: (text.match(/"name":"task_update"/g) || []).length,',
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
      // Two hard-won details in this one argument. The tool names must be
      // exact — an earlier version said `task_add`, which does not exist, so
      // the test measured whether the model could out-guess a wrong prompt.
      // And the whole sentence must be wrapped in literal double quotes:
      // spawnSync with shell:true on Windows concatenates args unquoted, and
      // an unwrapped sentence reaches pi as ONE PROMPT PER WORD — a session
      // of this test's own making showed the model dutifully creating tasks
      // named "exactly", "once", "with", "greet"... The promptIntact check
      // below is the tripwire for this ever regressing.
      "-p",
      '"Call task_create exactly once with subject greet-the-user. Then call task_update exactly ' +
        'once with id 1, status completed and evidence: greeting written. Do not create any other ' +
        'tasks and do not call any other tools. Then reply with the word HELLO and stop."',
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
  for (const r of requests.filter((x) => x.sweep)) {
    console.log(`  sweep at turns=${r.turns} creates=${r.creates} updates=${r.updates}`);
  }
  const last = requests[requests.length - 1];
  if (last) console.log(`  final: turns=${last.turns} creates=${last.creates} updates=${last.updates}`);

  check("requests were captured", requests.length > 0, `${requests.length}`);
  check(
    "the prompt arrived as one prompt, not one word at a time",
    requests.length > 0 && requests[0].promptIntact,
  );
  check("the sweep reaches the model once the list is complete", withSweep > 0);

  // The contract is "once per completion episode", not "once per run": a
  // model that wanders — reopens a task, adds one, cancels one — legitimately
  // re-arms the sweep, and this harness cannot control the model that
  // tightly. Asserting `withSweep <= 1` measured the model's obedience, not
  // the extension, and failed whenever qwen improvised.
  //
  // Every legitimate re-arm passes through a task tool call (reopen and
  // cancel are task_update, adding is task_create), and the probe's counts
  // are cumulative, so the real invariant is: between two sweep-carrying
  // requests, the combined count must strictly grow. The failure modes this
  // exists to catch — the sweep firing on every turn after completion, or
  // twice for one event — repeat with the counts unchanged.
  const sweeps = requests.filter((r) => r.sweep);
  let repeatWithoutRearm = false;
  for (let i = 1; i < sweeps.length; i++) {
    const before = sweeps[i - 1].creates + sweeps[i - 1].updates;
    const after = sweeps[i].creates + sweeps[i].updates;
    if (after <= before) repeatWithoutRearm = true;
  }
  check(
    "a sweep repeats only after task activity re-armed it",
    !repeatWithoutRearm,
    sweeps.map((s) => `turns=${s.turns} tools=${s.creates}+${s.updates}`).join(" → ") || "one sweep",
  );
  check(
    "the stale-list nudge does not fire alongside it",
    !requests.some((r) => r.sweep && r.nudge),
  );

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  // Windows can hold a handle on the repo for a beat after pi exits; without
  // retries the cleanup throws EPERM and buries the test verdict.
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
