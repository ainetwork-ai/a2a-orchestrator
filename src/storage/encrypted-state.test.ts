import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { EncryptedStateCodec, StateValue } from "./encrypted-state";

const secret = randomBytes(32);
const codec = new EncryptedStateCodec("uncommon-gallery", secret);
test("large Unicode conversation round trips without exposing text or original key", () => {
  const state: StateValue = { key: "messages:original-thread-id", type: "string", value: Array.from({ length: 12000 }, () => "기존 대화와 사용자 식별자🙂" + randomBytes(6).toString("hex")).join(""), expiresAt: null };
  const sealed = codec.seal(state);
  assert.ok(sealed.chunks.length > 1);
  assert.ok(sealed.chunks.every(chunk => chunk.length <= 4096));
  assert.ok(!JSON.stringify(sealed).includes(state.key));
  assert.deepEqual(codec.open(state.key, sealed.head, sealed.chunks), state);
  assert.notEqual(codec.seal(state).head.sha256, sealed.head.sha256);
});
test("set members and TTL remain exact", () => {
  const state: StateValue = { key: "threads:list", type: "set", value: ["a", "b", "한글"], expiresAt: 1800000000123 };
  const sealed = codec.seal(state);
  assert.deepEqual(codec.open(state.key, sealed.head, sealed.chunks), state);
});
test("wrong organization, secret, record key and revision fail authentication", () => {
  const state: StateValue = { key: "thread:id", type: "string", value: "private", expiresAt: null };
  const sealed = codec.seal(state);
  for (const other of [new EncryptedStateCodec("other-org", secret), new EncryptedStateCodec("uncommon-gallery", randomBytes(32))]) {
    assert.throws(() => other.open(state.key, sealed.head, sealed.chunks));
    assert.notEqual(other.recordId(state.key), sealed.recordId);
  }
  assert.throws(() => codec.open("thread:other", sealed.head, sealed.chunks));
  assert.throws(() => codec.open(state.key, { ...sealed.head, revision: "0".repeat(32) }, sealed.chunks));
});
test("corruption cannot be hidden by replacing the public digest", () => {
  const state: StateValue = { key: "report:job:id", type: "string", value: "private report", expiresAt: null };
  const sealed = codec.seal(state);
  const bytes = Buffer.from(sealed.chunks[0], "base64"); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => codec.open(state.key, { ...sealed.head, sha256: createHash("sha256").update(bytes).digest("hex") }, [bytes.toString("base64")]));
});
test("missing, reordered and mixed revision chunks are rejected", () => {
  // Incompressible, so the record spans several chunks.
  const state: StateValue = { key: "messages:id", type: "string", value: randomBytes(10000).toString("base64"), expiresAt: null };
  const sealed = codec.seal(state), other = codec.seal(state);
  assert.throws(() => codec.open(state.key, sealed.head, sealed.chunks.slice(1)));
  assert.throws(() => codec.open(state.key, sealed.head, [...sealed.chunks].reverse()));
  assert.throws(() => codec.open(state.key, sealed.head, [other.chunks[0], ...sealed.chunks.slice(1)]));
});
test("invalid key material, duplicate members and malformed expiry fail closed", () => {
  assert.throws(() => new EncryptedStateCodec("", secret));
  assert.throws(() => new EncryptedStateCodec("org", Buffer.alloc(16)));
  assert.throws(() => codec.seal({ key: "set", type: "set", value: ["a", "a"], expiresAt: null }));
  assert.throws(() => codec.seal({ key: "x", type: "string", value: "a", expiresAt: NaN }));
});
test("text is compressed before encryption and old uncompressed records still open", () => {
  const state: StateValue = { key: "messages:thread", type: "string", value: JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `질문 ${i}: 전시 작품에 대해 알려줘` }))), expiresAt: null };
  const current = codec.seal(state), legacy = codec.seal(state, 1);
  assert.equal(current.head.version, 2);
  assert.ok(current.chunks.join("").length * 4 < legacy.chunks.join("").length);
  assert.deepEqual(codec.open(state.key, current.head, current.chunks), state);
  assert.deepEqual(codec.open(state.key, legacy.head, legacy.chunks), state);
  // The version is authenticated: relabelling a record cannot change how it is decoded.
  assert.throws(() => codec.open(state.key, { ...legacy.head, version: 2 }, legacy.chunks));
  assert.throws(() => codec.open(state.key, { ...current.head, version: 1 }, current.chunks));
});
