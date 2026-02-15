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
   * - Inline comments are posted as diff discussions on the specific file/line.
   * - A summary note is posted as a regular MR note.
   */
  async postReview(
    projectId: number,
    mrIid: number,
    summary: string,
    comments: ReviewComment[],
    diffVersion: MergeRequestDiffVersionDetail,
  ): Promise<{ posted: number; failed: number }> {
    let posted = 0;
    let failed = 0;

    // Post inline comments
    for (const comment of comments) {
      try {
        // Find the matching diff file
        const diffFile = diffVersion.diffs.find(
          (d) => d.new_path === comment.file || d.old_path === comment.file,
        );

        if (!diffFile) {
          console.warn(
            `[gitlab] File "${comment.file}" not found in diff, posting as general note`,
          );
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

        await this.postDiffDiscussion(
          projectId,
          mrIid,
          `${severityIcon} **${comment.severity.toUpperCase()}**: ${comment.body}`,
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

    return { posted, failed };
  }
}
