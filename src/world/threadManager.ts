import { World } from "./world";
import { Thread, AgentPersona } from "../types";
import { v4 as uuidv4 } from "uuid";
import { getRedisClient, rethrowAuthoritativeStateError } from "../utils/redis";
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
  private mutations = new Map<string, Promise<unknown>>();
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
  private serializeThread<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.mutations.get(id) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(action);
    this.mutations.set(id, pending);
    const clear = () => { if (this.mutations.get(id) === pending) this.mutations.delete(id); };
    void pending.then(clear, clear);
    return pending;
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
      rethrowAuthoritativeStateError(error);
    }
  }

  async saveUserIdToRedis(threadId: string, userId: string): Promise<void> {
    return this.serializeThread(threadId, () => this.persistUserId(threadId, userId));
  }
  private async persistUserId(threadId: string, userId: string): Promise<void> {
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
      rethrowAuthoritativeStateError(error);
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
      rethrowAuthoritativeStateError(error);
    }
  }

  /**
   * Create a new thread
   */
  async createThread(name: string, userId: string, agents: AgentPersona[] = []): Promise<Thread> {
    const thread: Thread = {
      id: uuidv4(),
      name,
      agents,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId,
    };

    // Create a new World instance for this thread
    const world = new World(this.apiUrl, this.model, thread.id, agents, userId);

    // Save to Redis
    await this.saveThreadToRedis(thread);
    this.threads.set(thread.id, thread);
    this.worlds.set(thread.id, world);

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
  async getOrCreateThread(input: {
    id: string;
    name?: string;
    userId: string;
    agents: IngestAgentInput[];
  }): Promise<World> {
    return this.serializeThread(input.id, () => this.upsertThread(input));
  }
  private async upsertThread(input: { id: string; name?: string; userId: string; agents: IngestAgentInput[] }): Promise<World> {
    let existing = this.threads.get(input.id);
    if (!existing && process.env.STATE_BACKEND === "ain-blockchain") {
      const persisted = await getRedisClient().get(`thread:${input.id}`);
      if (persisted) {
        existing = JSON.parse(persisted) as Thread;
        if (existing.id !== input.id) throw Error("Persisted thread identity mismatch");
        await getRedisClient().sAdd("threads:list", input.id);
        const restoredWorld = new World(this.apiUrl, this.model, existing.id, existing.agents, existing.userId);
        await restoredWorld.loadMessagesFromRedis(existing.id);
        this.threads.set(existing.id, existing);
        this.worlds.set(existing.id, restoredWorld);
      }
    }
    if (existing) {
      // Merge any newly-seen agents; keep the existing thread + World.
      await this.mergeAgents(existing, input.agents);
      await this.registerAgents(this.threads.get(input.id)!.agents);
      let world = this.worlds.get(input.id);
      if (!world) {
        // Defensive: thread present but World missing (never happens via the
        // normal create/load paths). Rebuild so ingest has somewhere to append.
        const current = this.threads.get(input.id)!;
        world = new World(this.apiUrl, this.model, current.id, current.agents, current.userId);
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

    const world = new World(this.apiUrl, this.model, thread.id, agents, thread.userId);

    await this.saveThreadToRedis(thread);
    await this.registerAgents(agents);
    this.threads.set(thread.id, thread);
    this.worlds.set(thread.id, world);

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
  private async registerAgents(agents: AgentPersona[]): Promise<void> {
    const registerable = agents
      .filter((a) => a.name && a.a2aUrl)
      .map((a) => ({ name: a.name, a2aUrl: a.a2aUrl }));
    if (registerable.length > 0) {
      await AgentService.getInstance().registerAgents(registerable);
    }
  }

  /**
   * Merge incoming agents into an existing thread, identity-consistent (F3).
   *
   * ainspace posts the user turn first (its roster may lack backendAgentId and
   * even a2aUrl) and agent turns later (carrying backendAgentId/a2aUrl from the
   * SSE stream), and the backend may suffix display names ("WarmHeart" →
   * "WarmHeart22"). So a matched later post BACKFILLS the earlier roster entry's
   * missing fields rather than being dropped or duplicated; an unmatched agent
   * is added as before. Backfill never overwrites an already-non-empty field.
   */
  private async mergeAgents(thread: Thread, incoming: IngestAgentInput[]): Promise<void> {
    thread = structuredClone(thread);
    const added: AgentPersona[] = [];
    let backfilled = false;
    for (const inc of incoming) {
      const match = this.findExistingAgent(thread, inc);
      if (match) {
        if (!match.a2aUrl && inc.a2aUrl) {
          match.a2aUrl = inc.a2aUrl;
          backfilled = true;
        }
        if (!match.backendAgentId && inc.backendAgentId) {
          match.backendAgentId = inc.backendAgentId;
          backfilled = true;
        }
        if (!match.role && inc.role) {
          match.role = inc.role;
          backfilled = true;
        }
        continue;
      }
      const persona = this.toPersona(inc);
      thread.agents.push(persona);
      added.push(persona);
    }

    if (added.length > 0 || backfilled) {
      thread.updatedAt = Date.now();
      await this.saveThreadToRedis(thread);
      // Re-register all: a backfilled a2aUrl can make a previously
      // unregisterable entry registerable. orchestrator:agents is a SET and
      // registerAgents filters by a2aUrl, so re-registering all is idempotent.
      await this.registerAgents(thread.agents);
      this.threads.set(thread.id, thread);
      this.worlds.get(thread.id)?.updateAgents(thread.agents);
      console.log(
        `[ThreadManager] Merged agents into thread ${thread.id} (added ${added.length}, backfilled=${backfilled})`
      );
    }
  }

  /**
   * Find the existing thread agent an incoming agent refers to, by key
   * preference: backendAgentId (both present) → a2aUrl (both present,
   * non-empty) → exact name. Stronger keys win so an id-bearing / name-suffixed
   * later post still resolves to the earlier user-turn roster entry.
   */
  private findExistingAgent(thread: Thread, inc: IngestAgentInput): AgentPersona | undefined {
    if (inc.backendAgentId) {
      const byId = thread.agents.find((ex) => ex.backendAgentId === inc.backendAgentId);
      if (byId) return byId;
    }
    if (inc.a2aUrl) {
      const byUrl = thread.agents.find((ex) => ex.a2aUrl === inc.a2aUrl);
      if (byUrl) return byUrl;
    }
    return thread.agents.find((ex) => ex.name === inc.name);
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
    return this.serializeThread(threadId, () => this.persistDeletion(threadId));
  }
  private async persistDeletion(threadId: string): Promise<boolean> {
    const deleted = this.threads.has(threadId);
    if (deleted) {

      // Delete from Redis
      try {
        const redis = getRedisClient();
        await redis.del(`thread:${threadId}`);
        await redis.del(`messages:${threadId}`);
        await redis.sRem("threads:list", threadId);
      } catch (error) {
        console.error(`[ThreadManager] Error deleting thread from Redis:`, error);
        rethrowAuthoritativeStateError(error);
      }
      this.threads.delete(threadId);
      this.worlds.delete(threadId);

      console.log(`[ThreadManager] Deleted thread: ${threadId}`);
    }
    return deleted;
  }

  /**
   * Add an agent to a thread
   */
  async addAgent(threadId: string, agent: AgentPersona): Promise<boolean> {
    return this.serializeThread(threadId, () => this.persistAddedAgent(threadId, agent));
  }
  private async persistAddedAgent(threadId: string, agent: AgentPersona): Promise<boolean> {
    const cached = this.threads.get(threadId);
    const thread = cached && structuredClone(cached);
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

    // Save to Redis
    await this.saveThreadToRedis(thread);
    this.threads.set(threadId, thread);
    this.worlds.get(threadId)?.updateAgents(thread.agents);

    console.log(`[ThreadManager] Added agent ${agent.name} to thread ${threadId}`);
    return true;
  }

  /**
   * Remove an agent from a thread
   */
  async removeAgent(threadId: string, agentId: string): Promise<boolean> {
    return this.serializeThread(threadId, () => this.persistRemovedAgent(threadId, agentId));
  }
  private async persistRemovedAgent(threadId: string, agentId: string): Promise<boolean> {
    const cached = this.threads.get(threadId);
    const thread = cached && structuredClone(cached);
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

    // Save to Redis
    await this.saveThreadToRedis(thread);
    this.threads.set(threadId, thread);
    this.worlds.get(threadId)?.updateAgents(thread.agents);

    console.log(`[ThreadManager] Removed agent ${agentId} from thread ${threadId}`);
    return true;
  }

  /**
   * Update thread name
   */
  async updateThreadName(threadId: string, name: string): Promise<boolean> {
    return this.serializeThread(threadId, () => this.persistThreadName(threadId, name));
  }
  private async persistThreadName(threadId: string, name: string): Promise<boolean> {
    const cached = this.threads.get(threadId);
    const thread = cached && structuredClone(cached);
    if (!thread) {
      return false;
    }

    thread.name = name;
    thread.updatedAt = Date.now();

    // Save to Redis
    await this.saveThreadToRedis(thread);
    this.threads.set(threadId, thread);

    return true;
  }
}

export default ThreadManager;
