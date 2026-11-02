// Package cache is the Redis hot tier (a decorator provider). Wrap puts it in front of any
// router.Provider: the inner provider's name, classes, health and probe pass through untouched, so
// ladders, pins, Served.Provider and the archive's provider_id stamping do not change. Adding a
// provider needs no cache code; main.go wraps every provider in one loop.
//
// It is a disposable cache, not a history store. Finished RAW 1d/1m history is owned by the
// Postgres archive (internal/archive); this tier holds what the archive does not: quotes, bars of
// the session in progress, adjusted bars, hourly bars, and (with the archive off) finished history
// for a while. Any store error or timeout is a miss. Nothing here ever fails a request.
package cache

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/xnys"
)

const (
	// DefaultPrefix is the global invalidation switch: bump the version when the value format or a
	// provider's data variant changes (the Alpaca feed is hard-coded to sip today).
	DefaultPrefix = "md:v1:"

	readTimeout  = 150 * time.Millisecond
	writeTimeout = 250 * time.Millisecond
	flightLimit  = 2 * time.Minute // the shared upstream call outlives a caller that gives up
	breakerFails = 5               // consecutive store failures that open the breaker
	breakerOpen  = 30 * time.Second
	statsEvery   = time.Minute
	warnEvery    = time.Minute
)

type Options struct {
	Log *slog.Logger
	Now func() time.Time // default time.Now
	// ArchiveOn is true when the H1 Postgres archive is enabled: RAW finished 1d/1m windows then get
	// a short TTL only, because the archive owns them.
	ArchiveOn bool
	Prefix    string // default DefaultPrefix
}

// Cache is one store shared by every wrapped provider: one breaker, one stats set, one
// single-flight group (keys carry the provider name, so entries never cross providers).
type Cache struct {
	store     Store
	log       *slog.Logger
	now       func() time.Time
	archiveOn bool
	prefix    string
	sf        singleflight.Group

	mu        sync.Mutex // breaker, counters, warn limiter
	fails     int
	openUntil time.Time
	counts    map[string]int64
	lastWarn  time.Time
}

func New(store Store, o Options) *Cache {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Prefix == "" {
		o.Prefix = DefaultPrefix
	}
	return &Cache{store: store, log: o.Log, now: o.Now, archiveOn: o.ArchiveOn, prefix: o.Prefix, counts: map[string]int64{}}
}

func (c *Cache) Backend() string { return c.store.Backend() }
func (c *Cache) Close() error    { return c.store.Close() }

// Wrap decorates inner. The wrapper always implements both QuoteProvider and BarsProvider; when
// inner lacks one it returns the error the router would have produced.
func (c *Cache) Wrap(inner router.Provider) router.Provider { return &provider{Provider: inner, c: c} }

type provider struct {
	router.Provider // Name, Classes, Configured, Health, Probe: all delegated
	c               *Cache
}

// ---- store access: short timeouts, a breaker, and every error becomes a miss --------------------

// allow is the circuit breaker. After breakerFails consecutive failures the store is skipped for
// breakerOpen; then one call probes it and the window restarts until that call reports back.
func (c *Cache) allow() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fails < breakerFails {
		return true
	}
	if now := c.now(); !now.Before(c.openUntil) {
		c.openUntil = now.Add(breakerOpen)
		return true
	}
	c.counts["breaker_open"]++
	return false
}

func (c *Cache) report(ctx context.Context, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case err == nil:
		c.fails = 0
	case ctx.Err() == nil: // the caller leaving is not the store's fault
		c.fails++
		c.counts["store_error"]++
		if c.fails == breakerFails {
			c.openUntil = c.now().Add(breakerOpen)
		}
		if now := c.now(); now.Sub(c.lastWarn) >= warnEvery {
			c.lastWarn = now
			c.log.Warn("cache store error; treating as a miss", "backend", c.store.Backend(), "error", err.Error())
		}
	}
}

func (c *Cache) call(ctx context.Context, timeout time.Duration, op func(context.Context) error) error {
	if !c.allow() {
		return fmt.Errorf("cache: breaker open")
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err := op(cctx)
	c.report(ctx, err)
	return err
}

func (c *Cache) get(ctx context.Context, key string) (v []byte, ok bool) {
	_ = c.call(ctx, readTimeout, func(ctx context.Context) (err error) {
		v, ok, err = c.store.Get(ctx, key)
		return err
	})
	return v, ok
}

func (c *Cache) mget(ctx context.Context, keys []string) (vs [][]byte) {
	err := c.call(ctx, readTimeout, func(ctx context.Context) (err error) {
		vs, err = c.store.MGet(ctx, keys)
		return err
	})
	if err != nil || len(vs) != len(keys) {
		return make([][]byte, len(keys))
	}
	return vs
}

// set stores val with ±10% jitter on the TTL so a burst of fills does not expire together.
func (c *Cache) set(ctx context.Context, key string, val []byte, ttl time.Duration, nx bool) {
	if ttl <= 0 || len(val) > maxStored {
		return
	}
	ttl = time.Duration(float64(ttl) * (0.9 + 0.2*rand.Float64()))
	_ = c.call(ctx, writeTimeout, func(ctx context.Context) error { return c.store.Set(ctx, key, val, ttl, nx) })
}

func (c *Cache) count(name string) {
	c.mu.Lock()
	c.counts[name]++
	c.mu.Unlock()
}

// flight collapses concurrent identical misses into one upstream call. The call runs on a context
// that survives the leader leaving, so the followers still get their answer; each caller still
// stops waiting when its own context ends.
func (c *Cache) flight(ctx context.Context, key string, fn func(context.Context) (any, error)) (any, error) {
	ch := c.sf.DoChan(key, func() (any, error) {
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), flightLimit)
		defer cancel()
		return fn(fctx)
	})
	select {
	case r := <-ch:
		return r.Val, r.Err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// ---- stats ----------------------------------------------------------------------------------

// Run logs the counters as one JSON line per minute when any is non-zero, until ctx ends. Hit rate
// is then one `docker logs | jq 'select(.msg=="cache_stats")'` away.
func (c *Cache) Run(ctx context.Context) {
	t := time.NewTicker(statsEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.flushStats()
		}
	}
}

func (c *Cache) flushStats() {
	c.mu.Lock()
	counts := c.counts
	c.counts = map[string]int64{}
	c.mu.Unlock()
	if len(counts) == 0 {
		return
	}
	names := make([]string, 0, len(counts))
	for n := range counts {
		names = append(names, n)
	}
	sort.Strings(names)
	attrs := make([]any, 0, 2*len(names)+2)
	attrs = append(attrs, "backend", c.store.Backend())
	for _, n := range names {
		attrs = append(attrs, n, counts[n])
	}
	c.log.Info("cache_stats", attrs...)
}

// ---- quotes ---------------------------------------------------------------------------------

func (p *provider) quoteKey(symbol string) string {
	return p.c.prefix + p.Name() + ":q:" + symbol
}

func (p *provider) Quotes(ctx context.Context, symbols []string) ([]*pb.Quote, error) {
	qp, ok := p.Provider.(router.QuoteProvider)
	if !ok {
		return nil, fmt.Errorf("%w: %s has no quote support", router.ErrNotConfigured, p.Name())
	}
	c := p.c
	if router.Pinned(ctx) || len(symbols) == 0 {
		c.count("quote.bypass")
		return qp.Quotes(ctx, symbols)
	}
	keys := make([]string, len(symbols))
	for i, s := range symbols {
		keys[i] = p.quoteKey(s)
	}
	have := map[string]*pb.Quote{}
	asked := map[string]bool{}
	var missing []string
	for i, v := range c.mget(ctx, keys) {
		sym := symbols[i]
		if q, err := decodeQuote(v); err == nil {
			have[sym] = q
			c.count("quote.hit")
		} else if !asked[sym] {
			asked[sym] = true
			missing = append(missing, sym)
			c.count("quote.miss")
		}
	}
	if len(missing) > 0 {
		v, err := c.flight(ctx, p.Name()+"|q|"+strings.Join(missing, ","), func(ctx context.Context) (any, error) {
			qs, err := qp.Quotes(ctx, missing)
			if err != nil {
				return nil, err
			}
			now := c.now()
			for _, q := range qs {
				c.set(ctx, p.quoteKey(q.Symbol), encodeQuote(q), quoteTTL(q, now), false)
			}
			return qs, nil
		})
		if err != nil {
			return nil, err
		}
		for _, q := range v.([]*pb.Quote) {
			have[q.Symbol] = proto.Clone(q).(*pb.Quote) // the flight result is shared; each caller gets its own
		}
	}
	out := make([]*pb.Quote, 0, len(symbols))
	for _, s := range symbols {
		if q := have[s]; q != nil {
			out = append(out, q)
		}
	}
	return out, nil
}

// ---- bars -----------------------------------------------------------------------------------

func (p *provider) barsKey(symbol, tf, adj string, from, to time.Time) string {
	return p.c.prefix + p.Name() + ":b:" + symbol + ":" + tf + ":" + adj + ":" +
		strconv.FormatInt(from.Unix(), 10) + ":" + strconv.FormatInt(to.Unix(), 10)
}

func (p *provider) Bars(ctx context.Context, req *pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) {
	bp, ok := p.Provider.(router.BarsProvider)
	if !ok {
		return nil, 0, fmt.Errorf("%w: %s has no bars support", router.ErrNotConfigured, p.Name())
	}
	c := p.c
	tf, okTF := timeframeName(req.Timeframe)
	adj, okAdj := adjustmentName(req.Adjustment)
	if req.PinProvider != "" || router.Pinned(ctx) || !okTF || !okAdj || req.Start == nil || req.End == nil {
		c.count("bars.bypass")
		return bp.Bars(ctx, req)
	}
	start, end := req.Start.AsTime(), req.End.AsTime()
	from, to := window(start, end)
	now := c.now()
	ttl, immutable := barsTTL(req.Timeframe, req.Adjustment, xnys.Default().SessionDate(end), c.archiveOn, now)
	if ttl == 0 {
		c.count("bars.bypass")
		return bp.Bars(ctx, req)
	}
	key := p.barsKey(req.Symbol, tf, adj, from, to)

	corrupt := false
	if v, hit := c.get(ctx, key); hit {
		if bars, q, err := decodeBars(v); err == nil {
			c.count("bars.hit")
			return slice(bars, req.Timeframe, start, end), q, nil
		}
		corrupt = true // a bad value is a miss, and the fill below must overwrite it even when it is NX
		c.count("bars.corrupt")
	}
	c.count("bars.miss")

	v, err := c.flight(ctx, key, func(ctx context.Context) (any, error) {
		// as_of is lifted to now, as the archive does: the cache keeps every closed bar and the
		// server cuts the answer to the caller's as_of afterwards.
		bars, q, err := bp.Bars(ctx, &pb.GetBarsRequest{Symbol: req.Symbol, Timeframe: req.Timeframe, Adjustment: req.Adjustment,
			Start: timestamppb.New(from), End: timestamppb.New(to), AsOf: timestamppb.New(c.now())})
		if err != nil {
			return nil, err
		}
		// Only closed bars are ever stored, even if a provider returns a forming one.
		bars = router.BarsClosedBy(bars, req.Timeframe, c.now())
		enc := encodeBars(req.Symbol, bars, q)
		if len(bars) > 0 { // an empty window is not cached
			c.set(ctx, key, enc, ttl, immutable && !corrupt)
		}
		return enc, nil
	})
	if err != nil {
		return nil, 0, err
	}
	bars, q, err := decodeBars(v.([]byte))
	if err != nil {
		return nil, 0, fmt.Errorf("%w: cache decode: %v", router.ErrUnavailable, err)
	}
	return slice(bars, req.Timeframe, start, end), q, nil
}
