// rehearsal is deliberately offline: it exports synthetic JSON rows through
// the exact same validator/writer as the MySQL snapshot reader.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	migrate "rememberkey/migrate"
)

type fixture struct {
	Tables map[string][][]*string `json:"tables"`
	Next   int64                  `json:"autoIncrement"`
}

func (f fixture) Each(_ context.Context, t migrate.Table, visit func(migrate.Row) error) error {
	for _, values := range f.Tables[t.Name] {
		row := make(migrate.Row, len(values))
		for i, v := range values {
			if v != nil {
				row[i] = []byte(*v)
			}
		}
		if err := visit(row); err != nil {
			return err
		}
	}
	return nil
}
func (f fixture) AutoIncrement(_ context.Context, _ string) (int64, error) {
	return f.AutoIncrementValue(), nil
}
func (f fixture) AutoIncrementValue() int64 { return f.Next }
func main() {
	input := flag.String("fixture", "", "synthetic JSON fixture")
	out := flag.String("out", "", "new output directory")
	flag.Parse()
	if *input == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "--fixture and --out required")
		os.Exit(2)
	}
	raw, err := os.ReadFile(*input)
	if err != nil {
		panic(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		panic(err)
	}
	if err := migrate.Export(context.Background(), f, *out, map[string]string{"kind": "client-generated-synthetic-offline"}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
