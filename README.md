# GitLab Copilot Reviewer

Automated code review for GitLab Merge Requests powered by **GitHub Copilot SDK**, running on **GitLab CI**.

## How It Works

```
┌─────────────┐    Webhook    ┌───────────────────┐   Trigger API   ┌────────────────────┐
│   GitLab    │──── POST ────▶│  Webhook Receiver  │──── POST ─────▶│  Reviewer Project  │
│  (MR hook)  │               │  (Docker container)│                │  (GitLab CI job)   │
└─────────────┘               └───────────────────┘                └─────────┬──────────┘
                                                                              │
                                                                    1. Clone target repo
                                                                    2. Fetch diff metadata
                                                                    3. Copilot SDK review
                                                                    4. Post comments to MR
```

### Trigger Flow

1. A user adds a **service account** (e.g. `copilot-reviewer`) as a reviewer on a Merge Request in any target project.
2. GitLab fires a **Merge Request webhook** to the webhook receiver.
3. The receiver validates the token, checks that the bot was *newly added* as a reviewer, and that the MR is not a draft.
4. The receiver triggers a **CI pipeline** in the reviewer project via the [Pipeline Trigger API](https://docs.gitlab.com/ee/ci/triggers/), passing MR metadata (project ID, MR IID, branches, etc.) as pipeline variables.
5. The CI job starts on your existing GitLab runner:
   - **Clones the target project** (`--depth 1 --single-branch`) to get full source context
   - Fetches MR diff metadata via the GitLab API (SHAs, line mappings for inline comments)
   - Creates a **Copilot SDK session** with `workingDirectory` pointed at the cloned repo
   - Copilot explores the codebase using built-in Read/Bash/Grep tools and returns structured JSON
6. Comments are posted back as **inline diff discussions** on the MR. A summary note is also posted.

### Two Components

| Component | What | Where it runs |
|---|---|---|
| **Webhook receiver** (`src/server.ts`) | Lightweight HTTP server — validates webhooks, triggers pipelines | Docker container (on runner host, k8s, anywhere) |
| **Review job** (`src/index.ts`) | Clones target repo, runs Copilot review, posts comments | GitLab CI pipeline on your existing runner |

## Why GitLab CI (not Lambda)?

| Factor | AWS Lambda | GitLab CI |
|---|---|---|
| New infrastructure | Function URL, IAM, layers, Terraform | None — reuse existing runner |
| Git | Needs Lambda layer | Already available |
| Node.js 24 | Runtime supported, SDK needs layer | Docker image `node:24-slim` |
| Secrets | AWS Secrets Manager | GitLab CI/CD variables |
| Timeout | 15 min max | No hard limit |
| Disk space | 10 GB max ephemeral | Full runner disk |
| Cold starts | Yes | No |
| Complexity | High | Low |

## Prerequisites

- **GitLab runner** (shared or project-specific)
- **Docker** — for running the webhook receiver and the CI job image
- **Node.js 24+** — used in the CI job image (`node:24-slim`)
- **GitHub account** with Copilot access + a Personal Access Token
- **GitLab access token** with `api` scope (for API calls and cloning target repos)
- **GitLab service account** — the "bot" user that triggers reviews

## Project Structure

```
├── src/
│   ├── index.ts          # CLI entrypoint (runs in CI job)
│   ├── server.ts         # Webhook receiver (runs as Docker container)
│   ├── config.ts         # Environment variable loader
│   ├── types.ts          # TypeScript types (webhook, API, review)
│   ├── webhook.ts        # Webhook validation & trigger logic
│   ├── gitlab-client.ts  # GitLab REST API client (diffs + comments)
│   ├── git.ts            # Git clone helper (shallow clone + cleanup)
│   └── reviewer.ts       # Copilot SDK integration (workingDirectory)
├── .gitlab-ci.yml        # CI pipeline for the review job
├── Dockerfile.webhook    # Docker image for the webhook receiver
├── package.json
└── tsconfig.json
```

## Setup

### 1. Create the Reviewer Project

Create a new GitLab project (e.g. `infra/copilot-reviewer`) and push this code to it. This is the project whose CI pipeline will run the reviews.

### 2. Install Dependencies & Build

```bash
npm install
npm run build:all
```

This produces:
- `dist/index.mjs` — review CLI (used by the CI job)
- `dist/server.mjs` — webhook receiver

Commit `dist/` to the repo so the CI job can use it directly without a build step. Or add a build stage to the CI pipeline.

### 3. Create a Pipeline Trigger Token

In the reviewer project:
1. Go to **Settings → CI/CD → Pipeline trigger tokens**
2. Create a new trigger token
3. Save the token — you'll need it for the webhook receiver

### 4. Configure CI/CD Variables

In the reviewer project, go to **Settings → CI/CD → Variables** and add:

| Variable | Type | Protected | Masked | Value |
|---|---|---|---|---|
| `GITLAB_URL` | Variable | No | No | `https://gitlab.example.com` |
| `GITLAB_TOKEN` | Variable | No | ✅ | GitLab access token with `api` scope |
| `GITLAB_BOT_USERNAME` | Variable | No | No | `copilot-reviewer` |
| `GITHUB_TOKEN` | Variable | No | ✅ | GitHub PAT with Copilot access |
| `COPILOT_MODEL` | Variable | No | No | `gpt-4.1` (optional) |

### 5. Deploy the Webhook Receiver

Build and run the Docker container:

```bash
# Build
docker build -f Dockerfile.webhook -t copilot-reviewer-webhook .

# Run
docker run -d --name copilot-reviewer-webhook \
  -p 3000:3000 \
  -e GITLAB_URL=https://gitlab.example.com \
  -e GITLAB_TOKEN=glpat-... \
  -e GITLAB_BOT_USERNAME=copilot-reviewer \
  -e GITLAB_WEBHOOK_SECRET=your-webhook-secret \
  -e GITLAB_TRIGGER_TOKEN=your-trigger-token \
  -e REVIEWER_PROJECT_ID=123 \
  copilot-reviewer-webhook
```

The receiver exposes:
- `POST /webhook` — GitLab webhook endpoint
- `GET /health` — health check

### 6. Configure GitLab Webhooks

In each target project you want to review:
1. Go to **Settings → Webhooks**
2. **URL**: `http://<webhook-receiver-host>:3000/webhook`
3. **Secret token**: same value as `GITLAB_WEBHOOK_SECRET`
4. **Trigger**: check **Merge request events**
5. Save

### 7. Trigger a Review

1. Open or update a Merge Request in a target project
2. Add the bot user (e.g. `copilot-reviewer`) as a **Reviewer**
3. The webhook fires → receiver triggers the pipeline → CI job reviews and posts comments

## Environment Variables

### Review Job (CI/CD Variables)

| Variable | Required | Description |
|---|---|---|
| `GITLAB_URL` | ✅ | GitLab instance URL |
| `GITLAB_TOKEN` | ✅ | Access token with `api` scope (also used for cloning) |
| `GITLAB_BOT_USERNAME` | ✅ | Service account username |
| `GITHUB_TOKEN` | ✅ | GitHub PAT with Copilot access |
| `COPILOT_MODEL` | | Model to use (default: `gpt-4.1`) |
| `LOG_LEVEL` | | Logging level (default: `info`) |

### Webhook Receiver (Docker env)

| Variable | Required | Description |
|---|---|---|
| `GITLAB_URL` | ✅ | GitLab instance URL |
| `GITLAB_TOKEN` | ✅ | Access token with `api` scope |
| `GITLAB_BOT_USERNAME` | ✅ | Service account username |
| `GITLAB_WEBHOOK_SECRET` | ✅ | Webhook secret for payload verification |
| `GITLAB_TRIGGER_TOKEN` | ✅ | Pipeline trigger token for the reviewer project |
| `REVIEWER_PROJECT_ID` | ✅ | GitLab project ID of the reviewer project |
| `REVIEWER_PROJECT_REF` | | Git ref to trigger (default: `main`) |
| `WEBHOOK_PORT` | | Port to listen on (default: `3000`) |

## How Comments Are Posted

- **Inline diff discussions**: Each finding is posted on the specific file and line. Includes severity indicator (🔴 critical, 🟡 warning, ℹ️ info).
- **Summary note**: Overall assessment with comment count.
- **Fallback**: If an inline comment fails (e.g. line not in diff), it falls back to a regular MR note.

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| Webhook receiver returns 401 | Wrong webhook secret | Ensure `GITLAB_WEBHOOK_SECRET` matches in both webhook config and receiver |
| Pipeline not triggered | Trigger token invalid or wrong project ID | Verify `GITLAB_TRIGGER_TOKEN` and `REVIEWER_PROJECT_ID` |
| CI job: `Cannot find module '@github/copilot-sdk'` | SDK not installed | Add `npm ci` to `before_script` or commit `node_modules` |
| CI job: git clone fails | Token lacks access to target project | Ensure `GITLAB_TOKEN` has `api` scope and access to target projects |
| No comments posted | Copilot returned unparseable response | Check CI job log for raw Copilot output; adjust system prompt |
| Webhook not triggering | Wrong event type or bot not in reviewers | Verify webhook is set to "Merge request events"; check bot username |
| Inline comment fails | Line not present in MR diff | Expected — falls back to a regular MR note |

### Checking Logs

```bash
# Webhook receiver logs
docker logs copilot-reviewer-webhook -f

# CI job logs
# → Go to the reviewer project → CI/CD → Pipelines → select the triggered pipeline
```

## Architecture Decisions

| Decision | Rationale |
|---|---|
| **GitLab CI over Lambda** | Reuses existing runner; no new infrastructure; no timeout/disk/cold-start constraints |
| **Separate webhook receiver** | GitLab webhooks can't trigger cross-project pipelines directly; the receiver translates webhook → Pipeline Trigger API |
| **Pipeline Trigger API** | Native GitLab mechanism for triggering pipelines with custom variables; no custom CI bridge needed |
| **Copilot SDK over CLI** | CLI `/review` is TUI-only; SDK supports headless use, token auth, structured output |
| **Shallow clone** | Minimizes time and disk; Copilot rarely needs full history |
| **Diff metadata from API** | SHAs and line mappings needed for GitLab's `position` object when posting inline discussions |

