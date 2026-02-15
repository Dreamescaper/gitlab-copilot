#!/usr/bin/env node

/**
 * CLI entrypoint for the GitLab Copilot Reviewer.
 *
 * Invoked by a GitLab CI pipeline trigger with MR metadata as pipeline variables:
 *   MR_PROJECT_ID, MR_IID, MR_TITLE, MR_DESCRIPTION,
 *   MR_SOURCE_BRANCH, MR_TARGET_BRANCH, MR_PROJECT_URL, MR_HTTP_URL
 *
 * The pipeline runs in the *reviewer* project, so this script clones the
 * *target* project (where the MR lives) before running the review.
 *
 * Flow:
 *   1. Load config from environment variables
 *   2. Clone the target project's source branch
 *   3. Fetch MR diffs from GitLab API
 *   4. Run Copilot SDK review (with full repo on disk)
 *   5. Post review comments back to GitLab MR
 *   6. Clean up the clone
 */

import { loadConfig } from "./config.js";
import { GitLabClient } from "./gitlab-client.js";
import { cloneRepository } from "./git.js";
import { reviewMergeRequest } from "./reviewer.js";

function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[review] Missing required pipeline variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  console.log("[review] Starting Copilot code review…");

  // ─── Load config ────────────────────────────────────────────────────────
  const config = loadConfig();

  // ─── Read MR info from pipeline trigger variables ───────────────────────
  const projectId = Number(requireEnvVar("MR_PROJECT_ID"));
  const mrIid = Number(requireEnvVar("MR_IID"));
  const mrTitle = requireEnvVar("MR_TITLE");
  const mrDescription = process.env["MR_DESCRIPTION"] ?? "";
  const sourceBranch = requireEnvVar("MR_SOURCE_BRANCH");
  const targetBranch = requireEnvVar("MR_TARGET_BRANCH");
  const projectUrl = requireEnvVar("MR_PROJECT_URL");
  const httpUrl = requireEnvVar("MR_HTTP_URL");
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
