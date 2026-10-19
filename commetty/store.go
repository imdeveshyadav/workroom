package main

// Storage: the whole ledger is one small JSON file (data/db.json) kept in memory and rewritten
// atomically on every change. Screenshots are separate files in data/shots, so the JSON stays tiny.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var (
	idRe   = regexp.MustCompile(`^[a-f0-9]{16}$`)
	dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

	errNotFound = errors.New("not found")
)

type Committee struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	TotalAmount    float64 `json:"totalAmount"`
	StartDate      string  `json:"startDate"`
	Monthly        float64 `json:"monthly,omitempty"`
	Months         int     `json:"months,omitempty"`
	Organizer      string  `json:"organizer,omitempty"`
	Notes          string  `json:"notes,omitempty"`
	ReceivedAmount float64 `json:"receivedAmount,omitempty"`
	ReceivedDate   string  `json:"receivedDate,omitempty"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

type Deposit struct {
	ID            string   `json:"id"`
	CommitteeID   string   `json:"committeeId"`
	InstallmentNo int      `json:"installmentNo"`
	Amount        float64  `json:"amount"`
	Date          string   `json:"date"`
	Mode          string   `json:"mode,omitempty"`
	TxnID         string   `json:"txnId,omitempty"`
	PaidTo        string   `json:"paidTo,omitempty"`
	Note          string   `json:"note,omitempty"`
	Screenshots   []string `json:"screenshots"`
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
}

type Data struct {
	Committees []*Committee `json:"committees"`
	Deposits   []*Deposit   `json:"deposits"`
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339) }

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > n {
		s = string([]rune(s)[:n])
	}
	return s
}

func validDate(s string) bool {
	if !dateRe.MatchString(s) {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func validAmount(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 && f < 1e12 }

func (c *Committee) clean() error {
	c.Name, c.Organizer, c.Notes = clip(c.Name, 200), clip(c.Organizer, 200), clip(c.Notes, 4000)
	switch {
	case c.Name == "":
		return errors.New("commetty name is required")
	case !validAmount(c.TotalAmount) || !validAmount(c.Monthly) || !validAmount(c.ReceivedAmount):
		return errors.New("invalid amount")
	case !validDate(c.StartDate):
		return errors.New("invalid start date")
	case c.ReceivedDate != "" && !validDate(c.ReceivedDate):
		return errors.New("invalid received date")
	case c.Months < 0 || c.Months > 1000:
		return errors.New("invalid number of installments")
	}
	return nil
}

func (d *Deposit) clean() error {
	d.Mode, d.TxnID, d.PaidTo, d.Note = clip(d.Mode, 50), clip(d.TxnID, 100), clip(d.PaidTo, 200), clip(d.Note, 4000)
	if d.Screenshots == nil {
		d.Screenshots = []string{}
	}
	switch {
	case d.InstallmentNo < 1 || d.InstallmentNo > 1000:
		return errors.New("invalid installment number")
	case !validAmount(d.Amount):
		return errors.New("invalid amount")
	case !validDate(d.Date):
		return errors.New("invalid date")
	case len(d.Screenshots) > 20:
		return errors.New("too many screenshots")
	}
	for _, s := range d.Screenshots {
		if !idRe.MatchString(s) {
			return errors.New("invalid screenshot id")
		}
	}
	return nil
}

// validate checks a whole dataset (used for restores).
func (d *Data) validate() error {
	if d.Committees == nil {
		d.Committees = []*Committee{}
	}
	if d.Deposits == nil {
		d.Deposits = []*Deposit{}
	}
	ids := map[string]bool{}
	for _, c := range d.Committees {
		if c == nil || !idRe.MatchString(c.ID) || ids[c.ID] {
			return errors.New("bad committee id")
		}
		ids[c.ID] = true
		if err := c.clean(); err != nil {
			return fmt.Errorf("commetty %q: %w", c.Name, err)
		}
	}
	for _, dep := range d.Deposits {
		if dep == nil || !idRe.MatchString(dep.ID) || ids[dep.ID] || !ids[dep.CommitteeID] {
			return errors.New("bad deposit id")
		}
		ids[dep.ID] = true
		if err := dep.clean(); err != nil {
			return fmt.Errorf("deposit: %w", err)
		}
	}
	return nil
}

type Store struct {
	mu   sync.RWMutex
	dir  string
	data Data
}

func openStore(dir string) (*Store, error) {
	for _, d := range []string{dir, filepath.Join(dir, "shots"), filepath.Join(dir, "backups")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	s := &Store{dir: dir, data: Data{Committees: []*Committee{}, Deposits: []*Deposit{}}}
	b, err := os.ReadFile(s.dbPath())
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		return nil, fmt.Errorf("db.json is corrupt (restore a backup from %s): %w", filepath.Join(dir, "backups"), err)
	}
	return s, s.data.validate()
}

func (s *Store) dbPath() string            { return filepath.Join(s.dir, "db.json") }
func (s *Store) shotPath(id string) string { return filepath.Join(s.dir, "shots", id) }

// JSON returns the full dataset and the ids of every referenced screenshot.
func (s *Store) JSON() ([]byte, []string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, err := json.Marshal(s.data)
	var shots []string
	for _, d := range s.data.Deposits {
		shots = append(shots, d.Screenshots...)
	}
	return b, shots, err
}

// save writes db.json atomically (temp file + fsync + rename). Caller holds the write lock.
func (s *Store) save() error {
	b, err := json.Marshal(s.data)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.dbPath(), b)
}

func writeFileAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) committee(id string) int {
	for i, c := range s.data.Committees {
		if c.ID == id {
			return i
		}
	}
	return -1
}

func (s *Store) deposit(id string) int {
	for i, d := range s.data.Deposits {
		if d.ID == id {
			return i
		}
	}
	return -1
}

// PutCommittee creates (id == "") or updates a committee.
func (s *Store) PutCommittee(c *Committee) error {
	if err := c.clean(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c.UpdatedAt = nowStamp()
	if c.ID == "" {
		c.ID, c.CreatedAt = newID(), c.UpdatedAt
		s.data.Committees = append(s.data.Committees, c)
	} else {
		i := s.committee(c.ID)
		if i < 0 {
			return errNotFound
		}
		c.CreatedAt = s.data.Committees[i].CreatedAt
		s.data.Committees[i] = c
	}
	return s.save()
}

func (s *Store) DeleteCommittee(id string) error {
	s.mu.Lock()
	i := s.committee(id)
	if i < 0 {
		s.mu.Unlock()
		return errNotFound
	}
	s.data.Committees = append(s.data.Committees[:i], s.data.Committees[i+1:]...)
	var gone []string
	kept := s.data.Deposits[:0]
	for _, d := range s.data.Deposits {
		if d.CommitteeID == id {
			gone = append(gone, d.Screenshots...)
		} else {
			kept = append(kept, d)
		}
	}
	s.data.Deposits = kept
	err := s.save()
	s.mu.Unlock()
	if err == nil {
		s.removeShots(gone)
	}
	return err
}

// PutDeposit creates (id == "") or updates a deposit. Screenshots dropped by an edit are deleted.
func (s *Store) PutDeposit(d *Deposit) error {
	if err := d.clean(); err != nil {
		return err
	}
	for _, id := range d.Screenshots {
		if _, err := os.Stat(s.shotPath(id)); err != nil {
			return errors.New("screenshot not found, please add it again")
		}
	}
	s.mu.Lock()
	if s.committee(d.CommitteeID) < 0 {
		s.mu.Unlock()
		return errors.New("commetty not found")
	}
	var gone []string
	d.UpdatedAt = nowStamp()
	if d.ID == "" {
		d.ID, d.CreatedAt = newID(), d.UpdatedAt
		s.data.Deposits = append(s.data.Deposits, d)
	} else {
		i := s.deposit(d.ID)
		if i < 0 {
			s.mu.Unlock()
			return errNotFound
		}
		old := s.data.Deposits[i]
		d.CreatedAt, d.CommitteeID = old.CreatedAt, old.CommitteeID
		keep := map[string]bool{}
		for _, id := range d.Screenshots {
			keep[id] = true
		}
		for _, id := range old.Screenshots {
			if !keep[id] {
				gone = append(gone, id)
			}
		}
		s.data.Deposits[i] = d
	}
	err := s.save()
	s.mu.Unlock()
	if err == nil {
		s.removeShots(gone)
	}
	return err
}

func (s *Store) DeleteDeposit(id string) error {
	s.mu.Lock()
	i := s.deposit(id)
	if i < 0 {
		s.mu.Unlock()
		return errNotFound
	}
	gone := s.data.Deposits[i].Screenshots
	s.data.Deposits = append(s.data.Deposits[:i], s.data.Deposits[i+1:]...)
	err := s.save()
	s.mu.Unlock()
	if err == nil {
		s.removeShots(gone)
	}
	return err
}

// Replace swaps in a whole (already validated) dataset — used by restore.
func (s *Store) Replace(d Data) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = d
	return s.save()
}

func (s *Store) removeShots(ids []string) {
	for _, id := range ids {
		os.Remove(s.shotPath(id))
	}
}

// gcShots deletes screenshot files no deposit references (e.g. uploaded, then the form was abandoned)
// once they are older than minAge.
func (s *Store) gcShots(minAge time.Duration) {
	s.mu.RLock()
	used := map[string]bool{}
	for _, d := range s.data.Deposits {
		for _, id := range d.Screenshots {
			used[id] = true
		}
	}
	s.mu.RUnlock()
	entries, _ := os.ReadDir(filepath.Join(s.dir, "shots"))
	for _, e := range entries {
		if used[e.Name()] {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) >= minAge {
			os.Remove(filepath.Join(s.dir, "shots", e.Name()))
		}
	}
}
