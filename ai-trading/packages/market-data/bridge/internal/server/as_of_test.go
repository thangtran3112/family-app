package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

// asOfBars asks for the harness's two daily bars (2024-04-30 and 2024-05-01) with `asOf`.
func asOfBars(t *testing.T, h *harness, asOf *timestamppb.Timestamp) (int, *pb.GetBarsResponse, string) {
	t.Helper()
	status, body := h.post("GetBars", &pb.GetBarsRequest{
		Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1,
		Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow),
		AsOf: asOf,
	}, readAuth())
	if status != 200 {
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &e)
		return status, nil, e.Code + " " + e.Message
	}
	var resp pb.GetBarsResponse
	if err := protojson.Unmarshal(body, &resp); err != nil {
		t.Fatalf("body: %v: %s", err, body)
	}
	return status, &resp, ""
}

// 02u T2, no look-ahead: at 15:59 ET on 2024-05-01 that day's daily bar has not closed and must be
// absent; at 16:00 ET it is present. The bar's own close instant decides, not when it was fetched.
func TestAsOfHidesABarThatHasNotClosed(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name  string
		asOf  string
		count int
	}{
		{"15:59 ET", "2024-05-01T19:59:00Z", 1},
		{"16:00 ET", "2024-05-01T20:00:00Z", 2},
		{"after the session", "2024-05-02T20:30:00Z", 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			at, err := time.Parse(time.RFC3339, tc.asOf)
			if err != nil {
				t.Fatal(err)
			}
			status, resp, msg := asOfBars(t, h, timestamppb.New(at))
			if status != 200 {
				t.Fatalf("status %d: %s", status, msg)
			}
			if len(resp.Bars) != tc.count {
				t.Fatalf("%d bars at as_of %s, want %d", len(resp.Bars), tc.asOf, tc.count)
			}
			for _, b := range resp.Bars {
				if b.CloseAt.AsTime().After(at) {
					t.Errorf("bar %s closes %s, after as_of %s", b.SessionDate, b.CloseAt.AsTime(), tc.asOf)
				}
			}
		})
	}
}

// An as_of before anything closed is NoData, the bridge's rule for an empty bars answer, and the
// message says why. It is never an empty success (ADR-0010: no fake fresh value).
func TestAsOfBeforeAnyCloseIsNoData(t *testing.T) {
	h := newHarness(t)
	status, _, msg := asOfBars(t, h, timestamppb.New(fixedNow.AddDate(0, 0, -10)))
	if status != 404 {
		t.Fatalf("status %d, want 404 NoData: %s", status, msg)
	}
	if !strings.Contains(msg, "not_found") || !strings.Contains(msg, "had closed by as_of") {
		t.Errorf("message %q must name NO_DATA and the as_of cut", msg)
	}
}

// Unset as_of means now (02u §4.2: an old client is never surprised), so the same request keeps the
// answer it had before C0.
func TestUnsetAsOfMeansNow(t *testing.T) {
	h := newHarness(t)
	status, resp, msg := asOfBars(t, h, nil)
	if status != 200 {
		t.Fatalf("status %d: %s", status, msg)
	}
	if len(resp.Bars) != 2 {
		t.Fatalf("%d bars, want both closed sessions", len(resp.Bars))
	}
}
