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
    /** Parent issue (epic/story) — available in Jira Cloud and next-gen projects. */
    parent?: {
      key: string;
      fields: {
        summary: string;
        issuetype: { name: string };
        status: { name: string };
      };
    };
    /** Classic epic link field (Jira Server / classic projects). */
    epic?: {
      key: string;
      name: string;
    } | null;
    /** Linked issues (blocks, is blocked by, relates to, etc.). */
    issuelinks?: Array<{
      type: { name: string; inward: string; outward: string };
      inwardIssue?: { key: string; fields: { summary: string; status: { name: string }; issuetype: { name: string } } };
      outwardIssue?: { key: string; fields: { summary: string; status: { name: string }; issuetype: { name: string } } };
    }>;
    /** Sub-tasks of this issue. */
    subtasks?: Array<{
      key: string;
      fields: { summary: string; status: { name: string }; issuetype: { name: string } };
    }>;
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
  /** Parent issue (epic or story that this issue belongs to). */
  parent?: { key: string; summary: string; type: string; status: string };
  /** Linked issues (blocks, relates to, etc.). */
  links: Array<{ relationship: string; key: string; summary: string; type: string; status: string }>;
  /** Sub-tasks. */
  subtasks: Array<{ key: string; summary: string; type: string; status: string }>;
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
      `/issue/${issueKey}?fields=summary,description,status,issuetype,priority,labels,assignee,parent,epic,issuelinks,subtasks`,
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

    // Resolve parent: prefer the `parent` field, fall back to classic `epic` link
    let parent: JiraIssueContext["parent"];
    if (issue.fields.parent) {
      const p = issue.fields.parent;
      parent = {
        key: p.key,
        summary: p.fields.summary,
        type: p.fields.issuetype.name,
        status: p.fields.status.name,
      };
    } else if (issue.fields.epic) {
      parent = {
        key: issue.fields.epic.key,
        summary: issue.fields.epic.name,
        type: "Epic",
        status: "Unknown",
      };
    }

    // Flatten issue links into a uniform shape
    const links: JiraIssueContext["links"] = (issue.fields.issuelinks ?? []).map((link) => {
      if (link.outwardIssue) {
        return {
          relationship: link.type.outward,
          key: link.outwardIssue.key,
          summary: link.outwardIssue.fields.summary,
          type: link.outwardIssue.fields.issuetype.name,
          status: link.outwardIssue.fields.status.name,
        };
      }
      const inward = link.inwardIssue!;
      return {
        relationship: link.type.inward,
        key: inward.key,
        summary: inward.fields.summary,
        type: inward.fields.issuetype.name,
        status: inward.fields.status.name,
      };
    });

    // Sub-tasks
    const subtasks: JiraIssueContext["subtasks"] = (issue.fields.subtasks ?? []).map((st) => ({
      key: st.key,
      summary: st.fields.summary,
      type: st.fields.issuetype.name,
      status: st.fields.status.name,
    }));

    return {
      key: issue.key,
      summary: issue.fields.summary,
      type: issue.fields.issuetype.name,
      status: issue.fields.status.name,
      priority: issue.fields.priority?.name,
      assignee: issue.fields.assignee?.displayName ?? undefined,
      labels: issue.fields.labels,
      description: issue.fields.description,
      parent,
      links,
      subtasks,
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

export function formatIssueContext(ctx: JiraIssueContext): string {
  let result = `### ${ctx.key}: ${ctx.summary}\n`;
  result += `**Type**: ${ctx.type} | **Status**: ${ctx.status}`;
  if (ctx.priority) result += ` | **Priority**: ${ctx.priority}`;
  if (ctx.assignee) result += ` | **Assignee**: ${ctx.assignee}`;
  if (ctx.labels && ctx.labels.length > 0) {
    result += `\n**Labels**: ${ctx.labels.join(", ")}`;
  }
  result += "\n";

  if (ctx.parent) {
    result += `\n**Parent**: ${ctx.parent.key} — ${ctx.parent.summary} (${ctx.parent.type}, ${ctx.parent.status})`;
    result += `\n_Use \`get_jira_issue("${ctx.parent.key}")\` to fetch full parent details._\n`;
  }

  if (ctx.links.length > 0) {
    result += `\n**Linked Issues** (${ctx.links.length}):\n`;
    for (const link of ctx.links) {
      result += `- _${link.relationship}_ **${link.key}**: ${link.summary} (${link.type}, ${link.status})\n`;
    }
  }

  if (ctx.subtasks.length > 0) {
    result += `\n**Sub-tasks** (${ctx.subtasks.length}):\n`;
    for (const st of ctx.subtasks) {
      result += `- **${st.key}**: ${st.summary} (${st.type}, ${st.status})\n`;
    }
  }

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
