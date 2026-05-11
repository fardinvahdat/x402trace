import { describe, expect, it } from "vitest";
import { createEventBus } from "../../src/proxy/event-bus.js";

describe("createEventBus", () => {
  it("delivers events emitted after subscription", async () => {
    const bus = createEventBus<number>();
    const sub = bus.subscribe();
    const iter = sub[Symbol.asyncIterator]();

    bus.emit(1);
    bus.emit(2);

    await expect(iter.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iter.next()).resolves.toEqual({ value: 2, done: false });
    sub.unsubscribe();
  });

  it("does NOT deliver events emitted before subscription (no replay)", async () => {
    const bus = createEventBus<number>();
    bus.emit(99); // before any subscriber
    const sub = bus.subscribe();
    bus.emit(1);

    const iter = sub[Symbol.asyncIterator]();
    await expect(iter.next()).resolves.toEqual({ value: 1, done: false });
    sub.unsubscribe();
  });

  it("queues events when no consumer is awaiting", async () => {
    const bus = createEventBus<string>();
    const sub = bus.subscribe();

    bus.emit("a");
    bus.emit("b");
    bus.emit("c");

    const seen: string[] = [];
    const iter = sub[Symbol.asyncIterator]();
    seen.push((await iter.next()).value);
    seen.push((await iter.next()).value);
    seen.push((await iter.next()).value);
    sub.unsubscribe();

    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("supports multiple independent subscribers", async () => {
    const bus = createEventBus<number>();
    const a = bus.subscribe();
    const b = bus.subscribe();

    bus.emit(42);
    const ia = a[Symbol.asyncIterator]();
    const ib = b[Symbol.asyncIterator]();

    await expect(ia.next()).resolves.toEqual({ value: 42, done: false });
    await expect(ib.next()).resolves.toEqual({ value: 42, done: false });
    a.unsubscribe();
    b.unsubscribe();
  });

  it("drops oldest events when maxQueue is reached and counts the drop", async () => {
    const bus = createEventBus<number>();
    const sub = bus.subscribe(2); // maxQueue=2

    bus.emit(1);
    bus.emit(2);
    bus.emit(3); // pushes 1 out

    expect(bus.droppedFor(sub)).toBe(1);

    const iter = sub[Symbol.asyncIterator]();
    await expect(iter.next()).resolves.toEqual({ value: 2, done: false });
    await expect(iter.next()).resolves.toEqual({ value: 3, done: false });
    sub.unsubscribe();
  });

  it("unsubscribing resolves any pending awaits with done:true", async () => {
    const bus = createEventBus<number>();
    const sub = bus.subscribe();
    const iter = sub[Symbol.asyncIterator]();

    const pending = iter.next();
    sub.unsubscribe();
    await expect(pending).resolves.toMatchObject({ done: true });
  });
});
