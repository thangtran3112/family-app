// Package archive is the H1 write-once RAW history archive (02u §2, §3): GetBars reads through
// it. Bars of finished sessions are filled on read, written once, and never fetched again; the
// session still in progress passes through from the provider and is not stored.
package archive

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/xnys"
)

// Fetch is the provider path the archive reads through (router.Router.Bars).
type Fetch func(ctx context.Context, req *pb.GetBarsRequest) (*pb.GetBarsResponse, error)

type Archive struct {
	store Store
	log   *slog.Logger
	now   func() time.Time
	cal   *xnys.Calendar
}

func New(store Store, log *slog.Logger, now func() time.Time) *Archive {
	if log == nil {
		log = slog.Default()
	}
	if now == nil {
		now = time.Now
	}
	return &Archive{store: store, log: log, now: now, cal: xnys.Default()}
}

// finished reports whether a session's bars can no longer change: the extended session ends
// 20:00 ET, plus the 15-minute SIP embargo. This is later than 02u §2.1's "regular close plus the
// embargo" on purpose: a 1m session holds after-hours bars until 20:00 ET, and the archive is
// write-once, so archiving at 16:15 would freeze it incomplete forever.
func finished(date string, now time.Time) bool {
	d, err := time.ParseInLocation(xnys.DateFormat, date, xnys.NewYork)
	if err != nil {
		return false
	}
	return !now.Before(time.Date(d.Year(), d.Month(), d.Day(), 20, 15, 0, 0, xnys.NewYork))
}

// Bars answers from the archive where it can and asks fetch for the rest. Only RAW DAY_1 and
// MINUTE_1 are archived: a split rewrites adjusted history (02u §2.1), and a pinned provider is a
// diagnostic that must reach that provider. Everything else passes through. A store failure never
// fails a request: the answer then comes from the provider alone (02u §3.2, archive down).
func (a *Archive) Bars(ctx context.Context, req *pb.GetBarsRequest, fetch Fetch) (*pb.GetBarsResponse, error) {
	tf := router.CalendarTimeframe(req.Timeframe)
	if req.Adjustment != pb.Adjustment_RAW || req.PinProvider != "" || (tf != xnys.TimeframeDay && tf != xnys.TimeframeMin) {
		return a.passthrough(ctx, req, fetch)
	}
	now := a.now().UTC()
	start, end := req.Start.AsTime(), req.End.AsTime()
	first, last := a.cal.SessionDate(start), a.cal.SessionDate(end)
	dates := a.sessionDates(first, last)
	if len(dates) == 0 {
		return a.passthrough(ctx, req, fetch)
	}

	// `finished` parses its date, so ask it once per date and reuse the answer below.
	isFinished := make([]bool, len(dates))
	var fin []string
	for i, d := range dates {
		if isFinished[i] = finished(d, now); isFinished[i] {
			fin = append(fin, d)
		}
	}
	covered, err := a.covered(ctx, req.Symbol, tf, fin)
	if err != nil {
		a.log.Warn("archive read failed; serving from the provider", "symbol", req.Symbol, "error", err.Error())
		return a.passthrough(ctx, req, fetch)
	}
	have := make(map[string]bool, len(covered))
	for _, s := range covered {
		have[s.Date] = true
	}
	// Dates the provider must answer: finished sessions not yet archived, and today's open one.
	// A date after today has no bars yet and is not asked for.
	today := a.cal.SessionDate(now)
	var need, toStore []string
	for i, d := range dates {
		switch {
		case isFinished[i] && !have[d]:
			need, toStore = append(need, d), append(toStore, d)
		case !isFinished[i] && d <= today:
			need = append(need, d)
		}
	}

	var fetched []*pb.Bar
	var served *pb.Served
	if len(need) > 0 {
		resp, err := fetch(ctx, a.fetchRequest(req, need[0], need[len(need)-1], now))
		var re *router.RouteError
		switch {
		case err == nil:
			fetched, served = resp.Bars, resp.Served
			if err := a.record(ctx, req.Symbol, tf, toStore, resp); err != nil {
				a.log.Warn("archive write failed; the answer is unaffected", "symbol", req.Symbol, "error", err.Error())
			}
		case errors.As(err, &re) && re.Kind == pb.ErrorKind_NO_DATA && len(covered) > 0:
			served = &pb.Served{Attempts: re.Attempts} // nothing new to add; the archive answers
		default:
			return nil, err
		}
	}

	bars := a.merge(covered, fetched, req, tf, first, last)
	if len(bars) == 0 {
		return nil, &router.RouteError{Kind: pb.ErrorKind_NO_DATA,
			Summary: fmt.Sprintf("no bars for %s in the window", req.Symbol)}
	}
	if served == nil || served.Provider == "" {
		// Served from the archive alone (or the live rung had nothing): the vendor that filled it.
		attempts := served.GetAttempts()
		served = &pb.Served{Provider: covered[0].Provider, Quality: pb.Quality_EOD, Attempts: attempts}
	}
	return &pb.GetBarsResponse{Symbol: req.Symbol, Bars: bars, Served: served}, nil
}

// covered reads the archived sessions among fin, the finished session dates in order (only finished ones can be
// archived).
func (a *Archive) covered(ctx context.Context, symbol, tf string, fin []string) ([]Session, error) {
	if len(fin) == 0 {
		return nil, nil
	}
	return a.store.Read(ctx, symbol, tf, fin[0], fin[len(fin)-1])
}

func (a *Archive) passthrough(ctx context.Context, req *pb.GetBarsRequest, fetch Fetch) (*pb.GetBarsResponse, error) {
	resp, err := fetch(ctx, req)
	if err == nil {
		markSource(resp.Bars, pb.BarSource_PROVIDER)
	}
	return resp, err
}

func markSource(bars []*pb.Bar, s pb.BarSource) {
	for _, b := range bars {
		b.Source = s
	}
}

// sessionDates lists the XNYS sessions from first to last (ET dates, inclusive), clamped to the
// embedded calendar: a date outside it is not a session, and a far-future end must not loop.
func (a *Archive) sessionDates(first, last string) []string {
	first, last = max(first, a.cal.First()), min(last, a.cal.Last())
	var out []string
	for d, _ := time.ParseInLocation(xnys.DateFormat, first, xnys.NewYork); ; d = d.AddDate(0, 0, 1) {
		day := d.Format(xnys.DateFormat) // once per calendar day; the lookup takes the string, not an instant
		if day > last {
			break
		}
		if a.cal.IsSessionDate(day) {
			out = append(out, day)
		}
	}
	return out
}

func finishedOf(dates []string, now time.Time) []string {
	var out []string
	for _, d := range dates {
		if finished(d, now) {
			out = append(out, d)
		}
	}
	return out
}

// fetchRequest widens the caller's window to whole ET days from the first to the last date to
// fill (a stored session must be the whole session, however little the caller asked for) and
// lifts as_of to now: the archive keeps every closed bar, and the server cuts the answer to the
// caller's as_of afterwards.
func (a *Archive) fetchRequest(req *pb.GetBarsRequest, from, to string, now time.Time) *pb.GetBarsRequest {
	f, _ := time.ParseInLocation(xnys.DateFormat, from, xnys.NewYork)
	t, _ := time.ParseInLocation(xnys.DateFormat, to, xnys.NewYork)
	return &pb.GetBarsRequest{
		Symbol: req.Symbol, Timeframe: req.Timeframe, Adjustment: pb.Adjustment_RAW,
		Start: timestamppb.New(f.UTC()), End: timestamppb.New(t.AddDate(0, 0, 1).Add(-time.Second).UTC()),
		AsOf: timestamppb.New(now),
	}
}

// record writes the fetched finished sessions. A date the provider returned nothing for is a
// quiet session (bar_count 0) and is recorded as complete (02u §3.2).
func (a *Archive) record(ctx context.Context, symbol, tf string, dates []string, resp *pb.GetBarsResponse) error {
	if len(dates) == 0 {
		return nil
	}
	sessions := make([]Session, len(dates))
	idx := map[string]int{}
	for i, d := range dates {
		sessions[i] = Session{Date: d, Provider: resp.Served.GetProvider()}
		idx[d] = i
	}
	for _, b := range resp.Bars {
		if i, ok := idx[b.SessionDate]; ok {
			sessions[i].Bars = append(sessions[i].Bars, b)
		}
	}
	return a.store.Write(ctx, symbol, tf, sessions)
}

// merge is the archive's bars for the covered sessions plus the provider's for every other date,
// cut to the caller's window. The archive wins where both have a date (02u §5.2: a vendor
// revision never shows).
func (a *Archive) merge(covered []Session, fetched []*pb.Bar, req *pb.GetBarsRequest, tf, first, last string) []*pb.Bar {
	n := len(fetched)
	for _, s := range covered {
		n += len(s.Bars)
	}
	out := make([]*pb.Bar, 0, n) // every bar of both sources can land here: size once, no append regrowth
	have := make(map[string]bool, len(covered))
	for _, s := range covered {
		have[s.Date] = true
		for _, b := range s.Bars {
			b.Source = pb.BarSource_ARCHIVE
			if c, ok := a.cal.BarClose(tf, b.Start.AsTime()); ok {
				b.CloseAt = timestamppb.New(c)
			}
			out = append(out, b)
		}
	}
	for _, b := range fetched {
		if !have[b.SessionDate] {
			b.Source = pb.BarSource_PROVIDER
			out = append(out, b)
		}
	}
	start, end := req.Start.AsTime(), req.End.AsTime()
	kept := out[:0]
	for _, b := range out {
		in := b.SessionDate >= first && b.SessionDate <= last
		if tf == xnys.TimeframeMin {
			in = !b.Start.AsTime().Before(start) && !b.Start.AsTime().After(end)
		}
		if in {
			kept = append(kept, b)
		}
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].Start.AsTime().Before(kept[j].Start.AsTime()) })
	return kept
}
