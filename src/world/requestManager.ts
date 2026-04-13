import https from "https";

// Create a custom agent that allows self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

interface QueuedRequest {
  apiUrl: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

class RequestManager {
  private static instance: RequestManager;
  private queue: QueuedRequest[] = [];
  private activeRequests: number = 0;
  private readonly MAX_CONCURRENT_REQUESTS = 4;

  private constructor() {}

  static getInstance(): RequestManager {
    if (!RequestManager.instance) {
      RequestManager.instance = new RequestManager();
    }
    return RequestManager.instance;
  }

  /**
   * Request LLM API with queue management
   */
  async request(
    apiUrl: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens: number = 1500,
    temperature: number = 0.7
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        apiUrl,
        model,
        messages,
        maxTokens,
        temperature,
        resolve,
        reject,
      });

      console.log(
        `[RequestManager] Queued request. Queue: ${this.queue.length}, Active: ${this.activeRequests}`
      );

      this.processQueue();
    });
  }

  private async processQueue() {
    // If we're at max capacity or queue is empty, don't process
    if (
      this.activeRequests >= this.MAX_CONCURRENT_REQUESTS ||
      this.queue.length === 0
    ) {
      return;
    }

    const request = this.queue.shift();
    if (!request) return;

    this.activeRequests++;
    console.log(
      `[RequestManager] Processing request. Queue: ${this.queue.length}, Active: ${this.activeRequests}`
    );

    try {
      const result = await this.executeRequest(request);
      request.resolve(result);
    } catch (error) {
      request.reject(error as Error);
    } finally {
      this.activeRequests--;
      console.log(
        `[RequestManager] Request completed. Queue: ${this.queue.length}, Active: ${this.activeRequests}`
      );
      // Process next request in queue
      this.processQueue();
    }
  }

  private async executeRequest(request: QueuedRequest): Promise<string> {
    const { apiUrl, model, messages, maxTokens, temperature } = request;

    const requestBody = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      // @ts-ignore - agent option for self-signed certificates
      agent: apiUrl.startsWith("https") ? httpsAgent : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `API request failed: ${response.status} ${response.statusText} - ${errorBody}`
      );
    }

    const data = await response.json() as any;
    const text =
      data.choices?.[0]?.message?.content || data.choices?.[0]?.text || "";

    if (!text) {
      throw new Error("No text in API response");
    }

    return text.trim();
  }

  /**
   * Get current queue status
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      maxConcurrent: this.MAX_CONCURRENT_REQUESTS,
    };
  }
}

export default RequestManager;
