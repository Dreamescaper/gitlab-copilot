#!/usr/bin/env node

/**
 * Webhook receiver for GitLab Copilot Reviewer.
 *
 * A lightweight HTTP server that:
 *   1. Receives GitLab MR webhook events
 *   2. Validates the webhook token
 *   3. Checks if the bot was newly added as a reviewer
 *   4. Triggers a CI pipeline in the reviewer project via GitLab Trigger API,
 *      passing the MR metadata as pipeline variables
 *
 * The triggered pipeline then clones the target repo, runs the Copilot review,
 * and posts comments back to the MR.
 *
 * Deploy this as a Docker container (see Dockerfile.webhook) or run directly:
 *   node dist/server.mjs
 */

import { createServer } from "node:http";
import { loadWebhookServerConfig, type WebhookServerConfig } from "./config.js";
import { verifyWebhookToken, shouldTriggerReview } from "./webhook.js";
import type { MergeRequestWebhookPayload } from "./types.js";

/**
 * Trigger a pipeline in the reviewer project via GitLab Pipeline Trigger API.
 *
 * POST /projects/:id/trigger/pipeline
 * Passes MR metadata as pipeline `variables[KEY]=value`.
 */
async function triggerReviewPipeline(
  config: WebhookServerConfig,
  payload: MergeRequestWebhookPayload,
): Promise<void> {
  const url =
    `${config.gitlabUrl}/api/v4/projects/${encodeURIComponent(config.reviewerProjectId)}` +
    `/trigger/pipeline`;

  const body = new URLSearchParams({
    token: config.gitlabTriggerToken,
    ref: config.reviewerProjectRef,
    "variables[MR_PROJECT_ID]": String(payload.project.id),
    "variables[MR_IID]": String(payload.object_attributes.iid),
    "variables[MR_TITLE]": payload.object_attributes.title,
    "variables[MR_DESCRIPTION]": payload.object_attributes.description ?? "",
    "variables[MR_SOURCE_BRANCH]": payload.object_attributes.source_branch,
    "variables[MR_TARGET_BRANCH]": payload.object_attributes.target_branch,
    "variables[MR_PROJECT_URL]": payload.project.web_url,
    "variables[MR_HTTP_URL]": payload.project.http_url,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to trigger pipeline: ${response.status} ${response.statusText} – ${text}`,
    );
  }

  const result = (await response.json()) as { id: number; web_url: string };
  console.log(
    `[server] Pipeline triggered: #${result.id} – ${result.web_url}`,
  );
}

function startServer(config: WebhookServerConfig): void {
  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Only accept POST to /webhook
    if (req.method !== "POST" || (req.url !== "/webhook" && req.url !== "/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString("utf-8");

    // Verify webhook token
    const webhookToken = req.headers["x-gitlab-token"] as string | undefined;
    if (!verifyWebhookToken(webhookToken, config.gitlabWebhookSecret)) {
      console.warn("[server] Invalid webhook token");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Parse payload
    let payload: MergeRequestWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as MergeRequestWebhookPayload;
    } catch {
      console.error("[server] Invalid JSON body");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Check trigger conditions
    if (!shouldTriggerReview(payload, config.gitlabBotUsername)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Event ignored – review not triggered" }));
      return;
    }

    // Trigger the review pipeline
    try {
      await triggerReviewPipeline(config, payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: "Review pipeline triggered",
          mr: `!${payload.object_attributes.iid}`,
          project: payload.project.path_with_namespace,
        }),
      );
    } catch (err) {
      console.error("[server] Failed to trigger pipeline:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Failed to trigger review pipeline",
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  server.listen(config.webhookPort, () => {
    console.log(`[server] Webhook receiver listening on port ${config.webhookPort}`);
    console.log(`[server] POST /webhook  – receive GitLab MR webhooks`);
    console.log(`[server] GET  /health   – health check`);
    console.log(`[server] Reviewer project: ${config.reviewerProjectId} (ref: ${config.reviewerProjectRef})`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[server] Shutting down…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ─── Main ──────────────────────────────────────────────────────────────────

const config = loadWebhookServerConfig();
startServer(config);
