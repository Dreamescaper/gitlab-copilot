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
 *   COPILOT_CONFIG_DIR    – Copilot SDK config/session directory (default: .copilot-sessions)
 *   LOG_LEVEL             – Logging verbosity (default: info)
 *
 * Optional Jira integration (all three required to enable):
 *   JIRA_URL              – Jira instance URL (e.g. https://yourteam.atlassian.net)
 *   JIRA_EMAIL            – Email associated with the Jira API token
 *   JIRA_API_TOKEN        – Jira API token
 *
 * Optional Serena MCP integration (for symbolic project tools via Copilot SDK MCP):
 *   SERENA_ENABLED            – Enable Serena MCP server (default: false)
 *   SERENA_COMMAND            – Serena launcher command (default: uvx)
 *   SERENA_RUNNER_ARGS        – CSV args before Serena subcommand (default: --from,git+https://github.com/oraios/serena,serena)
 *   SERENA_CONTEXT            – Serena context (default: codex)
 *   SERENA_MCP_TOOLS          – MCP tools allow-list CSV (default: MR review subset; set to * for all)
 *   SERENA_PROJECT_LANGUAGES  – Serena project language list CSV (default: csharp)
 *   SERENA_INIT_PROJECT       – Auto-create .serena/project.yml if missing (default: true)
 */

const SERENA_DEFAULT_REVIEW_TOOLS = [
  "get_current_config",
  "find_file",
  "list_dir",
  "read_file",
  "search_for_pattern",
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "restart_language_server",
];

export interface Config {
  gitlabUrl: string;
  gitlabToken: string;
  gitlabBotUsername: string;
  githubToken: string;
  copilotModel: string;
  copilotConfigDir: string;
  logLevel: string;
  jira?: {
    url: string;
    email: string;
    apiToken: string;
  };
  serena?: {
    command: string;
    runnerArgs: string[];
    context: string;
    tools: string[];
    projectLanguages: string[];
    initializeProject: boolean;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
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

  const serenaEnabled = parseBoolean(process.env["SERENA_ENABLED"], false);
  const serena = serenaEnabled
    ? {
      command: process.env["SERENA_COMMAND"] ?? "uvx",
      runnerArgs: parseCsv(
        process.env["SERENA_RUNNER_ARGS"],
        ["--from", "git+https://github.com/oraios/serena", "serena"],
      ),
      context: process.env["SERENA_CONTEXT"] ?? "codex",
      tools: parseCsv(process.env["SERENA_MCP_TOOLS"], SERENA_DEFAULT_REVIEW_TOOLS),
      projectLanguages: parseCsv(process.env["SERENA_PROJECT_LANGUAGES"], ["csharp"]),
      initializeProject: parseBoolean(process.env["SERENA_INIT_PROJECT"], true),
    }
    : undefined;

  if (serena) {
    console.log(
      `[config] Serena MCP enabled (context=${serena.context}, ` +
      `languages=${serena.projectLanguages.join(",")})`,
    );
  }

  return {
    gitlabUrl: gitlabUrl.replace(/\/+$/, ""),
    gitlabToken: requireEnv("GITLAB_TOKEN"),
    gitlabBotUsername: requireEnv("GITLAB_BOT_USERNAME"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    copilotModel: process.env["COPILOT_MODEL"] ?? "gpt-4.1",
    copilotConfigDir: process.env["COPILOT_CONFIG_DIR"] ?? ".copilot-sessions",
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    jira,
    serena,
  };
}


