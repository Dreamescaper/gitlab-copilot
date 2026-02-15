/**
 * Configuration loaded from environment variables.
 *
 * Required environment variables:
 *   GITLAB_URL           – GitLab instance base URL (e.g. https://gitlab.example.com)
 *   GITLAB_TOKEN         – Personal/project access token with `api` scope
 *   GITLAB_BOT_USERNAME  – Username of the service account that triggers reviews
 *   GITHUB_TOKEN         – GitHub PAT with Copilot access (for the Copilot SDK)
 *
 * Optional environment variables:
 *   GITLAB_WEBHOOK_SECRET – Webhook secret token for payload verification
 *   COPILOT_MODEL         – Model to use (default: gpt-4.1)
 *   LOG_LEVEL             – Logging verbosity (default: info)
 */

export interface Config {
  gitlabUrl: string;
  gitlabToken: string;
  gitlabBotUsername: string;
  gitlabWebhookSecret: string | undefined;
  githubToken: string;
  copilotModel: string;
  logLevel: string;
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
    gitlabWebhookSecret: process.env["GITLAB_WEBHOOK_SECRET"],
    githubToken: requireEnv("GITHUB_TOKEN"),
    copilotModel: process.env["COPILOT_MODEL"] ?? "gpt-4.1",
    logLevel: process.env["LOG_LEVEL"] ?? "info",
  };
}
