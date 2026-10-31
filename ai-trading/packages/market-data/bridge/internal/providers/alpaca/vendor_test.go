package alpaca

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
)

// bridgeRoot is the package's own root: testdata/ and the recorded vendor window live under it.
// The vendor fixtures are the frozen real Alpaca responses (02u §6.2 T1); they are committed data,
// and the tests below are offline.
const (
	bridgeRoot = "../../.."
	// The Python fixtures in the `common` package are read by relative path with no copy (02u T1):
	// bridge -> market-data -> packages -> ai-trading.
	commonFixtures = bridgeRoot + "/../../../common/tests/fixtures/alpaca"
)

// windowed replays a recorded body the way the vendor would: `start <= t <= end`, both inclusive.
//
// This is the whole reason the 5U cases mean something. A fake that ignored the window would pass
// with the unpadded request too, and the bug would come back silently.
type windowed struct {
	mu   sync.Mutex
	rows []barJSON
	reqs []url.Values
}

func (w *windowed) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(rw http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		start, err := time.Parse(time.RFC3339, q.Get("start"))
		if err != nil {
			t.Errorf("start %q: %v", q.Get("start"), err)
		}
		end, err := time.Parse(time.RFC3339, q.Get("end"))
		if err != nil {
			t.Errorf("end %q: %v", q.Get("end"), err)
		}
		kept := []barJSON{}
		w.mu.Lock()
		w.reqs = append(w.reqs, q)
		for _, b := range w.rows {
			if !b.T.Before(start) && !b.T.After(end) {
				kept = append(kept, b)
			}
		}
		w.mu.Unlock()
		if err := json.NewEncoder(rw).Encode(barsPage{Bars: kept}); err != nil {
			t.Error(err)
		}
	}
}

func (w *windowed) lastRequest(t *testing.T) url.Values {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.reqs) == 0 {
		t.Fatal("no vendor request was sent")
	}
	return w.reqs[len(w.reqs)-1]
}

// recorded is one `{"params": ..., "body": {"bars": [...]}}` file, the format common/scripts/record.py
// writes and the Python replay tests read.
type recorded struct {
	Params map[string]string `json:"params"`
	Body   struct {
		Bars []barJSON `json:"bars"`
	} `json:"body"`
}

func loadRecorded(t *testing.T, path string) []barJSON {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("recorded fixture %s: %v", path, err)
	}
	var r recorded
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	if len(r.Body.Bars) == 0 {
		t.Fatalf("%s has no bars", path)
	}
	return r.Body.Bars
}

// replay serves `rows` and returns a client whose clock is `now`.
func replay(t *testing.T, rows []barJSON, now time.Time) (*Client, *windowed) {
	t.Helper()
	w := &windowed{rows: rows}
	srv := httptest.NewServer(w.handler(t))
	t.Cleanup(srv.Close)
	c := New("key-id", "key-secret", WithBaseURL(srv.URL), WithClock(func() time.Time { return now }), WithMinInterval(0))
	return c, w
}

func mustTimestamp(t *testing.T, s string) *timestamppb.Timestamp {
	t.Helper()
	return timestamppb.New(mustTime(t, s))
}

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	got, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func getBars(t *testing.T, c *Client, symbol string, tf pb.Timeframe, start, end string, adj pb.Adjustment) []*pb.Bar {
	t.Helper()
	bars, _, err := c.Bars(t.Context(), &pb.GetBarsRequest{
		Symbol: symbol, Timeframe: tf, Adjustment: adj,
		Start: mustTimestamp(t, start), End: mustTimestamp(t, end),
	})
	if err != nil {
		t.Fatalf("%s %s %s..%s: %v", symbol, tf, start, end, err)
	}
	return bars
}

// TestDailyWindowIsPaddedAndResliced is the 5U regression, in Go (02u §6.2 T2, STATUS row 5U,
// f6e8fdfc). The cases mirror the Python `TestDailyWindowWidth` table.
func TestDailyWindowIsPaddedAndResliced(t *testing.T) {
	oct := loadRecorded(t, filepath.Join(bridgeRoot, "testdata/vendor/alpaca/2026-10/daily_spy.json"))
	jan := loadRecorded(t, filepath.Join(commonFixtures, "daily_range_spy.json"))
	now := mustTime(t, "2026-10-31T15:00:00Z")

	cases := []struct {
		name       string
		rows       []barJSON
		start, end string
		wantDays   []string
		wantStart  string // the vendor request's start: padded for daily, as asked for intraday
	}{
		{
			// One session, extended open..extended close: the production request that returned
			// nothing. The daily bar is stamped 04:00Z, an hour before this start.
			name: "one session in daylight time", rows: oct,
			start: "2026-10-30T08:00:00Z", end: "2026-10-31T00:00:00Z",
			wantDays: []string{"2026-10-30"}, wantStart: "2026-10-30T04:00:00Z",
		},
		{
			// The same window in standard time: midnight ET is 05:00Z, so the pad is a different hour.
			name: "one session in standard time", rows: jan,
			start: "2026-01-02T09:00:00Z", end: "2026-01-03T01:00:00Z",
			wantDays: []string{"2026-01-02"}, wantStart: "2026-01-02T05:00:00Z",
		},
		{
			name: "multi session keeps its first session", rows: oct,
			start: "2026-10-28T08:00:00Z", end: "2026-10-31T00:00:00Z",
			wantDays: []string{"2026-10-28", "2026-10-29", "2026-10-30"}, wantStart: "2026-10-28T04:00:00Z",
		},
		{
			// The pad reaches back before the caller's window, so the answer must be re-sliced to it.
			name: "sessions outside the window are sliced away", rows: oct,
			start: "2026-10-27T08:00:00Z", end: "2026-10-30T00:00:00Z",
			wantDays: []string{"2026-10-27", "2026-10-28", "2026-10-29"}, wantStart: "2026-10-27T04:00:00Z",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, w := replay(t, tc.rows, now)
			bars := getBars(t, c, "SPY", pb.Timeframe_DAY_1, tc.start, tc.end, pb.Adjustment_ALL)
			if got := days(bars); !equal(got, tc.wantDays) {
				t.Fatalf("sessions %v, want %v", got, tc.wantDays)
			}
			if got := w.lastRequest(t).Get("start"); got != tc.wantStart {
				t.Errorf("vendor request start %s, want %s (the pad is to midnight ET, never forward)", got, tc.wantStart)
			}
		})
	}
}

// Intraday bars are stamped at their own start, inside the window, so their range is not padded.
func TestIntradayRequestsAreNotPadded(t *testing.T) {
	rows := loadRecorded(t, filepath.Join(bridgeRoot, "testdata/vendor/alpaca/2026-10/minute_aapl_2026-10-30.json"))
	c, w := replay(t, rows, mustTime(t, "2026-10-31T15:00:00Z"))
	getBars(t, c, "AAPL", pb.Timeframe_MINUTE_1, "2026-10-30T13:30:00Z", "2026-10-30T13:40:00Z", pb.Adjustment_ALL)
	if got := w.lastRequest(t).Get("start"); got != "2026-10-30T13:30:00Z" {
		t.Errorf("minute request start %s, must be exactly the caller's", got)
	}
}

// Known values (02u T1): the frozen real window, with literals checked against the vendor once at
// recording time. SPY 2026-10-30 closed at 755.72 (the 5U test's own literal).
func TestRecordedWindowMatchesKnownValues(t *testing.T) {
	rows := loadRecorded(t, filepath.Join(bridgeRoot, "testdata/vendor/alpaca/2026-10/daily_spy.json"))
	c, _ := replay(t, rows, mustTime(t, "2026-10-31T15:00:00Z"))
	bars := getBars(t, c, "SPY", pb.Timeframe_DAY_1, "2026-10-26T08:00:00Z", "2026-10-31T00:00:00Z", pb.Adjustment_ALL)

	if len(bars) != 5 {
		t.Fatalf("%d bars, want the 5 sessions 2026-10-26..2026-10-30", len(bars))
	}
	want := []struct {
		day           string
		start, close  string // UTC instants
		price, volume float64
	}{
		{"2026-10-26", "2026-10-26T04:00:00Z", "2026-10-26T20:00:00Z", 765.37, 31811570},
		{"2026-10-27", "2026-10-27T04:00:00Z", "2026-10-27T20:00:00Z", 769.66, 28688329},
		{"2026-10-28", "2026-10-28T04:00:00Z", "2026-10-28T20:00:00Z", 772.31, 0},
		{"2026-10-29", "2026-10-29T04:00:00Z", "2026-10-29T20:00:00Z", 769.36, 0},
		{"2026-10-30", "2026-10-30T04:00:00Z", "2026-10-30T20:00:00Z", 755.72, 0},
	}
	for i, w := range want {
		b := bars[i]
		if b.SessionDate != w.day {
			t.Errorf("bar %d session date %q, want %q", i, b.SessionDate, w.day)
		}
		if got := b.Start.AsTime().Format(time.RFC3339); got != w.start {
			t.Errorf("%s start %s, want %s", w.day, got, w.start)
		}
		if got := b.CloseAt.AsTime().Format(time.RFC3339); got != w.close {
			t.Errorf("%s close %s, want %s (16:00 EDT is 20:00Z)", w.day, got, w.close)
		}
		if b.Close != w.price {
			t.Errorf("%s close price %v, want %v", w.day, b.Close, w.price)
		}
		if w.volume > 0 && b.Volume != int64(w.volume) {
			t.Errorf("%s volume %d, want %v", w.day, b.Volume, w.volume)
		}
	}
}

// A half day closes at 13:00 ET: the bar must appear at 13:00, not be withheld until 16:00 the way
// the pre-C0 "assume 16:00" rule did. 2025-11-28 is an early close in the embedded calendar.
func TestHalfDayDailyBarClosesAtTheRegularClose(t *testing.T) {
	rows := []barJSON{{T: mustTime(t, "2025-11-28T05:00:00Z"), O: 276, H: 278, L: 275, C: 277.5, V: 1000}}
	// 12:59 ET: not closed yet, so nothing is returned (no repainting).
	early, _ := replay(t, rows, mustTime(t, "2025-11-28T17:59:00Z"))
	if bars := getBars(t, early, "AAPL", pb.Timeframe_DAY_1, "2025-11-28T09:00:00Z", "2025-11-29T01:00:00Z", pb.Adjustment_ALL); len(bars) != 0 {
		t.Fatalf("%d bars at 12:59 ET, want none", len(bars))
	}
	c, _ := replay(t, rows, mustTime(t, "2025-11-28T18:05:00Z")) // 13:05 EST
	bars := getBars(t, c, "AAPL", pb.Timeframe_DAY_1, "2025-11-28T09:00:00Z", "2025-11-29T01:00:00Z", pb.Adjustment_ALL)
	if len(bars) != 1 {
		t.Fatalf("%d bars, want the half day's bar at 13:00 ET", len(bars))
	}
	if got := bars[0].CloseAt.AsTime().Format(time.RFC3339); got != "2025-11-28T18:00:00Z" {
		t.Errorf("close %s, want 18:00Z (13:00 EST)", got)
	}
}

// The hourly half-day case, from the Python fixture set read by relative path (02u T2):
// bar_close caps a regular-session hour at the early close.
func TestHourlyHalfDayMatchesBarClose(t *testing.T) {
	rows := loadRecorded(t, filepath.Join(commonFixtures, "hourly_half_day.json"))
	c, _ := replay(t, rows, mustTime(t, "2025-11-30T15:00:00Z"))
	bars := getBars(t, c, "AAPL", pb.Timeframe_HOUR_1, "2025-11-28T09:00:00Z", "2025-11-29T01:00:00Z", pb.Adjustment_ALL)
	if len(bars) != 13 {
		t.Fatalf("%d bars, want the fixture's 13 hourly bars", len(bars))
	}
	closes := map[string]string{}
	for _, b := range bars {
		closes[b.Start.AsTime().Format(time.RFC3339)] = b.CloseAt.AsTime().Format(time.RFC3339)
		if b.SessionDate != "2025-11-28" {
			t.Errorf("%s: session date %q", b.Start.AsTime().Format(time.RFC3339), b.SessionDate)
		}
	}
	want := map[string]string{
		"2025-11-28T09:00:00Z": "2025-11-28T10:00:00Z", // 04:00 ET pre-market: its own hour
		"2025-11-28T17:00:00Z": "2025-11-28T18:00:00Z", // 12:00 ET: the regular close (13:00 ET)
		"2025-11-28T20:00:00Z": "2025-11-28T21:00:00Z", // 15:00 ET post-market: its own hour
	}
	for start, wantClose := range want {
		if got := closes[start]; got != wantClose {
			t.Errorf("%s closes %s, want %s", start, got, wantClose)
		}
	}
}

// 02u T2: a 19:59 ET extended-hours bar in EST is 00:59Z the next UTC day and still belongs to the
// ET date, on both sides of the 2026-11-01 change.
func TestSessionDateAcrossUTCMidnight(t *testing.T) {
	cases := []struct {
		name, stamp, day, closeAt string
	}{
		{"EDT", "2026-10-30T23:59:00Z", "2026-10-30", "2026-10-31T00:00:00Z"},
		{"EST", "2026-11-03T00:59:00Z", "2026-11-02", "2026-11-03T01:00:00Z"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rows := []barJSON{{T: mustTime(t, tc.stamp), O: 1, H: 2, L: 0.5, C: 1.5, V: 10}}
			c, _ := replay(t, rows, mustTime(t, "2026-11-04T15:00:00Z"))
			bars := getBars(t, c, "AAPL", pb.Timeframe_MINUTE_1, tc.stamp, "2026-11-04T00:00:00Z", pb.Adjustment_ALL)
			if len(bars) != 1 {
				t.Fatalf("%d bars, want 1", len(bars))
			}
			if bars[0].SessionDate != tc.day {
				t.Errorf("session date %q, want the ET date %q", bars[0].SessionDate, tc.day)
			}
			if got := bars[0].CloseAt.AsTime().Format(time.RFC3339); got != tc.closeAt {
				t.Errorf("close %s, want %s", got, tc.closeAt)
			}
		})
	}
}

// A daily bar on a day the exchange was shut is not data: it is dropped, the way Python's
// drop_unclosed drops a day XNYS does not recognize.
func TestDailyBarOnAHolidayIsDropped(t *testing.T) {
	rows := []barJSON{
		{T: mustTime(t, "2026-11-25T05:00:00Z"), O: 1, H: 2, L: 0.5, C: 1.5, V: 10}, // a session
		{T: mustTime(t, "2026-11-26T05:00:00Z"), O: 1, H: 2, L: 0.5, C: 1.5, V: 10}, // Thanksgiving
	}
	c, _ := replay(t, rows, mustTime(t, "2026-11-30T15:00:00Z"))
	bars := getBars(t, c, "AAPL", pb.Timeframe_DAY_1, "2026-11-24T09:00:00Z", "2026-11-28T01:00:00Z", pb.Adjustment_ALL)
	if len(bars) != 1 || bars[0].SessionDate != "2026-11-25" {
		t.Fatalf("want only 2026-11-25: %v", days(bars))
	}
}

// parityCase is one entry of the Python-generated golden: the same fixture window, and the bars the
// Python adapter normalized it to.
type parityCase struct {
	Name       string `json:"name"`
	Fixture    string `json:"fixture"`
	Symbol     string `json:"symbol"`
	Timeframe  string `json:"timeframe"`
	Start      string `json:"start"`
	End        string `json:"end"`
	Now        string `json:"now"`
	Adjustment string `json:"adjustment"`
	AsOf       string `json:"as_of"`
	Quality    string `json:"quality"`
	Bars       []struct {
		SessionDate string  `json:"session_date"`
		Start       string  `json:"start"`
		Open        float64 `json:"open"`
		High        float64 `json:"high"`
		Low         float64 `json:"low"`
		Close       float64 `json:"close"`
		Volume      int64   `json:"volume"`
		CloseAt     string  `json:"close_at"`
	} `json:"bars"`
}

var parityTimeframes = map[string]pb.Timeframe{"1d": pb.Timeframe_DAY_1, "1h": pb.Timeframe_HOUR_1, "1m": pb.Timeframe_MINUTE_1}
var parityQualities = map[string]pb.Quality{"eod": pb.Quality_EOD, "delayed-15m": pb.Quality_DELAYED_15M}
var parityAdjustments = map[string]pb.Adjustment{"all": pb.Adjustment_ALL, "raw": pb.Adjustment_RAW, "split": pb.Adjustment_SPLIT}

// TestParityWithThePythonAdapter is the test that would have caught the 5U drift: the same recorded
// vendor window through both adapters must produce identical normalized bars (02u §5.1 C0 exit
// gate, §6.2 T1). The Python side is the committed golden, generated by
// tools/gen_parity_golden.py, because cross-language invocation from `go test` is not a pattern here.
func TestParityWithThePythonAdapter(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(bridgeRoot, "testdata/vendor/alpaca/expected_python_bars.json"))
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Cases []parityCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden.Cases) == 0 {
		t.Fatal("empty parity golden")
	}
	for _, c := range golden.Cases {
		t.Run(c.Name, func(t *testing.T) {
			rows := loadRecorded(t, filepath.Join(bridgeRoot, c.Fixture))
			tf, ok := parityTimeframes[c.Timeframe]
			if !ok {
				t.Fatalf("unknown timeframe %q", c.Timeframe)
			}
			client, _ := replay(t, rows, mustTime(t, c.Now))
			bars, quality, err := client.Bars(t.Context(), &pb.GetBarsRequest{
				Symbol: c.Symbol, Timeframe: tf, Adjustment: parityAdjustments[c.Adjustment],
				Start: mustTimestamp(t, c.Start), End: mustTimestamp(t, c.End),
			})
			if err != nil {
				t.Fatalf("%s: %v", c.Symbol, err)
			}
			if quality != parityQualities[c.Quality] {
				t.Errorf("quality %v, want %v", quality, parityQualities[c.Quality])
			}
			cutoff := mustTime(t, c.Now)
			if c.AsOf != "" {
				cutoff = mustTime(t, c.AsOf)
			}
			bars = router.BarsClosedBy(bars, tf, cutoff)

			if len(bars) != len(c.Bars) {
				t.Fatalf("%d bars, Python normalized %d", len(bars), len(c.Bars))
			}
			for i, want := range c.Bars {
				got := bars[i]
				if got.SessionDate != want.SessionDate {
					t.Errorf("bar %d session date %q, Python %q", i, got.SessionDate, want.SessionDate)
				}
				if got := got.Start.AsTime().Format(time.RFC3339); got != want.Start {
					t.Errorf("bar %d start %s, Python %s", i, got, want.Start)
				}
				if got := got.CloseAt.AsTime().Format(time.RFC3339); got != want.CloseAt {
					t.Errorf("bar %d close %s, Python %s", i, got, want.CloseAt)
				}
				if got.Open != want.Open || got.High != want.High || got.Low != want.Low || got.Close != want.Close {
					t.Errorf("bar %d OHLC %v/%v/%v/%v, Python %v/%v/%v/%v", i,
						got.Open, got.High, got.Low, got.Close, want.Open, want.High, want.Low, want.Close)
				}
				if got.Volume != want.Volume {
					t.Errorf("bar %d volume %d, Python %d", i, got.Volume, want.Volume)
				}
			}
		})
	}
}

func days(bars []*pb.Bar) []string {
	out := make([]string, 0, len(bars))
	for _, b := range bars {
		out = append(out, b.SessionDate)
	}
	sort.Strings(out)
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
