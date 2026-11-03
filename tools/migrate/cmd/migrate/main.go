package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	migrate "rememberkey/migrate"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "export" {
		fmt.Fprintln(os.Stderr, "usage: migrate export --out NEW_DIRECTORY")
		os.Exit(2)
	}
	flags := flag.NewFlagSet("export", flag.ExitOnError)
	out := flags.String("out", "", "new export directory")
	flags.Parse(os.Args[2:])
	dsn := os.Getenv("RK_MIGRATION_MYSQL_DSN")
	if *out == "" || dsn == "" || flags.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "--out and RK_MIGRATION_MYSQL_DSN are required")
		os.Exit(2)
	}
	if err := migrate.ExportMySQL(context.Background(), dsn, *out); err != nil {
		fmt.Fprintln(os.Stderr, "export failed:", err)
		os.Exit(1)
	}
	fmt.Println("export complete")
}
