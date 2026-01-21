import { Message } from "../types";

/**
 * MessageDAG - Directed Acyclic Graph for managing message history
 *
 * Structure:
 * - All messages are stored in a Map indexed by ID
 * - Messages can have multiple children (responses)
 * - One path through the graph represents the "main history" (accepted messages)
 */
export class MessageDAG {
  private messages: Map<string, Message>;
  private rootMessageId: string | null = null;
  private latestAcceptedMessageId: string | null = null;

  constructor() {
    this.messages = new Map();
  }

  /**
   * Add a message to the DAG
   */
  addMessage(message: Message): void {
    this.messages.set(message.id, message);

    // Track root message (first user message)
    if (!this.rootMessageId && message.speaker === "User") {
      this.rootMessageId = message.id;
      this.latestAcceptedMessageId = message.id;
    }

    // Update latest accepted message
    if (message.status === "accepted") {
      this.latestAcceptedMessageId = message.id;
    }
  }

  /**
   * Get a message by ID
   */
  getMessage(id: string): Message | undefined {
    return this.messages.get(id);
  }

  /**
   * Get all messages
   */
  getAllMessages(): Message[] {
    return Array.from(this.messages.values());
  }

  /**
   * Get the main history (path of accepted messages)
   */
  getMainHistory(): Message[] {
    const mainHistory: Message[] = [];

    if (!this.rootMessageId) {
      return mainHistory;
    }

    let currentId: string | null = this.rootMessageId;

    while (currentId) {
      const message = this.messages.get(currentId);
      if (!message) break;

      mainHistory.push(message);

      // Find the next accepted message that replies to this one
      const children = this.getChildren(currentId);
      const nextAccepted = children.find(child => child.status === "accepted");

      currentId = nextAccepted?.id || null;
    }

    return mainHistory;
  }

  /**
   * Get all child messages (responses) to a given message
   */
  getChildren(messageId: string): Message[] {
    return Array.from(this.messages.values()).filter(
      msg => msg.replyTo === messageId
    );
  }

  /**
   * Get the latest accepted message ID
   */
  getLatestAcceptedMessageId(): string | null {
    return this.latestAcceptedMessageId;
  }

  /**
   * Get the current block context based on main history
   */
  getMainHistoryContext(): Message[] {
    return this.getMainHistory();
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.messages.clear();
    this.rootMessageId = null;
    this.latestAcceptedMessageId = null;
  }

  /**
   * Get statistics about the DAG
   */
  getStats() {
    return {
      totalMessages: this.messages.size,
      mainHistoryLength: this.getMainHistory().length,
      rootMessageId: this.rootMessageId,
      latestAcceptedMessageId: this.latestAcceptedMessageId,
    };
  }
}
