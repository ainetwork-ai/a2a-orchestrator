export const RESET_PATTERNS = [
  "thread:*", "messages:*", "report:job:*", "report:cache:*", "report:index:*",
] as const;
export const RESET_SET_KEYS = ["threads:list", "orchestrator:agents"] as const;
export const PRESERVE_PATTERN = "emb:msg:*";
