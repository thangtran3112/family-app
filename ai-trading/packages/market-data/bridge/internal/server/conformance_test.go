package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1/marketdatav1connect"
)

// One scripted session, run against its own bridge over every wire: gRPC
// (grpc-go), gRPC-Web, Connect protobuf, and Connect unary JSON (what the
// Python seam sends). Results must be identical, which proves the JSON path
// equals the gRPC wire (02t §8.1). The JSON run also writes/checks the goldens.
type step struct {
	golden  string // testdata/contract name; "" = not a golden
	pre     func(h *harness)
	rpc     string
	req     proto.Message
	resp    func() proto.Message
	auth    string // "none" | "read" | "admin"
	wantErr connect.Code
	archive bool // run on a bridge with the H1 archive on (the default bridge has it off)
}

func steps() []step {
	quotes := func() proto.Message { return &pb.GetQuotesResponse{} }
	bars := func() proto.Message { return &pb.GetBarsResponse{} }
	day := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_SPLIT,
		Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow)}
	// The 5U request: one whole session (`extended_open`..`extended_close`). Before C0 the adapter
	// sent this start unpadded and Alpaca answered nothing, because the daily bar is stamped at
	// midnight ET, 04:00Z, an hour before this start.
	singleSession := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1,
		Start: timestamppb.New(time.Date(2024, 5, 1, 8, 0, 0, 0, time.UTC)), End: timestamppb.New(time.Date(2024, 5, 2, 0, 0, 0, 0, time.UTC))}
	// as_of mid-session: 2024-05-01 15:00 ET. That day's daily bar (closes 20:00Z) must be absent;
	// 04-30's is present. No look-ahead (02u §4, read_bars semantics).
	midSession := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1,
		Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow),
		AsOf: timestamppb.New(time.Date(2024, 5, 1, 19, 0, 0, 0, time.UTC))}
	minute := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_MINUTE_1,
		Start: timestamppb.New(time.Date(2024, 5, 2, 20, 0, 0, 0, time.UTC)), End: timestamppb.New(fixedNow)}
	// 2023-11-24 is an early close (13:00 ET): the 12:30 ET hourly bar closes at 18:00Z, not 18:30Z.
	halfDay := &pb.GetBarsRequest{Symbol: "SPY", Timeframe: pb.Timeframe_HOUR_1,
		Start: timestamppb.New(time.Date(2023, 11, 24, 15, 0, 0, 0, time.UTC)), End: timestamppb.New(time.Date(2023, 11, 24, 21, 0, 0, 0, time.UTC))}
	ensure := &pb.EnsureHistoryRequest{Symbols: []string{"AAPL"}, Timeframe: pb.Timeframe_DAY_1, FirstSession: "2024-04-30", LastSession: "2024-05-01"}
	prefAlpaca := &pb.SetRoutingRequest{Version: 2, Preferences: []*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "alpaca"}}}
	return []step{
		{golden: "get_quotes", rpc: "GetQuotes", req: &pb.GetQuotesRequest{Symbols: []string{"AAPL", "MSFT", "ZZZZ"}}, resp: quotes, auth: "read"},
		{golden: "get_quotes_invalid", rpc: "GetQuotes", req: &pb.GetQuotesRequest{Symbols: []string{"not a ticker"}}, resp: quotes, auth: "read", wantErr: connect.CodeInvalidArgument},
		{golden: "get_bars_daily", rpc: "GetBars", req: day, resp: bars, auth: "read"},
		{golden: "get_bars_daily_single_session", rpc: "GetBars", req: singleSession, resp: bars, auth: "read"},
		{golden: "get_bars_as_of_mid_session", rpc: "GetBars", req: midSession, resp: bars, auth: "read"},
		{golden: "get_bars_minute", rpc: "GetBars", req: minute, resp: bars, auth: "read"},
		{golden: "get_bars_hourly_half_day", rpc: "GetBars", req: halfDay, resp: bars, auth: "read"},
		{golden: "get_bars_invalid", rpc: "GetBars", req: &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1,
			Start: timestamppb.New(fixedNow), End: timestamppb.New(fixedNow.AddDate(0, 0, -1))}, resp: bars, auth: "read", wantErr: connect.CodeInvalidArgument},
		{golden: "list_providers", rpc: "ListProviders", req: &pb.ListProvidersRequest{}, resp: func() proto.Message { return &pb.ListProvidersResponse{} }, auth: "read"},
		{golden: "list_providers_unauthenticated", rpc: "ListProviders", req: &pb.ListProvidersRequest{}, resp: func() proto.Message { return &pb.ListProvidersResponse{} }, auth: "none", wantErr: connect.CodeUnauthenticated},
		{golden: "get_status", rpc: "GetStatus", req: &pb.GetStatusRequest{}, resp: func() proto.Message { return &pb.BridgeStatus{} }, auth: "read"},
		{golden: "get_quotes_fallback", pre: func(h *harness) { h.IBKR.setDown(true) }, rpc: "GetQuotes", req: &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}, resp: quotes, auth: "read"},
		{golden: "list_providers_ibkr_down", rpc: "ListProviders", req: &pb.ListProvidersRequest{}, resp: func() proto.Message { return &pb.ListProvidersResponse{} }, auth: "read"},
		{golden: "set_routing", rpc: "SetRouting", req: prefAlpaca, resp: func() proto.Message { return &pb.Routing{} }, auth: "admin"},
		{golden: "set_routing_invalid", rpc: "SetRouting", req: &pb.SetRoutingRequest{Version: 3, Preferences: []*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "marketdata_app"}}},
			resp: func() proto.Message { return &pb.Routing{} }, auth: "admin", wantErr: connect.CodeInvalidArgument},
		{golden: "set_routing_denied", rpc: "SetRouting", req: prefAlpaca, resp: func() proto.Message { return &pb.Routing{} }, auth: "read", wantErr: connect.CodePermissionDenied},
		{golden: "get_status_unauthenticated", rpc: "GetStatus", req: &pb.GetStatusRequest{}, resp: func() proto.Message { return &pb.BridgeStatus{} }, auth: "none", wantErr: connect.CodeUnauthenticated},
		{rpc: "GetOptionChain", req: &pb.GetOptionChainRequest{Underlying: "AAPL", MaxDte: 30}, resp: func() proto.Message { return &pb.GetOptionChainResponse{} }, auth: "read", wantErr: connect.CodeUnimplemented},
		{golden: "get_bars_daily_single_session", rpc: "GetBars", req: singleSession, resp: bars, auth: "read"},
		{golden: "get_bars_as_of_mid_session", rpc: "GetBars", req: midSession, resp: bars, auth: "read"},
		{golden: "get_bars_minute", rpc: "GetBars", req: minute, resp: bars, auth: "read"},
		{golden: "get_bars_hourly_half_day", rpc: "GetBars", req: halfDay, resp: bars, auth: "read"},
		{golden: "get_bars_invalid", rpc: "GetBars", req: &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1,
			Start: timestamppb.New(fixedNow), End: timestamppb.New(fixedNow.AddDate(0, 0, -1))}, resp: bars, auth: "read", wantErr: connect.CodeInvalidArgument},
		{golden: "list_providers_unauthenticated", rpc: "ListProviders", req: &pb.ListProvidersRequest{}, resp: func() proto.Message { return &pb.ListProvidersResponse{} }, auth: "none", wantErr: connect.CodeUnauthenticated},
		{golden: "ensure_history", archive: true, rpc: "EnsureHistory", req: ensure, resp: func() proto.Message { return &pb.EnsureHistoryResponse{} }, auth: "read"},
		{golden: "ensure_history_disabled", rpc: "EnsureHistory", req: ensure, resp: func() proto.Message { return &pb.EnsureHistoryResponse{} }, auth: "read", wantErr: connect.CodeUnimplemented},
		{golden: "get_quotes_unavailable", pre: func(h *harness) { h.setAlpacaDown(true) }, rpc: "GetQuotes", req: &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}, resp: quotes, auth: "read", wantErr: connect.CodeUnavailable},
	}
}

func authHeaders(kind string) map[string]string {
	switch kind {
	case "read":
		return readAuth()
	case "admin":
		return adminAuth()
	}
	return nil
}

type outcome struct {
	msg  proto.Message
	code connect.Code // 0 = ok
}

// transport runs one step on a harness and reports the outcome.
type transport struct {
	name string
	call func(t *testing.T, h *harness, s step) outcome
}

func transports() []transport {
	return []transport{
		{"grpc (grpc-go)", callGRPC},
		{"grpc-web", func(t *testing.T, h *harness, s step) outcome { return callConnect(t, h, s, connect.WithGRPCWeb()) }},
		{"connect protobuf", func(t *testing.T, h *harness, s step) outcome { return callConnect(t, h, s) }},
		{"connect json (http)", callJSON},
	}
}

func callGRPC(t *testing.T, h *harness, s step) outcome {
	t.Helper()
	conn, err := grpc.NewClient(strings.TrimPrefix(h.URL, "http://"), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	md := metadata.MD{}
	for k, v := range authHeaders(s.auth) {
		md.Set(strings.ToLower(k), v)
	}
	resp := s.resp()
	err = conn.Invoke(metadata.NewOutgoingContext(context.Background(), md), rpcBase+s.rpc, s.req, resp)
	if err != nil {
		return outcome{code: connect.Code(status.Code(err))}
	}
	return outcome{msg: resp}
}

func callConnect(t *testing.T, h *harness, s step, opts ...connect.ClientOption) outcome {
	t.Helper()
	c := marketdatav1connect.NewMarketDataClient(http.DefaultClient, h.URL, opts...)
	hdr := func(r interface{ Header() http.Header }) {
		for k, v := range authHeaders(s.auth) {
			r.Header().Set(k, v)
		}
	}
	var msg proto.Message
	var err error
	ctx := context.Background()
	switch s.rpc {
	case "GetQuotes":
		r := connect.NewRequest(s.req.(*pb.GetQuotesRequest))
		hdr(r)
		var resp *connect.Response[pb.GetQuotesResponse]
		if resp, err = c.GetQuotes(ctx, r); err == nil {
			msg = resp.Msg
		}
	case "GetBars":
		r := connect.NewRequest(s.req.(*pb.GetBarsRequest))
		hdr(r)
		var resp *connect.Response[pb.GetBarsResponse]
		if resp, err = c.GetBars(ctx, r); err == nil {
			msg = resp.Msg
		}
	case "GetOptionChain":
		r := connect.NewRequest(s.req.(*pb.GetOptionChainRequest))
		hdr(r)
		var resp *connect.Response[pb.GetOptionChainResponse]
		if resp, err = c.GetOptionChain(ctx, r); err == nil {
			msg = resp.Msg
		}
	case "ListProviders":
		r := connect.NewRequest(s.req.(*pb.ListProvidersRequest))
		hdr(r)
		var resp *connect.Response[pb.ListProvidersResponse]
		if resp, err = c.ListProviders(ctx, r); err == nil {
			msg = resp.Msg
		}
	case "EnsureHistory":
		r := connect.NewRequest(s.req.(*pb.EnsureHistoryRequest))
		hdr(r)
		var resp *connect.Response[pb.EnsureHistoryResponse]
		if resp, err = c.EnsureHistory(ctx, r); err == nil {
			msg = resp.Msg
		}
	case "GetStatus":
		r := connect.NewRequest(s.req.(*pb.GetStatusRequest))
		hdr(r)
		var resp *connect.Response[pb.BridgeStatus]
		if resp, err = c.GetStatus(ctx, r); err == nil {
			msg = resp.Msg
		}
	case "SetRouting":
		r := connect.NewRequest(s.req.(*pb.SetRoutingRequest))
		hdr(r)
		var resp *connect.Response[pb.Routing]
		if resp, err = c.SetRouting(ctx, r); err == nil {
			msg = resp.Msg
		}
	default:
		t.Fatalf("no connect caller for %s", s.rpc)
	}
	if err != nil {
		return outcome{code: connect.CodeOf(err)}
	}
	return outcome{msg: msg}
}

// callJSON is the Python seam's transport: a plain HTTP POST of protojson.
func callJSON(t *testing.T, h *harness, s step) outcome {
	t.Helper()
	status, body := h.post(s.rpc, s.req, authHeaders(s.auth))
	if s.golden != "" {
		golden(t, s.golden, s.rpc, s.req, status, body)
	}
	if status != http.StatusOK {
		var e struct{ Code string }
		if json.Unmarshal(body, &e) != nil {
			t.Fatalf("HTTP %d with a non-JSON body: %s", status, body)
		}
		var c connect.Code
		if err := c.UnmarshalText([]byte(e.Code)); err != nil {
			t.Fatalf("unknown code %q", e.Code)
		}
		return outcome{code: c}
	}
	resp := s.resp()
	if err := protojson.Unmarshal(body, resp); err != nil {
		t.Fatalf("%s: %v\n%s", s.rpc, err, body)
	}
	return outcome{msg: resp}
}

func TestConformanceEveryRPCIdenticalOverEveryWire(t *testing.T) {
	script := steps()
	results := map[string][]outcome{}
	for _, tr := range transports() {
		h, withArchive := newHarness(t), newHarness(t, memArchive)
		for _, s := range script {
			use := h
			if s.archive {
				use = withArchive
			}
			if s.pre != nil {
				s.pre(use)
			}
			results[tr.name] = append(results[tr.name], tr.call(t, use, s))
		}
	}
	for i, s := range script {
		want := results["connect json (http)"][i]
		if want.code != s.wantErr {
			t.Errorf("step %d %s (%s): code %v, want %v", i, s.rpc, s.golden, want.code, s.wantErr)
		}
		for _, tr := range transports() {
			got := results[tr.name][i]
			if got.code != want.code || (want.msg != nil && !proto.Equal(got.msg, want.msg)) {
				t.Errorf("step %d %s (%s) over %s differs from connect json:\n got  %v %v\n want %v %v",
					i, s.rpc, s.golden, tr.name, got.code, got.msg, want.code, want.msg)
			}
		}
	}
	if codes.Code(connect.CodeUnavailable) != codes.Unavailable { // the numbering the comparison relies on
		t.Fatal("connect and gRPC code numbering diverged")
	}
}
