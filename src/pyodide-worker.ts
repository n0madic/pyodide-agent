/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { resolve } from "@std/path";
import pyodideModule from "pyodide/pyodide.js";
import type { PyodideInterface, PyodideConfig } from "pyodide";
import type {
  ExecuteResult,
  WorkerInitPayload,
  WorkerRequest,
  WorkerResponse,
} from "./pyodide-worker-protocol.ts";

const { loadPyodide } = pyodideModule as {
  loadPyodide: (opts?: PyodideConfig) => Promise<PyodideInterface>;
};

// Python gets a curated JS bridge. This intentionally omits `Deno`, `process`,
// and the rest of the host global scope.
const SAFE_JSGLOBALS = Object.freeze({
  console,
});

// Python-level hardening applied when host exec is NOT allowed.
//
// IMPORTANT: this is best-effort UX hardening, not the primary sandbox. The
// real boundary is the worker's Deno permission profile plus the restricted
// JS globals passed to Pyodide.
const HOST_EXEC_BLOCKER = `
def _pyodide_agent_apply_sandbox():
    import os as _os
    import subprocess as _sub

    _MSG = (
        "Host process execution is disabled in this sandbox. "
        "Start the agent with --allow-host-exec to enable it."
    )

    def _blocked(*_a, **_kw):
        raise PermissionError(_MSG)

    for _name in (
        "system", "popen",
        "execv", "execve", "execvp", "execvpe",
        "execl", "execle", "execlp", "execlpe",
        "spawnv", "spawnve", "spawnvp", "spawnvpe",
        "spawnl", "spawnle", "spawnlp", "spawnlpe",
        "posix_spawn", "posix_spawnp",
    ):
        if hasattr(_os, _name):
            setattr(_os, _name, _blocked)

    for _name in (
        "run", "call", "check_call", "check_output",
        "getoutput", "getstatusoutput",
    ):
        if hasattr(_sub, _name):
            setattr(_sub, _name, _blocked)

    class _BlockedPopen:
        def __init__(self, *_a, **_kw):
            raise PermissionError(_MSG)
    _sub.Popen = _BlockedPopen

    try:
        import ctypes as _ctypes
        _real_CDLL = _ctypes.CDLL
        class _SafeCDLL(_real_CDLL):
            def __init__(self, name, *a, **kw):
                if name is None:
                    raise PermissionError(
                        "ctypes.CDLL(None) is disabled (would expose host "
                        "libc). Start the agent with --allow-host-exec to enable."
                    )
                super().__init__(name, *a, **kw)
        _ctypes.CDLL = _SafeCDLL
    except ImportError:
        pass

_pyodide_agent_apply_sandbox()
del _pyodide_agent_apply_sandbox
`;

let pyodide: PyodideInterface | null = null;
let stdoutBuf = "";
let stderrBuf = "";

function postMessageToParent(message: WorkerResponse): void {
  globalThis.postMessage(message);
}

function sendStatus(requestId: string, message: string): void {
  postMessageToParent({ kind: "status", requestId, message });
}

function filterPyodideNoise(raw: (msg: string) => void): (msg: string) => void {
  return (msg) => {
    if (/^Loaded\s/.test(msg)) return;
    raw(msg);
  };
}

async function initPyodideInternal(
  payload: WorkerInitPayload,
  requestId: string,
): Promise<void> {
  if (pyodide) return;

  const status = filterPyodideNoise((msg) => sendStatus(requestId, msg));

  status("loading pyodide…");
  pyodide = await loadPyodide({
    jsglobals: SAFE_JSGLOBALS,
    packageCacheDir: payload.packageCacheDir,
  });

  pyodide.setStdout({
    batched: (line: string) => {
      stdoutBuf += line + "\n";
    },
  });
  pyodide.setStderr({
    batched: (line: string) => {
      stderrBuf += line + "\n";
    },
  });

  if (payload.packages.loadList.length > 0) {
    await pyodide.loadPackage([...payload.packages.loadList], {
      messageCallback: status,
      errorCallback: status,
    });
  }

  await pyodide.runPythonAsync(payload.packages.preludeCode);

  if (!payload.allowHostExec) {
    await pyodide.runPythonAsync(HOST_EXEC_BLOCKER);
  }

  if (payload.mountDir) {
    const absolute = resolve(payload.mountDir);
    let statResult: Deno.FileInfo;
    try {
      statResult = await Deno.stat(absolute);
    } catch (err) {
      throw new Error(
        `--mount-dir: cannot access ${absolute}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!statResult.isDirectory) {
      throw new Error(`--mount-dir: ${absolute} is not a directory`);
    }
    status(`mounting ${absolute} → /host`);
    pyodide.mountNodeFS("/host", absolute);
  }
}

async function executeCodeInternal(
  code: string,
  requestId: string,
): Promise<ExecuteResult> {
  if (!pyodide) {
    throw new Error("Pyodide not initialized — call initPyodide() first");
  }

  stdoutBuf = "";
  stderrBuf = "";
  const started = Date.now();
  let ok = true;

  try {
    const pkgCallback = (msg: string) => sendStatus(requestId, msg);
    await pyodide.loadPackagesFromImports(code, {
      messageCallback: pkgCallback,
      errorCallback: pkgCallback,
    });
    await pyodide.runPythonAsync(code);
  } catch (err) {
    ok = false;
    const msg = err instanceof Error ? err.message : String(err);
    stderrBuf += (stderrBuf.endsWith("\n") || stderrBuf === "" ? "" : "\n") +
      msg;
  }

  return {
    stdout: stdoutBuf.trimEnd(),
    stderr: stderrBuf.trimEnd(),
    ok,
    durationMs: Date.now() - started,
  };
}

async function resetScratchpadInternal(): Promise<void> {
  if (!pyodide) return;
  await pyodide.runPythonAsync("scratchpad = {}");
}

globalThis.addEventListener(
  "message",
  async (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;

    try {
      switch (request.kind) {
        case "init":
          await initPyodideInternal(request.payload, request.requestId);
          postMessageToParent({
            kind: "result",
            requestId: request.requestId,
            payload: null,
          });
          break;
        case "execute":
          postMessageToParent({
            kind: "result",
            requestId: request.requestId,
            payload: await executeCodeInternal(request.code, request.requestId),
          });
          break;
        case "reset_scratchpad":
          await resetScratchpadInternal();
          postMessageToParent({
            kind: "result",
            requestId: request.requestId,
            payload: null,
          });
          break;
      }
    } catch (err) {
      postMessageToParent({
        kind: "error",
        requestId: request.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
