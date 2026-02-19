require('dotenv').config();

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const { HuggingFaceInferenceEmbeddings } = require("@langchain/community/embeddings/hf");
const { getPineconeIndex } = require("../config/pinecone");

// ✅ CHANGED: We import the split functions to enable the 2-Phase Fix
const { insertFileSymbols, insertFileEdges, deleteGraphForFile } = require('./graphService');

// =========================================================================
// 🔒 NO CHANGES MADE TO THIS FUNCTION (As requested)
// =========================================================================
function extractSymbolsAndDependencies(code, filePath) {
    const symbols = [];
    const dependencies = [];

    let ast;

    try {
        ast = parser.parse(code, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"]
        });
    } catch (err) {
        console.error(`   ❌ Babel parse error in ${filePath}:`, err.message);
        return { symbols: [], dependencies: [] };
    }

    // Stack to support nested functions safely
    const symbolStack = [];

    function getCurrentSymbol() {
        return symbolStack.length > 0
            ? symbolStack[symbolStack.length - 1]
            : null;
    }

    function generateAnonymousName(loc) {
        return `${filePath}:${loc.start.line}`;
    }

    traverse(ast, {

        /* =============================
           SYMBOL EXTRACTION
        ============================= */

        FunctionDeclaration: {
            enter(path) {
                const { start, end, loc } = path.node;
                const name = path.node.id?.name || generateAnonymousName(loc);

                const symbol = {
                    type: "function",
                    name,
                    startLine: loc.start.line,
                    endLine: loc.end.line,
                    code: code.slice(start, end)
                };

                symbols.push(symbol);
                symbolStack.push(name);
            },
            exit() {
                symbolStack.pop();
            }
        },

        FunctionExpression: {
            enter(path) {
                if (!path.node.loc) return;

                const { start, end, loc } = path.node;

                const name =
                    path.parent.id?.name ||
                    generateAnonymousName(loc);

                const symbol = {
                    type: "function_expression",
                    name,
                    startLine: loc.start.line,
                    endLine: loc.end.line,
                    code: code.slice(start, end)
                };

                symbols.push(symbol);
                symbolStack.push(name);
            },
            exit() {
                symbolStack.pop();
            }
        },

        ArrowFunctionExpression: {
            enter(path) {
                if (!path.node.loc) return;

                const { start, end, loc } = path.node;

                const name =
                    path.parent.id?.name ||
                    generateAnonymousName(loc);

                const symbol = {
                    type: "arrow_function",
                    name,
                    startLine: loc.start.line,
                    endLine: loc.end.line,
                    code: code.slice(start, end)
                };

                symbols.push(symbol);
                symbolStack.push(name);
            },
            exit() {
                symbolStack.pop();
            }
        },

        ClassDeclaration: {
            enter(path) {
                const { start, end, loc } = path.node;
                const name = path.node.id?.name || generateAnonymousName(loc);

                const symbol = {
                    type: "class",
                    name,
                    startLine: loc.start.line,
                    endLine: loc.end.line,
                    code: code.slice(start, end)
                };

                symbols.push(symbol);
                symbolStack.push(name);
            },
            exit() {
                symbolStack.pop();
            }
        },

        ClassMethod: {
            enter(path) {
                const { start, end, loc } = path.node;
                const name =
                    path.node.key?.name ||
                    generateAnonymousName(loc);

                const symbol = {
                    type: "method",
                    name,
                    startLine: loc.start.line,
                    endLine: loc.end.line,
                    code: code.slice(start, end)
                };

                symbols.push(symbol);
                symbolStack.push(name);
            },
            exit() {
                symbolStack.pop();
            }
        },

        /* =============================
           DEPENDENCY EXTRACTION
        ============================= */

        CallExpression(path) {
            const currentSymbol = getCurrentSymbol();
            const callee = path.node.callee;

            // Handle require('...')
            if (
                callee.type === "Identifier" &&
                callee.name === "require"
            ) {
                const arg = path.node.arguments[0];
                if (arg && arg.type === "StringLiteral") {
                    dependencies.push({
                        from: filePath,
                        to: arg.value,
                        type: "imports"
                    });
                }
                return;
            }

            // Only track function calls if inside a symbol
            if (!currentSymbol) return;

            // Direct call: calculateTax()
            if (callee.type === "Identifier") {
                dependencies.push({
                    from: currentSymbol,
                    to: callee.name,
                    type: "calls"
                });
            }

            // Member call: utils.calculateTax()
            if (callee.type === "MemberExpression") {
                if (callee.property?.type === "Identifier") {
                    dependencies.push({
                        from: currentSymbol,
                        to: callee.property.name,
                        type: "calls"
                    });
                }
            }
        },

        ImportDeclaration(path) {
            const source = path.node.source.value;

            dependencies.push({
                from: filePath,
                to: source,
                type: "imports"
            });
        }
    });

    return { symbols, dependencies };
}

// =========================================================================
// ✅ UPDATED: Main Ingestion Function (3-Phase Pipeline)
// =========================================================================
async function processAndStore(filesArray, repositoryId, owner, repo) {
    console.log(`⚙️  Starting AST-Based (Babel) RAG Pipeline for ${owner}/${repo}...`);

    try {
        const index = await getPineconeIndex();
        if (!index) return;

        // ----------------------------------------------------
        // PRE-PROCESSING: Extract AST for ALL files first
        // ----------------------------------------------------
        const processedFiles = [];
        for (const file of filesArray) {
            const { symbols, dependencies } = extractSymbolsAndDependencies(file.content, file.path);
            processedFiles.push({ ...file, symbols, dependencies });
        }

        // ----------------------------------------------------
        // PHASE 1: CLEAN & INSERT SYMBOLS (The Foundation)
        // ----------------------------------------------------
        console.log("   🔹 Phase 1: Symbol Ingestion...");
        for (const item of processedFiles) {
            await deleteGraphForFile(repositoryId, item.path); // Clear old data
            await insertFileSymbols(repositoryId, item.path, item.symbols);
        }

        // ----------------------------------------------------
        // PHASE 2: RESOLVE & INSERT EDGES (The Connections)
        // ----------------------------------------------------
        console.log("   🔹 Phase 2: Edge Resolution...");
        for (const item of processedFiles) {
            await insertFileEdges(repositoryId, item.path, item.dependencies);
        }

        // ----------------------------------------------------
        // PHASE 3: EMBEDDING & PINECONE (The Search Index)
        // ----------------------------------------------------
        console.log("   🔹 Phase 3: Embedding Generation...");

        const embeddings = new HuggingFaceInferenceEmbeddings({
            apiKey: process.env.HUGGINGFACEHUB_API_KEY,
            model: "sentence-transformers/all-mpnet-base-v2",
            provider: "hf-inference" // prevent auto provider spam
        });

        const allVectors = [];

        for (const file of processedFiles) { // Using processedFiles which has symbols attached
            console.log(`   📄 Processing Embeddings: ${file.path}`);
            
            // Note: 'file.symbols' is already attached from Pre-processing step above
            const symbols = file.symbols; 

            const fileSymbols = symbols.length > 0
                ? symbols
                : [{
                    type: "file",
                    name: file.path,
                    startLine: 1,
                    endLine: file.content.split("\n").length,
                    code: file.content
                }];

            const validSymbols = fileSymbols.filter(s =>
                s.code && s.code.trim().length > 0
            );

            if (validSymbols.length === 0) continue;

            const texts = validSymbols.map(s => s.code);

            // Batch embed to avoid API limits
            const vectors = await embeddings.embedDocuments(texts);

            vectors.forEach((vectorValues, idx) => {
                const symbol = validSymbols[idx];

                allVectors.push({
                    id: `${repositoryId}-${file.path}-${symbol.name}-${symbol.startLine}`,
                    values: vectorValues,
                    metadata: {
                        repo: `${owner}/${repo}`,
                        path: file.path,
                        symbolType: symbol.type,
                        symbolName: symbol.name,
                        startLine: symbol.startLine,
                        endLine: symbol.endLine,
                        text: symbol.code
                    }
                });
            });
        }

        console.log(`   🧩 Generated ${allVectors.length} symbol-level vectors.`);

        if (allVectors.length === 0) {
            console.log("   ⚠️ No vectors to upload.");
            return;
        }

        const BATCH_SIZE = 50;

        for (let i = 0; i < allVectors.length; i += BATCH_SIZE) {
            const batch = allVectors.slice(i, i + BATCH_SIZE);

            console.log(
                `   🚀 Uploading batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} vectors)...`
            );

            await index.upsert(batch);
            console.log("   ✅ Batch uploaded successfully!");
        }

        console.log("✅ AST-Based (Babel) Ingestion Complete!");

    } catch (error) {
        console.error("❌ Error in RAG Pipeline:", error);
    }
}

module.exports = { processAndStore };