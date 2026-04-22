// Sticky-routing headers — must match nginx `$http_x_thread_id` / `$http_x_agent_id`
export const HEADER_THREAD_ID = "X-Thread-Id";
export const HEADER_AGENT_ID = "X-Agent-Id";

// Strip CR/LF to prevent HTTP header injection. threadId/agentId are internally generated,
// but defensive sanitization is cheap and guards against future sources (user input, etc).
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}
