/**
 * Minimal pub-sub for in-process consumers (decoder, reconciler) to
 * subscribe to the live event stream. The JSONL sink is a separate
 * concern that does not go through this bus.
 *
 * A subscriber receives events from the moment it subscribes onward —
 * no replay. If a subscriber falls behind, events are queued in memory
 * up to `maxQueue` (default 1024), then the oldest is dropped and an
 * internal "dropped" counter is incremented (visible via `droppedFor`).
 */

export interface EventBus<T> {
  emit(event: T): void;
  subscribe(maxQueue?: number): AsyncIterable<T> & { unsubscribe(): void };
  droppedFor(iterable: AsyncIterable<T>): number;
}

interface Subscriber<T> {
  queue: T[];
  maxQueue: number;
  resolvers: Array<(value: IteratorResult<T>) => void>;
  done: boolean;
  dropped: number;
}

export function createEventBus<T>(): EventBus<T> {
  const subscribers = new Set<Subscriber<T>>();
  const iterableToSub = new WeakMap<AsyncIterable<T>, Subscriber<T>>();

  return {
    emit(event) {
      for (const sub of subscribers) {
        const resolver = sub.resolvers.shift();
        if (resolver) {
          resolver({ value: event, done: false });
          continue;
        }
        if (sub.queue.length >= sub.maxQueue) {
          sub.queue.shift();
          sub.dropped += 1;
        }
        sub.queue.push(event);
      }
    },
    subscribe(maxQueue = 1024) {
      const sub: Subscriber<T> = {
        queue: [],
        maxQueue,
        resolvers: [],
        done: false,
        dropped: 0,
      };
      subscribers.add(sub);

      const iterable: AsyncIterable<T> & { unsubscribe(): void } = {
        [Symbol.asyncIterator]: () => ({
          next(): Promise<IteratorResult<T>> {
            if (sub.queue.length > 0) {
              return Promise.resolve({ value: sub.queue.shift()!, done: false });
            }
            if (sub.done) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise<IteratorResult<T>>((resolve) => sub.resolvers.push(resolve));
          },
          return(): Promise<IteratorResult<T>> {
            sub.done = true;
            subscribers.delete(sub);
            for (const resolver of sub.resolvers) {
              resolver({ value: undefined as never, done: true });
            }
            sub.resolvers.length = 0;
            return Promise.resolve({ value: undefined as never, done: true });
          },
        }),
        unsubscribe() {
          sub.done = true;
          subscribers.delete(sub);
          for (const resolver of sub.resolvers) {
            resolver({ value: undefined as never, done: true });
          }
          sub.resolvers.length = 0;
        },
      };
      iterableToSub.set(iterable, sub);
      return iterable;
    },
    droppedFor(iterable) {
      return iterableToSub.get(iterable)?.dropped ?? 0;
    },
  };
}
