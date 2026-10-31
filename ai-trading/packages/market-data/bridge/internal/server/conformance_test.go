package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

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
}

func steps() []step {
	quotes := func() proto.Message { return &pb.GetQuotesResponse{} }
	day := &pb.GetBarsRequest{Symbol: "AAPL", Timeframe: pb.Timeframe_DAY_1, Adjustment: pb.Adjustment_SPLIT,
		Start: timestamppb.New(fixedNow.AddDate(0, 0, -5)), End: timestamppb.New(fixedNow)}
	prefAlpaca := &pb.SetRoutingRequest{Version: 2, Preferences: []*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "alpaca"}}}
	return []step{
		{golden: "get_quotes", rpc: "GetQuotes", req: &pb.GetQuotesRequest{Symbols: []string{"AAPL", "MSFT", "ZZZZ"}}, resp: quotes, auth: "read"},
		{golden: "get_quotes_invalid", rpc: "GetQuotes", req: &pb.GetQuotesRequest{Symbols: []string{"not a ticker"}}, resp: quotes, auth: "read", wantErr: connect.CodeInvalidArgument},
		{golden: "get_bars_daily", rpc: "GetBars", req: day, resp: func() proto.Message { return &pb.GetBarsResponse{} }, auth: "read"},
		{golden: "list_providers", rpc: "ListProviders", req: &pb.ListProvidersRequest{}, resp: func() proto.Message { return &pb.ListProvidersResponse{} }, auth: "read"},
		{golden: "get_status", rpc: "GetStatus", req: &pb.GetStatusRequest{}, resp: func() proto.Message { return &pb.BridgeStatus{} }, auth: "read"},
		{golden: "get_quotes_fallback", pre: func(h *harness) { h.IBKR.setDown(true) }, rpc: "GetQuotes", req: &pb.GetQuotesRequest{Symbols: []string{"AAPL"}}, resp: quotes, auth: "read"},
		{golden: "list_providers_ibkr_down", rpc: "ListProviders", req: &pb.ListProvidersRequest{}, resp: func() proto.Message { return &pb.ListProvidersResponse{} }, auth: "read"},
		{golden: "set_routing", rpc: "SetRouting", req: prefAlpaca, resp: func() proto.Message { return &pb.Routing{} }, auth: "admin"},
		{golden: "set_routing_invalid", rpc: "SetRouting", req: &pb.SetRoutingRequest{Version: 3, Preferences: []*pb.ClassPreference{{DataClass: pb.DataClass_EQUITY_QUOTES, Provider: "marketdata_app"}}},
			resp: func() proto.Message { return &pb.Routing{} }, auth: "admin", wantErr: connect.CodeInvalidArgument},
		{golden: "set_routing_denied", rpc: "SetRouting", req: prefAlpaca, resp: func() proto.Message { return &pb.Routing{} }, auth: "read", wantErr: connect.CodePermissionDenied},
		{golden: "get_status_unauthenticated", rpc: "GetStatus", req: &pb.GetStatusRequest{}, resp: func() proto.Message { return &pb.BridgeStatus{} }, auth: "none", wantErr: connect.CodeUnauthenticated},
		{rpc: "GetOptionChain", req: &pb.GetOptionChainRequest{Underlying: "AAPL", MaxDte: 30}, resp: func() proto.Message { return &pb.GetOptionChainResponse{} }, auth: "read", wantErr: connect.CodeUnimplemented},
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
		h := newHarness(t)
		for _, s := range script {
			if s.pre != nil {
				s.pre(h)
			}
			results[tr.name] = append(results[tr.name], tr.call(t, h, s))
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
