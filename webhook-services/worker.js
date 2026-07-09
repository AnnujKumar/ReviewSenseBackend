require('dotenv').config();
const { Worker } = require('bullmq');
const connection = require('./queue/connection');
const { App } = require('@octokit/app');
const fs = require('fs');
const parseDiff = require("parse-diff");

// GraphRAG services
const { ingestRepo } = require("../rag-services/services/ingestionServices.js");
const { processAndStore, extractSymbolsAndDependencies, filterDependenciesByWhitelist } = require("../rag-services/services/embeddingService.js");
const { updateRepoFiles } = require("../rag-services/services/updationServices.js");
const { getPullRequestDiff } = require("./services/gitHubServices.js");
const { retrieveImpactContext } = require("../rag-services/services/retrievalService.js");
const { generatePRReview, formatReviewAsMarkdown } = require("../rag-services/services/llmService.js");
const { insertPRSymbols, insertPREdges, cleanupPR } = require("../rag-services/services/graphService.js");
const { db } = require("../rag-services/config/db.js");
const { repositories } = require("../rag-services/lib/db/schema.js");
const { eq, and } = require("drizzle-orm");

const privateKey = process.env.PRIVATE_KEY ||
  (process.env.PRIVATE_KEY_PATH ? fs.readFileSync(process.env.PRIVATE_KEY_PATH, 'utf8') : undefined);

const githubApp = new App({
  appId: process.env.APP_ID,
  privateKey: privateKey,
});

async function resolveRepositoryId(owner, repo, githubRepoId) {
  let repoRecord;

  if (githubRepoId) {
    repoRecord = await db.query.repositories.findFirst({
      where: eq(repositories.githubRepoId, githubRepoId)
    });
  }

  if (!repoRecord) {
    repoRecord = await db.query.repositories.findFirst({
      where: and(eq(repositories.name, repo), eq(repositories.fullName, `${owner}/${repo}`))
    });
  }

  return repoRecord?.id;
}

function isCodeFile(filePath) {
    return /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(filePath);
}

async function handleAnalyzePR(job) {
  const { repository, prNumber, diffUrl, installationId, title, body, action, githubRepoId, headRef } = job.data;
  const [owner, repo] = repository.split('/');

  console.log(`[Job ${job.id}] Starting analysis for ${repository} PR #${prNumber}`);

  try {
    // Handle PR closed/merged → cleanup delta graph
    if (action === 'closed') {
      console.log(`   🧹 PR #${prNumber} closed. Cleaning up delta graph...`);
      await cleanupPR(prNumber);
      return 'cleaned';
    }

    const octokit = await githubApp.getInstallationOctokit(installationId);
    const diff = await getPullRequestDiff(octokit, owner, repo, prNumber);

    if (!diff) {
      console.log(`[Job ${job.id}] No diff found for PR #${prNumber}`);
      return 'no-diff';
    }

    const repositoryId = await resolveRepositoryId(owner, repo, githubRepoId);

    // --- DELTA GRAPH PROCESSING ---
    const parsed = parseDiff(diff);
    const changedFiles = [];

    for (const file of parsed) {
      const filePath = (file.to || file.from || '').replace(/^[ab]\//, '');
      if (!filePath || filePath === '/dev/null' || !isCodeFile(filePath)) continue;

      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner,
          repo,
          path: filePath,
          ref: headRef
        });
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        changedFiles.push({ path: filePath, content });
      } catch (err) {
        console.warn(`   ⚠️ Could not fetch PR file ${filePath}:`, err.message);
      }
    }

    if (changedFiles.length > 0) {
      console.log(`   🔬 [PR-${prNumber}] Processing ${changedFiles.length} changed files into delta graph...`);
      await cleanupPR(prNumber);

      const processedFiles = [];
      for (const file of changedFiles) {
        const result = extractSymbolsAndDependencies(file.content, file.path);
        processedFiles.push({ ...file, ...result });
      }

      const symbolWhitelist = new Set();
      for (const item of processedFiles) {
        for (const sym of item.symbols) {
          symbolWhitelist.add(sym.name);
        }
      }

      for (const item of processedFiles) {
        item.dependencies = filterDependenciesByWhitelist(item.dependencies, symbolWhitelist);
      }

      for (const item of processedFiles) {
        await insertPRSymbols(prNumber, repositoryId, item.path, item.symbols);
      }
      for (const item of processedFiles) {
        await insertPREdges(prNumber, repositoryId, item.path, item.dependencies);
      }
    }

    // --- IMPACT RETRIEVAL & REVIEW ---
    const impactedContext = await retrieveImpactContext(diff, repositoryId, owner, repo, prNumber);
    
    // This calls Gemini LLM. It will throw if rate limited, which triggers BullMQ retry.
    const reviewJSON = await generatePRReview(diff, title, body, impactedContext);

    const reviewMarkdown = formatReviewAsMarkdown(reviewJSON);

    await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      owner,
      repo,
      pull_number: prNumber,
      body: reviewMarkdown,
      event: reviewJSON.status
    });

    console.log(`   📋 PR #${prNumber} review posted: ${reviewJSON.status}`);
    return 'reviewed';
  } catch (error) {
    console.error(`❌ [Job ${job.id}] Failed:`, error.message);
    throw error;
  }
}

async function handleProcessInstallation(job) {
  const { installationId, repos } = job.data;
  console.log(`[Job ${job.id}] Starting installation processing for ${repos.length} repos`);
  for (const repo of repos) {
    const [owner, repoName] = repo.full_name.split('/');
    const octokit = await githubApp.getInstallationOctokit(installationId);
    const result = await ingestRepo(octokit, owner, repoName, installationId);

    if (!result?.files?.length) {
      console.log(`   ⚠️ No code files found in ${repo.full_name}.`);
      continue;
    }

    console.log(`   ⚙️ Processing ${result.files.length} files for AST & Pinecone...`);
    await processAndStore(result.files, result.repositoryId, owner, repoName);
  }
}

async function handleProcessPush(job) {
  const { installationId, repository, commits } = job.data;
  const owner = repository.owner.login;
  const repo = repository.name;
  console.log(`[Job ${job.id}] Starting push processing for ${owner}/${repo}`);

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const modifiedFilesWithContent = [];
  const addedModifiedSet = new Set();
  const removedSet = new Set();

  (commits || []).forEach(commit => {
    commit.added.forEach(f => addedModifiedSet.add(f));
    commit.modified.forEach(f => addedModifiedSet.add(f));
    commit.removed.forEach(f => removedSet.add(f));
  });

  const modifiedFilePaths = Array.from(addedModifiedSet);
  const removedFilePaths = Array.from(removedSet);

  for (const path of modifiedFilePaths) {
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path });
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      modifiedFilesWithContent.push({ path, content });
    } catch (err) {
      console.error(`   ⚠️ Failed to fetch content for ${path}:`, err.message);
    }
  }

  if (modifiedFilesWithContent.length > 0 || removedFilePaths.length > 0) {
    await updateRepoFiles(owner, repo, modifiedFilesWithContent, removedFilePaths);
  }
}

const worker = new Worker('pr-review-queue', async (job) => {
  try {
    if (job.name === 'analyze-pr') {
      return await handleAnalyzePR(job);
    } else if (job.name === 'process-installation') {
      return await handleProcessInstallation(job);
    } else if (job.name === 'process-push') {
      return await handleProcessPush(job);
    } else {
      console.warn(`[Job ${job.id}] Unknown job name: ${job.name}`);
    }
  } catch (error) {
    console.error(`❌ [Job ${job.id}] Failed:`, error.message);
    throw error; // Re-throw so BullMQ can retry
  }
}, { 
  connection,
  concurrency: 1 // CRITICAL: Must be exactly 1 to survive 2GB RAM constraints
});

worker.on('completed', (job) => {
  console.log(`✅ [Job ${job.id}] completed successfully.`);
});

worker.on('failed', (job, err) => {
  console.error(`🚨 [Job ${job.id}] failed:`, err.message);
});

console.log('👷 BullMQ Worker started: listening to pr-review-queue...');
