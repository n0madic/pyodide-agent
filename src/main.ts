#!/usr/bin/env -S deno run --env-file=.env --allow-env=OPENAI_*,MODEL,MAX_ITERATIONS,PYODIDE_PACKAGES,HTTP_PROXY,HTTPS_PROXY,NO_PROXY --allow-read --allow-write --allow-net --allow-import
import { Command } from "commander";
import OpenAI from "openai";
import * as readline from "node:readline/promises";
import process from "node:process";
import { type AgentEvent, type AgentRunResult, runAgent } from "./agent.ts";
import { renderEvent } from "./cli-format.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import {
  closePyodide,
  DEFAULT_PACKAGE_SPEC,
  initPyodide,
  resetScratchpad,
  resolvePackages,
} from "./pyodide-runtime.ts";

interface Opts {
  model?: string;
  maxIterations?: string;
  verbose?: boolean;
  json?: boolean;
  mountDir?: string;
  packages?: string;
  allowHostExec?: boolean;
  allowNet?: boolean;
}

const enc = new TextEncoder();
const stdoutWrite = (s: string) => {
  Deno.stdout.writeSync(enc.encode(s));
};
const stderrWrite = (s: string) => {
  Deno.stderr.writeSync(enc.encode(s));
};

type Sink = (s: string) => void;

const program = new Command()
  .name("pyodide-agent")
  .description(
    "LLM agent with a single execute_code tool (Python via Pyodide).\n\n" +
      "Run with no args for interactive REPL, or pass a prompt for one-shot mode.",
  )
  .argument(
    "[prompt]",
    "one-shot prompt (use '-' to read from stdin); omit for REPL",
  )
  .option("-m, --model <id>", "override MODEL env")
  .option("--max-iterations <n>", "override MAX_ITERATIONS env")
  .option("-v, --verbose", "one-shot: stream tool calls to stderr", false)
  .option("--json", "one-shot: emit JSON result to stdout", false)
  .option(
    "--mount-dir <path>",
    "mount a host directory into Pyodide at /host (read-write)",
  )
  .option(
    "--packages <list>",
    "comma-separated Pyodide packages to preload; 'none' = none; " +
      `default: ${DEFAULT_PACKAGE_SPEC}. Examples: pyyaml,python-dateutil,numpy,pandas`,
  )
  .option(
    "--allow-host-exec",
    "UNSAFE: disable the Python-level block on os.system / subprocess / ctypes.CDLL(None). " +
      "Also requires Deno-level --allow-run --allow-ffi (or `deno task start:unsafe` which " +
      "sets both). Without them Python subprocess/FFI calls stay denied by the kernel even " +
      "with this flag.",
    false,
  )
  .option(
    "--allow-net",
    "Enable outbound HTTP/HTTPS from Python — loads `ssl` + `pyodide-http` and runs " +
      "`pyodide_http.patch_all()` so `import requests` just works. Also requires Deno-level " +
      "broad --allow-net (use `deno task start:net` which sets both). Without this flag " +
      "the default Deno posture grants net only to api.openai.com + cdn.jsdelivr.net, so " +
      "Python can't reach arbitrary hosts even if it tried.",
    false,
  );

program.parse();

const opts = program.opts<Opts>();
const positional = program.args[0];

const apiKey = Deno.env.get("OPENAI_API_KEY");
const baseURL = Deno.env.get("OPENAI_BASE_URL") || undefined;
const model = opts.model ?? Deno.env.get("MODEL") ?? "gpt-4o";
const maxIterations = parseInt(
  opts.maxIterations ?? Deno.env.get("MAX_ITERATIONS") ?? "20",
  10,
);

if (!apiKey) {
  stderrWrite(
    "error: OPENAI_API_KEY is not set (copy .env.example to .env and fill it in)\n",
  );
  Deno.exit(2);
}

const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

const allowHostExec = opts.allowHostExec === true;
const allowNet = opts.allowNet === true;
const packages = resolvePackages(
  opts.packages ?? Deno.env.get("PYODIDE_PACKAGES") ?? undefined,
  allowNet,
);
const systemPrompt = buildSystemPrompt({
  mountDir: opts.mountDir,
  packages,
  allowHostExec,
  allowNet,
});

async function readStdin(): Promise<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Deno.stdin.readable) {
    buf += dec.decode(chunk, { stream: true });
  }
  buf += dec.decode(); // flush any incomplete multi-byte sequence
  return buf;
}

function printEvent(event: AgentEvent, sink: Sink): void {
  const rendered = renderEvent(event);
  if (rendered) {
    sink(rendered);
  }
}

async function bootPyodide(interactive: boolean): Promise<void> {
  // Show Pyodide status (startup + runtime wheel loads) in REPL and in
  // --verbose one-shot. Silent in default one-shot so stderr stays quiet
  // until something actually goes wrong.
  const showStatus = interactive || opts.verbose === true;
  await initPyodide({
    ...(opts.mountDir ? { mountDir: opts.mountDir } : {}),
    packages,
    allowHostExec,
    allowNet,
    onStatus: showStatus
      ? (msg) => stderrWrite(`[pyodide] ${msg}\n`)
      : () => {},
  });
  if (opts.mountDir) {
    stderrWrite(
      `[pyodide] warning: files under ${opts.mountDir} are fully read-write from Python\n`,
    );
  }
  if (allowHostExec) {
    // This warning is always shown (even in silent one-shot) — if the user
    // opts out of the Python-level guard, they should see it loud and clear.
    stderrWrite(
      `[pyodide] WARNING: --allow-host-exec is set. The Python block is off; ` +
        `whether Python can actually reach the host shell depends on the Deno ` +
        `permissions (--allow-run / --allow-ffi) granted at launch.\n`,
    );
  }
  if (allowNet) {
    // Detect whether Deno actually has broad net permission. If it's been
    // granted only a narrow allowlist (default `deno task start` posture),
    // `requests.get` to other hosts will fail at Deno's permission layer —
    // warn loudly so the mismatch isn't silent.
    const net = await Deno.permissions.query({ name: "net" });
    if (net.state !== "granted") {
      stderrWrite(
        `[pyodide] WARNING: --allow-net is set but Deno only has scoped net ` +
          `permission. \`requests\` will work for allow-listed hosts only. ` +
          `Use \`deno task start:net\` for broad access.\n`,
      );
    }
  }
}

async function runInteractive(): Promise<void> {
  await bootPyodide(true);
  stdoutWrite(
    `pyodide-agent — model: ${model}${baseURL ? ` @ ${baseURL}` : ""}\n` +
      `commands: /reset, /help, /exit. Ctrl-C to quit.\n\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let history: AgentRunResult["history"] = [];

  try {
    while (true) {
      let line: string;
      try {
        line = (await rl.question("> ")).trim();
      } catch {
        break; // Ctrl-C / EOF
      }
      if (!line) continue;

      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") {
        stdoutWrite(
          "  /reset  — forget conversation + reset Python scratchpad\n" +
            "  /help   — show this\n" +
            "  /exit   — quit\n",
        );
        continue;
      }
      if (line === "/reset") {
        history = [];
        await resetScratchpad();
        stdoutWrite("(history cleared, scratchpad reset)\n");
        continue;
      }

      let totalIn = 0;
      let totalOut = 0;
      const gen = runAgent({
        client,
        model,
        systemPrompt,
        userMessage: line,
        history,
        maxIterations,
      });
      let next = await gen.next();
      while (!next.done) {
        const ev = next.value;
        if (ev.kind === "api_call") {
          totalIn += ev.inputTokens;
          totalOut += ev.outputTokens;
        } else {
          printEvent(ev, stdoutWrite);
        }
        next = await gen.next();
      }
      const result = next.value;
      history = result.history;
      stdoutWrite(
        `\n[${result.iterations} turn(s), ${result.toolCalls} tool call(s), ` +
          `${totalIn} in / ${totalOut} out tokens${
            result.hitMaxIterations ? ", HIT MAX ITER" : ""
          }]\n\n`,
      );
    }
  } finally {
    rl.close();
    closePyodide();
  }
}

async function runOneShot(rawPrompt: string): Promise<void> {
  try {
    await bootPyodide(false);

    let totalIn = 0;
    let totalOut = 0;
    const gen = runAgent({
      client,
      model,
      systemPrompt,
      userMessage: rawPrompt,
      history: [],
      maxIterations,
    });
    let next = await gen.next();
    while (!next.done) {
      const ev = next.value;
      if (ev.kind === "api_call") {
        totalIn += ev.inputTokens;
        totalOut += ev.outputTokens;
      } else if (opts.verbose) {
        // In verbose mode, print all events (tool calls, results, and
        // intermediate text) to stderr. The final answer still goes to stdout.
        printEvent(ev, stderrWrite);
      }
      next = await gen.next();
    }
    const result = next.value;

    if (opts.json) {
      const payload = {
        answer: result.finalText,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        hitMaxIterations: result.hitMaxIterations,
        model,
        tokens: { input: totalIn, output: totalOut },
      };
      stdoutWrite(JSON.stringify(payload, null, 2) + "\n");
    } else {
      stdoutWrite((result.finalText || "").trimEnd() + "\n");
    }

    if (result.hitMaxIterations) {
      stderrWrite(
        `\n[warn] hit max iterations (${maxIterations}) before producing a final answer\n`,
      );
      Deno.exit(1);
    }
  } finally {
    closePyodide();
  }
}

async function main(): Promise<void> {
  try {
    if (positional === undefined) {
      await runInteractive();
      return;
    }
    const prompt = positional === "-" ? (await readStdin()).trim() : positional;
    if (!prompt) {
      stderrWrite("error: empty prompt\n");
      Deno.exit(2);
    }
    await runOneShot(prompt);
  } catch (err) {
    stderrWrite(
      `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    Deno.exit(2);
  }
}

main();
