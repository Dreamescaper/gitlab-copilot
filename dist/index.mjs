#!/usr/bin/env node

// src/index.ts
import { readFile as readFile2 } from "node:fs/promises";

// src/config.ts
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
function loadConfig() {
  const gitlabUrl = process.env["CI_SERVER_URL"] ?? process.env["GITLAB_URL"];
  if (!gitlabUrl) {
    throw new Error("Missing GitLab URL: CI_SERVER_URL or GITLAB_URL must be set");
  }
  return {
    gitlabUrl: gitlabUrl.replace(/\/+$/, ""),
    gitlabToken: requireEnv("GITLAB_TOKEN"),
    gitlabBotUsername: requireEnv("GITLAB_BOT_USERNAME"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    copilotModel: process.env["COPILOT_MODEL"] ?? "gpt-4.1",
    logLevel: process.env["LOG_LEVEL"] ?? "info"
  };
}

// src/gitlab-client.ts
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
      const text = await response.text();
      throw new Error(
        `GitLab API error: ${response.status} ${response.statusText} \u2013 ${text}`
      );
    }
    return response.json();
  }
  // ─── Merge Request Diffs ──────────────────────────────────────────────────
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
   * Post an inline discussion (diff comment) on a merge request.
   */
  async postDiffDiscussion(projectId, mrIid, body, position) {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`,
      { body, position }
    );
  }
  /**
   * Post all review comments to a merge request.
   *
   * - Fetches existing discussions/notes to avoid duplicates
   * - Inline comments are posted as diff discussions on the specific file/line.
   * - A summary note is posted as a regular MR note.
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
        const diffFile = diffVersion.diffs.find(
          (d) => d.new_path === comment.file || d.old_path === comment.file
        );
        if (!diffFile) {
          console.warn(
            `[gitlab] File "${comment.file}" not found in diff, posting as general note`
          );
          if (commentExists(comment.file, comment.line, comment.body)) {
            skipped++;
            continue;
          }
          await this.postMergeRequestNote(
            projectId,
            mrIid,
            `**${comment.file}:${comment.line}** \u2013 ${comment.body}`
          );
          posted++;
          continue;
        }
        const position = {
          position_type: "text",
          base_sha: diffVersion.base_commit_sha,
          head_sha: diffVersion.head_commit_sha,
          start_sha: diffVersion.start_commit_sha,
          old_path: diffFile.old_path,
          new_path: diffFile.new_path,
          new_line: comment.line
        };
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
        await this.postDiffDiscussion(
          projectId,
          mrIid,
          commentBody,
          position
        );
        posted++;
      } catch (err) {
        console.error(`[gitlab] Failed to post comment on ${comment.file}:${comment.line}:`, err);
        failed++;
        try {
          await this.postMergeRequestNote(
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
import { readFile } from "node:fs/promises";
import { join as join2 } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
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
async function loadFirstFound(repoDir, candidates) {
  for (const relPath of candidates) {
    try {
      const content = await readFile(join2(repoDir, relPath), "utf-8");
      return { path: relPath, content: content.trim() };
    } catch {
    }
  }
  return void 0;
}
async function loadProjectInstructions(repoDir) {
  const [copilot, agents] = await Promise.all([
    loadFirstFound(repoDir, COPILOT_INSTRUCTIONS_PATHS),
    loadFirstFound(repoDir, AGENTS_PATHS)
  ]);
  if (copilot) {
    console.log(`[reviewer] Loaded copilot-instructions from ${copilot.path}`);
  }
  if (agents) {
    console.log(`[reviewer] Loaded agents instructions from ${agents.path}`);
  }
  return {
    copilotInstructions: copilot?.content,
    agentsInstructions: agents?.content
  };
}
var REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer performing a review on a GitLab Merge Request.

You will be given a diff of the changes. The full repository source code is available in your working directory \u2014 you can and should read related files to understand the broader context.

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

1. **Security vulnerabilities** \u2013 SQL injection, XSS, secrets in code, auth issues, unsafe deserialization
2. **Bugs & logic errors** \u2013 off-by-one, null/undefined references, race conditions, incorrect conditionals, unhandled edge cases
3. **Performance issues** \u2013 N+1 queries, memory leaks, unnecessary allocations, blocking calls in async code
4. **Code quality** \u2013 naming, readability, DRY violations, dead code, missing abstractions
5. **Best practices** \u2013 error handling, input validation, logging, test coverage gaps
6. **API design** \u2013 backward compatibility, consistent naming, proper HTTP methods/status codes
7. **Consistency** \u2013 does the change follow existing patterns and conventions in the codebase?

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
- Read the actual source to verify your assumptions \u2014 don't guess about what existing code does.

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
function buildDiffPrompt(mrTitle, mrDescription, mrUrl, sourceBranch, targetBranch, diffs) {
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
  return `# Merge Request: ${mrTitle}
**Branch**: \`${sourceBranch}\` \u2192 \`${targetBranch}\`
**URL**: ${mrUrl}

## Description
${mrDescription || "(no description)"}

## Changed Files (${diffs.length} file(s))

${filesDiff}${skippedNote}

---

Please review the above changes. The full repository is available in your working directory \u2014 read related source files, imports, tests, documentation, and configuration to understand context before producing your review.

When done, output your review as JSON.`;
}
function parseReviewResponse(content) {
  let cleaned = content.trim();
  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    cleaned = jsonBlockMatch[1].trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.summary !== "string") {
      throw new Error("Missing 'summary' field");
    }
    if (!Array.isArray(parsed.comments)) {
      parsed.comments = [];
    }
    parsed.comments = parsed.comments.filter(
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
    return parsed;
  } catch (err) {
    console.error("[reviewer] Failed to parse Copilot response as JSON:", err);
    console.error("[reviewer] Raw response:", content);
    return {
      summary: content,
      comments: []
    };
  }
}
async function reviewMergeRequest(opts) {
  const { config, repoDir, diffVersion } = opts;
  const { copilotInstructions, agentsInstructions } = await loadProjectInstructions(repoDir);
  let systemPrompt = REVIEW_SYSTEM_PROMPT;
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
  try {
    const session = await client.createSession({
      model: config.copilotModel,
      workingDirectory: repoDir,
      systemMessage: {
        mode: "append",
        content: systemPrompt
      },
      // Auto-approve all tool calls — they are read-only operations
      // on a temporary clone that gets deleted after the review.
      onPermissionRequest: async () => ({ kind: "approved" })
    });
    console.log(`[reviewer] Session created with model: ${config.copilotModel}`);
    const userPrompt = buildDiffPrompt(
      opts.mrTitle,
      opts.mrDescription,
      opts.mrUrl,
      opts.sourceBranch,
      opts.targetBranch,
      diffVersion.diffs
    );
    console.log(
      `[reviewer] Sending ${diffVersion.diffs.length} file(s) for review (prompt length: ${userPrompt.length} chars, workingDir: ${repoDir})`
    );
    const response = await session.sendAndWait({
      prompt: userPrompt
    }, 3e5);
    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got response (${responseContent.length} chars)`);
    await session.destroy();
    await client.stop();
    return parseReviewResponse(responseContent);
  } catch (err) {
    try {
      await client.stop();
    } catch {
    }
    throw err;
  }
}
var COMMENT_REPLY_SYSTEM_PROMPT = `You are an expert developer assistant responding to a comment on a GitLab Merge Request.

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
- Do NOT output JSON \u2014 just write a natural language response (with code blocks if needed).
- Do NOT repeat the question or the thread \u2014 just provide your answer.

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
- The suggestion block replaces entire lines \u2014 include the complete replacement, not just the changed parts.
- You can have multiple suggestion blocks in one reply if needed.
- Outside of suggestion blocks, explain your reasoning in natural language.
- If the discussion is a general MR comment (not on a specific line), use regular code blocks instead.`;
async function replyToComment(opts) {
  const { config, repoDir } = opts;
  const { copilotInstructions, agentsInstructions } = await loadProjectInstructions(repoDir);
  let systemPrompt = COMMENT_REPLY_SYSTEM_PROMPT;
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
    const session = await client.createSession({
      model: config.copilotModel,
      workingDirectory: repoDir,
      systemMessage: {
        mode: "append",
        content: systemPrompt
      },
      onPermissionRequest: async () => ({ kind: "approved" })
    });
    console.log(`[reviewer] Comment reply session created with model: ${config.copilotModel}`);
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
    console.log(
      `[reviewer] Sending comment reply request (${opts.threadMessages.length} messages in thread, prompt: ${prompt.length} chars)`
    );
    const response = await session.sendAndWait({
      prompt
    }, 3e5);
    const responseContent = response?.data?.content ?? "";
    console.log(`[reviewer] Got reply (${responseContent.length} chars)`);
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
  if (action !== "update") {
    console.log("[webhook] Ignoring MR action:", action);
    return false;
  }
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
  const raw = await readFile2(payloadPath, "utf-8");
  return JSON.parse(raw);
}
async function main() {
  console.log("[review] Starting Copilot code review\u2026");
  const payload = await loadTriggerPayload();
  console.log(
    `[review] Received ${payload.object_kind} event`
  );
  const config = loadConfig();
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
async function handleCommentReply(payload, config) {
  const projectId = payload.project.id;
  const mr = payload.merge_request;
  const mrIid = mr.iid;
  const discussionId = payload.object_attributes.discussion_id;
  const httpUrl = payload.project.http_url;
  const sourceBranch = mr.source_branch;
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
        `\u26A0\uFE0F Failed to generate a reply. Check the CI job log.

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
    console.log("[review] Running Copilot review\u2026");
    const review = await reviewMergeRequest({
      config,
      repoDir: clone.dir,
      mrTitle,
      mrDescription,
      mrUrl,
      sourceBranch,
      targetBranch,
      diffVersion
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
        `\u{1F916} **Copilot Review**: Review failed with an error. Check the CI job log.

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
