import type { Tool } from "@github/copilot-sdk";
import type { Config } from "./config.js";
import type { ReviewComment, ReviewResult } from "./types.js";
import { JiraClient, formatIssueContext } from "./jira-client.js";

// ─── submit_review tool ─────────────────────────────────────────────────────

/** JSON Schema for the submit_review tool parameters (matches ReviewResult). */
const SUBMIT_REVIEW_PARAMETERS = {
  type: "object",
  required: ["summary", "comments"],
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description:
        "A 2-4 sentence overall assessment of the MR, including what it does and your confidence level.",
    },
    comments: {
      type: "array",
      description: "Review comments. Empty array if no issues found.",
      items: {
        type: "object",
        required: ["file", "line", "body", "severity"],
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description: "Path to the file being commented on.",
          },
          line: {
            type: "integer",
            description:
              "The line number where the comment attaches (the discussion thread anchor).",
          },
          body: {
            type: "string",
            description:
              "Markdown description of the issue and suggested fix.",
          },
          severity: {
            type: "string",
            enum: ["info", "warning", "critical"],
            description: "Severity of the issue.",
          },
          suggestion: {
            type: "string",
            description:
              "Optional replacement code for the line(s). If provided, this will be rendered as a GitLab suggestion block.",
          },
          startLine: {
            type: "integer",
            description:
              "Start of the range to replace (if suggestion spans multiple lines).",
          },
          endLine: {
            type: "integer",
            description:
              "End of the range to replace (if suggestion spans multiple lines).",
          },
        },
      },
    },
  },
} as const;

/**
 * Build the submit_review Tool that captures the structured review result.
 * Each call creates a fresh closure so concurrent reviews don't interfere.
 */
export function buildSubmitReviewTool(): {
  tool: Tool<ReviewResult>;
  getResult: () => ReviewResult | undefined;
} {
  let captured: ReviewResult | undefined;

  const tool: Tool<ReviewResult> = {
    name: "submit_review",
    description:
      "Submit the final code review. Call this exactly once when your review is complete.",
    parameters: SUBMIT_REVIEW_PARAMETERS as unknown as Record<string, unknown>,
    handler: (args: ReviewResult) => {
      captured = normalizeReviewResult(args);
      return "Review submitted successfully.";
    },
  };

  return { tool, getResult: () => captured };
}

// ─── get_jira_issue tool ─────────────────────────────────────────────────────

const GET_JIRA_ISSUE_PARAMETERS = {
  type: "object",
  required: ["issueKey"],
  additionalProperties: false,
  properties: {
    issueKey: {
      type: "string",
      description:
        "The Jira issue key (e.g. PROJ-123, AO2-2624).",
    },
  },
} as const;

/**
 * Build a get_jira_issue Tool backed by the Jira API.
 * Returns undefined when Jira is not configured.
 */
export function buildJiraIssueTool(
  config: Config,
): Tool<{ issueKey: string }> | undefined {
  if (!config.jira) return undefined;

  const client = new JiraClient(config.jira);

  return {
    name: "get_jira_issue",
    description:
      "Fetch a Jira issue's details, including summary, description, status, priority, labels, and comments. " +
      "Use this when you see Jira issue keys (e.g. PROJ-123) in the MR title, branch name, description, or code.",
    parameters: GET_JIRA_ISSUE_PARAMETERS as unknown as Record<string, unknown>,
    handler: async (args: { issueKey: string }) => {
      const key = args.issueKey.trim().toUpperCase();
      console.log(`[jira] Tool call: fetching ${key}`);
      try {
        const ctx = await client.getIssueContext(key);
        console.log(`[jira] Fetched ${key}: "${ctx.summary}" (${ctx.comments.length} comments)`);
        return formatIssueContext(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[jira] Failed to fetch ${key}: ${msg}`);
        return { resultType: "failure" as const, textResultForLlm: `Failed to fetch Jira issue ${key}: ${msg}`, error: msg };
      }
    },
  };
}

// ─── Normalisation / validation ─────────────────────────────────────────────

/**
 * Normalise and validate a ReviewResult from tool args or parsed JSON.
 */
export function normalizeReviewResult(raw: ReviewResult): ReviewResult {
  if (typeof raw.summary !== "string") {
    raw.summary = "";
  }
  if (!Array.isArray(raw.comments)) {
    raw.comments = [];
  }

  raw.comments = raw.comments
    .filter(
      (c): c is ReviewComment =>
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

  return raw;
}

// ─── Fallback text parser (used only when the model fails to call the tool) ─

/**
 * Attempt to extract a ReviewResult from free-text model output.
 * This is the fallback path when the model doesn't use the submit_review tool.
 */
export function parseReviewResponse(content: string): ReviewResult {
  let cleaned = content.trim();

  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*)\s*```/);
  if (jsonBlockMatch) {
    cleaned = jsonBlockMatch[1]!.trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  if (!cleaned.startsWith("{")) {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    return normalizeReviewResult(JSON.parse(cleaned) as ReviewResult);
  } catch (err) {
    console.error("[reviewer] Failed to parse Copilot response as JSON:", err);
    console.error("[reviewer] Raw response:", content);

    return {
      summary: content,
      comments: [],
    };
  }
}
