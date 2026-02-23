#!/usr/bin/env node

// src/server.ts
import { createServer } from "node:http";

// src/config.ts
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
function loadWebhookServerConfig() {
  return {
    gitlabUrl: requireEnv("GITLAB_URL").replace(/\/+$/, ""),
    gitlabToken: requireEnv("GITLAB_TOKEN"),
    gitlabBotUsername: requireEnv("GITLAB_BOT_USERNAME"),
    gitlabWebhookSecret: requireEnv("GITLAB_WEBHOOK_SECRET"),
    gitlabTriggerToken: requireEnv("GITLAB_TRIGGER_TOKEN"),
    reviewerProjectId: requireEnv("REVIEWER_PROJECT_ID"),
    reviewerProjectRef: process.env["REVIEWER_PROJECT_REF"] ?? "main",
    webhookPort: Number(process.env["WEBHOOK_PORT"] ?? "3000")
  };
}

// src/webhook.ts
function verifyWebhookToken(headerToken, secret) {
  return headerToken === secret;
}
function shouldTriggerReview(payload, botUsername) {
  if (payload.object_kind !== "merge_request") {
    console.log("[webhook] Ignoring non-MR event:", payload.object_kind);
    return false;
  }
  const action = payload.object_attributes.action;
  if (action !== "update") {
    console.log("[webhook] Ignoring MR action:", action);
    return false;
  }
  if (payload.object_attributes.draft || payload.object_attributes.work_in_progress) {
    console.log("[webhook] Ignoring draft MR");
    return false;
  }
  const botUser = payload.reviewers?.find(
    (r) => r.username === botUsername
  );
  if (!botUser) {
    console.log("[webhook] Bot user not found in reviewers list");
    return false;
  }
  const reviewerChanges = payload.changes?.reviewer_ids;
  if (reviewerChanges) {
    const previousIds = reviewerChanges.previous ?? [];
    const currentIds = reviewerChanges.current ?? [];
    const wasAlreadyReviewer = previousIds.includes(botUser.id);
    const isNowReviewer = currentIds.includes(botUser.id);
    if (wasAlreadyReviewer || !isNowReviewer) {
      console.log("[webhook] Bot was not newly added as reviewer");
      return false;
    }
  }
  console.log(
    `[webhook] Review triggered for MR !${payload.object_attributes.iid} in ${payload.project.path_with_namespace}`
  );
  return true;
}

// src/server.ts
async function triggerReviewPipeline(config2, payload) {
  const url = `${config2.gitlabUrl}/api/v4/projects/${encodeURIComponent(config2.reviewerProjectId)}/trigger/pipeline`;
  const body = new URLSearchParams({
    token: config2.gitlabTriggerToken,
    ref: config2.reviewerProjectRef,
    "variables[MR_PROJECT_ID]": String(payload.project.id),
    "variables[MR_IID]": String(payload.object_attributes.iid),
    "variables[MR_TITLE]": payload.object_attributes.title,
    "variables[MR_DESCRIPTION]": payload.object_attributes.description ?? "",
    "variables[MR_SOURCE_BRANCH]": payload.object_attributes.source_branch,
    "variables[MR_TARGET_BRANCH]": payload.object_attributes.target_branch,
    "variables[MR_PROJECT_URL]": payload.project.web_url,
    "variables[MR_HTTP_URL]": payload.project.http_url
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to trigger pipeline: ${response.status} ${response.statusText} \u2013 ${text}`
    );
  }
  const result = await response.json();
  console.log(
    `[server] Pipeline triggered: #${result.id} \u2013 ${result.web_url}`
  );
}
function startServer(config2) {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/webhook" && req.url !== "/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf-8");
    const webhookToken = req.headers["x-gitlab-token"];
    if (!verifyWebhookToken(webhookToken, config2.gitlabWebhookSecret)) {
      console.warn("[server] Invalid webhook token");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.error("[server] Invalid JSON body");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    if (!shouldTriggerReview(payload, config2.gitlabBotUsername)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Event ignored \u2013 review not triggered" }));
      return;
    }
    try {
      await triggerReviewPipeline(config2, payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: "Review pipeline triggered",
          mr: `!${payload.object_attributes.iid}`,
          project: payload.project.path_with_namespace
        })
      );
    } catch (err) {
      console.error("[server] Failed to trigger pipeline:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Failed to trigger review pipeline",
          detail: err instanceof Error ? err.message : String(err)
        })
      );
    }
  });
  server.listen(config2.webhookPort, () => {
    console.log(`[server] Webhook receiver listening on port ${config2.webhookPort}`);
    console.log(`[server] POST /webhook  \u2013 receive GitLab MR webhooks`);
    console.log(`[server] GET  /health   \u2013 health check`);
    console.log(`[server] Reviewer project: ${config2.reviewerProjectId} (ref: ${config2.reviewerProjectRef})`);
  });
  const shutdown = () => {
    console.log("[server] Shutting down\u2026");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5e3);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
var config = loadWebhookServerConfig();
startServer(config);
