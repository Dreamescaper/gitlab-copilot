# GitLab Copilot Reviewer

Automated code review for GitLab Merge Requests powered by **GitHub Copilot SDK**, running on **GitLab CI**.

## Features

- **Automated MR reviews** — triggered when a bot user is added as reviewer
- **Re-request support** — re-requesting a review triggers a fresh review on updated code
- **Draft-aware** — auto-reviews when MR transitions from Draft to Ready (if bot is already a reviewer)
- **Comment replies** — mention the bot (`@copilot-reviewer`) in any MR comment to get an AI-powered response with full thread context
- **Code suggestions** — inline suggestions using GitLab's Apply Suggestion UI (single-line and multi-line ranges)
- **Jira integration** — automatically fetches Jira issue descriptions and comments when a Jira key is found in the MR title
- **Skills support** — loads agent skills from `.github/skills/`, `.claude/skills/`, or `.agents/skills/` directories
- **Duplicate detection** — skips comments that have already been posted (safe to re-trigger)
- **Per-project customization** — supports `copilot-instructions.md` and `agents.md` for project-specific review guidelines
- **Submit as review** — all comments are created as draft notes and published atomically as a single "Comment" review submission
- **Copilot thinking logs** — see tool calls, file reads, and reasoning in CI logs (configurable via `LOG_LEVEL`)
- **No infrastructure required** — runs on existing GitLab runners with no intermediary servers

## How It Works

```
┌─────────────┐  Webhook (MR/Note)     ┌────────────────────┐
│   GitLab    │─── POST (trigger) ────▶│  Reviewer Project   │
│  (webhook)  │                        │  (GitLab CI job)    │
└─────────────┘                        └─────────┬──────────┘
                                                  │
                                        1. Parse $TRIGGER_PAYLOAD
                                        2. Classify event:
                                           a) MR update → full code review
                                           b) Note with @mention → comment reply
                                        3. Clone target repo
                                        4. Fetch context (diffs, threads, Jira)
                                        5. Copilot SDK session
                                        6. Post results to MR
```

### Trigger Conditions

The review pipeline triggers on two types of events:

**Full Code Review** (merge_request webhook):
1. Bot user is **newly added as a reviewer** on a non-draft MR
2. Review is **re-requested** via GitLab UI (detects `re_requested: true` on the bot's reviewer entry)
3. MR transitions from **Draft → Ready** while bot is already a reviewer
4. MR is **opened** with the bot already assigned as a reviewer (non-draft only)

**Comment Reply** (note webhook):
1. A comment on an MR mentions the bot (`@copilot-reviewer`)
2. The bot fetches the full discussion thread and replies in context

### No Webhook Receiver Needed

GitLab natively supports triggering pipelines from webhooks — no intermediary server or Docker container required. The target project's webhook URL points directly at the GitLab Pipeline Trigger API:

```
https://gitlab.example.com/api/v4/projects/<reviewer_project_id>/ref/main/trigger/pipeline?token=<trigger_token>
```

## Prerequisites

- **GitLab runner** (shared or project-specific)
- **Node.js 24+** — used in the CI job image (`node:24-slim`)
- **GitHub account** with Copilot access + a Personal Access Token
- **GitLab access token** with `api` scope (for API calls and cloning target repos)
- **GitLab service account** — the "bot" user that triggers reviews

## Project Structure

```
├── src/
│   ├── index.ts          # CLI entrypoint (runs in CI job)
│   ├── config.ts         # Environment variable loader
│   ├── types.ts          # TypeScript types (webhook, API, review)
│   ├── webhook.ts        # Event classification (MR review / comment reply / ignore)
│   ├── gitlab-client.ts  # GitLab REST API client (diffs, discussions, draft notes)
│   ├── jira-client.ts    # Jira Cloud API client (issue details + comments)
│   ├── git.ts            # Git clone helper (shallow clone + cleanup)
│   ├── reviewer.ts       # Copilot SDK integration (review + comment reply sessions)
│   ├── gitlab-client.test.ts  # Tests for diff parsing and line resolution
│   └── prompts/
│       ├── review-system.ts        # System prompt for MR reviews
│       ├── comment-reply-system.ts # System prompt for comment replies
│       └── build-prompts.ts        # User prompt builders (diff prompt, reply prompt)
├── test/
│   └── fixtures/             # Test fixture files (webhook payloads)
├── .gitlab-ci.yml        # CI pipeline for the review job
├── package.json
└── tsconfig.json
```

## Setup

### 1. Create the Reviewer Project

Create a new GitLab project (e.g. `infra/copilot-reviewer`) and push this code to it. This is the project whose CI pipeline will run the reviews.

### 2. Install Dependencies & Build

```bash
npm install
npm run build
```

This produces `dist/index.mjs` — the review script used by the CI job.

Commit `dist/` to the repo so the CI job can use it directly without a build step. Or add a build stage to the CI pipeline.

### 3. Create a Pipeline Trigger Token

In the reviewer project:
1. Go to **Settings → CI/CD → Pipeline trigger tokens**
2. Click **Add new token**, give it a description (e.g. "MR webhook trigger")
3. Save the token value — you'll use it when configuring webhooks

### 4. Configure CI/CD Variables

In the reviewer project, go to **Settings → CI/CD → Variables** and add:

| Variable | Type | Protected | Masked | Value |
|---|---|---|---|---|
| `GITLAB_TOKEN` | Variable | No | ✅ | GitLab access token with `api` scope |
| `GITLAB_BOT_USERNAME` | Variable | No | No | `copilot-reviewer` |
| `GITHUB_TOKEN` | Variable | No | ✅ | GitHub PAT with Copilot access |
| `COPILOT_MODEL` | Variable | No | No | `gpt-4.1` (optional) |
| `JIRA_URL` | Variable | No | No | `https://yourteam.atlassian.net` (optional) |
| `JIRA_EMAIL` | Variable | No | No | Email for Jira API auth (optional) |
| `JIRA_API_TOKEN` | Variable | No | ✅ | Jira API token (optional) |

**Notes:**
- `CI_SERVER_URL` (GitLab instance URL) is automatically available as a predefined CI variable.
- Jira integration is optional — all three `JIRA_*` variables must be set to enable it. If not configured, Jira context is silently skipped.

### 5. Configure Webhooks in Target Projects

For each project you want Copilot to review:

1. Go to **Settings → Webhooks → Add new webhook**
2. **URL**: enter the Pipeline Trigger URL:
   ```
   https://gitlab.example.com/api/v4/projects/<REVIEWER_PROJECT_ID>/ref/main/trigger/pipeline?token=<TRIGGER_TOKEN>
   ```
   Replace `<REVIEWER_PROJECT_ID>` with the reviewer project's ID and `<TRIGGER_TOKEN>` with the token from step 3.
3. **Trigger**: check both **Merge request events** and **Comments**
4. Leave **Secret token** empty (auth is via the trigger token in the URL)
5. Optionally enable **SSL verification**
6. Save

### 6. Add the Bot as a Project Member

In each target project, add the service account (e.g. `copilot-reviewer`) as a member with at least **Reporter** role. This allows the bot to post comments.

### 7. Trigger a Review

**Full review:**
1. Open or update a Merge Request in a target project
2. Add the bot user (e.g. `copilot-reviewer`) as a **Reviewer**
3. The webhook fires → pipeline triggers → CI job reviews and posts comments

**Re-request review (after updates):**
1. After pushing new commits to the MR, click the **Re-request review** button next to the bot reviewer
2. A fresh review runs on the updated code (duplicate detection avoids re-posting identical findings)

**Comment reply:**
1. In any MR comment or discussion thread, mention the bot: `@copilot-reviewer can you explain this?`
2. The webhook fires → pipeline triggers → CI job replies to the discussion thread

**Draft → Ready:**
1. Add the bot as a reviewer while the MR is still a Draft
2. When you mark the MR as Ready, the review triggers automatically

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CI_SERVER_URL` | Auto | GitLab instance URL (predefined variable, automatically set) |
| `GITLAB_TOKEN` | ✅ | Access token with `api` scope (also used for cloning) |
| `GITLAB_BOT_USERNAME` | ✅ | Service account username |
| `GITHUB_TOKEN` | ✅ | GitHub PAT with Copilot access |
| `COPILOT_MODEL` | | Model to use (default: `gpt-4.1`) |
| `LOG_LEVEL` | | Logging level (default: `info`). Set to `debug` for full Copilot tool-call logging |
| `JIRA_URL` | | Jira instance URL (e.g. `https://yourteam.atlassian.net`) |
| `JIRA_EMAIL` | | Email for Jira API Basic auth |
| `JIRA_API_TOKEN` | | Jira API token |

## Jira Integration

When all three `JIRA_*` variables are configured, the reviewer automatically:

1. Extracts Jira issue keys from the MR title (e.g. `AO2-2624` from `fix: AO2-2624 Old batches shouldn't send main flow request`)
2. Fetches the issue description, status, priority, assignee, and labels
3. Fetches all comments on the issue
4. Includes this context in the Copilot prompt so the review can verify the implementation matches requirements

This works for both full MR reviews and comment replies.

## Customizing Reviews Per Project

You can add project-specific instructions and skills to customize the review behavior:

### Instructions Files

The review script checks these paths (first found wins):

**`copilot-instructions.md`:**
- `.github/copilot-instructions.md`
- `.gitlab/copilot-instructions.md`
- `copilot-instructions.md`

**`agents.md`:**
- `.github/agents.md`
- `.gitlab/agents.md`
- `agents.md`

Contents are appended to the Copilot system prompt. Both files can coexist.

### Skills Directories

The Copilot SDK natively loads skills from directories. Skills are structured collections of prompts, tools, and examples that give Copilot specialized knowledge.

Supported locations (first existing directory is used):
- `.github/skills/`
- `.claude/skills/`
- `.agents/skills/`

All subdirectories within the matched location are loaded as individual skills. See the [Copilot SDK Skills Guide](https://github.com/github/copilot-sdk/blob/main/docs/guides/skills.md) for skill structure details.

Example:
```
.github/skills/
  code-review/
    skill.json
    prompts/
      system.md
  security/
    skill.json
    prompts/
      system.md
```

## How Comments Are Posted

- **Draft notes workflow**: All review findings are created as draft notes (without `commit_id` — position SHAs are sufficient), then published atomically via GitLab's `bulk_publish` API (equivalent to "Submit Review" with "Comment" action). This creates a single notification instead of one per comment.
- **Inline diff discussions**: Each finding is posted on the specific file and line. Includes severity indicator (🔴 critical, 🟡 warning, ℹ️ info).
- **Correct line positioning**: For lines inside diff hunks, both `old_line` and `new_line` are set for context lines (so GitLab can compute `line_code`). For lines outside diff hunks (expanded context), `old_line` is computed from cumulative hunk offsets.
- **Code suggestions**: When applicable, comments include GitLab suggestion blocks with single-line or multi-line range replacements (rendered as "Apply suggestion" buttons).
- **Summary note**: Overall assessment posted separately as a simple note (not resolvable, not part of review threads).
- **Duplicate detection**: Existing comments are checked before posting — re-triggering a review won't create duplicates.
- **Fallback**: If an inline comment fails, it falls back to a general draft note with file:line prefix.
- **Comment replies**: Posted directly in the discussion thread that triggered them.
- **Usage tracking**: After each review/reply session, token usage and cost are logged to CI output.

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| Pipeline not triggered | Wrong trigger token or project ID in webhook URL | Double-check the URL in the target project's webhook settings |
| CI job: `TRIGGER_PAYLOAD variable not set` | Pipeline not triggered via webhook/trigger API | Ensure `$CI_PIPELINE_SOURCE` is `trigger` |
| CI job: `Event ignored` | Non-MR event, draft MR, bot not newly added, or comment without @mention | This is expected — the pipeline exits gracefully for irrelevant events |
| CI job: `Cannot find module '@github/copilot-sdk'` | SDK not installed | Add `npm ci` to `before_script` or commit `node_modules` |
| CI job: git clone fails | Token lacks access to target project | Ensure `GITLAB_TOKEN` has `api` scope and access to target projects |
| No comments posted | Copilot returned unparseable response | Check CI job log for raw Copilot output; adjust system prompt |
| Webhook 403 error | Pipeline events can cause loops | Only use **Merge request events** and **Comments** — never pipeline events |
| Inline comment fails | Line not present in MR diff | Expected — falls back to a regular MR note |
| Jira fetch fails | Wrong credentials or issue key not found | Check `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`; review continues without Jira context |
| Bot replies to itself | Missing self-mention guard | Already handled — the bot ignores notes authored by `GITLAB_BOT_USERNAME` |

### Checking Logs

```bash
# CI job logs
# → Go to the reviewer project → CI/CD → Pipelines → select the triggered pipeline
```

By default, every Copilot tool call (file reads, grep, bash) is logged with its arguments.
Set `LOG_LEVEL=debug` to also log tool results and model reasoning tokens:

```
[copilot] ▶ tool: Read  args: {"path":"src/index.ts"}
[copilot] ◀ result (Read): {"content":"import { readFile }..."}
[copilot] ▶ tool: Grep  args: {"pattern":"handleReview","path":"src/"}
[copilot] session idle
```

## Architecture Decisions

| Decision | Rationale |
|---|---|
| **GitLab CI over Lambda** | Reuses existing runner; no new infrastructure; no timeout/disk/cold-start constraints |
| **Direct webhook trigger** | GitLab webhooks can trigger pipelines natively via the Pipeline Trigger URL — no intermediary server needed |
| **Payload via $TRIGGER_PAYLOAD** | GitLab exposes the webhook body as a file-type variable; the review script parses it to extract MR metadata |
| **Event classification** | Single entrypoint handles both MR reviews and comment replies by classifying the webhook payload type |
| **Copilot SDK over CLI** | CLI `/review` is TUI-only; SDK supports headless use, token auth, structured output |
| **Shallow clone** | Minimizes time and disk; Copilot rarely needs full history |
| **Diff metadata from API** | SHAs and line mappings needed for GitLab's `position` object when posting inline discussions |
| **Optional Jira integration** | Provides business context without requiring Jira — gracefully skipped when not configured |
| **Draft notes + bulk publish** | GitLab's "Submit Review" pattern — all comments posted atomically as a single review submission |
| **Draft notes without commit_id** | GitLab's browser UI sends `commit_id: null` for draft notes — the position's `head_sha`/`base_sha`/`start_sha` already identify the diff version. Sending an explicit `commit_id` causes 400 errors when the MR head moves after the diff version is fetched |
| **Diff line resolution** | `parseDiffLines()` tracks both `old_line` and `new_line` for each line in diff hunks. `computeOldLine()` resolves lines outside hunks using cumulative hunk offsets. This ensures all draft notes get proper `line_code` from GitLab |
| **Prompts in separate files** | System prompts and prompt builders extracted to `src/prompts/` for readability and easier iteration |
| **Native skills support** | Copilot SDK's `skillDirectories` avoids prompt bloat and supports complex skill structures |

