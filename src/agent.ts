import type OpenAI from "openai";
import { TOOLS } from "./tool-defs.ts";
import { executeCode } from "./pyodide-runtime.ts";

// Some OpenAI-compatible endpoints (and certain model versions) occasionally
// return the same text twice in a single message content, separated by one or
// two newlines. Collapse an exact `A<sep>A` pattern to a single copy.
function dedupeRepeatedContent(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 30) return text;
  for (let sepLen = 0; sepLen <= 2; sepLen++) {
    const n = trimmed.length - sepLen;
    if (n <= 20 || n % 2 !== 0) continue;
    const half = n / 2;
    const sep = trimmed.slice(half, half + sepLen);
    if (sepLen > 0 && sep !== "\n".repeat(sepLen)) continue;
    const a = trimmed.slice(0, half);
    const b = trimmed.slice(half + sepLen);
    if (a === b) return a;
  }
  return text;
}

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; code: string }
  | { kind: "tool_result"; ok: boolean; content: string; durationMs: number }
  | { kind: "api_call"; iteration: number; inputTokens: number; outputTokens: number; durationMs: number };

export interface AgentRunResult {
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  finalText: string;
  iterations: number;
  hitMaxIterations: boolean;
  toolCalls: number;
}

export interface RunAgentOpts {
  client: OpenAI;
  model: string;
  systemPrompt: string;
  userMessage: string;
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  maxIterations?: number;
}

export async function* runAgent(
  opts: RunAgentOpts,
): AsyncGenerator<AgentEvent, AgentRunResult> {
  const {
    client,
    model,
    systemPrompt,
    userMessage,
    history,
    maxIterations = 20,
  } = opts;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  let finalText = "";
  let iterations = 0;
  let toolCalls = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations++;
    const started = Date.now();
    const resp = await client.chat.completions.create({
      model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });
    const durationMs = Date.now() - started;

    yield {
      kind: "api_call",
      iteration: i,
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
      durationMs,
    };

    const msg = resp.choices[0]?.message;
    if (!msg) {
      finalText = finalText || "(API returned no choices)";
      yield { kind: "text", text: finalText };
      break;
    }

    if (msg.content) {
      msg.content = dedupeRepeatedContent(msg.content);
    }
    messages.push(msg);

    if (msg.content) {
      finalText = msg.content;
      yield { kind: "text", text: msg.content };
    }

    const toolCallsList = msg.tool_calls ?? [];
    if (toolCallsList.length === 0) {
      return {
        history: messages.slice(1),
        finalText,
        iterations,
        hitMaxIterations: false,
        toolCalls,
      };
    }

    for (const tc of toolCallsList) {
      if (tc.type !== "function") continue;
      if (tc.function.name !== "execute_code") {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Unknown tool: ${tc.function.name}`,
        });
        continue;
      }

      const parseResult = (() => {
        try {
          const parsed = JSON.parse(tc.function.arguments) as { code?: unknown };
          if (typeof parsed.code === "string") return { ok: true as const, code: parsed.code };
          return { ok: false as const, error: 'Invalid tool call: "code" argument is missing or not a string' };
        } catch (err) {
          return { ok: false as const, error: `Invalid tool call arguments (JSON parse failed): ${err instanceof Error ? err.message : String(err)}` };
        }
      })();

      if (!parseResult.ok) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: parseResult.error });
        continue;
      }

      const code = parseResult.code;
      toolCalls++;
      yield { kind: "tool_call", code };
      const r = await executeCode(code);
      const content = [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)";
      yield {
        kind: "tool_result",
        ok: r.ok,
        content,
        durationMs: r.durationMs,
      };
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content,
      });
    }
  }

  return {
    history: messages.slice(1),
    finalText,
    iterations,
    hitMaxIterations: true,
    toolCalls,
  };
}
