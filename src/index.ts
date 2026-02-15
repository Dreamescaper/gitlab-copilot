import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { loadConfig } from "./config.js";
import { verifyWebhookToken, shouldTriggerReview } from "./webhook.js";
import { GitLabClient } from "./gitlab-client.js";
import { cloneRepository } from "./git.js";
import { reviewMergeRequest } from "./reviewer.js";
import type { MergeRequestWebhookPayload } from "./types.js";

/**
 * AWS Lambda handler for GitLab MR webhook events.
 *
 * Triggered via Lambda Function URL.
 * Flow:
 *   1. Validate webhook token
 *   2. Parse payload & check if bot was added as reviewer
 *   3. Fetch MR diffs from GitLab API
 *   4. Shallow-clone the source branch
 *   5. Send diffs to Copilot SDK for review (with full repo on disk)
 *   6. Post review comments back to GitLab MR
 *   7. Clean up the clone
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  console.log("[lambda] Received event");

  // ─── Load config ────────────────────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error("[lambda] Configuration error:", err);
    return { statusCode: 500, body: "Server configuration error" };
  }

  // ─── Verify webhook token ──────────────────────────────────────────────
  const webhookToken = event.headers?.["x-gitlab-token"];
  if (!verifyWebhookToken(webhookToken, config.gitlabWebhookSecret)) {
    console.warn("[lambda] Invalid webhook token");
    return { statusCode: 401, body: "Unauthorized" };
  }

  // ─── Parse payload ────────────────────────────────────────────────────
  let payload: MergeRequestWebhookPayload;
  try {
    payload = JSON.parse(event.body ?? "{}") as MergeRequestWebhookPayload;
  } catch {
    console.error("[lambda] Failed to parse request body");
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // ─── Check trigger conditions ─────────────────────────────────────────
  if (!shouldTriggerReview(payload, config)) {
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Event ignored – review not triggered" }),
    };
  }

  const projectId = payload.project.id;
  const mrIid = payload.object_attributes.iid;
  const mrTitle = payload.object_attributes.title;
  const mrDescription = payload.object_attributes.description;
  const mrUrl = payload.object_attributes.url;
  const sourceBranch = payload.object_attributes.source_branch;
  const targetBranch = payload.object_attributes.target_branch;
  const gitHttpUrl = payload.project.http_url;

  console.log(
    `[lambda] Starting review for MR !${mrIid} in project ${projectId} ` +
    `(${payload.project.path_with_namespace}) ` +
    `[${sourceBranch} → ${targetBranch}]`,
  );

  const gitlab = new GitLabClient(config);
  let clone: Awaited<ReturnType<typeof cloneRepository>> | undefined;

  try {
    // ─── Fetch diffs ─────────────────────────────────────────────────────
    console.log("[lambda] Fetching MR diffs…");
    const diffVersion = await gitlab.getLatestDiffs(projectId, mrIid);
    console.log(
      `[lambda] Got ${diffVersion.diffs.length} changed file(s), ` +
      `version ${diffVersion.id}`,
    );

    if (diffVersion.diffs.length === 0) {
      await gitlab.postMergeRequestNote(
        projectId,
        mrIid,
        "🤖 **Copilot Review**: No file changes detected in this MR.",
      );
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No diffs to review" }),
      };
    }

    // ─── Clone the repository ────────────────────────────────────────────
    console.log("[lambda] Cloning repository…");
    clone = await cloneRepository(gitHttpUrl, sourceBranch, config.gitlabToken);
    console.log(`[lambda] Cloned to ${clone.dir}`);

    // ─── Run review (Copilot has full repo on disk) ──────────────────────
    console.log("[lambda] Running Copilot review (with full repo clone)…");
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
      `[lambda] Review complete: ${review.comments.length} comment(s)`,
    );

    // ─── Post results ────────────────────────────────────────────────────
    console.log("[lambda] Posting review to GitLab…");

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
      `[lambda] Done: ${posted} comment(s) posted, ${failed} failed`,
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Review posted",
        comments: review.comments.length,
        posted,
        failed,
      }),
    };
  } catch (err) {
    console.error("[lambda] Review failed:", err);

    // Attempt to notify the MR that review failed
    try {
      await gitlab.postMergeRequestNote(
        projectId,
        mrIid,
        `🤖 **Copilot Review**: Review failed with an error. Please check the Lambda logs.\n\n` +
        `\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``,
      );
    } catch {
      // ignore notification failure
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Review failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  } finally {
    // Always clean up the clone
    if (clone) {
      try {
        await clone.cleanup();
      } catch (cleanupErr) {
        console.warn("[lambda] Clone cleanup failed:", cleanupErr);
      }
    }
  }
}
