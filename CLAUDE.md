# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this is

A single-process **Deno** LLM agent with **exactly one tool** (`execute_code`)
that runs Python inside a dedicated Deno worker hosting a
[Pyodide](https://pyodide.org) (WebAssembly) runtime. Speaks any
OpenAI-compatible Chat Completions API via the `openai` SDK. TypeScript, ESM, no
build step — `deno run` executes `.ts` directly.

## Commands

```bash
deno task start                                  # interactive REPL
deno task start "prompt"                         # one-shot, answer on stdout
deno task start --verbose "..."                  # also stream tool calls to stderr
deno task start --json "..."                     # emit JSON payload to stdout
deno task start --raw "..."                      # print reply as raw text (no Markdown rendering)
deno task start --mount-dir ~/notes "..."        # expose host dir at /host (read-write)

deno task start --allow-net ...                  # (see start:net)
deno task start:net ...                          # broad --allow-net + loads pyodide-http
deno task start:unsafe ...                       # --allow-all + --allow-host-exec + --allow-net

deno task check                                  # deno check src/main.ts (strict TS)
deno task test                                   # run tests/ with required perms
deno task compile                                # build standalone ./pyodide-agent (~100 MB)
```

No linter is configured. Tests live in `tests/` (`security.test.ts` covers the
sandbox boundary, `tool-defs.test.ts` covers the dynamic `execute_code`
description, `helpers.test.ts` runs the Python helpers in a real Pyodide,
`system-prompt.test.ts` checks the prompt/helper matrix across modes,
`agent.test.ts` covers output truncation; `_pyodide.ts` is the shared
subprocess runner). Run `deno task check` for type-checking and `deno task test`
for the test suite after non-trivial edits (the task wires up the read/write/run/env/net
permissions the security tests need — bare `deno test` fails with
`Can't escalate parent thread permissions`).

Requires `OPENAI_API_KEY` in `.env`; Deno loads it automatically via
`--env-file=.env` on every task. See `.env.example` for all knobs (`MODEL`,
`OPENAI_BASE_URL`, `MAX_ITERATIONS`, `PYODIDE_PACKAGES`).

## Architecture

Each source file has a narrow responsibility. Understand these five
relationships before editing:

### 1. Agent loop is an async generator

`src/agent.ts` exports `runAgent()` as
`AsyncGenerator<AgentEvent, AgentRunResult>`. The caller (`main.ts`) pulls
events (`text`, `tool_call`, `tool_result`, `api_call`) and decides how to
render them — the REPL prints them live, the one-shot mode stays silent unless
`--verbose`. The generator's **return value** (not a yielded event) carries
`history`, `finalText`, `iterations`, `toolCalls`, `hitMaxIterations`. When
adding an event type, update `AgentEvent` and every consumer in `main.ts`.

### 2. `pyodide-config.ts` is the single source of truth for packages

`PACKAGE_REGISTRY` maps each supported Pyodide package to its Python import
lines and its system-prompt bullet text. `resolvePackages(spec)` takes the
CLI/env spec and returns a `PackageResolution` with three fields that flow to
three different consumers:

- `loadList` → `pyodide.loadPackage()` at startup
- `preludeCode` → `pyodide.runPythonAsync()` after load (sets up
  `scratchpad = {}` and all imports)
- `promptBullets` → embedded in the system prompt so the model sees only what's
  actually loaded

**When adding a new first-class package, add an entry to `PACKAGE_REGISTRY` — do
not special-case it elsewhere.** Packages passed via `--packages` that aren't in
the registry are still loaded but not auto-imported; the prompt notes them as
"available-but-not-imported".

Two orthogonal package mechanisms coexist:

- **Preloaded** (`--packages` / `PYODIDE_PACKAGES`) — loaded once at startup,
  costs RAM upfront.
- **Auto-load on import** — before every `execute_code` call,
  `loadPackagesFromImports(code)` scans for `import` statements and activates
  matching Pyodide-bundled wheels on demand (numpy, pandas, scipy, etc.). Cost:
  ~200ms–1.5s first use, free afterwards. The system prompt already tells the
  model to just `import` these freely.

### 3. `helpers.ts` is the second source of truth, for the Python helper library

`HELPER_REGISTRY` lists every pre-loaded helper (`name`, `group`, `signature`,
`doc`); the Python implementations live as `String.raw` strings in
`helpers-python.ts` (`CORE_PY` / `FS_PY` / `NET_PY`, stdlib only, exec'd into one
module named `HELPER_MODULE` (`agent_helpers`, deliberately not `helpers`, so it
cannot shadow a mounted project's own `helpers.py`) whose `__all__` is copied
into the user's globals).
`resolveHelpers({allowNet, hasMount})` generates both the Python prelude
(`HelperResolution.preludeCode`, run by the worker right after the package
prelude and before `HOST_EXEC_BLOCKER`) and the system prompt's helper section,
including the worked example (`exampleKind`). **Helpers unavailable in the
current mode (the `net` group without `--allow-net`) must not be defined or
mentioned anywhere — prompt text, examples, rules, tool description.** To add a
helper: implement it in `helpers-python.ts`, list it in that source's
`__all__.extend([...])`, add a registry entry — don't edit the prompt by hand.
`fetch` talks to `pyfetch` through the module variable `_pyfetch` so tests can
replace it (`tests/helpers.test.ts`; one test also runs the real path with
`realNet`). `save()` itself refuses to overwrite a file under `/host` that
existed before the session unless `overwrite=True` — that guard lives in the
helper, not only in the prompt. Pyodide's `pyfetch` imports
`AbortController, AbortSignal, Object, Request, fetch` from `js` in one
statement, so the worker passes `NET_JSGLOBALS` (not `SAFE_JSGLOBALS`) when
`--allow-net` is set. `agent.ts` caps tool output sent to the
model at `MAX_TOOL_OUTPUT_CHARS` (`tool-defs.ts`) via `truncateMiddle`.

### 4. Python state persists across tool calls

Pyodide globals (including `scratchpad`) survive between `execute_code`
invocations within a session. The main thread talks to the worker through
`pyodide-runtime.ts`, which keeps the worker alive for the duration of the CLI
session. `/reset` in the REPL clears both chat history and runs
`scratchpad = {}` (but does **not** re-run the full prelude — other module
imports and user-defined globals persist). The system prompt in
`system-prompt.ts` explicitly instructs the model to exploit this.

### 5. System prompt is generated per-run

`buildSystemPrompt()` is called once in `main.ts` after package resolution, and
the output reflects **this run's** loaded packages and mount state. If you
change what gets pre-imported or how the sandbox behaves, update
`system-prompt.ts` so the model's mental model stays accurate — a silent drift
between `PACKAGE_REGISTRY` and the prompt is a real hazard.

## Sandbox & stream plumbing

- `src/pyodide-runtime.ts` is now an RPC wrapper around `src/pyodide-worker.ts`.
  The wrapper is responsible for worker lifecycle, permission shaping, and
  forwarding status/result messages back to `main.ts`.
- Pyodide stdout/stderr are captured inside the worker via
  `setStdout`/`setStderr` with `batched` callbacks into worker-local
  `stdoutBuf`/`stderrBuf`. `executeCode()` resets them before each call and
  returns `{stdout, stderr, ok, durationMs}`.
- Pyodide's own progress messages (e.g. `Loading numpy`) are routed to
  `statusCallback` (stderr in the REPL) and **explicitly kept out of the
  LLM-visible stdout/stderr** — the model must only see Python output. Don't
  blur this boundary.
- `filterPyodideNoise` drops redundant `Loaded X` confirmations (Pyodide emits
  both `Loading X` and `Loaded X`).
- **Python network is gated by `--allow-net`.** Two layers again: (1) the
  default `deno task start` grants only
  `--allow-net=api.openai.com,cdn.jsdelivr.net` (enough for the agent loop +
  Pyodide wheel auto-loading); (2) `pyodide-http` is only added to
  `ALWAYS_LOADED` when `--allow-net` is passed to `main.ts`.
  `deno task start:net` wires both. Without the flag, an `import requests`
  succeeds (Pyodide auto-loads the wheel from CDN), but
  `requests.get("https://whatever")` fails at Deno's fetch layer with a clean
  `ConnectionError: Requires net access to "whatever:443"`. If you add the flag
  on its own (without broad Deno net), `main.ts` uses
  `Deno.permissions.query({ name: "net" })` to detect the mismatch and emits a
  `[pyodide] WARNING`. `urllib.request.urlopen` never works — stdlib socket
  can't do real TCP from WASM.
- **Host process execution has three layers:**
  1. **Worker permissions (primary).** By default the Pyodide worker gets a much
     narrower Deno permission profile than `main.ts`: no env, no run, no ffi, no
     sys, filesystem limited to the Pyodide cache plus optional `--mount-dir`.
  2. **Restricted JS globals (UX guard, not a boundary).** `loadPyodide({ jsglobals })`
     is passed a curated object instead of `globalThis`, so `from js import Deno`
     fails with a clear error. It does **not** stop a determined caller:
     `console.constructor.constructor("return Deno")()` reaches the worker's real
     `Deno` (and `Object`/`Function`) in every mode — pinned by a test in
     `security.test.ts`. What that `Deno` can actually do is bounded only by
     layer 1. With `--allow-net` the curated object also carries the Fetch API
     (`NET_JSGLOBALS`), which `pyfetch` needs and which adds no capability beyond
     the worker's `net` permission.
  3. **Python-level `HOST_EXEC_BLOCKER`** in `pyodide-worker.ts` — replaces
     `os.system`/`os.popen`/`os.exec*`/`os.spawn*`/`subprocess.*`/`ctypes.CDLL(None)`
     with stubs raising `PermissionError`. Toggled off by `--allow-host-exec`
     (CLI flag → `InitOpts.allowHostExec` → `buildSystemPrompt`). Serves as
     defense-in-depth and a clearer error message than the worker permission
     failure. `deno task start:unsafe` passes `--allow-all` AND
     `--allow-host-exec`; in that mode the worker intentionally inherits process
     permissions and the Python blocker is removed. Keep both the worker
     isolation and the Python blocker — removing either weakens safety or error
     UX.

     Known gaps in the blocker (intentional — the real boundary is the worker
     permission profile, not this list):
     - `os.fork()` is not patched (unsupported in WASM anyway, but not blocked by name)
     - `multiprocessing` module is not patched (also fails at WASM level)
     - `ctypes.CDLL(path)` with a concrete path is allowed; only `CDLL(None)`
       (libc shortcut) is blocked — the worker's `--allow-ffi=false` is the real
       guard against FFI escapes
- **This is a real sandbox, not a blocklist.** Historical context: earlier the
  project ran on Node, where Pyodide is explicitly _not_ sandboxed
  ([GSOC 2023 wiki](https://github.com/pyodide/pyodide/wiki/GSOC-2023); see also
  n8n CVE-2025-68668, Grist Cellbreak). The worker permission model
  (layer 1) is what replaces that gap; the restricted JS globals only make
  accidents obvious. Don't relax `--allow-*` flags
  in tasks without thinking through what Python gains.
- `--mount-dir` is the only way to expose host files; when active, `/host/`
  inside Python is read-write on the real filesystem (via `pyodide.mountNodeFS`
  — works under Deno 2.7+ despite the historical `node:fs` compat issues in
  older Deno). Requires `--allow-read --allow-write` on the mount path; the
  default task grants them broadly, `start:strict` does not and would need to be
  narrowed per-run.

## Docker build nuance

`Dockerfile` is a two-stage build on `denoland/deno:alpine`. Stage 1 runs
`deno cache src/main.ts` to populate `DENO_DIR`, then `deno eval` to pre-warm
the default Pyodide wheels (`micropip`, `pyodide-http`, `pyyaml`,
`python-dateutil`, plus the `requests` stack: `requests`, `certifi`, `idna`,
`urllib3`, `charset-normalizer`) into that same `DENO_DIR` so the runtime image
is offline-capable on first run even if the user opts into `--allow-net`. Stage
2 copies the warmed cache + `src/` + `deno.json` into a non-root `agent` user's
home and runs `deno task start:docker` as ENTRYPOINT with **the scoped
permission set matching `deno task start`** but without `--env-file`. Worker
permission shaping is enabled repo-locally via `deno.json`
(`"unstable": ["worker-options"]`). Override the entrypoint
(`docker run --entrypoint deno ...`) to get broader perms for
`start:net`/`start:unsafe` equivalents.

`deno eval` runs with implicit full permissions — do NOT pass `--allow-*` to it
(it errors out: _"unexpected argument --allow-env found"_). We deliberately use
`deno run` + source in the image rather than `deno compile`: the compiled binary
also works (verified — ~100 MB, Pyodide boots fine), but `deno run` plays nicer
with `DENO_DIR` caching of runtime-downloaded wheels (e.g. `numpy` when the user
passes `--packages numpy,pandas`). If the default package set changes, update
the `deno eval` pre-warm block to match `DEFAULT_PACKAGE_SPEC` +
`ALWAYS_LOADED_BASE`/`NET_PACKAGES` in `pyodide-runtime.ts`.

## Conventions

- TypeScript strict mode, ESM only. Imports use **explicit `.ts` extensions** on
  relative paths — Deno requires them (no loader rewriting). npm packages come
  in via the `imports` map in `deno.json` (`"openai": "npm:openai@..."`), not
  via `package.json`.
- No structured logging library — user-facing output is written directly to
  `stdout`/`stderr` in `main.ts` via `stdoutWrite`/`stderrWrite` helpers with
  semantic prefixes (`›`, `⚙`, `↩`, `✗`, `[pyodide]`). If you need diagnostics,
  prefer extending that scheme over reintroducing a logger.
- Permissions are granted at the `deno run` command line (tasks in `deno.json`),
  not via runtime `Deno.permissions.request()`. When adding a new capability,
  update both the relevant task entry and the "Sandbox boundaries" section of
  README.
- `dedupeRepeatedContent` in `agent.ts` works around certain OpenAI-compatible
  endpoints that occasionally duplicate message content; keep it unless you
  verify all supported providers have stopped doing this.
