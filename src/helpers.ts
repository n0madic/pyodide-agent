// ── Helper registry (single source of truth for the pre-loaded Python helpers) ─
//
// Mirrors PACKAGE_REGISTRY: one entry per helper, and everything else —
// the Python prelude, the system-prompt section — is generated from it. A
// helper that is unavailable in the current mode is neither defined in Python
// nor mentioned anywhere in the prompt.
//
// To add a helper: implement it in helpers-python.ts (and list it in that
// source's `__all__`), then add its entry below. Do not edit the prompt by hand.

import { CORE_PY, FS_PY, NET_PY } from "./helpers-python.ts";

/**
 * Name of the Python module holding the helpers. Deliberately not the generic
 * "helpers": a mounted project with its own helpers.py would otherwise be
 * shadowed by (or shadow) it.
 */
export const HELPER_MODULE = "agent_helpers";

export interface HelperEnv {
  /** Python may reach the network (`--allow-net`). */
  readonly allowNet: boolean;
  /** A host directory is mounted at /host (`--mount-dir`). */
  readonly hasMount: boolean;
}

type HelperGroupId = "core" | "fs" | "net";

interface HelperGroup {
  readonly source: string;
  readonly available: (env: HelperEnv) => boolean;
}

// Order matters: sources are exec'd in this order into one namespace and the
// later ones use private names defined by CORE_PY.
const HELPER_GROUPS: Record<HelperGroupId, HelperGroup> = {
  core: { source: CORE_PY, available: () => true },
  // File helpers always work: without a mount they use the sandbox's own
  // in-memory filesystem, with a mount they also reach /host.
  fs: { source: FS_PY, available: () => true },
  net: { source: NET_PY, available: (env) => env.allowNet },
};

export interface HelperSpec {
  readonly name: string;
  readonly group: HelperGroupId;
  /** Call signature as shown to the model. */
  readonly signature: string;
  /** One-line description. */
  readonly doc: string;
}

export const HELPER_REGISTRY: readonly HelperSpec[] = [
  {
    name: "fetch",
    group: "net",
    signature:
      'await fetch(url, as_="json", method=None, headers=None, json=None, data=None, timeout=20, retries=2)',
    doc:
      'HTTP request with retries (429/5xx/network, backoff), status check and body parsing; `as_` is "json" | "text" | "bytes" | "md" (HTML → Markdown). ' +
      "`json=` sends a JSON body, `data=` a form/str/bytes (method defaults to GET, or POST with a body); POST/PATCH are never retried on 5xx or network errors. " +
      "Non-2xx raises `HelperError` with the status and the start of the body",
  },
  {
    name: "fetch_many",
    group: "net",
    signature: 'await fetch_many(items, as_="json", limit=5)',
    doc:
      "fetch many URLs (or `{\"url\": ..., **fetch kwargs}` dicts) concurrently; returns `[{url, ok, data | error}]` " +
      "in input order — one failure never aborts the rest",
  },
  {
    name: "html_to_md",
    group: "net",
    signature: 'html_to_md(html, base_url="")',
    doc:
      "HTML → readable Markdown (drops scripts/styles, keeps headings, lists, tables, links)",
  },
  {
    name: "html_links",
    group: "net",
    signature: 'html_links(html, base_url="")',
    doc: "`[{url, text}]` — absolute, de-duplicated links of an HTML page",
  },
  {
    name: "load",
    group: "fs",
    signature: "load(path, df=False)",
    doc:
      "read a file by extension: json/jsonl/yaml → objects, csv/tsv → list of dicts (string values), text files → str, binary files → bytes; " +
      "`df=True` → pandas DataFrame (run `import pandas` first)",
  },
  {
    name: "save",
    group: "fs",
    signature: "save(obj, path, overwrite=False)",
    doc:
      "write by extension (json/jsonl/csv/tsv/yaml; str/bytes as-is), creates parent dirs; " +
      'returns `{"path", "bytes", "existed"}`; `overwrite=True` is only needed to replace user files that pre-date the session',
  },
  {
    name: "files",
    group: "fs",
    signature: 'files(root, pattern="**/*", max=500)',
    doc: "`[{path, size}]` of the files under `root` whose path relative to `root` matches the glob `pattern`",
  },
  {
    name: "grep",
    group: "fs",
    signature: 'grep(pattern, root, glob="**/*", max=100, context=0)',
    doc:
      "regex search in text files under `root` (or in one file); `[{path, line, text}]`, plus `before`/`after` lines when `context` > 0",
  },
  {
    name: "peek",
    group: "core",
    signature: "peek(obj, n=5)",
    doc:
      "print a compact description of any object: keys, types, lengths, DataFrame shape/dtypes, the first `n` items",
  },
  {
    name: "emit",
    group: "core",
    signature: "emit(x, limit=4000)",
    doc:
      "print `x` compactly (list of dicts → table, DataFrame → text table, other → JSON); output beyond `limit` characters is cut and marked",
  },
  {
    name: "step",
    group: "core",
    signature: 'with step("name", on_error="continue"):',
    doc:
      'run one stage of a script; prints `✓ name (0.3s)` or `✗ name: Error: message (line N)`. ' +
      '`"continue"` (default) lets the script go on; `"raise"` re-raises',
  },
  {
    name: "check",
    group: "core",
    signature: "check(cond, msg)",
    doc: "print `CHECK ✓/✗ msg` and return `bool(cond)`; never raises",
  },
  {
    name: "parallel",
    group: "core",
    signature: "await parallel(coros, limit=5)",
    doc:
      "run coroutines concurrently (at most `limit` at once); results keep input order",
  },
];

export interface HelperResolution {
  /** Names of the helpers defined in Python for this run. */
  readonly names: readonly string[];
  /** Python source that defines the helpers; runs once at startup. */
  readonly preludeCode: string;
  /** One markdown-ready line (without bullet) per available helper. */
  readonly promptLines: readonly string[];
  /** Which filesystem the file helpers act on, phrased for the prompt. */
  readonly fsNote: string;
  /** Which worked example the system prompt should show. */
  readonly exampleKind: "net" | "files";
}

const GROUP_ORDER: readonly HelperGroupId[] = ["core", "fs", "net"];

/**
 * Build the Python prelude and prompt material for the helpers available in
 * the given mode.
 */
export function resolveHelpers(env: HelperEnv): HelperResolution {
  const groups = GROUP_ORDER.filter((id) => HELPER_GROUPS[id].available(env));
  const specs = HELPER_REGISTRY.filter((h) => groups.includes(h.group));

  // The loader runs inside a function so no `_` temporaries leak into the
  // user's globals; only names listed in the module's `__all__` are copied.
  const sources = groups.map((id) => HELPER_GROUPS[id].source).join("\n");
  const preludeCode = [
    "def _pyodide_agent_install_helpers():",
    "    import sys, types",
    `    m = types.ModuleType(${JSON.stringify(HELPER_MODULE)})`,
    '    m.__dict__["__all__"] = []',
    `    exec(compile(${JSON.stringify(sources)}, "<helpers>", "exec"), m.__dict__)`,
    `    sys.modules[${JSON.stringify(HELPER_MODULE)}] = m`,
    "    return {k: getattr(m, k) for k in m.__all__}",
    "",
    "globals().update(_pyodide_agent_install_helpers())",
    "del _pyodide_agent_install_helpers",
  ].join("\n");

  const fsNote = env.hasMount
    ? "`load`/`save`/`files`/`grep` work on any path: `/host` is the user's mounted directory " +
      "(real files, persistent) and `save` refuses to replace a `/host` file that existed before this " +
      "session unless `overwrite=True`; everything else is the sandbox's in-memory filesystem " +
      "(e.g. `/tmp`), which disappears when the session ends"
    : "`load`/`save`/`files`/`grep` work on the sandbox's in-memory filesystem (e.g. `/tmp`), " +
      "which disappears when the session ends; there are no pre-existing user files to read";

  return {
    names: specs.map((h) => h.name),
    preludeCode,
    promptLines: specs.map((h) => `\`${h.signature}\` — ${h.doc}`),
    fsNote,
    exampleKind: env.allowNet ? "net" : "files",
  };
}
