import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PROMPT_FILE_CANDIDATES = [
	join(process.cwd(), "src", "prompts", "comment-reply-system.md"),
	join(process.cwd(), "prompts", "comment-reply-system.md"),
];

export async function loadCommentReplySystemPrompt(): Promise<string> {
	for (const path of PROMPT_FILE_CANDIDATES) {
		try {
			const content = (await readFile(path, "utf-8")).trim();
			if (content.length > 0) {
				console.log(`[reviewer] Loaded comment reply system prompt from ${path}`);
				return content;
			}
		} catch {
			// prompt file not found, try next
		}
	}

	throw new Error(
		"Comment-reply system prompt file not found or empty. Expected one of: " +
		PROMPT_FILE_CANDIDATES.join(", "),
	);
}
