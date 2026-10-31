import { AinWriteRejected, ChainOperation, StateChainTransport } from "./ain-transport";

/** In-memory AIN chain for state tests: head CAS like the native rule, failure switches, rule store. */
export class TestChain implements StateChainTransport {
  values = new Map<string, unknown>();
  rejectChunks = false;
  unconfirmed = false;
  rejectHeadId: string | null = null;
  legacyChunkRule = false;
  rules = new Map<string, unknown>();
  /** Address that signs, for rule checks in cleanup tests. */
  address = "0x" + "a".repeat(40);
  writes = 0;
  /** Optional hook to reject a write (e.g. a budget refusal). */
  rejectWrite: ((operations: ChainOperation[]) => boolean) | null = null;
  async getRule(ref: string): Promise<unknown> { return this.rules.get(ref) ?? null; }
  async childLabels(ref: string): Promise<string[]> {
    return [...new Set([...this.values.keys()].filter(key => key.startsWith(ref + "/")).map(key => key.slice(ref.length + 1).split("/")[0]))];
  }
  async get<T>(ref: string): Promise<T | null> {
    if (ref.endsWith("/heads")) return Object.fromEntries([...this.values].filter(([key]) => key.startsWith(ref + "/")).map(([key, value]) => [key.slice(ref.length + 1), value])) as T;
    return this.values.has(ref) ? structuredClone(this.values.get(ref)) as T : null;
  }
  async write(operations: ChainOperation[]): Promise<void> {
    this.writes++;
    if (this.rejectWrite?.(operations)) throw new AinWriteRejected("Write rejected");
    const draft = new Map(this.values);
    for (const op of operations) {
      if (op.type === "SET_RULE") { this.rules.set(op.ref, (op.value as { ".rule"?: { write: unknown } } | null)?.[".rule"]?.write ?? null); continue; }
      const rule = this.rules.get(op.ref.replace(/\/heads\/[^/]+$/, "/heads/$recordId").replace(/\/chunks\/[^/]+\/[^/]+\/[^/]+$/, "/chunks/$recordId/$revision/$index"));
      if (op.value !== null && typeof rule === "string" && rule.endsWith("&& newData === null")) throw new AinWriteRejected("Delete-only rule rejects a write");
      if (op.ref.includes("/heads/") && op.value === null) {
        // Removing a head needs a rule that allows it (the CAS head rule requires a dict).
        const rule = this.rules.get(op.ref.replace(/\/heads\/[^/]+$/, "/heads/$recordId"));
        if (typeof rule !== "string" || !rule.includes("newData === null")) throw new AinWriteRejected("Head rule rejects removal");
        draft.delete(op.ref); continue;
      }
      if (op.ref.includes("/heads/")) {
        if (this.rejectHeadId && op.ref.endsWith("/" + this.rejectHeadId)) throw new AinWriteRejected("Head rejected");
        const before = draft.get(op.ref) as { revision: string } | undefined;
        const after = op.value as { previousRevision: string | null };
        if (after.previousRevision !== (before?.revision ?? null)) throw new AinWriteRejected("CAS rejected");
      } else if (this.rejectChunks) throw Error("Chunk confirmation failed");
      else if (op.value === null && this.legacyChunkRule) throw new AinWriteRejected("Legacy chunk rule rejects removal");
      if (op.value === null) { for (const key of [...draft.keys()]) if (key === op.ref || key.startsWith(op.ref + "/")) draft.delete(key); continue; }
      draft.set(op.ref, structuredClone(op.value));
    }
    this.values = draft;
    if (this.unconfirmed) throw Error("Finality timed out");
  }
}
