import type { PackageResolution } from "./pyodide-config.ts";

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  durationMs: number;
}

export interface WorkerInitPayload {
  mountDir?: string;
  packages: PackageResolution;
  allowHostExec?: boolean;
  packageCacheDir: string;
}

export type WorkerRequest =
  | { kind: "init"; requestId: string; payload: WorkerInitPayload }
  | { kind: "execute"; requestId: string; code: string }
  | { kind: "reset_scratchpad"; requestId: string };

export type WorkerResponse =
  | { kind: "status"; requestId: string; message: string }
  | { kind: "result"; requestId: string; payload: ExecuteResult | null }
  | { kind: "error"; requestId: string; message: string };
