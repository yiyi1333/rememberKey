package main

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func safeUser(tx *sql.Tx, id string) (any, error) {
	var username, role, created string
	var disabled bool
	e := tx.QueryRow(`SELECT username,role,disabled,created FROM accounts WHERE id=?`, id).Scan(&username, &role, &disabled, &created)
	if e == sql.ErrNoRows {
		return nil, fail(404, "account_not_found")
	}
	return map[string]any{"accountId": id, "username": username, "role": role, "disabled": disabled, "createdAt": created}, e
}
func (s *Server) admin(tx *sql.Tx, r *http.Request, i identity, path string) (any, int, error) {
	switch {
	case path == "/admin/users" && r.Method == "GET":
		rows, e := tx.Query(`SELECT id,username,role,disabled,created FROM accounts ORDER BY created,id`)
		if e != nil {
			return nil, 0, e
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var id, user, role, created string
			var disabled bool
			if e = rows.Scan(&id, &user, &role, &disabled, &created); e != nil {
				return nil, 0, e
			}
			out = append(out, map[string]any{"accountId": id, "username": user, "role": role, "disabled": disabled, "createdAt": created})
		}
		return out, 200, rows.Err()
	case strings.HasPrefix(path, "/admin/users/") && r.Method == "PATCH":
		id := strings.TrimPrefix(path, "/admin/users/")
		var v struct {
			Disabled *bool `json:"disabled"`
		}
		if e := body(r, &v); e != nil {
			return nil, 0, e
		}
		if v.Disabled == nil {
			return nil, 0, fail(400, "disabled_required")
		}
		if *v.Disabled && id == i.Account {
			return nil, 0, fail(409, "cannot_disable_self")
		}
		var role string
		if tx.QueryRow(`SELECT role FROM accounts WHERE id=?`, id).Scan(&role) != nil {
			return nil, 0, fail(404, "account_not_found")
		}
		if *v.Disabled && role == "admin" {
			var count int
			if e := tx.QueryRow(`SELECT count(*) FROM accounts WHERE role='admin' AND disabled=0 AND id<>?`, id).Scan(&count); e != nil {
				return nil, 0, e
			}
			if count == 0 {
				return nil, 0, fail(409, "last_admin")
			}
		}
		if _, e := tx.Exec(`UPDATE accounts SET disabled=? WHERE id=?`, *v.Disabled, id); e != nil {
			return nil, 0, e
		}
		if *v.Disabled {
			if _, e := tx.Exec(`UPDATE families SET revoked=1 WHERE account=?`, id); e != nil {
				return nil, 0, e
			}
		}
		if e := audit(tx, i.Account, "account.disabled.change", id); e != nil {
			return nil, 0, e
		}
		data, e := safeUser(tx, id)
		return data, 200, e
	case path == "/admin/invitations" && r.Method == "POST":
		value := token()
		exp := time.Now().Add(24 * time.Hour)
		if _, e := tx.Exec(`INSERT INTO invitations(hash,expires) VALUES(?,?)`, digest(value), exp.Unix()); e != nil {
			return nil, 0, e
		}
		if e := audit(tx, i.Account, "invitation.create", ""); e != nil {
			return nil, 0, e
		}
		return map[string]string{"token": value, "expiresAt": exp.UTC().Format(time.RFC3339)}, 201, nil
	case path == "/admin/audit" && r.Method == "GET":
		cursor, limit, e := page(r)
		if e != nil {
			return nil, 0, e
		}
		rows, e := tx.Query(`SELECT seq,actor,action,target,created FROM audit WHERE seq>? ORDER BY seq LIMIT ?`, cursor, limit+1)
		if e != nil {
			return nil, 0, e
		}
		defer rows.Close()
		events := []any{}
		more := false
		for rows.Next() {
			var seq int64
			var actor, action, target, created string
			if e = rows.Scan(&seq, &actor, &action, &target, &created); e != nil {
				return nil, 0, e
			}
			if len(events) == limit {
				more = true
				break
			}
			events = append(events, map[string]any{"seq": seq, "actorId": actor, "action": action, "targetId": target, "createdAt": created})
			cursor = seq
		}
		return map[string]any{"events": events, "cursor": cursor, "hasMore": more}, 200, rows.Err()
	}
	return nil, 0, fail(404, "not_found")
}
