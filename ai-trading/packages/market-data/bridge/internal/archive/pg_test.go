package archive

import (
	"context"
	"fmt"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

// testPostgres opens the database named by ARCHIVE_TEST_DATABASE_URL and migrates it. The schema
// is shared and persistent, so a test deletes only the symbols it uses (SPY and TEST*) before and after.
func testPostgres(t *testing.T, url string) *Postgres {
	t.Helper()
	pg, err := OpenPostgres(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pg.Close)
	if err := pg.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := pg.Migrate(t.Context()); err != nil { // idempotent
		t.Fatalf("second migrate: %v", err)
	}
	clean := func() {
		for _, q := range []string{"raw_1d", "raw_1m", "archive_sessions"} {
			if _, err := pg.pool.Exec(context.Background(), fmt.Sprintf("DELETE FROM market_archive.%s WHERE symbol IN ('SPY') OR symbol LIKE 'TEST%%'", q)); err != nil {
				t.Fatal(err)
			}
		}
	}
	clean()
	t.Cleanup(clean)
	return pg
}

// The Store contract, on whichever stores are available: write-once, first vendor wins, quiet
// sessions, the unique indexes, and ordered bars.
func TestStoreContract(t *testing.T) {
	eachStore(t, func(t *testing.T, mk func() Store) {
		s := mk()
		day := func(i int) *pb.Bar {
			return &pb.Bar{Start: timestamppb.New(time.Date(2026, 1, 5, 14, 30+i, 0, 0, time.UTC)), Open: 1.5, High: 2, Low: 1, Close: 1.75, Volume: int64(100 + i), SessionDate: "2026-01-05"}
		}
		if err := s.Write(t.Context(), "TESTA", "1m", []Session{
			{Date: "2026-01-05", Provider: "alpaca", Bars: []*pb.Bar{day(1), day(0)}},
			{Date: "2026-01-06", Provider: "alpaca"}, // quiet
		}); err != nil {
			t.Fatal(err)
		}
		// Second writer for the same session: ignored, bars included.
		if err := s.Write(t.Context(), "TESTA", "1m", []Session{{Date: "2026-01-05", Provider: "other", Bars: []*pb.Bar{day(7)}}}); err != nil {
			t.Fatal(err)
		}
		got, err := s.Read(t.Context(), "TESTA", "1m", "2026-01-01", "2026-01-31")
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 || got[0].Date != "2026-01-05" || got[1].Date != "2026-01-06" {
			t.Fatalf("sessions %+v", got)
		}
		if got[0].Provider != "alpaca" || len(got[0].Bars) != 2 || got[0].Bars[0].Volume != 100 || got[0].Bars[1].Volume != 101 {
			t.Fatalf("first vendor must keep the session, bars ordered: %+v", got[0])
		}
		if b := got[0].Bars[0]; b.Open != 1.5 || b.Close != 1.75 || b.SessionDate != "2026-01-05" {
			t.Errorf("bar did not round-trip: %v", b)
		}
		if len(got[1].Bars) != 0 {
			t.Errorf("quiet session has %d bars", len(got[1].Bars))
		}
		if other, _ := s.Read(t.Context(), "TESTA", "1d", "2026-01-01", "2026-01-31"); len(other) != 0 {
			t.Errorf("1d read saw 1m sessions: %+v", other)
		}
	})
}
