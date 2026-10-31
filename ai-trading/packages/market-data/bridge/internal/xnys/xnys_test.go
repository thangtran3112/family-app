package xnys

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func at(day, clock string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", day+" "+clock, NewYork)
	if err != nil {
		panic(err)
	}
	return t
}

func utc(day, clock string) time.Time {
	t, err := time.Parse("2006-01-02 15:04", day+" "+clock)
	if err != nil {
		panic(err)
	}
	return t.UTC()
}

func TestEmbeddedCalendarCoversTheRuledRange(t *testing.T) {
	c := Default()
	if c.First() != "2016-01-01" || c.Last() != "2030-12-31" {
		t.Fatalf("range %s..%s, want 2016-01-01..2030-12-31 (02u §9 ruling 6)", c.First(), c.Last())
	}
	if c.Source() == "" || c.Generated() == "" {
		t.Fatal("the calendar must carry its provenance")
	}
}

// The two UTC offsets are the whole point of computing instants from the ET clock instead of
// storing them: 16:00 ET is 20:00Z in EDT and 21:00Z in EST.
func TestSessionEdgesFollowDaylightSaving(t *testing.T) {
	c := Default()
	cases := []struct {
		name, day, want string
		open            bool
	}{
		{"EDT open", "2026-10-30", "2026-10-30 13:30", true},
		{"EDT close", "2026-10-30", "2026-10-30 20:00", false},
		{"EST open", "2026-11-02", "2026-11-02 14:30", true},
		{"EST close", "2026-11-02", "2026-11-02 21:00", false},
	}
	for _, tc := range cases {
		edge, ok := c.RegularClose(at(tc.day, "12:00"))
		if tc.open {
			edge, ok = c.RegularOpen(at(tc.day, "12:00"))
		}
		if !ok {
			t.Fatalf("%s: %s is not a session", tc.name, tc.day)
		}
		if want := mustUTC(t, tc.want); !edge.Equal(want) {
			t.Errorf("%s: %s, want %s", tc.name, edge.Format(time.RFC3339), want.Format(time.RFC3339))
		}
	}
}

func mustUTC(t *testing.T, s string) time.Time {
	t.Helper()
	got, err := time.Parse("2006-01-02 15:04", s)
	if err != nil {
		t.Fatal(err)
	}
	return got.UTC()
}

func TestHolidaysAndEarlyCloses(t *testing.T) {
	c := Default()
	if c.IsSession(at("2026-11-26", "12:00")) {
		t.Error("2026-11-26 is Thanksgiving: not a session")
	}
	if c.IsSession(at("2026-11-28", "12:00")) {
		t.Error("a Saturday is not a session")
	}
	close, ok := c.RegularClose(at("2026-11-27", "12:00"))
	if !ok {
		t.Fatal("2026-11-27 is a session (early close)")
	}
	if want := mustUTC(t, "2026-11-27 18:00"); !close.Equal(want) { // 13:00 ET in EST
		t.Errorf("early close %s, want %s", close.Format(time.RFC3339), want.Format(time.RFC3339))
	}
	if open, _ := c.RegularOpen(at("2026-11-27", "12:00")); !open.Equal(mustUTC(t, "2026-11-27 14:30")) {
		t.Errorf("an early close still opens at 09:30 ET: %s", open.Format(time.RFC3339))
	}
}

// 5U in one line: a daily bar is dated by its ET date, so the calendar must answer 1d closes per
// trading day and refuse a day the exchange was shut.
func TestBarCloseMatchesTheDeskRule(t *testing.T) {
	c := Default()
	day := at("2026-10-30", "00:00") // the midnight ET stamp of a daily bar
	if got, ok := c.BarClose(TimeframeDay, day); !ok || !got.Equal(mustUTC(t, "2026-10-30 20:00")) {
		t.Errorf("1d close %s ok=%v", got.Format(time.RFC3339), ok)
	}
	if _, ok := c.BarClose(TimeframeDay, at("2026-11-26", "00:00")); ok {
		t.Error("1d on a holiday must not have a close")
	}
	// A half day's last regular hour closes at the regular close, not an hour later.
	if got, ok := c.BarClose(TimeframeHour, at("2025-11-28", "12:30")); !ok || !got.Equal(mustUTC(t, "2025-11-28 18:00")) {
		t.Errorf("half-day 12:30 hourly bar: %s ok=%v, want 18:00Z", got.Format(time.RFC3339), ok)
	}
	// An extended-hours hourly bar keeps its full hour: there is no session edge to borrow.
	if got, _ := c.BarClose(TimeframeHour, at("2025-11-28", "14:00")); !got.Equal(mustUTC(t, "2025-11-28 20:00")) {
		t.Errorf("post-market hourly bar: %s, want 20:00Z", got.Format(time.RFC3339))
	}
	if got, _ := c.BarClose(TimeframeMin, at("2026-10-30", "15:59")); !got.Equal(mustUTC(t, "2026-10-30 20:00")) {
		t.Errorf("1m close: %s, want 20:00Z", got.Format(time.RFC3339))
	}
	if _, ok := c.BarClose("5m", at("2026-10-30", "15:59")); ok {
		t.Error("an unknown timeframe has no close rule")
	}
}

func TestClosedNeverReturnsAFormingBar(t *testing.T) {
	c := Default()
	day := at("2026-10-30", "00:00")
	if c.Closed(TimeframeDay, day, mustUTC(t, "2026-10-30 19:59")) {
		t.Error("a daily bar is not closed at 15:59 ET")
	}
	if !c.Closed(TimeframeDay, day, mustUTC(t, "2026-10-30 20:00")) {
		t.Error("a daily bar is closed at 16:00 ET")
	}
	if !c.Closed(TimeframeMin, at("2026-10-30", "15:59"), mustUTC(t, "2026-10-30 20:00")) {
		t.Error("a minute bar closes one minute after its start")
	}
}

// A 19:59 ET bar in EST is 00:59Z the next UTC day and still belongs to the ET date (02u T2).
func TestSessionDateIsTheETDateOnBothSidesOfTheDSTChange(t *testing.T) {
	c := Default()
	cases := map[string]string{
		"2026-10-30T23:59:00Z": "2026-10-30", // 19:59 ET, EDT: still the same UTC day
		"2026-11-03T00:59:00Z": "2026-11-02", // 19:59 ET, EST: the next UTC day
	}
	for stamp, want := range cases {
		got, err := time.Parse(time.RFC3339, stamp)
		if err != nil {
			t.Fatal(err)
		}
		if got := c.SessionDate(got); got != want {
			t.Errorf("%s: session date %s, want %s", stamp, got, want)
		}
	}
}

func TestOutsideTheCoveredRangeIsNotASession(t *testing.T) {
	c := Default()
	for _, day := range []string{"2015-12-31", "2031-01-02"} {
		if c.Covers(at(day, "12:00")) {
			t.Errorf("%s is outside the covered range but Covers said yes", day)
		}
		if c.IsSession(at(day, "12:00")) {
			t.Errorf("%s is outside the covered range but IsSession said yes", day)
		}
	}
}

// The drift test (02u T2): the embedded dates and this package's derived instants must equal the
// Desk calendar's, for every day from 2016 to 2030. The golden is generated from
// `ai_trading.core.calendar.session` by tools/gen_xnys_calendar.py, so the two sides are
// independent: a stale regeneration, a hand edit, or wrong DST arithmetic fails here.
func TestDriftAgainstThePythonCalendar(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "calendar", "xnys_python_golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Source   string `json:"source"`
		Range    span   `json:"range"`
		Sessions []struct {
			D string `json:"d"`
			O string `json:"o"`
			C string `json:"c"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden.Sessions) == 0 {
		t.Fatal("empty golden")
	}
	c := Default()
	if golden.Range.First != c.First() || golden.Range.Last != c.Last() {
		t.Fatalf("golden covers %s..%s, calendar %s..%s", golden.Range.First, golden.Range.Last, c.First(), c.Last())
	}

	want := make(map[string]struct{}, len(golden.Sessions))
	for _, s := range golden.Sessions {
		want[s.D] = struct{}{}
		day := at(s.D, "12:00")
		if !c.IsSession(day) {
			t.Errorf("%s: the Desk calendar has a session, the embedded calendar does not", s.D)
			continue
		}
		open, _ := c.RegularOpen(day)
		close, _ := c.RegularClose(day)
		if got, wantOpen := open.Format(time.RFC3339), s.O; got != wantOpen {
			t.Errorf("%s: open %s, want %s", s.D, got, wantOpen)
		}
		if got, wantClose := close.Format(time.RFC3339), s.C; got != wantClose {
			t.Errorf("%s: close %s, want %s", s.D, got, wantClose)
		}
	}

	// The other direction: no extra session in the embedded calendar.
	day, err := time.Parse(DateFormat, c.First())
	if err != nil {
		t.Fatal(err)
	}
	last, err := time.Parse(DateFormat, c.Last())
	if err != nil {
		t.Fatal(err)
	}
	for ; !day.After(last); day = day.AddDate(0, 0, 1) {
		label := day.Format(DateFormat)
		if c.IsSession(at(label, "12:00")) {
			if _, ok := want[label]; !ok {
				t.Errorf("%s: the embedded calendar has a session the Desk calendar does not", label)
			}
		}
	}
}
