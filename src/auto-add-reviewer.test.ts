import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { autoAddBotReviewerIfMissing } from "./auto-add-reviewer.js";
import type {
  GitLabUser,
  MergeRequestWebhookPayload,
} from "./types.js";

function makeUser(id: number, username: string): GitLabUser {
  return {
    id,
    username,
    name: username,
    avatar_url: "",
  };
}

function makePayload(opts?: {
  reviewers?: GitLabUser[];
  reviewerIds?: number[];
  projectId?: number;
  mrIid?: number;
}): MergeRequestWebhookPayload {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: makeUser(10, "author"),
    project: {
      id: opts?.projectId ?? 100,
      name: "demo",
      description: "",
      web_url: "https://gitlab.example.com/group/demo",
      git_ssh_url: "git@gitlab.example.com:group/demo.git",
      git_http_url: "https://gitlab.example.com/group/demo.git",
      namespace: "group",
      visibility_level: 0,
      path_with_namespace: "group/demo",
      default_branch: "main",
      homepage: "https://gitlab.example.com/group/demo",
      url: "https://gitlab.example.com/group/demo.git",
      ssh_url: "git@gitlab.example.com:group/demo.git",
      http_url: "https://gitlab.example.com/group/demo.git",
    },
    object_attributes: {
      id: 999,
      iid: opts?.mrIid ?? 7,
      target_branch: "main",
      source_branch: "feature/x",
      source_project_id: 100,
      target_project_id: 100,
      author_id: 10,
      assignee_id: null,
      assignee_ids: [],
      reviewer_ids: opts?.reviewerIds ?? [],
      title: "feat: update",
      description: "",
      state: "opened",
      action: "update",
      draft: false,
      work_in_progress: false,
      merge_status: "can_be_merged",
      url: "https://gitlab.example.com/group/demo/-/merge_requests/7",
      last_commit: {
        id: "abc",
        message: "msg",
        timestamp: new Date().toISOString(),
      },
      source: {
        id: 100,
        name: "demo",
        description: "",
        web_url: "https://gitlab.example.com/group/demo",
        git_ssh_url: "git@gitlab.example.com:group/demo.git",
        git_http_url: "https://gitlab.example.com/group/demo.git",
        namespace: "group",
        visibility_level: 0,
        path_with_namespace: "group/demo",
        default_branch: "main",
        homepage: "https://gitlab.example.com/group/demo",
        url: "https://gitlab.example.com/group/demo.git",
        ssh_url: "git@gitlab.example.com:group/demo.git",
        http_url: "https://gitlab.example.com/group/demo.git",
      },
      target: {
        id: 100,
        name: "demo",
        description: "",
        web_url: "https://gitlab.example.com/group/demo",
        git_ssh_url: "git@gitlab.example.com:group/demo.git",
        git_http_url: "https://gitlab.example.com/group/demo.git",
        namespace: "group",
        visibility_level: 0,
        path_with_namespace: "group/demo",
        default_branch: "main",
        homepage: "https://gitlab.example.com/group/demo",
        url: "https://gitlab.example.com/group/demo.git",
        ssh_url: "git@gitlab.example.com:group/demo.git",
        http_url: "https://gitlab.example.com/group/demo.git",
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    reviewers: opts?.reviewers ?? [],
    changes: {},
  };
}

describe("autoAddBotReviewerIfMissing", () => {
  const config = {
    gitlabAutoAddReviewer: true,
    gitlabBotUsername: "copilot-reviewer",
  };

  const findUserByUsername = vi.fn();
  const updateMergeRequestReviewers = vi.fn();
  const client = {
    findUserByUsername,
    updateMergeRequestReviewers,
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when auto-add is disabled", async () => {
    const payload = makePayload();

    const result = await autoAddBotReviewerIfMissing(
      payload,
      { ...config, gitlabAutoAddReviewer: false },
      client,
    );

    expect(result).toBe(false);
    expect(findUserByUsername).not.toHaveBeenCalled();
    expect(updateMergeRequestReviewers).not.toHaveBeenCalled();
  });

  it("returns false when bot is already in reviewers list", async () => {
    const payload = makePayload({
      reviewers: [makeUser(42, "copilot-reviewer")],
      reviewerIds: [42],
    });

    const result = await autoAddBotReviewerIfMissing(payload, config, client);

    expect(result).toBe(false);
    expect(findUserByUsername).not.toHaveBeenCalled();
    expect(updateMergeRequestReviewers).not.toHaveBeenCalled();
  });

  it("returns false when bot user cannot be found", async () => {
    const payload = makePayload({
      reviewers: [makeUser(77, "alice")],
      reviewerIds: [77],
    });
    findUserByUsername.mockResolvedValueOnce(undefined);

    const result = await autoAddBotReviewerIfMissing(payload, config, client);

    expect(result).toBe(false);
    expect(findUserByUsername).toHaveBeenCalledWith("copilot-reviewer");
    expect(updateMergeRequestReviewers).not.toHaveBeenCalled();
  });

  it("adds bot reviewer and returns true when missing", async () => {
    const payload = makePayload({
      projectId: 321,
      mrIid: 88,
      reviewers: [makeUser(77, "alice")],
      reviewerIds: [77],
    });
    findUserByUsername.mockResolvedValueOnce({ id: 42, username: "copilot-reviewer" });

    const result = await autoAddBotReviewerIfMissing(payload, config, client);

    expect(result).toBe(true);
    expect(updateMergeRequestReviewers).toHaveBeenCalledWith(321, 88, [77, 42]);
  });

  it("returns false when update API call fails", async () => {
    const payload = makePayload({
      reviewers: [makeUser(77, "alice")],
      reviewerIds: [77],
    });
    findUserByUsername.mockResolvedValueOnce({ id: 42, username: "copilot-reviewer" });
    updateMergeRequestReviewers.mockRejectedValueOnce(new Error("API error"));

    const result = await autoAddBotReviewerIfMissing(payload, config, client);

    expect(result).toBe(false);
    expect(updateMergeRequestReviewers).toHaveBeenCalledTimes(1);
  });
});
