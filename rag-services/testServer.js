const express = require('express');
const { processAndStore } = require('./services/embeddingService');
const { mockRepoFiles, mockMetadata } = require('./mockPayload');
const { updateRepoFiles } = require('./services/updationServices');
const { mockModifiedFiles, mockRemovedFiles, mockUpdateMetadata } = require('./mockUpdatePayload');

const { searchByEmbedding, retrieveImpactContext } = require('./services/retrievalService');

const { db } = require("./config/db");
const { repositories, installations, users } = require("./lib/db/schema");
const { eq } = require("drizzle-orm");

const app = express();
const PORT = 5000;

app.use(express.json());

/* ============================================================
   Ensure Fake Repository Exists
============================================================ */

async function ensureFakeRepository(owner, repo) {
    let existingRepo = await db.query.repositories.findFirst({
        where: eq(repositories.fullName, `${owner}/${repo}`)
    });

    if (existingRepo) {
        return existingRepo.id;
    }

    console.log("🧪 Creating fake user + installation + repository...");

    const [fakeUser] = await db.insert(users).values({
        clerkId: "test_clerk_id",
        email: "test@example.com",
        fullName: "Test User",
        githubId: "test_github_id"
    }).returning();

    const [fakeInstall] = await db.insert(installations).values({
        userId: fakeUser.id,
        githubInstallationId: 999999,
        accountLogin: owner,
        accountType: "User"
    }).returning();

    const [fakeRepo] = await db.insert(repositories).values({
        installationId: fakeInstall.id,
        githubRepoId: 999999,
        name: repo,
        fullName: `${owner}/${repo}`,
        url: "http://localhost/mock",
        private: false,
        isIndexed: true
    }).returning();

    console.log(`✅ Fake repository created with ID: ${fakeRepo.id}`);

    return fakeRepo.id;
}

/* ============================================================
   TEST INGEST
============================================================ */

app.post('/test-ingest', async (req, res) => {
    console.log("\n🧪 Triggering Mock Ingestion...");

    try {
        const repositoryId = await ensureFakeRepository(
            mockMetadata.owner,
            mockMetadata.repo
        );

        await processAndStore(
            mockRepoFiles,
            repositoryId,
            mockMetadata.owner,
            mockMetadata.repo
        );

        res.send("✅ Mock Ingestion Complete! Check console logs.");
    } catch (err) {
        console.error("❌ Mock Ingestion Failed:", err.message);
        res.status(500).send("Mock ingestion failed.");
    }
});

/* ============================================================
   TEST SEMANTIC QUERY (Pure RAG)
============================================================ */

app.post('/test-query', async (req, res) => {
    try {
        const { query } = req.body;

        if (!query) {
            return res.status(400).json({ error: "Query is required." });
        }

        const results = await searchByEmbedding(
            query,
            `${mockMetadata.owner}/${mockMetadata.repo}`
        );

        res.json({
            query,
            results
        });

    } catch (err) {
        console.error("❌ Test Query Failed:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   TEST DIFF IMPACT (Graph + RAG)
============================================================ */

app.post('/test-impact', async (req, res) => {
    try {
        const { diff } = req.body;

        if (!diff) {
            return res.status(400).json({ error: "Diff is required." });
        }

        const repositoryId = await ensureFakeRepository(
            mockMetadata.owner,
            mockMetadata.repo
        );

        const results = await retrieveImpactContext(
            diff,
            repositoryId,
            mockMetadata.owner,
            mockMetadata.repo
        );

        res.json({
            impactedContext: results
        });

    } catch (err) {
        console.error("❌ Test Impact Failed:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   TEST UPDATE
============================================================ */

app.post('/test-update', async (req, res) => {
    console.log("\n🧪 Triggering Mock Update...");

    try {
        await updateRepoFiles(
            mockUpdateMetadata.owner,
            mockUpdateMetadata.repo,
            mockModifiedFiles,
            mockRemovedFiles
        );

        res.send("✅ Mock Update Processed! Check logs and Pinecone.");
    } catch (err) {
        console.error("❌ Mock Update Failed:", err.message);
        res.status(500).send("Mock update failed.");
    }
});

/* ============================================================
   SERVER START
============================================================ */

app.listen(PORT, () => {
    console.log(`🧪 Test Server running on port ${PORT}`);
    console.log(`👉 POST http://localhost:${PORT}/test-ingest`);
    console.log(`👉 POST http://localhost:${PORT}/test-query`);
    console.log(`👉 POST http://localhost:${PORT}/test-impact`);
});
