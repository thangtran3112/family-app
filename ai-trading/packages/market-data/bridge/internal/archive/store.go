package archive

import (
	"context"
	"sort"
	"sync"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

// Session is one finished XNYS session of one symbol, as the archive holds it. Bars may be empty:
// a quiet session is a complete answer (02u §3.2), distinct from a failed fetch.
type Session struct {
	Date     string // ET trading date, YYYY-MM-DD
	Provider string
	Bars     []*pb.Bar // Start, OHLCV, SessionDate only; the Archive adds close_at and source
}

// Store is the archive's storage. Timeframe is the calendar's name: xnys.TimeframeDay or
// xnys.TimeframeMin.
type Store interface {
	// Read returns the recorded sessions with session date in [from, to] (inclusive), bars ordered.
	Read(ctx context.Context, symbol, timeframe, from, to string) ([]Session, error)
	// Write records sessions once. A session already recorded is left untouched: first vendor wins.
	Write(ctx context.Context, symbol, timeframe string, sessions []Session) error
}

// MemStore is the in-memory Store for tests, with the same write-once rule as Postgres.
type MemStore struct {
	mu   sync.Mutex
	data map[[3]string]Session // symbol, timeframe, date
}

func NewMemStore() *MemStore { return &MemStore{data: map[[3]string]Session{}} }

func (m *MemStore) Read(_ context.Context, symbol, tf, from, to string) ([]Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Session
	for k, s := range m.data {
		if k[0] == symbol && k[1] == tf && k[2] >= from && k[2] <= to {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date < out[j].Date })
	return out, nil
}

func (m *MemStore) Write(_ context.Context, symbol, tf string, sessions []Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range sessions {
		k := [3]string{symbol, tf, s.Date}
		if _, ok := m.data[k]; !ok {
			m.data[k] = s
		}
	}
	return nil
}
