import assert from "node:assert/strict";
import { test } from "node:test";
import { RESET_PATTERNS, RESET_SET_KEYS } from "./reset-report-policy";
test("reset removes conversation/report state and both index records while preserving embeddings", () => {
  const keys = ["thread:t", "threads:list", "messages:t", "orchestrator:agents", "report:job:j", "report:summary:j", "report:cache:c", "report:index:job_ids", "report:index:job_ids:v1_ready", "emb:msg:hash", "other:key"];
  const selected = keys.filter(key => RESET_SET_KEYS.some(item => item === key) || RESET_PATTERNS.some(pattern => key.startsWith(pattern.slice(0, -1))));
  assert.deepEqual(selected, keys.slice(0, 9));
});
