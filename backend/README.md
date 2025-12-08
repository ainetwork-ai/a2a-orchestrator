# Backend - A2A Orchestrator API

Express.js backend server for orchestrating multi-agent conversations using A2A protocol.

## Features

- Multi-agent conversation management using A2A protocol
- Real-time SSE (Server-Sent Events) streaming
- Block summarization and next speaker recommendation
- Conversation verification with automatic stop detection
- A2A client integration for external agent communication

## Prerequisites

- Node.js 18 or higher
- Access to A2A-compatible agent endpoints
- Access to an LLM API (vLLM or compatible) for verifier

## Environment Variables

Create a `.env` file in the backend directory:

```env
# LLM API Configuration (for Verifier)
LLM_API_URL=http://your-llm-server:8000/v1/chat/completions
LLM_MODEL=/path/to/your/model

# A2A Agent URLs
AGENT_RYU_SEONG_RYONG_URL=https://your-agent-server.com/agent/ryu-seong-ryong
AGENT_RYU_UN_RYONG_URL=https://your-agent-server.com/agent/ryu-un-ryong
AGENT_GGAEBI_URL=https://your-agent-server.com/agent/ggaebi
AGENT_HORAENG_URL=https://your-agent-server.com/agent/horaeng

# Server Configuration
PORT=3001
ALLOWED_ORIGINS=http://localhost:3000
```

## Local Development

```bash
# Install dependencies
npm install

# Development mode with hot reload
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## Docker Deployment

### Option 1: Docker Compose with Makefile (Recommended)

Development environment (includes Redis):
```bash
make dev         # Start
make dev-build   # Build and start
make dev-logs    # View logs
make dev-down    # Stop
```

Production environment (requires external Redis):
```bash
make prod        # Start
make prod-build  # Build and start
make prod-logs   # View logs
make prod-down   # Stop
```

### Option 2: Docker CLI

1. Create .env file with your configuration

2. Build the image:
```bash
docker build -t a2a-orchestrator-backend .
```

3. Run the container:
```bash
docker run -d \
  -p 3001:3001 \
  --env-file .env \
  --name a2a-orchestrator-backend \
  a2a-orchestrator-backend
```

4. View logs:
```bash
docker logs -f a2a-orchestrator-backend
```

5. Stop and remove:
```bash
docker stop a2a-orchestrator-backend
docker rm a2a-orchestrator-backend
```

## API Endpoints

### Health Check
```
GET /api/health
```

### Get Agents
```
GET /api/chat/agents
```

### Send Message
```
POST /api/chat
Content-Type: application/json

{
  "message": "Your message here"
}
```

### Reset Conversation
```
POST /api/chat
Content-Type: application/json

{
  "action": "reset"
}
```

### SSE Stream
```
GET /api/chat/stream
```

Receives real-time updates:
- `type: "connected"` - Connection established
- `type: "message"` - New message from agent
- `type: "block"` - Block summary and next speaker recommendation

## Architecture

```
backend/
├── src/
│   ├── server.ts           # Express server entry point
│   ├── routes/
│   │   └── chat.ts         # Chat API routes
│   ├── world/
│   │   ├── agents.ts       # Agent personas with A2A client integration
│   │   ├── world.ts        # World state management
│   │   ├── worldManager.ts # Singleton world manager
│   │   ├── messageDAG.ts   # Message history DAG
│   │   ├── requestManager.ts # LLM API request queue (for verifier)
│   │   └── verifier.ts     # Conversation verification
│   └── types/
│       └── index.ts        # TypeScript type definitions
├── Dockerfile
├── docker-compose.yml
└── package.json
```

### A2A Protocol Integration

This backend uses the A2A (Agent-to-Agent) protocol to communicate with external agents. Each agent is defined by an A2A URL endpoint, and the backend maintains conversation context through contextId.

**Key Features:**
- Lazy client initialization (A2A client created on first use)
- Context preservation across conversation turns
- JSON-RPC response parsing with multiple format support
- Automatic retry and error handling

## Production Deployment

### Prerequisites
- Ensure Redis is running and accessible at `host.docker.internal:6379`
- Configure `.env.prod` file with production settings

### Using Docker on Remote Server

1. Copy files to server:
```bash
scp -r backend/ user@server:/path/to/app/
```

2. SSH into server:
```bash
ssh user@server
cd /path/to/app/backend
```

3. Ensure `.env.prod` file has correct production settings

4. Deploy with Makefile:
```bash
make prod
```

Or with docker-compose directly:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Health Check

The backend includes a health check endpoint at `/api/health`. Docker health checks are configured to ensure the service is running properly.

## CORS Configuration

CORS is configured via the `ALLOWED_ORIGINS` environment variable. For multiple origins, separate them with commas:

```env
ALLOWED_ORIGINS=http://localhost:3000,https://example.com,https://app.example.com
```

## License

ISC
