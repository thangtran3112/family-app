package cache

import (
	"context"
	"sync"
	"time"
)

// Store is the byte store under the cache. Every method may fail; the cache treats any error as a
// miss and never lets it reach the caller. A miss is (nil, false, nil), not an error.
type Store interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	// MGet returns one entry per key in order; a nil entry is a miss.
	MGet(ctx context.Context, keys []string) ([][]byte, error)
	// Set stores val for ttl. With nx it writes only when the key is absent (write-once).
	Set(ctx context.Context, key string, val []byte, ttl time.Duration, nx bool) error
	Backend() string // "redis" | "memory"
	Close() error
}

// MemStore is an in-process Store that honours an injected clock. It backs the tests; it is never
// wired in production.
type MemStore struct {
	now func() time.Time
	mu  sync.Mutex
	m   map[string]memEntry
}

type memEntry struct {
	val     []byte
	expires time.Time
}

func NewMemStore(now func() time.Time) *MemStore {
	if now == nil {
		now = time.Now
	}
	return &MemStore{now: now, m: map[string]memEntry{}}
}

func (s *MemStore) liveLocked(key string) ([]byte, bool) {
	e, ok := s.m[key]
	if !ok {
		return nil, false
	}
	if !s.now().Before(e.expires) {
		delete(s.m, key)
		return nil, false
	}
	return e.val, true
}

func (s *MemStore) Get(_ context.Context, key string) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.liveLocked(key)
	return append([]byte(nil), v...), ok, nil
}

func (s *MemStore) MGet(_ context.Context, keys []string) ([][]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([][]byte, len(keys))
	for i, k := range keys {
		if v, ok := s.liveLocked(k); ok {
			out[i] = append([]byte(nil), v...)
		}
	}
	return out, nil
}

func (s *MemStore) Set(_ context.Context, key string, val []byte, ttl time.Duration, nx bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, live := s.liveLocked(key); live && nx {
		return nil
	}
	s.m[key] = memEntry{val: append([]byte(nil), val...), expires: s.now().Add(ttl)}
	return nil
}

func (s *MemStore) Backend() string { return "memory" }
func (s *MemStore) Close() error    { return nil }

// Len is the number of live keys (tests).
func (s *MemStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for k := range s.m {
		if _, ok := s.liveLocked(k); ok {
			n++
		}
	}
	return n
}

// Reset empties the store (tests).
func (s *MemStore) Reset() {
	s.mu.Lock()
	s.m = map[string]memEntry{}
	s.mu.Unlock()
}
