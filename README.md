# 🧠 ReviewSense: Enterprise GraphRAG Code Reviewer

[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-blue.svg)](https://neon.tech/)
[![Redis](https://img.shields.io/badge/Redis-BullMQ-red.svg)](https://redis.io/)
[![Gemini](https://img.shields.io/badge/AI-Gemini%20Pro-orange.svg)](https://deepmind.google/technologies/gemini/)

**ReviewSense** is an automated, event-driven CI/CD guardrail built as a GitHub App. It intercepts Pull Requests and uses a **Hybrid GraphRAG** architecture to mathematically prove if a developer's code changes break downstream contracts, preventing production regressions before human review.

---

## ✨ Key Features

- 🌳 **Deterministic AST Parsing**: Bypasses naive text splitters by using `@babel/parser` to chunk code strictly by its logical semantic boundaries (Classes, Functions, Methods).
- 🕸️ **Recursive Graph Dependency Mapping**: Maps cross-file imports and function calls into a PostgreSQL database, generating a mathematically proven dependency graph.
- 💥 **Recursive CTE Blast Radius**: Uses advanced SQL `WITH RECURSIVE` queries to instantly calculate the 2-hop downstream impact of a Pull Request.
- 🛡️ **Delta Graph Isolation**: Parses unmerged PR code into isolated delta tables, ensuring the main repository graph is never corrupted by rejected code.
- 🤖 **XML Data Contracts**: Enforces strict prompt engineering boundaries to prevent LLM hallucination, forcing the model to evaluate exact contract breakages.
- ⚡ **Producer/Consumer Architecture**: Safely decoupled via BullMQ and Redis to handle heavy AST processing within strict memory limits (2GB RAM) and bypass GitHub's 10-second webhook timeouts.

---

## 🛠️ Technology Stack

| Component | Technology | Justification |
| :--- | :--- | :--- |
| **API Framework** | Express.js | Lightweight and fast, perfect for a decoupled Producer webhook interceptor. |
| **Queueing** | BullMQ + Redis | Handles intensive background AST parsing with strict `concurrency: 1` limits and exponential backoff retries. |
| **Database** | Neon DB (PostgreSQL) | Serverless SQL engine allowing lightning-fast Recursive CTEs for graph traversal. |
| **ORM** | Drizzle | Extremely lightweight SQL-like ORM, skipping heavy Rust binaries to preserve RAM. |
| **AST Parser** | Babel | Industry standard for extracting deterministic JavaScript/TypeScript symbols and edges. |
| **Vector DB** | Pinecone | Fully managed vector database for natural language semantic search. |
| **LLM** | Gemini Pro | Generates structured, deterministic JSON output via `application/json` mime-types. |

---

## 🚀 Local Setup & Installation

### Prerequisites
- Node.js (v18+)
- Redis Server (v5.0+)
- PostgreSQL Database (Neon DB recommended)
- Pinecone API Key
- Gemini API Key
- A GitHub App configured with Webhook events (Push, Pull Request, Installation).

### 1. Clone the Repository
```bash
git clone https://github.com/YourUsername/ReviewSense.git
cd ReviewSenseBackend
```

### 2. Install Dependencies
This project is split into two microservices: the background RAG service and the Webhook listener.
```bash
# Install RAG Service dependencies
cd rag-services
npm install

# Install Webhook Service dependencies
cd ../webhook-services
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root of **both** `rag-services` and `webhook-services`:

```env
# Database
DATABASE_URL="postgresql://user:password@neon.tech/db"

# Redis Queue
REDIS_URL="redis://127.0.0.1:6379"

# AI & Vectors
GEMINI_API_KEY="your_gemini_key"
PINECONE_API_KEY="your_pinecone_key"
HUGGINGFACEHUB_API_KEY="your_hf_key"

# GitHub App Secrets
APP_ID="your_github_app_id"
WEBHOOK_SECRET="your_webhook_secret"
PRIVATE_KEY_PATH="./private-key.pem"
```

### 4. Database Migrations
Ensure your PostgreSQL schema is up to date:
```bash
cd rag-services
npx drizzle-kit push:pg
```

---

## 💻 Running the Application

Because this architecture is safely decoupled to prevent OOM crashes, you must run **three** separate processes locally.

### Step 1: Start Redis
If you are on Windows, we have provided a shortcut script:
```bash
.\start-redis.bat
```
*(If on Mac/Linux, ensure your `redis-server` daemon is running).*

### Step 2: Start the Webhook Producer (Express)
This service intercepts GitHub events and pushes them to the queue in milliseconds.
```bash
cd webhook-services
npm run dev
```

### Step 3: Start the Heavy Consumer (BullMQ Worker)
This background worker executes the intense GraphRAG AST parsing and LLM inference.
```bash
cd webhook-services
node worker.js
```

> [!NOTE]  
> We recommend using `smee.io` or `ngrok` to forward your local port 5000 to your GitHub App's Webhook URL for local testing!

---

## 🏗️ Architecture Flow

1. **The Webhook:** A developer opens a PR. GitHub fires a webhook to our Express API.
2. **The Queue:** Express immediately returns a `202 Accepted` (beating the timeout) and drops the payload into Redis.
3. **The AST Extraction:** The BullMQ Worker pulls the job, fetches the new PR code, and uses Babel to extract all modified functions, classes, and cross-file imports.
4. **The Graph:** These changes are temporarily inserted into `pr_symbols` and `pr_edges` delta tables.
5. **The Blast Radius:** A Recursive CTE traverses Postgres, mathematically proving exactly which downstream files depend on the modified code.
6. **The LLM:** The downstream files and the PR diff are segregated into strict `<PULL_REQUEST_CHANGES>` and `<DOWNSTREAM_IMPACT_CONTEXT>` XML tags.
7. **The Guardrail:** Gemini evaluates the contract. If breaking, it outputs `REQUEST_CHANGES`, and ReviewSense automatically blocks the PR via GitHub Branch Protection.

---

## 📜 License
This project is licensed under the MIT License.
