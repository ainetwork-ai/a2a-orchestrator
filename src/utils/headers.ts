// Sticky-routing headers — must match nginx `$http_x_thread_id` / `$http_x_agent_id`
export const HEADER_THREAD_ID = "X-Thread-Id";
export const HEADER_AGENT_ID = "X-Agent-Id";

// Strip control characters that can exploit HTTP header parsing:
// - CR/LF: header injection (split headers)
// - NUL: some parsers truncate on null byte
// - TAB: header value folding per RFC 7230
// threadId/agentId are internally generated, but defensive sanitization is cheap.
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0\t]/g, "");
}
