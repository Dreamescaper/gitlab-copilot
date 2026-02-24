import type { Config } from "./config.js";
import type {
  MergeRequestDiffVersion,
  MergeRequestDiffVersionDetail,
  DiffFile,
  DiffPosition,
  ReviewComment,
} from "./types.js";

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

    return response.json() as Promise<T>;
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

  /**
   * Post all review comments to a merge request.
   *
   * - Fetches existing discussions/notes to avoid duplicates
   * - Inline comments are posted as diff discussions on the specific file/line.
   * - A summary note is posted as a regular MR note.
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
      // Check discussions for inline comments on this file/line
      const fileLineKey = `${file}:${line}`;
      for (const discussion of existingDiscussions) {
        for (const note of discussion.notes) {
          if (note.body.includes(fileLineKey) && note.body.includes(body)) {
            return true;
          }
        }
      }
      // Check general notes
      for (const note of existingNotes) {
        if (note.body.includes(fileLineKey) && note.body.includes(body)) {
          return true;
        }
      }
      return false;
    };

    // Post inline comments
    for (const comment of comments) {
      try {
        // Skip if comment already exists
        if (commentExists(comment.file, comment.line, comment.body)) {
          console.log(`[gitlab] Skipping duplicate comment on ${comment.file}:${comment.line}`);
          skipped++;
          continue;
        }

        // Find the matching diff file
        const diffFile = diffVersion.diffs.find(
          (d) => d.new_path === comment.file || d.old_path === comment.file,
        );

        if (!diffFile) {
          console.warn(
            `[gitlab] File "${comment.file}" not found in diff, posting as general note`,
          );
          // Skip if comment already exists as a general note
          if (commentExists(comment.file, comment.line, comment.body)) {
            skipped++;
            continue;
          }
          await this.postMergeRequestNote(
            projectId,
            mrIid,
            `**${comment.file}:${comment.line}** – ${comment.body}`,
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

        const severityIcon =
          comment.severity === "critical" ? "🔴" :
          comment.severity === "warning" ? "🟡" : "ℹ️";

        // Format comment body with suggestion if available
        let commentBody = `${severityIcon} **${comment.severity.toUpperCase()}**: ${comment.body}`;
        if (comment.suggestion) {
          // Calculate range offsets for multi-line suggestions
          let rangeOffset = "";
          if (comment.startLine !== undefined && comment.endLine !== undefined) {
            const beforeOffset = comment.line - comment.startLine;
            const afterOffset = comment.endLine - comment.line;
            rangeOffset = `:${beforeOffset > 0 ? "-" : ""}${Math.abs(beforeOffset)}+${afterOffset}`;
          }
          commentBody += `\n\n\`\`\`suggestion${rangeOffset}\n${comment.suggestion}\n\`\`\``;
        }

        await this.postDiffDiscussion(
          projectId,
          mrIid,
          commentBody,
          position,
        );
        posted++;
      } catch (err) {
        console.error(`[gitlab] Failed to post comment on ${comment.file}:${comment.line}:`, err);
        failed++;

        // Fallback: post as a general note
        try {
          await this.postMergeRequestNote(
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

    // Post summary
    await this.postMergeRequestNote(projectId, mrIid, summary);

    return { posted, failed, skipped };
  }
}
