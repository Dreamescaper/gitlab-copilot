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
- **GitHub account** with Copilot access + a Personal Access Token
- **GitLab instance** with a project access token or PAT with `api` scope
- **GitLab service account** (the "bot" user that triggers reviews)
- **Copilot CLI** binary – the SDK communicates with it in server mode (Lambda layer)
- **Git** – available in Lambda environment (Lambda layer)
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
│   ├── main.tf           # Terraform config (Lambda + Function URL)
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

The Lambda function requires two layers:

#### Copilot CLI Layer

The Copilot SDK spawns the Copilot CLI as a child process.

```bash
# Download the Copilot CLI linux-x64 binary
mkdir -p copilot-layer/bin
# Place the copilot binary in copilot-layer/bin/copilot
chmod +x copilot-layer/bin/copilot
cd copilot-layer && zip -r ../copilot-cli-layer.zip .

# Create the layer
aws lambda publish-layer-version \
  --layer-name copilot-cli \
  --zip-file fileb://copilot-cli-layer.zip \
  --compatible-runtimes nodejs24.x
```

Set `copilot_cli_layer_arn` in your Terraform vars.

#### Git Layer

Lambda doesn't include git by default. You need a layer with a statically-linked git binary.

```bash
# Option: use lambci/git-lambda-layer or build your own
# Or use an existing community layer ARN for your region
```

Set `git_layer_arn` in your Terraform vars. If git is already available in your Lambda environment (e.g. via a custom runtime), you can leave this empty.

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
