package cache

import (
	"time"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/xnys"
)

// The TTL table. Constants, not config: none of it varies per environment. Every policy function is
// pure in (data, now), so the table is tested row by row. A zero TTL means "do not cache".
const (
	ttlQuoteLive    = 30 * time.Second // DELAYED_15M while its session is still moving
	ttlQuoteSettled = 5 * time.Minute  // DELAYED_15M once the session is finished
	ttlQuoteEOD     = 10 * time.Minute // EOD
	ttlOpenBars     = 60 * time.Second // a window the open (or a future) session touches
	ttlSettledRaw   = 30 * 24 * time.Hour
	ttlArchived     = 10 * time.Minute // RAW 1d/1m when the Postgres archive owns the history
	ttlAdjustedMin  = 5 * time.Minute
	ttlAdjustedMax  = 24 * time.Hour
	adjustedRefresh = 4 // ET hour of the daily adjusted-bar refresh, before the extended open
)

// quoteTTL is the TTL of one quote, from the data it carries.
func quoteTTL(q *pb.Quote, now time.Time) time.Duration {
	switch q.Quality {
	case pb.Quality_EOD:
		return ttlQuoteEOD
	case pb.Quality_DELAYED_15M:
		if q.AsOf == nil {
			return 0
		}
		if xnys.SessionFinished(xnys.Default().SessionDate(q.AsOf.AsTime()), now) {
			return ttlQuoteSettled
		}
		return ttlQuoteLive
	}
	return 0 // REALTIME (would defeat realtime) and anything unlabelled
}

// adjustmentName maps the wire adjustment onto the key vocabulary; UNSPECIFIED is ALL, as the
// Alpaca adapter treats it.
func adjustmentName(a pb.Adjustment) (string, bool) {
	switch a {
	case pb.Adjustment_RAW:
		return "raw", true
	case pb.Adjustment_SPLIT:
		return "split", true
	case pb.Adjustment_ALL, pb.Adjustment_ADJUSTMENT_UNSPECIFIED:
		return "all", true
	}
	return "", false
}

func timeframeName(tf pb.Timeframe) (string, bool) {
	name := router.CalendarTimeframe(tf)
	return name, name != ""
}

// settled reports whether every session up to endDate is finished: nothing in the window can still
// change. A weekend or holiday end date counts as the session before it. A date outside the
// embedded calendar is never settled.
func settled(endDate string, now time.Time) bool {
	cal := xnys.Default()
	if endDate < cal.First() || endDate > cal.Last() {
		return false
	}
	d := endDate
	for i := 0; i < 10 && !cal.IsSessionDate(d); i++ {
		t, _ := time.ParseInLocation(xnys.DateFormat, d, xnys.NewYork)
		d = t.AddDate(0, 0, -1).Format(xnys.DateFormat)
	}
	today := cal.SessionDate(now)
	return d < today || (d == today && xnys.SessionFinished(d, now))
}

// barsTTL is the TTL of one bars window and whether the entry is immutable (written once, SET NX).
// endDate is the ET date of the window's end.
func barsTTL(tf pb.Timeframe, adj pb.Adjustment, endDate string, archiveOn bool, now time.Time) (ttl time.Duration, immutable bool) {
	tfName, ok := timeframeName(tf)
	if !ok {
		return 0, false
	}
	adjName, ok := adjustmentName(adj)
	if !ok {
		return 0, false
	}
	switch {
	case !settled(endDate, now):
		return ttlOpenBars, false
	case adjName != "raw":
		return untilRefresh(now), false // a split rewrites history: refresh daily
	case archiveOn && (tfName == xnys.TimeframeDay || tfName == xnys.TimeframeMin):
		return ttlArchived, true // the archive owns it; Redis only covers a Postgres outage
	}
	return ttlSettledRaw, true
}

// untilRefresh is the time to the next 04:00 ET, clamped to [5 min, 24 h].
func untilRefresh(now time.Time) time.Duration {
	et := now.In(xnys.NewYork)
	next := time.Date(et.Year(), et.Month(), et.Day(), adjustedRefresh, 0, 0, 0, xnys.NewYork)
	if !next.After(now) {
		next = time.Date(et.Year(), et.Month(), et.Day()+1, adjustedRefresh, 0, 0, 0, xnys.NewYork)
	}
	return min(max(next.Sub(now), ttlAdjustedMin), ttlAdjustedMax)
}

// window widens a request to whole ET days, the way the archive does, so callers that differ only
// in "now" share one entry: from is midnight ET of the start's date, to is the last second of the
// end's date. DST-safe because the arithmetic runs on ET civil dates.
func window(start, end time.Time) (from, to time.Time) {
	s, e := start.In(xnys.NewYork), end.In(xnys.NewYork)
	from = time.Date(s.Year(), s.Month(), s.Day(), 0, 0, 0, 0, xnys.NewYork)
	to = time.Date(e.Year(), e.Month(), e.Day()+1, 0, 0, 0, 0, xnys.NewYork).Add(-time.Second)
	return from.UTC(), to.UTC()
}

// slice cuts the cached superset back to the caller's window: DAY_1 by ET session date (the rule
// alpaca.toBars applies), intraday by bar start (the rule archive.merge applies).
func slice(bars []*pb.Bar, tf pb.Timeframe, start, end time.Time) []*pb.Bar {
	cal := xnys.Default()
	first, last := cal.SessionDate(start), cal.SessionDate(end)
	out := make([]*pb.Bar, 0, len(bars))
	for _, b := range bars {
		s := b.GetStart().AsTime()
		in := !s.Before(start) && !s.After(end)
		if tf == pb.Timeframe_DAY_1 {
			day := cal.SessionDate(s)
			in = day >= first && day <= last
		}
		if in {
			out = append(out, b)
		}
	}
	return out
}
