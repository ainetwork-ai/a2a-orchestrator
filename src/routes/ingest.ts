import { Router, Request, Response } from "express";
import ThreadManager, { IngestAgentInput } from "../world/threadManager";
import { ingestAuth } from "../middleware/ingestAuth";

/**
 * EPIC8 — ainspace dual-write ingest.
 *
 * ainspace posts already-completed conversation turns here after they round-trip
 * the shared backend. Everything flows through ThreadManager/World so BOTH the
 * in-memory World (which the report pipeline reads) and Redis are updated; agents
 * are never triggered. The body below is the inter-repo contract frozen with
 * ainspace EPIC17 — see docs/EPIC8-AINSPACE_DUALWRITE_INGEST.md.
 */
const router = Router();

// Every ingest route requires the shared-secret Bearer token.
router.use(ingestAuth);

interface IngestMessage {
  id: string;
  speaker: string;
  content: string;
  timestamp: number;
  senderA2aUrl?: string;
  replyTo?: string;
  status?: "accepted" | "dropped";
}

// POST /api/ingest/conversation
router.post("/conversation", (req: Request, res: Response) => {
  try {
    const { thread, messages } = req.body ?? {};

    // --- Validate thread ---
    if (!thread || typeof thread !== "object") {
      return res.status(400).json({ error: "thread is required" });
    }
    if (typeof thread.id !== "string" || thread.id.trim() === "") {
      return res.status(400).json({ error: "thread.id is required (= backend conversationId)" });
    }
    if (typeof thread.userId !== "string" || thread.userId.trim() === "") {
      return res.status(400).json({ error: "thread.userId is required (= backend user id)" });
    }
    if (!Array.isArray(thread.agents)) {
      return res.status(400).json({ error: "thread.agents must be an array" });
    }

    // agent name required + unique within thread; a2aUrl/backendAgentId optional (F1).
    const agentNames = new Set<string>();
    for (const a of thread.agents as IngestAgentInput[]) {
      if (!a || typeof a.name !== "string" || a.name.trim() === "") {
        return res.status(400).json({ error: "each thread.agents[].name is required" });
      }
      if (agentNames.has(a.name)) {
        return res.status(400).json({ error: `duplicate agent name within thread: "${a.name}"` });
      }
      agentNames.add(a.name);
    }

    // --- Validate messages ---
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages must be a non-empty array" });
    }

    // A speaker must be "User" (exact) or one of the thread's agent names — this
    // is what keeps the report pipeline's isUser derivation + agentNames filter
    // aligned. Agents join by name (a2aUrl may be absent).
    const validSpeakers = new Set<string>(["User", ...agentNames]);

    for (const m of messages as IngestMessage[]) {
      if (!m || typeof m.id !== "string" || m.id.trim() === "") {
        return res.status(400).json({ error: "each message.id is required" });
      }
      if (typeof m.speaker !== "string" || m.speaker === "") {
        return res.status(400).json({ error: `message.speaker is required (id=${m.id})` });
      }
      if (typeof m.content !== "string") {
        return res.status(400).json({ error: `message.content is required (id=${m.id})` });
      }
      if (typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp)) {
        return res.status(400).json({ error: `message.timestamp must be a number in epoch ms (id=${m.id})` });
      }
      if (!validSpeakers.has(m.speaker)) {
        return res.status(400).json({
          error: `message.speaker must be "User" or one of thread.agents[].name (got "${m.speaker}", id=${m.id})`,
        });
      }
      if (m.status !== undefined && m.status !== "accepted" && m.status !== "dropped") {
        return res.status(400).json({ error: `message.status must be "accepted" or "dropped" (id=${m.id})` });
      }
    }

    // --- Upsert thread + append messages (through the managers) ---
    const threadManager = ThreadManager.getInstance();
    const world = threadManager.getOrCreateThread({
      id: thread.id,
      name: thread.name,
      userId: thread.userId,
      agents: thread.agents as IngestAgentInput[],
    });

    // Ingest in timestamp order so DAG ordering matches wall-clock even when a
    // batch arrives out of order (F3). Idempotency is per message id.
    const ordered = [...(messages as IngestMessage[])].sort((a, b) => a.timestamp - b.timestamp);

    let ingested = 0;
    let skipped = 0;
    for (const m of ordered) {
      const result = world.ingestMessage({
        id: m.id,
        speaker: m.speaker,
        content: m.content,
        timestamp: m.timestamp,
        replyTo: m.replyTo,
        status: m.status,
        senderA2aUrl: m.senderA2aUrl,
      });
      if (result.ingested) ingested++;
      else skipped++;
    }

    return res.json({ ok: true, threadId: thread.id, ingested, skipped });
  } catch (error: any) {
    console.error("Error in ingest/conversation:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
