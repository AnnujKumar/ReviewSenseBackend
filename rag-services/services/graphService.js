const { db } = require("../config/db");
const { symbols, edges, prSymbols, prEdges } = require("../lib/db/schema");
const { eq, and, inArray, sql } = require("drizzle-orm");

// =========================================================================
// BASE GRAPH OPERATIONS
// =========================================================================

/**
 * PHASE 1: Insert Symbols into the Base Graph
 * Now includes sourceCode for monolithic storage (avoids Pinecone round-trips)
 */
async function insertFileSymbols(repositoryId, filePath, extractedSymbols) {
    if (!extractedSymbols || extractedSymbols.length === 0) return;

    try {
        await db
            .insert(symbols)
            .values(extractedSymbols.map(s => ({
                repositoryId,
                filePath,
                symbolName: s.name,
                symbolType: s.type,
                startLine: s.startLine,
                endLine: s.endLine,
                sourceCode: s.code || null
            })))
            .onConflictDoUpdate({
                target: [symbols.repositoryId, symbols.filePath, symbols.symbolName],
                set: {
                    symbolType: sql`excluded.symbol_type`,
                    startLine: sql`excluded.start_line`,
                    endLine: sql`excluded.end_line`,
                    sourceCode: sql`excluded.source_code`,
                }
            });
        console.log(`   📝 Symbols upserted for ${filePath} (${extractedSymbols.length} symbols, sourceCode included)`);
    } catch (err) {
        console.error(`   ❌ Failed to insert symbols for ${filePath}:`, err.message);
    }
}

/**
 * PHASE 2: Resolve and Insert Edges into the Base Graph
 */
async function insertFileEdges(repositoryId, filePath, dependencies) {
    if (!dependencies || dependencies.length === 0) return;

    try {
        // 1. Collect all symbol names involved
        const namesToFind = new Set();
        dependencies.forEach(d => {
            namesToFind.add(d.from);
            namesToFind.add(d.to);
        });

        // 2. Bulk Fetch IDs from DB
        const foundSymbols = await db
            .select({ id: symbols.id, name: symbols.symbolName })
            .from(symbols)
            .where(and(
                eq(symbols.repositoryId, repositoryId),
                inArray(symbols.symbolName, Array.from(namesToFind))
            ));

        const symbolMap = {};
        foundSymbols.forEach(s => {
            symbolMap[s.name] = s.id;
        });

        // Debug: Log unresolved symbol names
        const unresolvedNames = Array.from(namesToFind).filter(n => !symbolMap[n]);
        if (unresolvedNames.length > 0) {
            console.log(`   ⚠️  [${filePath}] Unresolved symbols (no DB match): ${unresolvedNames.join(', ')}`);
        }

        // 3. Construct Edges
        const edgesToInsert = [];
        for (const dep of dependencies) {
            const fromId = symbolMap[dep.from];
            const toId = symbolMap[dep.to];

            if (fromId && toId) {
                edgesToInsert.push({
                    repositoryId,
                    fromSymbolId: fromId,
                    toSymbolId: toId,
                    edgeType: dep.type
                });
            } else {
                console.log(`   ⛓️‍💥 [${filePath}] Edge dropped: ${dep.from} → ${dep.to} (fromId=${fromId || 'MISS'}, toId=${toId || 'MISS'})`);
            }
        }

        if (edgesToInsert.length > 0) {
            await db.insert(edges).values(edgesToInsert).onConflictDoNothing();
            console.log(`   🔗 Linked ${edgesToInsert.length} edges for ${filePath}`);
        }

    } catch (err) {
        console.error(`   ❌ Failed to insert edges for ${filePath}:`, err.message);
    }
}

/**
 * Delete all graph data (symbols + cascading edges) for a specific file
 */
async function deleteGraphForFile(repositoryId, filePath) {
    try {
        await db.delete(symbols).where(and(
            eq(symbols.repositoryId, repositoryId),
            eq(symbols.filePath, filePath)
        ));
        console.log(`   🗑  Graph cleared for ${filePath}`);
    } catch (err) {
        console.error("❌ Graph delete error:", err.message);
    }
}

/**
 * 🔄 BACKWARD COMPATIBILITY WRAPPER
 * Runs both phases sequentially for a single file.
 */
async function storeGraphForFile(repositoryId, filePath, extractedSymbols, dependencies) {
    await insertFileSymbols(repositoryId, filePath, extractedSymbols);
    await insertFileEdges(repositoryId, filePath, dependencies);
}

// =========================================================================
// DELTA GRAPH OPERATIONS (PR State Isolation)
// =========================================================================

/**
 * Insert symbols into the PR Delta Graph (pr_symbols table)
 * Isolated from the base graph — safe for concurrent PRs
 */
async function insertPRSymbols(pullRequestId, repositoryId, filePath, extractedSymbols) {
    if (!extractedSymbols || extractedSymbols.length === 0) return;

    try {
        await db
            .insert(prSymbols)
            .values(extractedSymbols.map(s => ({
                pullRequestId,
                repositoryId,
                filePath,
                symbolName: s.name,
                symbolType: s.type,
                startLine: s.startLine,
                endLine: s.endLine,
                sourceCode: s.code || null
            })))
            .onConflictDoNothing();
        console.log(`   📝 [PR-${pullRequestId}] Delta symbols inserted for ${filePath}`);
    } catch (err) {
        console.error(`   ❌ [PR-${pullRequestId}] Failed to insert PR symbols for ${filePath}:`, err.message);
    }
}

/**
 * Resolve and Insert Edges into the PR Delta Graph (pr_edges table)
 * Resolves symbol IDs from BOTH pr_symbols AND base symbols
 */
async function insertPREdges(pullRequestId, repositoryId, filePath, dependencies) {
    if (!dependencies || dependencies.length === 0) return;

    try {
        const namesToFind = new Set();
        dependencies.forEach(d => {
            namesToFind.add(d.from);
            namesToFind.add(d.to);
        });

        const namesArray = Array.from(namesToFind);

        // Look up in PR symbols first
        const foundPRSymbols = await db
            .select({ id: prSymbols.id, name: prSymbols.symbolName })
            .from(prSymbols)
            .where(and(
                eq(prSymbols.pullRequestId, pullRequestId),
                inArray(prSymbols.symbolName, namesArray)
            ));

        const symbolMap = {};
        foundPRSymbols.forEach(s => {
            symbolMap[s.name] = s.id;
        });

        // For symbols not found in PR tables, they exist in the base graph
        // We don't create cross-table edges — the CTE handles stitching
        const edgesToInsert = [];
        for (const dep of dependencies) {
            const fromId = symbolMap[dep.from];
            const toId = symbolMap[dep.to];

            if (fromId && toId) {
                edgesToInsert.push({
                    pullRequestId,
                    repositoryId,
                    fromSymbolId: fromId,
                    toSymbolId: toId,
                    edgeType: dep.type
                });
            }
        }

        if (edgesToInsert.length > 0) {
            await db.insert(prEdges).values(edgesToInsert).onConflictDoNothing();
            console.log(`   🔗 [PR-${pullRequestId}] Linked ${edgesToInsert.length} delta edges for ${filePath}`);
        }

    } catch (err) {
        console.error(`   ❌ [PR-${pullRequestId}] Failed to insert PR edges for ${filePath}:`, err.message);
    }
}

/**
 * Clean up all delta data for a PR (on close/merge)
 * Cascade deletes pr_edges via FK constraint
 */
async function cleanupPR(pullRequestId) {
    try {
        await db.delete(prSymbols).where(eq(prSymbols.pullRequestId, pullRequestId));
        console.log(`   🗑  [PR-${pullRequestId}] Delta graph cleaned up`);
    } catch (err) {
        console.error(`❌ [PR-${pullRequestId}] Cleanup error:`, err.message);
    }
}

// =========================================================================
// GRAPH TRAVERSAL — RECURSIVE CTE (Unified Base + Delta)
// =========================================================================

/**
 * Calculate the bounded Blast Radius using a Recursive CTE.
 * Stitches the Base Graph (edges) and Delta Graph (pr_edges) via UNION,
 * then traverses up to 2 hops from each target symbol.
 *
 * @param {number} repositoryId - The repository ID
 * @param {number|null} pullRequestId - The PR ID (null for base-only queries)
 * @param {number[]} targetSymbolIds - Symbol IDs to start traversal from
 * @returns {Array<{from_symbol: number, to_symbol: number, hop_depth: number, source: string}>}
 */
async function getBlastRadius(repositoryId, pullRequestId, targetSymbolIds) {
    if (!targetSymbolIds || targetSymbolIds.length === 0) return [];

    try {
        // Build the target list as a SQL-safe parameter
        const targetList = targetSymbolIds.join(',');

        // If no PR, only query the base graph
        const prUnionClause = pullRequestId
            ? `UNION SELECT from_symbol_id, to_symbol_id FROM pr_edges WHERE pull_request_id = ${pullRequestId}`
            : '';

        const query = `
            WITH RECURSIVE UnifiedEdges AS (
                SELECT from_symbol_id AS from_symbol, to_symbol_id AS to_symbol
                FROM edges
                WHERE repository_id = $1
                ${prUnionClause}
            ),
            BlastRadius AS (
                -- Hop 1: Direct Dependencies (who calls the changed symbols)
                SELECT from_symbol, to_symbol, 1 AS hop_depth
                FROM UnifiedEdges
                WHERE to_symbol IN (${targetList})

                UNION ALL

                -- Hop 2: Indirect Dependencies (strictly bounded)
                SELECT ue.from_symbol, ue.to_symbol, br.hop_depth + 1
                FROM UnifiedEdges ue
                INNER JOIN BlastRadius br ON ue.to_symbol = br.from_symbol
                WHERE br.hop_depth < 2
            )
            SELECT DISTINCT from_symbol, to_symbol, hop_depth
            FROM BlastRadius
            ORDER BY hop_depth ASC;
        `;

        const result = await db.execute(sql.raw(query.replace('$1', repositoryId)));
        
        console.log(`   💥 Blast radius: ${result.rows?.length || 0} impacted symbols (up to 2 hops)`);
        return result.rows || [];

    } catch (err) {
        console.error("❌ Blast radius CTE error:", err.message);
        return [];
    }
}

/**
 * Fetch full symbol records (including sourceCode) by ID array.
 * Queries both base symbols and PR symbols.
 */
async function getSymbolsByIds(symbolIds, pullRequestId = null) {
    if (!symbolIds || symbolIds.length === 0) return [];

    try {
        // Fetch from base symbols
        const baseResults = await db
            .select()
            .from(symbols)
            .where(inArray(symbols.id, symbolIds));

        let prResults = [];
        if (pullRequestId) {
            prResults = await db
                .select()
                .from(prSymbols)
                .where(and(
                    eq(prSymbols.pullRequestId, pullRequestId),
                    inArray(prSymbols.id, symbolIds)
                ));
        }

        return [...baseResults, ...prResults];

    } catch (err) {
        console.error("❌ Failed to fetch symbols by IDs:", err.message);
        return [];
    }
}

module.exports = {
    // Base graph
    insertFileSymbols,
    insertFileEdges,
    deleteGraphForFile,
    storeGraphForFile,
    // Delta graph (PR isolation)
    insertPRSymbols,
    insertPREdges,
    cleanupPR,
    // Graph traversal
    getBlastRadius,
    getSymbolsByIds,
};