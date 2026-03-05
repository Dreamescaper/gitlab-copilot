import type { DiffFile, MergeRequestCommentContext } from "../types.js";

const REVIEW_CONTEXT_COMMENT_LIMIT = 30;
const REVIEW_CONTEXT_COMMENT_BODY_LIMIT = 500;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function buildMrCommentsSection(
  mrComments: MergeRequestCommentContext[] | undefined,
): string {
  if (!mrComments || mrComments.length === 0) {
    return "";
  }

  const recent = mrComments.slice(-REVIEW_CONTEXT_COMMENT_LIMIT);
  const entries = recent
    .map((comment) => {
      const location = comment.filePath
        ? `, ${comment.filePath}${comment.lineNumber ? `:${comment.lineNumber}` : ""}`
        : "";
      const body = truncate(
        normalizeWhitespace(comment.body),
        REVIEW_CONTEXT_COMMENT_BODY_LIMIT,
      );
      return `- **${comment.author}** (${comment.createdAt}, ${comment.source}${location})\n  ${body}`;
    })
    .join("\n");

  const truncatedNote =
    mrComments.length > recent.length
      ? `\n\n> Showing the latest ${recent.length} of ${mrComments.length} MR comment message(s).`
      : "";

  return `## Existing MR Comment Context\n${
    "Use this history to avoid repeating already-addressed findings and to incorporate author clarifications/replies."}
\n\n${entries}${truncatedNote}\n\n`;
}

/**
 * Build the user prompt that presents the MR diff to the reviewer.
 */
export function buildDiffPrompt(
  mrTitle: string,
  mrDescription: string,
  mrUrl: string,
  sourceBranch: string,
  targetBranch: string,
  diffs: DiffFile[],
  mrComments?: MergeRequestCommentContext[],
): string {
  const filesDiff = diffs
    .filter((d) => !d.too_large && !d.collapsed)
    .map((d) => {
      const status = d.new_file
        ? "(new file)"
        : d.deleted_file
          ? "(deleted)"
          : d.renamed_file
            ? `(renamed from ${d.old_path})`
            : "";
      return `### ${d.new_path} ${status}\n\`\`\`diff\n${d.diff}\n\`\`\``;
    })
    .join("\n\n");

  const skipped = diffs.filter((d) => d.too_large || d.collapsed);
  const skippedNote =
    skipped.length > 0
      ? `\n\n> **Note**: ${skipped.length} file(s) were too large to include in the diff. ` +
        `You can read them directly from the working directory: ${skipped.map((d) => d.new_path).join(", ")}`
      : "";

  const mrCommentsSection = buildMrCommentsSection(mrComments);

  return `# Merge Request: ${mrTitle}
**Branch**: \`${sourceBranch}\` → \`${targetBranch}\`
**URL**: ${mrUrl}

## Description
${mrDescription || "(no description)"}

${mrCommentsSection}## Changed Files (${diffs.length} file(s))

${filesDiff}${skippedNote}

---

Please review the above changes. The full repository is available in your working directory — read related source files, imports, tests, documentation, and configuration to understand context before producing your review.

When done, call the **submit_review** tool with your review.`;
}

/**
 * Build the user prompt for a comment reply session.
 */
export function buildCommentReplyPrompt(opts: {
  mrTitle: string;
  mrUrl: string;
  filePath?: string;
  lineNumber?: number;
  diffContext?: string;
  threadMessages: Array<{ author: string; body: string; createdAt: string }>;
}): string {
  let prompt = `# Merge Request: ${opts.mrTitle}\n**URL**: ${opts.mrUrl}\n\n`;

  if (opts.filePath) {
    prompt += `## File Context\n**File**: \`${opts.filePath}\``;
    if (opts.lineNumber) {
      prompt += ` (line ${opts.lineNumber})`;
    }
    prompt += "\n\n";
  }

  if (opts.diffContext) {
    prompt += `## Diff\n\`\`\`diff\n${opts.diffContext}\n\`\`\`\n\n`;
  }

  prompt += `## Discussion Thread\n\n`;
  for (const msg of opts.threadMessages) {
    prompt += `**${msg.author}** (${msg.createdAt}):\n${msg.body}\n\n---\n\n`;
  }

  prompt += `Please respond to the latest message in this discussion thread. Provide a helpful and specific answer.`;

  return prompt;
}
