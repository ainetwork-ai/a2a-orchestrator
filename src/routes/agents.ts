import { Router, Request, Response } from "express";
// @ts-ignore - ESM import in CommonJS environment
import { A2AClient } from "@a2a-js/sdk/client";
import AgentService from "../services/agentService";

const router = Router();

/**
 * GET /api/agents
 * Get all registered agents for report filtering
 *
 * Response:
 * - agents: Array of { name, a2aUrl }
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const agentService = AgentService.getInstance();
    const agents = await agentService.getAllAgents();

    res.json({
      success: true,
      agents,
      total: agents.length,
    });
  } catch (error: any) {
    console.error("Error getting agents:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

// Import agent information from A2A URL
router.post("/import", async (req: Request, res: Response) => {
  try {
    const { a2aUrl } = req.body;

    if (!a2aUrl) {
      return res.status(400).json({
        error: "A2A URL is required"
      });
    }

    console.log(`[Agent Import] Fetching agent info from: ${a2aUrl}`);

    // Create A2A client from card URL
    const client = await A2AClient.fromCardUrl(a2aUrl);

    // Access card from client's internal structure
    // @ts-ignore - accessing internal card property
    const card = client.card || client._card;

    if (!card) {
      // Fallback: fetch card directly from URL
      const response = await fetch(a2aUrl);
      if (!response.ok) {
        return res.status(400).json({
          error: `Failed to fetch agent card: ${response.statusText}`
        });
      }
      const fetchedCard = await response.json() as any;

      const agentInfo = {
        name: fetchedCard.name || "Unknown Agent",
        role: fetchedCard.description || "AI Agent",
        a2aUrl: a2aUrl,
        color: generateRandomColor()
      };

      console.log(`[Agent Import] Successfully imported agent (fallback): ${agentInfo.name}`);
      return res.json({
        success: true,
        agent: agentInfo
      });
    }

    // Extract agent information from card
    const agentInfo = {
      name: card.name || "Unknown Agent",
      role: card.description || "AI Agent",
      a2aUrl: a2aUrl,
      color: generateRandomColor()
    };

    console.log(`[Agent Import] Successfully imported agent: ${agentInfo.name}`);

    res.json({
      success: true,
      agent: agentInfo
    });
  } catch (error: any) {
    console.error("Error importing agent:", error);
    res.status(500).json({
      error: error.message || "Failed to import agent from A2A URL"
    });
  }
});

// Generate random color for agent
function generateRandomColor(): string {
  const colors = [
    "bg-blue-100 border-blue-400",
    "bg-purple-100 border-purple-400",
    "bg-green-100 border-green-400",
    "bg-amber-100 border-amber-400",
    "bg-pink-100 border-pink-400",
    "bg-indigo-100 border-indigo-400",
    "bg-red-100 border-red-400",
    "bg-teal-100 border-teal-400",
    "bg-orange-100 border-orange-400",
    "bg-cyan-100 border-cyan-400"
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

export default router;
