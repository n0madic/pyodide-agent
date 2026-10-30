// Shared test runner: boots the real Pyodide worker in a child `deno run`
// process. A subprocess is required because `deno test` cannot grant the
// worker narrower-than-parent permissions ("Can't escalate parent thread
// permissions").

import { dirname, fromFileUrl, join } from "@std/path";
import type { ExecuteResult } from "../src/pyodide-runtime.ts";

const dec = new TextDecoder();
export const repoRoot = dirname(dirname(fromFileUrl(import.meta.url)));
export const runtimeModuleUrl =
  new URL("../src/pyodide-runtime.ts", import.meta.url).href;
export const helpersModuleUrl =
  new URL("../src/helpers.ts", import.meta.url).href;
export const denoJsonPath = join(repoRoot, "deno.json");
export const mainTsPath = join(repoRoot, "src", "main.ts");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runRuntimeSnippet(
  source: string,
  {
    env,
    netArg = "--allow-net=cdn.jsdelivr.net",
  }: {
    env?: Record<string, string>;
    /** Deno net permission flag for the child process. */
    netArg?: string;
  } = {},
): Promise<RunResult> {
  const tempDir = await Deno.makeTempDir({ prefix: "pyodide-agent-test-" });
  const scriptPath = join(tempDir, "snippet.ts");
  await Deno.writeTextFile(scriptPath, source);

  try {
    const output = await new Deno.Command("deno", {
      args: [
        "run",
        "--config",
        denoJsonPath,
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        netArg,
        "--allow-import=cdn.jsdelivr.net,jsr.io",
        ...(env ? [`--allow-env=${Object.keys(env).join(",")}`] : []),
        scriptPath,
      ],
      cwd: repoRoot,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();

    return {
      code: output.code,
      stdout: dec.decode(output.stdout),
      stderr: dec.decode(output.stderr),
    };
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

export interface PythonRunOpts {
  /** Select the helper set as `resolveHelpers({ allowNet })` would. Unless `realNet`
   *  is set the worker itself gets no broad net, so network helpers need a fake. */
  allowNet?: boolean;
  /** Give the child process and the worker real, broad network access (the
   *  `--allow-net` posture) so the true `pyfetch` path can be exercised. */
  realNet?: boolean;
  /** Mount a host directory at /host. */
  mountDir?: string;
}

const RESULT_MARKER = "@@RESULTS@@";

/** Run Python snippets in order in one fresh Pyodide session. */
export async function runPython(
  codes: string[],
  { allowNet = false, realNet = false, mountDir }: PythonRunOpts = {},
): Promise<ExecuteResult[]> {
  const result = await runRuntimeSnippet(`
    import { closePyodide, initPyodide, executeCode, resolvePackages } from ${
    JSON.stringify(runtimeModuleUrl)
  };
    import { resolveHelpers } from ${JSON.stringify(helpersModuleUrl)};

    await initPyodide({
      ${mountDir ? `mountDir: ${JSON.stringify(mountDir)},` : ""}
      ${realNet ? "allowNet: true, packages: resolvePackages(undefined, true)," : ""}
      helpers: resolveHelpers({ allowNet: ${allowNet || realNet}, hasMount: ${!!mountDir} }),
    });
    const results = [];
    for (const code of ${JSON.stringify(codes)}) {
      results.push(await executeCode(code));
    }
    console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(results));
    closePyodide();
  `, realNet ? { netArg: "--allow-net" } : {});

  if (result.code !== 0) {
    throw new Error(`snippet failed unexpectedly:\n${result.stderr}`);
  }
  const line = result.stdout.split("\n").find((l) =>
    l.startsWith(RESULT_MARKER)
  );
  if (!line) throw new Error(`no result marker in output:\n${result.stdout}`);
  return JSON.parse(line.slice(RESULT_MARKER.length)) as ExecuteResult[];
}

/** Run one snippet, fail loudly (with stderr) if Python raised, return stdout. */
export async function runPythonOk(
  code: string,
  opts: PythonRunOpts = {},
): Promise<string> {
  const [r] = await runPython([code], opts);
  if (!r.ok) {
    throw new Error(`Python failed:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
  return r.stdout;
}
