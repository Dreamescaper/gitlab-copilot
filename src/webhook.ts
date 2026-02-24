import type {
  MergeRequestWebhookPayload,
  GitLabUser,
} from "./types.js";

/**
 * Determine whether this webhook event should trigger a review.
 *
 * Triggers in two cases:
 *   1. Bot is NEWLY ADDED as a reviewer:
 *      - Must be an "update" action
 *      - changes.reviewers shows bot added (current but not previous)
 *      - MR is not a draft
 *   
 *   2. MR transitions from Draft → non-Draft AND bot is already reviewer:
 *      - changes.draft or changes.work_in_progress shows transition
 *      - Bot is in current reviewers list
 */
export function shouldTriggerReview(
  payload: MergeRequestWebhookPayload,
  botUsername: string,
): boolean {
  // Must be a merge_request event
  if (payload.object_kind !== "merge_request") {
    console.log("[webhook] Ignoring non-MR event:", payload.object_kind);
    return false;
  }

  // Must be an update action
  const action = payload.object_attributes.action;
  if (action !== "update") {
    console.log("[webhook] Ignoring MR action:", action);
    return false;
  }

  // Find bot in current reviewers
  const botUser = payload.reviewers?.find(
    (r: GitLabUser) => r.username === botUsername,
  );

  if (!botUser) {
    console.log("[webhook] Bot user not found in reviewers list");
    console.log(`[webhook] Looking for username: "${botUsername}"`);
    console.log(`[webhook] Available usernames: ${payload.reviewers?.map(r => `"${r.username}"`).join(", ") ?? "none"}`);
    return false;
  }

  // Skip if MR is currently a draft
  if (payload.object_attributes.draft || payload.object_attributes.work_in_progress) {
    console.log("[webhook] Ignoring draft MR");
    return false;
  }

  // Check CASE 1: Bot was newly added as a reviewer
  const reviewerChanges = payload.changes?.reviewers ?? payload.changes?.reviewer_ids;
  if (reviewerChanges) {
    const previousIds = Array.isArray(reviewerChanges.previous)
      ? reviewerChanges.previous.map((r: any) => typeof r === 'number' ? r : r.id)
      : [];
    const currentIds = Array.isArray(reviewerChanges.current)
      ? reviewerChanges.current.map((r: any) => typeof r === 'number' ? r : r.id)
      : [];
    
    const wasAlreadyReviewer = previousIds.includes(botUser.id);
    const isNowReviewer = currentIds.includes(botUser.id);

    if (isNowReviewer && !wasAlreadyReviewer) {
      console.log(
        `[webhook] Review triggered: Bot newly added as reviewer for MR !${payload.object_attributes.iid} ` +
        `in ${payload.project.path_with_namespace}`,
      );
      return true;
    }
  }

  // Check CASE 2: MR transitioned from Draft → non-Draft with bot already as reviewer
  const draftChanges = payload.changes?.draft;
  const wipChanges = payload.changes?.work_in_progress;
  
  if (draftChanges) {
    const wasDraft = draftChanges.previous === true;
    const isNowDraft = draftChanges.current === true;
    
    if (wasDraft && !isNowDraft) {
      console.log(
        `[webhook] Review triggered: Draft status changed for MR !${payload.object_attributes.iid} ` +
        `in ${payload.project.path_with_namespace}`,
      );
      return true;
    }
  }

  if (wipChanges) {
    const wasWip = wipChanges.previous === true;
    const isNowWip = wipChanges.current === true;
    
    if (wasWip && !isNowWip) {
      console.log(
        `[webhook] Review triggered: WIP status changed for MR !${payload.object_attributes.iid} ` +
        `in ${payload.project.path_with_namespace}`,
      );
      return true;
    }
  }

  console.log("[webhook] No trigger conditions met (not bot added, and not draft→non-draft transition)");
  return false;
}
