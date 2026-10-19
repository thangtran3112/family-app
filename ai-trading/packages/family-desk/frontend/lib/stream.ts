import type { Quality } from "./labels.ts";

export interface Quote {
  symbol: string;
  close: number;
  quality: Quality;
  as_of: string;
}

type Subscriber = { onQuote: (quote: Quote) => void; onError?: (error: Error) => void };
type Stream = {
  source?: EventSource;
  timer?: ReturnType<typeof setTimeout>;
  failures: number;
  subscribers: Map<number, Subscriber>;
};

const streams = new Map<string, Stream>();
const qualities = new Set<Quality>(["realtime", "delayed-15m", "eod", "fallback", "unavailable"]);
let nextSubscriberId = 0;

function parseQuote(data: string, symbol: string): Quote | undefined {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) return;
    const quote = value as Record<string, unknown>;
    if (
      quote.symbol !== symbol ||
      typeof quote.close !== "number" ||
      !Number.isFinite(quote.close) ||
      typeof quote.quality !== "string" ||
      !qualities.has(quote.quality as Quality) ||
      typeof quote.as_of !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(quote.as_of) ||
      !Number.isFinite(Date.parse(quote.as_of))
    ) {
      return;
    }
    return {
      symbol,
      close: quote.close,
      quality: quote.quality as Quality,
      as_of: quote.as_of,
    };
  } catch {
    return;
  }
}

function report(stream: Stream, error: Error): void {
  for (const { onError } of stream.subscribers.values()) onError?.(error);
}

function connect(symbol: string, stream: Stream): void {
  if (streams.get(symbol) !== stream || stream.subscribers.size === 0) return;
  const source = new EventSource(`/api/desk/quotes/${encodeURIComponent(symbol)}`, { withCredentials: true });
  stream.source = source;
  source.onopen = () => {
    if (stream.source === source) stream.failures = 0;
  };
  source.addEventListener("quote", (event) => {
    if (stream.source !== source) return;
    const quote = parseQuote((event as MessageEvent<string>).data, symbol);
    if (!quote) {
      report(stream, new Error("Invalid quote event"));
      return;
    }
    for (const { onQuote } of stream.subscribers.values()) onQuote(quote);
  });
  source.onerror = () => {
    if (stream.source !== source) return;
    source.close(); // disable EventSource's own retry loop before scheduling ours
    stream.source = undefined;
    report(stream, new Error("Quote stream disconnected"));
    const delay = Math.min(1_000 * 2 ** stream.failures, 30_000);
    stream.failures += 1;
    stream.timer = setTimeout(() => {
      stream.timer = undefined;
      connect(symbol, stream);
    }, delay);
  };
}

export function openQuoteStream(
  symbol: string,
  onQuote: (quote: Quote) => void,
  onError?: (error: Error) => void,
): () => void {
  let stream = streams.get(symbol);
  const shouldConnect = !stream;
  if (!stream) {
    stream = { failures: 0, subscribers: new Map() };
    streams.set(symbol, stream);
  }
  const subscriberId = nextSubscriberId++;
  stream.subscribers.set(subscriberId, { onQuote, onError });
  if (shouldConnect) connect(symbol, stream);

  return () => {
    const current = streams.get(symbol);
    if (current !== stream || !stream.subscribers.delete(subscriberId)) return;
    if (stream.subscribers.size > 0) return;
    streams.delete(symbol);
    if (stream.timer !== undefined) clearTimeout(stream.timer);
    stream.source?.close();
  };
}
