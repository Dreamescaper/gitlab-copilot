// ─── GitLab Webhook Payload Types ───────────────────────────────────────────

export interface GitLabUser {
  id: number;
  name: string;
  username: string;
  avatar_url: string;
  email?: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  description: string;
  web_url: string;
  git_ssh_url: string;
  git_http_url: string;
  namespace: string;
  visibility_level: number;
  path_with_namespace: string;
  default_branch: string;
  homepage: string;
  url: string;
  ssh_url: string;
  http_url: string;
}

export interface GitLabCommit {
  id: string;
  message: string;
  title?: string;
  timestamp: string;
  url?: string;
  author?: {
    name: string;
    email: string;
  };
}

export interface MergeRequestAttributes {
  id: number;
  iid: number;
  target_branch: string;
  source_branch: string;
  source_project_id: number;
  target_project_id: number;
  author_id: number;
  assignee_id: number | null;
  assignee_ids: number[];
  reviewer_ids: number[];
  title: string;
  description: string;
  state: string;
  action: string;
  draft: boolean;
  work_in_progress: boolean;
  merge_status: string;
  detailed_merge_status?: string;
  url: string;
  last_commit: GitLabCommit;
  source: GitLabProject;
  target: GitLabProject;
  created_at: string;
  updated_at: string;
}

export interface MergeRequestChanges {
  reviewer_ids?: {
    previous: number[];
    current: number[];
  };
  [key: string]: unknown;
}

export interface MergeRequestWebhookPayload {
  object_kind: "merge_request";
  event_type: "merge_request";
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: MergeRequestAttributes;
  reviewers: GitLabUser[];
  changes: MergeRequestChanges;
}

// ─── GitLab API Response Types ──────────────────────────────────────────────

export interface MergeRequestDiffVersion {
  id: number;
  head_commit_sha: string;
  base_commit_sha: string;
  start_commit_sha: string;
  created_at: string;
  merge_request_id: number;
  state: string;
  real_size: string;
  patch_id_sha: string;
}

export interface DiffFile {
  old_path: string;
  new_path: string;
  a_mode: string;
  b_mode: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  too_large: boolean;
  collapsed: boolean;
  generated_file?: boolean;
}

export interface MergeRequestDiffVersionDetail extends MergeRequestDiffVersion {
  diffs: DiffFile[];
  commits: GitLabCommit[];
}

// ─── Review Types ───────────────────────────────────────────────────────────

export interface ReviewComment {
  file: string;
  line: number;
  body: string;
  severity: "info" | "warning" | "critical";
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
}

// ─── Discussion Position (for posting inline comments) ──────────────────────

export interface DiffPosition {
  position_type: "text";
  base_sha: string;
  head_sha: string;
  start_sha: string;
  old_path: string;
  new_path: string;
  new_line?: number;
  old_line?: number;
}
