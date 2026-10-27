package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type testClient struct {
	s                    *Server
	t                    *testing.T
	id, device, username string
	key, deviceKey       ed25519.PrivateKey
	access               string
	cookie               *http.Cookie
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
func zeros(n int) string  { return b64(make([]byte, n)) }
func fixtureBundle() Bundle {
	return Bundle{1, zeros(16), Wrap{zeros(24), zeros(48)}, Wrap{zeros(24), zeros(48)}, Wrap{zeros(24), zeros(200)}}
}
func newTest(t *testing.T) *Server {
	t.Helper()
	s, e := NewServer(Config{Origin: "http://localhost:8080", BootstrapToken: "bootstrap", DataDir: t.TempDir(), Dev: true})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func request(s *Server, method, path string, v any, access string, cookie *http.Cookie) *httptest.ResponseRecorder {
	raw := []byte{}
	if v != nil {
		raw, _ = json.Marshal(v)
	}
	r := httptest.NewRequest(method, "http://localhost:8080/api/v1"+path, bytes.NewReader(raw))
	r.Header.Set("Origin", "http://localhost:8080")
	r.Header.Set("Content-Type", "application/json")
	if access != "" {
		r.Header.Set("Authorization", "Bearer "+access)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func response(t *testing.T, w *httptest.ResponseRecorder, status int) map[string]json.RawMessage {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status=%d want=%d body=%s", w.Code, status, w.Body)
	}
	if status == 204 {
		return nil
	}
	var out struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	return out.Data
}
func str(m map[string]json.RawMessage, key string) string {
	var v string
	json.Unmarshal(m[key], &v)
	return v
}
func account(t *testing.T, s *Server, n int, invite string) *testClient {
	t.Helper()
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	dp, dk, _ := ed25519.GenerateKey(rand.Reader)
	id := fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
	device := fmt.Sprintf("10000000-0000-4000-8000-%012d", n)
	proof := b64(ed25519.Sign(key, []byte("rememberKey:device:1:"+id+":"+device+":"+b64(dp))))
	v := map[string]any{"inviteToken": invite, "accountId": id, "username": fmt.Sprintf("user%d", n), "signPublicKey": b64(pub), "boxPublicKey": zeros(32), "keyBundle": fixtureBundle(), "device": DeviceInput{device, "device", b64(dp), proof}}
	response(t, request(s, "POST", "/registrations", v, "", nil), 201)
	return &testClient{s: s, t: t, id: id, device: device, username: fmt.Sprintf("user%d", n), key: key, deviceKey: dk}
}
func (c *testClient) challenge() map[string]json.RawMessage {
	return response(c.t, request(c.s, "POST", "/auth/challenges", map[string]string{"accountId": c.id, "deviceId": c.device}, "", nil), 200)
}
func (c *testClient) login() {
	ch := c.challenge()
	sig := b64(ed25519.Sign(c.deviceKey, []byte(str(ch, "message"))))
	w := request(c.s, "POST", "/auth/sessions", map[string]string{"challengeId": str(ch, "id"), "signature": sig}, "", nil)
	out := response(c.t, w, 200)
	c.access = str(out, "accessToken")
	c.cookie = w.Result().Cookies()[0]
}
func (c *testClient) op(num int, id string, base int64) Operation {
	env := marshal(Envelope{1, zeros(24), zeros(32), zeros(80)})
	op := Operation{fmt.Sprintf("20000000-0000-4000-8000-%012d", num), id, base, false, &env, ""}
	op.Signature = b64(ed25519.Sign(c.key, []byte("rememberKey:op:1:"+c.id+":"+op.OperationID+":"+id+fmt.Sprintf(":%d:0:", base)+digest(env))))
	return op
}
func (c *testClient) push(ops ...Operation) *httptest.ResponseRecorder {
	return request(c.s, "POST", "/sync/operations", map[string]any{"operations": ops}, c.access, nil)
}
func results(t *testing.T, w *httptest.ResponseRecorder) []Result {
	data := response(t, w, 200)
	var out []Result
	if e := json.Unmarshal(data["results"], &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func TestChallengeConsumedOnFailureAndSuccess(t *testing.T) {
	s := newTest(t)
	c := account(t, s, 1, "bootstrap")
	ch := c.challenge()
	v := map[string]string{"challengeId": str(ch, "id"), "signature": zeros(64)}
	responseError(t, request(s, "POST", "/auth/sessions", v, "", nil), 401)
	v["signature"] = b64(ed25519.Sign(c.deviceKey, []byte(str(ch, "message"))))
	responseError(t, request(s, "POST", "/auth/sessions", v, "", nil), 401)
	c.login()
	response(t, request(s, "GET", "/me", nil, c.access, nil), 200)
}
func responseError(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status=%d want=%d: %s", w.Code, status, w.Body)
	}
}
func TestRefreshReuseRevokesFamily(t *testing.T) {
	s := newTest(t)
	c := account(t, s, 1, "bootstrap")
	c.login()
	old := c.cookie
	w := request(s, "POST", "/auth/refresh", nil, "", old)
	out := response(t, w, 200)
	newAccess := str(out, "accessToken")
	newCookie := w.Result().Cookies()[0]
	if !newCookie.HttpOnly || newCookie.SameSite != http.SameSiteStrictMode || newCookie.Path != "/api/v1/auth" {
		t.Fatal("unsafe refresh cookie")
	}
	responseError(t, request(s, "POST", "/auth/refresh", nil, "", old), 401)
	responseError(t, request(s, "GET", "/me", nil, newAccess, nil), 401)
	responseError(t, request(s, "POST", "/auth/refresh", nil, "", newCookie), 401)
}
func TestSyncIsolationIdempotencyConflictAndTombstone(t *testing.T) {
	s := newTest(t)
	a := account(t, s, 1, "bootstrap")
	a.login()
	inv := response(t, request(s, "POST", "/admin/invitations", nil, a.access, nil), 201)
	b := account(t, s, 2, str(inv, "token"))
	b.login()
	id := "30000000-0000-4000-8000-000000000001"
	op := a.op(1, id, 0)
	out := results(t, a.push(op))
	if out[0].Status != "applied" || out[0].Record.Revision != 1 {
		t.Fatal(out)
	}
	again := results(t, a.push(op))
	if marshal(out) != marshal(again) {
		t.Fatal("idempotent replay changed")
	}
	altered := a.op(1, id, 1)
	responseError(t, a.push(altered), 409)
	conflict := a.op(2, id, 0)
	if results(t, a.push(conflict))[0].Status != "conflict" {
		t.Fatal("missing conflict")
	}
	responseError(t, b.push(op), 403)
}
func TestSyncSignatureAndIsolation(t *testing.T) {
	s := newTest(t)
	a := account(t, s, 1, "bootstrap")
	a.login()
	inv := response(t, request(s, "POST", "/admin/invitations", nil, a.access, nil), 201)
	b := account(t, s, 2, str(inv, "token"))
	b.login()
	id := "30000000-0000-4000-8000-000000000001"
	op := a.op(1, id, 0)
	responseError(t, b.push(op), 403)
	results(t, a.push(op))
	snap := response(t, request(s, "GET", "/sync/snapshot", nil, b.access, nil), 200)
	if string(snap["records"]) != "[]" {
		t.Fatal("cross-account leak")
	}
	del := Operation{OperationID: "20000000-0000-4000-8000-000000000002", ID: id, BaseRevision: 1, Deleted: true}
	del.Signature = b64(ed25519.Sign(a.key, []byte("rememberKey:op:1:"+a.id+":"+del.OperationID+":"+id+":1:1:"+digest(""))))
	if results(t, a.push(del))[0].Record.Revision != 2 {
		t.Fatal("delete revision")
	}
	page := response(t, request(s, "GET", "/sync/changes?limit=1", nil, a.access, nil), 200)
	if string(page["hasMore"]) != "true" {
		t.Fatal("missing hasMore")
	}
	second := response(t, request(s, "GET", "/sync/changes?cursor="+string(page["cursor"]), nil, a.access, nil), 200)
	if string(second["hasMore"]) != "false" {
		t.Fatal("bad page")
	}
}
func TestRevocationAndAdminRules(t *testing.T) {
	s := newTest(t)
	a := account(t, s, 1, "bootstrap")
	a.login()
	responseError(t, request(s, "PATCH", "/admin/users/"+a.id, map[string]bool{"disabled": true}, a.access, nil), 409)
	inv := response(t, request(s, "POST", "/admin/invitations", nil, a.access, nil), 201)
	b := account(t, s, 2, str(inv, "token"))
	b.login()
	responseError(t, request(s, "GET", "/admin/users", nil, b.access, nil), 403)
	responseError(t, request(s, "DELETE", "/devices/"+a.device, nil, b.access, nil), 404)
	response(t, request(s, "PATCH", "/admin/users/"+b.id, map[string]bool{"disabled": true}, a.access, nil), 200)
	responseError(t, b.push(b.op(1, "30000000-0000-4000-8000-000000000001", 0)), 401)
	responseError(t, request(s, "POST", "/auth/refresh", nil, "", b.cookie), 401)
	responseError(t, request(s, "POST", "/auth/challenges", map[string]string{"accountId": b.id, "deviceId": b.device}, "", nil), 403)
}
func TestOriginValidationAndStrictPayload(t *testing.T) {
	s := newTest(t)
	r := httptest.NewRequest("POST", "/api/v1/auth/refresh", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	responseError(t, w, 403)
	r = httptest.NewRequest("POST", "/api/v1/auth/challenges", strings.NewReader(`{"accountId":"x","deviceId":"y","secret":"plaintext"}`))
	r.Header.Set("Origin", s.cfg.Origin)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	responseError(t, w, 400)
	for _, c := range []Config{{Origin: "http://example.com"}, {Origin: "https://example.com/"}, {Origin: "https://example.com", Dev: true}} {
		c.DataDir = t.TempDir()
		if x, e := NewServer(c); e == nil {
			x.Close()
			t.Fatal("accepted unsafe config")
		}
	}
}
func TestBundleUpdateAndDeviceRevocation(t *testing.T) {
	s := newTest(t)
	c := account(t, s, 1, "bootstrap")
	c.login()
	b := fixtureBundle()
	b.PasswordWrap.Ciphertext = b64(bytes.Repeat([]byte{1}, 48))
	bundle := marshal(b)
	sign := func(raw string, version int) string {
		return b64(ed25519.Sign(c.key, []byte(fmt.Sprintf("rememberKey:bundle:1:%s:%d:%s", c.id, version, digest(raw)))))
	}
	v := map[string]any{"bundleJson": bundle, "expectedVersion": 1, "signature": sign(bundle, 1)}
	out := response(t, request(s, "PUT", "/key-bundle", v, c.access, nil), 200)
	if string(out["version"]) != "2" {
		t.Fatal("bad bundle version")
	}
	responseError(t, request(s, "PUT", "/key-bundle", v, c.access, nil), 409)
	b.PrivateWrap.Ciphertext = b64(bytes.Repeat([]byte{2}, 200))
	bundle = marshal(b)
	v = map[string]any{"bundleJson": bundle, "expectedVersion": 2, "signature": sign(bundle, 2)}
	responseError(t, request(s, "PUT", "/key-bundle", v, c.access, nil), 400)
	response(t, request(s, "DELETE", "/devices/"+c.device, nil, c.access, nil), 204)
	responseError(t, request(s, "GET", "/me", nil, c.access, nil), 401)
	responseError(t, request(s, "POST", "/auth/refresh", nil, "", c.cookie), 401)
}
func TestExpiredChallengeAndAccess(t *testing.T) {
	s := newTest(t)
	c := account(t, s, 1, "bootstrap")
	ch := c.challenge()
	if _, e := s.db.Exec(`UPDATE challenges SET expires=0 WHERE id=?`, str(ch, "id")); e != nil {
		t.Fatal(e)
	}
	v := map[string]string{"challengeId": str(ch, "id"), "signature": b64(ed25519.Sign(c.deviceKey, []byte(str(ch, "message"))))}
	responseError(t, request(s, "POST", "/auth/sessions", v, "", nil), 401)
	c.login()
	if _, e := s.db.Exec(`UPDATE access_tokens SET expires=0`); e != nil {
		t.Fatal(e)
	}
	responseError(t, request(s, "GET", "/me", nil, c.access, nil), 401)
	response(t, request(s, "POST", "/auth/refresh", nil, "", c.cookie), 200)
}
func TestConcurrentOperationsHaveOneRevisionWinner(t *testing.T) {
	s := newTest(t)
	c := account(t, s, 1, "bootstrap")
	c.login()
	id := "30000000-0000-4000-8000-000000000001"
	ops := []Operation{c.op(1, id, 0), c.op(2, id, 0)}
	responses := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for _, op := range ops {
		wg.Add(1)
		go func(op Operation) { defer wg.Done(); responses <- c.push(op) }(op)
	}
	wg.Wait()
	close(responses)
	applied, conflicts := 0, 0
	for w := range responses {
		res := results(t, w)
		if res[0].Status == "applied" {
			applied++
		} else if res[0].Status == "conflict" {
			conflicts++
		}
	}
	if applied != 1 || conflicts != 1 {
		t.Fatalf("applied=%d conflicts=%d", applied, conflicts)
	}
}
func TestConcurrentChallengeOneWinner(t *testing.T) {
	s := newTest(t)
	c := account(t, s, 1, "bootstrap")
	ch := c.challenge()
	v := map[string]string{"challengeId": str(ch, "id"), "signature": b64(ed25519.Sign(c.deviceKey, []byte(str(ch, "message"))))}
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); codes <- request(s, "POST", "/auth/sessions", v, "", nil).Code }()
	}
	wg.Wait()
	close(codes)
	wins := 0
	for code := range codes {
		if code == 200 {
			wins++
		}
	}
	if wins != 1 {
		t.Fatal("challenge winners", wins)
	}
}
