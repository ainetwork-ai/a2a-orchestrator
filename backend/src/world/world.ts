import { Agent } from "./agents";
import { Message, AgentPersona } from "../types";
import https from "https";
import RequestManager from "./requestManager";
import { MessageDAG } from "./messageDAG";
import { Verifier } from "./verifier";
import { getRedisClient } from "../utils/redis";

// Create a custom agent that allows self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export class World {
  private agents: Agent[];
  private messageDAG: MessageDAG;
  private verifier: Verifier;
  private apiUrl: string;
  private model: string;
  private threadId: string;
  private messageIdCounter: number;
  private onMessageCallbacks: Map<string, (message: Message) => void> = new Map();
  private onBlockCallbacks: Map<string, (block: { summary: string; next: { id: string; name: string }; stop_reason?: string; user_intent?: string }) => void> = new Map();
  private currentBlock: string = "";
  private nextSpeaker: { id: string; name: string } = { id: "user", name: "User" };
  private firstResponseReceived: Map<string, boolean> = new Map(); // Track first response per user message
  private initialUserMessage: string = ""; // Initial user message for current conversation
  private shouldStopConversation: boolean = false; // Flag to stop conversation
  private stopReason: string = "";
  private userIntent: string = "";
  private currentConversationMessageCount: number = 0; // Count messages since last user message

  constructor(apiUrl: string, model: string, threadId: string, agentPersonas?: AgentPersona[]) {
    this.apiUrl = apiUrl;
    this.model = model;
    this.threadId = threadId;
    // Use provided personas or default to empty array
    const personas = agentPersonas && agentPersonas.length > 0 ? agentPersonas : [];
    this.agents = personas.map((persona: AgentPersona) => new Agent(persona));
    this.messageDAG = new MessageDAG();
    this.verifier = new Verifier(apiUrl, model);
    this.messageIdCounter = 0;
  }

  /**
   * Update agents dynamically
   */
  updateAgents(agentPersonas: AgentPersona[]) {
    this.agents = agentPersonas.map(persona => new Agent(persona));
    console.log(`[World] Updated agents. Total: ${this.agents.length}`);
  }

  addMessageCallback(id: string, callback: (message: Message) => void) {
    this.onMessageCallbacks.set(id, callback);
  }

  removeMessageCallback(id: string) {
    this.onMessageCallbacks.delete(id);
  }

  addBlockCallback(id: string, callback: (block: { summary: string; next: { id: string; name: string }; stop_reason?: string; user_intent?: string }) => void) {
    this.onBlockCallbacks.set(id, callback);
  }

  removeBlockCallback(id: string) {
    this.onBlockCallbacks.delete(id);
  }

  private notifyMessage(message: Message) {
    this.onMessageCallbacks.forEach(callback => {
      try {
        callback(message);
      } catch (error) {
        console.error("Error in message callback:", error);
      }
    });
  }

  private notifyBlock(block: { summary: string; next: { id: string; name: string }; stop_reason?: string; user_intent?: string }) {
    this.onBlockCallbacks.forEach(callback => {
      try {
        callback(block);
      } catch (error) {
        console.error("Error in block callback:", error);
      }
    });
  }

  getCurrentBlock(): string {
    return this.currentBlock;
  }

  getNextSpeaker(): { id: string; name: string } {
    return this.nextSpeaker;
  }

  private generateMessageId(): string {
    return `msg_${++this.messageIdCounter}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Randomly select N agents from the available agents
   */
  private selectRandomAgents(count: number): Agent[] {
    if (count >= this.agents.length) {
      // If requesting more than available, return all agents
      return [...this.agents];
    }

    // Shuffle array and take first N elements
    const shuffled = [...this.agents].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  /**
   * Select relevant agents based on user message content using LLM
   * Returns array of agent names that are mentioned or related to the message
   */
  private async selectRelevantAgents(userMessage: Message): Promise<Agent[]> {
    // Build agent information for prompt
    const agentInfo = this.agents.map(agent => {
      const persona = agent.getPersona();
      return `- ID: ${persona.name}, Name: ${persona.name}, Role: ${persona.role}`;
    }).join('\n');

    const agentsList = this.agents.map(agent => agent.getName()).join(", ");

    const prompt = `Analyze the following user message and select agents that are relevant to respond.

User Message:
${userMessage.content}

Available Agents:
${agentInfo}

Selection Criteria:
1. Agents whose names are explicitly mentioned in the message (e.g., @AgentName or "AgentName")
2. Agents whose roles are relevant to the topic or content of the message

Instructions:
- Return a list of agent IDs that match the criteria
- If NO agents are relevant (message is too general or doesn't match any agent's role), return an empty array
- Do not force a selection if there's no clear relevance

Respond in JSON format only:
{
  "agents": ["agent_id1", "agent_id2"],
  "reason": "Explanation of why these agents were selected"
}`;

    try {
      console.log(`\n[Agent Selection] Requesting LLM to select relevant agents...`);
      console.log(`[Agent Selection] User message: ${userMessage.content.substring(0, 100)}...`);

      const requestManager = RequestManager.getInstance();
      const response = await requestManager.request(
        this.apiUrl,
        this.model,
        [{ role: "user", content: prompt }],
        400,
        0.3
      );

      // Parse JSON response - remove markdown code blocks if present
      let jsonStr = response.trim();
      if (jsonStr.startsWith("```json")) {
        jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
      } else if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/```\s*/g, "");
      }

      const parsed = JSON.parse(jsonStr);
      const selectedAgentIds = parsed.agents || [];
      const reason = parsed.reason || "No reason provided";

      console.log(`[Agent Selection] LLM response: ${selectedAgentIds.length} agents selected`);
      console.log(`[Agent Selection] Reason: ${reason}`);

      // Convert agent IDs to Agent objects
      const selectedAgents = this.agents.filter(agent =>
        selectedAgentIds.includes(agent.getName())
      );

      console.log(`[Agent Selection] Matched agents: ${selectedAgents.map(a => a.getName()).join(', ')}`);

      return selectedAgents;
    } catch (error) {
      console.error("[Agent Selection] Error selecting relevant agents:", error);
      // On error, return empty array to trigger random selection fallback
      return [];
    }
  }

  /**
   * Summarize the current block with new accepted message and recommend next speaker
   */
  private async summarizeBlock(newMessage: Message): Promise<{
    summary: string;
    next: { id: string; name: string };
    recommendation_reason: string;
  }> {
    // Build agent information for prompt
    const agentInfo = this.agents.map(agent => {
      const persona = agent.getPersona();
      return `- ID: ${persona.name}, Name: ${persona.name}, Role: ${persona.role}`;
    }).join('\n');

    const availableSpeakers = [
      ...this.agents.map(agent => {
        const persona = agent.getPersona();
        return { id: persona.name, name: persona.name };
      }),
      { id: "user", name: "User" }
    ];

    const agentsList = availableSpeakers.map(s => s.name).join(", ");

    // Use stored initial user message
    const userMessageContent = this.initialUserMessage || "(none)";

    const prompt = `Here is the previous block summary and the new message.

Previous Block:
${this.currentBlock || "(none)"}

Initial User Message:
${userMessageContent}

Recent Message:
${newMessage.speaker}: ${newMessage.content}

Available Agents:
${agentInfo}
- ID: user, Name: User, Role: User

Please perform the following tasks:
1. Summarize the previous block and new message in 500 characters or less
2. Recommend the most suitable speaker to respond next based on the conversation context (choose from: ${agentsList})
3. Do not recommend the person who wrote the most recent message

Respond in JSON format only:
{
  "summary": "Summary within 500 characters",
  "next": {
    "id": "agent_id",
    "name": "agent_name"
  },
  "recommendation_reason": "Explanation of recommendation"
}`;

    try {
      console.log(`\n[Block] Requesting summary...`);
      console.log(`[Block] Full prompt:\n${prompt}\n`);

      const requestManager = RequestManager.getInstance();
      const response = await requestManager.request(
        this.apiUrl,
        this.model,
        [{ role: "user", content: prompt }],
        600,
        0.3
      );

      // Parse JSON response - remove markdown code blocks if present
      let jsonStr = response.trim();
      if (jsonStr.startsWith("```json")) {
        jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
      } else if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/```\s*/g, "");
      }

      const parsed = JSON.parse(jsonStr);

      // Validate next speaker
      let validSpeaker = availableSpeakers.find(s =>
        s.id === parsed.next?.id || s.name === parsed.next?.name
      );

      return {
        summary: parsed.summary || response.substring(0, 500),
        next: validSpeaker || { id: "user", name: "User" },
        recommendation_reason: parsed.recommendation_reason || ""
      };
    } catch (error) {
      console.error("Error summarizing block:", error);
      // On error, just append the new message
      return {
        summary: `${this.currentBlock}\n\n${newMessage.speaker}: ${newMessage.content}`.substring(0, 500),
        next: { id: "user", name: "User" },
        recommendation_reason: ""
      };
    }
  }

  /**
   * Add user message to the thread (without processing agents)
   */
  async addUserMessage(content: string) {
    // Set new initial user message and reset flags
    this.initialUserMessage = content;
    this.verifier.reset();
    this.shouldStopConversation = false;
    this.stopReason = "";
    this.userIntent = "";
    this.firstResponseReceived.clear();
    this.currentConversationMessageCount = 0; // Reset message count for new conversation

    const message: Message = {
      id: this.generateMessageId(),
      speaker: "User",
      content,
      timestamp: Date.now(),
    };
    this.messageDAG.addMessage(message);

    // Save to Redis
    this.saveMessagesToRedis(this.threadId);

    return message.id;
  }

  /**
   * Broadcast user message to randomly selected agents (parallel responses)
   * Randomly selects 1-4 agents from the available agents
   */
  async broadcastToAgents(userMessage: Message) {
    const numAgentsToSelect = Math.floor(Math.random() * 4) + 1; // Random number between 1 and 4
    const selectedAgents = this.selectRandomAgents(numAgentsToSelect);

    console.log(`\n[BROADCAST] Broadcasting to ${selectedAgents.length} randomly selected agents (out of ${this.agents.length})...`);
    console.log(`[BROADCAST] Selected agents: ${selectedAgents.map((a) => a.getName()).join(', ')}`);

    // Request responses from selected agents in parallel
    const responsePromises = selectedAgents.map(agent =>
      this.processSpecificAgent(userMessage.content, agent.getName())
        .catch(error => {
          console.error(`[BROADCAST] Error from ${agent.getName()}:`, error);
        })
    );

    // Wait for all agents to respond
    await Promise.all(responsePromises);

    // Find the first (accepted) response
    const allMessages = this.messageDAG.getAllMessages();
    const acceptedMessage = allMessages.find(m =>
      m.replyTo === userMessage.id && m.status === "accepted"
    );

    if (acceptedMessage) {
      console.log(`[BROADCAST] First response from ${acceptedMessage.speaker} accepted`);

      // Increment message count (accepted message counts)
      this.currentConversationMessageCount++;

      // Generate block for accepted message and get next speaker recommendation
      const blockResult = await this.summarizeBlock(acceptedMessage);
      this.currentBlock = blockResult.summary;

      // Update next speaker only if verifier didn’t stop the conversation
      if (!this.shouldStopConversation) {
        this.nextSpeaker = blockResult.next;
      } else {
        console.log(`[BROADCAST] Keeping next speaker as user due to stop flag`);
      }

      // Notify with actual next speaker
      this.notifyBlock({
        summary: blockResult.summary,
        next: this.nextSpeaker,
        stop_reason: this.stopReason,
        user_intent: this.userIntent,
      });

      console.log(`[BLOCK UPDATED] ${this.currentBlock.substring(0, 100)}...`);
      console.log(`[NEXT SPEAKER RECOMMENDED] ${this.nextSpeaker.name} (${this.nextSpeaker.id})`);

      // Start verification in background (non-blocking)
      this.verifier.verify(
          this.initialUserMessage,
          this.currentBlock,
          acceptedMessage.content,
          acceptedMessage.speaker,
          this.currentConversationMessageCount
      ).then(verification => {
          this.userIntent = verification.user_intent;
          if (verification.should_stop) {
            this.shouldStopConversation = true;
            this.stopReason = verification.stop_reason;
          this.nextSpeaker = { id: "user", name: "User" };
            console.log(`[Verifier] STOP flag set: ${this.stopReason}`);

            // Notify UI about the stop
            this.notifyBlock({
              summary: this.currentBlock,
              next: this.nextSpeaker,
              stop_reason: this.stopReason,
              user_intent: this.userIntent,
            });
          }
      }).catch(error => {
        console.error("Error in verification:", error);
        });

      // Save to Redis
      this.saveMessagesToRedis(this.threadId);

      return acceptedMessage;
    }

    return null;
  }

  /**
   * Process sequential agent responses based on next speaker recommendation
   * No broadcast - only the recommended agent responds
   */
  async processAgentResponsesQueue(initialMessage: Message) {
    console.log(`\n[AUTO] Starting sequential conversation from ${initialMessage.speaker}`);

    let lastMessage = initialMessage;
    const maxRounds = 10;

    for (let round = 0; round < maxRounds; round++) {
      // Check if verifier flagged to stop
      if (this.shouldStopConversation) {
        console.log(`[AUTO] Stopping due to verifier: ${this.stopReason}`);
        break;
      }

      // Check if next speaker is user or same as last speaker
      if (this.nextSpeaker.id === "user" || this.nextSpeaker.name === lastMessage.speaker) {
        console.log(`[AUTO] Stopping (next: ${this.nextSpeaker.name}, last: ${lastMessage.speaker})`);
        break;
      }

      // Find the recommended agent
      const nextAgent = this.agents.find(a => a.getName() === this.nextSpeaker.name);
      if (!nextAgent) {
        console.log(`[AUTO] Agent ${this.nextSpeaker.name} not found`);
        break;
      }

      console.log(`[AUTO] Round ${round + 1}/${maxRounds}: ${this.nextSpeaker.name} responding...`);

      // Check again before agent responds
      if (this.shouldStopConversation) {
        console.log(`[AUTO] Stop flag detected before agent response, ending conversation`);
        break;
      }

      try {
        const mainHistory = this.messageDAG.getMainHistory();
        const content = await nextAgent.respond(mainHistory, lastMessage, this.currentBlock);
        const timestamp = Date.now();

        const agentMessage: Message = {
          id: this.generateMessageId(),
          speaker: nextAgent.getName(),
          content: content,
          timestamp: timestamp,
          replyTo: lastMessage.id,
          status: "accepted",
        };

        this.messageDAG.addMessage(agentMessage);
        this.notifyMessage(agentMessage);

        // Increment message count
        this.currentConversationMessageCount++;

        // Generate block and get next speaker recommendation
        const blockResult = await this.summarizeBlock(agentMessage);
        this.currentBlock = blockResult.summary;

        // Update next speaker only if verifier didn’t stop the conversation
        if (!this.shouldStopConversation) {
          this.nextSpeaker = blockResult.next;
        } else {
          console.log(`[AUTO] Keeping next speaker as user due to stop flag`);
        }

        // Notify with actual next speaker
        this.notifyBlock({
          summary: blockResult.summary,
          next: this.nextSpeaker,
          stop_reason: this.stopReason,
          user_intent: this.userIntent,
        });

        console.log(`[AUTO] ${nextAgent.getName()} responded. Next: ${this.nextSpeaker.name}`);

        // Save to Redis
        this.saveMessagesToRedis(this.threadId);

        // Run verification in background (non-blocking)
        this.verifier.verify(
            this.initialUserMessage,
            this.currentBlock,
            agentMessage.content,
            agentMessage.speaker,
            this.currentConversationMessageCount
        ).then(verification => {
            this.userIntent = verification.user_intent;
            if (verification.should_stop) {
              this.shouldStopConversation = true;
              this.stopReason = verification.stop_reason;
              this.nextSpeaker = { id: "user", name: "User" };
              console.log(`[Verifier] STOP flag set: ${this.stopReason}`);

              // Notify UI about the stop
              this.notifyBlock({
                summary: this.currentBlock,
                next: this.nextSpeaker,
                stop_reason: this.stopReason,
                user_intent: this.userIntent,
              });
            }
        }).catch(error => {
          console.error("Error in verification:", error);
          });

        // Update for next iteration
        lastMessage = agentMessage;
      } catch (error) {
        console.error(`[AUTO] Error in round ${round + 1}:`, error);
        break;
      }
    }

    console.log(`[AUTO] Conversation ended`);
  }

  getHistory(): Message[] {
    return this.messageDAG.getAllMessages();
  }

  getMainHistory(): Message[] {
    return this.messageDAG.getMainHistory();
  }

  getAgents(): Agent[] {
    return this.agents;
  }

  clearHistory(): void {
    this.messageDAG.clear();
    this.messageIdCounter = 0;
    this.currentBlock = "";
    this.nextSpeaker = { id: "user", name: "User" };
    this.firstResponseReceived.clear();
    this.initialUserMessage = "";
    this.shouldStopConversation = false;
    this.stopReason = "";
    this.userIntent = "";
    this.currentConversationMessageCount = 0;

    // Save cleared state to Redis
    this.saveMessagesToRedis(this.threadId);
  }

  /**
   * Process a specific agent's response to a message
   */
  async processSpecificAgent(messageContent: string, agentName: string) {
    // Find the message by content (assume it's already added)
    const allMessages = this.messageDAG.getAllMessages();
    const userMessage = allMessages.filter(m => m.speaker === "User" && m.content === messageContent).pop();

    if (!userMessage) {
      console.error(`User message not found: ${messageContent}`);
      return;
    }

    // Find the specified agent
    const agent = this.agents.find(a => a.getName() === agentName);
    if (!agent) {
      console.error(`Agent not found: ${agentName}`);
      return;
    }

    try {
      const mainHistory = this.messageDAG.getMainHistory();
      const content = await agent.respond(mainHistory, userMessage, this.currentBlock);
      const timestamp = Date.now();

      // Check if this is the first response for this user message
      const isFirst = !this.firstResponseReceived.get(userMessage.id);
      if (isFirst) {
        this.firstResponseReceived.set(userMessage.id, true);
      }

      console.log(`${agent.getName()} ${isFirst ? '[FIRST]' : '[OTHER]'}: "${content.substring(0, 50)}..."`);

      const message: Message = {
        id: this.generateMessageId(),
        speaker: agent.getName(),
        content: content,
        timestamp: timestamp,
        replyTo: userMessage.id,
        status: isFirst ? "accepted" : "dropped",
      };

      this.messageDAG.addMessage(message);

      // Send to UI immediately (don't wait for block generation)
      this.notifyMessage(message);
    } catch (error) {
      console.error(`Error getting response from ${agent.getName()}:`, error);
      throw error;
    }
  }

  /**
   * Generate block summary for a message
   */
  async generateBlockForMessage(messageId: string) {
    const message = this.messageDAG.getMessage(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const blockResult = await this.summarizeBlock(message);
    this.currentBlock = blockResult.summary;
    this.nextSpeaker = blockResult.next;
    console.log(`[BLOCK UPDATED] ${this.currentBlock.substring(0, 100)}...`);
    console.log(`[NEXT SPEAKER RECOMMENDED] ${blockResult.next.name} (${blockResult.next.id})`);

    return blockResult;
  }

  /**
   * Save messages to Redis
   */
  async saveMessagesToRedis(threadId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      const messages = this.messageDAG.getAllMessages();
      const data = {
        messages,
        currentBlock: this.currentBlock,
        nextSpeaker: this.nextSpeaker,
        messageIdCounter: this.messageIdCounter,
        initialUserMessage: this.initialUserMessage,
        currentConversationMessageCount: this.currentConversationMessageCount,
      };
      await redis.set(`messages:${threadId}`, JSON.stringify(data));
    } catch (error) {
      console.error(`[World] Error saving messages to Redis:`, error);
    }
  }

  /**
   * Load messages from Redis
   */
  async loadMessagesFromRedis(threadId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      const data = await redis.get(`messages:${threadId}`);

      if (data) {
        const parsed = JSON.parse(data);

        // Restore messages
        this.messageDAG.clear();
        if (parsed.messages && Array.isArray(parsed.messages)) {
          for (const msg of parsed.messages) {
            this.messageDAG.addMessage(msg);
          }
        }

        // Restore state
        this.currentBlock = parsed.currentBlock || "";
        this.nextSpeaker = parsed.nextSpeaker || { id: "user", name: "User" };
        this.messageIdCounter = parsed.messageIdCounter || 0;
        this.initialUserMessage = parsed.initialUserMessage || "";
        this.currentConversationMessageCount = parsed.currentConversationMessageCount || 0;

        console.log(`[World] Loaded ${parsed.messages?.length || 0} messages for thread ${threadId}`);
      }
    } catch (error) {
      console.error(`[World] Error loading messages from Redis:`, error);
    }
  }
}
