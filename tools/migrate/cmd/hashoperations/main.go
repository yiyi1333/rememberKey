// Independent Go hashes for synthetic client operation fixtures.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
)

type operation struct {
	OperationID  string  `json:"operationId"`
	ID           string  `json:"id"`
	BaseRevision int64   `json:"baseRevision"`
	Deleted      bool    `json:"deleted"`
	Envelope     *string `json:"envelope"`
	Signature    string  `json:"signature"`
}

func main() {
	input := flag.String("input", "", "synthetic operations JSON")
	flag.Parse()
	raw, err := os.ReadFile(*input)
	if err != nil {
		panic(err)
	}
	var ops []operation
	if err := json.Unmarshal(raw, &ops); err != nil {
		panic(err)
	}
	out := []map[string]string{}
	for _, op := range ops {
		raw, err := json.Marshal(op)
		if err != nil {
			panic(err)
		}
		sum := sha256.Sum256(raw)
		out = append(out, map[string]string{"canonical": string(raw), "hash": hex.EncodeToString(sum[:])})
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		panic(err)
	}
}
