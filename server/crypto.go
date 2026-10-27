package main

import (
	"encoding/json"
)

type Wrap struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}
type Bundle struct {
	Version      int    `json:"version"`
	Salt         string `json:"salt"`
	PasswordWrap Wrap   `json:"passwordWrap"`
	RecoveryWrap Wrap   `json:"recoveryWrap"`
	PrivateWrap  Wrap   `json:"privateWrap"`
}
type Envelope struct {
	Version    int    `json:"version"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
	WrappedKey string `json:"wrappedKey"`
}

func validWrap(w Wrap, n int) bool { return decode64(w.Nonce, 24) && decode64(w.Ciphertext, n) }
func bundleValid(raw string) (Bundle, error) {
	var b Bundle
	if strict([]byte(raw), &b) != nil || b.Version != 1 || !decode64(b.Salt, 16) || !validWrap(b.PasswordWrap, 48) || !validWrap(b.RecoveryWrap, 48) || !decode64(b.PrivateWrap.Nonce, 24) || !binaryRange(b.PrivateWrap.Ciphertext, 17, 4096) {
		return b, fail(400, "invalid_bundle")
	}
	return b, nil
}
func envelopeValid(raw *string, deleted bool) bool {
	if deleted {
		return raw == nil
	}
	if raw == nil || len(*raw) > 128<<10 {
		return false
	}
	var e Envelope
	return strict([]byte(*raw), &e) == nil && e.Version == 1 && decode64(e.Nonce, 24) && binaryRange(e.Ciphertext, 16, 96<<10) && decode64(e.WrappedKey, 80)
}
func binaryRange(v string, min, max int) bool {
	n := len(v) * 3 / 4
	for i := n - 2; i <= n+2; i++ {
		if i >= min && i <= max && decode64(v, i) {
			return true
		}
	}
	return false
}

type DeviceInput struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PublicKey string `json:"publicKey"`
	Proof     string `json:"proof"`
}

func validDevice(account, pub string, d DeviceInput) bool {
	return uuid.MatchString(d.ID) && len(d.Name) > 0 && len(d.Name) <= 128 && decode64(d.PublicKey, 32) && verify(pub, "rememberKey:device:1:"+account+":"+d.ID+":"+d.PublicKey, d.Proof)
}
func marshal(v any) string { b, _ := json.Marshal(v); return string(b) }
