# A2A Orchestrator Backend

A multi-agent orchestration system using A2A (Agent-to-Agent) protocol. This is the backend server that manages agent conversations, world simulation, and report generation with T3C-style visualization.

## Features

- **A2A Protocol Integration**: Communicates with external agents using A2A (Agent-to-Agent) protocol
- **Multi-Agent Conversations**: Orchestrates conversations between multiple AI agents
- **Real-time Message Streaming**: SSE-based real-time updates
- **Sequential Conversation Flow**: AI-recommended speaker order
- **Block Summarization**: Conversation context compression
- **Conversation Verification**: Automatic stop detection based on goal achievement
- **Report Generation**: Embedding-based clustering with T3C-style visualization
- **Grounded Analysis**: Opinions linked to supporting messages for verifiability
- **Redis Integration**: Conversation persistence, state management, and embedding cache

## Quick Start

### Docker Development (Recommended)

Includes Redis container for full functionality.

```bash
# Copy and configure environment file
cp .env.dev.example .env.dev

# Edit .env.dev with your LLM API and Embedding API settings
# Required: LLM_API_URL, LLM_MODEL
# Required: OPENAI_API_KEY or Azure OpenAI embedding configuration

# Start development environment (includes Redis)
make dev

# View logs
make dev-logs

# Stop
make dev-down
```

The server will run on `http://localhost:3006`

### Docker Production

```bash
# Copy and configure environment file
cp .env.prod.example .env.prod

# Edit .env.prod with your production settings
# Required: LLM_API_URL, LLM_MODEL, REDIS_URL
# Required: OPENAI_API_KEY or Azure OpenAI embedding configuration

# Start production environment
make prod

# View logs
make prod-logs

# Stop
make prod-down
```

The server will run on `http://localhost:3002`

### Local Development (without Docker)

Requires Redis running on your local machine.

```bash
# Install dependencies
npm install

# Copy environment file and update Redis URL to redis://redis:6379
cp .env.dev.example .env.dev

# Edit .env.dev:
# - Set REDIS_URL=redis://127.0.0.1:6379 (for local Redis)
# - Configure LLM_API_URL and LLM_MODEL
# - Configure embedding API (OpenAI or Azure OpenAI)

# Make sure Redis is running locally
# redis-server

# Run development server
npm run dev
```

The server will run on `http://localhost:3001`

## Environment Variables

### Development (.env.dev)

```env
# Server Configuration
NODE_ENV=development
PORT=3001

# Redis Configuration (Docker network)
REDIS_URL=redis://redis:6379

# LLM API URL (vLLM chat completions endpoint)
LLM_API_URL=http://your-llm-server:8000/v1/chat/completions

# LLM Model path
LLM_MODEL=/path/to/your/model

# Embedding API Configuration (Choose one)
# Option 1: OpenAI
OPENAI_API_KEY=sk-your-openai-api-key

# Option 2: Azure OpenAI
AZURE_OPENAI_EMBEDDING_BASE_URL=https://your-resource.openai.azure.com
AZURE_OPENAI_EMBEDDING_API_KEY=your-azure-api-key
AZURE_OPENAI_EMBEDDING_API_VERSION=2023-05-15
AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME=text-embedding-3-large

# SSL Configuration (allow self-signed certificates)
NODE_TLS_REJECT_UNAUTHORIZED=0

# CORS Configuration
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

### Production (.env.prod)

```env
# Server Configuration
NODE_ENV=production
PORT=3001

# Redis Configuration (External via host)
REDIS_URL=redis://host.docker.internal:6379

# LLM API URL (Production server)
LLM_API_URL=https://your-production-llm-server:8000/v1/chat/completions

# LLM Model path
LLM_MODEL=/path/to/your/model

# Embedding API Configuration (Choose one)
OPENAI_API_KEY=sk-your-openai-api-key
# or Azure OpenAI configuration (see above)

# SSL Configuration (commented out for production security)
# NODE_TLS_REJECT_UNAUTHORIZED=0

# CORS Configuration (Production frontend)
ALLOWED_ORIGINS=https://your-frontend-domain.com
```

## Report Generation Pipeline

The report pipeline uses embedding-based clustering for deterministic, cost-effective analysis:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Report Generation Pipeline                        │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Parse Messages      │ Extract messages from threads                 │
│  2. Generate Embeddings │ OpenAI/Azure text-embedding-3 (cached)        │
│  3. Categorize          │ Embedding similarity (no LLM)                 │
│  4. Cluster             │ UMAP + K-means (deterministic)                │
│  5. Subtopic Clustering │ K-means within topics (dot grid)              │
│  6. Analyze Clusters    │ LLM: labels, opinions, summaries              │
│  7. Ground Opinions     │ LLM: link opinions to supporting messages     │
│  8. Calculate Stats     │ Aggregations and distributions                │
│  9. Synthesize          │ LLM: key findings, executive summary          │
│ 10. Visualization       │ Scatter plot, topic tree, charts              │
│ 11. Dot Grid            │ T3C-style message visualization               │
│ 12. Render Markdown     │ Human-readable report                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Features

- **Embedding Caching**: 30-day Redis cache for embeddings (cost savings on repeated analysis)
- **Grounded Analysis**: Every opinion linked to supporting message IDs
- **T3C Dot Grid**: Visual representation of messages with subtopic clustering
- **Privacy-Safe**: No user IDs stored, only unique user counts via thread IDs

## Project Structure

```
a2a-orchestrator/
├── src/
│   ├── server.ts                    # Server entry point
│   ├── routes/
│   │   ├── threads.ts               # Thread management API
│   │   ├── agents.ts                # Agent import API
│   │   └── reports.ts               # Report generation API
│   ├── world/                       # Orchestration logic
│   │   ├── threadManager.ts         # Thread state management
│   │   ├── world.ts                 # World simulation
│   │   ├── worldManager.ts          # World lifecycle management
│   │   ├── messageDAG.ts            # Message DAG structure
│   │   ├── requestManager.ts        # LLM request handling
│   │   └── verifier.ts              # Conversation verification
│   ├── services/
│   │   ├── reportService.ts         # Report job management
│   │   └── reportPipeline/          # Report generation pipeline
│   │       ├── index.ts             # Pipeline orchestration
│   │       ├── parser.ts            # Thread message parsing
│   │       ├── embedder.ts          # OpenAI/Azure embedding
│   │       ├── categorizer.ts       # Embedding-based categorization
│   │       ├── clusterer.ts         # UMAP + K-means clustering
│   │       ├── subtopicClusterer.ts # Subtopic clustering (TRD 13)
│   │       ├── clusterAnalyzer.ts   # LLM cluster analysis
│   │       ├── grounding.ts         # Opinion grounding (TRD 05)
│   │       ├── analyzer.ts          # Statistics calculation
│   │       ├── synthesizer.ts       # Report synthesis
│   │       ├── visualizer.ts        # Visualization data
│   │       ├── dotGridGenerator.ts  # Dot grid (TRD 13)
│   │       └── renderer.ts          # Markdown rendering
│   ├── utils/
│   │   ├── redis.ts                 # Redis utilities
│   │   ├── reportTransformer.ts     # T3C format transformer
│   │   └── reportValidator.ts       # Report validation
│   └── types/
│       ├── index.ts                 # Core type definitions
│       ├── report.ts                # Report types (T3C)
│       ├── embedding.ts             # Embedding types
│       └── visualization.ts         # Visualization types
├── dist/                            # Built files (generated)
├── Dockerfile
├── docker-compose.dev.yml
├── docker-compose.prod.yml
├── Makefile
├── package.json
└── tsconfig.json
```

## API Endpoints

### Health Check
```
GET /api/health
```

### Thread Management
```
GET    /api/threads              # List all threads
POST   /api/threads              # Create new thread
POST   /api/threads/:id/agents   # Add agent to thread
POST   /api/threads/:id/messages # Send message to thread
GET    /api/threads/:id/stream   # SSE stream for thread updates
```

### Agent Management
```
POST   /api/agents/import        # Import agent from A2A endpoint
```

### Conversation Ingest (ainspace dual-write — EPIC8)
```
POST   /api/ingest/conversation  # Ingest already-completed turns (Bearer INGEST_TOKEN)
```

### Report Generation
```
POST   /api/reports              # Create report job
GET    /api/reports              # List reports (paginated, filterable)
GET    /api/reports/:jobId       # Get report (format: json|markdown|full)
PATCH  /api/reports/:jobId       # Update report metadata
DELETE /api/reports/:jobId       # Delete report
GET    /api/reports/:jobId/topics        # Get topics only
GET    /api/reports/:jobId/visualization # Get visualization data
GET    /api/reports/:jobId/statistics    # Get statistics
GET    /api/reports/:jobId/markdown      # Get markdown (plain text)
```

### Report API Examples

**Create Report:**
```bash
curl -X POST http://localhost:3006/api/reports \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Weekly Analysis",
    "description": "User feedback analysis",
    "tags": ["weekly", "feedback"],
    "language": "ko"
  }'
```

**Get Report (T3C JSON format):**
```bash
curl "http://localhost:3006/api/reports/{jobId}?format=full"
```

**List Reports with Filtering:**
```bash
curl "http://localhost:3006/api/reports?page=1&limit=20&tags=weekly&status=completed"
```

## Conversation Ingest (ainspace dual-write — EPIC8)

The ainspace frontend posts already-completed conversation turns (user message + agent
responses) here after they round-trip the shared backend. Ingest flows through
ThreadManager/World, so both the in-memory World (which the report pipeline reads) and
Redis are updated — the ingested conversation is visible to a **running** server with no
restart, and no agents are triggered. This is the write path that revives the EPIC1–7
report pipeline on top of live ainspace conversations. The body below is the inter-repo
contract frozen with ainspace EPIC17.

**Auth:** `Authorization: Bearer <INGEST_TOKEN>`. If `INGEST_TOKEN` is unset the endpoint
is **disabled (503)** — fail closed. Distribute the token only to the ainspace frontend/BFF;
"only ainspace calls this endpoint" is the basis of the "orchestrator = ainspace
conversations" provenance invariant.

**Request** — `POST /api/ingest/conversation`:
```jsonc
{
  "thread": {
    "id": "conv_123",           // = backend conversationId (== orchestrator thread id)
    "name": "optional",
    "userId": "user_abc",       // REQUIRED = backend users.id
    "agents": [
      { "name": "Researcher",   // REQUIRED, unique within thread (speaker join key)
        "a2aUrl": "https://agent.example/a2a",  // recommended (report agentUrls filter)
        "backendAgentId": "agent_users_id",     // recommended (correlation)
        "role": "analyst", "color": "bg-gray-100 border-gray-400" }
    ]
  },
  "messages": [
    { "id": "m1", "speaker": "User",       "content": "…", "timestamp": 1720500000000 },
    { "id": "m2", "speaker": "Researcher", "content": "…", "timestamp": 1720500005000,
      "senderA2aUrl": "https://agent.example/a2a", "status": "accepted" }
  ]
}
```
- `speaker` must be exactly `"User"` or one of `thread.agents[].name`.
- `timestamp` is epoch **ms** (the report date filter reads it verbatim).
- `a2aUrl` / `backendAgentId` / `senderA2aUrl` / `replyTo` / `status` are optional.

**Response:** `{ "ok": true, "threadId": "conv_123", "ingested": 2, "skipped": 0 }`

**Idempotent + incremental:** re-POSTing a message id is skipped (counted in `skipped`),
and the user turn and agent turns may arrive in **separate** posts — the first post upserts
the thread, later posts append.

```bash
curl -X POST http://localhost:3002/api/ingest/conversation \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"thread":{"id":"conv_123","userId":"user_abc","agents":[{"name":"Researcher"}]},
       "messages":[{"id":"m1","speaker":"User","content":"hello","timestamp":1720500000000}]}'
```

### Reviving the service + end-to-end check

1. Set `REDIS_URL`, `LLM_API_URL`, `LLM_MODEL`, `INGEST_TOKEN`, and the embedding keys
   (`OPENAI_API_KEY` or the Azure `AZURE_OPENAI_EMBEDDING_*` set), then `npm run dev`
   (or `npm run build && npm start`). Confirm `GET /api/health` returns 200.
2. Ingest a turn or two with the `curl` above; confirm via
   `GET /api/threads/<id>/messages`.
3. Generate a report over that thread: `POST /api/reports` with
   `{ "threadIds": ["conv_123"] }`, then poll `GET /api/reports/<jobId>` until completed.
4. Re-POST the same batch and confirm `skipped` increases with no duplicates.

## T3C Report Format

The API returns reports in T3C (Talk to the City) compatible format:

```json
{
  "id": "report-uuid",
  "title": "Report Title",
  "version": "1.0.0",
  "metadata": {
    "processingTime": 15000,
    "scope": { "totalMessages": 500, "substantiveMessages": 420 },
    "filtering": { "filteringRate": 16.0, "filterReasons": {...} }
  },
  "statistics": { "totalMessages": 420, "topTopics": [...] },
  "synthesis": { "keyFindings": [...], "executiveSummary": "..." },
  "topics": [
    {
      "id": "topic-1",
      "name": "Feature Requests",
      "opinions": [
        {
          "text": "Users want dark mode",
          "supportingMessages": ["msg-1", "msg-5", "msg-12"],
          "mentionCount": 15,
          "confidence": 0.92
        }
      ],
      "subtopics": [
        { "id": "st-1", "label": "UI Improvements", "messageCount": 25 }
      ]
    }
  ],
  "visualization": { "scatterPlot": {...}, "topicTree": {...} },
  "dotGrid": { "topics": [...], "totalMessages": 420 }
}
```

## How It Works

### Conversation Flow
1. **Thread Creation**: Create a conversation thread
2. **Agent Addition**: Add AI agents to the thread
3. **Message Sending**: User sends a message to the thread
4. **Block Summary**: System generates conversation context summary
5. **Speaker Selection**: AI recommends the next most appropriate speaker
6. **Agent Response**: Selected agent responds via A2A protocol
7. **Verification**: System checks if conversation goal is achieved
8. **Continuation**: Process continues until goal achieved or conversation stalls

### Report Generation Flow
1. **Job Creation**: POST creates async job, returns jobId
2. **Processing**: Pipeline processes messages (SSE updates available)
3. **Completion**: Report available via GET with format parameter
4. **Caching**: Identical requests return cached results

## Docker Architecture

### Development Environment
- **Backend**: Port 3006:3001
- **Redis**: Port 6378:6379 (included)
- **Network**: Internal docker network
- **Redis URL**: `redis://redis:6379`

### Production Environment
- **Backend**: Port 3002:3001
- **Redis**: External (via host.docker.internal)
- **Redis URL**: `redis://host.docker.internal:6379`

## Development

```bash
# Local development with hot reload
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start

# Type check
npx tsc --noEmit

# Lint code
npm run lint
```

## Docker Commands

### Development
```bash
make dev          # Start dev environment
make dev-build    # Build and start
make dev-down     # Stop and remove containers
make dev-logs     # View logs
```

### Production
```bash
make prod         # Start prod environment
make prod-build   # Build and start
make prod-down    # Stop and remove containers
make prod-logs    # View logs
```

## Technology Stack

- **Runtime**: Node.js 22
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: Redis (state, cache, embeddings)
- **Protocol**: A2A (Agent-to-Agent)
- **AI Integration**: vLLM / OpenAI compatible API
- **Embeddings**: OpenAI / Azure OpenAI text-embedding-3
- **Clustering**: UMAP-js + K-means

## License

ISC
