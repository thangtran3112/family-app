package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/providers/alpaca"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
)

const (
	readToken  = "read-token-SECRET"
	adminToken = "admin-token-SECRET"
	rpcBase    = "/familyapp.marketdata.v1.MarketData/"
)

// 2024-05-02 16:30 ET: fixed so the contract goldens are deterministic.
var fixedNow = time.Date(2024, 5, 2, 20, 30, 0, 0, time.UTC)

// fakeIBKR stands in for the B1 remote rung: realtime when up, a named outage when down.
type fakeIBKR struct {
	mu   sync.Mutex
	down bool
}

func (f *fakeIBKR) setDown(v bool)          { f.mu.Lock(); f.down = v; f.mu.Unlock() }
func (f *fakeIBKR) Name() string            { return "ibkr" }
func (f *fakeIBKR) Classes() []pb.DataClass { return []pb.DataClass{pb.DataClass_EQUITY_QUOTES} }
func (f *fakeIBKR) Configured() bool        { return true }
func (f *fakeIBKR) Health() router.Health {
	return router.Health{State: pb.HealthState_HEALTH_STATE_OK, Quality: pb.Quality_REALTIME}
}
func (f *fakeIBKR) Probe(context.Context) error { return nil }
func (f *fakeIBKR) Quotes(_ context.Context, syms []string) ([]*pb.Quote, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		return nil, fmt.Errorf("%w: gateway_down", router.ErrUnavailable)
	}
	var out []*pb.Quote
	for _, s := range syms {
		out = append(out, &pb.Quote{Symbol: s, Last: 190, Bid: proto.Float64(189.99), Ask: proto.Float64(190.01),
			AsOf: timestamppb.New(fixedNow), Quality: pb.Quality_REALTIME, Provider: "ibkr"})
	}
	return out, nil
}

func fakeAlpacaHandler(alpacaDown *bool, mu *sync.Mutex) http.HandlerFunc {
	prices := map[string]string{"AAPL": "187.5", "MSFT": "410.25", "SPY": "455.2"}
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		down := *alpacaDown
		mu.Unlock()
		if down {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		sym := strings.Split(strings.Trim(r.URL.Path, "/"), "/")[0]
		price, ok := prices[sym]
		if !ok {
			http.NotFound(w, r)
			return
		}
		switch tf := r.URL.Query().Get("timeframe"); tf {
		case "1Day":
			_, _ = fmt.Fprintf(w, `{"bars":[
				{"t":"2024-04-30T04:00:00Z","o":180,"h":185,"l":179,"c":184,"v":1000},
				{"t":"2024-05-01T04:00:00Z","o":184,"h":190,"l":183,"c":%s,"v":1200}],"next_page_token":null}`, price)
			return
		case "1Hour":
			// 2023-11-24 (the Friday after Thanksgiving) is an early close: 13:00 ET. The 12:30 ET
			// bar closes at the regular close, not at 13:30, and the 14:00 ET post-market bar keeps
			// its full hour.
			_, _ = w.Write([]byte(`{"bars":[
				{"t":"2023-11-24T17:30:00Z","o":455,"h":456,"l":454.5,"c":455.2,"v":900},
				{"t":"2023-11-24T19:00:00Z","o":455.2,"h":455.6,"l":454.8,"c":455.4,"v":300}],"next_page_token":null}`))
			return
		}
		_, _ = fmt.Fprintf(w, `{"bars":[{"t":"2024-05-02T20:14:00Z","o":1,"h":2,"l":1,"c":%s,"v":900}],"next_page_token":null}`, price)
	}
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

type harness struct {
	t          *testing.T
	URL        string
	Router     *router.Router
	IBKR       *fakeIBKR
	Logs       *lockedBuf
	alpacaDown bool
	amu        sync.Mutex
}

func newHarness(t *testing.T, mods ...func(*Options)) *harness {
	t.Helper()
	h := &harness{t: t, IBKR: &fakeIBKR{}, Logs: &lockedBuf{}}
	fake := httptest.NewServer(fakeAlpacaHandler(&h.alpacaDown, &h.amu))
	t.Cleanup(fake.Close)
	clock := func() time.Time { return fixedNow }
	al := alpaca.New("key", "secret", alpaca.WithBaseURL(fake.URL), alpaca.WithClock(clock), alpaca.WithMinInterval(0))
	h.Router = router.New(router.Options{
		Role: "bridge", Now: clock,
		Ladders: map[pb.DataClass][]string{
			pb.DataClass_EQUITY_QUOTES: {"ibkr", "alpaca"},
			pb.DataClass_EQUITY_BARS:   {"alpaca"},
		},
		Providers: []router.Provider{h.IBKR, al},
	})
	o := &Options{Router: h.Router, Token: readToken, AdminToken: adminToken, Build: "test-build", Now: clock,
		Log: slog.New(slog.NewJSONHandler(h.Logs, nil)), Heartbeat: 20 * time.Millisecond}
	for _, m := range mods {
		m(o)
	}
	srv := httptest.NewServer(Handler(*o))
	t.Cleanup(srv.Close)
	h.URL = srv.URL
	return h
}

func (h *harness) setAlpacaDown(v bool) { h.amu.Lock(); h.alpacaDown = v; h.amu.Unlock() }

// post sends one Connect unary JSON call, the transport the Python seam uses.
func (h *harness) post(rpc string, req proto.Message, headers map[string]string) (int, []byte) {
	h.t.Helper()
	body := []byte("{}")
	if req != nil {
		var err error
		if body, err = protojson.Marshal(req); err != nil {
			h.t.Fatal(err)
		}
	}
	r, _ := http.NewRequest(http.MethodPost, h.URL+rpcBase+rpc, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func readAuth() map[string]string { return map[string]string{"Authorization": "Bearer " + readToken} }
func adminAuth() map[string]string {
	return map[string]string{"Authorization": "Bearer " + readToken, adminHeader: adminToken}
}

// normalize re-encodes JSON with sorted keys: protojson output is deliberately unstable.
func normalize(t *testing.T, raw []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("not JSON: %s", raw)
	}
	return v
}

// golden compares a Connect JSON exchange with testdata/contract/<name>.json
// (request, HTTP status, response), which the Python adapter tests replay.
// Run `go test ./internal/server -update` after an intended change.
func golden(t *testing.T, name, rpc string, req proto.Message, status int, body []byte) {
	t.Helper()
	var reqJSON any = map[string]any{}
	if req != nil {
		b, _ := protojson.Marshal(req)
		reqJSON = normalize(t, b)
	}
	got, err := json.MarshalIndent(map[string]any{"rpc": rpc, "request": reqJSON, "http_status": status, "response": normalize(t, body)}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	path := filepath.Join("..", "..", "testdata", "contract", name+".json")
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", path, err)
	}
	if !bytes.Equal(want, got) {
		t.Fatalf("golden %s differs (run with -update if intended):\n--- want\n%s\n--- got\n%s", name, want, got)
	}
}
