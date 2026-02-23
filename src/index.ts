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
import { reviewMergeRequest } from "./reviewer.js";
import { shouldTriggerReview } from "./webhook.js";
import type { MergeRequestWebhookPayload } from "./types.js";

/**
 * Read and parse the webhook payload from the $TRIGGER_PAYLOAD file variable.
 */
async function loadTriggerPayload(): Promise<MergeRequestWebhookPayload> {
  const payloadPath = process.env["TRIGGER_PAYLOAD"];
  if (!payloadPath) {
    throw new Error(
      "TRIGGER_PAYLOAD variable not set. " +
      "This job must be triggered via a webhook pipeline trigger.",
    );
  }

  const raw = await readFile(payloadPath, "utf-8");
  return JSON.parse(raw) as MergeRequestWebhookPayload;
}

async function main(): Promise<void> {
  console.log("[review] Starting Copilot code review…");

  // ─── Load & validate webhook payload ────────────────────────────────────
  const payload = await loadTriggerPayload();
  console.log(
    `[review] Received ${payload.object_kind} event ` +
    `(action: ${payload.object_attributes?.action ?? "unknown"})`,
  );

  // ─── Load config ────────────────────────────────────────────────────────
  const config = loadConfig();

  // ─── Check trigger conditions ───────────────────────────────────────────
  if (!shouldTriggerReview(payload, config.gitlabBotUsername)) {
    console.log("[review] Event does not require a review – exiting.");
    return;
  }

  // ─── Extract MR metadata from webhook payload ──────────────────────────
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

    // ─── Run review ────────────────────────────────────────────────────
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
      `_${review.comments.length} inline comment(s) posted._`;

    const { posted, failed } = await gitlab.postReview(
      projectId,
      mrIid,
      summaryBody,
      review.comments,
      diffVersion,
    );

    console.log(
      `[review] Done: ${posted} comment(s) posted, ${failed} failed`,
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
