require('dotenv').config();
const { getPineconeIndex } = require("../config/pinecone");
const { processAndStore } = require("./embeddingService"); 
const { deleteGraphForFile } = require("./graphService"); // Import graph cleanup
const { db } = require("../config/db");
const { repositories } = require("../lib/db/schema");
const { eq, and } = require("drizzle-orm");

/**
 * Helper: Deletes all vectors associated with a specific file path from Pinecone.
 * Uses metadata filtering to ensure we don't accidentally delete other files.
 */
async function deleteFileVectors(owner, repo, filePath) {
    try {
        const index = await getPineconeIndex();
        if (!index) return;

        console.log(`   🗑️  [Pinecone] Deleting vectors for: ${filePath}`);

        // Pinecone v6+: deleteMany takes a filter object
        await index.deleteMany({
            repo: `${owner}/${repo}`,
            path: filePath
        });
        
    } catch (error) {
        console.error(`   ❌ [Pinecone] Error deleting vectors for ${filePath}:`, error.message);
    }
}

/**
 * Main Function: Handles the "Push" event updates.
 * strictly follows: Delete Old (Graph + Vectors) -> Insert New
 * * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {Array} modifiedFiles - Array of objects [{ path: "...", content: "..." }]
 * @param {Array} removedFilePaths - Array of strings ["src/old.js"]
 */
async function updateRepoFiles(owner, repo, modifiedFiles, removedFilePaths) {
    console.log(`🔄 [UPDATE] Processing changes for ${owner}/${repo}...`);

    try {
        // 0. Fetch Repository ID (Needed for Graph deletion)
        const repoRecord = await db.query.repositories.findFirst({
            where: (r, { eq, and }) => and(
                eq(r.name, repo),
                eq(r.fullName, `${owner}/${repo}`)
            )
        });

        if (!repoRecord) {
            console.error(`❌ Repository ${owner}/${repo} not found in DB. Skipping update.`);
            return;
        }

        const repositoryId = repoRecord.id;

        // 1. Handle REMOVED files
        if (removedFilePaths && removedFilePaths.length > 0) {
            console.log(`   ✂️  Handling ${removedFilePaths.length} deletions...`);
            
            for (const filePath of removedFilePaths) {
                // A. Delete from Graph (Neon)
                await deleteGraphForFile(repositoryId, filePath);
                
                // B. Delete from Vector DB (Pinecone)
                await deleteFileVectors(owner, repo, filePath);
            }
        }

        // 2. Handle MODIFIED / ADDED files
        if (modifiedFiles && modifiedFiles.length > 0) {
            console.log(`   📝 Handling ${modifiedFiles.length} modifications...`);
            
            // We process sequentially to ensure safety, though could be parallelized if needed
            for (const file of modifiedFiles) {
                // A. Clean up OLD data first (Critical for consistency)
                // Even if it's a "modify", we treat it as "delete old + insert new"
                await deleteGraphForFile(repositoryId, file.path);
                await deleteFileVectors(owner, repo, file.path);
            }

            // B. Ingest NEW versions
            // processAndStore will handle: AST Parsing -> Graph Insertion -> Embedding -> Vector Upsert
            await processAndStore(modifiedFiles, repositoryId, owner, repo);
        }

        console.log(`✅ [UPDATE] Synchronization Complete.`);

    } catch (error) {
        console.error("❌ Error in Update Pipeline:", error);
    }
}

module.exports = { updateRepoFiles };