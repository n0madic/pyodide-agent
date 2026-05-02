import type OpenAI from "openai";

export interface ToolDefsOpts {
  allowHostExec?: boolean;
  allowNet?: boolean;
  mountDir?: string;
}

function buildExecuteCodeDescription(opts: ToolDefsOpts): string {
  const parts: string[] = [
    "Run Python 3 code in a persistent Pyodide (WebAssembly) runtime. Emit output via print().",
    "Variables you define and the `scratchpad` dict persist between calls within a session.",
    "Top-level `await` is supported.",
    "Direct access to Deno/host APIs through the JS bridge is restricted.",
  ];

  parts.push(
    opts.allowHostExec
      ? "Host process execution is available: os.system, subprocess, and ctypes.CDLL(None) reach the real shell."
      : "Host process execution is disabled: os.system, os.popen, os.exec*, os.spawn*, subprocess.*, and ctypes.CDLL(None) raise PermissionError.",
  );

  parts.push(
    opts.mountDir
      ? `Host directory \`${opts.mountDir}\` is mounted read-write at /host; nothing else on the host filesystem is accessible.`
      : "Host filesystem is not accessible.",
  );

  parts.push(
    opts.allowNet
      ? "HTTP/HTTPS works from Python via `requests` or `pyodide.http.pyfetch`; `urllib.request` does not work in any mode."
      : "Network is disabled: `requests`, `pyfetch`, `urllib`, and `socket` all fail.",
  );

  return parts.join(" ");
}

export function buildTools(
  opts: ToolDefsOpts,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: "execute_code",
        description: buildExecuteCodeDescription(opts),
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "Python 3 code to execute.",
            },
          },
          required: ["code"],
        },
      },
    },
  ];
}
