package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *Server) route(w http.ResponseWriter, r *http.Request) (any, int, error) {
	// No process-wide mutex here: MySQL provides real row locks, so correctness
	// comes from SELECT ... FOR UPDATE on the rows a request depends on, and
	// from unique keys for insert races. Earlier operations in a batch still
	// commit independently, which the client relies on for idempotent retries.
	//
	// Isolation is READ COMMITTED so a transaction only ever sees committed
	// snapshots; REPEATABLE READ would make the revision comparisons below read
	// stale values after another device commits.
	tx, e := s.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if e != nil {
		return nil, 0, e
	}
	defer tx.Rollback()
	var data any
	status := 200
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	method := r.Method
	switch {
	case path == "/status" && method == "GET":
		var count int
		e = tx.QueryRow(`SELECT count(*) FROM accounts`).Scan(&count)
		data = map[string]bool{"initialized": count > 0}
	case path == "/registrations" && method == "POST":
		data, e = s.register(tx, r)
		status = 201
	case path == "/accounts/lookup" && method == "GET":
		data, e = lookup(tx, r.URL.Query().Get("username"))
	case path == "/auth/challenges" && method == "POST":
		data, e = s.challenge(tx, r)
	case path == "/auth/sessions" && method == "POST":
		data, e = s.session(tx, w, r)
	case path == "/auth/refresh" && method == "POST":
		data, e = s.refresh(tx, w, r)
	case path == "/devices" && method == "POST":
		data, e = s.enroll(tx, r)
		status = 201
	default:
		var i identity
		i, e = auth(tx, r)
		if e != nil {
			return nil, 0, e
		}
		switch {
		case path == "/auth/sessions" && method == "DELETE":
			_, e = tx.Exec(`UPDATE families SET revoked=1 WHERE id=?`, i.Family)
			s.cookie(w, "", -1)
			status = 204
		case path == "/me" && method == "GET":
			data, e = me(tx, i.Account)
		case path == "/devices" && method == "GET":
			data, e = devices(tx, i.Account)
		case strings.HasPrefix(path, "/devices/") && method == "DELETE":
			id := strings.TrimPrefix(path, "/devices/")
			var result sql.Result
			result, e = tx.Exec(`UPDATE devices SET revoked=COALESCE(revoked,?) WHERE account=? AND id=?`, now(), i.Account, id)
			if e == nil {
				n, _ := result.RowsAffected()
				if n == 0 {
					e = fail(404, "device_not_found")
				} else {
					_, e = tx.Exec(`UPDATE families SET revoked=1 WHERE account=? AND device=?`, i.Account, id)
				}
			}
			if e == nil {
				e = audit(tx, i.Account, "device.revoke", id)
			}
			status = 204
		case path == "/key-bundle" && method == "PUT":
			data, e = updateBundle(tx, r, i)
		case path == "/sync/operations" && method == "POST":
			// Commit the read transaction before processing per-operation transactions.
			if e = tx.Commit(); e != nil {
				return nil, 0, e
			}
			return s.operations(r)
		case path == "/sync/changes" && method == "GET":
			data, e = changes(tx, r, i)
		case path == "/sync/snapshot" && method == "GET":
			data, e = snapshot(tx, i)
		case strings.HasPrefix(path, "/admin/"):
			if i.Role != "admin" {
				e = fail(403, "forbidden")
				break
			}
			data, status, e = s.admin(tx, r, i, path)
		default:
			e = fail(404, "not_found")
		}
	}
	// challenge consumption and refresh-reuse revocation intentionally commit on
	// authentication failure; no attacker can retry a failed challenge signature.
	if e != nil {
		if path == "/auth/sessions" && method == "POST" || path == "/auth/refresh" && method == "POST" {
			if ce := tx.Commit(); ce != nil {
				return nil, 0, ce
			}
		}
		return nil, 0, e
	}
	if e = tx.Commit(); e != nil {
		return nil, 0, e
	}
	return data, status, nil
}
func (s *Server) register(tx *sql.Tx, r *http.Request) (any, error) {
	var v struct {
		InviteToken   string          `json:"inviteToken"`
		AccountID     string          `json:"accountId"`
		Username      string          `json:"username"`
		SignPublicKey string          `json:"signPublicKey"`
		BoxPublicKey  string          `json:"boxPublicKey"`
		KeyBundle     json.RawMessage `json:"keyBundle"`
		Device        DeviceInput     `json:"device"`
	}
	if e := body(r, &v); e != nil {
		return nil, e
	}
	v.Username = strings.TrimSpace(v.Username)
	if !uuid.MatchString(v.AccountID) || len(v.Username) < 3 || len(v.Username) > 64 || !decode64(v.SignPublicKey, 32) || !decode64(v.BoxPublicKey, 32) || !validDevice(v.AccountID, v.SignPublicKey, v.Device) {
		return nil, fail(400, "invalid_registration")
	}
	if _, e := bundleValid(string(v.KeyBundle)); e != nil {
		return nil, e
	}
	var count int
	// Lock the table's accounts so two concurrent first-registrations cannot
	// both observe count=0 and each be granted the admin role. MySQL does not
	// expose a portable table lock through this interface, so the bootstrap
	// decision is serialized on a dedicated single-row lock instead.
	if _, e := tx.Exec(`INSERT INTO bootstrap_lock(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id`); e != nil {
		return nil, e
	}
	if _, e := tx.Exec(`SELECT id FROM bootstrap_lock WHERE id=1 FOR UPDATE`); e != nil {
		return nil, e
	}
	if e := tx.QueryRow(`SELECT count(*) FROM accounts`).Scan(&count); e != nil {
		return nil, e
	}
	role := "user"
	if count == 0 {
		if s.cfg.BootstrapToken == "" || digest(v.InviteToken) != digest(s.cfg.BootstrapToken) {
			return nil, fail(403, "invalid_invitation")
		}
		role = "admin"
	} else {
		res, e := tx.Exec(`UPDATE invitations SET used=1 WHERE hash=? AND used=0 AND expires>?`, digest(v.InviteToken), time.Now().Unix())
		if e != nil {
			return nil, e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return nil, fail(403, "invalid_invitation")
		}
	}
	if _, e := tx.Exec(`INSERT INTO accounts(id,username,sign_key,box_key,bundle,role,created) VALUES(?,?,?,?,?,?,?)`, v.AccountID, v.Username, v.SignPublicKey, v.BoxPublicKey, string(v.KeyBundle), role, now()); e != nil {
		return nil, fail(409, "account_exists")
	}
	if e := insertDevice(tx, v.AccountID, v.Device); e != nil {
		return nil, e
	}
	if e := audit(tx, v.AccountID, "account.register", v.AccountID); e != nil {
		return nil, e
	}
	return map[string]string{"accountId": v.AccountID}, nil
}
func lookup(tx *sql.Tx, name string) (any, error) {
	var id, user, sign, box, bundle string
	e := tx.QueryRow(`SELECT id,username,sign_key,box_key,bundle FROM accounts WHERE username=? AND disabled=0`, strings.TrimSpace(name)).Scan(&id, &user, &sign, &box, &bundle)
	if e != nil {
		return nil, fail(404, "account_not_found")
	}
	return map[string]any{"accountId": id, "username": user, "signPublicKey": sign, "boxPublicKey": box, "keyBundle": json.RawMessage(bundle)}, nil
}
func me(tx *sql.Tx, id string) (any, error) {
	var user, sign, box, bundle, role string
	var version int
	e := tx.QueryRow(`SELECT username,sign_key,box_key,bundle,role,bundle_version FROM accounts WHERE id=?`, id).Scan(&user, &sign, &box, &bundle, &role, &version)
	return map[string]any{"accountId": id, "username": user, "signPublicKey": sign, "boxPublicKey": box, "keyBundle": json.RawMessage(bundle), "role": role, "bundleVersion": version}, e
}
func insertDevice(tx *sql.Tx, account string, d DeviceInput) error {
	_, e := tx.Exec(`INSERT INTO devices(account,id,name,pub,proof,created) VALUES(?,?,?,?,?,?)`, account, d.ID, d.Name, d.PublicKey, d.Proof, now())
	return e
}
func (s *Server) enroll(tx *sql.Tx, r *http.Request) (any, error) {
	var v struct {
		AccountID string `json:"accountId"`
		ID        string `json:"id"`
		Name      string `json:"name"`
		PublicKey string `json:"publicKey"`
		Proof     string `json:"proof"`
	}
	if e := body(r, &v); e != nil {
		return nil, e
	}
	var pub string
	if tx.QueryRow(`SELECT sign_key FROM accounts WHERE id=? AND disabled=0`, v.AccountID).Scan(&pub) != nil {
		return nil, fail(403, "forbidden")
	}
	d := DeviceInput{v.ID, v.Name, v.PublicKey, v.Proof}
	if !validDevice(v.AccountID, pub, d) {
		return nil, fail(400, "invalid_device_proof")
	}
	var key, proof string
	var revoked sql.NullString
	e := tx.QueryRow(`SELECT pub,proof,revoked FROM devices WHERE account=? AND id=?`, v.AccountID, v.ID).Scan(&key, &proof, &revoked)
	if e == nil {
		if revoked.Valid || key != v.PublicKey || proof != v.Proof {
			return nil, fail(409, "device_conflict")
		}
		return map[string]string{"id": v.ID}, nil
	}
	if e != sql.ErrNoRows {
		return nil, e
	}
	if e = insertDevice(tx, v.AccountID, d); e != nil {
		return nil, e
	}
	e = audit(tx, v.AccountID, "device.enroll", v.ID)
	return map[string]string{"id": v.ID}, e
}
func devices(tx *sql.Tx, account string) (any, error) {
	rows, e := tx.Query(`SELECT id,name,created,revoked FROM devices WHERE account=? ORDER BY created,id`, account)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, name, created string
		var revoked *string
		if e = rows.Scan(&id, &name, &created, &revoked); e != nil {
			return nil, e
		}
		out = append(out, map[string]any{"id": id, "name": name, "createdAt": created, "revokedAt": revoked})
	}
	return out, rows.Err()
}
func updateBundle(tx *sql.Tx, r *http.Request, i identity) (any, error) {
	var v struct {
		BundleJSON      string `json:"bundleJson"`
		ExpectedVersion int    `json:"expectedVersion"`
		Signature       string `json:"signature"`
	}
	if e := body(r, &v); e != nil {
		return nil, e
	}
	b, e := bundleValid(v.BundleJSON)
	if e != nil {
		return nil, e
	}
	msg := "rememberKey:bundle:1:" + i.Account + ":" + strconv.Itoa(v.ExpectedVersion) + ":" + digest(v.BundleJSON)
	if !verify(i.SignKey, msg, v.Signature) {
		return nil, fail(403, "invalid_signature")
	}
	var old string
	var version int
	if e = tx.QueryRow(`SELECT bundle,bundle_version FROM accounts WHERE id=?`, i.Account).Scan(&old, &version); e != nil {
		return nil, e
	}
	ob, e := bundleValid(old)
	if e != nil {
		return nil, e
	}
	if b.PrivateWrap != ob.PrivateWrap {
		return nil, fail(400, "private_wrap_immutable")
	}
	if version != v.ExpectedVersion {
		return nil, fail(409, "bundle_conflict")
	}
	_, e = tx.Exec(`UPDATE accounts SET bundle=?,bundle_version=bundle_version+1 WHERE id=?`, v.BundleJSON, i.Account)
	return map[string]int{"version": version + 1}, e
}
func (s *Server) challenge(tx *sql.Tx, r *http.Request) (any, error) {
	var v struct {
		AccountID string `json:"accountId"`
		DeviceID  string `json:"deviceId"`
	}
	if e := body(r, &v); e != nil {
		return nil, e
	}
	var count int
	e := tx.QueryRow(`SELECT count(*) FROM devices d JOIN accounts a ON a.id=d.account WHERE d.account=? AND d.id=? AND d.revoked IS NULL AND a.disabled=0`, v.AccountID, v.DeviceID).Scan(&count)
	if e != nil {
		return nil, e
	}
	if count != 1 {
		return nil, fail(403, "device_unavailable")
	}
	id := token()
	exp := time.Now().Add(2 * time.Minute)
	msg := "rememberKey:challenge:1:" + s.cfg.Origin + ":" + v.AccountID + ":" + v.DeviceID + ":" + token()
	_, e = tx.Exec(`INSERT INTO challenges(id,account,device,message,expires) VALUES(?,?,?,?,?)`, id, v.AccountID, v.DeviceID, msg, exp.Unix())
	return map[string]string{"id": id, "message": msg, "expiresAt": exp.UTC().Format(time.RFC3339)}, e
}
func (s *Server) cookie(w http.ResponseWriter, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: "rk_refresh", Value: value, Path: "/api/v1/auth", HttpOnly: true, Secure: !s.cfg.Dev, SameSite: http.SameSiteStrictMode, MaxAge: age})
}
func (s *Server) issue(tx *sql.Tx, w http.ResponseWriter, family, account string) (any, error) {
	access, refresh := token(), token()
	expiry := time.Now().Add(15 * time.Minute)
	if _, e := tx.Exec(`INSERT INTO access_tokens(hash,family,expires) VALUES(?,?,?)`, digest(access), family, expiry.Unix()); e != nil {
		return nil, e
	}
	if _, e := tx.Exec(`INSERT INTO refresh_tokens(hash,family,expires) VALUES(?,?,?)`, digest(refresh), family, time.Now().Add(30*24*time.Hour).Unix()); e != nil {
		return nil, e
	}
	s.cookie(w, refresh, 30*24*3600)
	return map[string]string{"accessToken": access, "accountId": account, "expiresAt": expiry.UTC().Format(time.RFC3339)}, nil
}
func (s *Server) session(tx *sql.Tx, w http.ResponseWriter, r *http.Request) (any, error) {
	var v struct {
		ChallengeID string `json:"challengeId"`
		Signature   string `json:"signature"`
	}
	if e := body(r, &v); e != nil {
		return nil, e
	}
	var account, device, msg string
	var expires int64
	var used int
	// Lock the challenge row so a concurrent replay cannot read used=0 before
	// this transaction commits. Without the lock both requests could observe an
	// unused challenge and each mint a session, defeating single-use semantics.
	if tx.QueryRow(`SELECT account,device,message,expires,used FROM challenges WHERE id=? FOR UPDATE`, v.ChallengeID).Scan(&account, &device, &msg, &expires, &used) != nil {
		return nil, fail(401, "invalid_challenge")
	}
	// Consume unconditionally so a failed signature still burns the challenge.
	if _, e := tx.Exec(`UPDATE challenges SET used=1 WHERE id=?`, v.ChallengeID); e != nil {
		return nil, e
	}
	if used != 0 || expires <= time.Now().Unix() {
		return nil, fail(401, "invalid_challenge")
	}
	var pub string
	if tx.QueryRow(`SELECT d.pub FROM devices d JOIN accounts a ON a.id=d.account WHERE d.account=? AND d.id=? AND d.revoked IS NULL AND a.disabled=0`, account, device).Scan(&pub) != nil || !verify(pub, msg, v.Signature) {
		return nil, fail(401, "invalid_signature")
	}
	family := token()
	if _, e := tx.Exec(`INSERT INTO families(id,account,device) VALUES(?,?,?)`, family, account, device); e != nil {
		return nil, e
	}
	return s.issue(tx, w, family, account)
}
func (s *Server) refresh(tx *sql.Tx, w http.ResponseWriter, r *http.Request) (any, error) {
	c, e := r.Cookie("rk_refresh")
	if e != nil {
		return nil, fail(401, "unauthorized")
	}
	var family, account string
	var used, revoked int
	var expires int64
	// Lock the refresh row so two concurrent uses of the same token cannot both
// observe used=0 and each rotate a new session; reuse detection depends on
// exactly one caller winning this row.
	if tx.QueryRow(`SELECT t.family,f.account,t.used,t.expires,f.revoked FROM refresh_tokens t JOIN families f ON f.id=t.family WHERE t.hash=? FOR UPDATE`, digest(c.Value)).Scan(&family, &account, &used, &expires, &revoked) != nil {
		return nil, fail(401, "unauthorized")
	}
	if used != 0 {
		_, e = tx.Exec(`UPDATE families SET revoked=1 WHERE id=?`, family)
		s.cookie(w, "", -1)
		if e != nil {
			return nil, e
		}
		return nil, fail(401, "refresh_reuse")
	}
	var enabled int
	if tx.QueryRow(`SELECT count(*) FROM families f JOIN accounts a ON a.id=f.account JOIN devices d ON d.account=f.account AND d.id=f.device WHERE f.id=? AND a.disabled=0 AND d.revoked IS NULL`, family).Scan(&enabled) != nil || enabled != 1 || revoked != 0 || expires <= time.Now().Unix() {
		return nil, fail(401, "unauthorized")
	}
	if _, e = tx.Exec(`UPDATE refresh_tokens SET used=1 WHERE hash=?`, digest(c.Value)); e != nil {
		return nil, e
	}
	return s.issue(tx, w, family, account)
}
