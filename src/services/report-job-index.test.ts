import { test } from "node:test";
import assert from "node:assert/strict";
import { ReportJobIndex } from "./report-job-index";
import type { StateClient } from "../storage/state-client";
function setup() {
  const strings = new Map<string, string>(), sets = new Map<string, Set<string>>();
  let scans = 0, fail = false;
  const store = {
    get: async (key: string) => strings.get(key) ?? null,
    set: async (key: string, value: string) => { strings.set(key, value); return "OK"; },
    keys: async (pattern: string) => { scans++; if (fail) throw Error("Authoritative scan failed"); return [...strings.keys()].filter(key => key.startsWith(pattern.slice(0, -1))); },
    sAdd: async (key: string, values: string | string[]) => { const members = sets.get(key) ?? new Set<string>(); let count = 0; for (const value of typeof values === "string" ? [values] : values) if (!members.has(value)) { members.add(value); count++; } sets.set(key, members); return count; },
    sMembers: async (key: string) => [...sets.get(key) ?? []],
    sRem: async (key: string, value: string) => sets.get(key)?.delete(value) ? 1 : 0,
  } as unknown as StateClient;
  return { store, strings, scans: () => scans, setFail: (value: boolean) => { fail = value; } };
}
test("all legacy reports are indexed once and other state is excluded", async () => {
  const fixture = setup();
  fixture.strings.set("thread:private", "data"); fixture.strings.set("report:job:old-a", "a"); fixture.strings.set("report:job:old-b", "b");
  const index = new ReportJobIndex(fixture.store);
  assert.deepEqual((await index.keys()).sort(), ["report:job:old-a", "report:job:old-b"]);
  assert.deepEqual((await index.keys()).sort(), ["report:job:old-a", "report:job:old-b"]);
  assert.equal(fixture.scans(), 1);
  const restarted = new ReportJobIndex(fixture.store);
  assert.equal((await restarted.keys()).length, 2); assert.equal(fixture.scans(), 1);
});
test("concurrent first list requests share one bootstrap and later additions survive", async () => {
  const fixture = setup(); fixture.strings.set("report:job:old", "data");
  const index = new ReportJobIndex(fixture.store);
  const listing = Promise.all([index.keys(), index.keys()]);
  await index.add("new"); await listing;
  assert.deepEqual((await index.keys()).sort(), ["report:job:new", "report:job:old"]);
  assert.equal(fixture.scans(), 1);
  await index.remove("old"); assert.deepEqual(await index.keys(), ["report:job:new"]);
});
test("a failed authoritative bootstrap is surfaced and retried without publishing readiness", async () => {
  const fixture = setup(); fixture.strings.set("report:job:old", "data"); fixture.setFail(true);
  const index = new ReportJobIndex(fixture.store);
  await assert.rejects(index.keys(), /Authoritative scan failed/);
  fixture.setFail(false); assert.deepEqual(await index.keys(), ["report:job:old"]); assert.equal(fixture.scans(), 2);
});
