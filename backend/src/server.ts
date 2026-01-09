import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import chatRouter from "./routes/chat";
import threadsRouter from "./routes/threads";
import agentsRouter from "./routes/agents";
import reportsRouter from "./routes/reports";
import ThreadManager from "./world/threadManager";
import ReportService from "./services/reportService";
import { initRedis } from "./utils/redis";

// Load environment variables
dotenv.config();

// Initialize Redis and ThreadManager
async function initialize() {
  const apiUrl = process.env.LLM_API_URL;
  const model = process.env.LLM_MODEL;

  if (!apiUrl || !model) {
    console.error("Error: LLM_API_URL and LLM_MODEL must be set in environment variables");
    process.exit(1);
  }

  // Initialize Redis
  await initRedis();

  // Initialize ThreadManager
  ThreadManager.initialize(apiUrl, model);
  console.log("✅ ThreadManager initialized");

  // Initialize ReportService
  ReportService.initialize(apiUrl, model);
  console.log("✅ ReportService initialized");

  // Load existing threads from Redis
  const threadManager = ThreadManager.getInstance();
  await threadManager.loadThreadsFromRedis();
}

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
  "http://localhost:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// Middleware
app.use(express.json());

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use("/api/chat", chatRouter);
app.use("/api/threads", threadsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/reports", reportsRouter);

// Error handling middleware
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error("Error:", err);
    res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
);

// Start server after initialization
initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Backend server running on http://localhost:${PORT}`);
    console.log(`📡 API endpoints:`);
    console.log(`   - GET    http://localhost:${PORT}/api/threads`);
    console.log(`   - POST   http://localhost:${PORT}/api/threads`);
    console.log(`   - POST   http://localhost:${PORT}/api/threads/:id/agents`);
    console.log(`   - POST   http://localhost:${PORT}/api/threads/:id/messages`);
    console.log(`   - GET    http://localhost:${PORT}/api/threads/:id/stream`);
    console.log(`   - POST   http://localhost:${PORT}/api/agents/import`);
    console.log(`   - POST   http://localhost:${PORT}/api/reports`);
    console.log(`   - GET    http://localhost:${PORT}/api/reports/:jobId`);
    console.log(`   - GET    http://localhost:${PORT}/api/health`);
    console.log(`\n🌍 Allowed origins: ${allowedOrigins.join(", ")}\n`);
  });
}).catch((error) => {
  console.error("Failed to initialize server:", error);
  process.exit(1);
});
