package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var jpeg = append([]byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 'J', 'F', 'I', 'F', 0}, bytes.Repeat([]byte{1}, 200)...)

type client struct {
	t   *testing.T
	srv *httptest.Server
	c   *http.Client
}

func newTestServer(t *testing.T) (*App, *client) {
	t.Helper()
	cfg := loadConfig()
	cfg.dataDir, cfg.password, cfg.tgToken = t.TempDir(), "secret123", ""
	app, err := newApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(app.routes())
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	return app, &client{t, srv, &http.Client{Jar: jar}}
}

func (c *client) do(method, path string, body any, out any) int {
	c.t.Helper()
	var r io.Reader
	ctype := "application/json"
	switch b := body.(type) {
	case nil:
	case []byte:
		r, ctype = bytes.NewReader(b), "application/octet-stream"
	default:
		j, _ := json.Marshal(b)
		r = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, c.srv.URL+path, r)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("X-CB", "1")
	res, err := c.c.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if out != nil {
		if p, ok := out.(*[]byte); ok {
			*p = data
		} else if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s: bad json %q", method, path, data)
		}
	}
	return res.StatusCode
}

func TestFlow(t *testing.T) {
	app, c := newTestServer(t)

	if code := c.do("GET", "/api/data", nil, nil); code != 401 {
		t.Fatalf("data without login = %d", code)
	}
	if code := c.do("POST", "/api/login", map[string]string{"password": "nope"}, nil); code != 401 {
		t.Fatalf("bad password = %d", code)
	}
	if code := c.do("POST", "/api/login", map[string]string{"password": "secret123"}, nil); code != 200 {
		t.Fatalf("login = %d", code)
	}

	// CSRF header is required for writes.
	res, _ := c.c.Post(c.srv.URL+"/api/committees", "application/json", strings.NewReader(`{}`))
	if res.StatusCode != 403 {
		t.Fatalf("write without X-CB = %d", res.StatusCode)
	}

	var com Committee
	if code := c.do("POST", "/api/committees", map[string]any{"name": "Santosh uncle January 2026", "totalAmount": 105000, "startDate": "2026-01-05", "months": 15}, &com); code != 200 || com.ID == "" {
		t.Fatalf("create committee = %d %+v", code, com)
	}
	if code := c.do("POST", "/api/committees", map[string]any{"name": "", "totalAmount": 1, "startDate": "2026-01-05"}, nil); code != 400 {
		t.Fatalf("invalid committee = %d", code)
	}

	var shot struct{ ID string }
	if code := c.do("POST", "/api/shots", jpeg, &shot); code != 200 || !idRe.MatchString(shot.ID) {
		t.Fatalf("upload shot = %d", code)
	}
	if code := c.do("POST", "/api/shots", []byte("<html>not an image</html>"), nil); code != 400 {
		t.Fatalf("non-image upload = %d", code)
	}

	var dep Deposit
	if code := c.do("POST", "/api/deposits", map[string]any{"committeeId": com.ID, "installmentNo": 1, "amount": 7000, "date": "2026-01-05", "mode": "PhonePe", "screenshots": []string{shot.ID}}, &dep); code != 200 {
		t.Fatalf("create deposit = %d", code)
	}
	if code := c.do("POST", "/api/deposits", map[string]any{"committeeId": com.ID, "installmentNo": 2, "amount": 6700, "date": "2026-02-05", "screenshots": []string{"0123456789abcdef"}}, nil); code != 400 {
		t.Fatalf("deposit with unknown screenshot = %d", code)
	}
	c.do("POST", "/api/deposits", map[string]any{"committeeId": com.ID, "installmentNo": 2, "amount": 6700, "date": "2026-02-05"}, nil)

	var raw []byte
	if code := c.do("GET", "/api/shots/"+shot.ID, nil, &raw); code != 200 || !bytes.Equal(raw, jpeg) {
		t.Fatalf("get shot = %d", code)
	}

	var data struct {
		Committees []Committee
		Deposits   []Deposit
		Server     map[string]any
	}
	c.do("GET", "/api/data", nil, &data)
	if len(data.Committees) != 1 || len(data.Deposits) != 2 || data.Server["pending"] != true {
		t.Fatalf("data = %+v", data)
	}

	// Backup, then wipe, then restore from the server backup.
	var bk struct{ Name string }
	if code := c.do("POST", "/api/backups", nil, &bk); code != 200 || !backupNameRe.MatchString(bk.Name) {
		t.Fatalf("backup now = %d %q", code, bk.Name)
	}
	var zipBytes []byte
	if code := c.do("GET", "/api/backup", nil, &zipBytes); code != 200 || len(zipBytes) < 100 {
		t.Fatalf("download zip = %d", code)
	}
	if code := c.do("DELETE", "/api/committees/"+com.ID, nil, nil); code != 200 {
		t.Fatalf("delete committee = %d", code)
	}
	if _, err := os.Stat(app.store.shotPath(shot.ID)); !os.IsNotExist(err) {
		t.Fatal("screenshot file should be deleted with its committee")
	}
	c.do("GET", "/api/data", nil, &data)
	if len(data.Committees) != 0 || len(data.Deposits) != 0 {
		t.Fatal("delete did not cascade")
	}
	if code := c.do("POST", "/api/backups/"+bk.Name+"/restore", nil, nil); code != 200 {
		t.Fatalf("restore = %d", code)
	}
	c.do("GET", "/api/data", nil, &data)
	if len(data.Committees) != 1 || len(data.Deposits) != 2 {
		t.Fatalf("after restore = %+v", data)
	}
	if code := c.do("GET", "/api/shots/"+shot.ID, nil, &raw); code != 200 || !bytes.Equal(raw, jpeg) {
		t.Fatal("screenshot not restored")
	}

	// Upload restore of the downloaded zip, plus garbage rejection.
	if code := c.do("POST", "/api/restore", zipBytes, nil); code != 200 {
		t.Fatalf("upload restore = %d", code)
	}
	if code := c.do("POST", "/api/restore", []byte("garbage"), nil); code != 400 {
		t.Fatalf("garbage restore = %d", code)
	}
	if code := c.do("GET", "/api/backups/..%2Fdb.json", nil, nil); code != 404 {
		t.Fatalf("path traversal = %d", code)
	}

	// Data survives a restart.
	app2, err := newApp(app.cfg)
	if err != nil || len(app2.store.data.Deposits) != 2 {
		t.Fatalf("reload: %v", err)
	}

	c.do("POST", "/api/logout", nil, nil)
	if code := c.do("GET", "/api/data", nil, nil); code != 401 {
		t.Fatalf("after logout = %d", code)
	}
}

func TestLoginLockout(t *testing.T) {
	_, c := newTestServer(t)
	for i := 0; i < maxFails; i++ {
		c.do("POST", "/api/login", map[string]string{"password": "wrong"}, nil)
	}
	if code := c.do("POST", "/api/login", map[string]string{"password": "secret123"}, nil); code != 429 {
		t.Fatalf("expected lockout, got %d", code)
	}
}

func TestStaticAndPrune(t *testing.T) {
	app, c := newTestServer(t)
	var body []byte
	if code := c.do("GET", "/", nil, &body); code != 200 || !bytes.Contains(body, []byte("Commetty Book")) {
		t.Fatalf("index = %d", code)
	}
	app.cfg.keep = 2
	for i := 0; i < 4; i++ {
		os.WriteFile(filepath.Join(app.backupDir(), "commetty-2026010"+string(rune('1'+i))+"-020000-auto.zip"), []byte("x"), 0o600)
	}
	app.prune()
	if n := len(app.listBackups()); n != 2 {
		t.Fatalf("prune kept %d", n)
	}
}

func TestTelegramUpload(t *testing.T) {
	var gotChat, gotFile string
	var size int
	tg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/botTOKEN/sendDocument" {
			t.Errorf("path %s", r.URL.Path)
		}
		gotChat = r.FormValue("chat_id")
		f, h, err := r.FormFile("document")
		if err == nil {
			b, _ := io.ReadAll(f)
			gotFile, size = h.Filename, len(b)
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer tg.Close()
	old := telegramAPI
	telegramAPI = tg.URL
	defer func() { telegramAPI = old }()

	app, c := newTestServer(t)
	app.cfg.tgToken, app.cfg.tgChat = "TOKEN", "12345"
	c.do("POST", "/api/login", map[string]string{"password": "secret123"}, nil)
	c.do("POST", "/api/committees", map[string]any{"name": "A", "totalAmount": 1, "startDate": "2026-01-05"}, nil)
	app.dailyBackup()
	if gotChat != "12345" || !backupNameRe.MatchString(gotFile) || size < 50 {
		t.Fatalf("telegram got chat=%q file=%q size=%d", gotChat, gotFile, size)
	}
	gotFile = ""
	app.dailyBackup() // nothing changed → no new backup, nothing sent
	if gotFile != "" || len(app.listBackups()) != 1 {
		t.Fatal("unchanged data should not create another backup")
	}
}
