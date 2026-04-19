import { dirname, fromFileUrl, resolve } from "@std/path";
import {
  DEFAULT_PACKAGE_SPEC,
  type PackageResolution,
  resolvePackages,
} from "./pyodide-config.ts";
import type {
  ExecuteResult,
  WorkerRequest,
  WorkerResponse,
} from "./pyodide-worker-protocol.ts";

export type { ExecuteResult } from "./pyodide-worker-protocol.ts";
export {
  DEFAULT_PACKAGE_SPEC,
  type PackageResolution,
  resolvePackages,
} from "./pyodide-config.ts";

const PYODIDE_ASSET_ROOT = dirname(
  fromFileUrl(import.meta.resolve("pyodide/pyodide.js")),
);

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  onStatus?: (msg: string) => void;
}

export interface InitOpts {
  mountDir?: string;
  /** Pre-resolved package spec. Defaults to `resolvePackages(undefined, false)`. */
  packages?: PackageResolution;
  onStatus?: (msg: string) => void;
  /**
   * If true, skip the Python-level hardening that blocks `os.system`,
   * `subprocess.*`, and `ctypes.CDLL(None)`. Dangerous — the Python code
   * will have the host-shell access of the worker process.
   */
  allowHostExec?: boolean;
  /**
   * If true, give the worker broad outbound net access. Otherwise the worker
   * is limited to the Pyodide CDN for package/runtime fetching only.
   */
  allowNet?: boolean;
}

let worker: Worker | null = null;
let workerInitialized = false;
let workerInitPromise: Promise<void> | null = null;
let requestCounter = 0;
const pendingRequests = new Map<string, PendingRequest<ExecuteResult | null>>();
let statusCallback: ((msg: string) => void) | null = null;

function makeRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function rejectAllPending(error: Error): void {
  for (const [requestId, pending] of pendingRequests) {
    pendingRequests.delete(requestId);
    pending.reject(error);
  }
}

function installCleanupHandlers(): void {
  globalThis.addEventListener("unload", () => {
    worker?.terminate();
    worker = null;
  }, { once: true });
}

function getWorkerPermissions(opts: InitOpts): Deno.PermissionOptions {
  if (opts.allowHostExec) {
    return "inherit";
  }

  const read = [PYODIDE_ASSET_ROOT];
  const write = [PYODIDE_ASSET_ROOT];

  if (opts.mountDir) {
    const absoluteMount = resolve(opts.mountDir);
    read.push(absoluteMount);
    write.push(absoluteMount);
  }

  return {
    env: false,
    run: false,
    ffi: false,
    sys: false,
    read,
    write,
    net: opts.allowNet ? true : ["cdn.jsdelivr.net"],
    import: ["cdn.jsdelivr.net", "jsr.io"],
  };
}

function ensureWorker(opts: InitOpts): Worker {
  if (worker) return worker;

  const workerOptions = {
    type: "module",
    deno: {
      permissions: getWorkerPermissions(opts),
    },
  } as WorkerOptions & {
    deno: {
      permissions: Deno.PermissionOptions;
    };
  };

  worker = new Worker(
    new URL("./pyodide-worker.ts", import.meta.url).href,
    workerOptions,
  );

  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;

    switch (message.kind) {
      case "status":
        pending.onStatus?.(message.message);
        break;
      case "result":
        pendingRequests.delete(message.requestId);
        pending.resolve(message.payload);
        break;
      case "error":
        pendingRequests.delete(message.requestId);
        pending.reject(new Error(message.message));
        break;
    }
  });

  worker.addEventListener("error", (event) => {
    const error = event.error instanceof Error
      ? event.error
      : new Error(event.message || "Pyodide worker crashed");
    rejectAllPending(error);
  });

  installCleanupHandlers();
  return worker;
}

async function callWorker<T extends ExecuteResult | null>(
  request: WorkerRequest,
  onStatus?: (msg: string) => void,
): Promise<T> {
  const currentWorker = worker;
  if (!currentWorker) {
    throw new Error("Pyodide worker not initialized");
  }

  return await new Promise<T>((resolvePromise, rejectPromise) => {
    pendingRequests.set(request.requestId, {
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
      onStatus,
    });
    currentWorker.postMessage(request);
  });
}

export async function initPyodide(opts: InitOpts = {}): Promise<void> {
  if (workerInitialized) return;
  if (workerInitPromise) return await workerInitPromise;

  statusCallback = opts.onStatus ?? null;

  workerInitPromise = (async () => {
    ensureWorker(opts);

    try {
      await callWorker<null>({
        kind: "init",
        requestId: makeRequestId(),
        payload: {
          ...(opts.mountDir ? { mountDir: opts.mountDir } : {}),
          packages: opts.packages ?? resolvePackages(undefined, false),
          allowHostExec: opts.allowHostExec,
          packageCacheDir: PYODIDE_ASSET_ROOT,
        },
      }, statusCallback ?? undefined);

      workerInitialized = true;
    } catch (err) {
      worker?.terminate();
      worker = null;
      workerInitialized = false;
      // Concurrent callers that are already awaiting workerInitPromise will
      // receive this thrown error. After workerInitPromise is cleared in
      // `finally`, they can retry by calling initPyodide() again.
      throw err;
    } finally {
      workerInitPromise = null;
    }
  })();

  return await workerInitPromise;
}

export async function executeCode(code: string): Promise<ExecuteResult> {
  if (!workerInitialized) {
    throw new Error("Pyodide not initialized — call initPyodide() first");
  }

  return await callWorker<ExecuteResult>({
    kind: "execute",
    requestId: makeRequestId(),
    code,
  }, statusCallback ?? undefined);
}

export async function resetScratchpad(): Promise<void> {
  if (!workerInitialized) return;

  await callWorker<null>({
    kind: "reset_scratchpad",
    requestId: makeRequestId(),
  });
}

export function closePyodide(): void {
  rejectAllPending(new Error("Pyodide worker terminated"));
  worker?.terminate();
  worker = null;
  workerInitialized = false;
  workerInitPromise = null;
  statusCallback = null;
}
