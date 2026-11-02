package cache

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/xnys"
)

// et builds an ET wall-clock instant.
func et(day, clock string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", day+" "+clock, xnys.NewYork)
	if err != nil {
		panic(err)
	}
	return t
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// monday is 2026-11-02 12:00 ET: the day after the DST end, the session in progress. Friday
// 2026-10-30 is the last finished session.
var monday = et("2026-11-02", "12:00")

// inner is the scripted provider under the cache.
type inner struct {
	name string
	clk  *clock

	mu       sync.Mutex
	bars     []*pb.GetBarsRequest
	quotes   [][]string
	barsFn   func(*pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error)
	quotesFn func([]string) ([]*pb.Quote, error)
	gate     chan struct{} // when set, Bars blocks until it is closed
	entered  chan struct{} // closed on the first Bars entry
	once     sync.Once
}

func newInner(clk *clock) *inner { return &inner{name: "alpaca", clk: clk} }

func (i *inner) Name() string            { return i.name }
func (i *inner) Classes() []pb.DataClass { return []pb.DataClass{pb.DataClass_EQUITY_BARS} }
func (i *inner) Configured() bool        { return true }
func (i *inner) Health() router.Health {
	return router.Health{State: pb.HealthState_HEALTH_STATE_OK, Quality: pb.Quality_DELAYED_15M}
}
func (i *inner) Probe(context.Context) error { return nil }

func (i *inner) barCalls() int   { i.mu.Lock(); defer i.mu.Unlock(); return len(i.bars) }
func (i *inner) quoteCalls() int { i.mu.Lock(); defer i.mu.Unlock(); return len(i.quotes) }

func mkBar(tf pb.Timeframe, start time.Time) *pb.Bar {
	cal := xnys.Default()
	b := &pb.Bar{Start: timestamppb.New(start), Open: 10, High: 12, Low: 9, Close: 11, Volume: 100, SessionDate: cal.SessionDate(start)}
	if c, ok := cal.BarClose(router.CalendarTimeframe(tf), start); ok {
		b.CloseAt = timestamppb.New(c)
	}
	return b
}

// sessions lists the XNYS session dates in [from, to].
func sessions(from, to time.Time) []string {
	cal := xnys.Default()
	var out []string
	for d := from.In(xnys.NewYork); !d.After(to); d = d.AddDate(0, 0, 1) {
		if day := d.Format(xnys.DateFormat); cal.IsSessionDate(day) {
			out = append(out, day)
		}
	}
	return out
}

// defaultBars: DAY_1 is one bar stamped at midnight ET per session; intraday is one bar at 10:00,
// 11:00 and 12:00 ET per session. Like the real adapter it returns closed bars only.
func (i *inner) defaultBars(r *pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) {
	var out []*pb.Bar
	from, to := r.Start.AsTime(), r.End.AsTime()
	for _, day := range sessions(from, to) {
		if r.Timeframe == pb.Timeframe_DAY_1 {
			out = append(out, mkBar(r.Timeframe, et(day, "00:00")))
			continue
		}
		for _, h := range []string{"10:00", "11:00", "12:00"} {
			if s := et(day, h); !s.Before(from) && !s.After(to) {
				out = append(out, mkBar(r.Timeframe, s))
			}
		}
	}
	return router.BarsClosedBy(out, r.Timeframe, i.clk.Now()), pb.Quality_DELAYED_15M, nil
}

func (i *inner) Bars(_ context.Context, r *pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) {
	i.mu.Lock()
	i.bars = append(i.bars, proto.Clone(r).(*pb.GetBarsRequest))
	fn, gate, entered := i.barsFn, i.gate, i.entered
	i.mu.Unlock()
	if entered != nil {
		i.once.Do(func() { close(entered) })
	}
	if gate != nil {
		<-gate
	}
	if fn != nil {
		return fn(r)
	}
	return i.defaultBars(r)
}

func (i *inner) Quotes(_ context.Context, syms []string) ([]*pb.Quote, error) {
	i.mu.Lock()
	i.quotes = append(i.quotes, append([]string(nil), syms...))
	fn := i.quotesFn
	i.mu.Unlock()
	if fn != nil {
		return fn(syms)
	}
	var out []*pb.Quote
	for _, s := range syms {
		out = append(out, &pb.Quote{Symbol: s, Last: 100, AsOf: timestamppb.New(i.clk.Now().Add(-20 * time.Minute)),
			Quality: pb.Quality_DELAYED_15M, Provider: i.name})
	}
	return out, nil
}

type rig struct {
	clk   *clock
	inner *inner
	store *MemStore
	c     *Cache
	p     router.Provider
	logs  *bytes.Buffer
}

func newRig(t *testing.T, mods ...func(*Options)) *rig {
	t.Helper()
	clk := &clock{t: monday}
	r := &rig{clk: clk, inner: newInner(clk), store: NewMemStore(clk.Now), logs: &bytes.Buffer{}}
	o := Options{Now: clk.Now, Log: slog.New(slog.NewJSONHandler(r.logs, nil))}
	for _, m := range mods {
		m(&o)
	}
	r.c = New(r.store, o)
	r.p = r.c.Wrap(r.inner)
	return r
}

func (r *rig) bars(ctx context.Context, req *pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) {
	return r.p.(router.BarsProvider).Bars(ctx, req)
}
func (r *rig) quotes(ctx context.Context, syms ...string) ([]*pb.Quote, error) {
	return r.p.(router.QuoteProvider).Quotes(ctx, syms)
}

func barsReq(tf pb.Timeframe, adj pb.Adjustment, start, end time.Time) *pb.GetBarsRequest {
	return &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: tf, Adjustment: adj,
		Start: timestamppb.New(start), End: timestamppb.New(end), AsOf: timestamppb.New(end)}
}

// openMinute is today's open session at 1m, RAW; settledMinute is Friday's whole finished session.
func openMinute() *pb.GetBarsRequest {
	return barsReq(pb.Timeframe_MINUTE_1, pb.Adjustment_RAW, et("2026-11-02", "04:00"), monday)
}
func settledMinute() *pb.GetBarsRequest {
	return barsReq(pb.Timeframe_MINUTE_1, pb.Adjustment_RAW, et("2026-10-30", "04:00"), et("2026-10-30", "20:00"))
}

func equalBars(t *testing.T, a, b []*pb.Bar) {
	t.Helper()
	if len(a) != len(b) {
		t.Fatalf("%d bars vs %d", len(a), len(b))
	}
	for i := range a {
		if !proto.Equal(a[i], b[i]) {
			t.Fatalf("bar %d differs: %v vs %v", i, a[i], b[i])
		}
	}
}

// ---- hit, miss, expiry --------------------------------------------------------------------------

func TestBarsMissThenHitThenExpiry(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	first, q1, err := r.bars(ctx, openMinute())
	if err != nil || len(first) == 0 || q1 != pb.Quality_DELAYED_15M {
		t.Fatalf("cold: %d bars, %v, %v", len(first), q1, err)
	}
	r.clk.Advance(40 * time.Second) // inside the 60 s TTL even at -10% jitter
	second, q2, err := r.bars(ctx, openMinute())
	if err != nil || r.inner.barCalls() != 1 || q2 != q1 {
		t.Fatalf("warm read: inner calls %d, quality %v, err %v", r.inner.barCalls(), q2, err)
	}
	equalBars(t, first, second)
	r.clk.Advance(40 * time.Second) // 80 s: past 60 s +10%
	if _, _, err := r.bars(ctx, openMinute()); err != nil || r.inner.barCalls() != 2 {
		t.Fatalf("after the TTL: inner calls %d, err %v, want 2", r.inner.barCalls(), err)
	}
}

func TestSettledWindowLivesThirtyDaysUnlessTheArchiveOwnsIt(t *testing.T) {
	for _, tc := range []struct {
		name      string
		archiveOn bool
		stillHit  time.Duration
		gone      time.Duration
	}{
		{"archive off", false, 26 * 24 * time.Hour, 34 * 24 * time.Hour},
		{"archive on", true, 8 * time.Minute, 12 * time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t, func(o *Options) { o.ArchiveOn = tc.archiveOn })
			ctx := context.Background()
			if _, _, err := r.bars(ctx, settledMinute()); err != nil {
				t.Fatal(err)
			}
			r.clk.Advance(tc.stillHit)
			r.bars(ctx, settledMinute())
			if r.inner.barCalls() != 1 {
				t.Fatalf("after %v: %d inner calls, want 1 (still cached)", tc.stillHit, r.inner.barCalls())
			}
			r.clk.Advance(tc.gone - tc.stillHit)
			r.bars(ctx, settledMinute())
			if r.inner.barCalls() != 2 {
				t.Fatalf("after %v: %d inner calls, want 2 (expired)", tc.gone, r.inner.barCalls())
			}
		})
	}
}

func TestQuotesPartialHitKeepInputOrderAndExpire(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	if _, err := r.quotes(ctx, "BBB", "CCC"); err != nil {
		t.Fatal(err)
	}
	got, err := r.quotes(ctx, "AAA", "BBB", "CCC")
	if err != nil {
		t.Fatal(err)
	}
	var syms []string
	for _, q := range got {
		syms = append(syms, q.Symbol)
	}
	if strings.Join(syms, ",") != "AAA,BBB,CCC" {
		t.Fatalf("order %v, want input order", syms)
	}
	if r.inner.quoteCalls() != 2 || strings.Join(r.inner.quotes[1], ",") != "AAA" {
		t.Fatalf("inner quote calls %v, want the second call to carry only AAA", r.inner.quotes)
	}
	r.clk.Advance(20 * time.Second) // inside the 30 s TTL
	r.quotes(ctx, "AAA", "BBB", "CCC")
	if r.inner.quoteCalls() != 2 {
		t.Fatalf("a warm read reached the inner provider: %v", r.inner.quotes)
	}
	r.clk.Advance(30 * time.Second) // 50 s: past 30 s +10%
	r.quotes(ctx, "AAA")
	if r.inner.quoteCalls() != 3 {
		t.Fatalf("after the TTL the quote must be refetched: %v", r.inner.quotes)
	}
}

func TestQuoteSymbolTheInnerProviderOmitsStaysOmitted(t *testing.T) {
	r := newRig(t)
	r.inner.quotesFn = func(syms []string) ([]*pb.Quote, error) { return nil, nil }
	got, err := r.quotes(context.Background(), "NOPE")
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v; the router reports the symbol as missing", got, err)
	}
}

// ---- window normalisation ------------------------------------------------------------------------

func TestWindowsWidenToWholeETDaysShareAnEntryAndSliceBack(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	a := barsReq(pb.Timeframe_MINUTE_1, pb.Adjustment_RAW, et("2026-11-02", "10:30"), monday)
	b := barsReq(pb.Timeframe_MINUTE_1, pb.Adjustment_RAW, et("2026-11-02", "04:00"), monday.Add(5*time.Minute))
	gotA, _, err := r.bars(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	gotB, _, err := r.bars(ctx, b)
	if err != nil {
		t.Fatal(err)
	}
	if r.inner.barCalls() != 1 {
		t.Fatalf("callers on the same ET days made %d inner calls, want 1", r.inner.barCalls())
	}
	sent := r.inner.bars[0]
	if !sent.Start.AsTime().Equal(et("2026-11-02", "00:00")) || !sent.End.AsTime().Equal(et("2026-11-03", "00:00").Add(-time.Second)) {
		t.Errorf("inner got [%v, %v], want the whole ET day", sent.Start.AsTime().In(xnys.NewYork), sent.End.AsTime().In(xnys.NewYork))
	}
	// The 12:00 bar closes at 12:01, after "now": only closed bars exist. A starts at 10:30.
	if len(gotA) != 1 || len(gotB) != 2 {
		t.Errorf("sliced to %d and %d bars, want 1 (11:00) and 2 (10:00, 11:00)", len(gotA), len(gotB))
	}
}

func TestDailyWindowSlicesBySessionDate(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	wide := barsReq(pb.Timeframe_DAY_1, pb.Adjustment_RAW, et("2026-10-26", "04:00"), et("2026-10-30", "20:00"))
	if got, _, err := r.bars(ctx, wide); err != nil || len(got) != 5 {
		t.Fatalf("wide window: %d bars, %v, want 5", len(got), err)
	}
	// One session, opened at its extended open: the 5U case (the bar is stamped at midnight, before 04:00).
	one := barsReq(pb.Timeframe_DAY_1, pb.Adjustment_RAW, et("2026-10-28", "04:00"), et("2026-10-28", "20:00"))
	got, _, err := r.bars(ctx, one)
	if err != nil || len(got) != 1 || got[0].SessionDate != "2026-10-28" {
		t.Fatalf("one-session window: %v, %v", got, err)
	}
	// Keys are per window (a different window is a different entry); the same window is shared.
	r.bars(ctx, one)
	if r.inner.barCalls() != 2 {
		t.Errorf("%d inner calls, want 2 (one per distinct window)", r.inner.barCalls())
	}
}

func TestKeysCarryProviderTimeframeAdjustmentAndTheWholeDayWindow(t *testing.T) {
	r := newRig(t)
	p := r.p.(*provider)
	from, to := window(et("2026-10-30", "10:00"), et("2026-10-30", "11:00"))
	want := fmt.Sprintf("md:v1:alpaca:b:AAPL:1m:raw:%d:%d", et("2026-10-30", "00:00").Unix(), et("2026-10-31", "00:00").Unix()-1)
	if got := p.barsKey("AAPL", "1m", "raw", from, to); got != want {
		t.Errorf("bars key %q, want %q", got, want)
	}
	if got := p.quoteKey("AAPL"); got != "md:v1:alpaca:q:AAPL" {
		t.Errorf("quote key %q", got)
	}
}

// ---- concurrency ------------------------------------------------------------------------------

type countingStore struct {
	Store
	gets, sets atomic.Int64
}

func (s *countingStore) Get(ctx context.Context, k string) ([]byte, bool, error) {
	s.gets.Add(1)
	return s.Store.Get(ctx, k)
}
func (s *countingStore) Set(ctx context.Context, k string, v []byte, ttl time.Duration, nx bool) error {
	s.sets.Add(1)
	return s.Store.Set(ctx, k, v, ttl, nx)
}

func TestConcurrentIdenticalRequestsCollapseIntoOneInnerCall(t *testing.T) {
	clk := &clock{t: monday}
	in := newInner(clk)
	in.gate, in.entered = make(chan struct{}), make(chan struct{})
	cs := &countingStore{Store: NewMemStore(clk.Now)}
	p := New(cs, Options{Now: clk.Now, Log: slog.New(slog.DiscardHandler)}).Wrap(in).(router.BarsProvider)

	const n = 20
	var wg sync.WaitGroup
	results := make([][]*pb.Bar, n)
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], _, errs[i] = p.Bars(context.Background(), openMinute())
		}()
	}
	<-in.entered
	for cs.gets.Load() < n { // every caller has missed and is waiting on the flight
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond) // the last caller joins the flight right after its Get
	close(in.gate)
	wg.Wait()
	if got := in.barCalls(); got != 1 {
		t.Fatalf("%d concurrent identical requests made %d inner calls, want 1", n, got)
	}
	for i := range n {
		if errs[i] != nil || len(results[i]) == 0 {
			t.Fatalf("caller %d: %d bars, %v", i, len(results[i]), errs[i])
		}
		equalBars(t, results[0], results[i])
	}
	// Callers mutate what they get (the archive stamps Bar.source): the copies must not alias.
	results[0][0].Open = 999
	if results[1][0].Open == 999 {
		t.Fatal("callers share bar objects")
	}
}

func TestCallerThatLeavesDoesNotFailTheOthers(t *testing.T) {
	clk := &clock{t: monday}
	in := newInner(clk)
	in.gate, in.entered = make(chan struct{}), make(chan struct{})
	p := New(NewMemStore(clk.Now), Options{Now: clk.Now, Log: slog.New(slog.DiscardHandler)}).Wrap(in).(router.BarsProvider)

	leaderCtx, cancel := context.WithCancel(context.Background())
	leaderDone := make(chan error, 1)
	go func() { _, _, err := p.Bars(leaderCtx, openMinute()); leaderDone <- err }()
	<-in.entered
	followerDone := make(chan error, 1)
	go func() { _, _, err := p.Bars(context.Background(), openMinute()); followerDone <- err }()
	time.Sleep(30 * time.Millisecond)
	cancel()
	if err := <-leaderDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("leader: %v, want context.Canceled", err)
	}
	close(in.gate)
	if err := <-followerDone; err != nil {
		t.Fatalf("follower failed because the leader left: %v", err)
	}
}

// ---- store failure: always a miss, never an error -----------------------------------------------

type failingStore struct {
	calls atomic.Int64
	fail  atomic.Bool
	inner Store
}

func (s *failingStore) err() error {
	s.calls.Add(1)
	if s.fail.Load() {
		return errors.New("connection refused")
	}
	return nil
}
func (s *failingStore) Get(ctx context.Context, k string) ([]byte, bool, error) {
	if err := s.err(); err != nil {
		return nil, false, err
	}
	return s.inner.Get(ctx, k)
}
func (s *failingStore) MGet(ctx context.Context, ks []string) ([][]byte, error) {
	if err := s.err(); err != nil {
		return nil, err
	}
	return s.inner.MGet(ctx, ks)
}
func (s *failingStore) Set(ctx context.Context, k string, v []byte, ttl time.Duration, nx bool) error {
	if err := s.err(); err != nil {
		return err
	}
	return s.inner.Set(ctx, k, v, ttl, nx)
}
func (s *failingStore) Backend() string { return "fake" }
func (s *failingStore) Close() error    { return nil }

func TestStoreErrorsAreMissesAndTheAnswerIsCorrect(t *testing.T) {
	clk := &clock{t: monday}
	in := newInner(clk)
	fs := &failingStore{inner: NewMemStore(clk.Now)}
	fs.fail.Store(true)
	var logs bytes.Buffer
	c := New(fs, Options{Now: clk.Now, Log: slog.New(slog.NewJSONHandler(&logs, nil))})
	p := c.Wrap(in)
	ctx := context.Background()
	want, _, _ := newInner(clk).defaultBars(openMinute())
	got, _, err := p.(router.BarsProvider).Bars(ctx, openMinute())
	if err != nil {
		t.Fatalf("a failing store failed the request: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("%d bars, want %d", len(got), len(want))
	}
	if qs, err := p.(router.QuoteProvider).Quotes(ctx, []string{"AAA"}); err != nil || len(qs) != 1 {
		t.Fatalf("quotes with a failing store: %v, %v", qs, err)
	}
	if strings.Contains(logs.String(), "connection refused") && strings.Count(logs.String(), "cache store error") != 1 {
		t.Errorf("store errors must be logged at most once a minute:\n%s", logs.String())
	}
}

func TestBreakerStopsCallingADeadStoreAndRecovers(t *testing.T) {
	clk := &clock{t: monday}
	in := newInner(clk)
	fs := &failingStore{inner: NewMemStore(clk.Now)}
	fs.fail.Store(true)
	c := New(fs, Options{Now: clk.Now, Log: slog.New(slog.DiscardHandler)})
	p := c.Wrap(in).(router.BarsProvider)
	ctx := context.Background()
	for range 10 {
		if _, _, err := p.Bars(ctx, openMinute()); err != nil {
			t.Fatal(err)
		}
	}
	if got := fs.calls.Load(); got != breakerFails {
		t.Fatalf("a dead store was called %d times in 10 requests, want %d (then the breaker opens)", got, breakerFails)
	}
	if in.barCalls() != 10 {
		t.Fatalf("every request must still be served by the inner provider: %d", in.barCalls())
	}
	clk.Advance(breakerOpen + time.Second)
	p.Bars(ctx, openMinute())
	if got := fs.calls.Load(); got != breakerFails+1 {
		t.Fatalf("after the window one probe goes through: %d calls, want %d", got, breakerFails+1)
	}
	fs.fail.Store(false)
	clk.Advance(breakerOpen + time.Second)
	p.Bars(ctx, openMinute()) // probe succeeds: closed again
	before := fs.calls.Load()
	p.Bars(ctx, openMinute())
	if fs.calls.Load() == before {
		t.Fatal("the breaker stayed open after a successful probe")
	}
	c.flushStats()
	if c.counts["breaker_open"] != 0 { // flushed
		t.Error("counters are not reset by the flush")
	}
}

// hangStore blocks until its context ends, like a Redis that accepted the connection and went silent.
type hangStore struct{ *MemStore }

func (hangStore) Get(ctx context.Context, _ string) ([]byte, bool, error) {
	<-ctx.Done()
	return nil, false, ctx.Err()
}
func (hangStore) MGet(ctx context.Context, ks []string) ([][]byte, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (hangStore) Set(ctx context.Context, _ string, _ []byte, _ time.Duration, _ bool) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestHangingStoreCostsAtMostTheTimeoutBudget(t *testing.T) {
	in := newInner(&clock{t: monday})
	p := New(hangStore{}, Options{Now: in.clk.Now, Log: slog.New(slog.DiscardHandler)}).Wrap(in).(router.BarsProvider)
	begin := time.Now()
	got, _, err := p.Bars(context.Background(), openMinute())
	if err != nil || len(got) == 0 {
		t.Fatalf("%d bars, %v", len(got), err)
	}
	if took := time.Since(begin); took > readTimeout+writeTimeout+300*time.Millisecond {
		t.Fatalf("a hanging store cost %v, want about %v", took, readTimeout+writeTimeout)
	}
}

func TestCorruptValueIsAMissAndIsOverwrittenEvenWhenWriteOnce(t *testing.T) {
	for _, junk := range [][]byte{[]byte("garbage"), {'Z', 1, 2, 3}, {'R', 0xff, 0xff}, nil} {
		r := newRig(t) // a settled RAW window: written with NX
		key := r.p.(*provider).barsKey("AAPL", "1m", "raw", et("2026-10-30", "00:00"), et("2026-10-31", "00:00").Add(-time.Second))
		if err := r.store.Set(context.Background(), key, junk, time.Hour, false); err != nil {
			t.Fatal(err)
		}
		if got, _, err := r.bars(context.Background(), settledMinute()); err != nil || len(got) == 0 {
			t.Fatalf("junk %q: %d bars, %v", junk, len(got), err)
		}
		r.bars(context.Background(), settledMinute())
		if r.inner.barCalls() != 1 {
			t.Errorf("junk %q: %d inner calls, want 1 (the fill overwrote the corrupt entry)", junk, r.inner.barCalls())
		}
	}
}

// ---- invalidation ---------------------------------------------------------------------------------

func TestPrefixBumpMissesEveryOldEntry(t *testing.T) {
	clk := &clock{t: monday}
	store := NewMemStore(clk.Now)
	in := newInner(clk)
	ctx := context.Background()
	v1 := New(store, Options{Now: clk.Now, Log: slog.New(slog.DiscardHandler)}).Wrap(in).(router.BarsProvider)
	v2 := New(store, Options{Now: clk.Now, Log: slog.New(slog.DiscardHandler), Prefix: "md:v2:"}).Wrap(in).(router.BarsProvider)
	v1.Bars(ctx, openMinute())
	v1.Bars(ctx, openMinute())
	v2.Bars(ctx, openMinute())
	if in.barCalls() != 2 {
		t.Fatalf("%d inner calls, want 2 (v1 filled once, v2 missed once)", in.barCalls())
	}
}

func TestImmutableEntriesAreWrittenOnce(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	r.c.set(ctx, "k", []byte("first"), time.Hour, true)
	r.c.set(ctx, "k", []byte("second"), time.Hour, true)
	if v, _, _ := r.store.Get(ctx, "k"); string(v) != "first" {
		t.Fatalf("NX write replaced the stored value: %q", v)
	}
	r.c.set(ctx, "k", []byte("third"), time.Hour, false)
	if v, _, _ := r.store.Get(ctx, "k"); string(v) != "third" {
		t.Fatalf("a plain write must replace: %q", v)
	}
	r.c.set(ctx, "big", make([]byte, maxStored+1), time.Hour, false)
	if _, ok, _ := r.store.Get(ctx, "big"); ok {
		t.Fatal("a value over 1 MiB was stored")
	}
}

func TestLargeBarSetsAreCompressedAndRoundTrip(t *testing.T) {
	var bars []*pb.Bar
	for i := range 300 {
		bars = append(bars, mkBar(pb.Timeframe_MINUTE_1, et("2026-10-30", "04:00").Add(time.Duration(i)*time.Minute)))
	}
	enc := encodeBars("AAPL", bars, pb.Quality_EOD)
	if enc[0] != tagFlate {
		t.Fatalf("tag %q, want deflate for a payload over %d bytes", enc[0], compressOver)
	}
	got, q, err := decodeBars(enc)
	if err != nil || q != pb.Quality_EOD {
		t.Fatal(q, err)
	}
	equalBars(t, bars, got)
	small := encodeBars("AAPL", bars[:1], pb.Quality_EOD)
	if small[0] != tagRaw {
		t.Fatalf("tag %q, want raw for a small payload", small[0])
	}
}

// ---- no look-ahead, pins, realtime -----------------------------------------------------------------

func TestAFormingBarIsNeverStored(t *testing.T) {
	r := newRig(t)
	forming := mkBar(pb.Timeframe_MINUTE_1, monday.Add(-30*time.Second)) // closes in 30 s
	closedBar := mkBar(pb.Timeframe_MINUTE_1, monday.Add(-10*time.Minute))
	r.inner.barsFn = func(*pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) {
		return []*pb.Bar{closedBar, forming}, pb.Quality_DELAYED_15M, nil
	}
	got, _, err := r.bars(context.Background(), openMinute())
	if err != nil || len(got) != 1 || !got[0].Start.AsTime().Equal(closedBar.Start.AsTime()) {
		t.Fatalf("answer %v, %v: the forming bar must be dropped", got, err)
	}
	for k, e := range r.store.m {
		bars, _, err := decodeBars(e.val)
		if err != nil || len(bars) != 1 {
			t.Errorf("stored %s: %d bars, %v, want only the closed bar", k, len(bars), err)
		}
	}
}

func TestRequestsDifferingOnlyInAsOfShareAnEntry(t *testing.T) {
	r := newRig(t)
	a, b := openMinute(), openMinute()
	a.AsOf = timestamppb.New(monday.Add(-time.Hour))
	b.AsOf = timestamppb.New(monday)
	r.bars(context.Background(), a)
	r.bars(context.Background(), b)
	if r.inner.barCalls() != 1 {
		t.Fatalf("%d inner calls, want 1: as_of must not be part of the key", r.inner.barCalls())
	}
}

func TestPinnedRequestsNeverTouchTheStore(t *testing.T) {
	clk := &clock{t: monday}
	in := newInner(clk)
	cs := &countingStore{Store: NewMemStore(clk.Now)}
	p := New(cs, Options{Now: clk.Now, Log: slog.New(slog.DiscardHandler)}).Wrap(in)
	ctx := context.Background()
	pinReq := openMinute()
	pinReq.PinProvider = "alpaca"
	pinned := router.WithPinned(ctx)
	bp, qp := p.(router.BarsProvider), p.(router.QuoteProvider)
	for range 2 {
		bp.Bars(ctx, pinReq)          // req.PinProvider
		bp.Bars(pinned, openMinute()) // context flag
		qp.Quotes(pinned, []string{"AAA"})
	}
	if in.barCalls() != 4 || in.quoteCalls() != 2 {
		t.Fatalf("inner calls: %d bars (want 4), %d quotes (want 2): a pinned request must reach the vendor", in.barCalls(), in.quoteCalls())
	}
	if cs.gets.Load()+cs.sets.Load() != 0 {
		t.Fatalf("a pinned request touched the store (%d gets, %d sets)", cs.gets.Load(), cs.sets.Load())
	}
}

func TestRealtimeQuotesAreNeverStored(t *testing.T) {
	r := newRig(t)
	r.inner.quotesFn = func(syms []string) ([]*pb.Quote, error) {
		return []*pb.Quote{{Symbol: syms[0], Last: 1, AsOf: timestamppb.New(monday), Quality: pb.Quality_REALTIME}}, nil
	}
	r.quotes(context.Background(), "AAA")
	r.quotes(context.Background(), "AAA")
	if r.inner.quoteCalls() != 2 || r.store.Len() != 0 {
		t.Fatalf("realtime: %d inner calls (want 2), %d stored (want 0)", r.inner.quoteCalls(), r.store.Len())
	}
}

func TestErrorsAndEmptyWindowsAreNotCached(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	r.inner.barsFn = func(*pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) {
		return nil, 0, fmt.Errorf("%w: boom", router.ErrUnavailable)
	}
	if _, _, err := r.bars(ctx, openMinute()); !errors.Is(err, router.ErrUnavailable) {
		t.Fatalf("the inner error must pass through: %v", err)
	}
	r.inner.barsFn = func(*pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) { return nil, pb.Quality_DELAYED_15M, nil }
	if got, _, err := r.bars(ctx, openMinute()); err != nil || len(got) != 0 {
		t.Fatalf("empty window: %v, %v", got, err)
	}
	r.bars(ctx, openMinute())
	if r.inner.barCalls() != 3 || r.store.Len() != 0 {
		t.Fatalf("%d inner calls (want 3), %d stored (want 0)", r.inner.barCalls(), r.store.Len())
	}
}

func TestUncacheableRequestsPassThrough(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	weekly := barsReq(pb.Timeframe_TIMEFRAME_UNSPECIFIED, pb.Adjustment_RAW, et("2026-10-26", "00:00"), monday)
	r.bars(ctx, weekly)
	r.bars(ctx, weekly)
	if r.inner.barCalls() != 2 || r.store.Len() != 0 {
		t.Fatalf("unknown timeframe: %d inner calls (want 2), %d stored", r.inner.barCalls(), r.store.Len())
	}
}

// ---- wrapper contract ----------------------------------------------------------------------------

type quotesOnly struct{ router.Provider }
type barsOnly struct{ router.Provider }

func TestWrapperDelegatesIdentityAndReportsMissingSupportLikeTheRouter(t *testing.T) {
	r := newRig(t)
	if r.p.Name() != "alpaca" || !r.p.Configured() || len(r.p.Classes()) != 1 || r.p.Health().Quality != pb.Quality_DELAYED_15M || r.p.Probe(context.Background()) != nil {
		t.Fatal("the wrapper must delegate Name, Classes, Configured, Health and Probe")
	}
	c := New(NewMemStore(nil), Options{Log: slog.New(slog.DiscardHandler)})
	noBars := c.Wrap(quotesOnly{r.inner}).(router.BarsProvider)
	if _, _, err := noBars.Bars(context.Background(), openMinute()); !errors.Is(err, router.ErrNotConfigured) || !strings.Contains(err.Error(), "no bars support") {
		t.Fatalf("missing bars support: %v", err)
	}
	noQuotes := c.Wrap(barsOnly{r.inner}).(router.QuoteProvider)
	if _, err := noQuotes.Quotes(context.Background(), []string{"A"}); !errors.Is(err, router.ErrNotConfigured) || !strings.Contains(err.Error(), "no quote support") {
		t.Fatalf("missing quote support: %v", err)
	}
}

func TestStatsLineCountsHitsAndMisses(t *testing.T) {
	r := newRig(t)
	r.bars(context.Background(), openMinute())
	r.bars(context.Background(), openMinute())
	r.c.flushStats()
	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(r.logs.Bytes()), &line); err != nil {
		t.Fatalf("not one JSON line: %q", r.logs.String())
	}
	if line["msg"] != "cache_stats" || line["bars.hit"] != float64(1) || line["bars.miss"] != float64(1) || line["backend"] != "memory" {
		t.Fatalf("stats line %v", line)
	}
	r.logs.Reset()
	r.c.flushStats()
	if r.logs.Len() != 0 {
		t.Fatal("an empty interval must log nothing")
	}
}
