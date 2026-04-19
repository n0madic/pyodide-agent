// ── Package registry (single source of truth) ─────────────────────────────
//
// For each Pyodide package we support "first-class", list the Python statements
// to add to the prelude and the bullet text for the system prompt. Packages not
// listed here can still be loaded via --packages — they'll be passed to
// loadPackage() but won't get an automatic import, and the system prompt will
// note them as available-but-not-imported.

interface PackageSpec {
  readonly imports: readonly string[];
  readonly bullet: string;
}

const PACKAGE_REGISTRY: Record<string, PackageSpec> = {
  micropip: {
    imports: [], // imported on demand by the agent — keeps startup cheap
    bullet: "`micropip` — call `await micropip.install('pkg')` to fetch " +
      "more Pyodide wheels or pure-Python PyPI packages at runtime",
  },
  ssl: {
    // stdlib `ssl` is available; no auto-import needed (imported on demand).
    imports: [],
    bullet: "`ssl` (stdlib) — TLS primitives + enables HTTPS for `requests`",
  },
  "pyodide-http": {
    // Monkey-patches `requests` (and `urllib`/`http.client` in browser contexts)
    // to route through `pyfetch`, so HTTPS calls actually work from WASM.
    imports: ["import pyodide_http", "pyodide_http.patch_all()"],
    bullet:
      "`requests` HTTPS works out of the box — `pyodide_http.patch_all()` is " +
      "pre-applied, routing it through `pyfetch`",
  },
  pyyaml: {
    imports: ["import yaml"],
    bullet: "`yaml`",
  },
  "python-dateutil": {
    imports: [
      "from dateutil import parser as dateutil_parser",
      "from dateutil.relativedelta import relativedelta",
    ],
    bullet:
      "`dateutil_parser` (aliased from `dateutil.parser`), `relativedelta`",
  },
  numpy: {
    imports: ["import numpy as np"],
    bullet: "`numpy as np`",
  },
  pandas: {
    imports: ["import pandas as pd"],
    bullet: "`pandas as pd`",
  },
  scipy: {
    imports: ["import scipy"],
    bullet: "`scipy`",
  },
};

const BASE_PRELUDE_LINES = [
  "import json, sys, os, re, csv, math, hashlib, base64",
  "from datetime import datetime, timedelta, date",
  "from collections import defaultdict, Counter",
  "from pathlib import PurePosixPath",
];

const BASE_PROMPT_BULLETS = [
  "`json`, `sys`, `os`, `re`, `csv`, `math`, `hashlib`, `base64`",
  "`datetime`, `timedelta`, `date` from `datetime`",
  "`defaultdict`, `Counter` from `collections`",
  "`PurePosixPath` from `pathlib`",
];

const SCRATCHPAD_BULLET =
  "`scratchpad` — persistent dict you can use as working memory across calls";

export const DEFAULT_PACKAGE_SPEC = "pyyaml,python-dateutil";

// Unconditional preload (regardless of user spec, regardless of --allow-net):
//   - micropip: escape hatch for arbitrary PyPI packages at runtime
const ALWAYS_LOADED_BASE = ["micropip"] as const;

// Loaded only when network is enabled (--allow-net):
//   - ssl: stdlib TLS primitives
//   - pyodide-http: monkey-patches `requests` to route through `pyfetch` so HTTPS
//     actually works from WASM. Loading this module without net permission would
//     just produce misleading errors — `requests.get` would reach Deno's fetch
//     and be denied at the OS permission layer.
const NET_PACKAGES = ["ssl", "pyodide-http"] as const;

export interface PackageResolution {
  /** Packages to hand to `pyodide.loadPackage()`. */
  readonly loadList: readonly string[];
  /** Python source that runs at startup after packages are loaded. */
  readonly preludeCode: string;
  /** Bullets to embed in the system prompt's "Pre-loaded" section. */
  readonly promptBullets: readonly string[];
}

/**
 * Parse a spec string (CLI `--packages` value or `PYODIDE_PACKAGES` env var)
 * and expand it into a PackageResolution. Accepts:
 *  - `undefined` / unset → defaults to DEFAULT_PACKAGE_SPEC
 *  - empty string / "none" → bare Python, no packages loaded
 *  - comma-separated list (e.g. `"pyyaml,numpy,pandas"`)
 *
 * `allowNet` adds the `ssl` + `pyodide-http` pair so HTTPS works from Python;
 * when false those are skipped and Python effectively has no network.
 */
export function resolvePackages(
  spec: string | undefined,
  allowNet: boolean,
): PackageResolution {
  const source = spec ?? DEFAULT_PACKAGE_SPEC;
  const trimmed = source.trim();
  const userList = trimmed === "" || trimmed.toLowerCase() === "none"
    ? []
    : trimmed
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

  const alwaysLoaded = allowNet
    ? [...ALWAYS_LOADED_BASE, ...NET_PACKAGES]
    : [...ALWAYS_LOADED_BASE];

  // Prepend the always-loaded set, dedupe while preserving first-occurrence order.
  const seen = new Set<string>();
  const loadList: string[] = [];
  for (const pkg of [...alwaysLoaded, ...userList]) {
    if (!seen.has(pkg)) {
      seen.add(pkg);
      loadList.push(pkg);
    }
  }

  const extraPrelude: string[] = [];
  const knownBullets: string[] = [];
  const unknown: string[] = [];

  for (const pkg of loadList) {
    const pkgSpec = PACKAGE_REGISTRY[pkg];
    if (pkgSpec) {
      extraPrelude.push(...pkgSpec.imports);
      knownBullets.push(pkgSpec.bullet);
    } else {
      unknown.push(pkg);
    }
  }

  const preludeCode = [
    ...BASE_PRELUDE_LINES,
    ...extraPrelude,
    "",
    "scratchpad = {}",
  ].join("\n");

  const promptBullets = [...BASE_PROMPT_BULLETS, ...knownBullets];
  if (unknown.length > 0) {
    promptBullets.push(
      `additional Pyodide packages loaded (import as needed): ${
        unknown.join(", ")
      }`,
    );
  }
  promptBullets.push(SCRATCHPAD_BULLET);

  return { loadList, preludeCode, promptBullets };
}
