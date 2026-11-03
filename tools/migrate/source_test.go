package migrate

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A database/sql driver seam verifies the transaction options and actual fixed
// SQL source-reader paths without connecting to any MySQL server.
type sourceDriver struct{}

func (sourceDriver) Open(string) (driver.Conn, error) { return nil, fmt.Errorf("connector required") }

type sourceConnector struct{ conn *sourceConn }

func (c sourceConnector) Connect(context.Context) (driver.Conn, error) { return c.conn, nil }
func (sourceConnector) Driver() driver.Driver                          { return sourceDriver{} }

type sourceConn struct {
	opts               driver.TxOptions
	queries            []string
	commits, rollbacks int
	bad                bool
	fixture            *fixtureSource
}

func (c *sourceConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("unexpected prepare")
}
func (c *sourceConn) Close() error { return nil }
func (c *sourceConn) Begin() (driver.Tx, error) {
	return nil, fmt.Errorf("context transaction required")
}
func (c *sourceConn) BeginTx(_ context.Context, opts driver.TxOptions) (driver.Tx, error) {
	c.opts = opts
	return sourceTx{c}, nil
}

type sourceTx struct{ c *sourceConn }

func (t sourceTx) Commit() error   { t.c.commits++; return nil }
func (t sourceTx) Rollback() error { t.c.rollbacks++; return nil }

type sourceRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *sourceRows) Columns() []string { return r.columns }
func (r *sourceRows) Close() error      { return nil }
func (r *sourceRows) Next(dest []driver.Value) error {
	if r.index == len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.index])
	r.index++
	return nil
}
func (c *sourceConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.queries = append(c.queries, query)
	if strings.Contains(query, "SELECT TABLE_NAME, ENGINE") {
		values := [][]driver.Value{}
		for _, t := range Tables {
			engine := "InnoDB"
			if c.bad {
				engine = "MyISAM"
			}
			values = append(values, []driver.Value{t.Name, engine, "utf8mb4_0900_ai_ci"})
		}
		return &sourceRows{columns: []string{"TABLE_NAME", "ENGINE", "TABLE_COLLATION"}, rows: values}, nil
	}
	if strings.Contains(query, "SELECT AUTO_INCREMENT") {
		if len(args) != 1 {
			return nil, fmt.Errorf("metadata must bind table value")
		}
		return &sourceRows{columns: []string{"AUTO_INCREMENT"}, rows: [][]driver.Value{{int64(42)}}}, nil
	}
	for _, t := range Tables {
		if strings.Contains(query, " FROM `"+t.Name+"`") {
			columns := []string{}
			for _, col := range t.Columns {
				columns = append(columns, col.Name)
			}
			values := [][]driver.Value{}
			source := fixture()
			if c.fixture != nil {
				source = *c.fixture
			}
			for _, r := range source.Rows[t.Name] {
				v := make([]driver.Value, len(r))
				for i, b := range r {
					if b != nil {
						v[i] = b
					}
				}
				values = append(values, v)
			}
			return &sourceRows{columns: columns, rows: values}, nil
		}
	}
	return nil, fmt.Errorf("unexpected query")
}
func TestSnapshotReadOnlyRepeatableRead(t *testing.T) {
	conn := &sourceConn{}
	db := sql.OpenDB(sourceConnector{conn})
	defer db.Close()
	if err := exportDatabase(context.Background(), db, filepath.Join(t.TempDir(), "out")); err != nil {
		t.Fatal(err)
	}
	if !conn.opts.ReadOnly || conn.opts.Isolation != driver.IsolationLevel(sql.LevelRepeatableRead) || conn.commits != 1 || conn.rollbacks != 0 {
		t.Fatalf("wrong snapshot transaction: %+v", conn)
	}
	persistent := 0
	for _, q := range conn.queries {
		if strings.Contains(q, " FROM `") {
			persistent++
			if strings.Contains(q, " FROM `changes`") || strings.Contains(q, " FROM `audit`") {
				if !strings.HasSuffix(q, "ORDER BY `seq`") {
					t.Fatal(q)
				}
			} else if !strings.Contains(q, "CAST(`") {
				t.Fatal("missing binary text-key order: " + q)
			}
		}
	}
	if persistent != 7 {
		t.Fatal("must read exactly seven persistent tables")
	}
}
func TestSnapshotRejectsNonInnoDBAndRollsBack(t *testing.T) {
	conn := &sourceConn{bad: true}
	db := sql.OpenDB(sourceConnector{conn})
	defer db.Close()
	if err := exportDatabase(context.Background(), db, filepath.Join(t.TempDir(), "out")); err == nil {
		t.Fatal("nontransactional engine accepted")
	}
	if conn.commits != 0 || conn.rollbacks != 1 {
		t.Fatal("failed snapshot was not rolled back")
	}
}

func TestSourceBinaryTextProjections(t *testing.T) {
	conn := &sourceConn{}
	db := sql.OpenDB(sourceConnector{conn})
	defer db.Close()
	if err := exportDatabase(context.Background(), db, filepath.Join(t.TempDir(), "out")); err != nil {
		t.Fatal(err)
	}
	for _, table := range Tables {
		t.Run(table.Name, func(t *testing.T) {
			columns := []string{}
			order := []string{}
			for _, column := range table.Columns {
				switch {
				case table.Name == "invitations" && column.Name == "used_by":
					columns = append(columns, "NULL")
				case column.Type == "text":
					columns = append(columns, "CAST(`"+column.Name+"` AS BINARY)")
				default:
					columns = append(columns, "`"+column.Name+"`")
				}
			}
			for _, key := range table.PrimaryKey {
				if key == "seq" {
					order = append(order, "`seq`")
				} else {
					order = append(order, "CAST(`"+key+"` AS BINARY)")
				}
			}
			want := "SELECT " + strings.Join(columns, ",") + " FROM `" + table.Name + "` ORDER BY " + strings.Join(order, ",")
			for _, query := range conn.queries {
				if strings.Contains(query, " FROM `"+table.Name+"`") {
					if query != want {
						t.Fatalf("source text must bypass result-charset transcoding; nullable text stays binary, integers stay numeric, used_by stays NULL\ngot:  %s\nwant: %s", query, want)
					}
					return
				}
			}
			t.Fatal("mapped source table was not queried")
		})
	}
}

func TestSourceExportPreservesNonASCIIBytes(t *testing.T) {
	source := fixture()
	source.Rows["accounts"][0][4] = []byte("中文 <>& é/e\u0301 \u2028\u2029 \x00")
	source.Rows["devices"][0][2] = []byte("设备 é/e\u0301 \x00")
	conn := &sourceConn{fixture: &source}
	db := sql.OpenDB(sourceConnector{conn})
	defer db.Close()
	out := filepath.Join(t.TempDir(), "out")
	if err := exportDatabase(context.Background(), db, out); err != nil {
		t.Fatal(err)
	}
	for _, table := range Tables {
		raw, err := os.ReadFile(filepath.Join(out, table.Name+".jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		for rowIndex, row := range source.Rows[table.Name] {
			var tuples [][2]*string
			if err := decoder.Decode(&tuples); err != nil {
				t.Fatal(err)
			}
			for columnIndex, column := range table.Columns {
				if column.Type != "text" {
					continue
				}
				value := tuples[columnIndex][1]
				if row[columnIndex] == nil {
					if value != nil {
						t.Fatalf("%s row %d column %s: NULL changed", table.Name, rowIndex, column.Name)
					}
					continue
				}
				if value == nil {
					t.Fatalf("%s.%s: text became NULL", table.Name, column.Name)
				}
				got, err := base64.StdEncoding.DecodeString(*value)
				if err != nil || !bytes.Equal(got, row[columnIndex]) {
					t.Fatalf("%s row %d column %s: source text bytes changed", table.Name, rowIndex, column.Name)
				}
			}
		}
	}
}
