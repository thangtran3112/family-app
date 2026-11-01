package server

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/archive"
)

// memArchive turns the H1 archive on, over the in-memory store, at the harness's fixed clock.
func memArchive(o *Options) {
	o.Archive = archive.New(archive.NewMemStore(), slog.New(slog.DiscardHandler), func() time.Time { return fixedNow })
}

func rawDaily(h *harness) (int, []byte) {
	return h.post("GetBars", &pb.GetBarsRequest{
		Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_RAW,
		Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow),
	}, readAuth())
}

// H1 through the wire: with the archive off a response carries no `source` (C0 goldens stay
// byte-identical); with it on, the first answer is PROVIDER and the repeat is ARCHIVE, with the
// same bars, and the as_of cut still applies to archived bars.
func TestGetBarsSourceThroughTheArchive(t *testing.T) {
	off := newHarness(t)
	if status, body := rawDaily(off); status != 200 || strings.Contains(string(body), `"source"`) {
		t.Fatalf("archive off: status %d, source in body: %s", status, body)
	}

	on := newHarness(t, func(o *Options) {
		o.Archive = archive.New(archive.NewMemStore(), slog.New(slog.DiscardHandler), func() time.Time { return fixedNow })
	})
	get := func() *pb.GetBarsResponse {
		status, body := rawDaily(on)
		if status != 200 {
			t.Fatalf("status %d: %s", status, body)
		}
		var resp pb.GetBarsResponse
		if err := protojson.Unmarshal(body, &resp); err != nil {
			t.Fatal(err)
		}
		return &resp
	}
	first, second := get(), get()
	if len(first.Bars) != 2 || len(second.Bars) != 2 {
		t.Fatalf("bars %d then %d, want 2", len(first.Bars), len(second.Bars))
	}
	for i := range first.Bars {
		if first.Bars[i].Source != pb.BarSource_PROVIDER || second.Bars[i].Source != pb.BarSource_ARCHIVE {
			t.Errorf("bar %d source %v then %v, want PROVIDER then ARCHIVE", i, first.Bars[i].Source, second.Bars[i].Source)
		}
		if first.Bars[i].Close != second.Bars[i].Close || first.Bars[i].SessionDate != second.Bars[i].SessionDate {
			t.Errorf("bar %d differs between the fetch and the archive", i)
		}
	}
	// as_of before 05-01's close hides it even though the archive holds it.
	status, body := on.post("GetBars", &pb.GetBarsRequest{
		Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_RAW,
		Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow),
		AsOf: timestamppb.New(time.Date(2024, 5, 1, 19, 59, 0, 0, time.UTC)),
	}, readAuth())
	if status != 200 {
		t.Fatalf("as_of status %d: %s", status, body)
	}
	var cut pb.GetBarsResponse
	if err := protojson.Unmarshal(body, &cut); err != nil {
		t.Fatal(err)
	}
	if len(cut.Bars) != 1 || cut.Bars[0].SessionDate != "2024-04-30" {
		t.Errorf("as_of cut on archived bars: %v", cut.Bars)
	}
}

func ensure(h *harness, req *pb.EnsureHistoryRequest) (int, *pb.EnsureHistoryResponse, []byte) {
	status, body := h.post("EnsureHistory", req, readAuth())
	var resp pb.EnsureHistoryResponse
	if status == 200 {
		if err := protojson.Unmarshal(body, &resp); err != nil {
			h.t.Fatal(err)
		}
	}
	return status, &resp, body
}

var ensureDaily = &pb.EnsureHistoryRequest{Symbols: []string{"aapl", "MSFT", "ZZZZ"}, Timeframe: pb.Timeframe_DAY_1,
	FirstSession: "2024-04-30", LastSession: "2024-05-01"}

// EnsureHistory over the wire: fresh fills, the repeat finds everything present, and a symbol the
// vendor does not know is that symbol's missing sessions, not a failed call.
func TestEnsureHistoryThroughTheArchive(t *testing.T) {
	h := newHarness(t, memArchive)
	status, first, body := ensure(h, ensureDaily)
	if status != 200 || len(first.Coverage) != 3 {
		t.Fatalf("status %d: %s", status, body)
	}
	for _, c := range first.Coverage[:2] {
		if c.FetchedNow != 2 || c.Archived != 0 || len(c.Missing) != 0 {
			t.Errorf("%s first call: %v", c.Symbol, c)
		}
	}
	if c := first.Coverage[0]; c.Symbol != "AAPL" {
		t.Errorf("symbols are cleaned, got %q", c.Symbol)
	}
	if z := first.Coverage[2]; z.Symbol != "ZZZZ" || z.FetchedNow != 0 || len(z.Missing) != 2 || z.Missing[0].Error == pb.ErrorKind_ERROR_KIND_UNSPECIFIED {
		t.Errorf("unknown symbol must be a per-symbol error, got %v", z)
	}
	_, second, _ := ensure(h, ensureDaily)
	for _, c := range second.Coverage[:2] {
		if c.FetchedNow != 0 || c.Archived != 2 {
			t.Errorf("%s repeat: %v", c.Symbol, c)
		}
	}
}

// ARCHIVE_ENABLED=0 is a clear UNIMPLEMENTED that says why, not a silent no-op.
func TestEnsureHistoryDisabled(t *testing.T) {
	status, body := newHarness(t).post("EnsureHistory", ensureDaily, readAuth())
	if status != 501 || !strings.Contains(string(body), "ARCHIVE_ENABLED=0") {
		t.Fatalf("status %d: %s", status, body)
	}
}

func TestEnsureHistoryValidation(t *testing.T) {
	h := newHarness(t, memArchive)
	for name, mut := range map[string]func(r *pb.EnsureHistoryRequest){
		"no symbols":      func(r *pb.EnsureHistoryRequest) { r.Symbols = nil },
		"hourly":          func(r *pb.EnsureHistoryRequest) { r.Timeframe = pb.Timeframe_HOUR_1 },
		"bad date":        func(r *pb.EnsureHistoryRequest) { r.FirstSession = "2024-4-30" },
		"reversed":        func(r *pb.EnsureHistoryRequest) { r.FirstSession, r.LastSession = r.LastSession, r.FirstSession },
		"before 2000":     func(r *pb.EnsureHistoryRequest) { r.FirstSession = "1999-12-31" },
		"unfinished last": func(r *pb.EnsureHistoryRequest) { r.LastSession = "2024-05-02" }, // fixedNow is 16:30 ET
	} {
		req := &pb.EnsureHistoryRequest{Symbols: []string{"AAPL"}, Timeframe: pb.Timeframe_DAY_1, FirstSession: "2024-04-30", LastSession: "2024-05-01"}
		mut(req)
		if status, _, body := ensure(h, req); status != 400 {
			t.Errorf("%s: status %d, want 400: %s", name, status, body)
		}
	}
}

// ListProviders says whether the archive is on and what backs it; with it off, "none".
func TestListProvidersArchiveState(t *testing.T) {
	list := func(h *harness) *pb.ArchiveInfo {
		status, body := h.post("ListProviders", nil, readAuth())
		var resp pb.ListProvidersResponse
		if status != 200 || protojson.Unmarshal(body, &resp) != nil || resp.Archive == nil {
			t.Fatalf("status %d: %s", status, body)
		}
		return resp.Archive
	}
	if off := list(newHarness(t)); off.Enabled || off.Backend != "none" || len(off.Ranges) != 0 {
		t.Errorf("archive off: %v", off)
	}
	on := newHarness(t, memArchive)
	if info := list(on); !info.Enabled || info.Backend != "memory" || len(info.Ranges) != 0 {
		t.Errorf("archive on, empty: %v", info)
	}
	ensure(on, ensureDaily)
	info := list(on)
	if len(info.Ranges) != 1 || info.Ranges[0].Timeframe != pb.Timeframe_DAY_1 ||
		info.Ranges[0].EarliestSession != "2024-04-30" || info.Ranges[0].LatestSession != "2024-05-01" {
		t.Errorf("ranges after a fill: %v", info.Ranges)
	}
}
