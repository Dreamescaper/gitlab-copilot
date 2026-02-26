import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type { Config } from "./config.js";
import type {
  MergeRequestDiffVersionDetail,
  ReviewResult,
} from "./types.js";
import { REVIEW_SYSTEM_PROMPT } from "./prompts/review-system.js";
import { COMMENT_REPLY_SYSTEM_PROMPT } from "./prompts/comment-reply-system.js";
import { buildDiffPrompt, buildCommentReplyPrompt } from "./prompts/build-prompts.js";

// ─── Session logging helpers ────────────────────────────────────────────────

/**
 * Truncate a string to a maximum length, appending "…" if truncated.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/**
 * Return hooks for createSession that log every tool call to the console.
 * When LOG_LEVEL=debug, tool results are logged as well (truncated).
 */
function buildSessionHooks(logLevel: string) {
  const isDebug = logLevel === "debug";
  return {
    onPreToolUse: async (input: { toolName: string; toolArgs: unknown }) => {
      const argsStr = truncate(JSON.stringify(input.toolArgs), 300);
      console.log(`[copilot] ▶ tool: ${input.toolName}  args: ${argsStr}`);
      return { permissionDecision: "allow" as const };
    },
    onPostToolUse: async (input: { toolName: string; toolResult: unknown }) => {
      if (isDebug) {
        const resultStr = truncate(JSON.stringify(input.toolResult), 500);
        console.log(`[copilot] ◀ result (${input.toolName}): ${resultStr}`);
      }
    },
  };
}

/**
 * Attach session event listeners for streaming progress visibility.
 * Returns a cleanup function and accumulated usage statistics.
 */
function attachSessionListeners(session: { on: Function }, logLevel: string): {
  detach: () => void;
  getUsage: () => UsageStats;
} {
  const isDebug = logLevel === "debug";
  const unsubscribers: Array<() => void> = [];

  // Track cumulative usage across all API calls in this session
  const usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: 0,
    requestCount: 0,
  };

  // Track usage from each assistant.usage event
  unsubscribers.push(
    session.on("assistant.usage", (event: {
      data: {
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        cost?: number;
      };
    }) => {
      usage.inputTokens += event.data.inputTokens ?? 0;
      usage.outputTokens += event.data.outputTokens ?? 0;
      usage.cacheReadTokens += event.data.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.data.cacheWriteTokens ?? 0;
      usage.totalCost += event.data.cost ?? 0;
      usage.requestCount++;

      if (isDebug) {
        console.log(
          `[copilot] usage: +${event.data.inputTokens ?? 0} in, +${event.data.outputTokens ?? 0} out, ` +
          `cost: ${event.data.cost?.toFixed(4) ?? "N/A"} (model: ${event.data.model})`,
        );
      }
    }),
  );

  // Log reasoning tokens (for models like o1 that expose reasoning)
  if (isDebug) {
    unsubscribers.push(
      session.on("assistant.reasoning_delta", (event: { data: { deltaContent: string } }) => {
        process.stderr.write(event.data.deltaContent);
      }),
    );
  }

  // Log errors
  unsubscribers.push(
    session.on("session.error", (event: { data: { message: string } }) => {
      console.error(`[copilot] ✖ error: ${event.data.message}`);
    }),
  );

  // Log idle state
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
    },
    getUsage: () => usage,
  };
}

interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  requestCount: number;
}

// ─── Project-specific instructions ──────────────────────────────────────────

/**
 * Well-known paths for project-specific review instructions.
 * For each group, the first file found is used (checked in order).
 * Both copilot-instructions.md and agents.md can coexist — if both
 * are present, their contents are combined.
 */
const COPILOT_INSTRUCTIONS_PATHS = [
  ".github/copilot-instructions.md",
  ".gitlab/copilot-instructions.md",
  "copilot-instructions.md",
];

const AGENTS_PATHS = [
  ".github/agents.md",
  ".gitlab/agents.md",
  "agents.md",
];

/**
 * Well-known directories for agent skill files.
 * Existing directories are passed to the Copilot SDK via skillDirectories.
 */
const SKILLS_DIRS = [
  ".github/skills",
  ".claude/skills",
  ".agents/skills",
];

/**
 * Try to read the first existing file from a list of candidate paths.
 */
async function loadFirstFound(
  repoDir: string,
  candidates: string[],
): Promise<{ path: string; content: string } | undefined> {
  for (const relPath of candidates) {
    try {
      const content = await readFile(join(repoDir, relPath), "utf-8");
      return { path: relPath, content: content.trim() };
    } catch {
      // file doesn't exist, try next
    }
  }
  return undefined;
}

/**
 * Find all existing skill directories in the repo.
 * Returns absolute paths suitable for the SDK's skillDirectories option.
 */
async function findSkillDirectories(repoDir: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const dir of SKILLS_DIRS) {
    try {
      await access(join(repoDir, dir));
      dirs.push(join(repoDir, dir));
    } catch {
      // directory doesn't exist
    }
  }
  return dirs;
}

interface ProjectInstructions {
  copilotInstructions?: string;
  agentsInstructions?: string;
  skillDirectories: string[];
}

/**
 * Load project-specific instructions from the cloned repo.
 * Checks for copilot-instructions.md, agents.md, and skills directories.
 */
async function loadProjectInstructions(
  repoDir: string,
): Promise<ProjectInstructions> {
  const [copilot, agents, skillDirectories] = await Promise.all([
    loadFirstFound(repoDir, COPILOT_INSTRUCTIONS_PATHS),
    loadFirstFound(repoDir, AGENTS_PATHS),
    findSkillDirectories(repoDir),
  ]);

  if (copilot) {
    console.log(`[reviewer] Loaded copilot-instructions from ${copilot.path}`);
  }
  if (agents) {
    console.log(`[reviewer] Loaded agents instructions from ${agents.path}`);
  }
  if (skillDirectories.length > 0) {
    console.log(
      `[reviewer] Found skill directories: ${skillDirectories.join(", ")}`,
    );
  }

  return {
    copilotInstructions: copilot?.content,
    agentsInstructions: agents?.content,
    skillDirectories,
  };
}

// ─── Response parser ────────────────────────────────────────────────────────

function parseReviewResponse(content: string): ReviewResult {
  // Try to extract JSON from markdown code fences
  let cleaned = content.trim();

  // Look for ```json...``` or ```...``` blocks
  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    cleaned = jsonBlockMatch[1]!.trim();
  } else if (cleaned.startsWith("```")) {
    // Fallback: old behavior if fence is at start
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned) as ReviewResult;

    if (typeof parsed.summary !== "string") {
      throw new Error("Missing 'summary' field");
    }
    if (!Array.isArray(parsed.comments)) {
      parsed.comments = [];
    }

    parsed.comments = parsed.comments
      .filter(
        (c) =>
          typeof c.file === "string" &&
          typeof c.line === "number" &&
          typeof c.body === "string",
      )
      .map((c) => ({
        file: c.file,
        line: c.line,
        body: c.body,
        severity: ["info", "warning", "critical"].includes(c.severity)
          ? c.severity
          : "info",
        suggestion: typeof c.suggestion === "string" ? c.suggestion : undefined,
        startLine: typeof c.startLine === "number" ? c.startLine : undefined,
        endLine: typeof c.endLine === "number" ? c.endLine : undefined,
      }));

    return parsed;
  } catch (err) {
    console.error("[reviewer] Failed to parse Copilot response as JSON:", err);
    console.error("[reviewer] Raw response:", content);

    return {
      summary: content,
      comments: [],
    };
  }
}

// ─── Main review function ───────────────────────────────────────────────────

export interface ReviewOptions {
  config: Config;
  /** Absolute path to the cloned repository */
  repoDir: string;
  mrTitle: string;
  mrDescription: string;
  mrUrl: string;
  sourceBranch: string;
  targetBranch: string;
  diffVersion: MergeRequestDiffVersionDetail;
  /** Jira issue context (formatted markdown), if available */
  jiraContext?: string;
}

/**
 * Run code review on a merge request using the Copilot SDK.
 *
 * The repository is cloned locally and `workingDirectory` is set so Copilot's
 * built-in tools (Read, Grep, Bash, etc.) can browse the full source tree.
 */
export async function reviewMergeRequest(
  opts: ReviewOptions,
): Promise<ReviewResult> {
  const { config, repoDir, diffVersion } = opts;

  // Load project-specific review instructions if available
  const { copilotInstructions, agentsInstructions, skillDirectories } =
    await loadProjectInstructions(repoDir);

  let systemPrompt = REVIEW_SYSTEM_PROMPT;

  if (copilotInstructions) {
    systemPrompt +=
      `\n\n## Project-Specific Instructions (copilot-instructions.md)\n\n` +
      `The repository contains a \`copilot-instructions.md\` file. ` +
      `Follow these guidelines in addition to the rules above:\n\n` +
      copilotInstructions;
  }

  if (agentsInstructions) {
    systemPrompt +=
      `\n\n## Agent Instructions (agents.md)\n\n` +
      `The repository contains an \`agents.md\` file with additional instructions ` +
      `for AI agents. Follow these guidelines:\n\n` +
      agentsInstructions;
  }

  const client = new CopilotClient({
    githubToken: config.githubToken,
  });

  try {
    const session = await client.createSession({
      model: config.copilotModel,
      workingDirectory: repoDir,
      systemMessage: {
        mode: "append",
        content: systemPrompt,
      },
      // Load skill directories natively via the SDK
      ...(skillDirectories.length > 0 && { skillDirectories }),
      // Tool call logging hooks — auto-approve all operations (read-only
      // on a temporary clone that gets deleted after the review).
      hooks: buildSessionHooks(config.logLevel),
    });

    // Attach event listeners for errors/reasoning/usage visibility
    const { detach, getUsage } = attachSessionListeners(session, config.logLevel);

    console.log(`[reviewer] Session created with model: ${config.copilotModel}`);

    const userPrompt = buildDiffPrompt(
      opts.mrTitle,
      opts.mrDescription,
      opts.mrUrl,
      opts.sourceBranch,
      opts.targetBranch,
      diffVersion.diffs,
      opts.jiraContext,
    );

    console.log(
      `[reviewer] Sending ${diffVersion.diffs.length} file(s) for review ` +
      `(prompt length: ${userPrompt.length} chars, workingDir: ${repoDir})`,
    );

    const response = await session.sendAndWait({
      prompt: userPrompt
    }, 300000);

    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got response (${responseContent.length} chars)`);

    // Log usage statistics
    const usage = getUsage();
    console.log(
      `[reviewer] Usage: ${usage.requestCount} request(s), ` +
      `${usage.inputTokens} input + ${usage.outputTokens} output tokens` +
      (usage.cacheReadTokens > 0 ? ` (${usage.cacheReadTokens} cached)` : "") +
      (usage.totalCost > 0 ? `, cost: $${usage.totalCost.toFixed(6)}` : ""),
    );

    detach();
    await session.destroy();
    await client.stop();

    return parseReviewResponse(responseContent);
  } catch (err) {
    try {
      await client.stop();
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

// ─── Comment Reply ──────────────────────────────────────────────────────────

export interface CommentReplyOptions {
  config: Config;
  repoDir: string;
  threadMessages: Array<{ author: string; body: string; createdAt: string }>;
  /** The file path if this is an inline diff discussion */
  filePath?: string;
  /** The line number if this is an inline diff discussion */
  lineNumber?: number;
  /** The diff context for the file if available */
  diffContext?: string;
  /** MR metadata for context */
  mrTitle: string;
  mrUrl: string;
  /** Jira issue context (formatted markdown), if available */
  jiraContext?: string;
}

/**
 * Generate a reply to a comment thread using the Copilot SDK.
 */
export async function replyToComment(
  opts: CommentReplyOptions,
): Promise<string> {
  const { config, repoDir } = opts;

  // Load project-specific instructions
  const { copilotInstructions, agentsInstructions, skillDirectories } =
    await loadProjectInstructions(repoDir);

  let systemPrompt = COMMENT_REPLY_SYSTEM_PROMPT;

  if (copilotInstructions) {
    systemPrompt +=
      `\n\n## Project-Specific Instructions (copilot-instructions.md)\n\n` +
      copilotInstructions;
  }

  if (agentsInstructions) {
    systemPrompt +=
      `\n\n## Agent Instructions (agents.md)\n\n` +
      agentsInstructions;
  }

  const client = new CopilotClient({
    githubToken: config.githubToken,
  });

  try {
    const session = await client.createSession({
      model: config.copilotModel,
      workingDirectory: repoDir,
      systemMessage: {
        mode: "append",
        content: systemPrompt,
      },
      ...(skillDirectories.length > 0 && { skillDirectories }),
      hooks: buildSessionHooks(config.logLevel),
    });

    const { detach, getUsage } = attachSessionListeners(session, config.logLevel);

    console.log(`[reviewer] Comment reply session created with model: ${config.copilotModel}`);

    const prompt = buildCommentReplyPrompt({
      mrTitle: opts.mrTitle,
      mrUrl: opts.mrUrl,
      filePath: opts.filePath,
      lineNumber: opts.lineNumber,
      diffContext: opts.diffContext,
      jiraContext: opts.jiraContext,
      threadMessages: opts.threadMessages,
    });

    console.log(
      `[reviewer] Sending comment reply request ` +
      `(${opts.threadMessages.length} messages in thread, prompt: ${prompt.length} chars)`,
    );

    const response = await session.sendAndWait({
      prompt,
    }, 300000);

    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got reply (${responseContent.length} chars)`);

    // Log usage statistics
    const usage = getUsage();
    console.log(
      `[reviewer] Usage: ${usage.requestCount} request(s), ` +
      `${usage.inputTokens} input + ${usage.outputTokens} output tokens` +
      (usage.cacheReadTokens > 0 ? ` (${usage.cacheReadTokens} cached)` : "") +
      (usage.totalCost > 0 ? `, cost: $${usage.totalCost.toFixed(6)}` : ""),
    );

    detach();
    await session.destroy();
    await client.stop();

    return responseContent.trim();
  } catch (err) {
    try {
      await client.stop();
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}
