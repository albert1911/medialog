# Medialog

An offline-first PWA for tracking any media (anime, manga, shows, movies, books, games, podcasts…), in the spirit of AniList. There is no backend: all data lives in your browser's **IndexedDB** on your device.

## Run it

```bash
npm start            # http://127.0.0.1:8080
PORT=3000 npm start  # custom port
```

It needs only Node (no `npm install`). Open the URL, then use **Install** in the header or your browser's "Install app" menu to get a standalone app that works offline.

`public/` is a plain static site, so you can also host it on any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages…). Even then, data stays in each device's own browser.

## Data model

The two stores mirror the original Laravel migrations:

| `media_sources` | |
|---|---|
| `id` | auto-increment key |
| `title` | string(100), required |
| `category` | string(50), required |
| `description` | string(255), nullable |
| `link` | string(255), nullable |
| `created_at`, `updated_at` | ISO timestamps |

| `media_entries` | |
|---|---|
| `id` | auto-increment key |
| `title` | string(100), required |
| `type` | string(50), required (free text, with suggestions) |
| `cover_image` | URL/path **or** an uploaded image stored as a data URL |
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
  js/app.js             hash router
  js/views/*.js         library, entry, sources, settings screens
```

## Backups
Every change is saved to IndexedDB immediately. Backups protect you if the browser's data gets wiped.

- **Auto-backup** (Settings → Auto-backup, Chrome/Edge desktop): pick a file once, ideally in a synced folder like OneDrive. Medialog rewrites it about 2 seconds after your last change, and right away when you close or hide the app. Several quick changes become one write.
  - Browsers usually ask for file permission again in each new session. When that happens, a **⚠ Backup** button appears in the header, and one click resumes.
  - Automatic writes never replace the file with an *empty* database, so "Delete all data" stays recoverable.
- **Manual**: Settings → Export JSON / Import (merge or replace). This works in every browser.
- Settings also has a button that asks the browser to keep your data permanently.

## Notes
- Covers given as remote URLs need internet to display. Uploaded covers are stored locally and resized to at most 600px.
- After changing app files, bump `VERSION` in `public/sw.js`. Installed copies update on the next launch.
