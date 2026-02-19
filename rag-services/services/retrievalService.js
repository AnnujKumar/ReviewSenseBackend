require('dotenv').config();

const parseDiff = require("parse-diff");
const { HuggingFaceInferenceEmbeddings } = require("@langchain/community/embeddings/hf");
const { getPineconeIndex } = require("../config/pinecone");
const { db } = require("../config/db");
const { symbols, edges, repositories } = require("../lib/db/schema"); // ✅ Added repositories
const { eq, and, inArray, lte, gte } = require("drizzle-orm");

/* ============================================================
   1️⃣ GENERIC EMBEDDING SEARCH (UNCHANGED)
============================================================ */
async function searchByEmbedding(query, repo, k = 3) {
    try {
        console.log(`🔍 Semantic search in ${repo} for: "${query}"`);

        const index = await getPineconeIndex();
        if (!index) throw new Error("Could not connect to Pinecone");

        const embeddings = new HuggingFaceInferenceEmbeddings({
            apiKey: process.env.HUGGINGFACEHUB_API_KEY,
            model: "sentence-transformers/all-mpnet-base-v2",
            provider: "hf-inference"
        });

        const queryVector = await embeddings.embedQuery(query);

        const searchResponse = await index.query({
            vector: queryVector,
            topK: k,
            includeMetadata: true,
            filter: { repo }
        });

        if (!searchResponse.matches?.length) return [];

        return searchResponse.matches.map(match => {
            const meta = match.metadata || {};
            return {
                score: match.score,
                file: meta.path,
                symbolName: meta.symbolName,
                symbolType: meta.symbolType,
                lineRange: `${meta.startLine}-${meta.endLine}`,
                codeSnippet: meta.text
            };
        });

    } catch (err) {
        console.error("❌ Embedding search failed:", err.message);
        return [];
    }
}

/* ============================================================
   2️⃣ DIFF → CHANGED RANGES (FIXED LOGIC)
   We extract 'Old File' ranges to match the DB state.
============================================================ */
function extractChangedRanges(diffText) {
    const parsed = parseDiff(diffText);

    return parsed.map(file => {
        const ranges = [];

        file.chunks.forEach(chunk => {
            // Map the Diff Chunk back to the OLD file coordinates (DB state)
            // If oldLines is 0 (pure addition), we use oldStart as an anchor
            const start = chunk.oldStart;
            const end = chunk.oldLines > 0 ? (chunk.oldStart + chunk.oldLines - 1) : chunk.oldStart;
            
            ranges.push({ start, end });
        });

        // Use 'from' (old path) because that matches what's in our DB
        const rawPath = file.from || file.to;
        
        // Strip 'a/' or 'b/' prefixes from git diff if present
        const cleanPath = rawPath.replace(/^[ab]\//, '');

        return {
            filePath: cleanPath, 
            ranges
        };
    }).filter(f => f.filePath && f.filePath !== '/dev/null'); 
}

/* ============================================================
   3️⃣ MAP RANGES → SYMBOLS (OVERLAP SEARCH)
============================================================ */
async function getImpactedSymbols(repositoryId, filePath, ranges) {
    if (!ranges.length) return [];

    const impacted = [];

    // 🕵️ DEBUG: Check if the file exists in DB at all
    // This helps us debug if it's a Path Mismatch vs Line Number Mismatch
    const fileExists = await db.query.symbols.findFirst({
        where: and(
            eq(symbols.repositoryId, repositoryId),
            eq(symbols.filePath, filePath)
        )
    });

    if (!fileExists) {
        console.warn(`   ⚠️ File not found in DB: ${filePath} (RepoID: ${repositoryId})`);
        return []; // Skip if file is missing (e.g. new file)
    }

    // Check each range for OVERLAP with DB symbols
    // Overlap Formula: (SymbolStart <= RangeEnd) AND (SymbolEnd >= RangeStart)
    for (const range of ranges) {
        const result = await db.query.symbols.findMany({
            where: and(
                eq(symbols.repositoryId, repositoryId),
                eq(symbols.filePath, filePath),
                lte(symbols.startLine, range.end),
                gte(symbols.endLine, range.start)
            )
        });

        if (result.length > 0) {
            console.log(`      Found ${result.length} symbols overlapping lines ${range.start}-${range.end}`);
        }
        impacted.push(...result);
    }

    // Deduplicate
    const unique = {};
    impacted.forEach(sym => unique[sym.id] = sym);
    return Object.values(unique);
}

/* ============================================================
   4️⃣ GRAPH EXPANSION (UNCHANGED)
============================================================ */
async function expandImpact(repositoryId, baseSymbols) {
    if (!baseSymbols.length) return [];

    const symbolIds = baseSymbols.map(s => s.id);

    const outgoingEdges = await db.query.edges.findMany({
        where: and(
            eq(edges.repositoryId, repositoryId),
            inArray(edges.fromSymbolId, symbolIds)
        )
    });

    if (!outgoingEdges.length) return baseSymbols;

    const impactedIds = outgoingEdges.map(e => e.toSymbolId);

    const impactedSymbols = await db.query.symbols.findMany({
        where: and(
            eq(symbols.repositoryId, repositoryId),
            inArray(symbols.id, impactedIds)
        )
    });

    return [...baseSymbols, ...impactedSymbols];
}

/* ============================================================
   5️⃣ RETRIEVE IMPACT CONTEXT (UNCHANGED)
============================================================ */
async function fetchSymbolsFromPinecone(repo, symbolList) {
    const index = await getPineconeIndex();
    if (!index) return [];

    const symbolNames = symbolList.map(s => s.symbolName);
    if (symbolNames.length === 0) return [];

    const searchResponse = await index.query({
        vector: Array(768).fill(0),
        topK: 100, // Fetch plenty of context
        includeMetadata: true,
        filter: {
            repo,
            symbolName: { "$in": symbolNames }
        }
    });

    return searchResponse.matches.map(match => {
        const meta = match.metadata || {};
        return {
            file: meta.path,
            symbolName: meta.symbolName,
            symbolType: meta.symbolType,
            lineRange: `${meta.startLine}-${meta.endLine}`,
            codeSnippet: meta.text
        };
    });
}

/* ============================================================
   6️⃣ MAIN DIFF-AWARE IMPACT RETRIEVAL (ROBUST)
============================================================ */
async function retrieveImpactContext(diffText, repositoryId, owner, repo) {
    try {
        console.log("🧐 Starting diff-aware impact retrieval...");

        // 🚨 AUTO-FIX: If repositoryId is missing, look it up!
        if (!repositoryId) {
            console.log("   ⚠️ repositoryId not provided. Looking up in DB...");
            const repoRecord = await db.query.repositories.findFirst({
                where: (r, { eq, and }) => and(
                    eq(r.name, repo),
                    eq(r.fullName, `${owner}/${repo}`)
                )
            });
            if (repoRecord) {
                repositoryId = repoRecord.id;
                console.log(`   ✅ Resolved Repository ID: ${repositoryId}`);
            } else {
                 console.error("   ❌ Could not resolve Repository ID. Cannot query graph.");
                 return [];
            }
        }

        // 1. Get Ranges based on OLD file coordinates
        const fileRanges = extractChangedRanges(diffText);
        
        let allBaseSymbols = [];

        for (const file of fileRanges) {
            console.log(`   Checking impact for ${file.filePath} (Ranges: ${JSON.stringify(file.ranges)})`);
            
            const symbols = await getImpactedSymbols(
                repositoryId,
                file.filePath,
                file.ranges
            );

            allBaseSymbols.push(...symbols);
        }

        if (!allBaseSymbols.length) {
            console.log("⚠️ No direct symbol overlaps found.");
            return [];
        }

        // 2. Expand Graph
        const expandedSymbols = await expandImpact(
            repositoryId,
            allBaseSymbols
        );

        // 3. Fetch Content
        const pineconeResults = await fetchSymbolsFromPinecone(
            `${owner}/${repo}`,
            expandedSymbols
        );

        console.log(`✅ Retrieved ${pineconeResults.length} impacted contexts.`);
        
        return pineconeResults;

    } catch (err) {
        console.error("❌ Impact retrieval failed:", err.message);
        return [];
    }
}

module.exports = {
    searchByEmbedding,
    retrieveImpactContext
};