import type { MergeRequestWebhookPayload } from "./types.js";

export interface AutoAddReviewerConfig {
  gitlabAutoAddReviewer: boolean;
  gitlabBotUsername: string;
}

export interface ReviewerAssignmentClient {
  findUserByUsername(
    username: string,
  ): Promise<{ id: number; username: string } | undefined>;
  updateMergeRequestReviewers(
    projectId: number,
    mrIid: number,
    reviewerIds: number[],
  ): Promise<void>;
}

export async function autoAddBotReviewerIfMissing(
  payload: MergeRequestWebhookPayload,
  config: AutoAddReviewerConfig,
  gitlab: ReviewerAssignmentClient,
): Promise<boolean> {
  if (!config.gitlabAutoAddReviewer) {
    return false;
  }

  const botAlreadyReviewer = payload.reviewers?.some(
    (reviewer) => reviewer.username === config.gitlabBotUsername,
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
        `[review] Auto-add reviewer enabled, but user "${config.gitlabBotUsername}" was not found in GitLab.`,
      );
      return false;
    }

    const existingIds = new Set<number>([
      ...(payload.object_attributes.reviewer_ids ?? []),
      ...(payload.reviewers ?? []).map((reviewer) => reviewer.id),
    ]);

    if (existingIds.has(botUser.id)) {
      return false;
    }

    const updatedReviewerIds = [...existingIds, botUser.id];
    await gitlab.updateMergeRequestReviewers(projectId, mrIid, updatedReviewerIds);

    console.log(
      `[review] Auto-added @${config.gitlabBotUsername} as reviewer for MR !${mrIid}.`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[review] Failed to auto-add reviewer @${config.gitlabBotUsername}:`,
      err,
    );
    return false;
  }
}
