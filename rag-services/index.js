require("dotenv").config();
const express = require('express');
const { App } = require('@octokit/app');
const fs = require('fs');

// --- Services ---
const { ingestRepo } = require('./services/ingestionServices.js');
const { processAndStore } = require('./services/embeddingService.js');
const { updateRepoFiles } = require('./services/updationServices.js');
const { searchCodebase, retrieveImpactContext } = require('./services/retrievalService.js');
const { generateAnswer, generatePRReview } = require('./services/llmService.js');
const { getPineconeIndex } = require('./config/pinecone');
const { db } = require("./config/db.js");

// ✅ NEW IMPORTS: Needed for robust DB lookups
const { repositories } = require("./lib/db/schema");
const { eq, and } = require("drizzle-orm");

const app = express();
const PORT = 4000; 

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
// 🔒 SECURITY MIDDLEWARE
// ==================================================================
app.use((req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.INTERNAL_API_KEY;

    if (!apiKey || apiKey !== validKey) {
        console.warn(`🛑 Blocked unauthorized access attempt from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
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

// 1. INGESTION ROUTE
app.post('/ingest', async (req, res) => {
    const { installationId, owner, repo, githubRepoId } = req.body;
    
    console.log(`\n📥 [INGEST] Received request for ${owner}/${repo} (GitHub ID: ${githubRepoId})`);
    res.status(202).send({ status: 'Ingestion started' }); 

    try {
        const octokit = await githubApp.getInstallationOctokit(installationId);
        
        console.log(`   📡 Syncing Neon DB and fetching files from GitHub...`);
        
        // Note: ingestRepo internally handles syncing the DB. 
        // We pass the basics, and it will fetch/ensure the repo exists.
        const result = await ingestRepo(octokit, owner, repo, installationId);
        
        if (!result || !result.files || result.files.length === 0) {
            console.log(`   ⚠️ No code files found in ${owner}/${repo}.`);
            return;
        }

        console.log(`   ⚙️ Processing ${result.files.length} files for AST & Pinecone...`);
        
        await processAndStore(result.files, result.repositoryId, owner, repo);
        
        console.log(`✅ [INGEST] Complete for ${owner}/${repo}`);
    } catch (error) {
        console.error(`❌ [INGEST] Failed for ${owner}/${repo}:`, error.message);
    }
});

// 2. UPDATE ROUTE
app.post('/update', async (req, res) => {
    const { installationId, owner, repo, githubRepoId, modifiedFilePaths, removedFilePaths } = req.body;
    
    console.log(`\n🔄 [UPDATE] Received changes for ${owner}/${repo}`);
    res.status(202).send({ status: 'Update started' });

    try {
        const octokit = await githubApp.getInstallationOctokit(installationId);
        const modifiedFilesWithContent = [];

        // 1. Fetch content (Webhook server doesn't send content to keep payload light)
        if (modifiedFilePaths && modifiedFilePaths.length > 0) {
            console.log(`   📡 Fetching content for ${modifiedFilePaths.length} files...`);
            
            for (const path of modifiedFilePaths) {
                try {
                    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                        owner, repo, path
                    });
                    
                    const content = Buffer.from(data.content, 'base64').toString('utf-8');
                    modifiedFilesWithContent.push({ path, content });
                } catch (err) {
                    console.error(`   ⚠️ Failed to fetch content for ${path}:`, err.message);
                }
            }
        }

        // 2. Process Updates
        if (modifiedFilesWithContent.length > 0 || (removedFilePaths && removedFilePaths.length > 0)) {
            // Note: updateRepoFiles looks up the Repo ID internally by name, 
            // which works fine since we just verified the repo exists via Octokit.
            await updateRepoFiles(owner, repo, modifiedFilesWithContent, removedFilePaths);
        }
        
    } catch (error) {
        console.error(`❌ [UPDATE] Failed for ${owner}/${repo}:`, error.message);
    }
});

// 3. QUERY ROUTE (Chat)
app.post('/query', async (req, res) => {
    const { query, repo } = req.body;
    console.log(`\n🔍 [QUERY] User asked: "${query}" in ${repo}`);

    try {
        const codeMatches = await searchCodebase(query, repo);
        const answer = await generateAnswer(query, codeMatches);

        res.json({
            query,
            matches: codeMatches,
            answer
        });

    } catch (error) {
        console.error("❌ [QUERY] Error:", error.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// 4. PR REVIEW ROUTE (OPTIMIZED)
app.post('/review', async (req, res) => {
    // 1. Destructure all new metadata
    let { 
        diff, 
        title, 
        description, 
        owner, 
        repo, 
        repositoryId, // Neon ID (usually undefined from webhook)
        installationId, 
        pull_number, 
        githubRepoId // GitHub ID (Passed from Webhook)
    } = req.body;

    console.log(`\n🧐 [REVIEW] Analyzing PR: "${title}" (#${pull_number})`);

    try {
        if (!diff) return res.status(400).json({ error: "No diff provided" });

        // 🚨 CRITICAL: Resolve 'repositoryId' (Neon DB ID) required for Graph Retrieval
        if (!repositoryId) {
            let repoRecord;

            // Strategy A: Lookup by GitHub ID (Fastest & Safest)
            if (githubRepoId) {
                repoRecord = await db.query.repositories.findFirst({
                    where: eq(repositories.githubRepoId, githubRepoId)
                });
            }

            // Strategy B: Lookup by Name (Fallback)
            if (!repoRecord) {
                console.log("   ⚠️ GitHub ID lookup failed. Falling back to name lookup...");
                repoRecord = await db.query.repositories.findFirst({
                    where: and(
                        eq(repositories.name, repo),
                        eq(repositories.fullName, `${owner}/${repo}`)
                    )
                });
            }

            if (repoRecord) {
                repositoryId = repoRecord.id;
            } else {
                console.warn("   ⚠️ Repo not found in DB. Graph Context will be unavailable.");
            }
        }

        // 2. Retrieve Context (Now guaranteed to use the correct ID if found)
        const impactedContext = await retrieveImpactContext(diff, repositoryId, owner, repo);

        // 3. Generate Review
        const review = await generatePRReview(diff, title, description, impactedContext);
        
        // 4. Post to GitHub
        if (installationId && pull_number) {
            try {
                console.log(`   📡 Posting review comment to GitHub PR #${pull_number}...`);
                const octokit = await githubApp.getInstallationOctokit(installationId);
                
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: pull_number,
                    body: review
                });

                console.log(`   ✅ Comment posted successfully.`);
            } catch (postError) {
                console.error(`   ⚠️ Failed to post comment to GitHub: ${postError.message}`);
            }
        } else {
            console.log("   ℹ️ Skipping GitHub comment (Missing installationId or pull_number)");
        }

        console.log("✅ [REVIEW] Analysis Complete.");
        res.json({ review });

    } catch (error) {
        console.error("❌ [REVIEW] Failed:", error.message);
        res.status(500).json({ error: "Review generation failed" });
    }
});

// Server Start
app.listen(PORT, async () => {
    console.log(`🧠 RAG Brain listening on port ${PORT}`);
    await checkDatabase();
    try {
        const index = await getPineconeIndex();
        if (index) {
            const stats = await index.describeIndexStats();
            console.log(`✅ Pinecone Connected! (Vectors: ${stats.totalRecordCount})`);
        }
    } catch (error) { console.error("❌ Pinecone Connection Failed:", error.message); }
});