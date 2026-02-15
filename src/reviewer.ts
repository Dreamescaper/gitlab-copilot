import { CopilotClient } from "@github/copilot-sdk";
import type { Config } from "./config.js";
import type {
  DiffFile,
  MergeRequestDiffVersionDetail,
  ReviewComment,
  ReviewResult,
} from "./types.js";

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
      "severity": "info | warning | critical"
    }
  ]
}

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
  // Strip markdown code fences if present
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
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

  const client = new CopilotClient({
    githubToken: config.githubToken,
  });

  try {
    const session = await client.createSession({
      model: config.copilotModel,
      workingDirectory: repoDir,
      systemMessage: {
        mode: "append",
        content: REVIEW_SYSTEM_PROMPT,
      },
      // Auto-approve all tool calls — they are read-only operations
      // on a temporary clone that gets deleted after the review.
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

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
      prompt: userPrompt,
    });

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
