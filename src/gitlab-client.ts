import type { Config } from "./config.js";
import type {
  MergeRequestDiffVersion,
  MergeRequestDiffVersionDetail,
  DiffFile,
  DiffPosition,
  ReviewComment,
} from "./types.js";

// ─── Diff line parser ───────────────────────────────────────────────────────

/**
 * Extract the set of new-side line numbers that appear in a unified diff.
 * These are the only lines GitLab will accept for inline comments.
 */
function extractNewLinesFromDiff(diff: string): Set<number> {
  const lines = new Set<number>();
  let currentNewLine = 0;

  for (const line of diff.split("\n")) {
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1]!, 10);
      continue;
    }

    if (currentNewLine === 0) continue; // before first hunk

    if (line.startsWith("+")) {
      // Added line — present on new side
      lines.add(currentNewLine);
      currentNewLine++;
    } else if (line.startsWith("-")) {
      // Removed line — only on old side, don't increment new line counter
    } else {
      // Context line — present on both sides
      lines.add(currentNewLine);
      currentNewLine++;
    }
  }

  return lines;
}

/**
 * GitLab REST API client for merge request operations.
 */
export class GitLabClient {
  private baseUrl: string;
  private token: string;

  constructor(config: Config) {
    this.baseUrl = `${config.gitlabUrl}/api/v4`;
    this.token = config.gitlabToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitLab API error: ${response.status} ${response.statusText} – ${text}`,
      );
    }

    // Some endpoints (e.g. bulk_publish) return 204 No Content
    const contentLength = response.headers.get("content-length");
    if (response.status === 204 || contentLength === "0") {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
  }

  // ─── Merge Request Diffs ──────────────────────────────────────────────────

  /**
   * Get all diff versions for a merge request.
   */
  async getMergeRequestVersions(
    projectId: number,
    mrIid: number,
  ): Promise<MergeRequestDiffVersion[]> {
    return this.request<MergeRequestDiffVersion[]>(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/versions`,
    );
  }

  /**
   * Get a specific diff version with full diffs.
   */
  async getMergeRequestVersionDetail(
    projectId: number,
    mrIid: number,
    versionId: number,
  ): Promise<MergeRequestDiffVersionDetail> {
    return this.request<MergeRequestDiffVersionDetail>(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/versions/${versionId}?unidiff=true`,
    );
  }

  /**
   * Get the latest diff version with full diffs.
   */
  async getLatestDiffs(
    projectId: number,
    mrIid: number,
  ): Promise<MergeRequestDiffVersionDetail> {
    const versions = await this.getMergeRequestVersions(projectId, mrIid);
    if (versions.length === 0) {
      throw new Error(`No diff versions found for MR !${mrIid}`);
    }

    // Versions are returned newest first
    const latest = versions[0]!;
    return this.getMergeRequestVersionDetail(projectId, mrIid, latest.id);
  }

  // ─── Posting Comments ─────────────────────────────────────────────────────

  /**
   * Post a general (non-inline) note on a merge request.
   */
  async postMergeRequestNote(
    projectId: number,
    mrIid: number,
    body: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/notes`,
      { body },
    );
  }

  /**
   * Get existing discussions (inline diff comments) on a merge request.
   */
  async getMergeRequestDiscussions(
    projectId: number,
    mrIid: number,
  ): Promise<Array<{ id: string; notes: Array<{ body: string }> }>> {
    return this.request<Array<{ id: string; notes: Array<{ body: string }> }>>(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`,
    );
  }

  /**
   * Get all notes in a specific discussion thread.
   */
  async getDiscussionNotes(
    projectId: number,
    mrIid: number,
    discussionId: string,
  ): Promise<Array<{ id: number; body: string; author: { id: number; name: string; username: string }; created_at: string }>> {
    return this.request<Array<{ id: number; body: string; author: { id: number; name: string; username: string }; created_at: string }>>(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
    );
  }

  /**
   * Post a reply to an existing discussion thread.
   */
  async replyToDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
      { body },
    );
  }

  /**
   * Get existing notes (general comments) on a merge request.
   */
  async getMergeRequestNotes(
    projectId: number,
    mrIid: number,
  ): Promise<Array<{ id: number; body: string }>> {
    return this.request<Array<{ id: number; body: string }>>(
      "GET",
      `/projects/${projectId}/merge_requests/${mrIid}/notes`,
    );
  }

  /**
   * Post an inline discussion (diff comment) on a merge request.
   */
  async postDiffDiscussion(
    projectId: number,
    mrIid: number,
    body: string,
    position: DiffPosition,
  ): Promise<void> {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`,
      { body, position },
    );
  }

  // ─── Draft Notes (Review Submission) ──────────────────────────────────────

  /**
   * Create a general (non-inline) draft note on a merge request.
   */
  async createDraftNote(
    projectId: number,
    mrIid: number,
    note: string,
  ): Promise<{ id: number }> {
    return this.request<{ id: number }>(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/draft_notes`,
      { note },
    );
  }

  /**
   * Create an inline diff draft note on a merge request.
   */
  async createDraftDiffNote(
    projectId: number,
    mrIid: number,
    note: string,
    position: DiffPosition,
  ): Promise<{ id: number }> {
    return this.request<{ id: number }>(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/draft_notes`,
      { note, position },
    );
  }

  /**
   * Publish all pending draft notes for a merge request.
   * This is GitLab's equivalent of "Submit Review" with the "Comment" action.
   */
  async publishAllDraftNotes(
    projectId: number,
    mrIid: number,
  ): Promise<void> {
    await this.request(
      "POST",
      `/projects/${projectId}/merge_requests/${mrIid}/draft_notes/bulk_publish`,
    );
  }

  /**
   * Post all review comments to a merge request using draft notes,
   * then bulk-publish them as a single "Submit Review" (Comment action).
   *
   * - Fetches existing discussions/notes to avoid duplicates
   * - Inline comments are created as draft diff notes.
   * - Comments that can't be placed inline fall back to general draft notes.
   * - All drafts are published in one shot via bulk_publish.
   * - Summary is posted separately as a simple note (not resolvable).
   */
  async postReview(
    projectId: number,
    mrIid: number,
    summary: string,
    comments: ReviewComment[],
    diffVersion: MergeRequestDiffVersionDetail,
  ): Promise<{ posted: number; failed: number; skipped: number }> {
    let posted = 0;
    let failed = 0;
    let skipped = 0;

    // Fetch existing comments to avoid duplicates
    console.log("[gitlab] Fetching existing comments to avoid duplicates...");
    let existingDiscussions: Array<{ id: string; notes: Array<{ body: string }> }> = [];
    let existingNotes: Array<{ id: number; body: string }> = [];
    try {
      existingDiscussions = await this.getMergeRequestDiscussions(projectId, mrIid);
      existingNotes = await this.getMergeRequestNotes(projectId, mrIid);
    } catch (err) {
      console.warn("[gitlab] Failed to fetch existing comments, proceeding anyway:", err);
    }

    // Check if a comment already exists for a given file/line/body
    const commentExists = (file: string, line: number, body: string): boolean => {
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

    // Create inline draft notes
    for (const comment of comments) {
      try {
        // Skip duplicates
        if (commentExists(comment.file, comment.line, comment.body)) {
          console.log(`[gitlab] Skipping duplicate comment on ${comment.file}:${comment.line}`);
          skipped++;
          continue;
        }

        const severityIcon =
          comment.severity === "critical" ? "🔴" :
          comment.severity === "warning" ? "🟡" : "ℹ️";

        // Format comment body with suggestion if available
        let commentBody = `${severityIcon} **${comment.severity.toUpperCase()}**: ${comment.body}`;
        if (comment.suggestion) {
          let rangeOffset = "";
          if (comment.startLine !== undefined && comment.endLine !== undefined) {
            const beforeOffset = comment.line - comment.startLine;
            const afterOffset = comment.endLine - comment.line;
            rangeOffset = `:${beforeOffset > 0 ? "-" : ""}${Math.abs(beforeOffset)}+${afterOffset}`;
          }
          commentBody += `\n\n\`\`\`suggestion${rangeOffset}\n${comment.suggestion}\n\`\`\``;
        }

        // Find the matching diff file
        const diffFile = diffVersion.diffs.find(
          (d) => d.new_path === comment.file || d.old_path === comment.file,
        );

        if (!diffFile) {
          console.warn(
            `[gitlab] File "${comment.file}" not found in diff, creating as general draft note`,
          );
          await this.createDraftNote(
            projectId,
            mrIid,
            `**${comment.file}:${comment.line}** – ${commentBody}`,
          );
          posted++;
          continue;
        }

        // Verify the comment line exists in the diff hunks
        const diffLines = extractNewLinesFromDiff(diffFile.diff);
        if (!diffLines.has(comment.line)) {
          console.warn(
            `[gitlab] Line ${comment.line} not in diff hunks for "${comment.file}", creating as general draft note`,
          );
          await this.createDraftNote(
            projectId,
            mrIid,
            `**${comment.file}:${comment.line}** – ${commentBody}`,
          );
          posted++;
          continue;
        }

        const position: DiffPosition = {
          position_type: "text",
          base_sha: diffVersion.base_commit_sha,
          head_sha: diffVersion.head_commit_sha,
          start_sha: diffVersion.start_commit_sha,
          old_path: diffFile.old_path,
          new_path: diffFile.new_path,
          new_line: comment.line,
        };

        await this.createDraftDiffNote(
          projectId,
          mrIid,
          commentBody,
          position,
        );
        posted++;
      } catch (err) {
        console.error(`[gitlab] Failed to create draft note for ${comment.file}:${comment.line}:`, err);
        failed++;

        // Fallback: create as general draft note
        try {
          await this.createDraftNote(
            projectId,
            mrIid,
            `**${comment.file}:${comment.line}** – ${comment.body}`,
          );
          posted++;
          failed--; // recovered
        } catch {
          // give up on this comment
        }
      }
    }

    // Publish all draft notes as a single review ("Comment" action)
    if (posted > 0) {
      console.log(`[gitlab] Publishing review (${posted} draft note(s))...`);
      await this.publishAllDraftNotes(projectId, mrIid);
      console.log("[gitlab] Review submitted.");
    }

    // Post summary as a separate, non-discussion note (not resolvable)
    await this.postMergeRequestNote(projectId, mrIid, summary);

    return { posted, failed, skipped };
  }
}
