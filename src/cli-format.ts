import type { AgentEvent } from "./agent.ts";

export function formatToolCall(code: string, maxLines = 20): string {
  const lines = code.split("\n");
  if (lines.length <= maxLines) return code;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n… (+${lines.length - maxLines} more lines)`
  );
}

export function renderEvent(event: AgentEvent): string | null {
  switch (event.kind) {
    case "text":
      return `› ${event.text}\n`;
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
