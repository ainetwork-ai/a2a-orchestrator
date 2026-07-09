import { World } from "./world";
import { Thread, AgentPersona } from "../types";
import { v4 as uuidv4 } from "uuid";
import { getRedisClient } from "../utils/redis";
import AgentService from "../services/agentService";

// EPIC8: agent shape accepted by the ingest upsert path. a2aUrl is optional on
// the wire (F1: absence is not a hard-fail), unlike the required AgentPersona.a2aUrl.
export interface IngestAgentInput {
  name: string;
  a2aUrl?: string;
  backendAgentId?: string;
  role?: string;
  color?: string;
}

class ThreadManager {
  private static instance: ThreadManager;
  private threads: Map<string, Thread> = new Map();
  private worlds: Map<string, World> = new Map();
  private apiUrl: string;
  private model: string;

  private constructor(apiUrl: string, model: string) {
    this.apiUrl = apiUrl;
    this.model = model;
  }

  static getInstance(): ThreadManager {
    if (!ThreadManager.instance) {
      throw new Error("ThreadManager not initialized. Call initialize() first.");
    }
    return ThreadManager.instance;
  }

  static initialize(apiUrl: string, model: string): ThreadManager {
    if (!ThreadManager.instance) {
      ThreadManager.instance = new ThreadManager(apiUrl, model);
    }
    return ThreadManager.instance;
  }

  /**
   * Save thread to Redis
   */
  private async saveThreadToRedis(thread: Thread): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.set(`thread:${thread.id}`, JSON.stringify(thread));
      await redis.sAdd("threads:list", thread.id);
    } catch (error) {
      console.error(`[ThreadManager] Error saving thread to Redis:`, error);
    }
  }

  async saveUserIdToRedis(threadId: string, userId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      
      const threadData = await redis.get(`thread:${threadId}`);
      if (!threadData) {
        console.warn(`[ThreadManager] Thread ${threadId} not found in Redis`);
        return;
      }

      const thread: Thread = JSON.parse(threadData);
      
      thread.userId = userId;
      thread.updatedAt = Date.now();

      await redis.set(`thread:${threadId}`, JSON.stringify(thread));

      const memoryThread = this.threads.get(threadId);
      if (memoryThread) {
        memoryThread.userId = userId;
        memoryThread.updatedAt = thread.updatedAt;
      }

      console.log(`[ThreadManager] Saved userId to thread ${threadId}`);
    } catch (error) {
      console.error(`[ThreadManager] Error saving userId to Redis:`, error);
    }
  }

  /**
   * Load threads from Redis
   */
  async loadThreadsFromRedis(): Promise<void> {
    try {
      const redis = getRedisClient();
      const threadIds = await redis.sMembers("threads:list");

      for (const threadId of threadIds) {
        const threadData = await redis.get(`thread:${threadId}`);
        if (threadData) {
          const thread: Thread = JSON.parse(threadData);
          this.threads.set(thread.id, thread);

          // Create World instance for this thread
          const world = new World(this.apiUrl, this.model, thread.id, thread.agents, thread.userId);
          this.worlds.set(thread.id, world);

          // Load messages for this thread
          await world.loadMessagesFromRedis(thread.id);
        }
      }

      console.log(`[ThreadManager] Loaded ${threadIds.length} threads from Redis`);
    } catch (error) {
      console.error(`[ThreadManager] Error loading threads from Redis:`, error);
    }
  }

  /**
   * Create a new thread
   */
  createThread(name: string, userId: string, agents: AgentPersona[] = []): Thread {
    const thread: Thread = {
      id: uuidv4(),
      name,
      agents,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId,
    };

    this.threads.set(thread.id, thread);

    // Create a new World instance for this thread
    const world = new World(this.apiUrl, this.model, thread.id, agents, userId);
    this.worlds.set(thread.id, world);

    // Save to Redis
    this.saveThreadToRedis(thread);

    console.log(`[ThreadManager] Created thread: ${thread.id} (${thread.name})`);
    return thread;
  }

  /**
   * Upsert a thread by the GIVEN id (EPIC8 — ainspace dual-write ingest).
   *
   * Unlike createThread, this does NOT mint a new uuid: the frontend-supplied
   * id IS the thread id (= backend conversationId, identity mapping). If the
   * thread already exists it is reused (any new agents are merged in), making
   * the ingest path idempotent across partial/repeated posts (F3).
   *
   * The stored userId is the backend user id (backend users.id) — required.
   * Agents are merged (dedup) and registered into orchestrator:agents so the
   * report agentUrls/agentNames filters resolve.
   */
  getOrCreateThread(input: {
    id: string;
    name?: string;
    userId: string;
    agents: IngestAgentInput[];
  }): World {
    const existing = this.threads.get(input.id);
    if (existing) {
      // Merge any newly-seen agents; keep the existing thread + World.
      this.mergeAgents(existing, input.agents);
      let world = this.worlds.get(input.id);
      if (!world) {
        // Defensive: thread present but World missing (never happens via the
        // normal create/load paths). Rebuild so ingest has somewhere to append.
        world = new World(this.apiUrl, this.model, existing.id, existing.agents, existing.userId);
        this.worlds.set(existing.id, world);
      }
      return world;
    }

    // New thread: use the given id verbatim.
    const agents: AgentPersona[] = input.agents.map((a) => this.toPersona(a));
    const now = Date.now();
    const thread: Thread = {
      id: input.id,
      name: input.name || input.id,
      agents,
      createdAt: now,
      updatedAt: now,
      userId: input.userId,
    };

    this.threads.set(thread.id, thread);

    const world = new World(this.apiUrl, this.model, thread.id, agents, thread.userId);
    this.worlds.set(thread.id, world);

    this.saveThreadToRedis(thread);
    this.registerAgents(agents);

    console.log(`[ThreadManager] getOrCreateThread created thread ${thread.id} with ${agents.length} agent(s)`);
    return world;
  }

  /**
   * Normalize an ingest agent input into an AgentPersona, applying defaults
   * (role "", color as in the agents route, a2aUrl "" when absent per F1).
   */
  private toPersona(a: IngestAgentInput): AgentPersona {
    const persona: AgentPersona = {
      name: a.name,
      role: a.role ?? "",
      a2aUrl: a.a2aUrl ?? "",
      color: a.color || "bg-gray-100 border-gray-400",
    };
    if (a.backendAgentId) persona.backendAgentId = a.backendAgentId;
    return persona;
  }

  /**
   * Register agents into the orchestrator:agents set (report filter source).
   * Only agents with both a name and a non-empty a2aUrl are registerable —
   * that set is keyed by a2aUrl. Agents without a2aUrl still live in
   * thread.agents, so the agentNames filter continues to resolve them.
   */
  private registerAgents(agents: AgentPersona[]): void {
    const registerable = agents
      .filter((a) => a.name && a.a2aUrl)
      .map((a) => ({ name: a.name, a2aUrl: a.a2aUrl }));
    if (registerable.length > 0) {
      AgentService.getInstance().registerAgents(registerable);
    }
  }

  /**
   * Merge incoming agents into an existing thread (add-only, idempotent).
   *
   * An incoming agent matches an existing one by a2aUrl when present, else by
   * name (names are unique within a thread per the ingest contract, so this is
   * the safe fallback when a2aUrl is absent — and it avoids empty-string
   * collisions among multiple a2aUrl-less agents).
   */
  private mergeAgents(thread: Thread, incoming: IngestAgentInput[]): void {
    const added: AgentPersona[] = [];
    for (const inc of incoming) {
      const match = thread.agents.find(
        (ex) => (inc.a2aUrl ? ex.a2aUrl === inc.a2aUrl : false) || ex.name === inc.name
      );
      if (match) continue;
      const persona = this.toPersona(inc);
      thread.agents.push(persona);
      added.push(persona);
    }

    if (added.length > 0) {
      thread.updatedAt = Date.now();
      const world = this.worlds.get(thread.id);
      if (world) world.updateAgents(thread.agents);
      this.saveThreadToRedis(thread);
      this.registerAgents(added);
      console.log(`[ThreadManager] Merged ${added.length} new agent(s) into thread ${thread.id}`);
    }
  }

  /**
   * Get a thread by ID
   */
  getThread(threadId: string): Thread | undefined {
    return this.threads.get(threadId);
  }

  /**
   * Get all threads
   */
  getAllThreads(): Thread[] {
    return Array.from(this.threads.values());
  }

  /**
   * Get World instance for a thread
   */
  getWorld(threadId: string): World | undefined {
    return this.worlds.get(threadId);
  }

  /**
   * Delete a thread
   */
  async deleteThread(threadId: string): Promise<boolean> {
    const deleted = this.threads.delete(threadId);
    if (deleted) {
      this.worlds.delete(threadId);

      // Delete from Redis
      try {
        const redis = getRedisClient();
        await redis.del(`thread:${threadId}`);
        await redis.del(`messages:${threadId}`);
        await redis.sRem("threads:list", threadId);
      } catch (error) {
        console.error(`[ThreadManager] Error deleting thread from Redis:`, error);
      }

      console.log(`[ThreadManager] Deleted thread: ${threadId}`);
    }
    return deleted;
  }

  /**
   * Add an agent to a thread
   */
  addAgent(threadId: string, agent: AgentPersona): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return false;
    }

    // Check if agent already exists
    const exists = thread.agents.some(a => a.a2aUrl === agent.a2aUrl);
    if (exists) {
      return false;
    }

    thread.agents.push(agent);
    thread.updatedAt = Date.now();

    // Update the World instance
    const world = this.worlds.get(threadId);
    if (world) {
      world.updateAgents(thread.agents);
    }

    // Save to Redis
    this.saveThreadToRedis(thread);

    console.log(`[ThreadManager] Added agent ${agent.name} to thread ${threadId}`);
    return true;
  }

  /**
   * Remove an agent from a thread
   */
  removeAgent(threadId: string, agentId: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return false;
    }

    const initialLength = thread.agents.length;
    thread.agents = thread.agents.filter(a => a.name !== agentId && a.a2aUrl !== agentId);

    if (thread.agents.length === initialLength) {
      return false; // No agent was removed
    }

    thread.updatedAt = Date.now();

    // Update the World instance
    const world = this.worlds.get(threadId);
    if (world) {
      world.updateAgents(thread.agents);
    }

    // Save to Redis
    this.saveThreadToRedis(thread);

    console.log(`[ThreadManager] Removed agent ${agentId} from thread ${threadId}`);
    return true;
  }

  /**
   * Update thread name
   */
  updateThreadName(threadId: string, name: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return false;
    }

    thread.name = name;
    thread.updatedAt = Date.now();

    // Save to Redis
    this.saveThreadToRedis(thread);

    return true;
  }
}

export default ThreadManager;
