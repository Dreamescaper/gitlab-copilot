/**
 * Session hook and event-listener helpers for Copilot SDK sessions.
 */

/**
 * Accumulated token/cost usage metrics for a session.
 */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalModelMultiplier: number;
  requestCount: number;
  firstUsedRequests?: number;
  lastUsedRequests?: number;
}

/**
 * Truncate a string to a maximum length, appending "…" if truncated.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function toLogString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Return hooks for createSession that log every tool call to the console.
 * Tool result logging is handled by session event listeners.
 */
export function buildSessionHooks() {
  return {
    onPreToolUse: async (input: { toolName: string; toolArgs: unknown }) => {
      const argsStr = truncate(JSON.stringify(input.toolArgs), 300);
      console.log(`[copilot] ▶ tool: ${input.toolName}  args: ${argsStr}`);
      return { permissionDecision: "allow" as const };
    },
  };
}

/**
 * Attach session event listeners for streaming progress visibility.
 * Returns a cleanup function and accumulated usage statistics.
 */
export function attachSessionListeners(session: { on: Function }, logLevel: string): {
  detach: () => void;
  getUsage: () => UsageStats;
} {
  const isDebug = logLevel === "debug";
  const unsubscribers: Array<() => void> = [];
  const activeToolCalls = new Map<string, { toolName: string; startedAtMs: number }>();
  let wroteAssistantMessageDelta = false;

  const usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalModelMultiplier: 0,
    requestCount: 0,
  };

  unsubscribers.push(
    session.on("assistant.usage", (event: {
      data: {
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        quotaSnapshots?: {
          usedRequests?: number;
        };
        cost?: number;
      };
    }) => {
      usage.inputTokens += event.data.inputTokens ?? 0;
      usage.outputTokens += event.data.outputTokens ?? 0;
      usage.cacheReadTokens += event.data.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.data.cacheWriteTokens ?? 0;
      usage.totalModelMultiplier += event.data.cost ?? 0;

      const usedRequests = event.data.quotaSnapshots?.usedRequests;
      if (usedRequests !== undefined) {
        if (usage.firstUsedRequests === undefined) {
          usage.firstUsedRequests = usedRequests;
        }
        usage.lastUsedRequests = usedRequests;
      }

      usage.requestCount++;

      if (isDebug) {
        console.log(
          `[copilot] usage: +${event.data.inputTokens ?? 0} in, +${event.data.outputTokens ?? 0} out, ` +
          `multiplier: ${event.data.cost?.toFixed(4) ?? "N/A"}, ` +
          `quotaSnapshots.usedRequests: ${usedRequests ?? "N/A"} (model: ${event.data.model})`,
        );
      }
    }),
  );

  if (isDebug) {
    unsubscribers.push(
      session.on("assistant.reasoning_delta", (event: { data: { deltaContent: string } }) => {
        process.stderr.write(event.data.deltaContent);
      }),
    );

    unsubscribers.push(
      session.on("assistant.message_delta", (event: { data: { deltaContent: string } }) => {
        wroteAssistantMessageDelta = true;
        process.stdout.write(event.data.deltaContent);
      }),
    );

    unsubscribers.push(
      session.on("assistant.turn_end", () => {
        if (wroteAssistantMessageDelta) {
          process.stdout.write("\n");
          wroteAssistantMessageDelta = false;
        }
      }),
    );
  }

  unsubscribers.push(
    session.on("session.error", (event: { data: { message: string } }) => {
      console.error(`[copilot] ✖ error: ${event.data.message}`);
    }),
  );

  if (isDebug) {
    unsubscribers.push(
      session.on("tool.execution_start", (event: {
        timestamp: string;
        data: { toolCallId: string; toolName: string };
      }) => {
        const startedAtMs = Date.parse(event.timestamp);
        activeToolCalls.set(event.data.toolCallId, {
          toolName: event.data.toolName,
          startedAtMs: Number.isNaN(startedAtMs) ? Date.now() : startedAtMs,
        });
      }),
    );

    unsubscribers.push(
      session.on("tool.execution_complete", (event: {
        timestamp: string;
        data: {
          toolCallId: string;
          result?: unknown;
          error?: { message: string };
          success: boolean;
        };
      }) => {
        const started = activeToolCalls.get(event.data.toolCallId);
        if (started) {
          activeToolCalls.delete(event.data.toolCallId);
        }

        const finishedAtMs = Date.parse(event.timestamp);
        const finished = Number.isNaN(finishedAtMs) ? Date.now() : finishedAtMs;
        const elapsedMs = started ? Math.max(0, finished - started.startedAtMs) : undefined;

        const toolName = started?.toolName ?? `toolCall:${event.data.toolCallId}`;
        const timing = elapsedMs !== undefined ? `, ${elapsedMs}ms` : "";
        const resultPayload = event.data.success
          ? event.data.result
          : (event.data.error?.message ?? event.data.result ?? "Tool execution failed");
        const resultStr = truncate(toLogString(resultPayload), 500);

        console.log(`[copilot] ◀ result (${toolName}${timing}): ${resultStr}`);
      }),
    );
  }

  unsubscribers.push(
    session.on("session.idle", () => {
      console.log(`[copilot] session idle`);
    }),
  );

  return {
    detach: () => {
      for (const unsub of unsubscribers) {
        try { unsub(); } catch { /* ignore */ }
      }
      activeToolCalls.clear();
    },
    getUsage: () => usage,
  };
}