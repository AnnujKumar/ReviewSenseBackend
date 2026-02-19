// SIMULATION: The user did a "git push"
// 1. They changed 'src/utils.js' (Modified code)
// 2. They deleted 'src/server.js'

const mockModifiedFiles = [
    {
        path: "src/utils.js",
        content: `
// UPDATED FILE - VERSION 2
function add(a, b) {
    console.log("Adding numbers"); // New log added
    return a + b;
}

function subtract(a, b) {
    return a - b;
}

// Tax is now 20% instead of 18%
function calculateTax(amount) {
    return amount * 0.20; 
}

module.exports = { add, subtract, calculateTax };
        `
    }
];

const mockRemovedFiles = [
    "src/server.js" // This file was deleted in the repo
];

const mockUpdateMetadata = {
    owner: "AnnujKumar",
    repo: "MockRepo"
};

module.exports = { mockModifiedFiles, mockRemovedFiles, mockUpdateMetadata };