# Medialog

An offline-first PWA for tracking any media (anime, manga, shows, movies, books, games, podcasts…), in the spirit of AniList. There is no backend: data lives in your browser's **IndexedDB** on each device, and can optionally [sync between devices](#sync-between-devices) through a private GitHub repository.

## Run it

```bash
npm start            # http://127.0.0.1:8080
PORT=3000 npm start  # custom port
```

It needs only Node (no `npm install`). Open the URL, then use **Install** in the header or your browser's "Install app" menu to get a standalone app that works offline.

`public/` is a plain static site, so you can also host it on any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages…). Even then, data stays in each device's own browser unless you turn on sync.

## Data model

The two stores mirror the original Laravel migrations:

| `media_sources` | |
|---|---|
| `id` | random UUID string (unique across devices) |
| `title` | string(100), required |
| `category` | string(50), required |
| `description` | string(255), nullable |
| `link` | string(255), nullable |
| `created_at`, `updated_at` | ISO timestamps |

| `media_entries` | |
|---|---|
| `id` | random UUID string (unique across devices) |
| `title` | string(100), required |
| `type` | string(50), required (free text, with suggestions) |
| `cover_image` | a web URL, **or** `cover:<sha256>.<ext>` pointing to an uploaded image in the `covers` store |
| `cover_aspect` | cover width ÷ height, measured on save. Picks the layout: portrait (< 0.85) fills the card; square and landscape are shown whole over a blurred copy; landscape (≥ 1.3) becomes a banner on the entry page |
| `description` | string(255), nullable |
| `release_date` | `YYYY-MM-DD`, nullable |
| `chapter_count` | unsigned int, default 1 (`0` = unknown / ongoing) |
| `content` | raw HTML, nullable (rendered in a sandboxed iframe, so scripts never run) |
| `media_source_id` | → `media_sources.id`, **set null on delete** |
| `status` | `current`, `planning`, `completed`, `repeating`, `paused`, `dropped` |
| `progress` | unsigned int (capped at `chapter_count`) |
| `score` | 0–10, nullable |
| `started_at`, `completed_at` | dates, nullable |
| `created_at`, `updated_at` | ISO timestamps |

The tracking fields (`status` → `completed_at`) are new. They are what turns the catalogue into a tracker.

Uploaded images live in a third store, `covers` (`id` = `<sha256>.<ext>`, `blob` = the image file), like files on a disk with entries holding the path. The id is a fingerprint of the image, so the same image is stored once. Covers load lazily (only those scrolled into view), and images no entry uses anymore are cleaned up automatically.

A deleted record is kept as a small tombstone (`id`, `created_at`, `updated_at`, `deleted_at`) so the deletion reaches your other devices. Tombstones are hidden everywhere in the app and left out of exports.

### Tracking rules (AniList-style)
- Raising progress on a *Planning* entry moves it to *In Progress*.
- Reaching the last chapter or episode marks the entry *Completed*.
- Setting status to *Completed* fills progress to the max.
- Switching *Completed* → *Revisiting* resets progress to 0.
- When updating, start and completion dates fill in automatically if they're empty.

## Project layout

```
server.js               zero-dependency static server
public/
  index.html, manifest.webmanifest, sw.js (offline cache)
  css/app.css
  js/db.js              IndexedDB layer: validation, CRUD, import/export
  js/sync.js            sync through a private GitHub repo
  js/autobackup.js      auto-backup to a local file
  js/app.js             hash router
  js/views/*.js         library, entry, sources, settings screens
```

## Sync between devices

Medialog can keep your laptop and phone in sync through a file in a **private** GitHub repository. Each device still works offline; it syncs when you open the app, a few seconds after each change, and every few minutes while open.

### One-time setup

1. **Create the data repository.** On GitHub, click **New repository**, name it e.g. `medialog-data`, choose **Private**, tick **Add a README file**, and create it. Keep it separate from the app's repo: the app repo is public, the data repo must be private.
2. **Create an access token** that can only touch that repository:
   1. Open GitHub → your avatar → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** (direct link: https://github.com/settings/personal-access-tokens/new).
   2. **Token name:** `Medialog sync`. **Expiration:** your choice. When it expires, sync shows a warning and you paste a new token.
   3. **Repository access:** *Only select repositories* → pick `medialog-data`.
   4. **Permissions → Repository permissions → Contents:** *Read and write*. (*Metadata: Read-only* is added automatically.) Leave everything else at *No access*.
   5. Click **Generate token** and copy it (it starts with `github_pat_`). GitHub shows it only once, so keep it somewhere safe (e.g. a password manager) to paste on your other devices.
3. **Connect each device.** In Medialog: **Settings → Sync**, enter the repository (`your-username/medialog-data`) and the token, then **Connect & sync**. Start with the device that already has your data; on the next device, the two libraries are merged.

### How it behaves
- If you change *different* entries on two devices, both changes are kept. If you change the *same* entry on both, the most recent change wins.
- Deleting something deletes it on every device.
- Uploaded cover images are stored once each in `covers/` in the data repo, with the same names as on the device, so the main file (`medialog.json`) stays small. Uploading many covers for the first time takes a while (about one per second, to stay within GitHub's limits); downloading them on another device runs 4 at a time.
- Every sync that changes something is a commit in the data repo, so the history doubles as a backup you can roll back to.
- The token is stored only in that device's browser. If a device is lost, delete the token on GitHub; your other devices keep working after you give them a new one.
- A **⚠ Sync** button appears in the header when something needs attention, such as an expired token.
- If you already copied data between devices with Export/Import before turning on sync, the copies are different records and would show up twice. Keep the data on one device, and on the other use **Delete all data** *before* connecting it.

## Backups
Every change is saved to IndexedDB immediately. Backups protect you if the browser's data gets wiped.

- **Auto-backup** (Settings → Auto-backup, Chrome/Edge desktop): pick a file once, ideally in a synced folder like OneDrive. Medialog rewrites it about 2 seconds after your last change, and right away when you close or hide the app. Several quick changes become one write.
  - Browsers usually ask for file permission again in each new session. When that happens, a **⚠ Backup** button appears in the header, and one click resumes.
  - Automatic writes never replace the file with an *empty* database, so "Delete all data" stays recoverable.
- **Manual**: Settings → Export JSON / Import (merge or replace). This works in every browser. The file includes your uploaded images (as base64), so one file restores everything. Importing a backup also brings back items you had deleted.
- Settings also has a button that asks the browser to keep your data permanently.

## Notes
- Covers given as remote URLs need internet to display. Uploaded covers are stored locally and resized (600px; 1280px for landscape).
- After changing app files, bump `VERSION` in `public/sw.js`. Installed copies update on the next launch.
