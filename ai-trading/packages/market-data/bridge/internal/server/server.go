// Package server is the connect-go handler: gRPC, gRPC-Web, and the Connect
// protocol (unary JSON over HTTP) on one port, plus a plain GET /healthz.
package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1/marketdatav1connect"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/config"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
)

const (
	maxSymbols = 100
	maxBody    = 1 << 20
)

// Same pattern as 01m's TICKER.
var ticker = regexp.MustCompile(`^[A-Z0-9][A-Z0-9.\-]{0,9}$`)

type Options struct {
	Router     *router.Router
	Token      string
	AdminToken string
	Build      string
	Log        *slog.Logger
	Now        func() time.Time // default time.Now
	Heartbeat  time.Duration    // WatchStatus heartbeat; default 5 s
}

type service struct {
	marketdatav1connect.UnimplementedMarketDataHandler // GetOptionChain: B6
	r                                                  *router.Router
	build                                              string
	log                                                *slog.Logger
	now                                                func() time.Time
	heartbeat                                          time.Duration
}

// Handler returns the whole HTTP surface, h2c-enabled for gRPC inside the Docker network.
func Handler(o Options) http.Handler {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Heartbeat <= 0 {
		o.Heartbeat = 5 * time.Second
	}
	svc := &service{r: o.Router, build: o.Build, log: o.Log, now: o.Now, heartbeat: o.Heartbeat}
	mux := http.NewServeMux()
	path, h := marketdatav1connect.NewMarketDataHandler(svc,
		connect.WithInterceptors(newAuth(o.Token, o.AdminToken, o.Log)),
		connect.WithReadMaxBytes(maxBody))
	mux.Handle(path, h)
	// Process health only, never provider health: a gateway that is off must
	// not restart the container.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","role":"` + o.Router.Role() + `"}`))
	})
	return h2c.NewHandler(mux, &http2.Server{})
}

func (s *service) GetQuotes(ctx context.Context, req *connect.Request[pb.GetQuotesRequest]) (*connect.Response[pb.GetQuotesResponse], error) {
	start := s.now()
	symbols, err := cleanSymbols(req.Msg.Symbols)
	if err != nil {
		return nil, err
	}
	resp, rerr := s.r.Quotes(ctx, symbols, req.Msg.PinProvider)
	var served *pb.Served
	if resp != nil {
		served = resp.Served
	}
	s.logRequest("GetQuotes", pb.DataClass_EQUITY_QUOTES, served, rerr, start)
	if rerr != nil {
		return nil, toConnect(rerr)
	}
	return connect.NewResponse(resp), nil
}

func (s *service) GetBars(ctx context.Context, req *connect.Request[pb.GetBarsRequest]) (*connect.Response[pb.GetBarsResponse], error) {
	start := s.now()
	m := req.Msg
	syms, err := cleanSymbols([]string{m.Symbol})
	if err != nil {
		return nil, err
	}
	switch {
	case m.Timeframe == pb.Timeframe_TIMEFRAME_UNSPECIFIED:
		return nil, invalid("timeframe is required")
	case m.Start == nil || m.End == nil || !m.Start.AsTime().Before(m.End.AsTime()):
		return nil, invalid("start and end are required, and start must be before end")
	}
	clean := &pb.GetBarsRequest{Symbol: syms[0], Timeframe: m.Timeframe, Start: m.Start, End: m.End, Adjustment: m.Adjustment, PinProvider: m.PinProvider}
	resp, rerr := s.r.Bars(ctx, clean)
	var served *pb.Served
	if resp != nil {
		served = resp.Served
	}
	s.logRequest("GetBars", pb.DataClass_EQUITY_BARS, served, rerr, start)
	if rerr != nil {
		return nil, toConnect(rerr)
	}
	return connect.NewResponse(resp), nil
}

func (s *service) ListProviders(context.Context, *connect.Request[pb.ListProvidersRequest]) (*connect.Response[pb.ListProvidersResponse], error) {
	return connect.NewResponse(&pb.ListProvidersResponse{Providers: s.r.Providers()}), nil
}

func (s *service) GetStatus(context.Context, *connect.Request[pb.GetStatusRequest]) (*connect.Response[pb.BridgeStatus], error) {
	return connect.NewResponse(s.r.Status(s.build)), nil
}

// WatchStatus sends the status now, on every routing or health change, and as
// a heartbeat so a watcher can tell a quiet bridge from a dead one.
func (s *service) WatchStatus(ctx context.Context, _ *connect.Request[pb.WatchStatusRequest], stream *connect.ServerStream[pb.BridgeStatus]) error {
	tick := time.NewTicker(s.heartbeat)
	defer tick.Stop()
	for {
		changed := s.r.Changed() // take it before the snapshot so no change is missed
		if err := stream.Send(s.r.Status(s.build)); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-changed:
		case <-tick.C:
		}
	}
}

func (s *service) SetRouting(_ context.Context, req *connect.Request[pb.SetRoutingRequest]) (*connect.Response[pb.Routing], error) {
	routing, err := s.r.SetRouting(req.Msg.Preferences, req.Msg.Version)
	if err != nil {
		s.log.Info("set routing rejected", "rpc", "SetRouting", "version", req.Msg.Version, "error", err.Error())
		return nil, toConnect(err)
	}
	s.log.Info("routing set", "rpc", "SetRouting", "version", routing.Version)
	return connect.NewResponse(routing), nil
}

func invalid(msg string) error { return connect.NewError(connect.CodeInvalidArgument, errors.New(msg)) }

// cleanSymbols upper-cases, dedupes in order, and validates 1..100 tickers.
func cleanSymbols(in []string) ([]string, error) {
	if len(in) == 0 || len(in) > maxSymbols {
		return nil, invalid("symbols: need 1 to 100")
	}
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		s = strings.ToUpper(strings.TrimSpace(s))
		if !ticker.MatchString(s) {
			return nil, invalid("symbols: not a ticker: " + truncate(s, 16))
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out, nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// toConnect maps router errors onto Connect codes, which the Python seam maps
// back onto its taxonomy (02t §4.1). When every rung failed, the attempts ride
// along as an error detail so the caller can say why.
func toConnect(err error) error {
	var re *router.RouteError
	switch {
	case errors.As(err, &re):
		code := map[pb.ErrorKind]connect.Code{
			pb.ErrorKind_UNAVAILABLE:    connect.CodeUnavailable,
			pb.ErrorKind_SOFT_BANNED:    connect.CodeResourceExhausted,
			pb.ErrorKind_NOT_ENTITLED:   connect.CodePermissionDenied,
			pb.ErrorKind_NO_DATA:        connect.CodeNotFound,
			pb.ErrorKind_NOT_CONFIGURED: connect.CodeFailedPrecondition,
		}[re.Kind]
		cerr := connect.NewError(code, re)
		if d, derr := connect.NewErrorDetail(&pb.Served{Attempts: re.Attempts}); derr == nil {
			cerr.AddDetail(d)
		}
		return cerr
	case errors.Is(err, router.ErrInvalid):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, router.ErrStale):
		return connect.NewError(connect.CodeAborted, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	}
	return connect.NewError(connect.CodeInternal, errors.New("internal error"))
}

// logRequest writes one JSON line per data request. Never tokens, headers, or query strings.
func (s *service) logRequest(rpc string, class pb.DataClass, served *pb.Served, err error, start time.Time) {
	attrs := []any{"rpc", rpc, "class", config.ClassName(class), "preferred", s.r.Preferred(class),
		"latency_ms", s.now().Sub(start).Milliseconds()}
	var attempts []string
	switch {
	case err == nil:
		attrs = append(attrs, "served_by", served.Provider, "quality", served.Quality.String(),
			"fallback", served.Fallback, "fallback_reason", served.FallbackReason, "outcome", "ok")
		for _, a := range served.Attempts {
			attempts = append(attempts, a.Provider+":"+a.Error.String())
		}
	default:
		var re *router.RouteError
		if errors.As(err, &re) {
			for _, a := range re.Attempts {
				attempts = append(attempts, a.Provider+":"+a.Error.String())
			}
		}
		attrs = append(attrs, "outcome", "error", "error_kind", errKind(err))
	}
	attrs = append(attrs, "attempts", attempts)
	s.log.Info("request", attrs...)
}

func errKind(err error) string {
	var re *router.RouteError
	if errors.As(err, &re) {
		return re.Kind.String()
	}
	return connect.CodeOf(toConnect(err)).String()
}
