// Golden hashes come from Go's encoder, independently of the Worker.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
)

// Keep this field order identical to legacy/server/sync.go Operation.
type Operation struct {
	OperationID  string  `json:"operationId"`
	ID           string  `json:"id"`
	BaseRevision int64   `json:"baseRevision"`
	Deleted      bool    `json:"deleted"`
	Envelope     *string `json:"envelope"`
	Signature    string  `json:"signature"`
}
type fixture struct {
	Name      string    `json:"name"`
	Operation Operation `json:"operation"`
	Canonical string    `json:"canonical"`
	Hash      string    `json:"hash"`
}

func main() {
	values := []struct {
		name     string
		envelope *string
	}{
		{"ordinary", ptr(`{"version":1,"nonce":"nonce"}`)},
		{"deleted-null", nil},
		{"whitespace", ptr(" { \"version\" : 1 } \n\t")},
		{"html-unicode-escapes", ptr("{\"value\":\"<>&中文\u2028\u2029\\\\\\\"\"}")},
		{"empty", ptr("")},
	}
	out := []fixture{}
	for _, v := range values {
		op := Operation{"20000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000003", 3, v.envelope == nil, v.envelope, "c2lnbmF0dXJl"}
		raw, err := json.Marshal(op)
		if err != nil {
			panic(err)
		}
		sum := sha256.Sum256(raw)
		out = append(out, fixture{v.name, op, string(raw), hex.EncodeToString(sum[:])})
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
func ptr(s string) *string { return &s }
