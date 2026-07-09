const { db } = require('../config/db');
const { repositories, installations, users } = require('../lib/db/schema.js');
const { eq } = require('drizzle-orm');

/**
 * Helper: Validates if a file is a JavaScript/TypeScript code file.
 * We limit this to JS/TS for now because your AST parser (Babel) supports these.
 */
function isCodeFile(filePath) {
    // Regex to match .js, .jsx, .ts, .tsx, .mjs, .cjs (case insensitive)
    return /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(filePath);
}

/**
 * NEW: Strictly handles Neon DB metadata.
 * Creates User -> Installation -> Repository records.
 */
async function syncMetadataToDatabase(owner, repo, githubInstallationId, octokit) {
    try {
        // --- 1. Fetch Real GitHub Data ---
        const { data: githubUser } = await octokit.request('GET /users/{username}', {
            username: owner
        });
        const githubNumericId = String(githubUser.id);

        const { data: githubRepo } = await octokit.request('GET /repos/{owner}/{repo}', {
            owner, repo
        });
        const githubRepoId = githubRepo.id;

        // --- 2. Check/Create User ---
        let userRecord = await db.query.users.findFirst({
            where: eq(users.githubId, githubNumericId)
        });

        if (!userRecord) {
            const [newUser] = await db.insert(users).values({
                clerkId: `temp_${githubNumericId}`, 
                email: `${owner}@placeholder.com`,
                fullName: owner,
                githubId: githubNumericId,
                avatarUrl: githubUser.avatar_url
            }).returning();
            userRecord = newUser;
            console.log(`✅ [Neon] Created temp user for ID: ${githubNumericId}`);
        }

        // --- 3. Check/Create Installation ---
        let installationRecord = await db.query.installations.findFirst({
            where: eq(installations.githubInstallationId, githubInstallationId)
        });

        if (!installationRecord) {
            const [newInstall] = await db.insert(installations).values({
                userId: userRecord.id,
                githubInstallationId: githubInstallationId,
                accountLogin: owner,
                accountType: 'User',
            }).returning();
            installationRecord = newInstall;
            console.log(`✅ [Neon] Created installation ${githubInstallationId}`);
        }

        // --- 4. Check/Create Repository ---
        const existingRepo = await db.query.repositories.findFirst({
            where: (repos, { and, eq }) => and(
                eq(repos.githubRepoId, githubRepoId),
                eq(repos.installationId, installationRecord.id)
            )
        });

        let repositoryRecord = existingRepo;

        if (!repositoryRecord) {
            const [newRepo] = await db.insert(repositories).values({
                installationId: installationRecord.id,
                githubRepoId: githubRepoId,
                name: repo,
                fullName: `${owner}/${repo}`,
                url: githubRepo.html_url,
                private: githubRepo.private,
                isIndexed: true,
            }).returning();

            repositoryRecord = newRepo;
            console.log(`✅ [Neon] Linked repo ${repo} (ID: ${githubRepoId})`);
        }

        return repositoryRecord;

    } catch (err) {
        console.error("❌ Neon Sync Error:", err.message);
    }
}

// YOUR ORIGINAL WORKING CODE
async function ingestRepo(octokit, owner, repo, githubInstallationId, defaultBranch = 'master') {
    try {
        // Sync Neon & get repository record
        const repositoryRecord = await syncMetadataToDatabase(
            owner,
            repo,
            githubInstallationId,
            octokit
        );

        if (!repositoryRecord) {
            throw new Error("Repository record not found after sync.");
        }

        // 1. Get Tree
        const { data } = await octokit.request(
            'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
            {
                owner,
                repo,
                tree_sha: defaultBranch,
                recursive: 'true',
            }
        );

        // ✅ FIXED: Now uses the isCodeFile helper defined above
        const fileList = data.tree.filter((item) =>
            item.type === 'blob' && isCodeFile(item.path)
        );

        console.log(`   Found ${fileList.length} code files. Downloading content...`);

        const filesWithContent = [];

        for (const file of fileList) {
            try {
                const { data: blobData } = await octokit.request(
                    'GET /repos/{owner}/{repo}/git/blobs/{file_sha}',
                    {
                        owner,
                        repo,
                        file_sha: file.sha
                    }
                );

                const content = Buffer
                    .from(blobData.content, 'base64')
                    .toString('utf-8');

                filesWithContent.push({
                    path: file.path,
                    content
                });

            } catch (err) {
                console.error(`   ⚠️ Could not read ${file.path}:`, err.message);
            }
        }

        return {
            files: filesWithContent,
            repositoryId: repositoryRecord.id
        };

    } catch (error) {
        if (defaultBranch === 'master') {
            console.log("   ⚠️ 'master' branch not found. Retrying with 'main'...");
            return ingestRepo(octokit, owner, repo, githubInstallationId, 'main');
        }

        console.error(`Error fetching files for ${owner}/${repo}:`, error.message);
        return null;
    }
}

module.exports = { ingestRepo };