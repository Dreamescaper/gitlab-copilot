import { createHmac } from "node:crypto";
import type {
  MergeRequestWebhookPayload,
  GitLabUser,
} from "./types.js";
import type { Config } from "./config.js";

/**
 * Verify the GitLab webhook secret token.
 * GitLab sends the secret in the `X-Gitlab-Token` header (plain text, not HMAC).
 */
export function verifyWebhookToken(
  headerToken: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return true; // no secret configured → skip verification
  return headerToken === secret;
}

/**
 * Determine whether this webhook event should trigger a review.
 *
 * Criteria:
 *   1. object_kind === "merge_request"
 *   2. action is "update" (reviewer list changed)
 *   3. The bot service account was ADDED to the reviewer list
 *      (present in `changes.reviewer_ids.current` but not in `changes.reviewer_ids.previous`)
 *   4. MR is not a draft / WIP
 */
export function shouldTriggerReview(
  payload: MergeRequestWebhookPayload,
  config: Config,
): boolean {
  // Must be a merge_request event
  if (payload.object_kind !== "merge_request") {
    console.log("[webhook] Ignoring non-MR event:", payload.object_kind);
    return false;
  }

  // Must be an update action (reviewer change fires as "update")
  const action = payload.object_attributes.action;
  if (action !== "update") {
    console.log("[webhook] Ignoring MR action:", action);
    return false;
  }

  // Skip drafts
  if (payload.object_attributes.draft || payload.object_attributes.work_in_progress) {
    console.log("[webhook] Ignoring draft MR");
    return false;
  }

  // Check if the bot was added as reviewer
  const botUser = payload.reviewers?.find(
    (r: GitLabUser) => r.username === config.gitlabBotUsername,
  );

  if (!botUser) {
    console.log("[webhook] Bot user not found in reviewers list");
    return false;
  }

  // Check if reviewer_ids actually changed and bot was newly added
  const reviewerChanges = payload.changes?.reviewer_ids;
  if (reviewerChanges) {
    const previousIds = reviewerChanges.previous ?? [];
    const currentIds = reviewerChanges.current ?? [];
    const wasAlreadyReviewer = previousIds.includes(botUser.id);
    const isNowReviewer = currentIds.includes(botUser.id);

    if (wasAlreadyReviewer || !isNowReviewer) {
      console.log("[webhook] Bot was not newly added as reviewer");
      return false;
    }
  }

  console.log(
    `[webhook] Review triggered for MR !${payload.object_attributes.iid} ` +
    `in ${payload.project.path_with_namespace}`,
  );
  return true;
}
