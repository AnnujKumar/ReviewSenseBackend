require('dotenv').config();
const express = require("express");
const crypto = require("crypto");
const { getPullRequestDiff } = require("./services/gitHubServices.js");
const { App } = require('@octokit/app');

// 🚀 IMPORT QUEUES
const { ingestionQueue, updateQueue, reviewQueue } = require('./config/queue');

const app = express();
const PORT = process.env.PORT || 5000

// Remove RAG_SERVICE_URL check - we don't use HTTP anymore!

const privateKey = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : require('fs').readFileSync(process.env.PRIVATE_KEY_PATH, 'utf8');

const githubApp = new App({
  appId: process.env.APP_ID,
  privateKey: privateKey,
  webhooks: { secret: process.env.WEBHOOK_SECRET },
});

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// --------------------------------------------------
// Verify GitHub Signature
// --------------------------------------------------
const verifyGitHubSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  const secret = process.env.WEBHOOK_SECRET;

  if (!signature || !secret)
    return res.status(401).send("Missing signature/secret");

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
    next();
  } else {
    res.status(403).send("Invalid signature");
  }
};

// --------------------------------------------------
// Main Webhook Handler (BullMQ Producer)
// --------------------------------------------------
app.post('/api/webhook', verifyGitHubSignature, async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;
  const installationId = payload.installation?.id;

  try {
    console.log(`🔔 Received Event: ${event}`);

    // ========================================================
    // 1️⃣ Pull Request -> Queue for Review
    // ========================================================
    if (event === 'pull_request') {
      const { action, pull_request, repository } = payload;

      if (['opened', 'reopened', 'synchronize'].includes(action)) {
        const owner = repository.owner.login;
        const repo = repository.name;
        const prNumber = pull_request.number;
        const githubRepoId = repository.id;

        console.log(`📜 Queuing PR #${prNumber} (${action}) in ${owner}/${repo}`);

        const octokit = await githubApp.getInstallationOctokit(installationId);
        const diff = await getPullRequestDiff(octokit, owner, repo, prNumber);

        if (diff) {
          // Add to Redis Review Queue
          await reviewQueue.add('review-pr', {
            diff,
            title: pull_request.title,
            description: pull_request.body,
            owner,
            repo,
            installationId,
            pull_number: prNumber,
            githubRepoId
          }, {
            // jobId prevents exact duplicates if GitHub retries the webhook
            jobId: `pr-${githubRepoId}-${prNumber}-${Date.now()}` 
          });
        }
      }

      return res.status(202).send('PR queued');
    }

    // ========================================================
    // 2️⃣ Push -> Queue for Update
    // ========================================================
    if (event === 'push') {
      const { ref, repository, commits } = payload;
      const defaultBranch = repository.default_branch;
      const githubRepoId = repository.id;

      if (ref !== `refs/heads/${defaultBranch}`) {
        console.log(`   Ignoring push to non-default branch: ${ref}`);
        return res.status(200).send('Ignored');
      }

      const addedModifiedSet = new Set();
      const removedSet = new Set();

      (commits || []).forEach(commit => {
        commit.added.forEach(f => addedModifiedSet.add(f));
        commit.modified.forEach(f => addedModifiedSet.add(f));
        commit.removed.forEach(f => removedSet.add(f));
      });

      const modifiedFilePaths = Array.from(addedModifiedSet);
      const removedFilePaths = Array.from(removedSet);

      if (modifiedFilePaths.length > 0 || removedFilePaths.length > 0) {
        console.log(`🔄 Queuing updates for ${repository.full_name}...`);
        
        // Add to Redis Update Queue
        await updateQueue.add('update-kb', {
          installationId,
          owner: repository.owner.login,
          repo: repository.name,
          githubRepoId,
          modifiedFilePaths,
          removedFilePaths
        });
      }

      return res.status(202).send('Push queued');
    }

    // ========================================================
    // 3️⃣ Installation -> Queue for Ingestion
    // ========================================================
    if (event === 'installation' || event === 'installation_repositories') {
      const action = payload.action;

      if (action === 'deleted' || action === 'suspend') {
        console.log("👋 App uninstalled or suspended.");
        return res.status(200).send('Uninstall processed');
      }

      const repos = payload.repositories_added || payload.repositories;

      if (repos?.length > 0) {
        for (const repo of repos) {
          const [owner, repoName] = repo.full_name.split('/');
          console.log(`✨ Queuing Ingestion: ${repo.full_name}`);

          // Add to Redis Ingestion Queue
          await ingestionQueue.add('ingest-repo', {
            installationId,
            owner,
            repo: repoName,
            githubRepoId: repo.id
          });
        }
      }

      return res.status(202).send('Installation queued');
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