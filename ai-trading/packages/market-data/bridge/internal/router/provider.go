// Package router holds the provider interfaces, the fallback ladder, the
// health cache, and the in-memory routing preference (02t §3.3, §3.5).
package router

import (
	"context"
	"errors"
	"strings"
	"time"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

// Errors mirror ai_trading_common.errors, so both languages fall through on
// the same conditions. Adapters wrap them with %w and a message that never
// carries a secret.
var (
	ErrNotConfigured = errors.New("not configured")
	ErrUnavailable   = errors.New("unavailable")
	ErrSoftBanned    = errors.New("soft banned")
	ErrNoData        = errors.New("no data")
	ErrNotEntitled   = errors.New("not entitled")
)

// Health is what a provider knows about itself, with no network call. The
// router overlays its own mark-down state, last-ok time, and counters.
type Health struct {
	State   pb.HealthState
	Reason  string
	Quality pb.Quality // what it serves right now
}

type Provider interface {
	Name() string
	Classes() []pb.DataClass
	Configured() bool // credentials present; cheap, no network
	Health() Health   // cached state; no network
	// Probe is the cheap liveness call the background re-probe makes while the
	// router has the provider marked down. It must never place a heavy request.
	Probe(ctx context.Context) error
}

type QuoteProvider interface {
	Provider
	Quotes(ctx context.Context, symbols []string) ([]*pb.Quote, error)
}

type BarsProvider interface {
	Provider
	Bars(ctx context.Context, r *pb.GetBarsRequest) ([]*pb.Bar, pb.Quality, error)
}

// Request errors the server maps onto Connect codes.
var (
	ErrInvalid = errors.New("invalid request")
	ErrStale   = errors.New("stale routing version")
)

// RouteError is returned when every rung failed.
type RouteError struct {
	Kind     pb.ErrorKind // the most serious attempt error: an outage ranks ahead of NO_DATA
	Attempts []*pb.Attempt
}

func (e *RouteError) Error() string {
	msg := "no provider answered"
	for _, a := range e.Attempts {
		msg += "; " + a.Provider + ": " + a.Message
	}
	return msg
}

// messageOf drops the sentinel prefix an adapter wrapped on: the attempt's
// error field already carries the kind, so "ibkr: gateway_down" reads cleanly.
func messageOf(err error) string {
	msg := err.Error()
	for _, s := range []error{ErrNotConfigured, ErrUnavailable, ErrSoftBanned, ErrNoData, ErrNotEntitled} {
		if rest, ok := strings.CutPrefix(msg, s.Error()+": "); ok {
			return rest
		}
	}
	return msg
}

func kindOf(err error) pb.ErrorKind {
	switch {
	case errors.Is(err, ErrNotConfigured):
		return pb.ErrorKind_NOT_CONFIGURED
	case errors.Is(err, ErrSoftBanned):
		return pb.ErrorKind_SOFT_BANNED
	case errors.Is(err, ErrNoData):
		return pb.ErrorKind_NO_DATA
	case errors.Is(err, ErrNotEntitled):
		return pb.ErrorKind_NOT_ENTITLED
	case errors.Is(err, context.Canceled):
		return pb.ErrorKind_UNAVAILABLE
	}
	return pb.ErrorKind_UNAVAILABLE // ErrUnavailable and anything unclassified
}

// severity ranks attempt errors for the final error: outage first.
var severity = map[pb.ErrorKind]int{
	pb.ErrorKind_UNAVAILABLE:    5,
	pb.ErrorKind_SOFT_BANNED:    4,
	pb.ErrorKind_NOT_ENTITLED:   3,
	pb.ErrorKind_NO_DATA:        2,
	pb.ErrorKind_NOT_CONFIGURED: 1,
}

func worst(attempts []*pb.Attempt) pb.ErrorKind {
	kind := pb.ErrorKind_ERROR_KIND_UNSPECIFIED
	for _, a := range attempts {
		if severity[a.Error] > severity[kind] {
			kind = a.Error
		}
	}
	return kind
}

type clock func() time.Time
