import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type { Config } from "./config.js";
import type {
  DiffFile,
  MergeRequestDiffVersionDetail,
  ReviewComment,
  ReviewResult,
  NoteWebhookPayload,
} from "./types.js";

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

interface ProjectInstructions {
  copilotInstructions?: string;
  agentsInstructions?: string;
}

/**
 * Load project-specific instructions from the cloned repo.
 * Checks for both copilot-instructions.md and agents.md.
 */
async function loadProjectInstructions(
  repoDir: string,
): Promise<ProjectInstructions> {
  const [copilot, agents] = await Promise.all([
    loadFirstFound(repoDir, COPILOT_INSTRUCTIONS_PATHS),
    loadFirstFound(repoDir, AGENTS_PATHS),
  ]);

  if (copilot) {
    console.log(`[reviewer] Loaded copilot-instructions from ${copilot.path}`);
  }
  if (agents) {
    console.log(`[reviewer] Loaded agents instructions from ${agents.path}`);
  }

  return {
    copilotInstructions: copilot?.content,
    agentsInstructions: agents?.content,
  };
}

// ─── System prompt ──────────────────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer performing a review on a GitLab Merge Request.

You will be given a diff of the changes. The full repository source code is available in your working directory — you can and should read related files to understand the broader context.

## Workflow

1. First, read the diff carefully to understand what changed.
2. Explore the repository for context:
   - Read files that are imported/referenced by the changed files.
   - Check type definitions, interfaces, or base classes that the changes depend on.
   - Look at existing tests for the changed code.
   - Read project documentation (README, CONTRIBUTING, etc.) and configuration files to understand conventions.
   - Check for related files that might need coordinated changes.
3. Based on the full context, produce your review.

## Review Focus Areas

1. **Security vulnerabilities** – SQL injection, XSS, secrets in code, auth issues, unsafe deserialization
2. **Bugs & logic errors** – off-by-one, null/undefined references, race conditions, incorrect conditionals, unhandled edge cases
3. **Performance issues** – N+1 queries, memory leaks, unnecessary allocations, blocking calls in async code
4. **Code quality** – naming, readability, DRY violations, dead code, missing abstractions
5. **Best practices** – error handling, input validation, logging, test coverage gaps
6. **API design** – backward compatibility, consistent naming, proper HTTP methods/status codes
7. **Consistency** – does the change follow existing patterns and conventions in the codebase?

## Rules

- Only comment on CHANGED lines (lines with + prefix in the diff), but use context from the broader codebase to inform your comments.
- Be specific and actionable. Always suggest a fix or improvement.
- For issues that have a clear code fix, include a "suggestion" field with the corrected code. For example:
  - Security issue: provide the corrected line with proper ARN restrictions
  - Bug: provide the corrected code with proper error handling
  - Naming issue: provide the line with the better name
  - Missing feature: provide the added code or configuration
- Do NOT comment on minor style nitpicks (formatting, spacing) unless they violate project conventions.
- If the code looks good, say so briefly.
- Read the actual source to verify your assumptions — don't guess about what existing code does.

## Output Format

When you have finished your review, respond with ONLY valid JSON matching this exact schema (no markdown fences, no preamble):

{
  "summary": "A 2-4 sentence overall assessment of the MR, including what it does and your confidence level.",
  "comments": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "body": "Description of the issue and suggested fix.",
      "severity": "info | warning | critical",
      "suggestion": "(optional) Suggested replacement code.",
      "startLine": 40,
      "endLine": 44
    }
  ]
}

Note: line is where the comment attaches; startLine and endLine describe the range being replaced (if suggestion spans multiple lines).

If there are no issues, return:
{
  "summary": "The changes look good. No significant issues found.",
  "comments": []
}`;

// ─── Diff prompt builder ────────────────────────────────────────────────────

function buildDiffPrompt(
  mrTitle: string,
  mrDescription: string,
  mrUrl: string,
  sourceBranch: string,
  targetBranch: string,
  diffs: DiffFile[],
): string {
  const filesDiff = diffs
    .filter((d) => !d.too_large && !d.collapsed)
    .map((d) => {
      const status = d.new_file
        ? "(new file)"
        : d.deleted_file
          ? "(deleted)"
          : d.renamed_file
            ? `(renamed from ${d.old_path})`
            : "";
      return `### ${d.new_path} ${status}\n\`\`\`diff\n${d.diff}\n\`\`\``;
    })
    .join("\n\n");

  const skipped = diffs.filter((d) => d.too_large || d.collapsed);
  const skippedNote =
    skipped.length > 0
      ? `\n\n> **Note**: ${skipped.length} file(s) were too large to include in the diff. ` +
        `You can read them directly from the working directory: ${skipped.map((d) => d.new_path).join(", ")}`
      : "";

  return `# Merge Request: ${mrTitle}
**Branch**: \`${sourceBranch}\` → \`${targetBranch}\`
**URL**: ${mrUrl}

## Description
${mrDescription || "(no description)"}

## Changed Files (${diffs.length} file(s))

${filesDiff}${skippedNote}

---

Please review the above changes. The full repository is available in your working directory — read related source files, imports, tests, documentation, and configuration to understand context before producing your review.

When done, output your review as JSON.`;
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
  const { copilotInstructions, agentsInstructions } =
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
      // Auto-approve all tool calls — they are read-only operations
      // on a temporary clone that gets deleted after the review.
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

    console.log(`[reviewer] Session created with model: ${config.copilotModel}`);

    const userPrompt = buildDiffPrompt(
      opts.mrTitle,
      opts.mrDescription,
      opts.mrUrl,
      opts.sourceBranch,
      opts.targetBranch,
      diffVersion.diffs,
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

const COMMENT_REPLY_SYSTEM_PROMPT = `You are an expert developer assistant responding to a comment on a GitLab Merge Request.

You will be given a discussion thread (all messages in order) and optionally the diff context for the file being discussed. The full repository source code is available in your working directory.

## Workflow

1. Read the full discussion thread to understand the context and what is being asked.
2. If code is being discussed, read the relevant files from the repository.
3. Provide a helpful, specific, and actionable response.

## Rules

- Be concise but thorough. Answer the question directly.
- If suggesting code changes, provide the actual code.
- If the question is about a specific part of the code, reference the file and line numbers.
- Use markdown formatting for readability.
- Do NOT output JSON — just write a natural language response (with code blocks if needed).
- Do NOT repeat the question or the thread — just provide your answer.

## Code Suggestions

When the discussion is on a specific file/line (inline diff discussion) and you want to suggest a code change, use GitLab's suggestion syntax. This renders as a one-click "Apply suggestion" button in the GitLab UI.

**Single-line replacement** (replaces the line the discussion is attached to):
\`\`\`suggestion
replacement code here
\`\`\`

**Multi-line replacement** (replaces a range of lines around the discussion line):
Use the \`:-N+M\` syntax after "suggestion", where N is the number of lines BEFORE the discussion line, and M is the number of lines AFTER it.
For example, to replace 3 lines before and 1 line after the comment line:
\`\`\`suggestion:-3+1
replacement code for all 5 lines
\`\`\`

Rules for suggestions:
- Only use suggestion blocks when the discussion is on specific code (file/line info is provided).
- The suggestion block replaces entire lines — include the complete replacement, not just the changed parts.
- You can have multiple suggestion blocks in one reply if needed.
- Outside of suggestion blocks, explain your reasoning in natural language.
- If the discussion is a general MR comment (not on a specific line), use regular code blocks instead.`;

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
}

/**
 * Generate a reply to a comment thread using the Copilot SDK.
 */
export async function replyToComment(
  opts: CommentReplyOptions,
): Promise<string> {
  const { config, repoDir } = opts;

  // Load project-specific instructions
  const { copilotInstructions, agentsInstructions } =
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
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

    console.log(`[reviewer] Comment reply session created with model: ${config.copilotModel}`);

    // Build the user prompt with thread context
    let prompt = `# Merge Request: ${opts.mrTitle}\n**URL**: ${opts.mrUrl}\n\n`;

    if (opts.filePath) {
      prompt += `## File Context\n**File**: \`${opts.filePath}\``;
      if (opts.lineNumber) {
        prompt += ` (line ${opts.lineNumber})`;
      }
      prompt += "\n\n";
    }

    if (opts.diffContext) {
      prompt += `## Diff\n\`\`\`diff\n${opts.diffContext}\n\`\`\`\n\n`;
    }

    prompt += `## Discussion Thread\n\n`;
    for (const msg of opts.threadMessages) {
      prompt += `**${msg.author}** (${msg.createdAt}):\n${msg.body}\n\n---\n\n`;
    }

    prompt += `Please respond to the latest message in this discussion thread. Provide a helpful and specific answer.`;

    console.log(
      `[reviewer] Sending comment reply request ` +
      `(${opts.threadMessages.length} messages in thread, prompt: ${prompt.length} chars)`,
    );

    const response = await session.sendAndWait({
      prompt,
    }, 300000);

    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got reply (${responseContent.length} chars)`);

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
