package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
)

type Operation struct {
	OperationID  string  `json:"operationId"`
	ID           string  `json:"id"`
	BaseRevision int64   `json:"baseRevision"`
	Deleted      bool    `json:"deleted"`
	Envelope     *string `json:"envelope"`
	Signature    string  `json:"signature"`
}
type Record struct {
	ID           string  `json:"id"`
	Revision     int64   `json:"revision"`
	Deleted      bool    `json:"deleted"`
	Envelope     *string `json:"envelope"`
	Signature    string  `json:"signature"`
	OperationID  string  `json:"operationId"`
	BaseRevision int64   `json:"baseRevision"`
}
type Result struct {
	OperationID string  `json:"operationId"`
	Status      string  `json:"status"`
	Record      *Record `json:"record"`
}

func record(tx *sql.Tx, account, id string) (*Record, error) {
	return recordFor(tx, account, id, false)
}

// recordFor reads one record. With lock set, the row is held with
// SELECT ... FOR UPDATE so two devices racing on the same record serialize and
// the revision comparison below cannot read a stale value. A missing row cannot
// be locked, so the create path additionally relies on the primary key and the
// duplicate-key retry in apply.
func recordFor(tx *sql.Tx, account, id string, lock bool) (*Record, error) {
	q := `SELECT id,revision,deleted,envelope,signature,operation,base FROM records WHERE account=? AND id=?`
	if lock {
		q += ` FOR UPDATE`
	}
	var r Record
	e := tx.QueryRow(q, account, id).Scan(&r.ID, &r.Revision, &r.Deleted, &r.Envelope, &r.Signature, &r.OperationID, &r.BaseRevision)
	if e == sql.ErrNoRows {
		return nil, nil
	}
	return &r, e
}
func (s *Server) operations(r *http.Request) (any, int, error) {
	var v struct {
		Operations []Operation `json:"operations"`
	}
	if e := body(r, &v); e != nil {
		return nil, 0, e
	}
	if len(v.Operations) == 0 || len(v.Operations) > 100 {
		return nil, 0, fail(400, "invalid_batch")
	}
	results := []Result{}
	for _, op := range v.Operations {
		tx, e := s.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if e != nil {
			return nil, 0, e
		}
		res, e := apply(tx, r, op)
		if e != nil {
			tx.Rollback()
			return nil, 0, e
		}
		if e = tx.Commit(); e != nil {
			return nil, 0, e
		}
		results = append(results, res)
	}
	return map[string]any{"results": results}, 200, nil
}
func apply(tx *sql.Tx, r *http.Request, op Operation) (Result, error) {
	var result Result
	i, e := auth(tx, r)
	if e != nil {
		return result, e
	}
	if !uuid.MatchString(op.OperationID) || !uuid.MatchString(op.ID) || op.BaseRevision < 0 || !envelopeValid(op.Envelope, op.Deleted) {
		return result, fail(400, "invalid_operation")
	}
	envelope := ""
	if op.Envelope != nil {
		envelope = *op.Envelope
	}
	deleted := "0"
	if op.Deleted {
		deleted = "1"
	}
	msg := "rememberKey:op:1:" + i.Account + ":" + op.OperationID + ":" + op.ID + ":" + strconv.FormatInt(op.BaseRevision, 10) + ":" + deleted + ":" + digest(envelope)
	if !verify(i.SignKey, msg, op.Signature) {
		return result, fail(403, "invalid_signature")
	}
	hash := digest(marshal(op))
	var oldHash, oldResult string
	e = tx.QueryRow(`SELECT hash,result FROM operations WHERE account=? AND id=? FOR UPDATE`, i.Account, op.OperationID).Scan(&oldHash, &oldResult)
	if e == nil {
		if oldHash != hash {
			return result, fail(409, "operation_id_reused")
		}
		e = json.Unmarshal([]byte(oldResult), &result)
		return result, e
	}
	if e != sql.ErrNoRows {
		return result, e
	}
	// Lock the record row (when it exists) before comparing revisions so two
	// devices submitting against the same base revision serialize here rather
	// than both observing the old revision and racing to write.
	current, e := recordFor(tx, i.Account, op.ID, true)
	if e != nil {
		return result, e
	}
	revision := int64(0)
	if current != nil {
		revision = current.Revision
	}
	result = Result{op.OperationID, "conflict", current}
	if revision == op.BaseRevision {
		next := &Record{op.ID, revision + 1, op.Deleted, op.Envelope, op.Signature, op.OperationID, op.BaseRevision}
		// MySQL upsert. VALUES() refers to the row proposed for insertion.
		// The revision guard in the WHERE clause means a concurrent insert that
		// already claimed this revision does not get overwritten.
		res, ue := tx.Exec(`INSERT INTO records(account,id,revision,deleted,envelope,signature,operation,base)
			VALUES(?,?,?,?,?,?,?,?)
			ON DUPLICATE KEY UPDATE
			  revision=IF(revision=VALUES(base), VALUES(revision), revision),
			  deleted=IF(revision=VALUES(revision), VALUES(deleted), deleted),
			  envelope=IF(revision=VALUES(revision), VALUES(envelope), envelope),
			  signature=IF(revision=VALUES(revision), VALUES(signature), signature),
			  operation=IF(revision=VALUES(revision), VALUES(operation), operation),
			  base=IF(revision=VALUES(revision), VALUES(base), base)`,
			i.Account, next.ID, next.Revision, next.Deleted, next.Envelope, next.Signature, next.OperationID, next.BaseRevision)
		if ue != nil {
			return result, ue
		}
		// RowsAffected is 1 for an insert, 2 for a changed update, and 0 when the
		// update matched but changed nothing. Only record a change-log entry when
		// this transaction is the one that actually stored the row, otherwise two
		// racing writers would emit duplicate change entries.
		n, _ := res.RowsAffected()
		if n == 0 {
			// Another writer won the race for this revision; re-read and report
			// the conflict instead of silently claiming success.
			latest, re := recordFor(tx, i.Account, op.ID, false)
			if re != nil {
				return result, re
			}
			result.Status = "conflict"
			result.Record = latest
			_, e = tx.Exec(`INSERT INTO operations(account,id,hash,result) VALUES(?,?,?,?)`, i.Account, op.OperationID, hash, marshal(result))
			return result, e
		}
		// Verify the stored row really is ours (the guard may have declined the
		// update even though a row was affected in an edge case).
		stored, se := recordFor(tx, i.Account, op.ID, false)
		if se != nil {
			return result, se
		}
		if stored == nil || stored.OperationID != op.OperationID {
			result.Status = "conflict"
			result.Record = stored
			_, e = tx.Exec(`INSERT INTO operations(account,id,hash,result) VALUES(?,?,?,?)`, i.Account, op.OperationID, hash, marshal(result))
			return result, e
		}
		if _, e = tx.Exec(`INSERT INTO changes(account,record) VALUES(?,?)`, i.Account, marshal(next)); e != nil {
			return result, e
		}
		result.Status = "applied"
		result.Record = next
	}
	// Persist conflicts too: a retry must not become an unintended overwrite after
	// state changes. Reusing an operation ID with any different signed body is 409.
	_, e = tx.Exec(`INSERT INTO operations(account,id,hash,result) VALUES(?,?,?,?)`, i.Account, op.OperationID, hash, marshal(result))
	return result, e
}
func page(r *http.Request) (int64, int, error) {
	cursor := int64(0)
	limit := 100
	var e error
	if v := r.URL.Query().Get("cursor"); v != "" {
		cursor, e = strconv.ParseInt(v, 10, 64)
		if e != nil || cursor < 0 {
			return 0, 0, fail(400, "invalid_cursor")
		}
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		limit, e = strconv.Atoi(v)
		if e != nil || limit < 1 || limit > 100 {
			return 0, 0, fail(400, "invalid_limit")
		}
	}
	return cursor, limit, nil
}
func changes(tx *sql.Tx, r *http.Request, i identity) (any, error) {
	cursor, limit, e := page(r)
	if e != nil {
		return nil, e
	}
	var upper int64
	if e = tx.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM changes WHERE account=?`, i.Account).Scan(&upper); e != nil {
		return nil, e
	}
	if cursor > upper {
		return nil, fail(400, "invalid_cursor")
	}
	rows, e := tx.Query(`SELECT seq,record FROM changes WHERE account=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`, i.Account, cursor, upper, limit+1)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []any{}
	more := false
	for rows.Next() {
		var seq int64
		var raw string
		if e = rows.Scan(&seq, &raw); e != nil {
			return nil, e
		}
		if len(out) == limit {
			more = true
			break
		}
		var item map[string]any
		if e = json.Unmarshal([]byte(raw), &item); e != nil {
			return nil, e
		}
		item["seq"] = seq
		out = append(out, item)
		cursor = seq
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	if !more {
		cursor = upper
	}
	return map[string]any{"changes": out, "cursor": cursor, "hasMore": more}, nil
}
func snapshot(tx *sql.Tx, i identity) (any, error) {
	rows, e := tx.Query(`SELECT id,revision,deleted,envelope,signature,operation,base FROM records WHERE account=? ORDER BY id LIMIT 10001`, i.Account)
	if e != nil {
		return nil, e
	}
	out := []Record{}
	for rows.Next() {
		var r Record
		if e = rows.Scan(&r.ID, &r.Revision, &r.Deleted, &r.Envelope, &r.Signature, &r.OperationID, &r.BaseRevision); e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	if len(out) > 10000 {
		return nil, fail(409, "snapshot_too_large")
	}
	var cursor int64
	e = tx.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM changes WHERE account=?`, i.Account).Scan(&cursor)
	return map[string]any{"records": out, "cursor": cursor}, e
}
