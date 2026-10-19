# Commetty Book 📒

Ek offline Android-style **PWA** jisme aap apni har commetty (chit fund / BC) ki installments ka record rakh sakte hain.
Sara data **sirf aapke phone** par rehta hai (IndexedDB). Koi server, login ya internet ki zarurat nahi.

## Features

| Kya chahiye tha | App me kahan hai |
|---|---|
| Commetty name, total amount, started date | **+ Commetty** form. Optional: monthly installment, total installments, organizer, notes, "commetty uthayi" (payout amount/date). |
| Add new deposit | Commetty kholo, phir **+ Add deposit**. Installment no., amount aur payment mode pichhle deposit se pehle se bhar jaate hain. |
| See old deposits | **Old deposits** tab: `#1  ₹7,000 \| 5 Jan 2026` |
| Deposit history | **Deposit history** tab: amount, date, installment (1st, 2nd…), paid via (PhonePe / GPay / Paytm / Cash…), Txn/UTR ID, paid to, note, **payment screenshots** (tap karke full screen) |
| Last installment number | `#2 · paid on 5 Feb 2026 · ₹6,700` |
| Next installment | `#3 · due 5 Mar 2026` + "Due in 5 days" / "3 days overdue" badge. Due date = start date + (n-1) months. |
| Share summary | Commetty screen ka share button text summary WhatsApp par bhejta hai. |
| Excel | Backup screen par **CSV export** milta hai (Excel / Google Sheets me khulta hai). |

## Data loss se bachav (backup & restore)

* **One-tap backup:** Har deposit save karne ke baad **"Backup bhejo"** button aata hai. Wo Android ka share sheet kholta hai, jahan se WhatsApp ("Message yourself" / family group), Google Drive, Gmail, kuch bhi choose kar sakte hain.
  Ek hi file (`CommettyBackup_2026-10-19_1930.txt`) me saari commetty, deposits **aur screenshots** hote hain.
  (Chrome JSON files share nahi karne deta, isliye file `.txt` hai. Andar JSON hi hai.)
* **Reminder:** Agar backup ke baad changes hue hain, to home screen par "N changes ka backup baaki hai, **Backup now**" dikhta hai (har 1/3/7/15/30 din, ya 5+ changes par).
* **Auto-save option:** Settings me "Har change par backup file Downloads me save karo" on kar sakte hain.
* **One-tap restore:** Backup & restore, phir **Backup file choose karo**, phir **Replace** (ya **Merge**). Galti se restore ho jaye to **Undo last restore** button bhi hai.
* App browser se **persistent storage** maangta hai, taaki phone ka space kam hone par browser data delete na kare.

> Browser bina aapke tap kiye WhatsApp par file nahi bhej sakta (security rule). Isliye backup "one tap" hai, poori tarah automatic nahi.

## Phone par kaise chalayein

PWA ko secure origin chahiye: `https://…` ya `http://localhost`. Dono me se koi ek tareeka chunein.

### Option A: Phone par hi localhost (Termux)

1. Play Store / F-Droid se **Termux** install karein.
2. Termux me:
   ```sh
   pkg install git python
   git clone https://github.com/imdeveshyadav/workroom
   cd workroom/commetty
   python -m http.server 8080
   ```
3. Chrome me `http://localhost:8080` kholein, phir menu (⋮), phir **Add to Home screen / Install app**.
4. Ab app Home screen se khulega aur **server band hone par bhi offline chalega** (service worker cache).
   Data `localhost:8080` origin se juda hai, isliye update ke liye hamesha **same port 8080** use karein.

### Option B: GitHub Pages (sabse aasaan)

Repo Settings, phir **Pages**, phir branch choose karein. URL `https://<user>.github.io/workroom/commetty/` Chrome me kholkar Install karein.
Sirf app ki files internet se aati hain. **Aapka data phir bhi sirf phone me rehta hai.**

## Files

```
commetty/
  index.html            app shell
  app.js                screens, calculations, backup/restore
  db.js                 IndexedDB wrapper (committees, deposits, meta)
  styles.css            UI (light + dark mode)
  sw.js                 offline cache. Files badlo to CACHE version badhao
  manifest.webmanifest  install info
  icons/                app icons (node tools/make-icons.js se bante hain)
```

Backup format: `{ app: "commetty-book", version: 1, exportedAt, committees: [...], deposits: [...] }`, with screenshots stored as JPEG data URLs.
