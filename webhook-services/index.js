require('dotenv').config();
const express = require("express");
const crypto = require("crypto"); 
const { getPullRequestDiff } = require("./services/gitHubServices.js");
const { App } = require('@octokit/app');

const app = express();
const PORT = 5000;
const RAG_SERVICE_URL = process.env.RAG_SERVICE; 

const privateKey = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : require('fs').readFileSync(process.env.PRIVATE_KEY_PATH, 'utf8');

const githubApp = new App({
  appId: process.env.APP_ID,
  privateKey: privateKey,
  webhooks: { secret: process.env.WEBHOOK_SECRET },
});

// Middleware: Verify GitHub Signature
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const verifyGitHubSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  const secret = process.env.WEBHOOK_SECRET;
  if (!signature || !secret) return res.status(401).send("Missing signature/secret");

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
    next();
  } else {
    res.status(403).send("Invalid signature");
  }
};

app.post('/api/webhook', verifyGitHubSignature, async (req, res) => {
    const event = req.headers['x-github-event'];
    const payload = req.body;
    const installationId = payload.installation?.id;

    // Internal Headers for RAG Server
    const internalHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': process.env.INTERNAL_API_KEY 
    };

    try {
        console.log(`🔔 Received Event: ${event}`);

        // ========================================================
        // 1. PULL REQUEST (Review)
        // ========================================================
        // ✅ OPTIMIZATION: Handle 'synchronize' to review new commits on existing PRs
        if (event === 'pull_request') {
            const { action, pull_request, repository } = payload;
            
            if (['opened', 'reopened', 'synchronize'].includes(action)) {
                const owner = repository.owner.login;
                const repo = repository.name;
                const prNumber = pull_request.number;
                const githubRepoId = repository.id; // Unique GitHub ID

                console.log(`📜 PR #${prNumber} (${action}) in ${owner}/${repo}`);

                // Fetch Diff locally to offload RAG server
                const octokit = await githubApp.getInstallationOctokit(installationId);
                const diff = await getPullRequestDiff(octokit, owner, repo, prNumber);

                if (diff) {
                    console.log(`   🚀 Forwarding to RAG Service...`);
                    
                    // Fire and forget (don't await response)
                    fetch(`${RAG_SERVICE_URL}/review`, {
                        method: 'POST',
                        headers: internalHeaders,
                        body: JSON.stringify({
                            diff,
                            title: pull_request.title,
                            description: pull_request.body,
                            owner,
                            repo,
                            installationId,
                            pull_number: prNumber,
                            githubRepoId: githubRepoId // Pass this for O(1) DB lookup
                        })
                    }).catch(err => console.error("   ❌ RAG Error:", err.message));
                }
            }
            return res.status(200).send('PR processed');
        } 
        
        // ========================================================
        // 2. PUSH (Update Knowledge Base)
        // ========================================================
        if (event === 'push') {
            const { ref, repository, commits } = payload;
            const defaultBranch = repository.default_branch;
            const githubRepoId = repository.id;

            // 🛑 FILTER: Only update DB if pushing to MAIN/MASTER
            if (ref !== `refs/heads/${defaultBranch}`) {
                console.log(`   ignoring push to non-default branch: ${ref}`);
                return res.status(200).send('Ignored (Not default branch)');
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
                console.log(`🔄 Syncing ${repository.full_name} (ID: ${githubRepoId})`);
                
                fetch(`${RAG_SERVICE_URL}/update`, {
                    method: 'POST',
                    headers: internalHeaders,
                    body: JSON.stringify({
                        installationId,
                        owner: repository.owner.login,
                        repo: repository.name,
                        githubRepoId, // Pass ID
                        modifiedFilePaths,
                        removedFilePaths
                    })
                }).catch(err => console.error("   ❌ RAG Error:", err.message));
            }
            return res.status(200).send('Push processed');
        }

        // ========================================================
        // 3. INSTALLATION (Initial Ingest)
        // ========================================================
        if (event === 'installation' || event === 'installation_repositories') {
            const action = payload.action;

            // 🛑 FILTER: Ignore uninstalls ('deleted') and suspensions ('suspend')
            if (action === 'deleted' || action === 'suspend') {
                console.log(`👋 App uninstalled or suspended. Skipping ingestion.`);
                // Optional: You could trigger a 'cleanup' job here to delete their data from your DB
                return res.status(200).send('Uninstall processed');
            }

            // Handle both initial install AND adding new repos later
            // For 'installation_repositories', the repos are in 'repositories_added'
            // For 'installation' (created), the repos are in 'repositories'
            const repos = payload.repositories_added || payload.repositories;
            
            if (repos && repos.length > 0) {
                repos.forEach(repo => {
                    const [owner, repoName] = repo.full_name.split('/');
                    console.log(`✨ Triggering Ingestion: ${repo.full_name} (Action: ${action})`);
                    
                    fetch(`${RAG_SERVICE_URL}/ingest`, {
                        method: 'POST',
                        headers: internalHeaders,
                        body: JSON.stringify({ 
                            installationId, 
                            owner, 
                            repo: repoName,
                            githubRepoId: repo.id 
                        })
                    }).catch(err => console.error("   ❌ RAG Error:", err.message));
                });
            } else {
                console.log(`ℹ️ Installation event (${action}) received but no repositories found.`);
            }
            return res.status(200).send('Installation processed');
        }

        res.status(200).send('Ignored Event');

    } catch (error) {
        console.error("🔥 Webhook Error:", error.message);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(PORT, () => {
    console.log(`Webhook Listener running on port ${PORT}`);
});