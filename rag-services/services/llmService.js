import { ai, modelName } from "../config/llm.js";

// Helper: Format the AST/Graph context into a readable structure for the LLM
function formatImpactContext(context) {
    if (!context || context.length === 0) return "No direct dependency impact detected.";

    return context.map((item, index) => `
    [IMPACTED SYMBOL #${index + 1}]
    TYPE: ${item.symbolType}
    NAME: ${item.symbolName}
    FILE: ${item.file}
    RANGE: Lines ${item.lineRange}
    
    DEPENDENT CODE SNIPPET:
    \`\`\`javascript
    ${item.codeSnippet}
    \`\`\`
    `).join("\n--------------------------------------------------\n");
}

// Function 1: Answer User Questions (Chat RAG)
// Updated to handle specific symbol context if available
async function generateAnswer(query, retrievedContext) {
    try {
        const contextString = retrievedContext.map(item => 
            `\n--- FILE: ${item.file} (Symbol: ${item.symbolName || 'General'}) ---\n${item.codeSnippet}`
        ).join("\n");

        const prompt = `
You are a Principal Software Engineer and System Architect.
You are answering a question based on a specific codebase.

CONTEXT (Retrieved via Graph RAG):
${contextString}

USER QUESTION: 
"${query}"

INSTRUCTIONS:
1. Use the provided code context strictly.
2. If the context contains function definitions, explain their inputs, outputs, and role.
3. If the answer involves multiple files, explain the relationship between them.
4. Do not hallucinate code that isn't provided.
`;

        console.log(`🤖 Asking ${modelName} (Chat)...`);

        const result = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
                temperature: 0.2, // Low temp for factual accuracy
                topP: 0.95,
                topK: 40,
            }
        });

        return result.text; 

    } catch (error) {
        console.error("❌ Error generating answer:", error.message);
        return "I encountered an error while analyzing the codebase.";
    }
}

// Function 2: Deep Impact PR Review
// This is the "Industry Grade" upgrade
async function generatePRReview(diff, title, description, impactedContext) {
    try {
        // 1. Format the "Downstream" code that might break
        const formattedContext = formatImpactContext(impactedContext);

        // 2. The "Architect" Prompt
        const prompt = `
You are a Senior Principal Engineer reviewing a Pull Request. 
Your goal is not just to check syntax, but to detect **Logical Regressions** and **Integration Issues**.

---
METADATA:
Title: ${title}
Description: ${description}

---
SECTION 1: THE PROPOSED CHANGES (DIFF)
${diff}

---
SECTION 2: THE IMPACT RADIUS (Code that DEPENDS on the changes above)
*These functions call or rely on the code changed in the Diff. Check them for breakage.*

${formattedContext}

---
YOUR TASK:
1. **Analyze the Diff**: Look for bugs, security risks, and inefficiencies in the new code.
2. **Analyze the Impact**: 
   - Look at the functions in SECTION 2. 
   - Did the API signature change in Section 1? If so, does Section 2 update the call sites?
   - Did the return type or logic change? Will Section 2 break?
3. **Provide a Review**:
   - 🔴 **Critical Issues**: Bugs, Security, Breaking Changes (e.g., "Function X changed signature but Caller Y was not updated").
   - 🟡 **Suggestions**: Optimization, readability, best practices.
   - 🟢 **Commendations**: What was done well.

OUTPUT FORMAT:
Markdown. Be concise but technical. If you see a breaking change between Section 1 and Section 2, HIGHLIGHT IT BOLDLY.
`;

        console.log(`🤖 Generating Deep Impact Review with ${modelName}...`);

        const result = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
                temperature: 0.1, // Very low temp - we want strict logic, not creativity
            }
        });

        return result.text;

    } catch (error) {
        console.error("❌ Error generating PR review:", error.message);
        return "Could not generate review due to an internal error.";
    }
}

export { generateAnswer, generatePRReview };