// Package xnys is the embedded New York Stock Exchange session calendar (02u §9 ruling 6).
//
// It answers three questions the bridge must get right and must never guess: is a date a
// trading session, when does a session's regular trading open and close (13:00 ET on an early
// close), and what instant does a bar close at (the same rule as the Desk's
// `ai_trading.data.bars.bar_close`). 5U is the reason: a daily bar is stamped at midnight ET
// of its trading date, and anything that treats that stamp as the session made a one-session
// window come back empty.
//
// The data is `xnys.json` (2016-01-01..2030-12-31): session dates and early-close dates only.
// Every open and close *instant* is derived here from the ET wall clock plus tzdata, so a
// wrong UTC offset fails a test instead of silently shifting a bar by an hour. Drift is
// pinned by `testdata/calendar/xnys_python_golden.json`, which holds the Desk calendar's own
// instants for every day in the range.
//
// Regenerate yearly (02u §9 ruling 6, sync-checklist item):
//
//	uv run --with exchange_calendars,pandas,python-dateutil \
//	    python tools/gen_xnys_calendar.py --desk-src ../../family-desk/backend/src
//
// then `go test ./internal/xnys`.
package xnys

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"
	"time"
	_ "time/tzdata" // the distroless static image's zoneinfo is not guaranteed
)

const (
	// DateFormat is the wire form of a session date (`Bar.session_date`): YYYY-MM-DD.
	DateFormat = "2006-01-02"
	// RegularOpenClock and RegularCloseClock are the regular session's ET edges; an early
	// close ends at EarlyCloseClock instead and opens at the same time.
	RegularOpenClock  = "09:30"
	RegularCloseClock = "16:00"
	EarlyCloseClock   = "13:00"
)

// Timeframes this package computes bar closes for, matching `ai_trading_common.bars.Timeframe`.
const (
	TimeframeDay   = "1d"
	TimeframeHour  = "1h"
	TimeframeMin   = "1m"
	minuteDuration = time.Minute
	hourDuration   = time.Hour
)

//go:embed xnys.json
var embedded []byte

// NewYork is the exchange's civil time zone. Bars and sessions are dated in it, never in UTC
// (the 19:59 ET extended-hours bar in EST is 00:59Z the next UTC day but belongs to the ET date).
var NewYork = mustLoad("America/New_York")

func mustLoad(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

type file struct {
	Note        string   `json:"note"`
	Source      string   `json:"source"`
	Generated   string   `json:"generated"`
	Range       span     `json:"range"`
	Sessions    []string `json:"sessions"`
	EarlyCloses []string `json:"early_closes"`
}

type span struct {
	First string `json:"first"`
	Last  string `json:"last"`
}

// Calendar is the parsed embedded calendar: read-only, safe for concurrent use.
type Calendar struct {
	source, generated string
	first, last       string // coverage bounds, date strings
	sessions          map[string]struct{}
	early             map[string]struct{}
}

var (
	defaultOnce sync.Once
	defaultCal  *Calendar
	defaultErr  error
)

// Default returns the embedded calendar. It parses on first use; the data is compiled in, so a
// failure here is a build error and panics rather than serving wrong sessions.
func Default() *Calendar {
	defaultOnce.Do(func() {
		defaultCal, defaultErr = Parse(embedded)
		if defaultErr != nil {
			panic(fmt.Sprintf("xnys: embedded calendar is corrupt: %v", defaultErr))
		}
	})
	return defaultCal
}

// Parse loads a calendar document (used by the drift test; production uses Default).
func Parse(data []byte) (*Calendar, error) {
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	if len(f.Sessions) == 0 {
		return nil, fmt.Errorf("xnys: no sessions")
	}
	c := &Calendar{
		source: f.Source, generated: f.Generated, first: f.Range.First, last: f.Range.Last,
		sessions: make(map[string]struct{}, len(f.Sessions)),
		early:    make(map[string]struct{}, len(f.EarlyCloses)),
	}
	for _, day := range f.Sessions {
		if _, err := time.Parse(DateFormat, day); err != nil {
			return nil, fmt.Errorf("xnys: bad session %q: %w", day, err)
		}
		c.sessions[day] = struct{}{}
	}
	for _, day := range f.EarlyCloses {
		if _, ok := c.sessions[day]; !ok {
			return nil, fmt.Errorf("xnys: early close %q is not a session", day)
		}
		c.early[day] = struct{}{}
	}
	return c, nil
}

// Source and Generated are the data's provenance, for the drift test's failure messages.
func (c *Calendar) Source() string    { return c.source }
func (c *Calendar) Generated() string { return c.generated }

// First and Last are the covered dates (inclusive).
func (c *Calendar) First() string { return c.first }
func (c *Calendar) Last() string  { return c.last }

// SessionDate is the ET trading date of an instant, YYYY-MM-DD.
func (c *Calendar) SessionDate(t time.Time) string { return t.In(NewYork).Format(DateFormat) }

// Covers reports whether the instant's ET date is inside the embedded range. Outside it the
// bridge has no session truth, so callers must not guess (see IsSession).
func (c *Calendar) Covers(t time.Time) bool {
	day := c.SessionDate(t)
	return day >= c.first && day <= c.last
}

// IsSession reports whether the instant's ET date is a trading session. A date outside the
// covered range is not a session: the calendar cannot say it is one, and the 2016 history floor
// means nothing older is ever asked for.
func (c *Calendar) IsSession(t time.Time) bool { return c.IsSessionDate(c.SessionDate(t)) }

// IsSessionDate is IsSession for an ET date already in wire form (YYYY-MM-DD): one map lookup, no instant
// to build and no string to format. A caller walking a date range uses it instead of IsSession.
func (c *Calendar) IsSessionDate(day string) bool {
	_, ok := c.sessions[day]
	return ok
}

// RegularOpen is 09:30 ET of the session whose ET date contains t, and false when that date is
// not a session.
func (c *Calendar) RegularOpen(t time.Time) (time.Time, bool) {
	if !c.IsSession(t) {
		return time.Time{}, false
	}
	et := t.In(NewYork)
	return time.Date(et.Year(), et.Month(), et.Day(), 9, 30, 0, 0, NewYork).UTC(), true
}

// RegularClose is 16:00 ET of the session whose ET date contains t, 13:00 ET on an early close,
// and false when that date is not a session.
func (c *Calendar) RegularClose(t time.Time) (time.Time, bool) {
	if !c.IsSession(t) {
		return time.Time{}, false
	}
	et := t.In(NewYork)
	hour := 16
	if _, early := c.early[et.Format(DateFormat)]; early {
		hour = 13
	}
	return time.Date(et.Year(), et.Month(), et.Day(), hour, 0, 0, 0, NewYork).UTC(), true
}

// BarClose is the instant a bar closes, matching `ai_trading.data.bars.bar_close`:
//
//   - "1d": the trading day's own regular close (16:00 ET, 13:00 ET on an early close). A day
//     the exchange does not recognize is not a bar at all, so ok is false.
//   - "1h": one hour after the start, or the regular close when the start is inside the regular
//     session and that close comes first (a half day's short last hour). An extended-hours bar
//     keeps its full hour: there is no session edge to borrow after the regular close.
//   - "1m": one minute after the start.
func (c *Calendar) BarClose(timeframe string, point time.Time) (time.Time, bool) {
	switch timeframe {
	case TimeframeDay:
		return c.RegularClose(point)
	case TimeframeMin:
		return point.Add(minuteDuration).UTC(), true
	case TimeframeHour:
		natural := point.Add(hourDuration)
		if start, open := c.RegularOpen(point); open {
			if close, closed := c.RegularClose(point); closed && !point.Before(start) && point.Before(close) {
				natural = close
			}
		}
		return natural.UTC(), true
	}
	return time.Time{}, false
}

// Closed reports whether the bar starting at `point` has finished by `now`, the rule the adapter
// applies before returning a bar (never a forming one: no repainting). A "1d" point the exchange
// does not recognize is dropped, the same way `drop_unclosed` drops it.
func (c *Calendar) Closed(timeframe string, point, now time.Time) bool {
	close, ok := c.BarClose(timeframe, point)
	return ok && !close.After(now)
}
