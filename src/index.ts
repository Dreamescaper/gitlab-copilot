#!/usr/bin/env node

/**
 * CLI entrypoint for the GitLab Copilot Reviewer.
 *
 * Invoked by a GitLab CI pipeline triggered directly from a GitLab webhook.
 * The webhook payload is available via the $TRIGGER_PAYLOAD predefined
 * CI/CD variable (file-type), containing the full MR webhook JSON.
 *
 * See: https://docs.gitlab.com/ci/triggers/#use-a-webhook
 *
 * The pipeline runs in the *reviewer* project, so this script clones the
 * *target* project (where the MR lives) before running the review.
 *
 * Flow:
 *   1. Read & parse the webhook payload from $TRIGGER_PAYLOAD
 *   2. Validate the event (MR update, bot added as reviewer, not draft)
 *   3. Load config from environment variables
 *   4. Clone the target project's source branch
 *   5. Fetch MR diffs from GitLab API
 *   6. Run Copilot SDK review (with full repo on disk)
 *   7. Post review comments back to GitLab MR
 *   8. Clean up the clone
 */

import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { GitLabClient } from "./gitlab-client.js";
import { cloneRepository } from "./git.js";
import { reviewMergeRequest, replyToComment } from "./reviewer.js";
import { fetchJiraContext } from "./jira-client.js";
import { classifyWebhookEvent } from "./webhook.js";
import type {
  MergeRequestWebhookPayload,
  NoteWebhookPayload,
  WebhookPayload,
} from "./types.js";

/**
 * Read and parse the webhook payload from the $TRIGGER_PAYLOAD file variable.
 */
async function loadTriggerPayload(): Promise<WebhookPayload> {
  const payloadPath = process.env["TRIGGER_PAYLOAD"];
  if (!payloadPath) {
    throw new Error(
      "TRIGGER_PAYLOAD variable not set. " +
      "This job must be triggered via a webhook pipeline trigger.",
    );
  }

  const raw = await readFile(payloadPath, "utf-8");
  return JSON.parse(raw) as WebhookPayload;
}

async function main(): Promise<void> {
  console.log("[review] Starting Copilot code review…");

  // ─── Load & validate webhook payload ────────────────────────────────────
  const payload = await loadTriggerPayload();
  console.log(
    `[review] Received ${payload.object_kind} event`,
  );

  // ─── Load config ────────────────────────────────────────────────────────
  const config = loadConfig();

  // ─── Classify event ─────────────────────────────────────────────────────
  const event = classifyWebhookEvent(payload, config.gitlabBotUsername);

  if (event.type === "ignore") {
    console.log(`[review] Event ignored: ${event.reason}`);
    return;
  }

  if (event.type === "comment_reply") {
    await handleCommentReply(event.payload, config);
    return;
  }

  // event.type === "review"
  await handleMergeRequestReview(event.payload, config);
}

// ─── Comment Reply Handler ──────────────────────────────────────────────────

async function handleCommentReply(
  payload: NoteWebhookPayload,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const projectId = payload.project.id;
  const mr = payload.merge_request!;
  const mrIid = mr.iid;
  const discussionId = payload.object_attributes.discussion_id;
  const httpUrl = payload.project.http_url;
  const sourceBranch = mr.source_branch;

  console.log(
    `[review] Responding to comment in discussion ${discussionId} ` +
    `on MR !${mrIid} in ${payload.project.path_with_namespace}`,
  );

  const gitlab = new GitLabClient(config);
  let cleanup: (() => Promise<void>) | undefined;

  try {
    // ─── Fetch full discussion thread ────────────────────────────────────
    console.log("[review] Fetching discussion thread…");
    const notes = await gitlab.getDiscussionNotes(projectId, mrIid, discussionId);
    console.log(`[review] Thread has ${notes.length} message(s)`);

    const threadMessages = notes.map((note) => ({
      author: note.author.username,
      body: note.body,
      createdAt: note.created_at,
    }));

    // ─── Extract file/line context if inline discussion ──────────────────
    const position = payload.object_attributes.position;
    const filePath = position?.new_path;
    const lineNumber = position?.new_line ?? undefined;

    // ─── Get diff context if available ───────────────────────────────────
    let diffContext: string | undefined;
    if (filePath) {
      try {
        const diffVersion = await gitlab.getLatestDiffs(projectId, mrIid);
        const diffFile = diffVersion.diffs.find(
          (d) => d.new_path === filePath || d.old_path === filePath,
        );
        if (diffFile) {
          diffContext = diffFile.diff;
        }
      } catch {
        console.warn("[review] Could not fetch diff context, continuing without it");
      }
    }

    // ─── Fetch Jira context if available ─────────────────────────────────
    const jiraContext = await fetchJiraContext(mr.title, config);

    // ─── Clone the target project ────────────────────────────────────────
    console.log("[review] Cloning target repository…");
    const clone = await cloneRepository(httpUrl, sourceBranch, config.gitlabToken);
    cleanup = clone.cleanup;
    console.log(`[review] Cloned to ${clone.dir}`);

    // ─── Generate reply ──────────────────────────────────────────────────
    console.log("[review] Generating Copilot reply…");
    const reply = await replyToComment({
      config,
      repoDir: clone.dir,
      threadMessages,
      filePath,
      lineNumber,
      diffContext,
      mrTitle: mr.title,
      mrUrl: mr.url,
      jiraContext,
    });

    if (!reply) {
      console.log("[review] Empty reply from Copilot, skipping.");
      return;
    }

    // ─── Post reply to the discussion ────────────────────────────────────
    console.log("[review] Posting reply to discussion…");
    await gitlab.replyToDiscussion(projectId, mrIid, discussionId, reply);
    console.log("[review] Reply posted successfully.");
  } catch (err) {
    console.error("[review] Comment reply failed:", err);

    // Attempt to notify the discussion
    try {
      await gitlab.replyToDiscussion(
        projectId,
        mrIid,
        discussionId,
        `⚠️ Failed to generate a reply. Check the CI job log.\n\n` +
        `\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``,
      );
    } catch {
      // ignore
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

// ─── MR Review Handler ─────────────────────────────────────────────────────

async function handleMergeRequestReview(
  payload: MergeRequestWebhookPayload,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
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
    `[review] MR !${mrIid} in project ${projectId}: ${mrTitle}\n` +
    `[review] ${sourceBranch} → ${targetBranch}`,
  );

  const gitlab = new GitLabClient(config);
  let cleanup: (() => Promise<void>) | undefined;

  try {
    // ─── Clone the target project ────────────────────────────────────────
    console.log("[review] Cloning target repository…");
    const clone = await cloneRepository(httpUrl, sourceBranch, config.gitlabToken);
    cleanup = clone.cleanup;
    console.log(`[review] Cloned to ${clone.dir}`);

    // ─── Fetch diffs ─────────────────────────────────────────────────────
    console.log("[review] Fetching MR diffs…");
    const diffVersion = await gitlab.getLatestDiffs(projectId, mrIid);
    console.log(
      `[review] Got ${diffVersion.diffs.length} changed file(s), ` +
      `version ${diffVersion.id}`,
    );

    if (diffVersion.diffs.length === 0) {
      await gitlab.postMergeRequestNote(
        projectId,
        mrIid,
        "🤖 **Copilot Review**: No file changes detected in this MR.",
      );
      console.log("[review] No diffs to review.");
      return;
    }

    // ─── Fetch Jira context if available ─────────────────────────────────────
    const jiraContext = await fetchJiraContext(mrTitle, config);

    // ─── Run review ───────────────────────────────────────────────────
    console.log("[review] Running Copilot review…");
    const review = await reviewMergeRequest({
      config,
      repoDir: clone.dir,
      mrTitle,
      mrDescription,
      mrUrl,
      sourceBranch,
      targetBranch,
      diffVersion,
      jiraContext,
    });
    console.log(
      `[review] Review complete: ${review.comments.length} comment(s)`,
    );

    // ─── Post results ────────────────────────────────────────────────────
    console.log("[review] Posting review to GitLab…");

    const summaryBody =
      `## 🤖 Copilot Code Review\n\n` +
      `${review.summary}\n\n` +
      `---\n` +
      `_${review.comments.length} comment(s) reviewed._`;

    const { posted, failed, skipped } = await gitlab.postReview(
      projectId,
      mrIid,
      summaryBody,
      review.comments,
      diffVersion,
    );

    console.log(
      `[review] Done: ${posted} comment(s) posted, ${skipped} skipped (duplicate), ${failed} failed`,
    );

    if (failed > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("[review] Review failed:", err);

    // Attempt to notify the MR
    try {
      await gitlab.postMergeRequestNote(
        projectId,
        mrIid,
        `🤖 **Copilot Review**: Review failed with an error. Check the CI job log.\n\n` +
        `\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``,
      );
    } catch {
      // ignore
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
