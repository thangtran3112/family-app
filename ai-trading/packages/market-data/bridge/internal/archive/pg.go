package archive

import (
	"context"
	_ "embed"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/xnys"
)

//go:embed schema.sql
var schema string

// Postgres is the archive Store. pgxpool connects lazily, so a bridge whose archive database is
// down still boots; every call then fails, and the Archive passes bars through.
type Postgres struct{ pool *pgxpool.Pool }

func OpenPostgres(ctx context.Context, url string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("archive database url: %w", err) // pgx redacts nothing in a parse error; never log url
	}
	return &Postgres{pool: pool}, nil
}

func (p *Postgres) Close() { p.pool.Close() }

// Migrate applies schema.sql. It is idempotent, and an advisory lock keeps two starting bridges
// from racing on CREATE.
func (p *Postgres) Migrate(ctx context.Context) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('market_archive_migrate'))`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, schema); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// table is chosen from a closed set, never from input.
func table(tf string) (string, error) {
	switch tf {
	case xnys.TimeframeDay:
		return "market_archive.raw_1d", nil
	case xnys.TimeframeMin:
		return "market_archive.raw_1m", nil
	}
	return "", fmt.Errorf("archive: timeframe %q is not archived", tf)
}

func (p *Postgres) Read(ctx context.Context, symbol, tf, from, to string) ([]Session, error) {
	tbl, err := table(tf)
	if err != nil {
		return nil, err
	}
	// Sessions first: a session is visible only with its bars (Write is one transaction), so a
	// session seen here always has its bars in the second query.
	rows, err := p.pool.Query(ctx, `SELECT session_date::text, provider_id FROM market_archive.archive_sessions
		WHERE symbol = $1 AND timeframe = $2 AND session_date BETWEEN $3::date AND $4::date ORDER BY session_date`,
		symbol, tf, from, to)
	if err != nil {
		return nil, err
	}
	var out []Session
	byDate := map[string]int{}
	for rows.Next() {
		var s Session
		if err := rows.Scan(&s.Date, &s.Provider); err != nil {
			rows.Close()
			return nil, err
		}
		byDate[s.Date] = len(out)
		out = append(out, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(out) == 0 {
		return nil, err
	}
	brows, err := p.pool.Query(ctx, `SELECT r.session_date::text, r."timestamp", r.open, r.high, r.low, r.close, r.volume
		FROM `+tbl+` r JOIN market_archive.archive_sessions s
		  ON s.symbol = r.symbol AND s.session_date = r.session_date AND s.provider_id = r.provider_id AND s.timeframe = $2
		WHERE r.symbol = $1 AND r.session_date BETWEEN $3::date AND $4::date ORDER BY r."timestamp"`,
		symbol, tf, from, to)
	if err != nil {
		return nil, err
	}
	defer brows.Close()
	for brows.Next() {
		var (
			day string
			at  time.Time
			b   = &pb.Bar{}
		)
		if err := brows.Scan(&day, &at, &b.Open, &b.High, &b.Low, &b.Close, &b.Volume); err != nil {
			return nil, err
		}
		b.Start, b.SessionDate = timestamppb.New(at), day
		i := byDate[day]
		out[i].Bars = append(out[i].Bars, b)
	}
	return out, brows.Err()
}

func (p *Postgres) Write(ctx context.Context, symbol, tf string, sessions []Session) error {
	tbl, err := table(tf)
	if err != nil {
		return err
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	for _, s := range sessions {
		tag, err := tx.Exec(ctx, `INSERT INTO market_archive.archive_sessions (symbol, timeframe, session_date, provider_id, bar_count)
			VALUES ($1, $2, $3::date, $4, $5) ON CONFLICT DO NOTHING`, symbol, tf, s.Date, s.Provider, len(s.Bars))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 { // already archived: the first vendor keeps the session
			continue
		}
		batch := &pgx.Batch{}
		for _, b := range s.Bars {
			batch.Queue(`INSERT INTO `+tbl+` (symbol, session_date, "timestamp", open, high, low, close, volume, provider_id)
				VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
				symbol, s.Date, b.Start.AsTime(), b.Open, b.High, b.Low, b.Close, b.Volume, s.Provider)
		}
		br := tx.SendBatch(ctx, batch)
		for range s.Bars {
			if _, err := br.Exec(); err != nil {
				br.Close()
				return err
			}
		}
		if err := br.Close(); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
