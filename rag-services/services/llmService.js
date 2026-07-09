const { ai, modelName } = require("../config/llm");

// =========================================================================
// PR REVIEW JSON SCHEMA (Enforced via structured output)
// Forces the LLM to return machine-readable output for CI/CD integration
// =========================================================================
const PR_REVIEW_SCHEMA = {
    type: "object",
    properties: {
        status: {
            type: "string",
            enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
            description: "Overall decision for the PR."
        },
        blast_radius_issues: {
            type: "array",
            description: "Breaking changes detected in downstream files NOT included in the PR.",
            items: {
                type: "object",
                properties: {
                    downstream_file_affected: { type: "string" },
                    downstream_method_affected: { type: "string" },
                    severity: { type: "string", enum: ["CRITICAL", "WARNING"] },
                    reason: { type: "string" }
                },
                required: ["downstream_file_affected", "downstream_method_affected", "severity", "reason"]
            }
        },
        pr_feedback: {
            type: "array",
            description: "General code quality feedback for the files actually modified in the PR.",
            items: {
                type: "object",
                properties: {
                    file: { type: "string" },
                    line_number: { type: "number" },
                    comment: { type: "string" }
                }
            }
        }
    },
    required: ["status", "blast_radius_issues", "pr_feedback"]
};

// =========================================================================
// Format downstream impact context using strict XML delimiters
// Prevents LLM from confusing PR changes with downstream code
// =========================================================================
function formatDownstreamContext(context) {
    if (!context || context.length === 0) {
        return "<DOWNSTREAM_IMPACT_CONTEXT>\nNo downstream dependencies detected. The changes in this PR do not appear to have callers or dependents in the indexed codebase.\n</DOWNSTREAM_IMPACT_CONTEXT>";
    }

    const entries = context.map((item, index) => {
        const hopLabel = item.hopDepth === 0 ? 'DIRECTLY CHANGED' :
                         item.hopDepth === 1 ? '1-HOP DEPENDENCY' :
                         item.hopDepth === 2 ? '2-HOP DEPENDENCY' : 'DEPENDENCY';

        return `  <SYMBOL index="${index + 1}" hop="${hopLabel}">
    <FILE>${item.file}</FILE>
    <NAME>${item.symbolName}</NAME>
    <TYPE>${item.symbolType}</TYPE>
    <LINES>${item.lineRange}</LINES>
    <SOURCE_CODE>
${item.codeSnippet}
    </SOURCE_CODE>
  </SYMBOL>`;
    }).join("\n\n");

    return `<DOWNSTREAM_IMPACT_CONTEXT>\n${entries}\n</DOWNSTREAM_IMPACT_CONTEXT>`;
}

// =========================================================================
// Function 1: Answer User Questions (Chat RAG) — UNCHANGED
// =========================================================================
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

// =========================================================================
// Function 2: Deep Impact PR Review — STRUCTURED OUTPUT
//
// Problem 9 Fix: XML-delimited prompt segregates PR changes from downstream
//                context, preventing the LLM from reviewing graph context
//                as if the developer wrote it.
//
// Problem 10 Fix: Enforces strict JSON output via response_mime_type,
//                 making the output parseable by CI/CD pipelines.
// =========================================================================
async function generatePRReview(diff, title, description, impactedContext) {
    try {
        // 1. Format downstream context with strict XML delimiters
        const downstreamBlock = formatDownstreamContext(impactedContext);

        // 2. The structured CI/CD prompt — XML-delimited, no context bleed
        const prompt = `
<PULL_REQUEST_METADATA>
  <TITLE>${title || 'No title provided'}</TITLE>
  <DESCRIPTION>${description || 'No description provided'}</DESCRIPTION>
</PULL_REQUEST_METADATA>

<PULL_REQUEST_CHANGES>
${diff}
</PULL_REQUEST_CHANGES>

${downstreamBlock}
`;

        const systemInstruction = `You are an expert CI/CD Code Reviewer. Your job is to analyze Pull Request changes and determine if they break ANY downstream code contracts.

CRITICAL DIRECTIVES:
1. You are receiving two separate blocks of code. <PULL_REQUEST_CHANGES> is the code the developer modified. <DOWNSTREAM_IMPACT_CONTEXT> is collateral code that relies on the modified code.
2. DO NOT list files from <PULL_REQUEST_CHANGES> inside the "blast_radius_issues" JSON array. 
3. "blast_radius_issues" is STRICTLY reserved for files in the <DOWNSTREAM_IMPACT_CONTEXT> that are broken because of the PR. 
4. Feedback regarding the developer's actual code goes into "pr_feedback".`;

        console.log(`🤖 Generating Structured PR Review with ${modelName}...`);

        const result = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
                temperature: 0.1, // Very low temp — strict logic, not creativity
                responseMimeType: "application/json",
                responseSchema: PR_REVIEW_SCHEMA,
                systemInstruction: systemInstruction,
            }
        });

        // Parse and return the structured JSON
        const reviewJSON = JSON.parse(result.text);
        console.log(`   📋 Review status: ${reviewJSON.status} | Blast issues: ${reviewJSON.blast_radius_issues.length} | PR feedback: ${reviewJSON.pr_feedback.length}`);
        return reviewJSON;

    } catch (error) {
        console.error("❌ Error generating PR review:", error.message);
        // Return a safe fallback structure so downstream code doesn't break
        return {
            status: "COMMENT",
            blast_radius_issues: [],
            pr_feedback: [{
                file: "N/A",
                line_number: 0,
                comment: `Review generation failed: ${error.message}`
            }]
        };
    }
}

// =========================================================================
// Format structured JSON review into GitHub-flavored Markdown
// For posting as a PR comment while preserving machine-readability
// =========================================================================
function formatReviewAsMarkdown(reviewJSON) {
    const lines = [];

    // Header with status badge
    const statusEmoji = {
        'APPROVE': '✅',
        'REQUEST_CHANGES': '🔴',
        'COMMENT': '💬'
    };
    lines.push(`## ${statusEmoji[reviewJSON.status] || '🔍'} Code Review: **${reviewJSON.status}**\n`);

    // Blast Radius Issues
    if (reviewJSON.blast_radius_issues && reviewJSON.blast_radius_issues.length > 0) {
        lines.push(`### 💥 Blast Radius Issues\n`);
        lines.push(`| Severity | Downstream File | Method | Reason |`);
        lines.push(`|----------|----------------|--------|--------|`);

        for (const issue of reviewJSON.blast_radius_issues) {
            const severityBadge = issue.severity === 'CRITICAL' ? '🔴 CRITICAL' : '🟡 WARNING';
            lines.push(`| ${severityBadge} | \`${issue.downstream_file_affected}\` | \`${issue.downstream_method_affected}\` | ${issue.reason} |`);
        }
        lines.push('');
    } else {
        lines.push(`### ✅ No Blast Radius Issues Detected\n`);
    }

    // PR Feedback
    if (reviewJSON.pr_feedback && reviewJSON.pr_feedback.length > 0) {
        lines.push(`### 📝 PR Feedback\n`);

        for (const fb of reviewJSON.pr_feedback) {
            const fileRef = fb.file && fb.line_number ? `\`${fb.file}:${fb.line_number}\`` : (fb.file ? `\`${fb.file}\`` : '');
            lines.push(`- ${fileRef} — ${fb.comment}`);
        }
        lines.push('');
    }

    // Machine-readable JSON block (for CI/CD parsers)
    lines.push(`<details>\n<summary>📊 Machine-Readable Review (JSON)</summary>\n`);
    lines.push('```json');
    lines.push(JSON.stringify(reviewJSON, null, 2));
    lines.push('```');
    lines.push(`</details>`);

    return lines.join('\n');
}

module.exports = { generateAnswer, generatePRReview, formatReviewAsMarkdown };