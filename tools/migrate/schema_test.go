package migrate

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func row(values ...any) Row {
	r := make(Row, len(values))
	for i, v := range values {
		if v != nil {
			r[i] = []byte(v.(string))
		}
	}
	return r
}

type fixtureSource struct {
	Rows map[string][]Row
	Next int64
}

func (s fixtureSource) Each(_ context.Context, t Table, visit func(Row) error) error {
	for _, r := range s.Rows[t.Name] {
		if err := visit(r); err != nil {
			return err
		}
	}
	return nil
}
func (s fixtureSource) AutoIncrement(_ context.Context, _ string) (int64, error) { return s.Next, nil }
func fixture() fixtureSource {
	return fixtureSource{map[string][]Row{
		"accounts":    {row("a", "Alice", "sign", "box", " { \"opaque\": \"<>&中文\\u2028\" } ", "1", "admin", "0", "2026-11-03T00:00:00Z")},
		"devices":     {row("a", "d1", "active", "pub", "proof", "created", nil), row("a", "d2", "revoked", "pub2", "proof2", "created", "2026-11-03")},
		"records":     {row("a", "r1", "2", "1", nil, "sig", "op-delete", "1"), row("a", "r2", "1", "0", " {\"raw\":\"'\\\\中文\"}\n\u0000", "sig", "op-create", "0")},
		"changes":     {row("4", "a", "{\"id\":\"r2\",\"revision\":1}"), row("9", "a", "{\"id\":\"r1\",\"deleted\":true}")},
		"operations":  {row("a", "op-conflict", "hash-conflict", "{\"status\":\"conflict\",\"record\":null}"), row("a", "op-create", "hash-create", "{\"status\":\"applied\"}")},
		"audit":       {row("3", "a", "create", "r2", "2026-11-03")},
		"invitations": {row("used-invite", "1893456000", "1", nil)},
	}, 42}
}
func TestTextLiteral(t *testing.T) {
	if got := textLiteral([]byte("a'\n")); got != "CAST(X'61270a' AS TEXT)" {
		t.Fatalf("unexpected SQL literal: %s", got)
	}
}
func TestTypedRows(t *testing.T) {
	table := Table{Name: "test", Columns: []Column{nullable("nil"), text("empty"), text("unicode"), integer("max")}}
	raw, err := EncodeRow(table, row(nil, "", "中文\u0000e\u0301é", "9007199254740991"))
	if err != nil {
		t.Fatal(err)
	}
	want := "[[\"text\",null],[\"text\",\"\"],[\"text\",\"5Lit5paHAGXMgcOp\"],[\"integer\",\"9007199254740991\"]]\n"
	if string(raw) != want {
		t.Fatalf("typed encoding mismatch: %s", raw)
	}
}
func TestPreflightRejects(t *testing.T) {
	cases := []struct {
		name, table string
		change      func(Row)
	}{
		{"null-role", "accounts", func(r Row) { r[6] = nil }},
		{"invalid-role", "accounts", func(r Row) { r[6] = []byte("owner") }},
		{"unsafe-version", "accounts", func(r Row) { r[5] = []byte("9007199254740992") }},
		{"invalid-utf8", "accounts", func(r Row) { r[4] = []byte{0xff} }},
		{"audit-null", "audit", func(r Row) { r[1] = nil }},
		{"missing-account", "changes", func(r Row) { r[1] = []byte("MISSING") }},
		{"unsafe-seq", "changes", func(r Row) { r[0] = []byte("9007199254740992") }},
		{"unsafe-revision", "records", func(r Row) { r[2] = []byte("9007199254740992") }},
		{"invalid-bool", "invitations", func(r Row) { r[2] = []byte("2") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := fixture()
			tc.change(s.Rows[tc.table][0])
			out := filepath.Join(t.TempDir(), "export")
			if err := Export(context.Background(), s, out, nil); err == nil {
				t.Fatal("expected rejection")
			}
			if _, err := os.Stat(filepath.Join(out, "manifest.json")); !os.IsNotExist(err) {
				t.Fatal("failed export must not publish manifest")
			}
		})
	}
}
func TestNOCASECollision(t *testing.T) {
	s := fixture()
	s.Rows["accounts"] = append(s.Rows["accounts"], row("b", "aLICE", "s", "b", "{}", "1", "user", "0", "now"))
	if err := Export(context.Background(), s, filepath.Join(t.TempDir(), "out"), nil); err == nil || !strings.Contains(err.Error(), "NOCASE") {
		t.Fatalf("expected NOCASE rejection: %v", err)
	}
}
func TestBinaryKeyOrder(t *testing.T) {
	s := fixture()
	s.Rows["devices"][0][1] = []byte("z")
	s.Rows["devices"][1][1] = []byte("A")
	if err := Export(context.Background(), s, filepath.Join(t.TempDir(), "out"), nil); err == nil {
		t.Fatal("unsorted rows accepted")
	}
}

func TestNOCASEEmbeddedNULCollision(t *testing.T) {
	s := fixture()
	s.Rows["accounts"][0][1] = []byte("a\x00x")
	s.Rows["accounts"] = append(s.Rows["accounts"], row("b", "A\x00y", "s", "b", "{}", "1", "user", "0", "now"))
	if err := Export(context.Background(), s, filepath.Join(t.TempDir(), "out"), nil); err == nil || !strings.Contains(err.Error(), "NOCASE") {
		t.Fatalf("expected SQLite NUL/NOCASE collision rejection: %v", err)
	}
}
func TestExportAndHighWater(t *testing.T) {
	out := filepath.Join(t.TempDir(), "export")
	s := fixture()
	if err := Export(context.Background(), s, out, map[string]string{"kind": "synthetic-offline"}); err != nil {
		t.Fatal(err)
	}
	if err := Export(context.Background(), s, out, nil); err == nil {
		t.Fatal("overwrite accepted")
	}
	raw, err := os.ReadFile(filepath.Join(out, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Tables[3].HighWater != "41" || manifest.Tables[3].MaxSeq != "9" || manifest.Tables[3].AutoIncrement != "42" {
		t.Fatal("lost source sequence high-water")
	}
	sql, err := os.ReadFile(filepath.Join(out, manifest.Chunks[0].Name))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sql, []byte("REPLACE")) || !bytes.Contains(sql, []byte("VALUES('changes',41)")) {
		t.Fatal("unexpected SQL")
	}
}
func TestChunkAndStatementLimits(t *testing.T) {
	s := fixture()
	s.Rows["accounts"][0][4] = bytes.Repeat([]byte("a"), MaxStatementBytes)
	if err := Export(context.Background(), s, filepath.Join(t.TempDir(), "out"), nil); err == nil {
		t.Fatal("oversized SQL accepted")
	}
	s = fixture()
	s.Next = MaxSafe + 1
	if err := Export(context.Background(), s, filepath.Join(t.TempDir(), "out"), nil); err == nil {
		t.Fatal("unsafe high water accepted")
	}
}

// Opt-in output contains synthetic data only. Used by the real local D1 rehearsal.
func TestWriteRehearsal(t *testing.T) {
	out := os.Getenv("RK_SYNTHETIC_EXPORT_OUT")
	if out == "" {
		t.Skip("set RK_SYNTHETIC_EXPORT_OUT to write synthetic export")
	}
	if err := Export(context.Background(), fixture(), out, map[string]string{"kind": "synthetic-offline-not-real-MySQL"}); err != nil {
		t.Fatal(err)
	}
}
