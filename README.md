# GitLab Copilot Reviewer

Automated code review for GitLab Merge Requests powered by **GitHub Copilot SDK**, running on **AWS Lambda**.

## How It Works

```
┌─────────────┐      Webhook       ┌──────────────────┐
│   GitLab    │ ─── MR event ────▶ │   AWS Lambda     │
│  (MR hook)  │                    │  (Function URL)  │
└─────────────┘                    └────────┬─────────┘
                                            │
                                   1. Validate webhook
                                   2. Check: bot added as reviewer?
                                            │
                              ┌─────────────┼──────────────┐
                              │             │              │
                              ▼             ▼              ▼
                    ┌────────────┐  ┌──────────────┐  ┌──────────────┐
                    │ GitLab API │  │  Git clone   │  │ Copilot SDK  │
                    │ Fetch diff │  │  (shallow)   │  │ Review code  │
                    │  metadata  │  │  to /tmp     │  │ workingDir   │
                    └────────────┘  └──────────────┘  └──────────────┘
                              │                            │
                              └─────────────┬──────────────┘
                                            │
                                            ▼
                                   Post inline comments
                                   + summary note on MR
```

### Trigger Flow

1. A user adds a **service account** (e.g. `copilot-reviewer`) as a reviewer on a Merge Request.
2. GitLab fires a **Merge Request webhook** to the Lambda Function URL.
3. The Lambda validates the webhook token, checks that the bot was *newly added* as a reviewer, and that the MR is not a draft.
4. It fetches the MR diff metadata via the **GitLab REST API** (`/versions` endpoint) – this provides the list of changed files, SHAs, and line mappings needed for posting inline comments.
5. A **shallow git clone** (`--depth 1 --single-branch`) of the source branch is performed into Lambda's `/tmp` ephemeral storage. This gives Copilot full source context – matching how GitHub Copilot Code Review works.
6. The Copilot SDK session is created with `workingDirectory` set to the cloned repo. The SDK's built-in **Read**, **Bash**, and **Grep** tools give Copilot full filesystem access to explore the codebase.
7. Copilot returns structured JSON with inline comments (file, line, severity, body).
8. Comments are posted back as **inline diff discussions** on the MR. A summary note is also posted.
9. The clone directory is cleaned up.

## Why Git Clone?

Diffs alone aren't enough for meaningful code review. Copilot needs full source context – surrounding code, imported modules, type definitions, config files, etc. A shallow clone is the simplest and most efficient way to provide this:

- **One operation** vs N API calls to browse files
- **SDK built-in tools** (Read, Bash, Grep) work natively with `workingDirectory` – no custom tool wiring needed
- **Git-native context**: `git diff`, `git log`, `git blame` available via the SDK's Bash tool
- **Matches GitHub Copilot Code Review** behavior – it also clones repos for full context

The clone is shallow (`--depth 1 --single-branch`) to minimize time and disk usage.

## Why Copilot SDK (not CLI)?

| Feature | CLI (`/review`) | SDK |
|---|---|---|
| Headless / programmatic | ❌ TUI-only | ✅ Supported |
| Custom system prompts | ❌ | ✅ `systemMessage` |
| Structured JSON output | ❌ | ✅ via prompt engineering |
| Auth via token | ❌ interactive login | ✅ `githubToken` option |
| Lambda-compatible | ❌ | ✅ |

The `/review` command is CLI-only (TUI) and not available in the SDK. However, the SDK lets us create a session with the same review behavior, plus structured output that we can parse and post as inline comments.

## Prerequisites

- **Node.js 24+** (Lambda runtime `nodejs24.x`)
- **Docker** – used to build Lambda layers for the correct platform (Amazon Linux 2023 / x86_64)
- **GitHub account** with Copilot access + a Personal Access Token
- **GitLab instance** with a project access token or PAT with `api` scope
- **GitLab service account** (the "bot" user that triggers reviews)
- **Terraform** (for infrastructure deployment)

## Project Structure

```
├── src/
│   ├── index.ts          # Lambda handler entry point
│   ├── config.ts         # Environment variable loader
│   ├── types.ts          # TypeScript types (webhook, API, review)
│   ├── webhook.ts        # Webhook validation & trigger logic
│   ├── gitlab-client.ts  # GitLab REST API client (diffs + comments)
│   ├── git.ts            # Git clone helper (shallow clone + cleanup)
│   └── reviewer.ts       # Copilot SDK integration (workingDirectory)
├── infra/
│   ├── main.tf           # Terraform config (Lambda + layers + Function URL)
│   ├── scripts/
│   │   ├── build-git-layer.sh      # Builds git Lambda layer via Docker
│   │   └── build-copilot-layer.sh  # Builds Copilot SDK Lambda layer via Docker
│   └── terraform.tfvars.example
├── package.json
└── tsconfig.json
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

This uses esbuild to bundle the TypeScript into a single `dist/index.mjs`.

### 3. Package for Lambda

```bash
npm run package
```

Creates `lambda.zip` ready for deployment. Note that `@github/copilot-sdk` is marked as external in the esbuild config – you need to include the SDK and the **Copilot CLI binary** in a Lambda layer or bundle them into the zip.

### 4. Lambda Layers

Both required Lambda layers are **built automatically** by Terraform via Docker. On the first `terraform apply`, Terraform runs build scripts that:

1. **Git layer** – spins up an Amazon Linux 2023 container, installs git, and packages the binary + shared libraries
2. **Copilot SDK layer** – spins up a Node.js 24 container, installs `@github/copilot-sdk`, and packages it in the Lambda `nodejs/` layer structure

No manual layer management needed. Docker must be running.

> **Pre-existing layers**: If you already have published layers, set `copilot_cli_layer_arn` and/or `git_layer_arn` in your Terraform vars to skip the Docker builds.

> **Rebuilding layers**: Delete the zips in `infra/layers/` and re-apply, or change the build scripts (the `null_resource` triggers on script hash).

### 5. Deploy Infrastructure

```bash
cd infra

# Copy and fill in your values
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your actual values

terraform init
terraform apply
```

This creates:
- IAM role with basic Lambda execution permissions
- Git and Copilot SDK Lambda layers (built via Docker on first run)
- Lambda function (10 min timeout, 1 GB RAM, 2 GB ephemeral storage)
- Lambda Function URL (public, secured by webhook secret)

The output includes the **Function URL** to use as the webhook endpoint.

### 6. Configure GitLab Webhook

1. Go to your GitLab project → **Settings → Webhooks**
2. **URL**: paste the Lambda Function URL from Terraform output
3. **Secret token**: the value you set for `GITLAB_WEBHOOK_SECRET`
4. **Trigger**: check **Merge request events**
5. Save

### 7. Trigger a Review

1. Open or update a Merge Request
2. Add the bot user (e.g. `copilot-reviewer`) as a **Reviewer**
3. The Lambda will be triggered, clone the repo, run the review, and post comments

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITLAB_URL` | ✅ | GitLab instance URL (e.g. `https://gitlab.example.com`) |
| `GITLAB_TOKEN` | ✅ | GitLab access token with `api` scope (also used for git clone auth) |
| `GITLAB_BOT_USERNAME` | ✅ | Username of the service account that triggers reviews |
| `GITHUB_TOKEN` | ✅ | GitHub PAT with Copilot access |
| `GITLAB_WEBHOOK_SECRET` | | Webhook secret for payload verification |
| `COPILOT_MODEL` | | Model to use (default: `gpt-4.1`) |
| `LOG_LEVEL` | | Logging level (default: `info`) |

## How Comments Are Posted

- **Inline diff discussions**: Each review finding is posted as a discussion on the specific file and line in the MR diff. The comment includes a severity indicator (🔴 critical, 🟡 warning, ℹ️ info).
- **Summary note**: A general MR note with the overall assessment and comment count.
- **Fallback**: If an inline comment fails (e.g. line not in diff), it falls back to a regular MR note.

## Resource Considerations

| Resource | Config | Rationale |
|---|---|---|
| Timeout | 600s (10 min) | Clone + Copilot review can take several minutes for large repos |
| Memory | 1024 MB | Copilot SDK + git operations |
| Ephemeral Storage | 2048 MB (2 GB) | Shallow clone of the repository |

For very large repositories, consider increasing ephemeral storage (up to 10 GB) or adjusting the clone depth.

## Local Development

Create a `.env` file:
```bash
GITLAB_URL=https://gitlab.example.com
GITLAB_TOKEN=glpat-...
GITLAB_BOT_USERNAME=copilot-reviewer
GITHUB_TOKEN=ghp_...
# GITLAB_WEBHOOK_SECRET=optional
# COPILOT_MODEL=gpt-4.1
```

You can test the handler locally by invoking it with a sample webhook payload.

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| `git: not found` in Lambda logs | Git layer missing or not attached | Check `layers` in Lambda config; ensure Docker build ran |
| `GIT_EXEC_PATH` errors | Git can't find helpers (git-remote-https) | Verify `GIT_EXEC_PATH=/opt/libexec/git-core` env var is set |
| `Cannot find module '@github/copilot-sdk'` | SDK layer missing | Check Copilot SDK layer; ensure `nodejs/node_modules/` structure |
| Lambda times out | Large repo or slow Copilot response | Increase `timeout` (max 900s) and `memory_size` |
| `ENOSPACE` during clone | Repo too large for ephemeral storage | Increase `ephemeral_storage` (max 10240 MB) |
| No comments posted | Copilot returned unparseable response | Check CloudWatch logs for raw Copilot output; adjust system prompt |
| Webhook not triggering | Wrong event type or bot not in reviewers | Verify webhook is set to "Merge request events" and bot username matches `GITLAB_BOT_USERNAME` |
| 401 on git clone | Token lacks repo access | Ensure `GITLAB_TOKEN` has `read_repository` scope (included in `api`) |
| Inline comment fails, falls back to note | Line not present in MR diff | Expected for lines outside the diff context; review posted as regular note instead |

### Checking Logs

```bash
# Tail Lambda logs (replace function name and region if different)
aws logs tail /aws/lambda/gitlab-copilot-reviewer --follow --region eu-central-1
```

## Architecture Decisions

| Decision | Rationale |
|---|---|
| **Copilot SDK over CLI** | CLI `/review` is TUI-only; SDK supports headless use, token auth, custom prompts, structured output |
| **Git clone over API browsing** | One shallow clone vs N HTTP calls; SDK built-in tools (Read/Bash/Grep) work with local filesystem; matches GitHub Copilot Code Review |
| **Shallow clone (`--depth 1`)** | Minimizes time and disk; Copilot rarely needs full history |
| **Lambda + Function URL** | Simplest serverless webhook handler; no API Gateway needed |
| **Docker-based layer builds** | Produces correct binaries for Amazon Linux 2023 / x86_64 regardless of dev machine |
| **esbuild with SDK as external** | SDK is in a Lambda layer (with native deps); esbuild bundles only our code |
| **Diff metadata from API** | SHAs and line mappings are needed for GitLab's `position` object when posting inline discussions; not available from the cloned repo alone |

