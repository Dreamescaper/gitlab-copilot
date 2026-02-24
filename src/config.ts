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
 *
 * Optional Jira integration (all three required to enable):
 *   JIRA_URL              – Jira instance URL (e.g. https://yourteam.atlassian.net)
 *   JIRA_EMAIL            – Email associated with the Jira API token
 *   JIRA_API_TOKEN        – Jira API token
 */

export interface Config {
  gitlabUrl: string;
  gitlabToken: string;
  gitlabBotUsername: string;
  githubToken: string;
  copilotModel: string;
  logLevel: string;
  jira?: {
    url: string;
    email: string;
    apiToken: string;
  };
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

  // Optional Jira integration — all three vars must be set to enable
  const jiraUrl = process.env["JIRA_URL"];
  const jiraEmail = process.env["JIRA_EMAIL"];
  const jiraApiToken = process.env["JIRA_API_TOKEN"];
  const jira =
    jiraUrl && jiraEmail && jiraApiToken
      ? { url: jiraUrl.replace(/\/+$/, ""), email: jiraEmail, apiToken: jiraApiToken }
      : undefined;

  if (jira) {
    console.log(`[config] Jira integration enabled (${jira.url})`);
  }

  return {
    gitlabUrl: gitlabUrl.replace(/\/+$/, ""),
    gitlabToken: requireEnv("GITLAB_TOKEN"),
    gitlabBotUsername: requireEnv("GITLAB_BOT_USERNAME"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    copilotModel: process.env["COPILOT_MODEL"] ?? "gpt-4.1",
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    jira,
  };
}


