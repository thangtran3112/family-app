package cache

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisStore is the production Store. It connects lazily: constructing it never touches the
// network, so the bridge boots with Redis down. Timeouts, retries and the circuit breaker that keep
// a dead Redis cheap live in Cache (cache.go); the client options here are the outer bound.
type RedisStore struct{ c *redis.Client }

// NewRedisStore parses a redis:// URL. The URL carries the password, so a parse failure returns a
// fixed message: go-redis and net/url both echo the URL in their errors.
func NewRedisStore(url string) (*RedisStore, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, errors.New("cache: not a valid redis:// URL (value withheld)")
	}
	opt.DialTimeout = 500 * time.Millisecond
	opt.ReadTimeout = 200 * time.Millisecond
	opt.WriteTimeout = 200 * time.Millisecond
	opt.MaxRetries = 1
	opt.DialerRetries = 1 // the default of 5 dial attempts would outlast every request budget
	opt.ContextTimeoutEnabled = true
	return &RedisStore{c: redis.NewClient(opt)}, nil
}

func (s *RedisStore) Get(ctx context.Context, key string) ([]byte, bool, error) {
	v, err := s.c.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return v, true, nil
}

func (s *RedisStore) MGet(ctx context.Context, keys []string) ([][]byte, error) {
	vals, err := s.c.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	out := make([][]byte, len(vals))
	for i, v := range vals {
		if str, ok := v.(string); ok { // a missing key is nil
			out[i] = []byte(str)
		}
	}
	return out, nil
}

func (s *RedisStore) Set(ctx context.Context, key string, val []byte, ttl time.Duration, nx bool) error {
	if nx {
		return s.c.SetNX(ctx, key, val, ttl).Err() // false (key exists) is not an error: write-once
	}
	return s.c.Set(ctx, key, val, ttl).Err()
}

func (s *RedisStore) Backend() string { return "redis" }
func (s *RedisStore) Close() error    { return s.c.Close() }
