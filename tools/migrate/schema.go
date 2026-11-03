package migrate

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

const MaxSafe int64 = 9007199254740991

type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
}
type Table struct {
	Name       string   `json:"name"`
	Columns    []Column `json:"columns"`
	PrimaryKey []string `json:"primaryKey"`
}

func text(name string) Column     { return Column{name, "text", false} }
func integer(name string) Column  { return Column{name, "integer", false} }
func nullable(name string) Column { return Column{name, "text", true} }

var Tables = []Table{
	{"accounts", []Column{text("id"), text("username"), text("sign_key"), text("box_key"), text("bundle"), integer("bundle_version"), text("role"), integer("disabled"), text("created")}, []string{"id"}},
	{"devices", []Column{text("account"), text("id"), text("name"), text("pub"), text("proof"), text("created"), nullable("revoked")}, []string{"account", "id"}},
	{"records", []Column{text("account"), text("id"), integer("revision"), integer("deleted"), nullable("envelope"), text("signature"), text("operation"), integer("base")}, []string{"account", "id"}},
	{"changes", []Column{integer("seq"), text("account"), text("record")}, []string{"seq"}},
	{"operations", []Column{text("account"), text("id"), text("hash"), text("result")}, []string{"account", "id"}},
	{"audit", []Column{integer("seq"), text("actor"), text("action"), text("target"), text("created")}, []string{"seq"}},
	{"invitations", []Column{text("hash"), integer("expires"), integer("used"), nullable("used_by")}, []string{"hash"}},
}

// Row is ordered like Table.Columns. nil is SQL NULL; all other values are raw bytes.
type Row [][]byte

// TypedRow uses ASCII-only values: text base64, integers canonical decimal, NULL explicit.
// SHA256 consumes compact JSON arrays of [type,value] tuples followed by LF.
func EncodeRow(t Table, row Row) ([]byte, error) {
	if len(row) != len(t.Columns) {
		return nil, fmt.Errorf("%s: wrong column count", t.Name)
	}
	tuples := make([][2]any, len(row))
	for i, c := range t.Columns {
		var value any
		if row[i] == nil {
			if !c.Nullable {
				return nil, fmt.Errorf("%s.%s: unexpected NULL", t.Name, c.Name)
			}
		} else if c.Type == "text" {
			if !utf8.Valid(row[i]) {
				return nil, fmt.Errorf("%s.%s: invalid UTF-8", t.Name, c.Name)
			}
			value = base64.StdEncoding.EncodeToString(row[i])
		} else {
			n, err := strconv.ParseInt(string(row[i]), 10, 64)
			if err != nil || n < 0 || n > MaxSafe {
				return nil, fmt.Errorf("%s.%s: unsafe integer", t.Name, c.Name)
			}
			if strconv.FormatInt(n, 10) != string(row[i]) {
				return nil, fmt.Errorf("%s.%s: noncanonical integer", t.Name, c.Name)
			}
			value = string(row[i])
		}
		tuples[i] = [2]any{c.Type, value}
	}
	raw, err := json.Marshal(tuples)
	return append(raw, '\n'), err
}
func textLiteral(value []byte) string { return "CAST(X'" + hex.EncodeToString(value) + "' AS TEXT)" }
func InsertSQL(t Table, row Row) (string, error) {
	if _, err := EncodeRow(t, row); err != nil {
		return "", err
	}
	cols := []string{}
	values := []string{}
	for i, c := range t.Columns {
		cols = append(cols, "\""+c.Name+"\"")
		v := "NULL"
		if row[i] != nil {
			if c.Type == "text" {
				v = textLiteral(row[i])
			} else {
				v = string(row[i])
			}
		}
		values = append(values, v)
	}
	return "INSERT INTO \"" + t.Name + "\" (" + strings.Join(cols, ",") + ") VALUES (" + strings.Join(values, ",") + ");\n", nil
}

type Validator struct {
	accounts    map[string]bool
	usernames   map[string]bool
	activeAdmin bool
	previous    map[string]Row
}

func NewValidator() *Validator {
	return &Validator{accounts: map[string]bool{}, usernames: map[string]bool{}, previous: map[string]Row{}}
}
func asciiFold(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 32
		}
		return r
	}, s)
}
func (v *Validator) Validate(t Table, row Row) error {
	if _, err := EncodeRow(t, row); err != nil {
		return err
	}
	fields := map[string]string{}
	for i, c := range t.Columns {
		fields[c.Name] = string(row[i])
	}
	for _, key := range t.PrimaryKey {
		if fields[key] == "" {
			return fmt.Errorf("%s: empty primary key", t.Name)
		}
	}
	if before := v.previous[t.Name]; before != nil {
		cmp := 0
		for _, key := range t.PrimaryKey {
			for i, c := range t.Columns {
				if c.Name == key {
					if c.Type == "integer" {
						a, _ := strconv.ParseInt(string(before[i]), 10, 64)
						b, _ := strconv.ParseInt(string(row[i]), 10, 64)
						if a < b {
							cmp = -1
						} else if a > b {
							cmp = 1
						}
					} else {
						cmp = strings.Compare(string(before[i]), string(row[i]))
					}
					break
				}
			}
			if cmp != 0 {
				break
			}
		}
		if cmp >= 0 {
			return fmt.Errorf("%s: duplicate or unsorted primary key", t.Name)
		}
	}
	for _, name := range []string{"disabled", "deleted", "used"} {
		if val, ok := fields[name]; ok && val != "0" && val != "1" {
			return fmt.Errorf("%s.%s: invalid boolean", t.Name, name)
		}
	}
	if t.Name == "accounts" {
		if fields["role"] != "admin" && fields["role"] != "user" {
			return fmt.Errorf("accounts: unexpected role")
		}
		folded := asciiFold(fields["username"])
		// SQLite NOCASE stops comparing at NUL, then compares original byte lengths.
		// Preserve NUL bytes, but reject any resulting target uniqueness collision.
		key := fmt.Sprintf("%d:%s", len(folded), strings.SplitN(folded, "\x00", 2)[0])
		if folded == "" || v.usernames[key] {
			return fmt.Errorf("accounts: NOCASE username collision/empty")
		}
		v.usernames[key] = true
		v.accounts[fields["id"]] = true
		if fields["role"] == "admin" && fields["disabled"] == "0" {
			v.activeAdmin = true
		}
	}
	if account, ok := fields["account"]; ok && !v.accounts[account] {
		return fmt.Errorf("%s: missing exact account reference", t.Name)
	}
	copyRow := make(Row, len(row))
	for i, b := range row {
		if b != nil {
			copyRow[i] = append([]byte{}, b...)
		}
	}
	v.previous[t.Name] = copyRow
	return nil
}
