import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
export function itemAt<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("missing text");
  return value;
}

export function count(value: unknown): number {
  if (typeof value !== "number") throw new Error("missing number");
  return value;
}

export function record(value: unknown): DynamicRecord {
  return isDynamicRecord(value) ? value : {};
}

export function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("missing bytes");
}

export function maybeAt<Item>(items: readonly Item[], index: number): Item | undefined {
  return items[index];
}
