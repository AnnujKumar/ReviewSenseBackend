require("dotenv").config();
const express = require('express');
const { App } = require('@octokit/app');
const fs = require('fs');

// --- Services ---
const { ingestRepo } = require('./services/ingestionServices.js');
const { processAndStore } = require('./services/embeddingService.js');
const { updateRepoFiles } = require('./services/updationServices.js');
const { searchByEmbeddingWithGraph, retrieveImpactContext } = require('./services/retrievalService.js');
const { generateAnswer, generatePRReview } = require('./services/llmService.js');
const { getPineconeIndex } = require('./config/pinecone');
const { db } = require("./config/db.js");

// --- DB ---
const { repositories } = require("./lib/db/schema");
const { eq, and } = require("drizzle-orm");

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

app.post('/query', async (req, res) => {
    const { query, repo } = req.body;
    console.log(`\n🔍 [HTTP: QUERY] User asked: "${query}" in ${repo}`);

    try {
        // Resolve repositoryId from the repo string (e.g., "owner/repo")
        let repositoryId = null;
        const repoRecord = await db.query.repositories.findFirst({
            where: eq(repositories.fullName, repo)
        });
        if (repoRecord) repositoryId = repoRecord.id;

        // Graph-augmented Q&A: Pinecone semantic search + 1-hop graph neighbors
        const codeMatches = await searchByEmbeddingWithGraph(query, repo, repositoryId);
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