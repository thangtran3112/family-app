package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1/marketdatav1connect"
)

func TestHealthzIsProcessOnlyAndUnauthenticated(t *testing.T) {
	h := newHarness(t)
	h.IBKR.setDown(true)
	h.setAlpacaDown(true)
	for i := 0; i < 3; i++ { // every provider is down and marked so; /healthz must still be 200
		h.post("GetQuotes", &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}, readAuth())
	}
	resp, err := http.Get(h.URL + "/healthz")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("healthz: %v %v", resp, err)
	}
	resp.Body.Close()
}

func TestAuth(t *testing.T) {
	h := newHarness(t)
	q := &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}
	cases := []struct {
		name    string
		rpc     string
		headers map[string]string
		status  int
		code    string
	}{
		{"no header", "GetQuotes", nil, 401, "unauthenticated"},
		{"wrong token", "GetQuotes", map[string]string{"Authorization": "Bearer nope"}, 401, "unauthenticated"},
		{"wrong scheme", "GetQuotes", map[string]string{"Authorization": "Basic " + readToken}, 401, "unauthenticated"},
		{"admin token alone is not a read token", "GetQuotes", map[string]string{"Authorization": "Bearer " + adminToken}, 401, "unauthenticated"},
		{"read token reads", "GetQuotes", readAuth(), 200, ""},
		{"list needs auth", "ListProviders", nil, 401, "unauthenticated"},
		{"status needs auth", "GetStatus", nil, 401, "unauthenticated"},
		{"read token cannot SetRouting", "SetRouting", readAuth(), 403, "permission_denied"},
		{"wrong admin token", "SetRouting", map[string]string{"Authorization": "Bearer " + readToken, adminHeader: "nope"}, 403, "permission_denied"},
		{"admin header without read token", "SetRouting", map[string]string{adminHeader: adminToken}, 401, "unauthenticated"},
	}
	for _, c := range cases {
		var req proto.Message
		if c.rpc == "GetQuotes" {
			req = q
		}
		status, body := h.post(c.rpc, req, c.headers)
		if status != c.status {
			t.Errorf("%s: HTTP %d, want %d (%s)", c.name, status, c.status, body)
			continue
		}
		var e struct{ Code string }
		_ = json.Unmarshal(body, &e)
		if e.Code != c.code {
			t.Errorf("%s: code %q, want %q", c.name, e.Code, c.code)
		}
	}
	status, _ := h.post("SetRouting", &pb.SetRoutingRequest{Version: 1}, adminAuth())
	if status != 200 {
		t.Fatalf("read+admin token must SetRouting: %d", status)
	}
}

func TestNoTokenConfiguredRejectsEverything(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Token, o.AdminToken = "", "" })
	for _, hdr := range []map[string]string{nil, {"Authorization": "Bearer "}, {"Authorization": "Bearer anything"}, adminAuth()} {
		if status, _ := h.post("ListProviders", nil, hdr); status != 401 {
			t.Fatalf("an unconfigured bridge must never serve: %d with %v", status, hdr)
		}
	}
	if status, _ := h.post("SetRouting", &pb.SetRoutingRequest{Version: 1}, map[string]string{adminHeader: ""}); status != 401 {
		t.Fatalf("empty admin token must not match the unset one: %d", status)
	}
	// Still a healthy process: this is the missing-profile boot.
	resp, err := http.Get(h.URL + "/healthz")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("healthz: %v %v", resp, err)
	}
	resp.Body.Close()
}

func TestRequestValidation(t *testing.T) {
	h := newHarness(t)
	many := make([]string, 101)
	for i := range many {
		many[i] = "AAPL"
	}
	day := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow)}
	bad := map[string]struct {
		rpc string
		req any
	}{
		"no symbols":     {"GetQuotes", &pb.GetQuotesRequest{}},
		"101 symbols":    {"GetQuotes", &pb.GetQuotesRequest{Symbols: many}},
		"bad ticker":     {"GetQuotes", &pb.GetQuotesRequest{Symbols: []string{"AAPL; DROP"}}},
		"empty ticker":   {"GetQuotes", &pb.GetQuotesRequest{Symbols: []string{""}}},
		"bars no tf":     {"GetBars", &pb.GetBarsRequest{Symbol: "AAPL", Start: day.Start, End: day.End}},
		"bars no window": {"GetBars", &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1}},
		"bars reversed":  {"GetBars", &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Start: day.End, End: day.Start}},
		"pin off ladder": {"GetQuotes", &pb.GetQuotesRequest{Symbols: []string{"AAPL"}, PinProvider: "marketdata_app"}},
	}
	for name, c := range bad {
		var status int
		switch r := c.req.(type) {
		case *pb.GetQuotesRequest:
			status, _ = h.post(c.rpc, r, readAuth())
		case *pb.GetBarsRequest:
			status, _ = h.post(c.rpc, r, readAuth())
		}
		if status != 400 {
			t.Errorf("%s: HTTP %d, want 400", name, status)
		}
	}
	// Lower-case and duplicate symbols are normalized, not rejected.
	status, body := h.post("GetQuotes", &pb.GetQuotesRequest{Symbols: []string{"aapl", "AAPL", " msft "}}, readAuth())
	var resp pb.GetQuotesResponse
	if status != 200 || protojson.Unmarshal(body, &resp) != nil || len(resp.Quotes) != 2 {
		t.Fatalf("%d %s", status, body)
	}
}

func TestOptionChainIsUnimplementedBeforeB6(t *testing.T) {
	h := newHarness(t)
	status, body := h.post("GetOptionChain", &pb.GetOptionChainRequest{Underlying: "AAPL", MaxDte: 30}, readAuth())
	if status != 501 || !strings.Contains(string(body), "unimplemented") {
		t.Fatalf("%d %s", status, body)
	}
}

func TestSetRoutingErrorsAndEffect(t *testing.T) {
	h := newHarness(t)
	set := func(p string, v int64) (int, []byte) {
		return h.post("SetRouting", &pb.SetRoutingRequest{Version: v, Preferences: []*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: p}}}, adminAuth())
	}
	if status, body := set("tradier", 1); status != 400 || !strings.Contains(string(body), "not a known provider") {
		t.Fatalf("%d %s", status, body)
	}
	if status, body := set("alpaca", 1); status != 200 {
		t.Fatalf("%d %s", status, body)
	}
	status, body := h.post("GetQuotes", &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}, readAuth())
	var q pb.GetQuotesResponse
	if status != 200 || protojson.Unmarshal(body, &q) != nil || q.Served.Provider != "alpaca" || q.Served.Fallback {
		t.Fatalf("preference must route to alpaca with no fallback flag: %d %s", status, body)
	}
	if status, _ := set("ibkr", 0); status != 400 { // version must be >= 1
		t.Fatalf("version 0: %d", status)
	}
	if status, _ := set("ibkr", 5); status != 200 {
		t.Fatal("v5")
	}
	if status, _ := set("alpaca", 4); status != 409 { // aborted: stale
		t.Fatalf("stale version: %d", status)
	}
}

func TestRequestLogCarriesTheStoryAndNoSecrets(t *testing.T) {
	h := newHarness(t)
	h.IBKR.setDown(true)
	// A secret in the query string and a bad token: neither may reach the logs.
	r, _ := http.NewRequest(http.MethodPost, h.URL+rpcBase+"GetQuotes?apikey=URL-SECRET-123", strings.NewReader(`{"symbols":["AAPL"]}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+readToken)
	if resp, err := http.DefaultClient.Do(r); err != nil || resp.StatusCode != 200 {
		t.Fatalf("%v %v", resp, err)
	}
	h.post("GetQuotes", &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}, map[string]string{"Authorization": "Bearer WRONG-TOKEN-456"})
	h.post("SetRouting", &pb.SetRoutingRequest{Version: 1}, map[string]string{"Authorization": "Bearer " + readToken, adminHeader: "WRONG-ADMIN-789"})

	logs := h.Logs.String()
	for _, secret := range []string{readToken, adminToken, "URL-SECRET-123", "WRONG-TOKEN-456", "WRONG-ADMIN-789", "apikey", "Bearer"} {
		if strings.Contains(logs, secret) {
			t.Fatalf("logs leak %q:\n%s", secret, logs)
		}
	}
	var line map[string]any
	for _, l := range strings.Split(strings.TrimSpace(logs), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) != nil {
			t.Fatalf("log line is not JSON: %s", l)
		}
		if m["msg"] == "request" {
			line = m
		}
	}
	for k, want := range map[string]any{"rpc": "GetQuotes", "class": "equity_quotes", "preferred": "ibkr", "served_by": "alpaca",
		"quality": "DELAYED_15M", "fallback": true, "outcome": "ok"} {
		if line[k] != want {
			t.Errorf("log %s = %v, want %v\n%v", k, line[k], want, line)
		}
	}
	if !strings.HasPrefix(line["fallback_reason"].(string), "ibkr: ") || line["attempts"].([]any)[0] != "ibkr:UNAVAILABLE" {
		t.Errorf("fallback story missing: %v", line)
	}
}

func TestWatchStatusSendsNowOnChangeAndAsHeartbeat(t *testing.T) {
	h := newHarness(t)
	client := marketdatav1connect.NewMarketDataClient(http.DefaultClient, h.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req := connect.NewRequest(&pb.WatchStatusRequest{})
	req.Header().Set("Authorization", "Bearer "+readToken)
	stream, err := client.WatchStatus(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	next := func() *pb.BridgeStatus {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg()
	}
	if first := next(); first.Role != "bridge" || first.Routing.Source != pb.RoutingSource_ENV_DEFAULT {
		t.Fatalf("first: %+v", first)
	}
	if hb := next(); hb.Routing.Version != 0 { // heartbeat: the same state again
		t.Fatalf("heartbeat: %+v", hb)
	}
	h.post("SetRouting", &pb.SetRoutingRequest{Version: 3}, adminAuth())
	for i := 0; i < 5; i++ {
		if m := next(); m.Routing.Version == 3 && m.Routing.Source == pb.RoutingSource_DESK {
			return
		}
	}
	t.Fatal("a routing change must reach the watcher")
}

func TestWatchStatusNeedsAuth(t *testing.T) {
	h := newHarness(t)
	client := marketdatav1connect.NewMarketDataClient(http.DefaultClient, h.URL)
	stream, err := client.WatchStatus(context.Background(), connect.NewRequest(&pb.WatchStatusRequest{}))
	if err == nil {
		defer stream.Close()
		if stream.Receive() {
			t.Fatal("an unauthenticated stream must be refused before any message")
		}
		err = stream.Err()
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("want unauthenticated, got %v", err)
	}
}
