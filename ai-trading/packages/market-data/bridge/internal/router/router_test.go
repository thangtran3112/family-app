package router

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// fake is a quote+bars provider whose behaviour the test scripts.
type fake struct {
	name       string
	classes    []pb.DataClass
	configured bool
	quality    pb.Quality
	err        error // returned by Quotes/Bars/Probe while set
	calls      int
	probes     int
	symbols    []string // symbols it can quote; nil = all
}

func (f *fake) Name() string            { return f.name }
func (f *fake) Classes() []pb.DataClass { return f.classes }
func (f *fake) Configured() bool        { return f.configured }
func (f *fake) Health() Health {
	return Health{State: pb.HealthState_HEALTH_STATE_OK, Quality: f.quality}
}
func (f *fake) Probe(context.Context) error { f.probes++; return f.err }
func (f *fake) Quotes(_ context.Context, syms []string) ([]*pb.Quote, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	var out []*pb.Quote
	for _, s := range syms {
		if f.symbols == nil || contains(f.symbols, s) {
			out = append(out, &pb.Quote{Symbol: s, Last: 1, Quality: f.quality, Provider: f.name, AsOf: timestamppb.New(time.Unix(100, 0))})
		}
	}
	return out, nil
}
func (f *fake) Bars(context.Context, *pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) {
	f.calls++
	if f.err != nil {
		return nil, 0, f.err
	}
	return []*pb.Bar{{Close: 1}}, f.quality, nil
}

var qc = []pb.DataClass{pb.DataClass_EQUITY_QUOTES, pb.DataClass_EQUITY_BARS}

func newRouter(ps ...Provider) (*Router, *fakeClock) {
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	return New(Options{
		Role:      "bridge",
		Ladders:   map[pb.DataClass][]string{pb.DataClass_EQUITY_QUOTES: {"ibkr", "longbridge", "alpaca"}, pb.DataClass_EQUITY_BARS: {"alpaca"}},
		Providers: ps,
		Now:       clk.Now,
	}), clk
}

func trio() (*fake, *fake, *fake) {
	return &fake{name: "ibkr", classes: qc[:1], configured: true, quality: pb.Quality_REALTIME},
		&fake{name: "longbridge", classes: qc[:1], configured: true, quality: pb.Quality_REALTIME},
		&fake{name: "alpaca", classes: qc, configured: true, quality: pb.Quality_DELAYED_15M}
}

func TestLadderOrderAndFirstSuccess(t *testing.T) {
	ib, lb, al := trio()
	r, _ := newRouter(ib, lb, al)
	got, err := r.Quotes(context.Background(), []string{"AAPL"}, "")
	if err != nil || got.Served.Provider != "ibkr" || got.Served.Fallback {
		t.Fatalf("want ibkr first, got %+v %v", got, err)
	}
	if lb.calls+al.calls != 0 {
		t.Fatal("later rungs must not be called after a success")
	}
}

func TestFallThroughOnEveryTaxonomyError(t *testing.T) {
	for _, e := range []error{ErrNotConfigured, ErrUnavailable, ErrSoftBanned, ErrNotEntitled, ErrNoData} {
		ib, lb, al := trio()
		ib.err = fmt.Errorf("%w: boom", e)
		r, _ := newRouter(ib, lb, al)
		got, err := r.Quotes(context.Background(), []string{"AAPL"}, "")
		if err != nil || got.Served.Provider != "longbridge" || !got.Served.Fallback {
			t.Fatalf("%v: want longbridge as fallback, got %+v %v", e, got, err)
		}
		if !strings.HasPrefix(got.Served.FallbackReason, "ibkr: ") || len(got.Served.Attempts) != 1 {
			t.Fatalf("%v: reason/attempts: %+v", e, got.Served)
		}
	}
}

func TestQualityIsTheServingProvidersOwn(t *testing.T) {
	ib, lb, al := trio()
	ib.err, lb.configured = ErrUnavailable, false
	r, _ := newRouter(ib, lb, al)
	got, _ := r.Quotes(context.Background(), []string{"AAPL"}, "")
	if got.Served.Quality != pb.Quality_DELAYED_15M || got.Quotes[0].Quality != pb.Quality_DELAYED_15M || got.Quotes[0].Provider != "alpaca" {
		t.Fatalf("fallback to alpaca must stay delayed and labeled alpaca: %+v", got)
	}
}

func TestPreferenceMovesToHeadAndKeepsRestInOrder(t *testing.T) {
	ib, lb, al := trio()
	r, _ := newRouter(ib, lb, al)
	routing, err := r.SetRouting([]*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "alpaca"}}, 7)
	if err != nil {
		t.Fatal(err)
	}
	if routing.Version != 7 || routing.Source != pb.RoutingSource_DESK {
		t.Fatalf("routing: %+v", routing)
	}
	if got := r.orderLocked(pb.DataClass_EQUITY_QUOTES); strings.Join(got, ",") != "alpaca,ibkr,longbridge" {
		t.Fatalf("order: %v", got)
	}
	if routing.Classes[0].Serving != "alpaca" || routing.Classes[0].Preferred != "alpaca" {
		t.Fatalf("serving: %+v", routing.Classes[0])
	}
	// Clearing the preference restores the env order.
	if _, err := r.SetRouting([]*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES}}, 8); err != nil {
		t.Fatal(err)
	}
	if r.Preferred(pb.DataClass_EQUITY_QUOTES) != "ibkr" {
		t.Fatal("cleared preference must fall back to the first env rung")
	}
}

func TestSetRoutingValidation(t *testing.T) {
	ib, lb, al := trio()
	lb.configured = false
	r, _ := newRouter(ib, lb, al) // no ibkr-for-bars; longbridge has no key
	set := func(c pb.DataClass, p string, v int64) error {
		_, err := r.SetRouting([]*pb.ClassPreference{{DataClass: c, Provider: p}}, v)
		return err
	}
	q, b := pb.DataClass_EQUITY_QUOTES, pb.DataClass_EQUITY_BARS
	cases := map[string]struct {
		err  error
		want string
	}{
		"unknown (tradier)":   {set(q, "tradier", 1), "not a known provider"},
		"not in ladder":       {set(b, "ibkr", 1), "not in the equity_bars ladder"},
		"marketdata_app":      {set(q, "marketdata_app", 1), "not in the equity_quotes ladder"},
		"no key":              {set(q, "longbridge", 1), "no key configured"},
		"class without rungs": {set(pb.DataClass_OPTION_CHAIN, "alpaca", 1), "no providers on this bridge"},
		"version zero":        {set(q, "alpaca", 0), "version"},
	}
	for name, c := range cases {
		if !errors.Is(c.err, ErrInvalid) || !strings.Contains(c.err.Error(), c.want) {
			t.Errorf("%s: want ErrInvalid containing %q, got %v", name, c.want, c.err)
		}
	}
	if r.Routing().Source != pb.RoutingSource_ENV_DEFAULT {
		t.Fatal("a rejected request must leave the routing untouched")
	}
}

func TestSetRoutingIsAtomicAndVersioned(t *testing.T) {
	ib, lb, al := trio()
	r, _ := newRouter(ib, lb, al)
	bad := []*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "alpaca"}, {DataClass: pb.DataClass_EQUITY_BARS, Provider: "ibkr"}}
	if _, err := r.SetRouting(bad, 3); !errors.Is(err, ErrInvalid) || r.Preferred(pb.DataClass_EQUITY_QUOTES) != "ibkr" {
		t.Fatalf("one bad entry must reject the whole request: %v", err)
	}
	ok := []*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "alpaca"}}
	if _, err := r.SetRouting(ok, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := r.SetRouting(ok, 5); err != nil { // the reconciler re-sends: idempotent
		t.Fatalf("same version must be accepted: %v", err)
	}
	if _, err := r.SetRouting(ok, 4); !errors.Is(err, ErrStale) {
		t.Fatalf("lower version must be stale: %v", err)
	}
}

func TestConfiguredButDownPreferenceIsAcceptedAndFallsThrough(t *testing.T) {
	ib, lb, al := trio()
	ib.err = ErrUnavailable
	r, _ := newRouter(ib, lb, al)
	if _, err := r.Quotes(context.Background(), []string{"AAPL"}, ""); err != nil {
		t.Fatal(err) // marks ibkr down
	}
	if _, err := r.SetRouting([]*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "ibkr"}}, 2); err != nil {
		t.Fatalf("configured-but-down must be accepted: %v", err)
	}
	got, _ := r.Quotes(context.Background(), []string{"AAPL"}, "")
	if got.Served.Provider != "longbridge" || got.Served.Attempts[0].Provider != "ibkr" {
		t.Fatalf("must fall through while down: %+v", got.Served)
	}
}

func TestDownRungIsSkippedWithoutRetryStorm(t *testing.T) {
	ib, lb, al := trio()
	ib.err = ErrUnavailable
	r, clk := newRouter(ib, lb, al)
	ctx := context.Background()
	for i := 0; i < 50; i++ {
		if _, err := r.Quotes(ctx, []string{"AAPL"}, ""); err != nil {
			t.Fatal(err)
		}
	}
	if ib.calls != 1 {
		t.Fatalf("ibkr called %d times; a down rung must be skipped, not retried per request", ib.calls)
	}
	// Re-probe only when due, once per interval.
	r.ProbeOnce(ctx)
	if ib.probes != 0 {
		t.Fatal("probe before the interval elapsed")
	}
	clk.Advance(61 * time.Second)
	r.ProbeOnce(ctx)
	r.ProbeOnce(ctx)
	if ib.probes != 1 {
		t.Fatalf("want exactly one probe per interval, got %d", ib.probes)
	}
	// Probe failed: still down. Recovery: next due probe marks it up, and the next request uses it.
	ib.err = nil
	clk.Advance(61 * time.Second)
	r.ProbeOnce(ctx)
	got, _ := r.Quotes(ctx, []string{"AAPL"}, "")
	if got.Served.Provider != "ibkr" || got.Served.Fallback {
		t.Fatalf("recovered provider must serve again with no re-toggle: %+v", got.Served)
	}
}

func TestPinHasNoFallback(t *testing.T) {
	ib, lb, al := trio()
	ib.err = ErrUnavailable
	r, _ := newRouter(ib, lb, al)
	_, err := r.Quotes(context.Background(), []string{"AAPL"}, "ibkr")
	var re *RouteError
	if !errors.As(err, &re) || re.Kind != pb.ErrorKind_UNAVAILABLE || lb.calls+al.calls != 0 {
		t.Fatalf("pin must not fall back: %v", err)
	}
	if _, err := r.Quotes(context.Background(), []string{"AAPL"}, "marketdata_app"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("pin outside the ladder: %v", err)
	}
	got, err := r.Quotes(context.Background(), []string{"AAPL"}, "alpaca")
	if err != nil || got.Served.Provider != "alpaca" || got.Served.Fallback {
		t.Fatalf("a pinned answer is not a fallback: %+v %v", got, err)
	}
}

func TestOutageIsReportedAheadOfNoData(t *testing.T) {
	ib, lb, al := trio()
	ib.err, lb.err, al.err = ErrNoData, ErrUnavailable, ErrNoData
	r, _ := newRouter(ib, lb, al)
	_, err := r.Quotes(context.Background(), []string{"AAPL"}, "")
	var re *RouteError
	if !errors.As(err, &re) || re.Kind != pb.ErrorKind_UNAVAILABLE || len(re.Attempts) != 3 {
		t.Fatalf("want UNAVAILABLE ahead of NO_DATA with 3 attempts: %v", err)
	}
	ib2, lb2, al2 := trio()
	ib2.err, lb2.err, al2.err = ErrNoData, ErrNoData, ErrNoData
	r2, _ := newRouter(ib2, lb2, al2)
	_, err = r2.Quotes(context.Background(), []string{"ZZZZ"}, "")
	if !errors.As(err, &re) || re.Kind != pb.ErrorKind_NO_DATA {
		t.Fatalf("all NO_DATA: %v", err)
	}
}

func TestMissingSymbols(t *testing.T) {
	_, _, al := trio()
	al.symbols = []string{"AAPL"}
	r, _ := newRouter(al)
	got, err := r.Quotes(context.Background(), []string{"AAPL", "ZZZZ"}, "")
	if err != nil || len(got.Quotes) != 1 || strings.Join(got.Missing, ",") != "ZZZZ" {
		t.Fatalf("missing: %+v %v", got, err)
	}
}

func TestProvidersAndStatus(t *testing.T) {
	_, _, al := trio()
	al.configured = false
	r, clk := newRouter(al) // ibkr, longbridge named in the ladder but not built
	byName := map[string]*pb.ProviderHealth{}
	for _, p := range r.Providers() {
		byName[p.Provider] = p
	}
	if byName["ibkr"].State != pb.HealthState_HEALTH_STATE_NOT_CONFIGURED || byName["ibkr"].Reason != "not_registered" || byName["ibkr"].Configured {
		t.Fatalf("ibkr: %+v", byName["ibkr"])
	}
	if byName["alpaca"].Reason != "no_key" {
		t.Fatalf("alpaca without a key: %+v", byName["alpaca"])
	}
	al.configured = true
	if _, err := r.Quotes(context.Background(), []string{"AAPL"}, ""); err != nil {
		t.Fatal(err)
	}
	clk.Advance(time.Second)
	st := r.Status("test")
	var h *pb.ProviderHealth
	for _, p := range st.Providers {
		if p.Provider == "alpaca" {
			h = p
		}
	}
	if h.State != pb.HealthState_HEALTH_STATE_OK || h.Quality != pb.Quality_DELAYED_15M || h.Counters.Requests != 1 ||
		h.LastOk == nil || h.NewestTick == nil || st.Role != "bridge" || st.Build != "test" {
		t.Fatalf("alpaca status: %+v", h)
	}
	if st.Routing.Source != pb.RoutingSource_ENV_DEFAULT || st.Routing.Classes[0].Serving != "alpaca" {
		t.Fatalf("routing: %+v", st.Routing)
	}
	// Counters are a rolling window.
	clk.Advance(16 * time.Minute)
	for _, p := range r.Providers() {
		if p.Provider == "alpaca" && p.Counters.Requests != 0 {
			t.Fatalf("counters must roll off after 15 minutes: %+v", p.Counters)
		}
	}
}

func TestChangedFiresOnRoutingAndHealth(t *testing.T) {
	ib, lb, al := trio()
	r, _ := newRouter(ib, lb, al)
	ch := r.Changed()
	if _, err := r.SetRouting([]*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "alpaca"}}, 1); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ch:
	default:
		t.Fatal("SetRouting must wake watchers")
	}
	ch = r.Changed()
	al.err = ErrUnavailable
	_, _ = r.Quotes(context.Background(), []string{"AAPL"}, "")
	select {
	case <-ch:
	default:
		t.Fatal("mark-down must wake watchers")
	}
}
