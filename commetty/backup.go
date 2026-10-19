package main

// Backups: a backup is one .zip with db.json + every screenshot. The server takes one every night
// (only if something changed), keeps the newest BACKUP_KEEP in data/backups, and can also send it to
// a Telegram chat so a copy lives off the server.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	backupNameRe = regexp.MustCompile(`^commetty-[0-9]{8}-[0-9]{6}-[a-z]+\.zip$`)
	telegramAPI  = "https://api.telegram.org"
)

type backupInfo struct {
	Name string    `json:"name"`
	Size int64     `json:"size"`
	Time time.Time `json:"time"`
}

func (a *App) backupDir() string { return filepath.Join(a.store.dir, "backups") }

// writeZip streams a full backup; screenshots are already JPEG so they are stored, not deflated.
func (a *App) writeZip(w io.Writer) error {
	db, shots, err := a.store.JSON()
	if err != nil {
		return err
	}
	zw := zip.NewWriter(w)
	now := time.Now()
	f, err := zw.CreateHeader(&zip.FileHeader{Name: "db.json", Method: zip.Deflate, Modified: now})
	if err != nil {
		return err
	}
	if _, err := f.Write(db); err != nil {
		return err
	}
	for _, id := range shots {
		src, err := os.Open(a.store.shotPath(id))
		if err != nil {
			continue // deleted meanwhile
		}
		f, err := zw.CreateHeader(&zip.FileHeader{Name: "shots/" + id, Method: zip.Store, Modified: now})
		if err == nil {
			_, err = io.Copy(f, src)
		}
		src.Close()
		if err != nil {
			return err
		}
	}
	return zw.Close()
}

// snapshot writes a backup into data/backups and prunes old ones. kind: auto, manual, prerestore.
func (a *App) snapshot(kind string) (string, error) {
	name := fmt.Sprintf("commetty-%s-%s.zip", time.Now().In(a.cfg.loc).Format("20060102-150405"), kind)
	path := filepath.Join(a.backupDir(), name)
	f, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	if err = a.writeZip(f); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(path+".tmp", path)
	}
	if err != nil {
		os.Remove(path + ".tmp")
		return "", err
	}
	a.prune()
	return name, nil
}

func (a *App) listBackups() []backupInfo {
	entries, _ := os.ReadDir(a.backupDir())
	out := []backupInfo{}
	for _, e := range entries {
		if !backupNameRe.MatchString(e.Name()) {
			continue
		}
		if info, err := e.Info(); err == nil {
			out = append(out, backupInfo{e.Name(), info.Size(), info.ModTime()})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	return out
}

func (a *App) prune() {
	for i, b := range a.listBackups() {
		if i >= a.cfg.keep {
			os.Remove(filepath.Join(a.backupDir(), b.Name))
		}
	}
}

// changedSinceBackup reports whether db.json is newer than the newest backup.
func (a *App) changedSinceBackup() bool {
	db, err := os.Stat(a.store.dbPath())
	if err != nil {
		return false
	}
	list := a.listBackups()
	return len(list) == 0 || db.ModTime().After(list[0].Time)
}

func (a *App) dailyBackup() {
	a.store.gcShots(24 * time.Hour)
	if !a.changedSinceBackup() {
		return
	}
	name, err := a.snapshot("auto")
	if err != nil {
		log.Printf("backup failed: %v", err)
		return
	}
	log.Printf("backup saved: %s", name)
	if a.cfg.tgToken != "" {
		if err := a.sendTelegram(name); err != nil {
			log.Printf("telegram upload failed: %v", err)
		}
	}
}

func (a *App) backupLoop() {
	// Catch up if the server was down at backup time.
	if list := a.listBackups(); len(list) == 0 || time.Since(list[0].Time) > 24*time.Hour {
		a.dailyBackup()
	}
	for {
		now := time.Now().In(a.cfg.loc)
		next := time.Date(now.Year(), now.Month(), now.Day(), a.cfg.backupHour, 0, 0, 0, a.cfg.loc)
		if !next.After(now) {
			next = next.AddDate(0, 0, 1)
		}
		time.Sleep(time.Until(next))
		a.dailyBackup()
	}
}

// sendTelegram uploads a backup file to the configured chat via the Bot API (streamed, no buffering).
func (a *App) sendTelegram(name string) error {
	f, err := os.Open(filepath.Join(a.backupDir(), name))
	if err != nil {
		return err
	}
	defer f.Close()
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		mw.WriteField("chat_id", a.cfg.tgChat)
		mw.WriteField("caption", "Commetty Book backup · "+time.Now().In(a.cfg.loc).Format("2 Jan 2006 3:04 PM"))
		part, err := mw.CreateFormFile("document", name)
		if err == nil {
			_, err = io.Copy(part, f)
		}
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()
	client := &http.Client{Timeout: 5 * time.Minute}
	res, err := client.Post(telegramAPI+"/bot"+a.cfg.tgToken+"/sendDocument", mw.FormDataContentType(), pr)
	if err != nil {
		return errors.New(strings.ReplaceAll(err.Error(), a.cfg.tgToken, "***"))
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("telegram: %s %s", res.Status, body)
	}
	return nil
}

// restoreZip validates a backup file, saves a "prerestore" backup of the current data, then
// replaces everything with the backup's contents.
func (a *App) restoreZip(path string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return errors.New("not a valid backup .zip file")
	}
	defer zr.Close()

	var data Data
	files := map[string]*zip.File{}
	found := false
	for _, f := range zr.File {
		switch {
		case f.Name == "db.json":
			if f.UncompressedSize64 > 50<<20 {
				return errors.New("db.json too large")
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			err = json.NewDecoder(io.LimitReader(rc, 50<<20)).Decode(&data)
			rc.Close()
			if err != nil {
				return errors.New("backup db.json is corrupt")
			}
			found = true
		case strings.HasPrefix(f.Name, "shots/") && idRe.MatchString(strings.TrimPrefix(f.Name, "shots/")):
			files[strings.TrimPrefix(f.Name, "shots/")] = f
		}
	}
	if !found {
		return errors.New("backup has no db.json — is this a Commetty Book backup?")
	}
	if err := data.validate(); err != nil {
		return err
	}

	// Extract screenshots first (ids are random, so existing files are identical and can stay).
	for _, d := range data.Deposits {
		for _, id := range d.Screenshots {
			if _, err := os.Stat(a.store.shotPath(id)); err == nil {
				continue
			}
			f := files[id]
			if f == nil {
				return fmt.Errorf("backup is missing screenshot %s", id)
			}
			if err := extract(f, a.store.shotPath(id)); err != nil {
				return err
			}
		}
	}
	if _, err := a.snapshot("prerestore"); err != nil {
		return fmt.Errorf("could not save current data before restore: %w", err)
	}
	if err := a.store.Replace(data); err != nil {
		return err
	}
	a.store.gcShots(time.Hour)
	return nil
}

func extract(f *zip.File, dst string) error {
	if f.UncompressedSize64 > maxShotBytes {
		return errors.New("screenshot in backup too large")
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, io.LimitReader(rc, maxShotBytes+1)); err != nil {
		return err
	}
	if buf.Len() > maxShotBytes {
		return errors.New("screenshot in backup too large")
	}
	return writeFileAtomic(dst, buf.Bytes())
}
