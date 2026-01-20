import { getRedisClient } from "../utils/redis";

const AGENTS_KEY = "orchestrator:agents";

export interface RegisteredAgent {
  name: string;
  a2aUrl: string;
}

class AgentService {
  private static instance: AgentService;

  private constructor() {}

  static getInstance(): AgentService {
    if (!AgentService.instance) {
      AgentService.instance = new AgentService();
    }
    return AgentService.instance;
  }

  /**
   * Register an agent to Redis Set
   */
  async registerAgent(agent: RegisteredAgent): Promise<void> {
    try {
      const redis = getRedisClient();
      const value = JSON.stringify(agent);
      await redis.sAdd(AGENTS_KEY, value);
    } catch (error) {
      console.error("[AgentService] Error registering agent:", error);
    }
  }

  /**
   * Register multiple agents at once
   */
  async registerAgents(agents: RegisteredAgent[]): Promise<void> {
    if (agents.length === 0) return;

    try {
      const redis = getRedisClient();
      const values = agents.map((a) => JSON.stringify(a));
      await redis.sAdd(AGENTS_KEY, values);
    } catch (error) {
      console.error("[AgentService] Error registering agents:", error);
    }
  }

  /**
   * Get all registered agents
   */
  async getAllAgents(): Promise<RegisteredAgent[]> {
    try {
      const redis = getRedisClient();
      const members = await redis.sMembers(AGENTS_KEY);

      return members.map((m) => JSON.parse(m) as RegisteredAgent);
    } catch (error) {
      console.error("[AgentService] Error getting agents:", error);
      return [];
    }
  }

  /**
   * Check if agent exists
   */
  async hasAgent(a2aUrl: string): Promise<boolean> {
    try {
      const agents = await this.getAllAgents();
      return agents.some((a) => a.a2aUrl === a2aUrl);
    } catch (error) {
      console.error("[AgentService] Error checking agent:", error);
      return false;
    }
  }

  /**
   * Remove an agent
   */
  async removeAgent(agent: RegisteredAgent): Promise<void> {
    try {
      const redis = getRedisClient();
      const value = JSON.stringify(agent);
      await redis.sRem(AGENTS_KEY, value);
    } catch (error) {
      console.error("[AgentService] Error removing agent:", error);
    }
  }
}

export default AgentService;
