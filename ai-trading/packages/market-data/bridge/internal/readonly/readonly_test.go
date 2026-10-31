// Package readonly pins the owner's rule (02t decision 7): the bridge is
// read-only. No orders, positions, or account calls exist anywhere in its
// source, for any provider.
package readonly

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var forbidden = regexp.MustCompile(`(?i)/v2/(orders|positions|account|activities)|/(orders|positions|account)\b|\b(place|submit|cancel)_?order|\b(req|request)_?(account|positions|open_?orders)|\bsubmitOrder\b|\bpaper-api\b`)

func TestNoOrderPositionOrAccountCallExists(t *testing.T) {
	root := filepath.Join("..", "..")
	self, _ := filepath.Abs("readonly_test.go")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == "gen" || d.Name() == "testdata") {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		if abs, _ := filepath.Abs(path); abs == self {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if m := forbidden.Find(src); m != nil {
			t.Errorf("%s mentions %q: the bridge never places orders or reads positions or accounts", path, m)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
