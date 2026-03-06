#!/usr/bin/env node

// src/index.ts
import { readFile as readFile5 } from "node:fs/promises";

// src/config.ts
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
function parseBooleanEnv(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
function loadConfig() {
  const gitlabUrl = process.env["CI_SERVER_URL"] ?? process.env["GITLAB_URL"];
  if (!gitlabUrl) {
    throw new Error("Missing GitLab URL: CI_SERVER_URL or GITLAB_URL must be set");
  }
  const jiraUrl = process.env["JIRA_URL"];
  const jiraEmail = process.env["JIRA_EMAIL"];
  const jiraApiToken = process.env["JIRA_API_TOKEN"];
  const jira = jiraUrl && jiraEmail && jiraApiToken ? { url: jiraUrl.replace(/\/+$/, ""), email: jiraEmail, apiToken: jiraApiToken } : void 0;
  if (jira) {
    console.log(`[config] Jira integration enabled (${jira.url})`);
  }
  return {
    gitlabUrl: gitlabUrl.replace(/\/+$/, ""),
    gitlabToken: requireEnv("GITLAB_TOKEN"),
    gitlabBotUsername: requireEnv("GITLAB_BOT_USERNAME"),
    gitlabAutoAddReviewer: parseBooleanEnv(process.env["GITLAB_AUTO_ADD_REVIEWER"]),
    githubToken: requireEnv("GITHUB_TOKEN"),
    copilotModel: process.env["COPILOT_MODEL"] ?? "gpt-4.1",
    copilotConfigDir: process.env["COPILOT_CONFIG_DIR"] ?? ".copilot-sessions",
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    jira
  };
}

// src/gitlab-client.ts
function parseDiffLines(diff) {
  const lines = /* @__PURE__ */ new Map();
  let currentNewLine = 0;
  let currentOldLine = 0;
  for (const line of diff.split("\n")) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1], 10);
      currentNewLine = parseInt(hunkMatch[2], 10);
      continue;
    }
    if (currentNewLine === 0) continue;
    if (line.startsWith("+")) {
      lines.set(currentNewLine, { newLine: currentNewLine, oldLine: null });
      currentNewLine++;
    } else if (line.startsWith("-")) {
      currentOldLine++;
    } else {
      lines.set(currentNewLine, { newLine: currentNewLine, oldLine: currentOldLine });
      currentNewLine++;
      currentOldLine++;
    }
  }
  return lines;
}
function computeOldLine(diff, newLine) {
  let offset = 0;
  for (const line of diff.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const oldStart = parseInt(m[1], 10);
    const oldCount = parseInt(m[2] ?? "1", 10);
    const newStart = parseInt(m[3], 10);
    const newCount = parseInt(m[4] ?? "1", 10);
    if (newLine < newStart) break;
    offset = oldStart + oldCount - (newStart + newCount);
  }
  return newLine + offset;
}
var GitLabClient = class {
  baseUrl;
  token;
  constructor(config) {
    this.baseUrl = `${config.gitlabUrl}/api/v4`;
    this.token = config.gitlabToken;
  }
  async request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json"
    };
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : void 0
    });
    if (!response.ok) {
      const text2 = await response.text();
      throw new Error(
        `GitLab API error: ${response.status} ${response.statusText} \u2013 ${text2}`
      );
    }
    const contentLength = response.headers.get("content-length");
    if (response.status === 204 || contentLength === "0") {
      return void 0;
    }
    const text = await response.text();
    if (!text) {
      return void 0;
    }
    return JSON.parse(text);
  }
  // ─── Merge Request Diffs ──────────────────────────────────────────────────
  /**
   * Find a GitLab user by exact username.
   */
  async findUserByUsername(username) {
    const users = await this.request(
      "GET",
      `/users?username=${encodeURIComponent(username)}`
    );
    return users.find((u) => u.username === username);
  }
  /**
   * Replace the MR reviewer list with the provided reviewer IDs.
   */
  async updateMergeRequestReviewers(projectId, mrIid, reviewerIds) {
    await this.request(
      "PUT",
      `/projects/${projectId}/merge_requests/${mrIid}`,
      { reviewer_ids: reviewerIds }
    );
  }
  /**
   * Get all diff versions for a merge request.
   */
  async getMergeRequestVersions(projectId, mrIid) {
    return this.request(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/versions`
    );
  }
  /**
   * Get a specific diff version with full diffs.
   */
  async getMergeRequestVersionDetail(projectId, mrIid, versionId) {
    return this.request(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/versions/${versionId}?unidiff=true`
    );
  }
  /**
   * Get the latest diff version with full diffs.
   */
  async getLatestDiffs(projectId, mrIid) {
    const versions = await this.getMergeRequestVersions(projectId, mrIid);
    if (versions.length === 0) {
      throw new Error(`No diff versions found for MR !${mrIid}`);
    }
    const latest = versions[0];
    return this.getMergeRequestVersionDetail(projectId, mrIid, latest.id);
  }
  // ─── Posting Comments ─────────────────────────────────────────────────────
  /**
   * Post a general (non-inline) note on a merge request.
   */
  async postMergeRequestNote(projectId, mrIid, body) {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/notes`,
      { body }
    );
  }
  /**
   * Get existing discussions (inline diff comments) on a merge request.
   */
  async getMergeRequestDiscussions(projectId, mrIid) {
    return this.request(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`
    );
  }
  /**
   * Get all notes in a specific discussion thread.
   */
  async getDiscussionNotes(projectId, mrIid, discussionId) {
    return this.request(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}/notes`
    );
  }
  /**
   * Post a reply to an existing discussion thread.
   */
  async replyToDiscussion(projectId, mrIid, discussionId, body) {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
      { body }
    );
  }
  /**
   * Get existing notes (general comments) on a merge request.
   */
  async getMergeRequestNotes(projectId, mrIid) {
    return this.request(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/notes`
    );
  }
  /**
   * Get chronological MR comment history for prompt context.
   * Includes both discussion notes and regular MR notes.
   */
  async getMergeRequestCommentContext(projectId, mrIid) {
    const [discussions, notes] = await Promise.all([
      this.request(
        "GET",
        `/projects/${projectId}/merge_requests/${mrIid}/discussions`
      ),
      this.request(
        "GET",
        `/projects/${projectId}/merge_requests/${mrIid}/notes`
      )
    ]);
    const discussionEntries = discussions.flatMap(
      (discussion) => discussion.notes.filter((note) => !note.system && note.body.trim().length > 0).map((note) => ({
        source: "discussion",
        author: note.author?.username ?? note.author?.name ?? "unknown",
        body: note.body,
        createdAt: note.created_at,
        filePath: note.position?.new_path ?? note.position?.old_path,
        lineNumber: note.position?.new_line ?? note.position?.old_line ?? void 0
      }))
    );
    const noteEntries = notes.filter((note) => !note.system && note.body.trim().length > 0).map((note) => ({
      source: "note",
      author: note.author?.username ?? note.author?.name ?? "unknown",
      body: note.body,
      createdAt: note.created_at,
      filePath: note.position?.new_path ?? note.position?.old_path,
      lineNumber: note.position?.new_line ?? note.position?.old_line ?? void 0
    }));
    const deduped = /* @__PURE__ */ new Map();
    for (const entry of [...discussionEntries, ...noteEntries]) {
      const key = `${entry.createdAt}|${entry.author}|${entry.body}`;
      if (!deduped.has(key)) {
        deduped.set(key, entry);
      }
    }
    return [...deduped.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
  /**
   * Post an inline discussion (diff comment) on a merge request.
   */
  async postDiffDiscussion(projectId, mrIid, body, position) {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`,
      { body, position }
    );
  }
  // ─── Draft Notes (Review Submission) ──────────────────────────────────────
  /**
   * Create a general (non-inline) draft note on a merge request.
   */
  async createDraftNote(projectId, mrIid, note) {
    return this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/draft_notes`,
      { note }
    );
  }
  /**
   * Create an inline diff draft note on a merge request.
   * Position's head_sha/base_sha/start_sha identify the diff version.
   */
  async createDraftDiffNote(projectId, mrIid, note, position) {
    return this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/draft_notes`,
      { note, position }
    );
  }
  /**
   * Publish all pending draft notes for a merge request.
   * This is GitLab's equivalent of "Submit Review" with the "Comment" action.
   */
  async publishAllDraftNotes(projectId, mrIid) {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/draft_notes/bulk_publish`
    );
  }
  /**
   * Post all review comments to a merge request using draft notes,
   * then bulk-publish them as a single "Submit Review" (Comment action).
   *
   * - Fetches existing discussions/notes to avoid duplicates
   * - Inline comments are created as draft diff notes.
   * - Comments that can't be placed inline fall back to general draft notes.
   * - All drafts are published in one shot via bulk_publish.
   * - Summary is posted separately as a simple note (not resolvable).
   */
  async postReview(projectId, mrIid, summary, comments, diffVersion) {
    let posted = 0;
    let failed = 0;
    let skipped = 0;
    console.log("[gitlab] Fetching existing comments to avoid duplicates...");
    let existingDiscussions = [];
    let existingNotes = [];
    try {
      existingDiscussions = await this.getMergeRequestDiscussions(projectId, mrIid);
      existingNotes = await this.getMergeRequestNotes(projectId, mrIid);
    } catch (err) {
      console.warn("[gitlab] Failed to fetch existing comments, proceeding anyway:", err);
    }
    const commentExists = (file, line, body) => {
      const fileLineKey = `${file}:${line}`;
      for (const discussion of existingDiscussions) {
        for (const note of discussion.notes) {
          if (note.body.includes(fileLineKey) && note.body.includes(body)) {
            return true;
          }
        }
      }
      for (const note of existingNotes) {
        if (note.body.includes(fileLineKey) && note.body.includes(body)) {
          return true;
        }
      }
      return false;
    };
    for (const comment of comments) {
      try {
        if (commentExists(comment.file, comment.line, comment.body)) {
          console.log(`[gitlab] Skipping duplicate comment on ${comment.file}:${comment.line}`);
          skipped++;
          continue;
        }
        const severityIcon = comment.severity === "critical" ? "\u{1F534}" : comment.severity === "warning" ? "\u{1F7E1}" : "\u2139\uFE0F";
        let commentBody = `${severityIcon} **${comment.severity.toUpperCase()}**: ${comment.body}`;
        if (comment.suggestion) {
          let rangeOffset = "";
          if (comment.startLine !== void 0 && comment.endLine !== void 0) {
            const beforeOffset = comment.line - comment.startLine;
            const afterOffset = comment.endLine - comment.line;
            rangeOffset = `:${beforeOffset > 0 ? "-" : ""}${Math.abs(beforeOffset)}+${afterOffset}`;
          }
          commentBody += `

\`\`\`suggestion${rangeOffset}
${comment.suggestion}
\`\`\``;
        }
        const diffFile = diffVersion.diffs.find(
          (d) => d.new_path === comment.file || d.old_path === comment.file
        );
        if (!diffFile) {
          console.warn(
            `[gitlab] File "${comment.file}" not found in diff, creating as general draft note`
          );
          await this.createDraftNote(
            projectId,
            mrIid,
            `**${comment.file}:${comment.line}** \u2013 ${commentBody}`
          );
          posted++;
          continue;
        }
        const diffLines = parseDiffLines(diffFile.diff);
        let lineInfo = diffLines.get(comment.line);
        if (!lineInfo) {
          const oldLine = computeOldLine(diffFile.diff, comment.line);
          lineInfo = { newLine: comment.line, oldLine };
          console.log(
            `[gitlab] Line ${comment.line} not in diff hunks for "${comment.file}", computed old_line=${oldLine} from hunk offsets`
          );
        }
        const position = {
          position_type: "text",
          base_sha: diffVersion.base_commit_sha,
          head_sha: diffVersion.head_commit_sha,
          start_sha: diffVersion.start_commit_sha,
          old_path: diffFile.old_path,
          new_path: diffFile.new_path,
          new_line: lineInfo.newLine,
          ...lineInfo.oldLine !== null && { old_line: lineInfo.oldLine }
        };
        const lineType = lineInfo.oldLine !== null ? "context" : "added";
        console.log(
          `[gitlab] Creating draft note: ${comment.file}:${comment.line} (${lineType}) old_line=${lineInfo.oldLine ?? "null"} new_line=${lineInfo.newLine} head=${diffVersion.head_commit_sha.slice(0, 8)}`
        );
        await this.createDraftDiffNote(
          projectId,
          mrIid,
          commentBody,
          position
        );
        posted++;
      } catch (err) {
        console.error(`[gitlab] Failed to create draft note for ${comment.file}:${comment.line}:`, err);
        failed++;
        try {
          await this.createDraftNote(
            projectId,
            mrIid,
            `**${comment.file}:${comment.line}** \u2013 ${comment.body}`
          );
          posted++;
          failed--;
        } catch {
        }
      }
    }
    if (posted > 0) {
      console.log(`[gitlab] Publishing review (${posted} draft note(s))...`);
      await this.publishAllDraftNotes(projectId, mrIid);
      console.log("[gitlab] Review submitted via bulk_publish.");
    }
    await this.postMergeRequestNote(projectId, mrIid, summary);
    return { posted, failed, skipped };
  }
};

// src/git.ts
import { execFile } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
function buildAuthUrl(gitHttpUrl, token) {
  const url = new URL(gitHttpUrl);
  url.username = "oauth2";
  url.password = token;
  return url.toString();
}
async function cloneRepository(gitHttpUrl, branch, gitlabToken) {
  const dir = await mkdtemp(join(tmpdir(), "gitlab-review-"));
  const authUrl = buildAuthUrl(gitHttpUrl, gitlabToken);
  console.log(`[git] Cloning ${gitHttpUrl} (branch: ${branch}) into ${dir}\u2026`);
  try {
    await execFileAsync("git", [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      branch,
      authUrl,
      dir
    ], {
      timeout: 12e4,
      // 2 minute timeout
      env: {
        ...process.env,
        // Prevent git from asking for credentials interactively
        GIT_TERMINAL_PROMPT: "0"
      }
    });
    console.log(`[git] Clone complete: ${dir}`);
    return {
      dir,
      cleanup: async () => {
        console.log(`[git] Cleaning up ${dir}`);
        await rm(dir, { recursive: true, force: true });
      }
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {
    });
    throw new Error(
      `Failed to clone repository: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// src/reviewer.ts
import { readFile as readFile4, access as access2 } from "node:fs/promises";
import { join as join5 } from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";

// src/prompts/review-system.ts
import { readFile } from "node:fs/promises";
import { join as join2 } from "node:path";
var PROMPT_FILE_CANDIDATES = [
  join2(process.cwd(), "src", "prompts", "review-system.md"),
  join2(process.cwd(), "prompts", "review-system.md")
];
async function loadReviewSystemPrompt() {
  for (const path of PROMPT_FILE_CANDIDATES) {
    try {
      const content = (await readFile(path, "utf-8")).trim();
      if (content.length > 0) {
        console.log(`[reviewer] Loaded review system prompt from ${path}`);
        return content;
      }
    } catch {
    }
  }
  throw new Error(
    "Review system prompt file not found or empty. Expected one of: " + PROMPT_FILE_CANDIDATES.join(", ")
  );
}

// src/prompts/comment-reply-system.ts
import { readFile as readFile2 } from "node:fs/promises";
import { join as join3 } from "node:path";
var PROMPT_FILE_CANDIDATES2 = [
  join3(process.cwd(), "src", "prompts", "comment-reply-system.md"),
  join3(process.cwd(), "prompts", "comment-reply-system.md")
];
async function loadCommentReplySystemPrompt() {
  for (const path of PROMPT_FILE_CANDIDATES2) {
    try {
      const content = (await readFile2(path, "utf-8")).trim();
      if (content.length > 0) {
        console.log(`[reviewer] Loaded comment reply system prompt from ${path}`);
        return content;
      }
    } catch {
    }
  }
  throw new Error(
    "Comment-reply system prompt file not found or empty. Expected one of: " + PROMPT_FILE_CANDIDATES2.join(", ")
  );
}

// src/prompts/build-prompts.ts
var REVIEW_CONTEXT_COMMENT_LIMIT = 30;
var REVIEW_CONTEXT_COMMENT_BODY_LIMIT = 500;
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\u2026`;
}
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}
function buildMrCommentsSection(mrComments) {
  if (!mrComments || mrComments.length === 0) {
    return "";
  }
  const recent = mrComments.slice(-REVIEW_CONTEXT_COMMENT_LIMIT);
  const entries = recent.map((comment) => {
    const location = comment.filePath ? `, ${comment.filePath}${comment.lineNumber ? `:${comment.lineNumber}` : ""}` : "";
    const body = truncate(
      normalizeWhitespace(comment.body),
      REVIEW_CONTEXT_COMMENT_BODY_LIMIT
    );
    return `- **${comment.author}** (${comment.createdAt}, ${comment.source}${location})
  ${body}`;
  }).join("\n");
  const truncatedNote = mrComments.length > recent.length ? `

> Showing the latest ${recent.length} of ${mrComments.length} MR comment message(s).` : "";
  return `## Existing MR Comment Context
${"Use this history to avoid repeating already-addressed findings and to incorporate author clarifications/replies."}


${entries}${truncatedNote}

`;
}
function buildDiffPrompt(mrTitle, mrDescription, mrUrl, sourceBranch, targetBranch, diffs, mrComments) {
  const filesDiff = diffs.filter((d) => !d.too_large && !d.collapsed).map((d) => {
    const status = d.new_file ? "(new file)" : d.deleted_file ? "(deleted)" : d.renamed_file ? `(renamed from ${d.old_path})` : "";
    return `### ${d.new_path} ${status}
\`\`\`diff
${d.diff}
\`\`\``;
  }).join("\n\n");
  const skipped = diffs.filter((d) => d.too_large || d.collapsed);
  const skippedNote = skipped.length > 0 ? `

> **Note**: ${skipped.length} file(s) were too large to include in the diff. You can read them directly from the working directory: ${skipped.map((d) => d.new_path).join(", ")}` : "";
  const mrCommentsSection = buildMrCommentsSection(mrComments);
  return `# Merge Request: ${mrTitle}
**Branch**: \`${sourceBranch}\` \u2192 \`${targetBranch}\`
**URL**: ${mrUrl}

## Description
${mrDescription || "(no description)"}

${mrCommentsSection}## Changed Files (${diffs.length} file(s))

${filesDiff}${skippedNote}

---

Please review the above changes. The full repository is available in your working directory \u2014 read related source files, imports, tests, documentation, and configuration to understand context before producing your review.

When done, call the **submit_review** tool with your review.`;
}
function buildCommentReplyPrompt(opts) {
  let prompt = `# Merge Request: ${opts.mrTitle}
**URL**: ${opts.mrUrl}

`;
  if (opts.filePath) {
    prompt += `## File Context
**File**: \`${opts.filePath}\``;
    if (opts.lineNumber) {
      prompt += ` (line ${opts.lineNumber})`;
    }
    prompt += "\n\n";
  }
  if (opts.diffContext) {
    prompt += `## Diff
\`\`\`diff
${opts.diffContext}
\`\`\`

`;
  }
  prompt += `## Discussion Thread

`;
  for (const msg of opts.threadMessages) {
    prompt += `**${msg.author}** (${msg.createdAt}):
${msg.body}

---

`;
  }
  prompt += `Please respond to the latest message in this discussion thread. Provide a helpful and specific answer.`;
  return prompt;
}

// src/jira-client.ts
var JiraClient = class {
  baseUrl;
  authHeader;
  constructor(jiraConfig) {
    this.baseUrl = `${jiraConfig.url}/rest/api/2`;
    const credentials = Buffer.from(
      `${jiraConfig.email}:${jiraConfig.apiToken}`
    ).toString("base64");
    this.authHeader = `Basic ${credentials}`;
  }
  async request(path) {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Jira API error: ${response.status} ${response.statusText} \u2013 ${text}`
      );
    }
    return response.json();
  }
  /**
   * Fetch issue details by key (e.g. "AO2-2624").
   */
  async getIssue(issueKey) {
    return this.request(
      `/issue/${issueKey}?fields=summary,description,status,issuetype,priority,labels,assignee,parent,epic,issuelinks,subtasks`
    );
  }
  /**
   * Fetch comments on an issue.
   */
  async getIssueComments(issueKey) {
    return this.request(
      `/issue/${issueKey}/comment?orderBy=created`
    );
  }
  /**
   * Fetch full context for an issue: details + comments.
   */
  async getIssueContext(issueKey) {
    const [issue, commentsResult] = await Promise.all([
      this.getIssue(issueKey),
      this.getIssueComments(issueKey)
    ]);
    let parent;
    if (issue.fields.parent) {
      const p = issue.fields.parent;
      parent = {
        key: p.key,
        summary: p.fields.summary,
        type: p.fields.issuetype.name,
        status: p.fields.status.name
      };
    } else if (issue.fields.epic) {
      parent = {
        key: issue.fields.epic.key,
        summary: issue.fields.epic.name,
        type: "Epic",
        status: "Unknown"
      };
    }
    const links = (issue.fields.issuelinks ?? []).map((link) => {
      if (link.outwardIssue) {
        return {
          relationship: link.type.outward,
          key: link.outwardIssue.key,
          summary: link.outwardIssue.fields.summary,
          type: link.outwardIssue.fields.issuetype.name,
          status: link.outwardIssue.fields.status.name
        };
      }
      const inward = link.inwardIssue;
      return {
        relationship: link.type.inward,
        key: inward.key,
        summary: inward.fields.summary,
        type: inward.fields.issuetype.name,
        status: inward.fields.status.name
      };
    });
    const subtasks = (issue.fields.subtasks ?? []).map((st) => ({
      key: st.key,
      summary: st.fields.summary,
      type: st.fields.issuetype.name,
      status: st.fields.status.name
    }));
    return {
      key: issue.key,
      summary: issue.fields.summary,
      type: issue.fields.issuetype.name,
      status: issue.fields.status.name,
      priority: issue.fields.priority?.name,
      assignee: issue.fields.assignee?.displayName ?? void 0,
      labels: issue.fields.labels,
      description: issue.fields.description,
      parent,
      links,
      subtasks,
      comments: commentsResult.comments.map((c) => ({
        author: c.author.displayName,
        body: c.body,
        created: c.created
      }))
    };
  }
};
function formatIssueContext(ctx) {
  let result = `### ${ctx.key}: ${ctx.summary}
`;
  result += `**Type**: ${ctx.type} | **Status**: ${ctx.status}`;
  if (ctx.priority) result += ` | **Priority**: ${ctx.priority}`;
  if (ctx.assignee) result += ` | **Assignee**: ${ctx.assignee}`;
  if (ctx.labels && ctx.labels.length > 0) {
    result += `
**Labels**: ${ctx.labels.join(", ")}`;
  }
  result += "\n";
  if (ctx.parent) {
    result += `
**Parent**: ${ctx.parent.key} \u2014 ${ctx.parent.summary} (${ctx.parent.type}, ${ctx.parent.status})`;
    result += `
_Use \`get_jira_issue("${ctx.parent.key}")\` to fetch full parent details._
`;
  }
  if (ctx.links.length > 0) {
    result += `
**Linked Issues** (${ctx.links.length}):
`;
    for (const link of ctx.links) {
      result += `- _${link.relationship}_ **${link.key}**: ${link.summary} (${link.type}, ${link.status})
`;
    }
  }
  if (ctx.subtasks.length > 0) {
    result += `
**Sub-tasks** (${ctx.subtasks.length}):
`;
    for (const st of ctx.subtasks) {
      result += `- **${st.key}**: ${st.summary} (${st.type}, ${st.status})
`;
    }
  }
  if (ctx.description) {
    result += `
**Description**:
${ctx.description}
`;
  }
  if (ctx.comments.length > 0) {
    result += `
**Comments** (${ctx.comments.length}):
`;
    for (const comment of ctx.comments) {
      const date = new Date(comment.created).toISOString().split("T")[0];
      result += `
> **${comment.author}** (${date}):
> ${comment.body.replace(/\n/g, "\n> ")}
`;
    }
  }
  return result;
}

// src/tools.ts
var SUBMIT_REVIEW_PARAMETERS = {
  type: "object",
  required: ["summary", "comments"],
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "A 2-4 sentence overall assessment of the MR, including what it does and your confidence level."
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
            description: "Path to the file being commented on."
          },
          line: {
            type: "integer",
            description: "The line number where the comment attaches (the discussion thread anchor)."
          },
          body: {
            type: "string",
            description: "Markdown description of the issue and suggested fix."
          },
          severity: {
            type: "string",
            enum: ["info", "warning", "critical"],
            description: "Severity of the issue."
          },
          suggestion: {
            type: "string",
            description: "Optional replacement code for the line(s). If provided, this will be rendered as a GitLab suggestion block."
          },
          startLine: {
            type: "integer",
            description: "Start of the range to replace (if suggestion spans multiple lines)."
          },
          endLine: {
            type: "integer",
            description: "End of the range to replace (if suggestion spans multiple lines)."
          }
        }
      }
    }
  }
};
function buildSubmitReviewTool() {
  let captured;
  const tool = {
    name: "submit_review",
    description: "Submit the final code review. Call this exactly once when your review is complete.",
    parameters: SUBMIT_REVIEW_PARAMETERS,
    handler: (args) => {
      captured = normalizeReviewResult(args);
      return "Review submitted successfully.";
    }
  };
  return { tool, getResult: () => captured };
}
var GET_JIRA_ISSUE_PARAMETERS = {
  type: "object",
  required: ["issueKey"],
  additionalProperties: false,
  properties: {
    issueKey: {
      type: "string",
      description: "The Jira issue key (e.g. PROJ-123, AO2-2624)."
    }
  }
};
function buildJiraIssueTool(config) {
  if (!config.jira) return void 0;
  const client = new JiraClient(config.jira);
  return {
    name: "get_jira_issue",
    description: "Fetch a Jira issue's details, including summary, description, status, priority, labels, and comments. Use this when you see Jira issue keys (e.g. PROJ-123) in the MR title, branch name, description, or code.",
    parameters: GET_JIRA_ISSUE_PARAMETERS,
    handler: async (args) => {
      const key = args.issueKey.trim().toUpperCase();
      console.log(`[jira] Tool call: fetching ${key}`);
      try {
        const ctx = await client.getIssueContext(key);
        console.log(`[jira] Fetched ${key}: "${ctx.summary}" (${ctx.comments.length} comments)`);
        return formatIssueContext(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[jira] Failed to fetch ${key}: ${msg}`);
        return { resultType: "failure", textResultForLlm: `Failed to fetch Jira issue ${key}: ${msg}`, error: msg };
      }
    }
  };
}
function normalizeReviewResult(raw) {
  if (typeof raw.summary !== "string") {
    raw.summary = "";
  }
  if (!Array.isArray(raw.comments)) {
    raw.comments = [];
  }
  raw.comments = raw.comments.filter(
    (c) => typeof c.file === "string" && typeof c.line === "number" && typeof c.body === "string"
  ).map((c) => ({
    file: c.file,
    line: c.line,
    body: c.body,
    severity: ["info", "warning", "critical"].includes(c.severity) ? c.severity : "info",
    suggestion: typeof c.suggestion === "string" ? c.suggestion : void 0,
    startLine: typeof c.startLine === "number" ? c.startLine : void 0,
    endLine: typeof c.endLine === "number" ? c.endLine : void 0
  }));
  return raw;
}
function parseReviewResponse(content) {
  let cleaned = content.trim();
  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*)\s*```/);
  if (jsonBlockMatch) {
    cleaned = jsonBlockMatch[1].trim();
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
    return normalizeReviewResult(JSON.parse(cleaned));
  } catch (err) {
    console.error("[reviewer] Failed to parse Copilot response as JSON:", err);
    console.error("[reviewer] Raw response:", content);
    return {
      summary: content,
      comments: []
    };
  }
}

// src/mcp/config-loader.ts
import { access, readFile as readFile3 } from "node:fs/promises";
import { join as join4 } from "node:path";
function interpolateString(value, replacements) {
  return value.replace(/\$\{([^}]+)\}/g, (match, key) => {
    return replacements[key] ?? match;
  });
}
function interpolateValue(value, replacements) {
  if (typeof value === "string") {
    return interpolateString(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        interpolateValue(nested, replacements)
      ])
    );
  }
  return value;
}
function normalizeServers(servers) {
  const normalizedEntries = Object.entries(servers).map(([name, raw]) => {
    const server = { ...raw };
    if (!Array.isArray(server["tools"])) {
      server["tools"] = ["*"];
    }
    return [name, server];
  });
  return Object.fromEntries(normalizedEntries);
}
async function buildMcpServers(repoDir) {
  const configPath = join4(process.cwd(), "mcp.json");
  try {
    await access(configPath);
  } catch {
    return void 0;
  }
  const raw = await readFile3(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.servers || Object.keys(parsed.servers).length === 0) {
    return void 0;
  }
  const interpolated = interpolateValue(parsed.servers, {
    repoDir,
    workspaceFolder: repoDir
  });
  const mcpServers = normalizeServers(interpolated);
  console.log(`[reviewer] Loaded MCP config from mcp.json (${Object.keys(mcpServers).length} server(s))`);
  return mcpServers;
}

// src/session-hooks.ts
function truncate2(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\u2026";
}
function toLogString(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function buildSessionHooks() {
  return {
    onPreToolUse: async (input) => {
      const argsStr = truncate2(JSON.stringify(input.toolArgs), 300);
      console.log(`[copilot] \u25B6 tool: ${input.toolName}  args: ${argsStr}`);
      return { permissionDecision: "allow" };
    }
  };
}
function attachSessionListeners(session, logLevel) {
  const isDebug = logLevel === "debug";
  const unsubscribers = [];
  const activeToolCalls = /* @__PURE__ */ new Map();
  let wroteAssistantMessageDelta = false;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalModelMultiplier: 0,
    requestCount: 0
  };
  unsubscribers.push(
    session.on("assistant.usage", (event) => {
      usage.inputTokens += event.data.inputTokens ?? 0;
      usage.outputTokens += event.data.outputTokens ?? 0;
      usage.cacheReadTokens += event.data.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.data.cacheWriteTokens ?? 0;
      usage.totalModelMultiplier += event.data.cost ?? 0;
      const usedRequests = event.data.quotaSnapshots?.usedRequests;
      if (usedRequests !== void 0) {
        if (usage.firstUsedRequests === void 0) {
          usage.firstUsedRequests = usedRequests;
        }
        usage.lastUsedRequests = usedRequests;
      }
      usage.requestCount++;
      if (isDebug) {
        console.log(
          `[copilot] usage: +${event.data.inputTokens ?? 0} in, +${event.data.outputTokens ?? 0} out, multiplier: ${event.data.cost?.toFixed(4) ?? "N/A"}, quotaSnapshots.usedRequests: ${usedRequests ?? "N/A"} (model: ${event.data.model})`
        );
      }
    })
  );
  if (isDebug) {
    unsubscribers.push(
      session.on("assistant.reasoning_delta", (event) => {
        process.stderr.write(event.data.deltaContent);
      })
    );
    unsubscribers.push(
      session.on("assistant.message_delta", (event) => {
        wroteAssistantMessageDelta = true;
        process.stdout.write(event.data.deltaContent);
      })
    );
    unsubscribers.push(
      session.on("assistant.turn_end", () => {
        if (wroteAssistantMessageDelta) {
          process.stdout.write("\n");
          wroteAssistantMessageDelta = false;
        }
      })
    );
  }
  unsubscribers.push(
    session.on("session.error", (event) => {
      console.error(`[copilot] \u2716 error: ${event.data.message}`);
    })
  );
  if (isDebug) {
    unsubscribers.push(
      session.on("tool.execution_start", (event) => {
        const startedAtMs = Date.parse(event.timestamp);
        activeToolCalls.set(event.data.toolCallId, {
          toolName: event.data.toolName,
          startedAtMs: Number.isNaN(startedAtMs) ? Date.now() : startedAtMs
        });
      })
    );
    unsubscribers.push(
      session.on("tool.execution_complete", (event) => {
        const started = activeToolCalls.get(event.data.toolCallId);
        if (started) {
          activeToolCalls.delete(event.data.toolCallId);
        }
        const finishedAtMs = Date.parse(event.timestamp);
        const finished = Number.isNaN(finishedAtMs) ? Date.now() : finishedAtMs;
        const elapsedMs = started ? Math.max(0, finished - started.startedAtMs) : void 0;
        const toolName = started?.toolName ?? `toolCall:${event.data.toolCallId}`;
        const timing = elapsedMs !== void 0 ? `, ${elapsedMs}ms` : "";
        const resultPayload = event.data.success ? event.data.result : event.data.error?.message ?? event.data.result ?? "Tool execution failed";
        const resultStr = truncate2(toLogString(resultPayload), 500);
        console.log(`[copilot] \u25C0 result (${toolName}${timing}): ${resultStr}`);
      })
    );
  }
  unsubscribers.push(
    session.on("session.idle", () => {
      console.log(`[copilot] session idle`);
    })
  );
  return {
    detach: () => {
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
        }
      }
      activeToolCalls.clear();
    },
    getUsage: () => usage
  };
}

// src/reviewer.ts
var COPILOT_INSTRUCTIONS_PATHS = [
  ".github/copilot-instructions.md",
  ".gitlab/copilot-instructions.md",
  "copilot-instructions.md"
];
var AGENTS_PATHS = [
  ".github/agents.md",
  ".gitlab/agents.md",
  "agents.md"
];
var SKILLS_DIRS = [
  ".github/skills",
  ".claude/skills",
  ".agents/skills"
];
async function loadFirstFound(repoDir, candidates) {
  for (const relPath of candidates) {
    try {
      const content = await readFile4(join5(repoDir, relPath), "utf-8");
      return { path: relPath, content: content.trim() };
    } catch {
    }
  }
  return void 0;
}
async function findSkillDirectories(repoDir) {
  const dirs = [];
  for (const dir of SKILLS_DIRS) {
    try {
      await access2(join5(repoDir, dir));
      dirs.push(join5(repoDir, dir));
    } catch {
    }
  }
  return dirs;
}
async function loadProjectInstructions(repoDir) {
  const [copilot, agents, skillDirectories] = await Promise.all([
    loadFirstFound(repoDir, COPILOT_INSTRUCTIONS_PATHS),
    loadFirstFound(repoDir, AGENTS_PATHS),
    findSkillDirectories(repoDir)
  ]);
  if (copilot) {
    console.log(`[reviewer] Loaded copilot-instructions from ${copilot.path}`);
  }
  if (agents) {
    console.log(`[reviewer] Loaded agents instructions from ${agents.path}`);
  }
  if (skillDirectories.length > 0) {
    console.log(
      `[reviewer] Found skill directories: ${skillDirectories.join(", ")}`
    );
  }
  return {
    copilotInstructions: copilot?.content,
    agentsInstructions: agents?.content,
    skillDirectories
  };
}
async function createOrResumeSession(client, sessionId, config, repoDir, systemPrompt, skillDirectories, tools, mcpServers) {
  const baseSessionConfig = {
    model: config.copilotModel,
    configDir: config.copilotConfigDir,
    onPermissionRequest: approveAll,
    workingDirectory: repoDir,
    systemMessage: {
      mode: "append",
      content: systemPrompt
    },
    infiniteSessions: { enabled: true },
    ...tools && { tools },
    ...mcpServers && { mcpServers },
    ...skillDirectories.length > 0 && { skillDirectories },
    hooks: buildSessionHooks()
  };
  try {
    const resumed = await client.resumeSession(sessionId, baseSessionConfig);
    console.log(`[reviewer] Resumed session: ${sessionId}`);
    return resumed;
  } catch {
    const created = await client.createSession({
      ...baseSessionConfig,
      sessionId
    });
    console.log(`[reviewer] Created new session: ${sessionId}`);
    return created;
  }
}
async function reviewMergeRequest(opts) {
  console.log(`[reviewer] \u{1F50D} Reviewing MR: "${opts.mrTitle}"`);
  const { config, repoDir, diffVersion } = opts;
  const { copilotInstructions, agentsInstructions, skillDirectories } = await loadProjectInstructions(repoDir);
  let systemPrompt = await loadReviewSystemPrompt();
  if (copilotInstructions) {
    systemPrompt += `

## Project-Specific Instructions (copilot-instructions.md)

The repository contains a \`copilot-instructions.md\` file. Follow these guidelines in addition to the rules above:

` + copilotInstructions;
  }
  if (agentsInstructions) {
    systemPrompt += `

## Agent Instructions (agents.md)

The repository contains an \`agents.md\` file with additional instructions for AI agents. Follow these guidelines:

` + agentsInstructions;
  }
  const client = new CopilotClient({
    githubToken: config.githubToken
  });
  const { tool: submitReviewTool, getResult } = buildSubmitReviewTool();
  const jiraTool = buildJiraIssueTool(config);
  const customTools = jiraTool ? [submitReviewTool, jiraTool] : [submitReviewTool];
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
      mcpServers
    );
    const { detach, getUsage } = attachSessionListeners(session, config.logLevel);
    console.log(`[reviewer] Session created with model: ${config.copilotModel}`);
    const userPrompt = buildDiffPrompt(
      opts.mrTitle,
      opts.mrDescription,
      opts.mrUrl,
      opts.sourceBranch,
      opts.targetBranch,
      diffVersion.diffs,
      opts.mrComments
    );
    console.log(
      `[reviewer] Sending ${diffVersion.diffs.length} file(s) for review (prompt length: ${userPrompt.length} chars, workingDir: ${repoDir})`
    );
    const usageBeforeReview = getUsage();
    console.log(
      `[reviewer] Quota before review: quotaSnapshots.usedRequests=${usageBeforeReview.lastUsedRequests ?? "N/A"}`
    );
    const response = await session.sendAndWait({
      prompt: userPrompt
    }, 6e5);
    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got response (${responseContent.length} chars)`);
    const usage = getUsage();
    console.log(
      `[reviewer] Usage: ${usage.requestCount} request(s), ${usage.inputTokens} input + ${usage.outputTokens} output tokens` + (usage.cacheReadTokens > 0 ? ` (${usage.cacheReadTokens} cached)` : "") + (usage.totalModelMultiplier > 0 ? `, total model multiplier: ${usage.totalModelMultiplier.toFixed(4)}` : "")
    );
    console.log(
      `[reviewer] Quota after review: quotaSnapshots.usedRequests=${usage.lastUsedRequests ?? "N/A"}`
    );
    detach();
    await session.destroy();
    await client.stop();
    const toolResult = getResult();
    if (toolResult) {
      console.log(
        `[reviewer] Review captured via submit_review tool call (${toolResult.comments.length} comment(s))`
      );
      return toolResult;
    }
    console.warn(
      "[reviewer] Model did not call submit_review tool \u2014 falling back to text parsing"
    );
    return parseReviewResponse(responseContent);
  } catch (err) {
    try {
      await client.stop();
    } catch {
    }
    throw err;
  }
}
async function replyToComment(opts) {
  console.log(`[reviewer] \u{1F4AC} Replying to comment on MR: "${opts.mrTitle}"`);
  const { config, repoDir } = opts;
  const { copilotInstructions, agentsInstructions, skillDirectories } = await loadProjectInstructions(repoDir);
  let systemPrompt = await loadCommentReplySystemPrompt();
  if (copilotInstructions) {
    systemPrompt += `

## Project-Specific Instructions (copilot-instructions.md)

` + copilotInstructions;
  }
  if (agentsInstructions) {
    systemPrompt += `

## Agent Instructions (agents.md)

` + agentsInstructions;
  }
  const client = new CopilotClient({
    githubToken: config.githubToken
  });
  try {
    const jiraTool = buildJiraIssueTool(config);
    const customTools = jiraTool ? [jiraTool] : void 0;
    const mcpServers = await buildMcpServers(repoDir);
    const session = await createOrResumeSession(
      client,
      opts.sessionId,
      config,
      repoDir,
      systemPrompt,
      skillDirectories,
      customTools,
      mcpServers
    );
    const { detach, getUsage } = attachSessionListeners(session, config.logLevel);
    console.log(`[reviewer] Comment reply session created with model: ${config.copilotModel}`);
    const prompt = buildCommentReplyPrompt({
      mrTitle: opts.mrTitle,
      mrUrl: opts.mrUrl,
      filePath: opts.filePath,
      lineNumber: opts.lineNumber,
      diffContext: opts.diffContext,
      threadMessages: opts.threadMessages
    });
    console.log(
      `[reviewer] Sending comment reply request (${opts.threadMessages.length} messages in thread, prompt: ${prompt.length} chars)`
    );
    const response = await session.sendAndWait({
      prompt
    }, 6e5);
    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got reply (${responseContent.length} chars)`);
    const usage = getUsage();
    console.log(
      `[reviewer] Usage: ${usage.requestCount} request(s), ${usage.inputTokens} input + ${usage.outputTokens} output tokens` + (usage.cacheReadTokens > 0 ? ` (${usage.cacheReadTokens} cached)` : "") + (usage.totalModelMultiplier > 0 ? `, total model multiplier: ${usage.totalModelMultiplier.toFixed(4)}` : "")
    );
    detach();
    await session.destroy();
    await client.stop();
    return responseContent.trim();
  } catch (err) {
    try {
      await client.stop();
    } catch {
    }
    throw err;
  }
}

// src/auto-add-reviewer.ts
async function autoAddBotReviewerIfMissing(payload, config, gitlab) {
  if (!config.gitlabAutoAddReviewer) {
    return false;
  }
  const botAlreadyReviewer = payload.reviewers?.some(
    (reviewer) => reviewer.username === config.gitlabBotUsername
  );
  if (botAlreadyReviewer) {
    return false;
  }
  const projectId = payload.project.id;
  const mrIid = payload.object_attributes.iid;
  try {
    const botUser = await gitlab.findUserByUsername(config.gitlabBotUsername);
    if (!botUser) {
      console.warn(
        `[review] Auto-add reviewer enabled, but user "${config.gitlabBotUsername}" was not found in GitLab.`
      );
      return false;
    }
    const existingIds = /* @__PURE__ */ new Set([
      ...payload.object_attributes.reviewer_ids ?? [],
      ...(payload.reviewers ?? []).map((reviewer) => reviewer.id)
    ]);
    if (existingIds.has(botUser.id)) {
      return false;
    }
    const updatedReviewerIds = [...existingIds, botUser.id];
    await gitlab.updateMergeRequestReviewers(projectId, mrIid, updatedReviewerIds);
    console.log(
      `[review] Auto-added @${config.gitlabBotUsername} as reviewer for MR !${mrIid}.`
    );
    return true;
  } catch (err) {
    console.warn(
      `[review] Failed to auto-add reviewer @${config.gitlabBotUsername}:`,
      err
    );
    return false;
  }
}

// src/webhook.ts
function classifyWebhookEvent(payload, botUsername) {
  if (payload.object_kind === "merge_request") {
    if (shouldTriggerReview(payload, botUsername)) {
      return { type: "review", payload };
    }
    return { type: "ignore", reason: "MR event did not match trigger conditions" };
  }
  if (payload.object_kind === "note") {
    if (shouldRespondToComment(payload, botUsername)) {
      return { type: "comment_reply", payload };
    }
    return { type: "ignore", reason: "Note event did not match reply conditions" };
  }
  return { type: "ignore", reason: `Unhandled event type: ${payload.object_kind}` };
}
function shouldTriggerReview(payload, botUsername) {
  if (payload.object_kind !== "merge_request") {
    console.log("[webhook] Ignoring non-MR event:", payload.object_kind);
    return false;
  }
  const action = payload.object_attributes.action;
  const botUser = payload.reviewers?.find(
    (r) => r.username === botUsername
  );
  if (!botUser) {
    console.log("[webhook] Bot user not found in reviewers list");
    console.log(`[webhook] Looking for username: "${botUsername}"`);
    console.log(`[webhook] Available usernames: ${payload.reviewers?.map((r) => `"${r.username}"`).join(", ") ?? "none"}`);
    return false;
  }
  if (payload.object_attributes.draft || payload.object_attributes.work_in_progress) {
    console.log("[webhook] Ignoring draft MR");
    return false;
  }
  if (action === "open") {
    console.log(
      `[webhook] Review triggered: MR opened with bot as reviewer for MR !${payload.object_attributes.iid} in ${payload.project.path_with_namespace}`
    );
    return true;
  }
  if (action !== "update") {
    console.log("[webhook] Ignoring MR action:", action);
    return false;
  }
  const reviewerChanges = payload.changes?.reviewers ?? payload.changes?.reviewer_ids;
  if (reviewerChanges) {
    const previousIds = Array.isArray(reviewerChanges.previous) ? reviewerChanges.previous.map((r) => typeof r === "number" ? r : r.id) : [];
    const currentIds = Array.isArray(reviewerChanges.current) ? reviewerChanges.current.map((r) => typeof r === "number" ? r : r.id) : [];
    const wasAlreadyReviewer = previousIds.includes(botUser.id);
    const isNowReviewer = currentIds.includes(botUser.id);
    if (isNowReviewer && !wasAlreadyReviewer) {
      console.log(
        `[webhook] Review triggered: Bot newly added as reviewer for MR !${payload.object_attributes.iid} in ${payload.project.path_with_namespace}`
      );
      return true;
    }
    if (isNowReviewer && wasAlreadyReviewer) {
      const botInCurrent = Array.isArray(reviewerChanges.current) ? reviewerChanges.current.find((r) => (typeof r === "number" ? r : r.id) === botUser.id) : void 0;
      if (botInCurrent && typeof botInCurrent === "object" && botInCurrent.re_requested === true) {
        console.log(
          `[webhook] Review triggered: Review re-requested for MR !${payload.object_attributes.iid} in ${payload.project.path_with_namespace}`
        );
        return true;
      }
    }
  }
  const draftChanges = payload.changes?.draft;
  const wipChanges = payload.changes?.work_in_progress;
  if (draftChanges) {
    const wasDraft = draftChanges.previous === true;
    const isNowDraft = draftChanges.current === true;
    if (wasDraft && !isNowDraft) {
      console.log(
        `[webhook] Review triggered: Draft status changed for MR !${payload.object_attributes.iid} in ${payload.project.path_with_namespace}`
      );
      return true;
    }
  }
  if (wipChanges) {
    const wasWip = wipChanges.previous === true;
    const isNowWip = wipChanges.current === true;
    if (wasWip && !isNowWip) {
      console.log(
        `[webhook] Review triggered: WIP status changed for MR !${payload.object_attributes.iid} in ${payload.project.path_with_namespace}`
      );
      return true;
    }
  }
  console.log("[webhook] No trigger conditions met (not bot added, and not draft\u2192non-draft transition)");
  return false;
}
function shouldRespondToComment(payload, botUsername) {
  if (payload.object_kind !== "note") {
    return false;
  }
  if (payload.object_attributes.noteable_type !== "MergeRequest") {
    console.log("[webhook] Ignoring note on non-MR:", payload.object_attributes.noteable_type);
    return false;
  }
  if (!payload.merge_request) {
    console.log("[webhook] Note event missing merge_request context");
    return false;
  }
  if (payload.user.username === botUsername) {
    console.log("[webhook] Ignoring note from bot itself");
    return false;
  }
  const mentionPattern = `@${botUsername}`;
  if (!payload.object_attributes.note.includes(mentionPattern)) {
    console.log(`[webhook] Note does not mention ${mentionPattern}`);
    return false;
  }
  console.log(
    `[webhook] Comment reply triggered: @${botUsername} mentioned in discussion ${payload.object_attributes.discussion_id} on MR !${payload.merge_request.iid}`
  );
  return true;
}

// src/index.ts
async function loadTriggerPayload() {
  const payloadPath = process.env["TRIGGER_PAYLOAD"];
  if (!payloadPath) {
    throw new Error(
      "TRIGGER_PAYLOAD variable not set. This job must be triggered via a webhook pipeline trigger."
    );
  }
  const raw = await readFile5(payloadPath, "utf-8");
  return JSON.parse(raw);
}
async function main() {
  console.log("[review] Starting Copilot code review\u2026");
  const payload = await loadTriggerPayload();
  console.log(
    `[review] Received ${payload.object_kind} event`
  );
  const config = loadConfig();
  if (payload.object_kind === "merge_request") {
    const wasAutoAdded = await autoAddBotReviewerIfMissing(
      payload,
      config,
      new GitLabClient(config)
    );
    if (wasAutoAdded) {
      console.log(
        "[review] Reviewer assignment updated. Waiting for follow-up webhook event to run review."
      );
      return;
    }
  }
  const event = classifyWebhookEvent(payload, config.gitlabBotUsername);
  if (event.type === "ignore") {
    console.log(`[review] Event ignored: ${event.reason}`);
    return;
  }
  if (event.type === "comment_reply") {
    await handleCommentReply(event.payload, config);
    return;
  }
  await handleMergeRequestReview(event.payload, config);
}
function buildMergeRequestSessionId(projectId, mrIid) {
  return `gitlab-mr-${projectId}-${mrIid}`;
}
function buildCiJobLogMessage() {
  const ciJobUrl = process.env["CI_JOB_URL"];
  return ciJobUrl ? `Check the [CI job log](${ciJobUrl}).` : "Check the CI job log.";
}
async function handleCommentReply(payload, config) {
  const projectId = payload.project.id;
  const mr = payload.merge_request;
  const mrIid = mr.iid;
  const discussionId = payload.object_attributes.discussion_id;
  const httpUrl = payload.project.http_url;
  const sourceBranch = mr.source_branch;
  const sessionId = buildMergeRequestSessionId(projectId, mrIid);
  console.log(
    `[review] Responding to comment in discussion ${discussionId} on MR !${mrIid} in ${payload.project.path_with_namespace}`
  );
  const gitlab = new GitLabClient(config);
  let cleanup;
  try {
    console.log("[review] Fetching discussion thread\u2026");
    const notes = await gitlab.getDiscussionNotes(projectId, mrIid, discussionId);
    console.log(`[review] Thread has ${notes.length} message(s)`);
    const threadMessages = notes.map((note) => ({
      author: note.author.username,
      body: note.body,
      createdAt: note.created_at
    }));
    const position = payload.object_attributes.position;
    const filePath = position?.new_path;
    const lineNumber = position?.new_line ?? void 0;
    let diffContext;
    if (filePath) {
      try {
        const diffVersion = await gitlab.getLatestDiffs(projectId, mrIid);
        const diffFile = diffVersion.diffs.find(
          (d) => d.new_path === filePath || d.old_path === filePath
        );
        if (diffFile) {
          diffContext = diffFile.diff;
        }
      } catch {
        console.warn("[review] Could not fetch diff context, continuing without it");
      }
    }
    console.log("[review] Cloning target repository\u2026");
    const clone = await cloneRepository(httpUrl, sourceBranch, config.gitlabToken);
    cleanup = clone.cleanup;
    console.log(`[review] Cloned to ${clone.dir}`);
    console.log("[review] Generating Copilot reply\u2026");
    const reply = await replyToComment({
      config,
      repoDir: clone.dir,
      sessionId,
      threadMessages,
      filePath,
      lineNumber,
      diffContext,
      mrTitle: mr.title,
      mrUrl: mr.url
    });
    if (!reply) {
      console.log("[review] Empty reply from Copilot, skipping.");
      return;
    }
    console.log("[review] Posting reply to discussion\u2026");
    await gitlab.replyToDiscussion(projectId, mrIid, discussionId, reply);
    console.log("[review] Reply posted successfully.");
  } catch (err) {
    console.error("[review] Comment reply failed:", err);
    try {
      await gitlab.replyToDiscussion(
        projectId,
        mrIid,
        discussionId,
        `\u26A0\uFE0F Failed to generate a reply. ${buildCiJobLogMessage()}

\`\`\`
${err instanceof Error ? err.message : String(err)}
\`\`\``
      );
    } catch {
    }
    process.exitCode = 1;
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupErr) {
        console.warn("[review] Clone cleanup failed:", cleanupErr);
      }
    }
  }
}
async function handleMergeRequestReview(payload, config) {
  const projectId = payload.project.id;
  const mrIid = payload.object_attributes.iid;
  const mrTitle = payload.object_attributes.title;
  const mrDescription = payload.object_attributes.description ?? "";
  const sourceBranch = payload.object_attributes.source_branch;
  const targetBranch = payload.object_attributes.target_branch;
  const projectUrl = payload.project.web_url;
  const httpUrl = payload.project.http_url;
  const mrUrl = `${projectUrl}/-/merge_requests/${mrIid}`;
  const sessionId = buildMergeRequestSessionId(projectId, mrIid);
  console.log(
    `[review] MR !${mrIid} in project ${projectId}: ${mrTitle}
[review] ${sourceBranch} \u2192 ${targetBranch}`
  );
  const gitlab = new GitLabClient(config);
  let cleanup;
  try {
    console.log("[review] Cloning target repository\u2026");
    const clone = await cloneRepository(httpUrl, sourceBranch, config.gitlabToken);
    cleanup = clone.cleanup;
    console.log(`[review] Cloned to ${clone.dir}`);
    console.log("[review] Fetching MR diffs\u2026");
    const diffVersion = await gitlab.getLatestDiffs(projectId, mrIid);
    console.log(
      `[review] Got ${diffVersion.diffs.length} changed file(s), version ${diffVersion.id}`
    );
    if (diffVersion.diffs.length === 0) {
      await gitlab.postMergeRequestNote(
        projectId,
        mrIid,
        "\u{1F916} **Copilot Review**: No file changes detected in this MR."
      );
      console.log("[review] No diffs to review.");
      return;
    }
    let mrComments = [];
    try {
      console.log("[review] Fetching MR comment context\u2026");
      mrComments = await gitlab.getMergeRequestCommentContext(projectId, mrIid);
      console.log(`[review] Got ${mrComments.length} comment message(s) for context`);
    } catch (err) {
      console.warn("[review] Could not fetch MR comment context, continuing without it", err);
    }
    console.log("[review] Running Copilot review\u2026");
    const review = await reviewMergeRequest({
      config,
      repoDir: clone.dir,
      sessionId,
      mrTitle,
      mrDescription,
      mrUrl,
      sourceBranch,
      targetBranch,
      diffVersion,
      mrComments
    });
    console.log(
      `[review] Review complete: ${review.comments.length} comment(s)`
    );
    console.log("[review] Posting review to GitLab\u2026");
    const summaryBody = `## \u{1F916} Copilot Code Review

${review.summary}

---
_${review.comments.length} comment(s) reviewed._`;
    const { posted, failed, skipped } = await gitlab.postReview(
      projectId,
      mrIid,
      summaryBody,
      review.comments,
      diffVersion
    );
    console.log(
      `[review] Done: ${posted} comment(s) posted, ${skipped} skipped (duplicate), ${failed} failed`
    );
    if (failed > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("[review] Review failed:", err);
    try {
      await gitlab.postMergeRequestNote(
        projectId,
        mrIid,
        `\u{1F916} **Copilot Review**: Review failed with an error. ${buildCiJobLogMessage()}

\`\`\`
${err instanceof Error ? err.message : String(err)}
\`\`\``
      );
    } catch {
    }
    process.exitCode = 1;
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupErr) {
        console.warn("[review] Clone cleanup failed:", cleanupErr);
      }
    }
  }
}
main();
