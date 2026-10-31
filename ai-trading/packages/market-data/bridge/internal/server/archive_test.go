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
