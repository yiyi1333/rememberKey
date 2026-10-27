package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type Config struct {
	Origin, BootstrapToken, DSN, WebDir string
	Dev                                 bool
}
type Server struct {
	db    *sql.DB
	cfg   Config
	mu    sync.Mutex
	rates map[string]rate
}
type rate struct {
	start time.Time
	count int
}
type apiError struct {
	status int
	code   string
}

func (e apiError) Error() string         { return e.code }
func fail(status int, code string) error { return apiError{status, code} }
func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func digest(v string) string { d := sha256.Sum256([]byte(v)); return hex.EncodeToString(d[:]) }
func now() string            { return time.Now().UTC().Format(time.RFC3339Nano) }
func decode64(v string, n int) bool {
	b, e := base64.RawURLEncoding.DecodeString(v)
	return e == nil && len(b) == n && base64.RawURLEncoding.EncodeToString(b) == v
}
func verify(pub, msg, sig string) bool {
	p, e := base64.RawURLEncoding.DecodeString(pub)
	s, f := base64.RawURLEncoding.DecodeString(sig)
	return e == nil && f == nil && len(p) == 32 && ed25519.Verify(p, []byte(msg), s)
}

var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func strict(raw []byte, v any) error {
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return fail(400, "invalid_json")
	}
	if d.Decode(new(any)) != io.EOF {
		return fail(400, "invalid_json")
	}
	return nil
}
func body(r *http.Request, v any) error {
	b, e := io.ReadAll(r.Body)
	if e != nil {
		return fail(413, "body_too_large")
	}
	return strict(b, v)
}
func NewServer(c Config) (*Server, error) {
	u, e := url.Parse(c.Origin)
	if e != nil || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.User != nil {
		return nil, errors.New("RK_ORIGIN must be an exact origin")
	}
	if c.Dev {
		if u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
			return nil, errors.New("development origin must be loopback")
		}
	} else if u.Scheme != "https" {
		return nil, errors.New("production requires HTTPS origin")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("invalid origin scheme")
	}
	if c.DSN == "" {
		return nil, errors.New("RK_DB_DSN is required")
	}
	db, e := sql.Open("mysql", c.DSN)
	if e != nil {
		return nil, e
	}
	// MySQL is a real client/server database, so the pool can be concurrent;
	// atomicity is enforced by row locks in each transaction instead of the
	// single-connection trick SQLite required. Bound the pool so a small
	// self-hosted deployment cannot exhaust server connections.
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(8)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(time.Minute)
	if e = db.Ping(); e != nil {
		db.Close()
		return nil, fmt.Errorf("cannot reach database: %w", e)
	}
	if _, e = db.Exec(schema); e != nil {
		db.Close()
		return nil, e
	}
	return &Server{db: db, cfg: c, rates: map[string]rate{}}, nil
}

// MySQL schema. Differences from the previous SQLite schema that matter:
//   - INT AUTO_INCREMENT replaces INTEGER PRIMARY KEY AUTOINCREMENT.
//   - TEXT columns that are indexed or compared need an explicit length so
//     InnoDB can build the key within its limit.
//   - All tables are InnoDB so transactions and row locks are available.
const schema = `
CREATE TABLE IF NOT EXISTS accounts(
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  sign_key VARCHAR(128) NOT NULL,
  box_key VARCHAR(128) NOT NULL,
  bundle MEDIUMTEXT NOT NULL,
  bundle_version BIGINT NOT NULL DEFAULT 1,
  role VARCHAR(16) NOT NULL,
  disabled TINYINT NOT NULL DEFAULT 0,
  created VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS devices(
  account VARCHAR(64) NOT NULL,
  id VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  pub VARCHAR(128) NOT NULL,
  proof VARCHAR(256) NOT NULL,
  created VARCHAR(40) NOT NULL,
  revoked VARCHAR(40) NULL,
  PRIMARY KEY(account,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS challenges(
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  account VARCHAR(64) NULL,
  device VARCHAR(64) NULL,
  message TEXT NOT NULL,
  expires BIGINT NULL,
  used TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS families(
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  account VARCHAR(64) NULL,
  device VARCHAR(64) NULL,
  revoked TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS access_tokens(
  hash VARCHAR(64) NOT NULL PRIMARY KEY,
  family VARCHAR(64) NULL,
  expires BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS refresh_tokens(
  hash VARCHAR(64) NOT NULL PRIMARY KEY,
  family VARCHAR(64) NULL,
  expires BIGINT NULL,
  used TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS invitations(
  hash VARCHAR(64) NOT NULL PRIMARY KEY,
  expires BIGINT NULL,
  used TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS records(
  account VARCHAR(64) NOT NULL,
  id VARCHAR(64) NOT NULL,
  revision BIGINT NOT NULL,
  deleted TINYINT NOT NULL,
  envelope MEDIUMTEXT NULL,
  signature VARCHAR(256) NOT NULL,
  operation VARCHAR(64) NOT NULL,
  base BIGINT NOT NULL,
  PRIMARY KEY(account,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS changes(
  seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account VARCHAR(64) NULL,
  record MEDIUMTEXT NOT NULL,
  KEY changes_account(account,seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS operations(
  account VARCHAR(64) NOT NULL,
  id VARCHAR(64) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  result MEDIUMTEXT NOT NULL,
  PRIMARY KEY(account,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS audit(
  seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor VARCHAR(64) NULL,
  action VARCHAR(64) NULL,
  target VARCHAR(64) NULL,
  created VARCHAR(40) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`

func (s *Server) Close() error { return s.db.Close() }
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/healthz" {
		w.WriteHeader(200)
		return
	}
	if r.URL.Path == "/readyz" {
		if s.db.Ping() != nil {
			w.WriteHeader(503)
		} else {
			w.WriteHeader(200)
		}
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		if s.cfg.WebDir != "" {
			http.FileServer(http.Dir(s.cfg.WebDir)).ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("Origin") != s.cfg.Origin {
		s.reply(w, nil, fail(403, "origin_rejected"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if strings.HasPrefix(r.URL.Path, "/api/v1/auth/") || r.URL.Path == "/api/v1/accounts/lookup" || r.URL.Path == "/api/v1/registrations" || r.URL.Path == "/api/v1/devices" && r.Method == "POST" {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		key := host + ":" + r.URL.Path
		s.mu.Lock()
		v, exists := s.rates[key]
		if len(s.rates) >= 10000 && !exists {
			for k, entry := range s.rates {
				if time.Since(entry.start) > time.Minute {
					delete(s.rates, k)
				}
			}
		}
		full := len(s.rates) >= 10000 && !exists
		if time.Since(v.start) > time.Minute {
			v = rate{start: time.Now()}
		}
		v.count++
		if !full {
			s.rates[key] = v
		}
		s.mu.Unlock()
		if full || v.count > 30 {
			w.Header().Set("Retry-After", "60")
			s.reply(w, nil, fail(429, "rate_limited"))
			return
		}
	}
	data, status, err := s.route(w, r)
	if err != nil {
		s.reply(w, nil, err)
		return
	}
	if status == 204 {
		w.WriteHeader(204)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"data": data})
}
func (s *Server) reply(w http.ResponseWriter, _ any, e error) {
	status, code := 500, "internal_error"
	var ae apiError
	if errors.As(e, &ae) {
		status, code = ae.status, ae.code
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": strings.ReplaceAll(code, "_", " ")}})
}

type queryer interface{ QueryRow(string, ...any) *sql.Row }
type identity struct{ Account, Device, Family, Role, SignKey string }

func auth(q queryer, r *http.Request) (identity, error) {
	var i identity
	t := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if t == "" || t == r.Header.Get("Authorization") {
		return i, fail(401, "unauthorized")
	}
	e := q.QueryRow(`SELECT a.id,d.id,f.id,a.role,a.sign_key FROM access_tokens t JOIN families f ON f.id=t.family JOIN accounts a ON a.id=f.account JOIN devices d ON d.account=f.account AND d.id=f.device WHERE t.hash=? AND t.expires>? AND f.revoked=0 AND a.disabled=0 AND d.revoked IS NULL`, digest(t), time.Now().Unix()).Scan(&i.Account, &i.Device, &i.Family, &i.Role, &i.SignKey)
	if e != nil {
		return i, fail(401, "unauthorized")
	}
	return i, nil
}
func audit(tx *sql.Tx, actor, action, target string) error {
	_, e := tx.Exec(`INSERT INTO audit(actor,action,target,created) VALUES(?,?,?,?)`, actor, action, target, now())
	return e
}
func main() {
	s, e := NewServer(Config{Origin: os.Getenv("RK_ORIGIN"), BootstrapToken: os.Getenv("RK_BOOTSTRAP_TOKEN"), DSN: os.Getenv("RK_DB_DSN"), WebDir: os.Getenv("RK_WEB_DIR"), Dev: os.Getenv("RK_DEV") == "true"})
	if e != nil {
		log.Fatal(e)
	}
	defer s.Close()
	addr := os.Getenv("RK_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	ln, e := net.Listen("tcp", addr)
	if e != nil {
		log.Fatalf("cannot listen on %s: %v", addr, e)
	}
	h := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	// Log only after the socket is actually bound, so the message reflects a
	// reachable address instead of an intended one.
	log.Printf("rememberKey listening on %s; TLS must terminate at configured reverse proxy", ln.Addr())
	if e = h.Serve(ln); e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
