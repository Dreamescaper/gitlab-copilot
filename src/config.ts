/**
 * Configuration loaded from environment variables.
 *
 * Used by both the CI review job and the webhook receiver.
 *
 * Required environment variables:
 *   GITLAB_URL           – GitLab instance base URL (e.g. https://gitlab.example.com)
 *   GITLAB_TOKEN         – Personal/project access token with `api` scope
 *   GITLAB_BOT_USERNAME  – Username of the service account that triggers reviews
 *   GITHUB_TOKEN         – GitHub PAT with Copilot access (for the Copilot SDK)
 *
 * Optional environment variables:
 *   COPILOT_MODEL         – Model to use (default: gpt-4.1)
 *   LOG_LEVEL             – Logging verbosity (default: info)
 */

export interface Config {
  gitlabUrl: string;
  gitlabToken: string;
  gitlabBotUsername: string;
  githubToken: string;
  copilotModel: string;
  logLevel: string;
}

/**
 * Configuration for the webhook receiver process.
 *
 * Required environment variables:
 *   GITLAB_URL             – GitLab instance base URL
 *   GITLAB_TOKEN           – GitLab access token with `api` scope
 *   GITLAB_BOT_USERNAME    – Username of the service account
 *   GITLAB_WEBHOOK_SECRET  – Webhook secret for payload verification
 *   GITLAB_TRIGGER_TOKEN   – CI pipeline trigger token
 *   REVIEWER_PROJECT_REF   – Git ref in the reviewer project to run the pipeline from (default: main)
 *
 * Optional:
 *   WEBHOOK_PORT           – Port to listen on (default: 3000)
 */
export interface WebhookServerConfig {
  gitlabUrl: string;
  gitlabToken: string;
  gitlabBotUsername: string;
  gitlabWebhookSecret: string;
  gitlabTriggerToken: string;
  reviewerProjectId: string;
  reviewerProjectRef: string;
  webhookPort: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    gitlabUrl: requireEnv("GITLAB_URL").replace(/\/+$/, ""),
    gitlabToken: requireEnv("GITLAB_TOKEN"),
    gitlabBotUsername: requireEnv("GITLAB_BOT_USERNAME"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    copilotModel: process.env["COPILOT_MODEL"] ?? "gpt-4.1",
    logLevel: process.env["LOG_LEVEL"] ?? "info",
  };
}

export function loadWebhookServerConfig(): WebhookServerConfig {
  return {
    gitlabUrl: requireEnv("GITLAB_URL").replace(/\/+$/, ""),
    gitlabToken: requireEnv("GITLAB_TOKEN"),
    gitlabBotUsername: requireEnv("GITLAB_BOT_USERNAME"),
    gitlabWebhookSecret: requireEnv("GITLAB_WEBHOOK_SECRET"),
    gitlabTriggerToken: requireEnv("GITLAB_TRIGGER_TOKEN"),
    reviewerProjectId: requireEnv("REVIEWER_PROJECT_ID"),
    reviewerProjectRef: process.env["REVIEWER_PROJECT_REF"] ?? "main",
    webhookPort: Number(process.env["WEBHOOK_PORT"] ?? "3000"),
  };
}
