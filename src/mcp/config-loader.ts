import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CopilotClient } from "@github/copilot-sdk";

type SessionMcpServers = NonNullable<
  Parameters<CopilotClient["createSession"]>[0]["mcpServers"]
>;

interface McpJsonConfig {
  servers?: Record<string, Record<string, unknown>>;
}

function interpolateString(value: string, replacements: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    return replacements[key] ?? match;
  });
}

function interpolateValue(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string") {
    return interpolateString(value, replacements);
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, replacements));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        interpolateValue(nested, replacements),
      ]),
    );
  }

  return value;
}

function normalizeServers(
  servers: Record<string, Record<string, unknown>>,
): SessionMcpServers {
  const normalizedEntries = Object.entries(servers).map(([name, raw]) => {
    const server = { ...raw };

    if (!Array.isArray(server["tools"])) {
      server["tools"] = ["*"];
    }

    return [name, server];
  });

  return Object.fromEntries(normalizedEntries) as SessionMcpServers;
}

export async function buildMcpServers(repoDir: string): Promise<SessionMcpServers | undefined> {
  const configPath = join(process.cwd(), "mcp.json");

  try {
    await access(configPath);
  } catch {
    return undefined;
  }

  const raw = await readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw) as McpJsonConfig;

  if (!parsed.servers || Object.keys(parsed.servers).length === 0) {
    return undefined;
  }

  const interpolated = interpolateValue(parsed.servers, {
    repoDir,
    workspaceFolder: repoDir,
  }) as Record<string, Record<string, unknown>>;

  const mcpServers = normalizeServers(interpolated);
  console.log(`[reviewer] Loaded MCP config from mcp.json (${Object.keys(mcpServers).length} server(s))`);
  return mcpServers;
}
