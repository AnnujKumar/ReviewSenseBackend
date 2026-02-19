require("dotenv").config();
const { Pinecone } = require("@pinecone-database/pinecone");

const INDEX_NAME = "code-review-index";

async function sdkSmokeTest() {
  const pc = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
  });

  // 🔑 resolve index host explicitly (v7 requirement)
  const desc = await pc.describeIndex(INDEX_NAME);
  const index = pc.index(INDEX_NAME, desc.host);

  console.log("Index resolved:", index.target);
const result = await index.upsert([
  {
    id: "sdk-smoke-test",
    values: new Array(768).fill(0.01),
    metadata: { test: true }
  }
]);

console.log("✅ SDK UPSERT RESULT:", result);


  console.log("✅ SDK UPSERT RESULT:", result);
}

sdkSmokeTest().catch(err => {
  console.error("❌ SDK SMOKE TEST FAILED");
  console.error(err);
});
