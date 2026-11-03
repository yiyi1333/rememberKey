package migrate

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/go-sql-driver/mysql"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const MaxChunkBytes = 512 * 1024
const MaxStatementBytes = 90 * 1024 // conservative D1 100KB SQL length ceiling
type File struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Bytes  int    `json:"bytes"`
}
type TableManifest struct {
	Table
	Rows          int    `json:"rows"`
	SHA256        string `json:"sha256"`
	JSONL         File   `json:"jsonl"`
	MaxSeq        string `json:"maxSeq"`
	AutoIncrement string `json:"autoIncrement"`
	HighWater     string `json:"highWater"`
}
type Manifest struct {
	Format         string          `json:"format"`
	Version        int             `json:"version"`
	DigestEncoding string          `json:"digestEncoding"`
	Tables         []TableManifest `json:"tables"`
	Chunks         []File          `json:"chunks"`
	Source         any             `json:"source"`
}
type Source interface {
	Each(context.Context, Table, func(Row) error) error
	AutoIncrement(context.Context, string) (int64, error)
}

func fileInfo(name string, raw []byte) File {
	sum := sha256.Sum256(raw)
	return File{name, hex.EncodeToString(sum[:]), len(raw)}
}
func Export(ctx context.Context, source Source, out string, metadata any) error {
	if err := os.Mkdir(out, 0700); err != nil {
		return fmt.Errorf("create new export directory: %w", err)
	}
	manifest := Manifest{"rememberKey-mysql-d1", 1, "typed-tuples-ascii-json-lf-v1", nil, nil, metadata}
	validator := NewValidator()
	chunk := []byte{}
	part := 0
	flush := func() error {
		if len(chunk) == 0 {
			return nil
		}
		part++
		name := fmt.Sprintf("part-%05d.sql", part)
		if err := os.WriteFile(filepath.Join(out, name), chunk, 0600); err != nil {
			return err
		}
		manifest.Chunks = append(manifest.Chunks, fileInfo(name, chunk))
		chunk = nil
		return nil
	}
	addSQL := func(s string) error {
		if len(s) > MaxStatementBytes {
			return fmt.Errorf("statement exceeds conservative D1 SQL limit; source unchanged")
		}
		if len(chunk)+len(s) > MaxChunkBytes {
			if err := flush(); err != nil {
				return err
			}
		}
		chunk = append(chunk, []byte(s)...)
		return nil
	}
	for _, table := range Tables {
		tm := TableManifest{Table: table, MaxSeq: "0", AutoIncrement: "0", HighWater: "0"}
		name := table.Name + ".jsonl"
		f, err := os.OpenFile(filepath.Join(out, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		hash := sha256.New()
		nbytes := 0
		maxSeq := int64(0)
		err = source.Each(ctx, table, func(row Row) error {
			if err := validator.Validate(table, row); err != nil {
				return err
			}
			raw, _ := EncodeRow(table, row)
			if _, err := f.Write(raw); err != nil {
				return err
			}
			hash.Write(raw)
			nbytes += len(raw)
			tm.Rows++
			if table.Name == "changes" || table.Name == "audit" {
				n, _ := strconv.ParseInt(string(row[0]), 10, 64)
				if n > maxSeq {
					maxSeq = n
				}
			}
			statement, _ := InsertSQL(table, row)
			return addSQL(statement)
		})
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		tm.SHA256 = hex.EncodeToString(hash.Sum(nil))
		tm.JSONL = File{name, tm.SHA256, nbytes}
		if table.Name == "changes" || table.Name == "audit" {
			next, err := source.AutoIncrement(ctx, table.Name)
			if err != nil {
				return err
			}
			if next < 1 || next > MaxSafe {
				return fmt.Errorf("%s: unsafe auto_increment", table.Name)
			}
			high := maxSeq
			if next-1 > high {
				high = next - 1
			}
			if high >= MaxSafe {
				return fmt.Errorf("%s: no safe next sequence", table.Name)
			}
			tm.MaxSeq = strconv.FormatInt(maxSeq, 10)
			tm.AutoIncrement = strconv.FormatInt(next, 10)
			tm.HighWater = strconv.FormatInt(high, 10)
			if err := addSQL(fmt.Sprintf("DELETE FROM sqlite_sequence WHERE name='%s';\nINSERT INTO sqlite_sequence(name,seq) VALUES('%s',%d);\n", table.Name, table.Name, high)); err != nil {
				return err
			}
		}
		manifest.Tables = append(manifest.Tables, tm)
	}
	if !validator.activeAdmin {
		return fmt.Errorf("no active administrator")
	}
	if err := flush(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	// Manifest is the completion marker: a failed export never has one.
	return os.WriteFile(filepath.Join(out, "manifest.json"), append(raw, '\n'), 0600)
}

type SQLSource struct{ Tx *sql.Tx }

func (s SQLSource) Each(ctx context.Context, t Table, visit func(Row) error) error {
	cols := []string{}
	order := []string{}
	for _, c := range t.Columns {
		if t.Name == "invitations" && c.Name == "used_by" {
			cols = append(cols, "NULL")
		} else if c.Type == "text" {
			// Binary results bypass connection/result charset conversion. Hash the
			// original stored UTF-8 bytes even with a non-UTF8 DSN result charset;
			// CAST(NULL AS BINARY) remains NULL for nullable mapped text columns.
			cols = append(cols, "CAST(`"+c.Name+"` AS BINARY)")
		} else {
			cols = append(cols, "`"+c.Name+"`")
		}
	}
	for _, key := range t.PrimaryKey {
		numeric := false
		for _, c := range t.Columns {
			if c.Name == key && c.Type == "integer" {
				numeric = true
			}
		}
		if numeric {
			order = append(order, "`"+key+"`")
		} else {
			order = append(order, "CAST(`"+key+"` AS BINARY)")
		}
	}
	rows, err := s.Tx.QueryContext(ctx, "SELECT "+strings.Join(cols, ",")+" FROM `"+t.Name+"` ORDER BY "+strings.Join(order, ","))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		row := make(Row, len(cols))
		args := make([]any, len(cols))
		for i := range row {
			args[i] = &row[i]
		}
		if err := rows.Scan(args...); err != nil {
			return err
		}
		if err := visit(row); err != nil {
			return err
		}
	}
	return rows.Err()
}
func (s SQLSource) AutoIncrement(ctx context.Context, table string) (int64, error) {
	var n sql.NullInt64
	err := s.Tx.QueryRowContext(ctx, "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", table).Scan(&n)
	if err != nil {
		return 0, err
	}
	if !n.Valid {
		return 0, fmt.Errorf("missing auto_increment")
	}
	return n.Int64, nil
}
func ExportMySQL(ctx context.Context, dsn, out string) error {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return fmt.Errorf("invalid source DSN")
	}
	cfg.ParseTime = false
	cfg.InterpolateParams = false
	cfg.MultiStatements = false
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return fmt.Errorf("source connection setup failed")
	}
	defer db.Close()
	return exportDatabase(ctx, db, out)
}

func exportDatabase(ctx context.Context, db *sql.DB, out string) error {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return fmt.Errorf("source snapshot failed (check connectivity and read-only permissions)")
	}
	defer tx.Rollback()
	metadata := []map[string]string{}
	rows, err := tx.QueryContext(ctx, "SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('accounts','devices','records','changes','operations','audit','invitations') ORDER BY TABLE_NAME")
	if err != nil {
		return fmt.Errorf("source schema metadata failed")
	}
	for rows.Next() {
		var table, engine, collation string
		if err := rows.Scan(&table, &engine, &collation); err != nil {
			rows.Close()
			return err
		}
		if engine != "InnoDB" {
			rows.Close()
			return fmt.Errorf("%s: consistent snapshot requires InnoDB", table)
		}
		metadata = append(metadata, map[string]string{"table": table, "engine": engine, "collation": collation})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(metadata) != 7 {
		return fmt.Errorf("source persistent tables missing")
	}
	if err := Export(ctx, SQLSource{tx}, out, metadata); err != nil {
		return err
	}
	return tx.Commit()
}
