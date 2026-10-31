package router

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/config"
)

const counterWindow = 15 * time.Minute

type Options struct {
	Role      string
	Ladders   map[pb.DataClass][]string // the env ladders: default routing and allowlist
	Providers []Provider
	Now       func() time.Time // default time.Now
	// ProbeInterval overrides the re-probe period for every provider (tests).
	// Default: 30 s, 60 s for ibkr (02t §3.5; matches RETRY_AFTER_S).
	ProbeInterval time.Duration
}

type event struct {
	at       time.Time
	ms       int32
	err      bool
	fallback bool
}

type stat struct {
	down      bool
	downKind  pb.ErrorKind
	reason    string
	lastProbe time.Time
	lastOK    time.Time
	newest    time.Time
	events    []event
}

type Router struct {
	role       string
	ladders    map[pb.DataClass][]string
	providers  map[string]Provider
	now        clock
	probeEvery time.Duration

	mu      sync.Mutex
	prefs   map[pb.DataClass]string
	version int64
	source  pb.RoutingSource
	stats   map[string]*stat
	changed chan struct{}
}

func New(o Options) *Router {
	r := &Router{
		role:       o.Role,
		ladders:    o.Ladders,
		providers:  map[string]Provider{},
		now:        o.Now,
		probeEvery: o.ProbeInterval,
		prefs:      map[pb.DataClass]string{},
		source:     pb.RoutingSource_ENV_DEFAULT,
		stats:      map[string]*stat{},
		changed:    make(chan struct{}),
	}
	if r.now == nil {
		r.now = time.Now
	}
	for _, p := range o.Providers {
		r.providers[p.Name()] = p
	}
	return r
}

func (r *Router) Role() string { return r.role }

// Changed returns a channel closed on the next routing or health change.
func (r *Router) Changed() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.changed
}

func (r *Router) notifyLocked() {
	close(r.changed)
	r.changed = make(chan struct{})
}

func (r *Router) statLocked(name string) *stat {
	s := r.stats[name]
	if s == nil {
		s = &stat{}
		r.stats[name] = s
	}
	return s
}

// orderLocked is the class ladder with the preference moved to the head.
func (r *Router) orderLocked(c pb.DataClass) []string {
	ladder := r.ladders[c]
	pref := r.prefs[c]
	if pref == "" {
		return ladder
	}
	out := []string{pref}
	for _, n := range ladder {
		if n != pref {
			out = append(out, n)
		}
	}
	return out
}

// Preferred is the class's preferred provider: the preference, else the first env rung.
func (r *Router) Preferred(c pb.DataClass) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if o := r.orderLocked(c); len(o) > 0 {
		return o[0]
	}
	return ""
}

// skipLocked says why a rung cannot be tried right now, or nil when it can.
func (r *Router) skipLocked(name string, c pb.DataClass) *pb.Attempt {
	p := r.providers[name]
	switch {
	case p == nil:
		return &pb.Attempt{Provider: name, Error: pb.ErrorKind_NOT_CONFIGURED, Message: "not built into this bridge"}
	case !p.Configured():
		return &pb.Attempt{Provider: name, Error: pb.ErrorKind_NOT_CONFIGURED, Message: "no key configured"}
	case !serves(p, c):
		return &pb.Attempt{Provider: name, Error: pb.ErrorKind_NOT_CONFIGURED, Message: "not registered for " + config.ClassName(c)}
	}
	if s := r.stats[name]; s != nil && s.down {
		return &pb.Attempt{Provider: name, Error: s.downKind, Message: "marked down (" + s.reason + "); skipped until the next probe succeeds"}
	}
	return nil
}

func serves(p Provider, c pb.DataClass) bool {
	for _, x := range p.Classes() {
		if x == c {
			return true
		}
	}
	return false
}

// route walks the ladder (02j §6 first_success): every error falls through,
// and when every rung fails an outage is reported ahead of NO_DATA.
func (r *Router) route(ctx context.Context, c pb.DataClass, pin string, try func(Provider) (pb.Quality, error)) (*pb.Served, error) {
	r.mu.Lock()
	order := r.orderLocked(c)
	if len(order) == 0 {
		r.mu.Unlock()
		return nil, fmt.Errorf("%w: %s has no providers on this bridge", ErrInvalid, config.ClassName(c))
	}
	preferred := order[0]
	if pin != "" {
		if !contains(r.ladders[c], pin) {
			r.mu.Unlock()
			return nil, fmt.Errorf("%w: pin_provider %q is not in the %s ladder", ErrInvalid, pin, config.ClassName(c))
		}
		order = []string{pin}
	}
	r.mu.Unlock()

	var attempts []*pb.Attempt
	for _, name := range order {
		r.mu.Lock()
		skip := r.skipLocked(name, c)
		p := r.providers[name]
		r.mu.Unlock()
		if skip != nil {
			attempts = append(attempts, skip)
			continue
		}
		start := r.now()
		q, err := try(p)
		ms := int32(r.now().Sub(start) / time.Millisecond)
		if err == nil {
			fallback := pin == "" && name != preferred
			r.record(name, ms, nil, fallback)
			served := &pb.Served{Provider: name, Quality: q, Fallback: fallback, Attempts: attempts}
			if fallback && len(attempts) > 0 {
				served.FallbackReason = attempts[0].Provider + ": " + attempts[0].Message
			}
			return served, nil
		}
		if ctx.Err() != nil { // the caller left; not the provider's fault
			return nil, ctx.Err()
		}
		r.record(name, ms, err, false)
		attempts = append(attempts, &pb.Attempt{Provider: name, Error: kindOf(err), Message: messageOf(err)})
	}
	return nil, &RouteError{Kind: worst(attempts), Attempts: attempts}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// record updates counters and the health cache. Only an outage or soft ban
// marks a rung down; NO_DATA and NOT_ENTITLED are answers about the request.
func (r *Router) record(name string, ms int32, err error, fallback bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	s := r.statLocked(name)
	s.events = append(s.events, event{at: now, ms: ms, err: err != nil, fallback: fallback})
	s.trimLocked(now)
	if err == nil {
		s.lastOK = now
		if s.down {
			s.down = false
			r.notifyLocked()
		}
		return
	}
	if k := kindOf(err); (k == pb.ErrorKind_UNAVAILABLE || k == pb.ErrorKind_SOFT_BANNED) && !s.down {
		s.down, s.downKind, s.lastProbe = true, k, now
		s.reason = strings.ToLower(k.String())
		r.notifyLocked()
	}
}

func (s *stat) trimLocked(now time.Time) {
	i := 0
	for i < len(s.events) && now.Sub(s.events[i].at) > counterWindow {
		i++
	}
	s.events = s.events[i:]
	if len(s.events) > 4096 { // ponytail: cap bounds memory under load; counters then cover less than 15 min
		s.events = s.events[len(s.events)-4096:]
	}
}

func (r *Router) interval(name string) time.Duration {
	switch {
	case r.probeEvery > 0:
		return r.probeEvery
	case name == "ibkr":
		return 60 * time.Second
	}
	return 30 * time.Second
}

// ProbeOnce re-probes every marked-down provider that is due. One caller, one
// probe per provider per interval: a down provider costs no request traffic.
func (r *Router) ProbeOnce(ctx context.Context) {
	r.mu.Lock()
	var due []Provider
	now := r.now()
	for name, s := range r.stats {
		if s.down && now.Sub(s.lastProbe) >= r.interval(name) && r.providers[name] != nil {
			s.lastProbe = now
			due = append(due, r.providers[name])
		}
	}
	r.mu.Unlock()
	sort.Slice(due, func(i, j int) bool { return due[i].Name() < due[j].Name() })
	for _, p := range due {
		pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := p.Probe(pctx)
		cancel()
		if err == nil {
			r.markUp(p.Name())
		}
	}
}

func (r *Router) markUp(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.statLocked(name); s.down {
		s.down, s.lastOK = false, r.now()
		r.notifyLocked()
	}
}

// Run drives ProbeOnce until ctx ends.
func (r *Router) Run(ctx context.Context) {
	tick := 5 * time.Second
	if r.probeEvery > 0 && r.probeEvery < tick {
		tick = r.probeEvery
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.ProbeOnce(ctx)
		}
	}
}

func (r *Router) Quotes(ctx context.Context, symbols []string, pin string) (*pb.GetQuotesResponse, error) {
	var quotes []*pb.Quote
	served, err := r.route(ctx, pb.DataClass_EQUITY_QUOTES, pin, func(p Provider) (pb.Quality, error) {
		qp, ok := p.(QuoteProvider)
		if !ok {
			return 0, fmt.Errorf("%w: %s has no quote support", ErrNotConfigured, p.Name())
		}
		qs, err := qp.Quotes(ctx, symbols)
		if err != nil {
			return 0, err
		}
		if len(qs) == 0 {
			return 0, fmt.Errorf("%w: none of the symbols has a quote", ErrNoData)
		}
		quotes = qs
		// The label is the serving provider's own, never upgraded: take the
		// least fresh quality among the quotes.
		q := qs[0].Quality
		for _, x := range qs {
			if x.Quality > q {
				q = x.Quality
			}
		}
		return q, nil
	})
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	var newest time.Time
	for _, q := range quotes {
		have[q.Symbol] = true
		if t := q.AsOf.AsTime(); t.After(newest) {
			newest = t
		}
	}
	var missing []string
	for _, s := range symbols {
		if !have[s] {
			missing = append(missing, s)
		}
	}
	r.mu.Lock()
	if s := r.statLocked(served.Provider); newest.After(s.newest) {
		s.newest = newest
	}
	r.mu.Unlock()
	return &pb.GetQuotesResponse{Quotes: quotes, Missing: missing, Served: served}, nil
}

func (r *Router) Bars(ctx context.Context, req *pb.GetBarsRequest) (*pb.GetBarsResponse, error) {
	var bars []*pb.Bar
	served, err := r.route(ctx, pb.DataClass_EQUITY_BARS, req.PinProvider, func(p Provider) (pb.Quality, error) {
		bp, ok := p.(BarsProvider)
		if !ok {
			return 0, fmt.Errorf("%w: %s has no bars support", ErrNotConfigured, p.Name())
		}
		bs, q, err := bp.Bars(ctx, req)
		if err != nil {
			return 0, err
		}
		if len(bs) == 0 {
			return 0, fmt.Errorf("%w: no closed bars for %s in the window", ErrNoData, req.Symbol)
		}
		bars = bs
		return q, nil
	})
	if err != nil {
		return nil, err
	}
	return &pb.GetBarsResponse{Symbol: req.Symbol, Bars: bars, Served: served}, nil
}

// Routing returns the cached routing with who would answer each class now.
func (r *Router) Routing() *pb.Routing {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.routingLocked()
}

func (r *Router) routingLocked() *pb.Routing {
	out := &pb.Routing{Version: r.version, Source: r.source}
	for _, c := range []pb.DataClass{pb.DataClass_EQUITY_QUOTES, pb.DataClass_EQUITY_BARS, pb.DataClass_OPTION_CHAIN} {
		ladder := r.ladders[c]
		if len(ladder) == 0 {
			continue
		}
		cr := &pb.ClassRouting{DataClass: c, Preferred: r.prefs[c], Ladder: append([]string(nil), ladder...)}
		for _, name := range r.orderLocked(c) {
			if r.skipLocked(name, c) == nil {
				cr.Serving = name
				break
			}
		}
		out.Classes = append(out.Classes, cr)
	}
	return out
}

// SetRouting validates the whole request, then applies it. The env ladder is
// the allowlist, so a preference only reorders a ladder; it can never add a
// provider (02t §3.5). A provider that is configured but down is accepted:
// the router falls through and uses it again on recovery.
func (r *Router) SetRouting(prefs []*pb.ClassPreference, version int64) (*pb.Routing, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if version < 1 {
		return nil, fmt.Errorf("%w: version must be the Desk's routing version (>= 1)", ErrInvalid)
	}
	if r.source == pb.RoutingSource_DESK && version < r.version {
		return nil, fmt.Errorf("%w: have version %d, got %d", ErrStale, r.version, version)
	}
	next := map[pb.DataClass]string{}
	for _, p := range prefs {
		c, name := p.DataClass, strings.ToLower(strings.TrimSpace(p.Provider))
		cn := config.ClassName(c)
		ladder := r.ladders[c]
		switch {
		case len(ladder) == 0:
			return nil, fmt.Errorf("%w: %s has no providers on this bridge", ErrInvalid, cn)
		case name == "":
			// clears the preference
		case config.Known[name] == nil:
			return nil, fmt.Errorf("%w: %q is not a known provider", ErrInvalid, name)
		case !contains(ladder, name):
			return nil, fmt.Errorf("%w: %q is not in the %s ladder (%s)", ErrInvalid, name, cn, strings.Join(ladder, ", "))
		case r.providers[name] == nil || !serves(r.providers[name], c):
			return nil, fmt.Errorf("%w: %q is not registered for %s on this bridge", ErrInvalid, name, cn)
		case !r.providers[name].Configured():
			return nil, fmt.Errorf("%w: %q has no key configured", ErrInvalid, name)
		}
		next[c] = name
	}
	for c, name := range next {
		if name == "" {
			delete(r.prefs, c)
		} else {
			r.prefs[c] = name
		}
	}
	r.version, r.source = version, pb.RoutingSource_DESK
	r.notifyLocked()
	return r.routingLocked(), nil
}

// Providers reports every provider named in a ladder or registered, sorted by name.
func (r *Router) Providers() []*pb.ProviderHealth {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.providersLocked()
}

func (r *Router) providersLocked() []*pb.ProviderHealth {
	names := map[string]bool{}
	for _, l := range r.ladders {
		for _, n := range l {
			names[n] = true
		}
	}
	for n := range r.providers {
		names[n] = true
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)

	now := r.now()
	var out []*pb.ProviderHealth
	for _, name := range sorted {
		p, s := r.providers[name], r.stats[name]
		h := &pb.ProviderHealth{Provider: name}
		switch {
		case p == nil:
			h.State, h.Reason = pb.HealthState_HEALTH_STATE_NOT_CONFIGURED, "not_registered"
		case !p.Configured():
			h.Classes = p.Classes()
			h.State, h.Reason = pb.HealthState_HEALTH_STATE_NOT_CONFIGURED, "no_key"
		default:
			h.Classes, h.Configured = p.Classes(), true
			ph := p.Health()
			h.State, h.Reason, h.Quality = ph.State, ph.Reason, ph.Quality
			if s != nil && s.down {
				h.State, h.Reason = pb.HealthState_HEALTH_STATE_DOWN, s.reason
			}
		}
		if s != nil {
			if !s.lastOK.IsZero() {
				h.LastOk = timestamppb.New(s.lastOK)
			}
			if !s.newest.IsZero() {
				h.NewestTick = timestamppb.New(s.newest)
			}
			s.trimLocked(now)
			h.Counters = s.counters()
		}
		out = append(out, h)
	}
	return out
}

func (s *stat) counters() *pb.Counters {
	c := &pb.Counters{}
	var ms []int
	for _, e := range s.events {
		c.Requests++
		if e.err {
			c.Errors++
		} else {
			ms = append(ms, int(e.ms))
		}
		if e.fallback {
			c.Fallbacks++
		}
	}
	sort.Ints(ms)
	if n := len(ms); n > 0 {
		c.P50Ms, c.P95Ms = int32(ms[(n-1)/2]), int32(ms[(n*95+99)/100-1])
	}
	return c
}

// Status is the GetStatus / WatchStatus payload.
func (r *Router) Status(build string) *pb.BridgeStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	return &pb.BridgeStatus{
		At:        timestamppb.New(r.now()),
		Role:      r.role,
		Providers: r.providersLocked(),
		Routing:   r.routingLocked(),
		Build:     build,
	}
}
