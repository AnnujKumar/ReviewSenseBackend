// Function to get the Raw Diff string
// UPDATED: Now accepts (octokit, owner, repo, pullNumber) directly
async function getPullRequestDiff(octokit, owner, repo, pullNumber) {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo,
            pull_number: pullNumber,
            headers: {
                accept: 'application/vnd.github.v3.diff' // IMPORTANT: Requests the diff text
            },
        });
        
        return response.data; 
    } catch (error) {
        console.error(`❌ Error fetching PR diff: ${error.message}`);
        return null;
    }
}

// Function to post a comment
async function postPRComment(octokit, owner, repo, pullNumber, message) {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: pullNumber,
            body: message,
        });
        console.log(`✅ Comment posted on PR #${pullNumber}`);
    } catch (error) {
        console.error(`❌ Error posting comment: ${error.message}`);
    }
}

module.exports = { getPullRequestDiff, postPRComment };