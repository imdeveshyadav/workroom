# Commetty Book 📒

Commetty (chit fund / BC) ki har installment ka record rakhne wala **PWA**. Ye aapke apne server/domain par chalta hai aur phone par app ki tarah install hota hai.

* **Bahut halka:** ek ~7.5 MB Go binary hai, aur iske alawa koi dependency, database server ya Node nahi chahiye. **RAM ~13 MB idle, ~15 MB use ke time** (measured).
* Data ek chhoti JSON file (`data/db.json`) mein rehta hai, aur screenshots `data/shots/` mein. Har save atomic hota hai (temp file, fsync, rename).
* **Roz automatic backup** hota hai, aur optionally **Telegram** par bhi jata hai, taaki ek copy server ke bahar rahe.

## Features

| | |
|---|---|
| Commetty | Name, total amount, started date. Optional: monthly installment, total installments, organizer, notes, aur "commetty uthayi" (payout). |
| Add deposit | Installment no., amount, date, paid via (PhonePe / GPay / Paytm / Cash…), Txn/UTR, paid to, note, **payment screenshots**. Screenshot phone par hi chhota (JPEG, max 1600px) karke upload hota hai. |
| Old deposits | `#1  ₹7,000 \| 5 Jan 2026` |
| Deposit history | Har deposit ki poori detail aur screenshots. Tap karne par full screen khulta hai. |
| Last / next installment | `#2 · paid on 5 Feb 2026` aur `#3 · due 5 Mar 2026`, saath mein "Due in 5 days" / "3 days overdue" badge. Due date = start date + (n‑1) months. |
| Offline | Internet na ho tab bhi app khulta hai aur aakhri data dikhata hai (read-only). |
| Extra | WhatsApp par summary share karna, aur Excel ke liye CSV export. |

## Backups (data loss se bachav)

1. **Roz raat `BACKUP_HOUR` (default 2 baje IST)** server ek `.zip` banata hai, jisme poora data aur saare screenshots hote hain. Ye sirf tab hota hai jab kuch badla ho. Aakhri `BACKUP_KEEP` (default 30) backups `data/backups/` mein rehte hain.
2. **Telegram (recommended):** har backup apne aap aapke Telegram chat mein pahunch jata hai. Ye free hai, aur server kharab ho jaye tab bhi copy bachi rehti hai.
3. **App mein Backup screen:** wahan "Abhi backup lo", kisi bhi purane backup ka **one-tap Restore**, phone mein `.zip` download, aur `.zip` file se restore milta hai.
4. Har restore se pehle current data ka "Restore se pehle" backup apne aap banta hai, isliye galat restore bhi undo ho sakta hai.

### Telegram setup (2 minute)
1. Telegram mein **@BotFather** kholein, `/newbot` bhejein, aur jo **token** mile use copy kar lein.
2. Apne naye bot ko koi bhi message bhejein (jaise "hi").
3. Browser mein `https://api.telegram.org/bot<TOKEN>/getUpdates` kholein. Wahan `"chat":{"id":123456789` mein jo number hai, wahi **chat id** hai.
4. Server env mein `TELEGRAM_BOT_TOKEN` aur `TELEGRAM_CHAT_ID` set karke restart karein. App mein "Abhi backup lo + Telegram" dabakar check kar lein.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `APP_PASSWORD` | **required** | App ka login password. Ise badalne par sab devices logout ho jate hain. |
| `PORT` / `ADDR` | `8080` / `:8080` | Listen address |
| `DATA_DIR` | `data` | Data, screenshots, backups |
| `TZ` | `Asia/Kolkata` | Backup time ka timezone |
| `BACKUP_HOUR` | `2` | Roz ka backup kis ghante mein ho (0–23) |
| `BACKUP_KEEP` | `30` | Kitne backups rakhne hain |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | Daily backup Telegram par |
| `TRUST_PROXY` | — | `1` jab app Caddy/Nginx ke peeche ho (sahi client IP aur https detect karne ke liye) |
| `TLS_CERT`, `TLS_KEY` | — | Bina proxy ke direct HTTPS |
| `GOMEMLIMIT` | `24MiB` | Go heap ki soft limit |

## Domain par deploy

PWA install ke liye **HTTPS zaroori hai**.

### A) VPS + systemd + Caddy (sabse halka)
```sh
# build (kisi bhi machine par Go 1.22+ ke saath); Linux ARM server ke liye GOARCH=arm64 lagayein
cd commetty && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o commetty .
scp commetty deploy/commetty.service deploy/commetty.env.example you@server:

# server par
sudo useradd --system --home /var/lib/commetty --create-home commetty
sudo install -m755 commetty /usr/local/bin/
sudo install -m600 commetty.env.example /etc/commetty.env   # password set karein
sudo cp commetty.service /etc/systemd/system/ && sudo systemctl enable --now commetty
```
HTTPS ke liye Caddy install karein aur `deploy/Caddyfile` mein apna domain daal dein. Caddy certificate apne aap le lega.

### B) Docker
```sh
cd commetty
docker build -t commetty .            # ~8 MB image
docker run -d --name commetty --restart=always -p 8080:8080 \
  -e APP_PASSWORD='long-password' -e TRUST_PROXY=1 \
  -v commetty-data:/data --memory=64m commetty
```

### Phone par install
Chrome mein `https://aapka-domain` kholein, password se login karein, phir menu (⋮) mein **Install app / Add to Home screen** dabayein.

## Development
```sh
cd commetty
APP_PASSWORD=secret123 go run .      # http://localhost:8080
go test ./...
node tools/make-icons.js             # icons dobara banane ke liye
```

`web/` ki files binary ke andar embed hoti hain. Inhe badalne ke baad `web/sw.js` mein `VERSION` badhayein, taaki phones naya version le lein.

## Security
* **Login:** ek password, jo HMAC-signed `HttpOnly`, `SameSite=Strict` cookie banata hai (180 din chalti hai). 5 galat try ke baad wo IP 15 minute ke liye lock ho jata hai.
* **Requests:** har write request par custom header check hota hai (CSRF guard). Strict CSP hai. Upload sirf images ka (max 8 MB) hota hai, aur file names random ids hote hain.
* **Files:** data directory `0700` permission ke saath hai. systemd unit sandboxed hai aur memory 64 MB tak capped hai.

## Files
```
commetty/
  main.go      HTTP server, routes, static files (pre-gzipped, embedded)
  store.go     JSON store + screenshots
  auth.go      password login, signed session cookie, lockout
  backup.go    zip backups, nightly job, Telegram upload, restore
  web/         PWA (index.html, app.js, styles.css, sw.js, manifest, icons)
  deploy/      systemd unit, env example, Caddyfile
  Dockerfile
```
