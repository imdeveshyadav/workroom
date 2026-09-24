# Workroom

A mobile-first **PWA for work-group messaging** where every member of a workroom sees every message and photo, photos are kept at **full resolution**, every message carries a **unique ID**, and anyone can **export the chat in one tap**.

## Features

| Requirement | How it works |
|---|---|
| Group chat (more than 2 people) | Create a workroom, share the 6-character code or invite link. Anyone who joins sees all messages and photos live. |
| Full-resolution photos | The original file is uploaded byte-for-byte (no compression). The phone also sends a small preview so the chat scrolls quickly. Tapping a photo opens the original, and you can download it. |
| Take a photo with the camera | 📷 button in the composer opens the rear camera directly (`capture="environment"`). **+ → Upload photo** picks from the gallery. |
| Describe the photo you're sending | Type in the message box while a photo is attached. The text becomes the caption. |
| Describe any earlier photo | **+ → Describe an earlier photo** (or open a photo → **Describe this photo**). The message shows a linked preview of that photo and its ID. The photo viewer lists every description of that photo. |
| Text-only messages | Just type and send. |
| Unique IDs | Photo messages get `IMG-0001`, `IMG-0002`, … and text messages get `MSG-0001`, … (numbered per workroom). **A photo and its caption are one message and share one ID.** The ID shows on the bubble and on the photo itself. |
| One-tap export | ⬇ button → **Last 2 / 5 / 10 / 20 / 30 min, 1 / 6 / 12 hours, or Entire chat**. Downloads a single `.html` file. |
| Export looks exactly like the chat | The server renders the export with the **same renderer (`public/render.js`) and the same stylesheet** as the app, from the exporter's point of view and in their time zone. Full-resolution photos are embedded, so the file works offline. Tap a photo to view it, or print/save as PDF. |
| PWA | Installable (manifest + service worker), works full-screen, handles safe areas and supports dark mode. |

## Run it

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there is no native build step).

```bash
npm install
npm start              # http://localhost:3000
npm test               # API tests
```

Or with Docker:

```bash
docker build -t workroom .
docker run -p 3000:3000 -v workroom-data:/data workroom
```

### Deploy on Render

The repo includes a `render.yaml` Blueprint.

1. On Render, go to **New → Blueprint** and pick this repo.
2. Click **Apply**. This creates a Node web service on the Starter plan, with a 10 GB persistent disk at `/var/data` that holds the database and original photos.
3. Open the `https://workroom-xxxx.onrender.com` URL on your phone and choose **Add to Home Screen** (or **Install app**).

The disk is needed because Render's free plan wipes local files whenever the service restarts or redeploys, so all messages and photos would be lost. The disk also means the service runs as a single instance, which is what the live updates expect.

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | SQLite database + `uploads/` (original photos) |
| `MAX_UPLOAD_MB` | `50` | Max size per photo |

> Phones only allow installing the PWA (and some camera features) over **HTTPS**. Deploy behind a TLS proxy (Caddy, Nginx, Cloudflare, Render, Railway, Fly.io…). The live updates use Server-Sent Events, so disable response buffering on the proxy for `/api/rooms/*/stream`.

## How it's built

```
server.js            Express API, SQLite storage, uploads, live updates (SSE), export
public/render.js     Message renderer shared by the browser and the export
public/styles.css    Shared by the app and exported files
public/app.js        Client: rooms, composer, camera/gallery, describe, lightbox, export
public/sw.js         Service worker (app-shell cache)
scripts/make-icons.js  Regenerates the PNG app icons
```

### API

| Method | Path | |
|---|---|---|
| POST | `/api/rooms` | `{name, userId, userName}`: create a workroom |
| POST | `/api/rooms/:code/join` | `{userId, userName}` |
| GET | `/api/rooms/:code/messages?userId=&after=|before=&limit=` | |
| POST | `/api/rooms/:code/messages` | multipart: `userId`, `text`, `image` (original), `preview` (optional), `refUid` (describe an earlier photo) |
| GET | `/api/rooms/:code/images?userId=` | All photos (for the picker) |
| GET | `/api/rooms/:code/images/:uid?userId=` | A photo and all of its descriptions |
| GET | `/api/rooms/:code/stream?userId=` | Live events (`message`, `members`) |
| GET | `/api/rooms/:code/export?userId=&minutes=2|5|10|20|30|60|360|720|all&tz=&locale=` | HTML export |

## Notes and next steps

* Identity is lightweight: a name plus a random device ID kept on the phone. Anyone with the room code can join. For wider use, add a login (OTP, SSO) and room admins.
* Photo files are served by unguessable URLs. Put them behind auth if the photos are sensitive.
