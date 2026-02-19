const { db } = require("../config/db");
const { symbols, edges } = require("../lib/db/schema");
const { eq, and, inArray } = require("drizzle-orm");

/**
 * PHASE 1: Insert Symbols Only
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
                endLine: s.endLine
            })))
            .onConflictDoNothing();
            
        console.log(`   📝 Symbols inserted for ${filePath}`);
    } catch (err) {
        console.error(`   ❌ Failed to insert symbols for ${filePath}:`, err.message);
    }
}

/**
 * PHASE 2: Resolve and Insert Edges
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

// Keep your existing delete function
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
 * This ensures 'updationServices.js' and other files don't break.
 * It runs both phases sequentially for a single file.
 */
async function storeGraphForFile(repositoryId, filePath, extractedSymbols, dependencies) {
    await insertFileSymbols(repositoryId, filePath, extractedSymbols);
    await insertFileEdges(repositoryId, filePath, dependencies);
}

module.exports = { 
    insertFileSymbols, 
    insertFileEdges, 
    deleteGraphForFile,
    storeGraphForFile // ✅ Restored export
};