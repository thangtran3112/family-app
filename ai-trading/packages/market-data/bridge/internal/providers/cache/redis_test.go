package cache

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"

	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
)

func newRedis(t *testing.T, password string) (*miniredis.Miniredis, *RedisStore) {
	t.Helper()
	mr := miniredis.RunT(t)
	url := "redis://" + mr.Addr() + "/0"
	if password != "" {
		mr.RequireAuth(password)
		url = "redis://:" + password + "@" + mr.Addr() + "/0"
	}
	s, err := NewRedisStore(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return mr, s
}

func TestRedisStoreGetSetNXMGetAndTTL(t *testing.T) {
	mr, s := newRedis(t, "")
	ctx := context.Background()
	if _, ok, err := s.Get(ctx, "k"); ok || err != nil {
		t.Fatalf("absent key: ok=%v err=%v, want a miss and no error", ok, err)
	}
	if err := s.Set(ctx, "k", []byte("one"), time.Minute, false); err != nil {
		t.Fatal(err)
	}
	if v, ok, err := s.Get(ctx, "k"); string(v) != "one" || !ok || err != nil {
		t.Fatalf("get: %q %v %v", v, ok, err)
	}
	if got := mr.TTL("k"); got != time.Minute {
		t.Errorf("TTL %v, want 1m", got)
	}
	// NX leaves an existing key alone, without an error.
	if err := s.Set(ctx, "k", []byte("two"), time.Minute, true); err != nil {
		t.Fatalf("NX on an existing key must not error: %v", err)
	}
	if v, _, _ := s.Get(ctx, "k"); string(v) != "one" {
		t.Fatalf("NX overwrote: %q", v)
	}
	if err := s.Set(ctx, "fresh", []byte("x"), time.Minute, true); err != nil {
		t.Fatal(err)
	}
	vals, err := s.MGet(ctx, []string{"k", "missing", "fresh"})
	if err != nil || len(vals) != 3 || string(vals[0]) != "one" || vals[1] != nil || string(vals[2]) != "x" {
		t.Fatalf("mget: %q %v", vals, err)
	}
	// Expiry is the server's: a key past its TTL is gone.
	mr.FastForward(2 * time.Minute)
	if _, ok, _ := s.Get(ctx, "k"); ok {
		t.Fatal("key survived its TTL")
	}
	if s.Backend() != "redis" {
		t.Errorf("backend %q", s.Backend())
	}
}

func TestRedisStoreWrongPasswordIsAnError(t *testing.T) {
	mr := miniredis.RunT(t)
	mr.RequireAuth("right-password-0123456789")
	s, err := NewRedisStore("redis://:wrong-password-0123456789@" + mr.Addr() + "/0")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err = s.Get(ctx, "k")
	if err == nil {
		t.Fatal("a wrong password must fail")
	}
	if strings.Contains(err.Error(), "wrong-password-0123456789") || strings.Contains(err.Error(), "right-password-0123456789") {
		t.Fatalf("the error echoes a password: %v", err)
	}
}

func TestRedisStoreConnectionRefusedFailsFast(t *testing.T) {
	mr := miniredis.RunT(t)
	addr := mr.Addr()
	mr.Close() // nothing listens any more
	s, err := NewRedisStore("redis://:pw-0123456789abcdef@" + addr + "/0")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	begin := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	if _, _, err := s.Get(ctx, "k"); err == nil {
		t.Fatal("a dead server must be an error")
	}
	if took := time.Since(begin); took > 700*time.Millisecond {
		t.Fatalf("connection refused took %v, want well inside the dial budget", took)
	}
}

func TestNewRedisStoreNeverEchoesTheURL(t *testing.T) {
	for _, url := range []string{
		"redis://:s3cr3t-pa55-word-0123@host:notaport/0",
		"redis://:s3cr3t-pa55-word-0123@host:6379/not-a-db",
		"http://:s3cr3t-pa55-word-0123@host:6379/0",
		"redis://:s3cr3t-pa55-word-0123@ho st:6379/0 \x7f",
	} {
		_, err := NewRedisStore(url)
		if err == nil {
			t.Errorf("%q: want an error", url)
			continue
		}
		if strings.Contains(err.Error(), "s3cr3t") || strings.Contains(err.Error(), "host") {
			t.Errorf("error echoes part of the URL: %v", err)
		}
	}
}

// The redis-down proof, end to end: the cache over a real RedisStore (miniredis). Warm: a repeat
// never reaches the vendor. Then the server dies mid-flight: every request is still answered,
// by the provider, with no error, and the breaker stops spending a timeout on each one.
func TestRedisDownFallsBackToTheProviderWithoutAnError(t *testing.T) {
	mr, store := newRedis(t, "pw-0123456789abcdef")
	clk := &clock{t: monday}
	in := newInner(clk)
	var logs bytes.Buffer
	c := New(store, Options{Now: clk.Now, Log: slog.New(slog.NewJSONHandler(&logs, nil))})
	p := c.Wrap(in)
	bars := p.(router.BarsProvider)
	ctx := context.Background()

	want, _, err := bars.Bars(ctx, openMinute())
	if err != nil || len(want) == 0 {
		t.Fatal(len(want), err)
	}
	if _, _, err := bars.Bars(ctx, openMinute()); err != nil || in.barCalls() != 1 {
		t.Fatalf("warm read over redis: %d inner calls, %v", in.barCalls(), err)
	}
	if qs, err := p.(router.QuoteProvider).Quotes(ctx, []string{"AAA", "BBB"}); err != nil || len(qs) != 2 {
		t.Fatal(qs, err)
	}
	if mr.Keys() == nil {
		t.Fatal("nothing reached redis")
	}

	mr.Close() // redis dies
	begin := time.Now()
	for i := range 12 {
		got, _, err := bars.Bars(ctx, openMinute())
		if err != nil {
			t.Fatalf("request %d failed with redis down: %v", i, err)
		}
		equalBars(t, want, got)
		qs, err := p.(router.QuoteProvider).Quotes(ctx, []string{"AAA", "BBB"})
		if err != nil || len(qs) != 2 {
			t.Fatalf("quotes %d with redis down: %v, %v", i, qs, err)
		}
	}
	if in.barCalls() != 13 { // 1 warm-up + 12 served by the provider
		t.Errorf("%d inner bar calls, want 13", in.barCalls())
	}
	// 24 requests, each with 2+ store operations. Without the breaker each would burn its timeout
	// (150-250 ms): the breaker opens after 5 failures, so the whole run stays near 5 timeouts.
	if took := time.Since(begin); took > 3*time.Second {
		t.Fatalf("24 requests with redis down took %v: the breaker is not limiting the cost", took)
	}
	c.flushStats()
	if !strings.Contains(logs.String(), `"breaker_open"`) || !strings.Contains(logs.String(), `"store_error"`) {
		t.Errorf("stats do not show the outage:\n%s", logs.String())
	}
	if strings.Contains(logs.String(), "pw-0123456789abcdef") {
		t.Error("the password reached the logs")
	}
}
