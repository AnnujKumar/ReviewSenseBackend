require('dotenv').config();

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const { HuggingFaceInferenceEmbeddings } = require("@langchain/community/embeddings/hf");
const { getPineconeIndex } = require("../config/pinecone");

const { insertFileSymbols, insertFileEdges, deleteGraphForFile } = require('./graphService');

// =========================================================================
// 🔒 PHASE 1: DETERMINISTIC AST SYMBOL & DEPENDENCY EXTRACTION
//    - No anonymous functions (ArrowFn only if VariableDeclarator)
//    - ClassMethod namespaced as ClassName.methodName
//    - Dependencies filtered via Phase-1-derived whitelist
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

    traverse(ast, {

        /* =============================
           SYMBOL EXTRACTION (Fixed)
        ============================= */

        FunctionDeclaration: {
            enter(path) {
                // Skip anonymous function declarations entirely
                if (!path.node.id?.name) return;

                const { start, end, loc } = path.node;
                const name = path.node.id.name;

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
            exit(path) {
                if (path.node.id?.name) symbolStack.pop();
            }
        },

        FunctionExpression: {
            enter(path) {
                // Only extract named variable-assigned function expressions
                // e.g., const myFunc = function() {}
                if (path.parent.type !== 'VariableDeclarator' || !path.parent.id?.name) return;
                if (!path.node.loc) return;

                const { start, end, loc } = path.node;
                const name = path.parent.id.name;

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
            exit(path) {
                if (path.parent.type === 'VariableDeclarator' && path.parent.id?.name) {
                    symbolStack.pop();
                }
            }
        },

        ArrowFunctionExpression: {
            enter(path) {
                // FIX: Only extract if part of a VariableDeclarator
                // e.g., const myFunc = () => {} — NOT .map(x => x) or Express callbacks
                if (path.parent.type !== 'VariableDeclarator' || !path.parent.id?.name) return;
                if (!path.node.loc) return;

                const { start, end, loc } = path.node;
                const name = path.parent.id.name;

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
            exit(path) {
                if (path.parent.type === 'VariableDeclarator' && path.parent.id?.name) {
                    symbolStack.pop();
                }
            }
        },

        ClassDeclaration: {
            enter(path) {
                // Skip anonymous class declarations
                if (!path.node.id?.name) return;

                const { start, end, loc } = path.node;
                const name = path.node.id.name;

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
            exit(path) {
                if (path.node.id?.name) symbolStack.pop();
            }
        },

        ClassMethod: {
            enter(path) {
                if (!path.node.key?.name) return;

                const { start, end, loc } = path.node;
                const methodName = path.node.key.name;

                // FIX: Namespace as ClassName.methodName to avoid collisions
                const parentClassPath = path.findParent((p) => p.isClassDeclaration());
                let finalSymbolName = methodName;
                if (parentClassPath && parentClassPath.node.id) {
                    finalSymbolName = `${parentClassPath.node.id.name}.${methodName}`;
                }

                const symbol = {
                    type: "method",
                    name: finalSymbolName,
                    startLine: loc.start.line,
                    endLine: loc.end.line,
                    code: code.slice(start, end)
                };

                symbols.push(symbol);
                symbolStack.push(finalSymbolName);
            },
            exit(path) {
                if (path.node.key?.name) symbolStack.pop();
            }
        },

        /* =============================
           DEPENDENCY EXTRACTION
           (Raw — filtered later via whitelist)
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
// 🔒 PHASE 2: WHITELIST-BASED DEPENDENCY FILTERING
//    Only keep edges whose callee exists in the repository symbol set.
//    Drops console.log, axios.get, [].push, etc.
// =========================================================================
function filterDependenciesByWhitelist(dependencies, symbolWhitelist) {
    return dependencies.filter(dep => {
        // Always keep import edges (file-level dependencies)
        if (dep.type === 'imports') return true;

        // For 'calls' edges, only keep if the callee is a known repo symbol
        return symbolWhitelist.has(dep.to);
    });
}

// =========================================================================
// ✅ MAIN INGESTION PIPELINE (3-Phase: AST → Graph → Embedding)
//    - AST IS the chunker — no RecursiveCharacterTextSplitter
//    - sourceCode stored in Neon DB alongside graph
//    - Pinecone gets exact semantic blocks
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
        // BUILD WHITELIST: O(1) lookup set of all repo symbols
        // ----------------------------------------------------
        const symbolWhitelist = new Set();
        for (const item of processedFiles) {
            for (const sym of item.symbols) {
                symbolWhitelist.add(sym.name);
            }
        }
        console.log(`   🔑 Whitelist built: ${symbolWhitelist.size} repository symbols`);

        // Filter dependencies through the whitelist
        for (const item of processedFiles) {
            item.dependencies = filterDependenciesByWhitelist(item.dependencies, symbolWhitelist);
        }

        // ----------------------------------------------------
        // PHASE 1: CLEAN & INSERT SYMBOLS (The Foundation)
        // Now includes sourceCode for monolithic storage
        // ----------------------------------------------------
        console.log("   🔹 Phase 1: Symbol Ingestion...");
        for (const item of processedFiles) {
            await deleteGraphForFile(repositoryId, item.path); // Clear old data
            await insertFileSymbols(repositoryId, item.path, item.symbols);
        }

        // ----------------------------------------------------
        // PHASE 2: RESOLVE & INSERT EDGES (The Connections)
        // Only whitelisted edges survive
        // ----------------------------------------------------
        console.log("   🔹 Phase 2: Edge Resolution...");
        for (const item of processedFiles) {
            await insertFileEdges(repositoryId, item.path, item.dependencies);
        }

        // ----------------------------------------------------
        // PHASE 3: EMBEDDING & PINECONE (The Search Index)
        // AST IS the chunker — each symbol.code is exactly one chunk
        // ----------------------------------------------------
        console.log("   🔹 Phase 3: Embedding Generation...");

        const embeddings = new HuggingFaceInferenceEmbeddings({
            apiKey: process.env.HUGGINGFACEHUB_API_KEY,
            model: "sentence-transformers/all-mpnet-base-v2",
            provider: "hf-inference" // prevent auto provider spam
        });

        const allVectors = [];

        for (const file of processedFiles) {
            console.log(`   📄 Processing Embeddings: ${file.path}`);
            
            const fileSymbols = file.symbols.length > 0
                ? file.symbols
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

            // AST IS the chunker: each symbol's code is exactly one chunk
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

module.exports = { processAndStore, extractSymbolsAndDependencies, filterDependenciesByWhitelist };