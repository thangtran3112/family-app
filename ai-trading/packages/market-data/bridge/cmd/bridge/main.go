// Command bridge is the market-data bridge (02t). One binary, two roles:
// "bridge" (this stage, B0) and "edge" (the IBKR edge; arrives at B1).
//
//	bridge [--role=bridge]   serve gRPC, gRPC-Web, and Connect on one port
//	bridge healthcheck       exit 0 when this process answers /healthz (container HEALTHCHECK)
//	bridge migrate           create or update the H1 archive schema (idempotent), then exit
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/archive"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/config"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/providers/alpaca"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/router"
	"github.com/thangtran3112/family-app/ai-trading/market-data/bridge/internal/server"
)

// build is stamped at link time (-ldflags "-X main.build=<git sha>").
var build = ""

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := migrate(); err != nil {
			fmt.Fprintln(os.Stderr, "bridge migrate:", err)
			os.Exit(1)
		}
		return
	}
	role := flag.String("role", "bridge", "bridge | edge")
	flag.Parse()
	if *role != "bridge" {
		fmt.Fprintf(os.Stderr, "bridge: role %q is not available yet (the IBKR edge arrives at B1)\n", *role)
		os.Exit(2)
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "bridge:", err)
		os.Exit(1)
	}
}

func run() error {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.FromEnv(os.Getenv)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if cfg.Token == "" {
		log.Warn("MARKET_DATA_BRIDGE_TOKEN is not set: serving, but every call is rejected until the ai-trading/market-data-bridge profile is rendered")
	}
	if cfg.AdminToken == "" {
		log.Warn("MARKET_DATA_BRIDGE_ADMIN_TOKEN is not set: SetRouting is rejected")
	}
	al := alpaca.New(cfg.AlpacaKeyID, cfg.AlpacaSecret)
	if !al.Configured() {
		log.Warn("Alpaca keys are not set: provider alpaca reports NOT_CONFIGURED and no data is served")
	}
	rt := router.New(router.Options{Role: "bridge", Ladders: cfg.Ladders, Providers: []router.Provider{al}})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go rt.Run(ctx)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           server.Handler(server.Options{Router: rt, Token: cfg.Token, AdminToken: cfg.AdminToken, Build: buildID(), Log: log}),
		ReadHeaderTimeout: 10 * time.Second, // no write timeout: WatchStatus streams
	}
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	log.Info("listening", "addr", ln.Addr().String(), "role", "bridge", "build", buildID())
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// migrate applies the archive schema. It runs with ARCHIVE_ENABLED still off: the deploy order is
// migrate, then enable.
func migrate() error {
	url := config.ArchiveURL(os.Getenv)
	if url == "" {
		return errors.New("set ARCHIVE_DATABASE_URL (or DESK_RUNTIME_DATABASE_URL)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pg, err := archive.OpenPostgres(ctx, url)
	if err != nil {
		return err
	}
	defer pg.Close()
	if err := pg.Migrate(ctx); err != nil {
		return err
	}
	fmt.Println("archive schema market_archive is up to date")
	return nil
}

func buildID() string {
	if build != "" {
		return build
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			if s.Key == "vcs.revision" {
				return s.Value
			}
		}
	}
	return "dev"
}

// healthcheck asks this process (never a provider) whether it is up.
func healthcheck() int {
	listen := os.Getenv("BRIDGE_LISTEN")
	if listen == "" {
		listen = ":8080"
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return 1
	}
	c := http.Client{Timeout: 4 * time.Second}
	resp, err := c.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
