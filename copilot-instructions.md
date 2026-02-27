# Copilot Instructions for gitlab-copilot

This is a GitLab MR code review system powered by GitHub Copilot SDK, running on GitLab CI runners.

## Architecture Overview

- **Trigger**: GitLab webhooks (MR events + Note events) → GitLab Pipeline Trigger API → CI job
- **Entrypoint**: `src/index.ts` — parses `$TRIGGER_PAYLOAD`, classifies event, orchestrates review or comment reply
- **Two modes**: Full MR code review OR comment reply to @mentions

## Key Source Files

### `src/index.ts` (~320 lines)
CLI entrypoint. Reads `TRIGGER_PAYLOAD` env var, calls webhook classification, clones repo, runs review or comment reply, posts results. Has `handleMergeRequestReview()` and `handleCommentReply()` flows.

### `src/config.ts` (~77 lines)
Loads config from environment variables. Required: `GITLAB_TOKEN`, `GITLAB_BOT_USERNAME`, `GITHUB_TOKEN`. Optional: `COPILOT_MODEL` (default `gpt-4.1`), `LOG_LEVEL`, `JIRA_*` vars.

### `src/types.ts` (~212 lines)
All TypeScript types: webhook payloads (`MergeRequestWebhookPayload`, `NoteWebhookPayload`), GitLab API types (`DiffFile`, `DiffPosition`, `MergeRequestDiffVersion`, `MergeRequestDiffVersionDetail`), review types (`ReviewResult`, `ReviewComment`).

### `src/webhook.ts` (~220 lines)
Event classification logic:
- `shouldTriggerReview()` — 4 cases: bot newly added, re-requested, draft→ready, MR opened with bot assigned
- `shouldRespondToComment()` — checks for @bot mentions in note webhooks
- Both return structured result objects with relevant metadata

### `src/gitlab-client.ts` (~490 lines)
GitLab REST API client. Key methods:
- `getDiffVersions()` / `getDiffVersionDetail()` — fetch MR diff metadata (SHAs, file diffs)
- `getDiscussions()` — fetch existing discussion threads (for duplicate detection + reply context)
- `createDraftNote()` / `createDraftDiffNote()` — create draft notes (general or positioned on diff)
- `publishAllDraftNotes()` — bulk publish all drafts (GitLab's "Submit Review")
- `postMergeRequestNote()` — post simple note (used for summary)
- `postReview()` — orchestrates full review posting: iterates comments, resolves positions, creates draft notes, publishes, posts summary

**Important diff line resolution:**
- `parseDiffLines(diff)` — parses unified diff, returns `Map<newLine, DiffLineInfo>` where `DiffLineInfo` has `{ newLine, oldLine }`. `oldLine` is null for added lines, set for context lines.
- `computeOldLine(diff, newLine)` — for lines OUTSIDE diff hunks (expanded context), computes old_line from cumulative hunk offsets.
- `DiffPosition` requires `old_line` + `new_line` for context lines (otherwise `line_code` is null and note doesn't anchor).
- Draft notes are created WITHOUT `commit_id` — the position's `head_sha`/`base_sha`/`start_sha` suffice. Sending `commit_id` causes 400 errors when MR head moves.

### `src/reviewer.ts` (~525 lines)
Copilot SDK integration:
- `reviewMergeRequest()` — creates Copilot session with system prompt, sends diff, parses JSON response
- `replyToComment()` — creates session for thread reply, sends discussion context
- `buildSessionHooks()` — logging hooks for tool calls (onPreToolUse/onPostToolUse)
- `attachSessionListeners()` — tracks `assistant.usage` events for token/cost reporting, plus error/idle/reasoning listeners
- `loadProjectInstructions()` — loads copilot-instructions.md, agents.md, skill directories from cloned repo
- `parseReviewResponse()` — extracts JSON from markdown fences, validates structure

### `src/prompts/` directory
- `review-system.ts` — `REVIEW_SYSTEM_PROMPT` constant: expert code reviewer persona, workflow, focus areas, JSON output format
- `comment-reply-system.ts` — `COMMENT_REPLY_SYSTEM_PROMPT` constant: discussion reply persona, GitLab suggestion syntax
- `build-prompts.ts` — `buildDiffPrompt()` (MR diff presentation with Jira context) and `buildCommentReplyPrompt()` (thread context builder)

### `src/jira-client.ts` (~200 lines)
Optional Jira Cloud REST API client. Fetches issue details + comments when Jira key found in MR title. Uses Basic auth.

### `src/git.ts`
Shallow clone helper. Clones target repo at MR source branch, includes `cleanup()`.

## Testing

- Framework: vitest (configured in package.json)
- Tests in `src/gitlab-client.test.ts`:
  - `parseDiffLines` — 12 tests covering added lines, context lines, removed lines, multiple hunks, real-world scenarios
  - `computeOldLine` — 8 tests covering offset computation for out-of-hunk lines
- Run: `npm test` or `npx vitest run`

## Required Validation After Every Code Change

- After each code change, always run:
  1. `npm run build`
  2. `npm test`
- Treat both commands as mandatory unless the user explicitly asks to skip them.
- If either command fails, report the failure and fix relevant issues before finalizing.

## Build

- esbuild bundles to `dist/index.mjs` (ESM, node24 target)
- `@github/copilot-sdk` is external (not bundled)
- Build: `npm run build`

## Key Design Decisions

1. **No `commit_id` on draft notes** — causes 400 when MR head moves; position SHAs are sufficient
2. **Both `old_line` and `new_line` required for context lines** — otherwise GitLab can't compute `line_code` and note doesn't anchor to the diff
3. **Lines outside diff hunks are valid comment targets** — `computeOldLine()` resolves the old_line offset
4. **Summary posted as simple note** (not draft note) — non-resolvable, not part of review threads
5. **Draft notes + bulk_publish** — atomic review submission, single notification
6. **Webhook payload passed via `$TRIGGER_PAYLOAD`** — GitLab file-type CI variable

## Common Issues When Developing

- GitLab's Draft Notes API returns 204 No Content on bulk_publish — `request()` handles empty responses
- `DiffPosition.old_line` must be set for context lines or `line_code` will be null
- GitLab diff line numbers start from hunk headers (`@@ -old,count +new,count @@`)
- The `head_sha` in diff versions may differ from the current MR head if new commits were pushed
