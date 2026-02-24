import type { Config } from "./config.js";

// ─── Jira Issue ID Extraction ───────────────────────────────────────────────

/**
 * Extract Jira issue keys from text (e.g. "AO2-2624", "PROJ-123").
 * Matches the standard Jira pattern: uppercase letters + optional digits, dash, digits.
 */
const JIRA_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

export function extractJiraKeys(text: string): string[] {
  const matches = text.match(JIRA_KEY_PATTERN);
  if (!matches) return [];
  // Deduplicate
  return [...new Set(matches)];
}

// ─── Jira API Types ─────────────────────────────────────────────────────────

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: {
      name: string;
    };
    issuetype: {
      name: string;
    };
    priority?: {
      name: string;
    };
    labels?: string[];
    assignee?: {
      displayName: string;
    } | null;
  };
}

export interface JiraComment {
  id: string;
  author: {
    displayName: string;
  };
  body: string;
  created: string;
  updated: string;
}

export interface JiraIssueContext {
  key: string;
  summary: string;
  type: string;
  status: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  description: string | null;
  comments: Array<{
    author: string;
    body: string;
    created: string;
  }>;
}

// ─── Jira Client ────────────────────────────────────────────────────────────

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(jiraConfig: NonNullable<Config["jira"]>) {
    this.baseUrl = `${jiraConfig.url}/rest/api/2`;
    // Jira Cloud: Basic auth with email:apiToken
    const credentials = Buffer.from(
      `${jiraConfig.email}:${jiraConfig.apiToken}`,
    ).toString("base64");
    this.authHeader = `Basic ${credentials}`;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Jira API error: ${response.status} ${response.statusText} – ${text}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch issue details by key (e.g. "AO2-2624").
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(
      `/issue/${issueKey}?fields=summary,description,status,issuetype,priority,labels,assignee`,
    );
  }

  /**
   * Fetch comments on an issue.
   */
  async getIssueComments(
    issueKey: string,
  ): Promise<{ comments: JiraComment[] }> {
    return this.request<{ comments: JiraComment[] }>(
      `/issue/${issueKey}/comment?orderBy=created`,
    );
  }

  /**
   * Fetch full context for an issue: details + comments.
   */
  async getIssueContext(issueKey: string): Promise<JiraIssueContext> {
    const [issue, commentsResult] = await Promise.all([
      this.getIssue(issueKey),
      this.getIssueComments(issueKey),
    ]);

    return {
      key: issue.key,
      summary: issue.fields.summary,
      type: issue.fields.issuetype.name,
      status: issue.fields.status.name,
      priority: issue.fields.priority?.name,
      assignee: issue.fields.assignee?.displayName ?? undefined,
      labels: issue.fields.labels,
      description: issue.fields.description,
      comments: commentsResult.comments.map((c) => ({
        author: c.author.displayName,
        body: c.body,
        created: c.created,
      })),
    };
  }
}

// ─── Jira Context Formatter ─────────────────────────────────────────────────

/**
 * Fetch Jira context for all issue keys found in text.
 * Returns a formatted markdown string, or undefined if no issues found / Jira not configured.
 */
export async function fetchJiraContext(
  text: string,
  config: Config,
): Promise<string | undefined> {
  if (!config.jira) return undefined;

  const keys = extractJiraKeys(text);
  if (keys.length === 0) return undefined;

  console.log(`[jira] Found Jira keys: ${keys.join(", ")}`);

  const client = new JiraClient(config.jira);
  const contexts: JiraIssueContext[] = [];

  for (const key of keys) {
    try {
      const ctx = await client.getIssueContext(key);
      contexts.push(ctx);
      console.log(`[jira] Fetched ${key}: "${ctx.summary}" (${ctx.comments.length} comments)`);
    } catch (err) {
      console.warn(`[jira] Failed to fetch ${key}:`, err);
    }
  }

  if (contexts.length === 0) return undefined;

  return contexts.map(formatIssueContext).join("\n\n");
}

function formatIssueContext(ctx: JiraIssueContext): string {
  let result = `### ${ctx.key}: ${ctx.summary}\n`;
  result += `**Type**: ${ctx.type} | **Status**: ${ctx.status}`;
  if (ctx.priority) result += ` | **Priority**: ${ctx.priority}`;
  if (ctx.assignee) result += ` | **Assignee**: ${ctx.assignee}`;
  if (ctx.labels && ctx.labels.length > 0) {
    result += `\n**Labels**: ${ctx.labels.join(", ")}`;
  }
  result += "\n";

  if (ctx.description) {
    result += `\n**Description**:\n${ctx.description}\n`;
  }

  if (ctx.comments.length > 0) {
    result += `\n**Comments** (${ctx.comments.length}):\n`;
    for (const comment of ctx.comments) {
      const date = new Date(comment.created).toISOString().split("T")[0];
      result += `\n> **${comment.author}** (${date}):\n> ${comment.body.replace(/\n/g, "\n> ")}\n`;
    }
  }

  return result;
}
