import { access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CopilotClient } from "@github/copilot-sdk";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFile);

export type SessionMcpServers = Parameters<CopilotClient["createSession"]>[0]["mcpServers"];

async function ensureSerenaProjectConfig(repoDir: string, config: Config): Promise<void> {
  const serena = config.serena;
  if (!serena || !serena.initializeProject) return;

  const projectConfigPath = join(repoDir, ".serena", "project.yml");
  try {
    await access(projectConfigPath);
    return;
  } catch {
    // no project config yet
  }

  const languageArgs = serena.projectLanguages.flatMap((language) => ["--language", language]);

  console.log(
    `[reviewer] Initializing Serena project config (.serena/project.yml) ` +
    `with languages: ${serena.projectLanguages.join(", ")}`,
  );

  await execFileAsync(
    serena.command,
    [...serena.runnerArgs, "project", "create", ...languageArgs],
    {
      cwd: repoDir,
      timeout: 120000,
    },
  );
}

export async function buildSerenaMcpServers(
  repoDir: string,
  config: Config,
): Promise<SessionMcpServers | undefined> {
  const serena = config.serena;
  if (!serena) return undefined;

  await ensureSerenaProjectConfig(repoDir, config);

  return {
    serena: {
      type: "stdio",
      command: serena.command,
      args: [
        ...serena.runnerArgs,
        "start-mcp-server",
        "--context",
        serena.context,
        "--project",
        repoDir,
        "--open-web-dashboard",
        "false",
      ],
      tools: serena.tools,
    },
  };
}
