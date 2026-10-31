-- H1 write-once RAW archive (02u §2). Idempotent: `bridge migrate` and the boot step both run it.
-- Own schema, so it can share the Desk's database without touching a Desk table.
CREATE SCHEMA IF NOT EXISTS market_archive;

CREATE TABLE IF NOT EXISTS market_archive.raw_1d (
    symbol       text             NOT NULL,
    session_date date             NOT NULL, -- the XNYS (New York) trading date, never the UTC date
    "timestamp"  timestamptz      NOT NULL, -- the bar's start, UTC
    open         double precision NOT NULL,
    high         double precision NOT NULL,
    low          double precision NOT NULL,
    close        double precision NOT NULL,
    volume       bigint           NOT NULL,
    provider_id  text             NOT NULL,
    ingested_at  timestamptz      NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_1d_symbol_session_provider
    ON market_archive.raw_1d (symbol, session_date, provider_id);

CREATE TABLE IF NOT EXISTS market_archive.raw_1m (
    symbol       text             NOT NULL,
    session_date date             NOT NULL,
    "timestamp"  timestamptz      NOT NULL,
    open         double precision NOT NULL,
    high         double precision NOT NULL,
    low          double precision NOT NULL,
    close        double precision NOT NULL,
    volume       bigint           NOT NULL,
    provider_id  text             NOT NULL,
    ingested_at  timestamptz      NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_1m_symbol_timestamp_provider
    ON market_archive.raw_1m (symbol, "timestamp", provider_id);
CREATE INDEX IF NOT EXISTS raw_1m_symbol_session
    ON market_archive.raw_1m (symbol, session_date);

-- One row per fetched finished session: "archived" is this row, not the bars, so a quiet session
-- (bar_count 0) is complete and never re-fetched. The first vendor to fill a session keeps it.
CREATE TABLE IF NOT EXISTS market_archive.archive_sessions (
    symbol       text        NOT NULL,
    timeframe    text        NOT NULL CHECK (timeframe IN ('1d', '1m')),
    session_date date        NOT NULL,
    provider_id  text        NOT NULL,
    bar_count    integer     NOT NULL CHECK (bar_count >= 0),
    fetched_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, timeframe, session_date)
);
