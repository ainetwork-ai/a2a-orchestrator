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

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function isRetryableError(error: unknown): boolean {
  // HTTP 429 (rate limit) or 5xx (server error)
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  // Network-level errors (socket closed, connection reset, etc.)
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("socket") || msg.includes("fetch failed") || msg.includes("econnreset") || msg.includes("etimedout");
  }
  return false;
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
      const result = await this.executeWithRetry(request);
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

  private async executeWithRetry(request: QueuedRequest): Promise<string> {
    let lastError: Error = new Error("executeWithRetry: no attempts made");

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.executeRequest(request);
      } catch (error) {
        lastError = error as Error;

        if (attempt < MAX_RETRIES && isRetryableError(error)) {
          const jitter = 0.5 + Math.random() * 0.5;
          const delay = Math.round(RETRY_BASE_DELAY_MS * Math.pow(2, attempt) * jitter);
          console.warn(
            `[RequestManager] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms: ${lastError.message}`
          );
          await new Promise((r) => setTimeout(r, delay));
        } else {
          break;
        }
      }
    }

    throw lastError;
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
      throw new HttpError(
        response.status,
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
