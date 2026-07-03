require("dotenv").config();
const express = require('express');
const { App } = require('@octokit/app');
const fs = require('fs');
const { Worker } = require('bullmq');

// --- Services ---
const { ingestRepo } = require('./services/ingestionServices.js');
const { processAndStore } = require('./services/embeddingService.js');
const { updateRepoFiles } = require('./services/updationServices.js');
const { searchCodebase, retrieveImpactContext } = require('./services/retrievalService.js');
const { generateAnswer, generatePRReview } = require('./services/llmService.js');
const { getPineconeIndex } = require('./config/pinecone');
const { db } = require("./config/db.js");

// --- DB & Redis ---
const { repositories } = require("./lib/db/schema");
const { eq, and } = require("drizzle-orm");
const { redisConnection } = require('./config/redis'); // Make sure this file exists!

const app = express();
const PORT = process.env.PORT || 3000; 

// Handle Private Key
const privateKey = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  : fs.readFileSync(process.env.PRIVATE_KEY_PATH, 'utf8');

const githubApp = new App({
  appId: process.env.APP_ID,
  privateKey: privateKey,
  webhooks: { secret: process.env.WEBHOOK_SECRET },
});

app.use(express.json());

// ==================================================================
// 🔒 SECURITY MIDDLEWARE (Only applies to HTTP routes like /query)
// ==================================================================
app.use((req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.INTERNAL_API_KEY;

    if (!apiKey || apiKey !== validKey) {
        console.warn(`🛑 Blocked unauthorized access attempt from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
});

// Verify DB Connection
async function checkDatabase() {
    try {
        await db.execute('SELECT 1');
        console.log("✅ Neon Database connected successfully");
    } catch (error) {
        console.error("❌ Neon Database connection failed:", error.message);
    }
}

// ==================================================================
// 1️⃣ INGESTION WORKER
// ==================================================================
const ingestionWorker = new Worker('ingestion-queue', async (job) => {
    const { installationId, owner, repo, githubRepoId } = job.data;
    console.log(`\n📥 [WORKER: INGEST] Starting for ${owner}/${repo} (GitHub ID: ${githubRepoId})`);

    const octokit = await githubApp.getInstallationOctokit(installationId);
    const result = await ingestRepo(octokit, owner, repo, installationId);
    
    if (!result || !result.files || result.files.length === 0) {
        console.log(`   ⚠️ No code files found in ${owner}/${repo}.`);
        return;
    }

    console.log(`   ⚙️ Processing ${result.files.length} files for AST & Pinecone...`);
    await processAndStore(result.files, result.repositoryId, owner, repo);
    
}, { connection: redisConnection });

ingestionWorker.on('completed', job => console.log(`✅ [INGEST] Complete for ${job.data.repo}`));
ingestionWorker.on('failed', (job, err) => console.error(`❌ [INGEST] Failed for ${job?.data?.repo}:`, err.message));

// ==================================================================
// 2️⃣ UPDATE WORKER
// ==================================================================
const updateWorker = new Worker('update-queue', async (job) => {
    const { installationId, owner, repo, githubRepoId, modifiedFilePaths, removedFilePaths } = job.data;
    console.log(`\n🔄 [WORKER: UPDATE] Processing changes for ${owner}/${repo}`);

    const octokit = await githubApp.getInstallationOctokit(installationId);
    const modifiedFilesWithContent = [];

    if (modifiedFilePaths && modifiedFilePaths.length > 0) {
        console.log(`   📡 Fetching content for ${modifiedFilePaths.length} files...`);
        for (const path of modifiedFilePaths) {
            try {
                const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path });
                const content = Buffer.from(data.content, 'base64').toString('utf-8');
                modifiedFilesWithContent.push({ path, content });
            } catch (err) {
                console.error(`   ⚠️ Failed to fetch content for ${path}:`, err.message);
            }
        }
    }

    if (modifiedFilesWithContent.length > 0 || (removedFilePaths && removedFilePaths.length > 0)) {
        await updateRepoFiles(owner, repo, modifiedFilesWithContent, removedFilePaths);
    }
}, { connection: redisConnection });

updateWorker.on('completed', job => console.log(`✅ [UPDATE] Complete for ${job.data.repo}`));
updateWorker.on('failed', (job, err) => console.error(`❌ [UPDATE] Failed for ${job?.data?.repo}:`, err.message));

// ==================================================================
// 3️⃣ PR REVIEW WORKER
// ==================================================================
const reviewWorker = new Worker('review-queue', async (job) => {
    let { diff, title, description, owner, repo, installationId, pull_number, githubRepoId } = job.data;
    let repositoryId; // Local Neon ID

    console.log(`\n🧐 [WORKER: REVIEW] Analyzing PR: "${title}" (#${pull_number})`);

    if (!diff) throw new Error("No diff provided in job payload");

    // Resolve 'repositoryId' (Neon DB ID)
    let repoRecord;
    if (githubRepoId) {
        repoRecord = await db.query.repositories.findFirst({
            where: eq(repositories.githubRepoId, githubRepoId)
        });
    }

    if (!repoRecord) {
        console.log("   ⚠️ GitHub ID lookup failed. Falling back to name lookup...");
        repoRecord = await db.query.repositories.findFirst({
            where: and(eq(repositories.name, repo), eq(repositories.fullName, `${owner}/${repo}`))
        });
    }

    if (repoRecord) {
        repositoryId = repoRecord.id;
    } else {
        console.warn("   ⚠️ Repo not found in DB. Graph Context will be unavailable.");
    }

    const impactedContext = await retrieveImpactContext(diff, repositoryId, owner, repo);
    const review = await generatePRReview(diff, title, description, impactedContext);
    
    // Post to GitHub
    if (installationId && pull_number) {
        console.log(`   📡 Posting review comment to GitHub PR #${pull_number}...`);
        const octokit = await githubApp.getInstallationOctokit(installationId);
        
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: pull_number,
            body: review
        });
    } else {
        throw new Error("Missing installationId or pull_number. Cannot post to GitHub.");
    }

}, { connection: redisConnection, concurrency: 2 }); // Process up to 2 PRs at the exact same time

reviewWorker.on('completed', job => console.log(`✅ [REVIEW] Complete for PR #${job.data.pull_number}`));
reviewWorker.on('failed', (job, err) => console.error(`❌ [REVIEW] Failed for PR #${job?.data?.pull_number}:`, err.message));

// ==================================================================
// HTTP ROUTES (Synchronous Tasks)
// ==================================================================
app.post('/query', async (req, res) => {
    const { query, repo } = req.body;
    console.log(`\n🔍 [HTTP: QUERY] User asked: "${query}" in ${repo}`);

    try {
        const codeMatches = await searchCodebase(query, repo);
        const answer = await generateAnswer(query, codeMatches);
        res.json({ query, matches: codeMatches, answer });
    } catch (error) {
        console.error("❌ [QUERY] Error:", error.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// Server Start
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🧠 RAG Brain HTTP Server running on port ${PORT}`);
    console.log(`👷 BullMQ Workers actively listening to Redis...`);
    
    await checkDatabase();
    
    try {
        const index = await getPineconeIndex();
        if (index) {
            const stats = await index.describeIndexStats();
            console.log(`✅ Pinecone Connected! (Vectors: ${stats.totalRecordCount})`);
        }
    } catch (error) { 
        console.error("❌ Pinecone Connection Failed:", error.message); 
    }
});