import type { DiffFile } from "../types.js";

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
  jiraContext?: string,
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

  const jiraSection = jiraContext
    ? `\n## Jira Issue Context\n\nThe following Jira issue(s) are referenced in this MR. Use this context to understand the business requirements and verify the implementation matches what was requested.\n\n${jiraContext}\n`
    : "";

  return `# Merge Request: ${mrTitle}
**Branch**: \`${sourceBranch}\` → \`${targetBranch}\`
**URL**: ${mrUrl}

## Description
${mrDescription || "(no description)"}
${jiraSection}
## Changed Files (${diffs.length} file(s))

${filesDiff}${skippedNote}

---

Please review the above changes. The full repository is available in your working directory — read related source files, imports, tests, documentation, and configuration to understand context before producing your review.

When done, output your review as JSON.`;
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
  jiraContext?: string;
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

  if (opts.jiraContext) {
    prompt += `## Jira Issue Context\n\n${opts.jiraContext}\n\n`;
  }

  prompt += `## Discussion Thread\n\n`;
  for (const msg of opts.threadMessages) {
    prompt += `**${msg.author}** (${msg.createdAt}):\n${msg.body}\n\n---\n\n`;
  }

  prompt += `Please respond to the latest message in this discussion thread. Provide a helpful and specific answer.`;

  return prompt;
}
