package server

import (
	"os"
	"path/filepath"
	"testing"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

// T0 (02u §6.2): every RPC that can answer has at least one success golden and one error golden,
// so a new RPC cannot ship untested. Two methods cannot hold a golden yet, for reasons that are
// not about coverage:
var metaExempt = map[string]string{
	"WatchStatus":    "server-streaming: there is no unary exchange to freeze as a golden",
	"GetOptionChain": "B6: UNIMPLEMENTED until the options stage (pinned by its own non-golden step)",
}

func TestEveryUnaryRPCGetsSuccessAndErrorGoldens(t *testing.T) {
	have := map[string]map[string]bool{} // method -> {"ok", "error"}
	for _, s := range steps() {
		if s.golden == "" {
			continue
		}
		if have[s.rpc] == nil {
			have[s.rpc] = map[string]bool{}
		}
		kind := "ok"
		if s.wantErr != 0 {
			kind = "error"
		}
		have[s.rpc][kind] = true
		path := filepath.Join("..", "..", "testdata", "contract", s.golden+".json")
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s: golden file missing: %v", s.golden, err)
		}
	}

	file := pb.File_marketdata_v1_marketdata_proto
	for i := 0; i < file.Services().Len(); i++ {
		svc := file.Services().Get(i)
		for j := 0; j < svc.Methods().Len(); j++ {
			m := svc.Methods().Get(j)
			name := string(m.Name())
			if m.IsStreamingClient() || m.IsStreamingServer() {
				if _, ok := metaExempt[name]; !ok {
					t.Errorf("%s: a streaming RPC is not covered by the golden meta-test yet", name)
				}
				continue
			}
			if reason, exempt := metaExempt[name]; exempt {
				if have[name]["ok"] {
					t.Errorf("%s is exempt (%s) but has a success golden: remove the exemption", name, reason)
				}
				continue
			}
			for _, kind := range []string{"ok", "error"} {
				if !have[name][kind] {
					t.Errorf("%s: no %s golden in testdata/contract (02u §6.2 T0)", name, kind)
				}
			}
		}
	}
}
