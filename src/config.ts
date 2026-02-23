/**
 * Configuration loaded from environment variables.
 *
 * Required environment variables:
 *   GITLAB_TOKEN         – Personal/project access token with `api` scope
 *   GITLAB_BOT_USERNAME  – Username of the service account that triggers reviews
 *   GITHUB_TOKEN         – GitHub PAT with Copilot access (for the Copilot SDK)
 *
 * GitLab URL (automatically available in CI):
 *   CI_SERVER_URL        – GitLab instance URL (predefined variable)
 *   GITLAB_URL           – Override for local testing (if CI_SERVER_URL not set)
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  // Use CI_SERVER_URL (predefined) or fall back to GITLAB_URL (for local testing)
  const gitlabUrl = process.env["CI_SERVER_URL"] ?? process.env["GITLAB_URL"];
  if (!gitlabUrl) {
    throw new Error("Missing GitLab URL: CI_SERVER_URL or GITLAB_URL must be set");
  }

  return {
    gitlabUrl: gitlabUrl.replace(/\/+$/, ""),
    gitlabToken: requireEnv("GITLAB_TOKEN"),
    gitlabBotUsername: requireEnv("GITLAB_BOT_USERNAME"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    copilotModel: process.env["COPILOT_MODEL"] ?? "gpt-4.1",
    logLevel: process.env["LOG_LEVEL"] ?? "info",
  };
}


