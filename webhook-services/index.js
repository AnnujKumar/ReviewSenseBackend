require('dotenv').config();
const express = require("express");
const crypto = require("crypto");
const { getPullRequestDiff } = require("./services/gitHubServices.js");
const { App } = require('@octokit/app');
const fs = require('fs');
const { ingestRepo } = require("../rag-services/services/ingestionServices.js");
const { processAndStore, extractSymbolsAndDependencies, filterDependenciesByWhitelist } = require("../rag-services/services/embeddingService.js");
const { updateRepoFiles } = require("../rag-services/services/updationServices.js");
const { retrieveImpactContext } = require("../rag-services/services/retrievalService.js");
const { generatePRReview, formatReviewAsMarkdown } = require("../rag-services/services/llmService.js");
const { insertPRSymbols, insertPREdges, cleanupPR } = require("../rag-services/services/graphService.js");
const { db } = require("../rag-services/config/db.js");
const { repositories } = require("../rag-services/lib/db/schema.js");
const { eq, and } = require("drizzle-orm");
const parseDiff = require("parse-diff");

const { Queue } = require('bullmq');
const connection = require('./queue/connection');
const prQueue = new Queue('pr-review-queue', { connection });

const app = express();
const PORT = process.env.PORT || 5000

const privateKey = process.env.PRIVATE_KEY ||
  (process.env.PRIVATE_KEY_PATH ? fs.readFileSync(process.env.PRIVATE_KEY_PATH, 'utf8') : undefined);

const githubApp = new App({
  appId: process.env.APP_ID,
  privateKey: privateKey,
  webhooks: { secret: process.env.WEBHOOK_SECRET },
});

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

async function resolveRepositoryId(owner, repo, githubRepoId) {
  let repoRecord;

  if (githubRepoId) {
    repoRecord = await db.query.repositories.findFirst({
      where: eq(repositories.githubRepoId, githubRepoId)
    });
  }

  if (!repoRecord) {
    repoRecord = await db.query.repositories.findFirst({
      where: and(eq(repositories.name, repo), eq(repositories.fullName, `${owner}/${repo}`))
    });
  }

  return repoRecord?.id;
}

async function queueInstallationJob(installationId, repos) {
  console.log(`   📥 Enqueueing Installation job`);
  await prQueue.add('process-installation', {
    installationId,
    repos
  }, {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 }
  });
  return 'queued';
}

async function queuePushJob(installationId, repository, commits) {
  console.log(`   📥 Enqueueing Push job for ${repository.full_name}`);
  await prQueue.add('process-push', {
    installationId,
    repository,
    commits
  }, {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 }
  });
  return 'queued';
}

/**
 * Helper: Check if a file is a JavaScript/TypeScript code file
 */
function isCodeFile(filePath) {
    return /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(filePath);
}

/**
 * PR Processing — Producer mode (Enqueues job to BullMQ)
 */
async function queuePullRequestJob(payload, installationId) {
  const { action, pull_request, repository } = payload;

  if (!['opened', 'reopened', 'synchronize', 'closed'].includes(action)) {
    return 'ignored';
  }

  console.log(`   📥 Enqueueing PR #${pull_request.number} action: ${action}`);

  await prQueue.add('analyze-pr', {
    repository: repository.full_name,
    prNumber: pull_request.number,
    diffUrl: pull_request.diff_url,
    installationId,
    title: pull_request.title,
    body: pull_request.body,
    action,
    githubRepoId: repository.id,
    headRef: pull_request.head?.ref
  }, {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 }
  });

  return 'queued';
}


// --------------------------------------------------
// Verify GitHub Signature
// --------------------------------------------------
const verifyGitHubSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  const secret = process.env.WEBHOOK_SECRET;

  if (!signature) {
    console.error("❌ Webhook rejected: missing x-hub-signature-256 header");
    return res.status(401).send("Missing signature");
  }

  if (!secret) {
    console.error("❌ Webhook rejected: WEBHOOK_SECRET is not set in environment");
    return res.status(401).send("Missing secret");
  }

  if (!req.rawBody) {
    console.error("❌ Webhook rejected: rawBody not captured (middleware misconfiguration)");
    return res.status(400).send("Bad request");
  }

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  // 🐛 DEBUG — remove after fixing secret mismatch
  console.log("🔍 Received signature :", signature);
  console.log("🔍 Computed digest    :", digest);
  console.log("🔍 Match?             :", signature === digest);

  const sigBuf = Buffer.from(signature);
  const digestBuf = Buffer.from(digest);

  // timingSafeEqual requires equal-length buffers; length mismatch = invalid
  if (sigBuf.length !== digestBuf.length) {
    console.error(`❌ Signature length mismatch — received: ${sigBuf.length}, expected: ${digestBuf.length}. WEBHOOK_SECRET in .env does not match GitHub App settings.`);
    return res.status(403).send("Invalid signature");
  }

  if (crypto.timingSafeEqual(sigBuf, digestBuf)) {
    next();
  } else {
    console.error("❌ Signature mismatch — WEBHOOK_SECRET in .env does not match the secret in your GitHub App settings.");
    res.status(403).send("Invalid signature");
  }
};

// --------------------------------------------------
// Main Webhook Handler
// --------------------------------------------------
app.post('/api/webhook', verifyGitHubSignature, async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;
  const installationId = payload.installation?.id;

  try {
    console.log(`🔔 Received Event: ${event}`);

    if (event === 'pull_request') {
      const result = await queuePullRequestJob(payload, installationId);
      if (result === 'ignored') return res.status(200).send('Ignored');
      return res.status(202).send({ message: "PR queued for review" });
    }

    if (event === 'push') {
      const { ref, repository, commits } = payload;
      const defaultBranch = repository.default_branch;

      if (ref !== `refs/heads/${defaultBranch}`) {
        console.log(`   Ignoring push to non-default branch: ${ref}`);
        return res.status(200).send('Ignored');
      }
      await queuePushJob(installationId, repository, commits);
      return res.status(202).send({ message: "Push queued for processing" });
    }

    if (event === 'installation' || event === 'installation_repositories') {
      const action = payload.action;

      if (action === 'deleted' || action === 'suspend') {
        console.log("👋 App uninstalled or suspended.");
        return res.status(200).send('Uninstall processed');
      }

      const repos = payload.repositories_added || payload.repositories;

      if (repos?.length > 0) {
        await queueInstallationJob(installationId, repos);
      }

      return res.status(202).send({ message: "Installation queued for processing" });
    }

    return res.status(200).send('Ignored Event');

  } catch (error) {
    console.error("🔥 Webhook Error:", error.message);
    return res.status(500).send('Internal Server Error');
  }
});

// --------------------------------------------------
// Start Server
// --------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Webhook Listener running on port ${PORT}`);
});