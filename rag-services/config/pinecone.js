require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');

if (!process.env.PINECONE_API_KEY) {
    throw new Error("❌ PINECONE_API_KEY is missing in .env file");
}


const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
});

const INDEX_NAME = "code-review-index";

async function getPineconeIndex() {
  // 1️⃣ Fetch index description (this resolves the host)
  const indexDescription = await pinecone.describeIndex(INDEX_NAME);

  // 2️⃣ Bind index WITH host
  return pinecone.index(INDEX_NAME, indexDescription.host);
}


module.exports = { getPineconeIndex };