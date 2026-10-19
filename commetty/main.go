// Commetty Book server: a tiny, dependency-free Go server for the Commetty Book PWA.
// One binary, one JSON file, screenshots on disk, nightly zip backups (optionally sent to Telegram).
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // works on minimal hosts/containers without zoneinfo
)

//go:embed web
var webFS embed.FS

const maxShotBytes = 8 << 20

type config struct {
	addr, dataDir, password string
	keep, backupHour        int
	tgToken, tgChat         string
	trustProxy              bool
	tlsCert, tlsKey         string
	loc                     *time.Location
}

type App struct {
	cfg    config
	store  *Store
	auth   *Auth
	static map[string]*asset
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return n
	}
	return def
}

func loadConfig() config {
	loc, err := time.LoadLocation(env("TZ", "Asia/Kolkata"))
	if err != nil {
		loc = time.FixedZone("IST", 5*3600+1800)
	}
	c := config{
		addr: env("ADDR", ":"+env("PORT", "8080")), dataDir: env("DATA_DIR", "data"), password: os.Getenv("APP_PASSWORD"),
		keep: envInt("BACKUP_KEEP", 30), backupHour: envInt("BACKUP_HOUR", 2),
		tgToken: os.Getenv("TELEGRAM_BOT_TOKEN"), tgChat: os.Getenv("TELEGRAM_CHAT_ID"),
		trustProxy: os.Getenv("TRUST_PROXY") == "1", tlsCert: os.Getenv("TLS_CERT"), tlsKey: os.Getenv("TLS_KEY"), loc: loc,
	}
	if c.keep < 1 {
		c.keep = 1
	}
	if c.backupHour < 0 || c.backupHour > 23 {
		c.backupHour = 2
	}
	if c.tgChat == "" {
		c.tgToken = ""
	}
	return c
}

func main() {
	// Keep the heap small: GC works harder rather than letting memory grow.
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(24 << 20)
	}
	cfg := loadConfig()
	if len(cfg.password) < 6 {
		log.Fatal("set APP_PASSWORD (at least 6 characters) — it is the login password for the app")
	}
	app, err := newApp(cfg)
	if err != nil {
		log.Fatal(err)
	}
	go app.backupLoop()

	srv := &http.Server{
		Addr: cfg.addr, Handler: app.routes(),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 10 * time.Minute, WriteTimeout: 10 * time.Minute,
		IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 16 << 10,
	}
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()
	log.Printf("Commetty Book on %s (data: %s, backups at %02d:00 %s, telegram: %v)", cfg.addr, cfg.dataDir, cfg.backupHour, cfg.loc, cfg.tgToken != "")
	if cfg.tlsCert != "" {
		err = srv.ListenAndServeTLS(cfg.tlsCert, cfg.tlsKey)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func newApp(cfg config) (*App, error) {
	store, err := openStore(cfg.dataDir)
	if err != nil {
		return nil, err
	}
	auth, err := newAuth(cfg.dataDir, cfg.password, cfg.trustProxy)
	if err != nil {
		return nil, err
	}
	static, err := loadStatic()
	if err != nil {
		return nil, err
	}
	return &App{cfg: cfg, store: store, auth: auth, static: static}, nil
}

// ------------------------------------------------------------------ static files

// asset is a pre-gzipped embedded file with a content-hash ETag (~100 KB total in memory).
type asset struct {
	body, gz []byte
	ctype    string
	etag     string
}

func loadStatic() (map[string]*asset, error) {
	sub, _ := fs.Sub(webFS, "web")
	out := map[string]*asset{}
	err := fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(sub, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		a := &asset{body: b, etag: `"` + hex.EncodeToString(sum[:8]) + `"`, ctype: mime.TypeByExtension(path.Ext(p))}
		if strings.HasSuffix(p, ".webmanifest") {
			a.ctype = "application/manifest+json"
		}
		if !strings.HasSuffix(p, ".png") {
			var buf bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			zw.Write(b)
			zw.Close()
			a.gz = buf.Bytes()
		}
		out["/"+p] = a
		return nil
	})
	out["/"] = out["/index.html"]
	return out, err
}

func (a *App) serveStatic(w http.ResponseWriter, r *http.Request) {
	f := a.static[r.URL.Path]
	if f == nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", f.ctype)
	h.Set("ETag", f.etag)
	h.Set("Cache-Control", "no-cache")
	h.Set("Vary", "Accept-Encoding")
	if r.Header.Get("If-None-Match") == f.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body := f.body
	if f.gz != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		h.Set("Content-Encoding", "gzip")
		body = f.gz
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method != http.MethodHead {
		w.Write(body)
	}
}

// ------------------------------------------------------------------ routing & middleware

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", a.serveStatic)
	mux.HandleFunc("POST /api/login", a.handleLogin)
	mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) { logout(w); writeJSON(w, 200, ok) })

	api := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, a.requireAuth(h)) }
	api("GET /api/data", a.handleData)
	api("POST /api/committees", a.handlePutCommittee)
	api("PUT /api/committees/{id}", a.handlePutCommittee)
	api("DELETE /api/committees/{id}", func(w http.ResponseWriter, r *http.Request) { a.reply(w, a.store.DeleteCommittee(r.PathValue("id"))) })
	api("POST /api/deposits", a.handlePutDeposit)
	api("PUT /api/deposits/{id}", a.handlePutDeposit)
	api("DELETE /api/deposits/{id}", func(w http.ResponseWriter, r *http.Request) { a.reply(w, a.store.DeleteDeposit(r.PathValue("id"))) })
	api("POST /api/shots", a.handleUploadShot)
	api("GET /api/shots/{id}", a.handleShot)
	api("GET /api/backup", a.handleDownloadZip)
	api("POST /api/restore", a.handleRestoreUpload)
	api("GET /api/backups", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.listBackups()) })
	api("POST /api/backups", a.handleBackupNow)
	api("GET /api/backups/{name}", a.handleDownloadBackup)
	api("POST /api/backups/{name}/restore", a.handleRestoreBackup)
	return a.secure(mux)
}

var ok = map[string]bool{"ok": true}

func (a *App) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if isHTTPS(r, a.cfg.trustProxy) {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		// CSRF guard: every state-changing call must carry a custom header, which cross-site pages cannot send.
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-CB") != "1" {
			writeErr(w, http.StatusForbidden, "missing X-CB header")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) requireAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.auth.valid(r) {
			writeErr(w, http.StatusUnauthorized, "login required")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		next(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (a *App) reply(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		writeJSON(w, 200, ok)
	case errors.Is(err, errNotFound):
		writeErr(w, 404, "not found")
	default:
		writeErr(w, 400, err.Error())
	}
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return errors.New("invalid request body")
	}
	return nil
}

// ------------------------------------------------------------------ handlers

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct{ Password string }
	if err := readJSON(r, &body); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	good, wait := a.auth.login(w, r, body.Password)
	switch {
	case wait > 0:
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeErr(w, 429, "Bahut galat try ho gaye. "+strconv.Itoa(int(wait.Minutes())+1)+" minute baad try karein.")
	case !good:
		writeErr(w, 401, "Galat password")
	default:
		writeJSON(w, 200, ok)
	}
}

func (a *App) handleData(w http.ResponseWriter, r *http.Request) {
	db, _, err := a.store.JSON()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	var last *backupInfo
	list := a.listBackups()
	if len(list) > 0 {
		last = &list[0]
	}
	meta, _ := json.Marshal(map[string]any{
		"lastBackup": last, "backupCount": len(list), "backupKeep": a.cfg.keep, "backupHour": a.cfg.backupHour,
		"telegram": a.cfg.tgToken != "", "pending": a.changedSinceBackup(),
	})
	w.Header().Set("Content-Type", "application/json")
	// {"committees":…,"deposits":…,"server":{…}}
	w.Write(db[:len(db)-1])
	w.Write([]byte(`,"server":`))
	w.Write(meta)
	w.Write([]byte("}"))
}

func (a *App) handlePutCommittee(w http.ResponseWriter, r *http.Request) {
	var c Committee
	if err := readJSON(r, &c); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	c.ID = r.PathValue("id")
	if err := a.store.PutCommittee(&c); err != nil {
		a.reply(w, err)
		return
	}
	writeJSON(w, 200, c)
}

func (a *App) handlePutDeposit(w http.ResponseWriter, r *http.Request) {
	var d Deposit
	if err := readJSON(r, &d); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	d.ID = r.PathValue("id")
	if err := a.store.PutDeposit(&d); err != nil {
		a.reply(w, err)
		return
	}
	writeJSON(w, 200, d)
}

func (a *App) handleUploadShot(w http.ResponseWriter, r *http.Request) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxShotBytes))
	if err != nil {
		writeErr(w, 413, "image too large (max 8 MB)")
		return
	}
	if ct := http.DetectContentType(b); !strings.HasPrefix(ct, "image/") {
		writeErr(w, 400, "only images are allowed")
		return
	}
	id := newID()
	if err := writeFileAtomic(a.store.shotPath(id), b); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"id": id})
}

func (a *App) handleShot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !idRe.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(a.store.shotPath(id))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	w.Header().Set("Content-Type", http.DetectContentType(head[:n]))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	f.Seek(0, io.SeekStart)
	io.Copy(w, f)
}

func (a *App) attachment(w http.ResponseWriter, name string) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
}

func (a *App) handleDownloadZip(w http.ResponseWriter, r *http.Request) {
	a.attachment(w, "CommettyBackup_"+time.Now().In(a.cfg.loc).Format("2006-01-02_1504")+".zip")
	if err := a.writeZip(w); err != nil {
		log.Printf("download backup: %v", err)
	}
}

func (a *App) handleBackupNow(w http.ResponseWriter, r *http.Request) {
	name, err := a.snapshot("manual")
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	resp := map[string]any{"name": name, "telegram": false}
	if a.cfg.tgToken != "" {
		if err := a.sendTelegram(name); err != nil {
			resp["telegramError"] = err.Error()
		} else {
			resp["telegram"] = true
		}
	}
	writeJSON(w, 200, resp)
}

func (a *App) handleDownloadBackup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !backupNameRe.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(a.backupDir(), name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	a.attachment(w, name)
	io.Copy(w, f)
}

func (a *App) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !backupNameRe.MatchString(name) {
		writeErr(w, 404, "backup not found")
		return
	}
	a.reply(w, a.restoreZip(filepath.Join(a.backupDir(), name)))
}

// handleRestoreUpload accepts a raw .zip body (streamed to a temp file, never held in memory).
func (a *App) handleRestoreUpload(w http.ResponseWriter, r *http.Request) {
	tmp, err := os.CreateTemp(a.store.dir, "upload-*.zip")
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer os.Remove(tmp.Name())
	_, err = io.Copy(tmp, http.MaxBytesReader(w, r.Body, 1<<30))
	tmp.Close()
	if err != nil {
		writeErr(w, 400, "upload failed")
		return
	}
	a.reply(w, a.restoreZip(tmp.Name()))
}
