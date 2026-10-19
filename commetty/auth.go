package main

// Single-password login. The session cookie is "<expiry>.<hmac>", signed with a key derived from a
// random secret (data/secret) and the password, so changing APP_PASSWORD logs every device out.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	cookieName  = "cb_session"
	sessionLife = 180 * 24 * time.Hour
	maxFails    = 5
	lockout     = 15 * time.Minute
)

type Auth struct {
	key        []byte
	pwHash     [32]byte
	trustProxy bool

	mu    sync.Mutex
	fails map[string]*failure
}

type failure struct {
	n     int
	until time.Time
}

func newAuth(dataDir, password string, trustProxy bool) (*Auth, error) {
	path := filepath.Join(dataDir, "secret")
	secret, err := os.ReadFile(path)
	if err != nil || len(secret) < 32 {
		secret = make([]byte, 32)
		rand.Read(secret)
		if err := writeFileAtomic(path, secret); err != nil {
			return nil, err
		}
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(password))
	return &Auth{key: mac.Sum(nil), pwHash: sha256.Sum256([]byte(password)), trustProxy: trustProxy, fails: map[string]*failure{}}, nil
}

func (a *Auth) sign(exp int64) string {
	mac := hmac.New(sha256.New, a.key)
	mac.Write([]byte(strconv.FormatInt(exp, 10)))
	return strconv.FormatInt(exp, 10) + "." + hex.EncodeToString(mac.Sum(nil))
}

func (a *Auth) valid(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	exp, _, ok := strings.Cut(c.Value, ".")
	n, err := strconv.ParseInt(exp, 10, 64)
	if !ok || err != nil || time.Now().Unix() > n {
		return false
	}
	return hmac.Equal([]byte(c.Value), []byte(a.sign(n)))
}

func (a *Auth) clientIP(r *http.Request) string {
	if a.trustProxy {
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			ip, _, _ := strings.Cut(f, ",")
			return strings.TrimSpace(ip)
		}
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	return ip
}

func isHTTPS(r *http.Request, trustProxy bool) bool {
	return r.TLS != nil || (trustProxy && r.Header.Get("X-Forwarded-Proto") == "https")
}

// login checks the password with per-IP lockout after repeated failures.
func (a *Auth) login(w http.ResponseWriter, r *http.Request, password string) (ok bool, retryAfter time.Duration) {
	ip := a.clientIP(r)
	a.mu.Lock()
	f := a.fails[ip]
	if f != nil && time.Now().Before(f.until) {
		a.mu.Unlock()
		return false, time.Until(f.until)
	}
	a.mu.Unlock()

	h := sha256.Sum256([]byte(password))
	if subtle.ConstantTimeCompare(h[:], a.pwHash[:]) != 1 {
		time.Sleep(500 * time.Millisecond)
		a.mu.Lock()
		if len(a.fails) > 10000 {
			a.fails = map[string]*failure{}
		}
		if f = a.fails[ip]; f == nil {
			f = &failure{}
			a.fails[ip] = f
		}
		if f.n++; f.n >= maxFails {
			f.n, f.until = 0, time.Now().Add(lockout)
		}
		a.mu.Unlock()
		return false, 0
	}
	a.mu.Lock()
	delete(a.fails, ip)
	a.mu.Unlock()

	exp := time.Now().Add(sessionLife)
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: a.sign(exp.Unix()), Path: "/", Expires: exp,
		HttpOnly: true, Secure: isHTTPS(r, a.trustProxy), SameSite: http.SameSiteStrictMode,
	})
	return true, 0
}

func logout(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
}
