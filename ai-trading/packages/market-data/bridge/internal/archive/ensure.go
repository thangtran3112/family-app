package archive

import (
	"context"
	"errors"
	"time"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/xnys"
)

// Finished reports whether the session on date can no longer change (see finished).
func (a *Archive) Finished(date string) bool { return finished(date, a.now().UTC()) }

// Ensure fills the archive for every finished session of symbol in [first, last] that is not
// archived yet, and says what it found. It is GetBars' fill path without the answer: the same
// covered() read, the same widened fetchRequest, the same record() write. A failure is data in the
// returned Coverage, never an error, so one symbol cannot fail a batch (02u §4.2).
func (a *Archive) Ensure(ctx context.Context, symbol string, timeframe pb.Timeframe, first, last string, fetch Fetch) *pb.Coverage {
	cov := &pb.Coverage{Symbol: symbol, Uncovered: a.beforeFloor(first, last)}
	tf := router.CalendarTimeframe(timeframe)
	now := a.now().UTC()
	dates := finishedOf(a.sessionDates(first, last), now)
	if len(dates) == 0 {
		return cov
	}
	covered, err := a.covered(ctx, symbol, tf, dates)
	if err != nil {
		a.log.Warn("archive read failed during EnsureHistory", "symbol", symbol, "error", err.Error())
		cov.Error = "archive unreachable"
		return cov
	}
	cov.Archived = int32(len(covered))
	have := map[string]bool{}
	for _, s := range covered {
		have[s.Date] = true
	}
	var need []string
	for _, d := range dates {
		if !have[d] {
			need = append(need, d)
		}
	}
	if len(need) == 0 {
		return cov
	}
	gaps := func(kind pb.ErrorKind, msg string) *pb.Coverage {
		for _, d := range need {
			cov.Missing = append(cov.Missing, &pb.SessionGap{SessionDate: d, Error: kind, Message: msg})
		}
		return cov
	}
	resp, err := fetch(ctx, a.fetchRequest(&pb.GetBarsRequest{Symbol: symbol, Timeframe: timeframe}, need[0], need[len(need)-1], now))
	if err != nil {
		var re *router.RouteError
		if errors.As(err, &re) {
			return gaps(re.Kind, re.Summary)
		}
		return gaps(pb.ErrorKind_UNAVAILABLE, "provider fetch failed")
	}
	if err := a.record(ctx, symbol, tf, need, resp); err != nil {
		a.log.Warn("archive write failed during EnsureHistory", "symbol", symbol, "error", err.Error())
		return gaps(pb.ErrorKind_UNAVAILABLE, "archive write failed")
	}
	cov.FetchedNow = int32(len(need))
	return cov
}

// beforeFloor lists the weekdays in [first, last] before the calendar's first covered date: history
// the bridge has no session calendar for, so it is reported and never fabricated.
func (a *Archive) beforeFloor(first, last string) []string {
	var out []string
	end := min(last, a.cal.First())
	for d, _ := time.ParseInLocation(xnys.DateFormat, first, xnys.NewYork); d.Format(xnys.DateFormat) < end; d = d.AddDate(0, 0, 1) {
		if wd := d.Weekday(); wd != time.Saturday && wd != time.Sunday {
			out = append(out, d.Format(xnys.DateFormat))
		}
	}
	return out
}

// Info is the archive state ListProviders reports. A store that cannot be read says so in words
// (bars then pass through, 02u §3.2); the probe is short so a stopped database cannot stall it.
func (a *Archive) Info(ctx context.Context) *pb.ArchiveInfo {
	info := &pb.ArchiveInfo{Enabled: true, Backend: a.store.Backend()}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for _, t := range []struct {
		wire pb.Timeframe
		cal  string
	}{{pb.Timeframe_DAY_1, xnys.TimeframeDay}, {pb.Timeframe_MINUTE_1, xnys.TimeframeMin}} {
		lo, hi, err := a.store.Bounds(ctx, t.cal)
		if err != nil {
			a.log.Warn("archive state unreadable", "error", err.Error())
			info.Reason, info.Ranges = "database_unreachable", nil
			break
		}
		if lo != "" {
			info.Ranges = append(info.Ranges, &pb.ArchiveRange{Timeframe: t.wire, EarliestSession: lo, LatestSession: hi})
		}
	}
	return info
}
