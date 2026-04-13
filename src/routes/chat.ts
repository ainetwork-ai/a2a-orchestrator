import { Router, Request, Response } from "express";
import WorldManager from "../world/worldManager";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const { message, action } = req.body;

    // Get API URL and model from environment variables
    const apiUrl = process.env.LLM_API_URL;
    const model = process.env.LLM_MODEL;

    if (!apiUrl) {
      return res.status(500).json({
        error: "LLM_API_URL is not set in environment variables",
      });
    }

    if (!model) {
      return res.status(500).json({
        error: "LLM_MODEL is not set in environment variables",
      });
    }

    const worldManager = WorldManager.getInstance();
    let world = worldManager.getWorld();

    // Initialize world if it doesn't exist
    if (!world) {
      world = worldManager.initWorld(apiUrl, model);
    }

    // Handle reset action
    if (action === "reset") {
      world = worldManager.resetWorld(apiUrl, model);
      return res.json({
        success: true,
      });
    }

    // Handle message
    if (!message || message.trim() === "") {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    // Add user message (this will generate block and recommend next speaker)
    const userMessageId = await world.addUserMessage(message);

    // Get the user message object
    const userMessage = world.getHistory().find(m => m.id === userMessageId);

    if (userMessage) {
      // Start sequential agent conversation (non-blocking)
      world.processAgentResponsesQueue(userMessage).catch((error) => {
        console.error("Error processing agents:", error);
      });
    }

    return res.json({
      success: true,
      messageId: userMessageId,
    });
  } catch (error: any) {
    console.error("Error in chat API:", error);
    return res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
});

router.get("/", (req: Request, res: Response) => {
  res.json({
    message: "Chat API is running. Use POST to send messages.",
  });
});

// SSE endpoint for streaming messages
router.get("/stream", (req: Request, res: Response) => {
  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

  // Get API URL and model from environment variables
  const apiUrl = process.env.LLM_API_URL;
  const model = process.env.LLM_MODEL;

  if (!apiUrl || !model) {
    res.write(`data: ${JSON.stringify({ error: "Server configuration error" })}\n\n`);
    res.end();
    return;
  }

  const worldManager = WorldManager.getInstance();
  let world = worldManager.getWorld();

  // Initialize world if it doesn't exist
  if (!world) {
    world = worldManager.initWorld(apiUrl, model);
  }

  const clientId = `client_${Date.now()}_${Math.random()}`;

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: "connected", clientId })}\n\n`);

  // Set up callbacks for this client
  world.addMessageCallback(clientId, (message) => {
    res.write(`data: ${JSON.stringify({ type: "message", data: message })}\n\n`);
  });

  world.addBlockCallback(clientId, (block) => {
    res.write(`data: ${JSON.stringify({ type: "block", data: block })}\n\n`);
  });

  // Clean up on client disconnect
  req.on("close", () => {
    console.log(`Client ${clientId} disconnected`);
    world?.removeMessageCallback(clientId);
    world?.removeBlockCallback(clientId);
    res.end();
  });
});

export default router;
