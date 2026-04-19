import type OpenAI from "openai";

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "execute_code",
      description:
        "Run Python 3 code in a persistent Pyodide (WebAssembly) runtime. Emit output via print(). " +
        "Variables you define and the `scratchpad` dict persist between calls within a session. " +
        "Host process execution (os.system, subprocess, ctypes.CDLL(None)) raises PermissionError " +
        "unless the user started the agent with --allow-host-exec. " +
        "Python does not get direct access to Deno/host APIs through the JS bridge. " +
        "Host filesystem is isolated unless the user passes --mount-dir <path>, exposing it at /host. " +
        "HTTP/HTTPS is available when the agent is started with --allow-net: use `requests` or `pyodide.http.pyfetch`; `urllib.request` does not work in any mode.",
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
