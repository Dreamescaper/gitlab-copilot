import { execFile } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Clone result with working directory path and cleanup function.
 */
export interface CloneResult {
  /** Absolute path to the cloned repository */
  dir: string;
  /** Call this to remove the cloned directory when done */
  cleanup: () => Promise<void>;
}

/**
 * Build a clone URL that embeds the GitLab token for HTTPS auth.
 * Example: https://oauth2:glpat-xxx@gitlab.example.com/group/project.git
 */
function buildAuthUrl(gitHttpUrl: string, token: string): string {
  const url = new URL(gitHttpUrl);
  url.username = "oauth2";
  url.password = token;
  return url.toString();
}

/**
 * Shallow-clone a GitLab repository branch into a temporary directory.
 *
 * Uses `--depth 1 --single-branch` for speed and minimal disk usage.
 * Returns the clone path and a cleanup function.
 */
export async function cloneRepository(
  gitHttpUrl: string,
  branch: string,
  gitlabToken: string,
): Promise<CloneResult> {
  const dir = await mkdtemp(join(tmpdir(), "gitlab-review-"));
  const authUrl = buildAuthUrl(gitHttpUrl, gitlabToken);

  console.log(`[git] Cloning ${gitHttpUrl} (branch: ${branch}) into ${dir}…`);

  try {
    await execFileAsync("git", [
      "clone",
      "--depth", "1",
      "--single-branch",
      "--branch", branch,
      authUrl,
      dir,
    ], {
      timeout: 120_000, // 2 minute timeout
      env: {
        ...process.env,
        // Prevent git from asking for credentials interactively
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    console.log(`[git] Clone complete: ${dir}`);

    return {
      dir,
      cleanup: async () => {
        console.log(`[git] Cleaning up ${dir}`);
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    // Clean up on failure
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Failed to clone repository: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
