import test from "node:test";
import assert from "node:assert/strict";
import { mapConcurrent } from "./concurrent-map";
test("bounded startup reads preserve order despite asynchronous completion", async () => {
  let active = 0, peak = 0;
  const values = Array.from({ length: 32 }, (_, i) => i);
  const result = await mapConcurrent(values, 8, async value => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, (value % 4) + 1));
    active--; return value * 2;
  });
  assert.equal(peak, 8); assert.equal(active, 0);
  assert.deepEqual(result, values.map(value => value * 2));
});
test("failure stops new reads, waits for in-flight reads, and cannot become partial success", async () => {
  const calls: number[] = []; let completed = false;
  const failure = new Error("authoritative read rejected");
  await assert.rejects(mapConcurrent([0, 1, 2, 3], 2, async value => {
    calls.push(value); if (value === 0) throw failure;
    await new Promise(resolve => setTimeout(resolve, 5)); completed = true; return value;
  }), error => error === failure);
  assert.deepEqual(calls, [0, 1]); assert.equal(completed, true);
});
test("empty input and absent records preserve their meaning", async () => {
  assert.deepEqual(await mapConcurrent([], 8, async value => value), []);
  assert.deepEqual(await mapConcurrent([0, 1], 8, async value => value ? { id: value } : null), [null, { id: 1 }]);
});
