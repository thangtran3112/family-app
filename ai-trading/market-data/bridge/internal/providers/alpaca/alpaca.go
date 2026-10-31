// Package alpaca is the Alpaca Market Data adapter (quotes and bars), ported
// from ai_trading_common.providers.alpaca. It targets the free Basic plan,
// whose SIP data is withheld for 15 minutes, so every answer is stamped
// delayed-15m (daily bars: eod). Nothing here is ever labeled realtime
// (02b §2): Basic's real-time IEX feed covers about 2-3% of volume.
//
// Read-only: market-data GETs only. No order, position, or account call exists.
package alpaca

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"time"
	_ "time/tzdata" // the distroless static image's zoneinfo is not guaranteed

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
)

const (
	Name        = "alpaca"
	DefaultBase = "https://data.alpaca.markets/v2/stocks"
	// The free plan withholds the latest 15 minutes of consolidated data; a
	// request ending inside that window is capped to its edge.
	embargo = 15 * time.Minute
	// The free plan allows 200 requests a minute (02b §2 finding 4).
	defaultMinInterval = 300 * time.Millisecond
	maxPages           = 50
	maxBody            = 32 << 20
)

var newYork = mustLoad("America/New_York")

func mustLoad(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

type Client struct {
	keyID, secret string
	base          string
	http          *http.Client
	now           func() time.Time
	minInterval   time.Duration

	mu   sync.Mutex
	next time.Time // earliest start of the next request (the 200/min throttle)
}

type Option func(*Client)

func WithBaseURL(u string) Option           { return func(c *Client) { c.base = u } }
func WithHTTPClient(h *http.Client) Option  { return func(c *Client) { c.http = h } }
func WithClock(now func() time.Time) Option { return func(c *Client) { c.now = now } }
func WithMinInterval(d time.Duration) Option {
	return func(c *Client) { c.minInterval = d }
}

func New(keyID, secret string, opts ...Option) *Client {
	c := &Client{
		keyID: keyID, secret: secret, base: DefaultBase,
		http: &http.Client{Timeout: 30 * time.Second}, now: time.Now, minInterval: defaultMinInterval,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

func (c *Client) Name() string { return Name }
func (c *Client) Classes() []pb.DataClass {
	return []pb.DataClass{pb.DataClass_EQUITY_QUOTES, pb.DataClass_EQUITY_BARS}
}
func (c *Client) Configured() bool { return c.keyID != "" && c.secret != "" }

func (c *Client) Health() router.Health {
	if !c.Configured() {
		return router.Health{State: pb.HealthState_HEALTH_STATE_NOT_CONFIGURED, Reason: "no_key"}
	}
	return router.Health{State: pb.HealthState_HEALTH_STATE_OK, Quality: pb.Quality_DELAYED_15M}
}

// Probe is one cheap one-bar request. "No data" still proves the service answered.
func (c *Client) Probe(ctx context.Context) error {
	_, err := c.latestBar(ctx, "SPY")
	if errors.Is(err, router.ErrNoData) {
		return nil
	}
	return err
}

// Quotes returns the close of each symbol's newest closed 1-minute bar inside
// the SIP embargo (15 minutes old at best, delayed-15m). A symbol with no bar
// in the last week is left out, not an error. Bid and ask are never set.
func (c *Client) Quotes(ctx context.Context, symbols []string) ([]*pb.Quote, error) {
	var out []*pb.Quote
	for _, sym := range symbols {
		bar, err := c.latestBar(ctx, sym)
		if errors.Is(err, router.ErrNoData) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if bar == nil {
			continue
		}
		out = append(out, &pb.Quote{Symbol: sym, Last: bar.C, AsOf: timestamppb.New(bar.T), Quality: pb.Quality_DELAYED_15M, Provider: Name})
	}
	return out, nil
}

func (c *Client) latestBar(ctx context.Context, symbol string) (*barJSON, error) {
	end := c.now().UTC().Add(-embargo)
	q := url.Values{
		"timeframe": {"1Min"}, "start": {end.Add(-7 * 24 * time.Hour).Format(time.RFC3339)}, "end": {end.Format(time.RFC3339)},
		"adjustment": {"all"}, "feed": {"sip"}, "sort": {"desc"}, "limit": {"1"},
	}
	page, err := c.get(ctx, symbol, q)
	if err != nil || len(page.Bars) == 0 {
		return nil, err
	}
	if !valid(page.Bars[0]) {
		return nil, fmt.Errorf("%w: malformed bar for %s", router.ErrUnavailable, symbol)
	}
	return &page.Bars[0], nil
}

var (
	timeframes  = map[pb.Timeframe]string{pb.Timeframe_MINUTE_1: "1Min", pb.Timeframe_HOUR_1: "1Hour", pb.Timeframe_DAY_1: "1Day"}
	adjustments = map[pb.Adjustment]string{pb.Adjustment_ADJUSTMENT_UNSPECIFIED: "all", pb.Adjustment_ALL: "all", pb.Adjustment_SPLIT: "split", pb.Adjustment_RAW: "raw"}
)

// Bars returns closed bars only: the end is capped to the SIP embargo, rows
// that fail hygiene are dropped (one bad print must not blank a good history),
// and a bar whose period has not ended is never returned (no repainting).
func (c *Client) Bars(ctx context.Context, r *pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error) {
	tf, ok := timeframes[r.Timeframe]
	if !ok {
		return nil, 0, fmt.Errorf("%w: unsupported timeframe %s", router.ErrNoData, r.Timeframe)
	}
	quality := pb.Quality_DELAYED_15M
	if r.Timeframe == pb.Timeframe_DAY_1 {
		quality = pb.Quality_EOD
	}
	now := c.now().UTC()
	start, end := r.Start.AsTime(), r.End.AsTime()
	if capped := now.Add(-embargo); end.After(capped) {
		end = capped
	}
	if end.Before(start) {
		return nil, quality, nil
	}
	q := url.Values{
		"timeframe": {tf}, "start": {start.Format(time.RFC3339)}, "end": {end.Format(time.RFC3339)},
		"adjustment": {adjustments[r.Adjustment]}, "feed": {"sip"}, "limit": {"10000"},
	}
	var rows []barJSON
	for i := 0; ; i++ {
		page, err := c.get(ctx, r.Symbol, q)
		if err != nil {
			return nil, 0, err
		}
		rows = append(rows, page.Bars...)
		if page.NextPageToken == nil || *page.NextPageToken == "" {
			break
		}
		if i >= maxPages {
			return nil, 0, fmt.Errorf("%w: more than %d pages for %s", router.ErrUnavailable, maxPages, r.Symbol)
		}
		q.Set("page_token", *page.NextPageToken)
	}
	return toBars(rows, r.Timeframe, now), quality, nil
}

func toBars(rows []barJSON, tf pb.Timeframe, now time.Time) []*pb.Bar {
	byStart := map[int64]barJSON{} // duplicates: keep the last
	for _, b := range rows {
		if valid(b) && closed(b.T, tf, now) {
			byStart[b.T.UnixNano()] = b
		}
	}
	keys := make([]int64, 0, len(byStart))
	for k := range byStart {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := make([]*pb.Bar, 0, len(keys))
	for _, k := range keys {
		b := byStart[k]
		out = append(out, &pb.Bar{Start: timestamppb.New(b.T), Open: b.O, High: b.H, Low: b.L, Close: b.C, Volume: int64(b.V)})
	}
	return out
}

func valid(b barJSON) bool {
	return b.O > 0 && b.H > 0 && b.L > 0 && b.C > 0 && b.H >= b.L && b.V >= 0
}

// closed reports whether the bar's period has ended by now. A daily bar closes
// at 16:00 ET of its date; half days close at 13:00, so this errs late, never
// early. ponytail: no exchange calendar; add one if a half-day close is needed.
func closed(start time.Time, tf pb.Timeframe, now time.Time) bool {
	switch tf {
	case pb.Timeframe_MINUTE_1:
		return !start.Add(time.Minute).After(now)
	case pb.Timeframe_HOUR_1:
		return !start.Add(time.Hour).After(now)
	}
	et := start.In(newYork)
	return !time.Date(et.Year(), et.Month(), et.Day(), 16, 0, 0, 0, newYork).After(now)
}

type barJSON struct {
	T time.Time `json:"t"`
	O float64   `json:"o"`
	H float64   `json:"h"`
	L float64   `json:"l"`
	C float64   `json:"c"`
	V float64   `json:"v"`
}

type barsPage struct {
	Bars          []barJSON `json:"bars"`
	NextPageToken *string   `json:"next_page_token"`
}

func (c *Client) throttle(ctx context.Context) error {
	c.mu.Lock()
	at := c.next
	if now := time.Now(); at.Before(now) {
		at = now
	}
	c.next = at.Add(c.minInterval)
	c.mu.Unlock()
	select {
	case <-time.After(time.Until(at)):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Client) get(ctx context.Context, symbol string, q url.Values) (*barsPage, error) {
	if !c.Configured() {
		return nil, fmt.Errorf("%w: no API key", router.ErrNotConfigured)
	}
	if err := c.throttle(ctx); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/"+url.PathEscape(symbol)+"/bars?"+q.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", router.ErrUnavailable, err)
	}
	req.Header.Set("APCA-API-KEY-ID", c.keyID)
	req.Header.Set("APCA-API-SECRET-KEY", c.secret)
	req.Header.Set("User-Agent", "family-app-market-data-bridge/0.1")
	resp, err := c.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) { // *url.Error carries the URL; keep only the cause
			err = ue.Err
		}
		return nil, fmt.Errorf("%w: Alpaca unreachable: %v", router.ErrUnavailable, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, fmt.Errorf("%w: reading response: %v", router.ErrUnavailable, err)
	}
	switch s := resp.StatusCode; {
	case s == http.StatusOK:
	case s == http.StatusUnauthorized || s == http.StatusForbidden:
		return nil, fmt.Errorf("%w: key rejected (HTTP %d)", router.ErrNotConfigured, s)
	case s == http.StatusTooManyRequests:
		return nil, fmt.Errorf("%w: rate limited (HTTP 429)", router.ErrSoftBanned)
	case s == http.StatusNotFound || s == http.StatusBadRequest || s == http.StatusUnprocessableEntity:
		// About this request, not the service: must not mark Alpaca down.
		return nil, fmt.Errorf("%w: unknown symbol or bad request for %s (HTTP %d)", router.ErrNoData, symbol, s)
	default:
		return nil, fmt.Errorf("%w: HTTP %d", router.ErrUnavailable, s)
	}
	var page barsPage
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, fmt.Errorf("%w: malformed JSON body", router.ErrUnavailable)
	}
	return &page, nil
}
