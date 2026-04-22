// Sticky-routing headers — must match nginx `$http_x_thread_id` / `$http_x_agent_id`
export const HEADER_THREAD_ID = "X-Thread-Id";
export const HEADER_AGENT_ID = "X-Agent-Id";

// Keep only visible ASCII + space (0x20-0x7E), per RFC 7230 header value rules.
// Strips CR/LF (injection), NUL (parser truncate), TAB (value folding), and
// non-ASCII chars (persona.name may be Korean/emoji — rejected by some proxies).
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "");
}
