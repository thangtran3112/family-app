package cache

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/xnys"
)

func TestQuoteTTLTable(t *testing.T) {
	q := func(quality pb.Quality, asOf time.Time) *pb.Quote {
		return &pb.Quote{Symbol: "A", Quality: quality, AsOf: timestamppb.New(asOf)}
	}
	for _, tc := range []struct {
		name string
		q    *pb.Quote
		now  time.Time
		want time.Duration
	}{
		{"realtime is never cached", q(pb.Quality_REALTIME, et("2026-10-30", "12:00")), et("2026-10-30", "12:00"), 0},
		{"unlabelled is never cached", q(pb.Quality_QUALITY_UNSPECIFIED, et("2026-10-30", "12:00")), et("2026-10-30", "12:00"), 0},
		{"delayed, session moving", q(pb.Quality_DELAYED_15M, et("2026-10-30", "11:45")), et("2026-10-30", "12:00"), 30 * time.Second},
		{"delayed, one second before the session is finished", q(pb.Quality_DELAYED_15M, et("2026-10-30", "19:59")), et("2026-10-30", "20:14").Add(59 * time.Second), 30 * time.Second},
		{"delayed, session finished on the minute", q(pb.Quality_DELAYED_15M, et("2026-10-30", "19:59")), et("2026-10-30", "20:15"), 5 * time.Minute},
		{"delayed, weekend", q(pb.Quality_DELAYED_15M, et("2026-10-30", "19:59")), et("2026-11-01", "09:00"), 5 * time.Minute},
		{"eod", q(pb.Quality_EOD, et("2026-10-30", "00:00")), et("2026-10-30", "12:00"), 10 * time.Minute},
		{"delayed without a bar time", &pb.Quote{Symbol: "A", Quality: pb.Quality_DELAYED_15M}, et("2026-10-30", "12:00"), 0},
	} {
		if got := quoteTTL(tc.q, tc.now); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestBarsTTLTable(t *testing.T) {
	const (
		d1, h1, m1 = pb.Timeframe_DAY_1, pb.Timeframe_HOUR_1, pb.Timeframe_MINUTE_1
		raw, all   = pb.Adjustment_RAW, pb.Adjustment_ALL
	)
	fri := et("2026-10-30", "12:00") // a session day, in progress
	for _, tc := range []struct {
		name      string
		tf        pb.Timeframe
		adj       pb.Adjustment
		end       string
		archiveOn bool
		now       time.Time
		ttl       time.Duration
		immutable bool
	}{
		{"unknown timeframe", pb.Timeframe_TIMEFRAME_UNSPECIFIED, raw, "2026-10-29", false, fri, 0, false},
		{"unknown adjustment", m1, pb.Adjustment(99), "2026-10-29", false, fri, 0, false},

		{"open session, raw", m1, raw, "2026-10-30", false, fri, ttlOpenBars, false},
		{"open session, adjusted", d1, all, "2026-10-30", false, fri, ttlOpenBars, false},
		{"open session with the archive on", m1, raw, "2026-10-30", true, fri, ttlOpenBars, false},
		{"window ending in the future", h1, raw, "2026-12-01", false, fri, ttlOpenBars, false},
		{"20:14:59 is still open", m1, raw, "2026-10-30", false, et("2026-10-30", "20:14").Add(59 * time.Second), ttlOpenBars, false},
		{"20:15:00 is settled", m1, raw, "2026-10-30", false, et("2026-10-30", "20:15"), ttlSettledRaw, true},

		{"settled raw 1m, archive off", m1, raw, "2026-10-29", false, fri, ttlSettledRaw, true},
		{"settled raw 1d, archive off", d1, raw, "2026-10-29", false, fri, ttlSettledRaw, true},
		{"settled raw 1m, archive on", m1, raw, "2026-10-29", true, fri, ttlArchived, true},
		{"settled raw 1d, archive on", d1, raw, "2026-10-29", true, fri, ttlArchived, true},
		{"settled raw 1h is not archived, even with it on", h1, raw, "2026-10-29", true, fri, ttlSettledRaw, true},

		{"early-close day, 20:14", m1, raw, "2026-11-27", false, et("2026-11-27", "20:14"), ttlOpenBars, false},
		{"early-close day, 20:15", m1, raw, "2026-11-27", false, et("2026-11-27", "20:15"), ttlSettledRaw, true},
		{"a weekend end counts as the Friday before it", m1, raw, "2026-10-31", false, et("2026-10-31", "09:00"), ttlSettledRaw, true},
		{"Friday not yet finished, Saturday end", m1, raw, "2026-10-31", false, et("2026-10-30", "18:00"), ttlOpenBars, false},
		{"DST end Sunday, end Saturday", m1, raw, "2026-10-31", false, et("2026-11-01", "10:00"), ttlSettledRaw, true},
		{"past the embedded calendar", m1, raw, "2031-06-01", false, fri, ttlOpenBars, false},
	} {
		ttl, immutable := barsTTL(tc.tf, tc.adj, tc.end, tc.archiveOn, tc.now)
		if ttl != tc.ttl || immutable != tc.immutable {
			t.Errorf("%s: (%v, %v), want (%v, %v)", tc.name, ttl, immutable, tc.ttl, tc.immutable)
		}
	}
	// Adjusted settled bars: until 04:00 ET (a split rewrites history), clamped. Every adjusted value.
	for _, adj := range []pb.Adjustment{pb.Adjustment_ALL, pb.Adjustment_SPLIT, pb.Adjustment_ADJUSTMENT_UNSPECIFIED} {
		ttl, immutable := barsTTL(d1, adj, "2026-10-29", false, fri)
		if want := 16 * time.Hour; ttl != want || immutable {
			t.Errorf("adjustment %v settled: (%v, %v), want (%v, false)", adj, ttl, immutable, want)
		}
	}
}

func TestAdjustedTTLLandsOnTheNextFourAMEastern(t *testing.T) {
	for _, tc := range []struct {
		name string
		now  time.Time
		want time.Duration
	}{
		{"noon", et("2026-10-29", "12:00"), 16 * time.Hour},
		{"one minute before: clamped up to 5 min", et("2026-10-29", "03:59"), ttlAdjustedMin},
		{"exactly 04:00: tomorrow's, clamped to 24 h", et("2026-10-29", "04:00"), ttlAdjustedMax},
		{"just after 04:00", et("2026-10-29", "04:01"), 23*time.Hour + 59*time.Minute},
		{"midnight", et("2026-10-29", "00:00"), 4 * time.Hour},
		// 2026-11-01 DST end: 00:30 EDT to 04:00 EST is 3 h 30 min on the wall clock, 4 h 30 min elapsed.
		{"across the DST end", et("2026-11-01", "00:30"), 4*time.Hour + 30*time.Minute},
	} {
		if got := untilRefresh(tc.now); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestWindowIsWholeETDaysAcrossDST(t *testing.T) {
	for _, tc := range []struct {
		name       string
		start, end time.Time
		wantFrom   time.Time
		wantTo     time.Time
	}{
		{"ordinary day", et("2026-10-30", "10:00"), et("2026-10-30", "11:00"), et("2026-10-30", "00:00"), et("2026-10-31", "00:00").Add(-time.Second)},
		// 2026-11-01 is 25 hours long: midnight EDT is 04:00Z, the next midnight EST is 05:00Z.
		{"DST end day", et("2026-11-01", "15:00"), et("2026-11-01", "16:00"), time.Date(2026, 11, 1, 4, 0, 0, 0, time.UTC), time.Date(2026, 11, 2, 5, 0, 0, 0, time.UTC).Add(-time.Second)},
		// 2026-03-08 is 23 hours long.
		{"DST start day", et("2026-03-08", "15:00"), et("2026-03-08", "16:00"), time.Date(2026, 3, 8, 5, 0, 0, 0, time.UTC), time.Date(2026, 3, 9, 4, 0, 0, 0, time.UTC).Add(-time.Second)},
		// 00:30Z is still the previous ET evening.
		{"UTC instants are read in ET", time.Date(2026, 10, 31, 0, 30, 0, 0, time.UTC), time.Date(2026, 10, 31, 1, 0, 0, 0, time.UTC), et("2026-10-30", "00:00"), et("2026-10-31", "00:00").Add(-time.Second)},
	} {
		from, to := window(tc.start, tc.end)
		if !from.Equal(tc.wantFrom) || !to.Equal(tc.wantTo) {
			t.Errorf("%s: [%v, %v], want [%v, %v]", tc.name, from, to, tc.wantFrom.UTC(), tc.wantTo.UTC())
		}
		if from.In(xnys.NewYork).Hour() != 0 {
			t.Errorf("%s: from is not midnight ET: %v", tc.name, from.In(xnys.NewYork))
		}
	}
}
