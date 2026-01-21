# A2A Orchestrator Backend

A multi-agent orchestration system using A2A (Agent-to-Agent) protocol. This is the backend server that manages agent conversations, world simulation, and report generation.

## Features

- **A2A Protocol Integration**: Communicates with external agents using A2A (Agent-to-Agent) protocol
- **Multi-Agent Conversations**: Orchestrates conversations between multiple AI agents
- **Real-time Message Streaming**: SSE-based real-time updates
- **Sequential Conversation Flow**: AI-recommended speaker order
- **Block Summarization**: Conversation context compression
- **Conversation Verification**: Automatic stop detection based on goal achievement
- **Report Generation**: Asynchronous report generation with job tracking
- **Redis Integration**: Conversation persistence and state management

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your settings
# Required: LLM_API_URL, LLM_MODEL, REDIS_URL

# Run development server
npm run dev
```

The server will run on `http://localhost:3001`

### Docker Development (with Redis)

```bash
# Copy and configure environment file
cp .env.example .env.dev

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
cp .env.example .env.prod

# Start production environment
make prod

# View logs
make prod-logs

# Stop
make prod-down
```

The server will run on `http://localhost:3002`

## Environment Variables

```env
# Server Configuration
NODE_ENV=development
PORT=3001

# Redis Configuration
REDIS_URL=redis://127.0.0.1:6379

# LLM API URL (vLLM chat completions endpoint)
LLM_API_URL=http://your-llm-server:8000/v1/chat/completions

# LLM Model path
# Example: /data/models/gpt-oss-120b
LLM_MODEL=/path/to/your/model

# SSL Configuration (set to 0 for development)
NODE_TLS_REJECT_UNAUTHORIZED=0

# CORS Configuration
ALLOWED_ORIGINS=http://localhost:3000
```

## Project Structure

```
a2a-orchestrator/
├── src/
│   ├── server.ts              # Server entry point
│   ├── routes/
│   │   ├── chat.ts            # Chat API (deprecated)
│   │   ├── threads.ts         # Thread management API
│   │   ├── agents.ts          # Agent import API
│   │   └── reports.ts         # Report generation API
│   ├── world/                 # Orchestration logic
│   │   ├── threadManager.ts   # Thread state management
│   │   ├── world.ts           # World simulation
│   │   ├── worldManager.ts    # World lifecycle management
│   │   ├── messageDAG.ts      # Message DAG structure
│   │   ├── requestManager.ts  # Request handling
│   │   └── verifier.ts        # Conversation verification
│   ├── services/
│   │   └── reportService.ts   # Report generation service
│   ├── utils/
│   │   └── redis.ts           # Redis utilities
│   └── types/
│       └── index.ts           # Type definitions
├── dist/                      # Built files (generated)
├── Dockerfile                 # Docker build configuration
├── docker-compose.dev.yml     # Development environment (with Redis)
├── docker-compose.prod.yml    # Production environment
├── Makefile                   # Convenient commands
├── package.json
├── tsconfig.json
└── .env.example
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

### Report Generation
```
POST   /api/reports              # Create report generation job
GET    /api/reports/:jobId       # Get report status/result
```

## How It Works

1. **Thread Creation**: Create a conversation thread
2. **Agent Addition**: Add AI agents to the thread
3. **Message Sending**: User sends a message to the thread
4. **Block Summary**: System generates conversation context summary
5. **Speaker Selection**: AI recommends the next most appropriate speaker
6. **Agent Response**: Selected agent responds via A2A protocol
7. **Verification**: System checks if conversation goal is achieved
8. **Continuation**: Process continues until goal achieved or conversation stalls

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

- **Runtime**: Node.js 20
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: Redis (for state persistence)
- **Protocol**: A2A (Agent-to-Agent)
- **AI Integration**: vLLM chat completions API

## License

ISC
