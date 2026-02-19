require('dotenv').config();
const express = require("express");
const crypto = require("crypto");
const { getPullRequestDiff } = require("./services/gitHubServices.js");
const { App } = require('@octokit/app');

const app = express();
const PORT = process.env.PORT || 5000;
const RAG_SERVICE_URL = process.env.RAG_SERVICE;

if (!RAG_SERVICE_URL) {
  console.error("❌ RAG_SERVICE environment variable not set!");
  process.exit(1);
}

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
// Helper: Call RAG Safely (with logging)
// --------------------------------------------------
async function callRag(endpoint, body) {
  try {
    console.log(`   🌐 Calling RAG: ${endpoint}`);

    const response = await fetch(`${RAG_SERVICE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.INTERNAL_API_KEY
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();

    console.log(`   📡 RAG Response: ${response.status}`);
    if (!response.ok) {
      console.error(`   ❌ RAG Error Body: ${text}`);
    }

  } catch (err) {
    console.error("   ❌ RAG Network Failure:", err.message);
  }
}

// --------------------------------------------------
// Main Webhook Handler
// --------------------------------------------------
app.post('/api/webhook', verifyGitHubSignature, async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;
  const installationId = payload.installation?.id;

  try {
    console.log(`🔔 Received Event: ${event}`);

    // ========================================================
    // 1️⃣ Pull Request
    // ========================================================
    if (event === 'pull_request') {
      const { action, pull_request, repository } = payload;

      if (['opened', 'reopened', 'synchronize'].includes(action)) {
        const owner = repository.owner.login;
        const repo = repository.name;
        const prNumber = pull_request.number;
        const githubRepoId = repository.id;

        console.log(`📜 PR #${prNumber} (${action}) in ${owner}/${repo}`);

        const octokit = await githubApp.getInstallationOctokit(installationId);
        const diff = await getPullRequestDiff(octokit, owner, repo, prNumber);

        if (diff) {
          await callRag("/review", {
            diff,
            title: pull_request.title,
            description: pull_request.body,
            owner,
            repo,
            installationId,
            pull_number: prNumber,
            githubRepoId
          });
        }
      }

      return res.status(200).send('PR processed');
    }

    // ========================================================
    // 2️⃣ Push
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

      await callRag("/update", {
        installationId,
        owner: repository.owner.login,
        repo: repository.name,
        githubRepoId,
        modifiedFilePaths: Array.from(addedModifiedSet),
        removedFilePaths: Array.from(removedSet)
      });

      return res.status(200).send('Push processed');
    }

    // ========================================================
    // 3️⃣ Installation
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
          console.log(`✨ Triggering Ingestion: ${repo.full_name}`);

          await callRag("/ingest", {
            installationId,
            owner,
            repo: repoName,
            githubRepoId: repo.id
          });
        }
      }

      return res.status(200).send('Installation processed');
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
