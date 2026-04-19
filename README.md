# pyodide-agent

A minimal LLM agent. One tool: `execute_code`. The tool runs Python inside an
in-process [Pyodide](https://pyodide.org) runtime — everything happens in a
single Deno app, but the Python runtime itself lives inside a dedicated Deno
worker with its own permission profile. No Python subprocess, no remote
workspace.

The agent speaks any OpenAI-compatible Chat Completions API via the official
`openai` SDK: real OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, etc.

Runs under [Deno](https://deno.com) so that OS-level permissions can actually
isolate what Python reaches — the Pyodide team
[notes](https://github.com/pyodide/pyodide/wiki/GSOC-2023) that Pyodide itself
is not a security sandbox; Deno's permission system provides that boundary.

## Install

```bash
brew install deno                    # or: curl -fsSL https://deno.land/install.sh | sh
cp .env.example .env                 # fill in OPENAI_API_KEY (and MODEL)
```

No `npm install` step — Deno fetches npm/JSR dependencies on first run.

## Run

```bash
deno task start                             # interactive REPL
deno task start "what is 17 * 23?"          # one-shot, answer on stdout
deno task start --verbose "summarize: …"    # also stream tool calls to stderr
deno task start --json "pi to 8 digits"     # JSON payload to stdout
echo "list primes under 30" | deno task start -

deno task start --mount-dir ~/notes \
    "summarize the newest markdown file"    # expose ~/notes at /host (read-write)
```

### Task variants

Default task is **network-off** for Python: the agent itself reaches the OpenAI
API and pulls Pyodide wheels from the CDN, but Python code can't hit arbitrary
URLs. Opt in via `start:net`.

| Task                     | Python network                                                               | Python host exec                            | When to use                                                                        |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `deno task start`        | **off** (scoped to `api.openai.com,cdn.jsdelivr.net` at the Deno layer)      | blocked                                     | Default — worker denies direct host API access and only mounts files you opt into. |
| `deno task start:docker` | same as `start`, but without `--env-file` and with an absolute in-image path | blocked                                     | Used by the Docker image entrypoint.                                               |
| `deno task start:net`    | on (broad `--allow-net` + loads `ssl` + `pyodide-http`)                      | blocked                                     | When the task genuinely needs HTTP/HTTPS from Python.                              |
| `deno task start:unsafe` | on                                                                           | `os.system` / `ctypes` reach the real shell | Only on a machine you own.                                                         |

`deno task compile` produces a standalone `./pyodide-agent` binary (~100 MB;
bakes Pyodide + deps + broad permissions, but does **not** embed `.env` values.
Provide runtime env vars externally when you run the binary. The CLI
`--allow-net` / `--allow-host-exec` flags still control what Python actually
gets. `deno task check` runs type-check only.

### REPL commands

`/reset` — forget conversation history and reset the Python `scratchpad`.
`/help`, `/exit`.

## Configuration

All env vars are optional except `OPENAI_API_KEY`. `deno task start` reads them
via `--env-file=.env` automatically.

| Variable           | Default                  | Meaning                                       |
| ------------------ | ------------------------ | --------------------------------------------- |
| `OPENAI_API_KEY`   | —                        | required                                      |
| `MODEL`            | `gpt-4o`                 | Chat model id (whatever your endpoint serves) |
| `OPENAI_BASE_URL`  | OpenAI                   | Any OpenAI-compatible endpoint                |
| `MAX_ITERATIONS`   | `20`                     | Max turns per task                            |
| `PYODIDE_PACKAGES` | `pyyaml,python-dateutil` | Packages to preload (see below)               |

## What ships pre-loaded in Python

Always-on (Python stdlib — no package load):

`json`, `sys`, `os`, `re`, `csv`, `math`, `hashlib`, `base64`, `datetime`,
`timedelta`, `date`, `defaultdict`, `Counter`, `PurePosixPath`. A mutable
`scratchpad = {}` lives in globals as working memory.

Always loaded (regardless of `--packages`):

- **`micropip`** — the agent's escape hatch for PyPI packages not in Pyodide's
  bundle (`await micropip.install('tabulate')` etc).

Loaded only with `--allow-net` (`deno task start:net`):

- **`ssl`** + **`pyodide-http`** — make HTTPS work. `pyodide_http.patch_all()`
  runs at startup so `import requests` goes through `pyfetch` transparently.
  Without `--allow-net` these are skipped and any attempt to reach an arbitrary
  host fails at the Deno permission layer with
  `ConnectionError:
  Requires net access to "<host>:443"`.

**Bundled Pyodide wheels auto-load on import.** Before every `execute_code` call
the runtime runs `pyodide.loadPackagesFromImports(code)`, which scans the Python
source for `import` statements and activates any matching Pyodide- bundled wheel
(`numpy`, `pandas`, `scipy`, `scikit-learn`, `matplotlib`, `sympy`, `pillow`,
`lxml`, `networkx`, and ~90 others). The agent just writes `import numpy as np`
and pays a one-time ~200ms–1.5s activation on first use; everything is cached
for the rest of the session.

The rest depends on `--packages` / `PYODIDE_PACKAGES`:

| Package                       | Python imports                     | Cost                         |
| ----------------------------- | ---------------------------------- | ---------------------------- |
| `pyyaml` _(default)_          | `yaml`                             | negligible                   |
| `python-dateutil` _(default)_ | `dateutil_parser`, `relativedelta` | negligible                   |
| `numpy`                       | `np`                               | +60MB RSS, +0.3s cold start  |
| `pandas`                      | `pd` (also pulls numpy)            | +280MB RSS, +1.3s cold start |
| `scipy`                       | `scipy`                            | ~+60MB                       |

Override per-run: `--packages pyyaml,python-dateutil,numpy,pandas`. Use
`--packages none` to skip user packages (smallest footprint — only the always-on
set: `micropip`, `ssl`, `pyodide-http`).

## Sandbox boundaries

The primary boundary is a dedicated Deno worker with a narrower permission set
than the main CLI process, layered with a restricted Pyodide JS bridge and a
Python-level block as defense-in-depth.

- **Host process execution:** deliberately not granted. The default task
  launches the Pyodide worker without host-exec privileges. On top of that, the
  Python prelude replaces `os.system`, `os.popen`, `os.exec*`, `os.spawn*`,
  `subprocess.*`, and `ctypes.CDLL(None)` with stubs that raise
  `PermissionError`. Pass `--allow-host-exec` to disable the Python stubs and
  let the worker inherit the process permissions, which is exactly what
  `deno task start:unsafe` is for.
- **Host filesystem:** isolated by default (Pyodide's MEMFS). Pass
  `--mount-dir <path>` to expose one host directory at `/host` read-write via
  `pyodide.mountNodeFS`. Python does **not** get raw `Deno` access through the
  JS bridge, so there is no backdoor around this mount.
- **JS bridge:** restricted. Python can use only a curated JS global scope;
  `from js import Deno` and direct environment/file access from Python are
  blocked.
- **Network (from Python):** off by default. The default task grants Deno
  `--allow-net=api.openai.com,cdn.jsdelivr.net` — enough for the agent loop and
  Pyodide wheel auto-loading, nothing else. `ssl` and `pyodide-http` are _not_
  loaded in this mode; `requests.get("https://whatever")` fails with
  `ConnectionError: Requires net access to "whatever:443"`. Pass `--allow-net`
  (via `deno task start:net`) to flip on the Python HTTP stack + broad Deno
  `--allow-net`; then `requests` / `pyodide.http.pyfetch` work normally.
  `urllib.request.urlopen` does **not** work either way — stdlib socket can't do
  real TCP from WASM.
- **Performance:** WASM runtime, CPU-bound code is 2-5× slower than native
  Python.

For untrusted input, still prefer a container on top (image is published by the
`Dockerfile`) or a rootless VM — the worker permissions meaningfully narrow what
Python can reach, but `--mount-dir ~` or `start:unsafe` are still explicit trust
decisions that hand real power to the model.

## License

MIT
