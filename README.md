# GitLab Copilot Reviewer

Automated code review for GitLab Merge Requests powered by **GitHub Copilot SDK**, running on **GitLab CI**.

## How It Works

```
┌─────────────┐  Webhook (MR event)   ┌────────────────────┐
│   GitLab    │─── POST (trigger) ───▶│  Reviewer Project   │
│  (MR hook)  │                       │  (GitLab CI job)    │
└─────────────┘                       └─────────┬──────────┘
                                                 │
                                       1. Parse $TRIGGER_PAYLOAD
                                       2. Validate event (bot added as reviewer)
                                       3. Clone target repo
                                       4. Fetch diff metadata
                                       5. Copilot SDK review
                                       6. Post comments to MR
```

### Trigger Flow

1. A user adds a **service account** (e.g. `copilot-reviewer`) as a reviewer on a Merge Request in any target project.
2. GitLab fires a **Merge Request webhook** directly to the reviewer project's [Pipeline Trigger URL](https://docs.gitlab.com/ci/triggers/#use-a-webhook).
3. A CI pipeline starts in the reviewer project. The webhook payload is available as the `$TRIGGER_PAYLOAD` file variable.
4. The review script parses the payload, validates that the bot was *newly added* as a reviewer and the MR is not a draft.
5. If conditions are met, the script:
   - **Clones the target project** (`--depth 1 --single-branch`) to get full source context
   - Fetches MR diff metadata via the GitLab API (SHAs, line mappings for inline comments)
   - Creates a **Copilot SDK session** with `workingDirectory` pointed at the cloned repo
   - Copilot explores the codebase using built-in Read/Bash/Grep tools and returns structured JSON
6. Comments are posted back as **inline diff discussions** on the MR. A summary note is also posted.

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
│   ├── webhook.ts        # Webhook payload validation (trigger conditions)
│   ├── gitlab-client.ts  # GitLab REST API client (diffs + comments)
│   ├── git.ts            # Git clone helper (shallow clone + cleanup)
│   └── reviewer.ts       # Copilot SDK integration (workingDirectory)
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

**Note**: The GitLab instance URL is automatically available via the `CI_SERVER_URL` predefined variable.

### 5. Configure Webhooks in Target Projects

For each project you want Copilot to review:

1. Go to **Settings → Webhooks → Add new webhook**
2. **URL**: enter the Pipeline Trigger URL:
   ```
   https://gitlab.example.com/api/v4/projects/<REVIEWER_PROJECT_ID>/ref/main/trigger/pipeline?token=<TRIGGER_TOKEN>
   ```
   Replace `<REVIEWER_PROJECT_ID>` with the reviewer project's ID and `<TRIGGER_TOKEN>` with the token from step 3.
3. **Trigger**: check **Merge request events**
4. Leave **Secret token** empty (auth is via the trigger token in the URL)
5. Optionally enable **SSL verification**
6. Save

### 6. Add the Bot as a Project Member

In each target project, add the service account (e.g. `copilot-reviewer`) as a member with at least **Reporter** role. This allows the bot to post comments.

### 7. Trigger a Review

1. Open or update a Merge Request in a target project
2. Add the bot user (e.g. `copilot-reviewer`) as a **Reviewer**
3. The webhook fires → pipeline triggers → CI job reviews and posts comments

## Environment Variables (CI/CD)

| Variable | Required | Description |
|---|---|---|
| `CI_SERVER_URL` | Auto | GitLab instance URL (predefined variable, automatically set) |
| `GITLAB_TOKEN` | ✅ | Access token with `api` scope (also used for cloning) |
| `GITLAB_BOT_USERNAME` | ✅ | Service account username |
| `GITHUB_TOKEN` | ✅ | GitHub PAT with Copilot access |
| `COPILOT_MODEL` | | Model to use (default: `gpt-4.1`) |
| `LOG_LEVEL` | | Logging level (default: `info`) |

## Customizing Reviews Per Project

You can add a `copilot-instructions.md` and/or `agents.md` file to the target project to customize the review behavior. The review script checks these paths (first found wins):

- `.github/copilot-instructions.md`
- `.gitlab/copilot-instructions.md`
- `copilot-instructions.md`

Same for `agents.md`. Contents are appended to the Copilot system prompt.

## How Comments Are Posted

- **Inline diff discussions**: Each finding is posted on the specific file and line. Includes severity indicator (🔴 critical, 🟡 warning, ℹ️ info).
- **Summary note**: Overall assessment with comment count.
- **Fallback**: If an inline comment fails (e.g. line not in diff), it falls back to a regular MR note.

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| Pipeline not triggered | Wrong trigger token or project ID in webhook URL | Double-check the URL in the target project's webhook settings |
| CI job: `TRIGGER_PAYLOAD variable not set` | Pipeline not triggered via webhook/trigger API | Ensure `$CI_PIPELINE_SOURCE` is `trigger` |
| CI job: `Event does not require a review` | Non-MR event, draft MR, or bot not newly added | This is expected — the pipeline exits gracefully for irrelevant events |
| CI job: `Cannot find module '@github/copilot-sdk'` | SDK not installed | Add `npm ci` to `before_script` or commit `node_modules` |
| CI job: git clone fails | Token lacks access to target project | Ensure `GITLAB_TOKEN` has `api` scope and access to target projects |
| No comments posted | Copilot returned unparseable response | Check CI job log for raw Copilot output; adjust system prompt |
| Webhook 403 error | Pipeline events can cause loops | Only use **Merge request events** — never pipeline events |
| Inline comment fails | Line not present in MR diff | Expected — falls back to a regular MR note |

### Checking Logs

```bash
# CI job logs
# → Go to the reviewer project → CI/CD → Pipelines → select the triggered pipeline
```

## Architecture Decisions

| Decision | Rationale |
|---|---|
| **GitLab CI over Lambda** | Reuses existing runner; no new infrastructure; no timeout/disk/cold-start constraints |
| **Direct webhook trigger** | GitLab webhooks can trigger pipelines natively via the Pipeline Trigger URL — no intermediary server needed |
| **Payload via $TRIGGER_PAYLOAD** | GitLab exposes the webhook body as a file-type variable; the review script parses it to extract MR metadata |
| **Copilot SDK over CLI** | CLI `/review` is TUI-only; SDK supports headless use, token auth, structured output |
| **Shallow clone** | Minimizes time and disk; Copilot rarely needs full history |
| **Diff metadata from API** | SHAs and line mappings needed for GitLab's `position` object when posting inline discussions |

