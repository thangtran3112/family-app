import assert from "node:assert/strict";
import test from "node:test";
import { openQuoteStream, type Quote } from "./stream.ts";

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly url: string;
  readonly init?: EventSourceInit;

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.init = init;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as Listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(data: string): void {
    for (const listener of this.listeners.get("quote") ?? []) listener({ data } as MessageEvent<string>);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

function withEventSource(run: (timers: FakeTimers) => void): void {
  const oldEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  FakeEventSource.instances = [];
  const timers = new FakeTimers();
  timers.install();
  try {
    run(timers);
  } finally {
    timers.restore();
    globalThis.EventSource = oldEventSource;
  }
}

class FakeTimers {
  private readonly oldSetTimeout = globalThis.setTimeout;
  private readonly oldClearTimeout = globalThis.clearTimeout;
  readonly scheduled: { callback: () => void; delay: number; cleared: boolean }[] = [];

  install(): void {
    globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
      const timer = { callback: callback as () => void, delay, cleared: false };
      this.scheduled.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      const timer = handle as unknown as (typeof this.scheduled)[number];
      timer.cleared = true;
    }) as typeof clearTimeout;
  }

  restore(): void {
    globalThis.setTimeout = this.oldSetTimeout;
    globalThis.clearTimeout = this.oldClearTimeout;
  }

  runNext(): void {
    const timer = this.scheduled.find(({ cleared }) => !cleared);
    assert.ok(timer, "expected a pending retry timer");
    timer.cleared = true;
    timer.callback();
  }
}

test("subscribers share one EventSource until the last unsubscribe", () => {
  withEventSource(() => {
    const first: Quote[] = [];
    const second: Quote[] = [];
    const unsubscribeFirst = openQuoteStream("AAPL", (quote) => first.push(quote));
    const unsubscribeSecond = openQuoteStream("AAPL", (quote) => second.push(quote));
    const [source] = FakeEventSource.instances;
    assert.ok(source);
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(source.url, "/api/desk/quotes/AAPL");
    assert.equal(source.init?.withCredentials, true);

    source.emit(JSON.stringify({ symbol: "AAPL", close: 101, quality: "delayed-15m", as_of: "2026-10-16T14:00:00Z" }));
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);

    unsubscribeFirst();
    assert.equal(source.closed, false);
    unsubscribeSecond();
    assert.equal(source.closed, true);
  });
});

test("slash-prefixed futures symbols are encoded as one quote route segment", () => {
  withEventSource(() => {
    const unsubscribe = openQuoteStream("/ES", () => {});
    assert.equal(FakeEventSource.instances[0]?.url, "/api/desk/quotes/%2FES");
    unsubscribe();
  });
});

test("errors close native EventSource and retry with capped exponential backoff", () => {
  withEventSource((timers) => {
    const unsubscribe = openQuoteStream("AAPL", () => {});
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

    for (const delay of delays) {
      const source = FakeEventSource.instances.at(-1);
      assert.ok(source);
      source.fail();
      assert.equal(source.closed, true);
      assert.equal(timers.scheduled.at(-1)?.delay, delay);
      timers.runNext();
    }

    unsubscribe();
  });
});

test("last unsubscribe closes stream and cancels pending retry", () => {
  withEventSource((timers) => {
    const unsubscribe = openQuoteStream("AAPL", () => {});
    const source = FakeEventSource.instances[0];
    assert.ok(source);
    source.fail();
    const timer = timers.scheduled[0];
    assert.ok(timer);

    unsubscribe();

    assert.equal(timer.cleared, true);
    assert.equal(FakeEventSource.instances.length, 1);
  });
});

test("invalid quote events report a fixed error and never reach subscribers", () => {
  withEventSource(() => {
    const quotes: Quote[] = [];
    const errors: Error[] = [];
    const unsubscribe = openQuoteStream("AAPL", (quote) => quotes.push(quote), (error) => errors.push(error));
    const source = FakeEventSource.instances[0];
    assert.ok(source);

    for (const invalid of [
      '{"symbol":"AAPL","close":1e999,"quality":"realtime","as_of":"2026-10-16T14:00:00Z"}',
      '{"symbol":"AAPL","close":1,"quality":"secret","as_of":"2026-10-16T14:00:00Z"}',
      '{"symbol":"AAPL","close":1,"quality":"realtime","as_of":"bad"}',
      '{"symbol":"AAPL","close":1,"quality":"realtime","as_of":"2026-10-16"}',
    ]) {
      source.emit(invalid);
    }

    assert.deepEqual(quotes, []);
    assert.equal(errors.length, 4);
    assert.equal(errors[0]?.message, "Invalid quote event");
    assert.doesNotMatch(errors.map(({ message }) => message).join(" "), /secret|bad|close/);
    unsubscribe();
  });
});
