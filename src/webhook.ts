import type {
  MergeRequestWebhookPayload,
  NoteWebhookPayload,
  WebhookPayload,
  GitLabUser,
} from "./types.js";

/**
 * Determine the type of webhook event and whether it should trigger any action.
 */
export function classifyWebhookEvent(
  payload: WebhookPayload,
  botUsername: string,
): { type: "review"; payload: MergeRequestWebhookPayload }
  | { type: "comment_reply"; payload: NoteWebhookPayload }
  | { type: "ignore"; reason: string } {
  
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
  
  return { type: "ignore", reason: `Unhandled event type: ${(payload as any).object_kind}` };
}

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

// ─── Comment Reply Detection ────────────────────────────────────────────────

/**
 * Determine whether this note webhook event should trigger a comment reply.
 *
 * Criteria:
 *   1. object_kind === "note"
 *   2. The note is on a merge request (noteable_type === "MergeRequest")
 *   3. The note body mentions the bot username (@botUsername)
 *   4. The note author is NOT the bot itself (avoid infinite loops)
 */
function shouldRespondToComment(
  payload: NoteWebhookPayload,
  botUsername: string,
): boolean {
  if (payload.object_kind !== "note") {
    return false;
  }

  // Must be a note on a merge request
  if (payload.object_attributes.noteable_type !== "MergeRequest") {
    console.log("[webhook] Ignoring note on non-MR:", payload.object_attributes.noteable_type);
    return false;
  }

  // Must have MR context
  if (!payload.merge_request) {
    console.log("[webhook] Note event missing merge_request context");
    return false;
  }

  // Ignore notes from the bot itself (prevent infinite loops)
  if (payload.user.username === botUsername) {
    console.log("[webhook] Ignoring note from bot itself");
    return false;
  }

  // Check if the note mentions the bot
  const mentionPattern = `@${botUsername}`;
  if (!payload.object_attributes.note.includes(mentionPattern)) {
    console.log(`[webhook] Note does not mention ${mentionPattern}`);
    return false;
  }

  console.log(
    `[webhook] Comment reply triggered: @${botUsername} mentioned in discussion ` +
    `${payload.object_attributes.discussion_id} on MR !${payload.merge_request.iid}`,
  );
  return true;
}
