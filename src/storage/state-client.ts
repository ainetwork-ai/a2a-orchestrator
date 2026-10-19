export interface StatePipeline {
  setEx(key: string, seconds: number, value: string): StatePipeline;
  exec(): Promise<unknown[]>;
}
export interface StateClient {
  get(key: string): Promise<string | null>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string): Promise<string | null>;
  setNX(key: string, value: string): Promise<boolean>;
  setEx(key: string, seconds: number, value: string): Promise<string>;
  sAdd(key: string, members: string | string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sRem(key: string, members: string | string[]): Promise<number>;
  sCard(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  del(keys: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  scanIterator(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string>;
  multi(): StatePipeline;
  quit(): Promise<unknown>;
}
