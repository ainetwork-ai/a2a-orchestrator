import { World } from "./world";
import { Thread, AgentPersona } from "../types";
import { v4 as uuidv4 } from "uuid";
import { getRedisClient } from "../utils/redis";

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
