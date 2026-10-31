package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"connectrpc.com/connect"

	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1/marketdatav1connect"
)

// adminHeader carries MARKET_DATA_BRIDGE_ADMIN_TOKEN. SetRouting needs it in
// addition to the bearer read token (02t §3.1).
const adminHeader = "X-Admin-Token"

// authInterceptor checks the bearer token with a constant-time compare, like
// 01m's X-API-Key. With no token configured every call is rejected: the bridge
// serves nobody until the profile is rendered, and never serves unauthenticated.
// Tokens, headers, and query strings are never logged.
type authInterceptor struct {
	token, admin []byte // sha256 digests; nil = not configured
	log          *slog.Logger
}

func digest(s string) []byte {
	if s == "" {
		return nil
	}
	d := sha256.Sum256([]byte(s))
	return d[:]
}

func newAuth(token, admin string, log *slog.Logger) *authInterceptor {
	return &authInterceptor{token: digest(token), admin: digest(admin), log: log}
}

// match compares digests, so the compare time never depends on the token length.
func match(want []byte, given string) bool {
	if want == nil {
		return false
	}
	got := sha256.Sum256([]byte(given))
	return subtle.ConstantTimeCompare(want, got[:]) == 1
}

func bearer(h http.Header) string {
	v := h.Get("Authorization")
	if len(v) > 7 && strings.EqualFold(v[:7], "bearer ") {
		return v[7:]
	}
	return ""
}

func (a *authInterceptor) check(h http.Header, procedure string) error {
	if !match(a.token, bearer(h)) {
		a.log.Warn("auth rejected", "rpc", rpcName(procedure), "reason", "unauthenticated")
		return connect.NewError(connect.CodeUnauthenticated, errors.New("missing or invalid bearer token"))
	}
	if procedure == marketdatav1connect.MarketDataSetRoutingProcedure && !match(a.admin, h.Get(adminHeader)) {
		a.log.Warn("auth rejected", "rpc", rpcName(procedure), "reason", "admin token")
		return connect.NewError(connect.CodePermissionDenied, errors.New("SetRouting needs the admin token"))
	}
	return nil
}

func rpcName(procedure string) string {
	if i := strings.LastIndex(procedure, "/"); i >= 0 {
		return procedure[i+1:]
	}
	return procedure
}

func (a *authInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		if err := a.check(req.Header(), req.Spec().Procedure); err != nil {
			return nil, err
		}
		return next(ctx, req)
	}
}

func (a *authInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (a *authInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		if err := a.check(conn.RequestHeader(), conn.Spec().Procedure); err != nil {
			return err
		}
		return next(ctx, conn)
	}
}
