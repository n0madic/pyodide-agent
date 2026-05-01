import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { AgentEvent } from "./agent.ts";

// markedTerminal() is the modern extension entry point; it returns a marked
// extension object that's compatible with marked v14's strict renderer
// validation. The legacy `new TerminalRenderer()` + `marked.use({ renderer })`
// path trips marked v14 because TerminalRenderer carries non-method props
// (o, tab, textLength, …) which marked's for-in loop rejects.
const markedInstance = new Marked();
markedInstance.use(markedTerminal());

export function renderMarkdown(text: string): string {
  const result = markedInstance.parse(text);
  // parse() is synchronous with a non-async renderer, but its TS return type
  // is string | Promise<string>; guard just in case.
  if (typeof result !== "string") return text;
  return result;
}

export function formatToolCall(code: string, maxLines = 20): string {
  const lines = code.split("\n");
  if (lines.length <= maxLines) return code;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n… (+${lines.length - maxLines} more lines)`
  );
}

export interface RenderOpts {
  markdown?: boolean;
}

export function renderEvent(
  event: AgentEvent,
  opts: RenderOpts = {},
): string | null {
  const useMd = opts.markdown ?? true;
  switch (event.kind) {
    case "text":
      return useMd ? renderMarkdown(event.text) : `› ${event.text}\n`;
    case "tool_call":
      return `\n⚙ python>\n${formatToolCall(event.code)}\n`;
    case "tool_result": {
      const tag = event.ok ? "↩" : "✗";
      return `${tag} (${event.durationMs}ms)\n${event.content}\n\n`;
    }
    case "api_call":
      return null;
  }
}
