import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { Config } from "./config.js";
import type {
  MergeRequestCommentContext,
  MergeRequestDiffVersionDetail,
  ReviewResult,
} from "./types.js";
import { loadReviewSystemPrompt } from "./prompts/review-system.js";
import { loadCommentReplySystemPrompt } from "./prompts/comment-reply-system.js";
import { buildDiffPrompt, buildCommentReplyPrompt } from "./prompts/build-prompts.js";
import { buildSubmitReviewTool, buildJiraIssueTool, parseReviewResponse } from "./tools.js";
import { buildMcpServers } from "./mcp/config-loader.js";

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
    totalModelMultiplier: 0,
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
  totalModelMultiplier: number;
  requestCount: number;
  firstUsedRequests?: number;
  lastUsedRequests?: number;
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

// ─── Main review function ───────────────────────────────────────────────────

export interface ReviewOptions {
  config: Config;
  /** Absolute path to the cloned repository */
  repoDir: string;
  sessionId: string;
  mrTitle: string;
  mrDescription: string;
  mrUrl: string;
  sourceBranch: string;
  targetBranch: string;
  diffVersion: MergeRequestDiffVersionDetail;
  mrComments?: MergeRequestCommentContext[];
}

async function createOrResumeSession(
  client: CopilotClient,
  sessionId: string,
  config: Config,
  repoDir: string,
  systemPrompt: string,
  skillDirectories: string[],
  tools?: Parameters<CopilotClient["createSession"]>[0]["tools"],
  mcpServers?: Parameters<CopilotClient["createSession"]>[0]["mcpServers"],
) {
  const baseSessionConfig = {
    model: config.copilotModel,
    configDir: config.copilotConfigDir,
    onPermissionRequest: approveAll,
    workingDirectory: repoDir,
    systemMessage: {
      mode: "append" as const,
      content: systemPrompt,
    },
    infiniteSessions: { enabled: true },
    ...(tools && { tools }),
    ...(mcpServers && { mcpServers }),
    ...(skillDirectories.length > 0 && { skillDirectories }),
    hooks: buildSessionHooks(config.logLevel),
  };

  try {
    const resumed = await client.resumeSession(sessionId, baseSessionConfig);
    console.log(`[reviewer] Resumed session: ${sessionId}`);
    return resumed;
  } catch {
    const created = await client.createSession({
      ...baseSessionConfig,
      sessionId,
    });
    console.log(`[reviewer] Created new session: ${sessionId}`);
    return created;
  }
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
  console.log(`[reviewer] 🔍 Reviewing MR: "${opts.mrTitle}"`);
  
  const { config, repoDir, diffVersion } = opts;

  // Load project-specific review instructions if available
  const { copilotInstructions, agentsInstructions, skillDirectories } =
    await loadProjectInstructions(repoDir);

  let systemPrompt = await loadReviewSystemPrompt();

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

  // Build custom tools
  const { tool: submitReviewTool, getResult } = buildSubmitReviewTool();
  const jiraTool = buildJiraIssueTool(config);
  const customTools = jiraTool
    ? [submitReviewTool, jiraTool]
    : [submitReviewTool];

  try {
    const mcpServers = await buildMcpServers(repoDir);

    const session = await createOrResumeSession(
      client,
      opts.sessionId,
      config,
      repoDir,
      systemPrompt,
      skillDirectories,
      customTools,
      mcpServers,
    );

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
      opts.mrComments,
    );

    console.log(
      `[reviewer] Sending ${diffVersion.diffs.length} file(s) for review ` +
      `(prompt length: ${userPrompt.length} chars, workingDir: ${repoDir})`,
    );

    const usageBeforeReview = getUsage();
    console.log(
      `[reviewer] Quota before review: quotaSnapshots.usedRequests=` +
      `${usageBeforeReview.lastUsedRequests ?? "N/A"}`,
    );

    const response = await session.sendAndWait({
      prompt: userPrompt
    }, 600000);

    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got response (${responseContent.length} chars)`);

    // Log usage statistics
    const usage = getUsage();
    console.log(
      `[reviewer] Usage: ${usage.requestCount} request(s), ` +
      `${usage.inputTokens} input + ${usage.outputTokens} output tokens` +
      (usage.cacheReadTokens > 0 ? ` (${usage.cacheReadTokens} cached)` : "") +
      (usage.totalModelMultiplier > 0
        ? `, total model multiplier: ${usage.totalModelMultiplier.toFixed(4)}`
        : ""),
    );
    console.log(
      `[reviewer] Quota after review: quotaSnapshots.usedRequests=` +
      `${usage.lastUsedRequests ?? "N/A"}`,
    );

    detach();
    await session.destroy();
    await client.stop();

    // Prefer the structured tool call result; fall back to text parsing
    const toolResult = getResult();
    if (toolResult) {
      console.log(
        `[reviewer] Review captured via submit_review tool call ` +
        `(${toolResult.comments.length} comment(s))`,
      );
      return toolResult;
    }

    console.warn(
      "[reviewer] Model did not call submit_review tool — falling back to text parsing",
    );
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
  sessionId: string;
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
}

/**
 * Generate a reply to a comment thread using the Copilot SDK.
 */
export async function replyToComment(
  opts: CommentReplyOptions,
): Promise<string> {
  console.log(`[reviewer] 💬 Replying to comment on MR: "${opts.mrTitle}"`);
  
  const { config, repoDir } = opts;

  // Load project-specific instructions
  const { copilotInstructions, agentsInstructions, skillDirectories } =
    await loadProjectInstructions(repoDir);

  let systemPrompt = await loadCommentReplySystemPrompt();

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
    // Build custom tools (Jira tool available in comment replies too)
    const jiraTool = buildJiraIssueTool(config);
    const customTools = jiraTool ? [jiraTool] : undefined;
    const mcpServers = await buildMcpServers(repoDir);

    const session = await createOrResumeSession(
      client,
      opts.sessionId,
      config,
      repoDir,
      systemPrompt,
      skillDirectories,
      customTools,
      mcpServers,
    );

    const { detach, getUsage } = attachSessionListeners(session, config.logLevel);

    console.log(`[reviewer] Comment reply session created with model: ${config.copilotModel}`);

    const prompt = buildCommentReplyPrompt({
      mrTitle: opts.mrTitle,
      mrUrl: opts.mrUrl,
      filePath: opts.filePath,
      lineNumber: opts.lineNumber,
      diffContext: opts.diffContext,
      threadMessages: opts.threadMessages,
    });

    console.log(
      `[reviewer] Sending comment reply request ` +
      `(${opts.threadMessages.length} messages in thread, prompt: ${prompt.length} chars)`,
    );

    const response = await session.sendAndWait({
      prompt,
    }, 600000);

    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got reply (${responseContent.length} chars)`);

    // Log usage statistics
    const usage = getUsage();
    console.log(
      `[reviewer] Usage: ${usage.requestCount} request(s), ` +
      `${usage.inputTokens} input + ${usage.outputTokens} output tokens` +
      (usage.cacheReadTokens > 0 ? ` (${usage.cacheReadTokens} cached)` : "") +
      (usage.totalModelMultiplier > 0
        ? `, total model multiplier: ${usage.totalModelMultiplier.toFixed(4)}`
        : ""),
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
