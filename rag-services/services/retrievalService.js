require('dotenv').config();

const parseDiff = require("parse-diff");
const { HuggingFaceInferenceEmbeddings } = require("@langchain/community/embeddings/hf");
const { getPineconeIndex } = require("../config/pinecone");
const { db } = require("../config/db");
const { symbols, edges, repositories } = require("../lib/db/schema");
const { eq, and, inArray, lte, gte } = require("drizzle-orm");
const { getBlastRadius, getSymbolsByIds } = require("./graphService");

/* ============================================================
   1️⃣ SEMANTIC SEARCH — Q&A PIPELINE (Pinecone + Graph)
   Natural Language → Vector Search → 1-hop Graph Neighbors
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

/**
 * Q&A Pipeline: Semantic search + 1-hop graph neighbors
 * Pinecone finds relevant symbols → Neon DB expands with graph neighbors
 */
async function searchByEmbeddingWithGraph(query, repo, repositoryId, k = 5) {
    try {
        // Step 1: Pinecone vector search (Top K)
        const semanticResults = await searchByEmbedding(query, repo, k);

        if (!semanticResults.length || !repositoryId) {
            return semanticResults;
        }

        // Step 2: Resolve Pinecone results to symbol IDs in Neon DB
        const symbolNames = semanticResults.map(r => r.symbolName).filter(Boolean);
        if (symbolNames.length === 0) return semanticResults;

        const dbSymbols = await db
            .select({ id: symbols.id, symbolName: symbols.symbolName })
            .from(symbols)
            .where(and(
                eq(symbols.repositoryId, repositoryId),
                inArray(symbols.symbolName, symbolNames)
            ));

        if (dbSymbols.length === 0) return semanticResults;

        // Step 3: Find 1-hop neighbors via graph edges
        const symbolIds = dbSymbols.map(s => s.id);

        const neighborEdges = await db
            .select({
                toId: edges.toSymbolId,
                fromId: edges.fromSymbolId
            })
            .from(edges)
            .where(and(
                eq(edges.repositoryId, repositoryId),
                inArray(edges.fromSymbolId, symbolIds)
            ));

        const neighborIds = new Set();
        neighborEdges.forEach(e => {
            neighborIds.add(e.toId);
            neighborIds.add(e.fromId);
        });
        // Remove already-found symbols
        symbolIds.forEach(id => neighborIds.delete(id));

        if (neighborIds.size === 0) return semanticResults;

        // Step 4: Fetch neighbor symbol data (including sourceCode)
        const neighbors = await getSymbolsByIds(Array.from(neighborIds));

        const graphContext = neighbors.map(sym => ({
            score: 0, // Graph-derived, not semantic
            file: sym.filePath,
            symbolName: sym.symbolName,
            symbolType: sym.symbolType,
            lineRange: `${sym.startLine}-${sym.endLine}`,
            codeSnippet: sym.sourceCode || `[Symbol: ${sym.symbolName} at ${sym.filePath}]`,
            source: 'graph-neighbor'
        }));

        console.log(`   🔗 Graph expansion: ${graphContext.length} neighbors found`);

        return [...semanticResults, ...graphContext];

    } catch (err) {
        console.error("❌ Graph-augmented search failed:", err.message);
        return [];
    }
}

/* ============================================================
   2️⃣ DIFF → CHANGED RANGES
   Extract 'Old File' ranges to match the DB state.
============================================================ */
function extractChangedRanges(diffText) {
    const parsed = parseDiff(diffText);

    return parsed.map(file => {
        const ranges = [];

        file.chunks.forEach(chunk => {
            // Map the Diff Chunk back to the OLD file coordinates (DB state)
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

    // Check if the file exists in DB at all
    const fileExists = await db.query.symbols.findFirst({
        where: and(
            eq(symbols.repositoryId, repositoryId),
            eq(symbols.filePath, filePath)
        )
    });

    if (!fileExists) {
        console.warn(`   ⚠️ File not found in DB: ${filePath} (RepoID: ${repositoryId})`);
        return [];
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
   4️⃣ MAIN DIFF-AWARE IMPACT RETRIEVAL (DETERMINISTIC)
   PR Review Pipeline: Diff → AST → Neon DB Recursive CTE
   → Fetch source_code directly from Neon DB
   → BYPASS PINECONE ENTIRELY
============================================================ */
async function retrieveImpactContext(diffText, repositoryId, owner, repo, pullRequestId = null) {
    try {
        console.log("🧐 Starting deterministic diff-aware impact retrieval...");

        // AUTO-FIX: If repositoryId is missing, look it up
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

        // Step 1: Get ranges based on OLD file coordinates
        const fileRanges = extractChangedRanges(diffText);
        
        let allBaseSymbols = [];

        for (const file of fileRanges) {
            console.log(`   Checking impact for ${file.filePath} (Ranges: ${JSON.stringify(file.ranges)})`);
            
            const impacted = await getImpactedSymbols(
                repositoryId,
                file.filePath,
                file.ranges
            );

            allBaseSymbols.push(...impacted);
        }

        if (!allBaseSymbols.length) {
            console.log("⚠️ No direct symbol overlaps found.");
            return [];
        }

        console.log(`   📍 Found ${allBaseSymbols.length} directly impacted symbols`);

        // Step 2: Calculate Blast Radius via Recursive CTE (2-hop bounded)
        const targetIds = allBaseSymbols.map(s => s.id);
        const blastResults = await getBlastRadius(repositoryId, pullRequestId, targetIds);

        // Collect all unique symbol IDs from the blast radius
        const allImpactedIds = new Set(targetIds); // Start with directly impacted
        blastResults.forEach(row => {
            allImpactedIds.add(row.from_symbol);
            if (row.to_symbol) allImpactedIds.add(row.to_symbol);
        });

        // Step 3: Fetch source_code DIRECTLY from Neon DB (BYPASS PINECONE)
        const allSymbols = await getSymbolsByIds(Array.from(allImpactedIds), pullRequestId);

        const impactContext = allSymbols.map(sym => ({
            file: sym.filePath,
            symbolName: sym.symbolName,
            symbolType: sym.symbolType,
            lineRange: `${sym.startLine}-${sym.endLine}`,
            codeSnippet: sym.sourceCode || `[No source stored for ${sym.symbolName}]`,
            hopDepth: targetIds.includes(sym.id) ? 0 : 
                      (blastResults.find(r => r.from_symbol === sym.id)?.hop_depth || 'unknown')
        }));

        console.log(`✅ Retrieved ${impactContext.length} total contexts (deterministic, no Pinecone).`);
        
        // 1. Get the list of files the developer actually modified in the PR
        const prFiles = fileRanges.map(f => f.filePath);
        
        // 2. THE CRITICAL FILTER: Remove PR files from the downstream context
        const trueDownstreamContext = impactContext.filter(sym => 
            !prFiles.includes(sym.file)
        );
        
        console.log(`✅ Filtered to ${trueDownstreamContext.length} true downstream contexts (excluding PR files).`);
        
        return trueDownstreamContext;

    } catch (err) {
        console.error("❌ Impact retrieval failed:", err.message);
        return [];
    }
}

module.exports = {
    searchByEmbedding,
    searchByEmbeddingWithGraph,
    retrieveImpactContext
};