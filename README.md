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
  js/gallery.js         gallery images on Cloudinary (upload queue, caching, self-healing)
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
   2. **Token name:** anything you'll recognize later (it's just a label; the app doesn't use it). **Expiration:** your choice. When it expires, sync shows a warning and you paste a new token.
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

## Gallery images (Cloudinary)

Each entry can have a gallery. Gallery images are stored on [Cloudinary](https://cloudinary.com)'s free plan, so the sync repo stays small and isn't slowed by GitHub's upload limits. Entries, covers and gallery *records* still sync through GitHub as before.

### One-time setup

1. **Create a free Cloudinary account.** Don't add a credit card. That way, going over the free allowance can only pause images, never cost money.
2. **Copy your cloud name** from the Cloudinary dashboard.
3. **Create an upload preset:** *Settings (gear) → Product environment settings → Upload → Add upload preset*.
   - **Name:** keep the random name Cloudinary generates (or make up your own random one). The preset name is what lets the app upload, so it should be unguessable; avoid names like `medialog` (see *Security* below).
   - **Signing mode:** *Unsigned*. This lets the app upload directly, without a secret key.
   - **Folder:** `medialog` (optional, keeps things tidy).
   - **Overwrite:** off, so nobody can replace existing images through the preset.
   - **Allowed formats:** `jpg, png, webp`.
   - **Incoming transformation:** `c_limit,w_2048,h_2048`, so anything larger is shrunk before it's stored. The app already resizes to this size, so it doesn't affect your uploads.
   - Save, and copy the preset's **name**.
4. **Recommended: turn on strict transformations** (*Settings → Product environment settings → Security*), then allow the one image size the app requests: `c_fill,g_center,w_320,h_320,q_80,f_jpg` (the gallery thumbnail). This stops anyone with an image link from generating endless image sizes on your account. If the thumbnail isn't allowed, the app still works: it makes thumbnails itself from the full image, using a bit more traffic.
5. **In Medialog:** *Settings → Gallery*, enter the cloud name and preset name, then **Save**. Do this on each device you want to *add* images from. Viewing works on every synced device without it.

### How it behaves
- **Adding images:** open an entry → **＋ Add images** (you can pick several). Images are resized to at most 2048px and saved on the device immediately, then uploaded. Offline, they wait and upload automatically when you're back online.
- **Other devices** download a small thumbnail when you open the gallery and the full image when you tap it. Both are then kept on the device, so viewing again uses no traffic and works offline.
- **Viewer:** tap an image to open it full screen; use the arrows, arrow keys or swipe to move between images.
- **Deleting** an image removes it from the gallery on every device. The file itself stays in your Cloudinary *Media Library* (folder `medialog`) until you delete it there. (If your preset returns a "delete token", Cloudinary also lets the app delete it automatically within 10 minutes of uploading; without one, the app just skips that step.)
- **Leaked link?** Delete that image in Cloudinary's Media Library. The next device that can't find it flags it, and a device that still has the file re-uploads it under a new link. Your gallery heals itself and the old link stays dead.
- **Privacy:** gallery images are public to anyone who has an image's exact link (links are long and random). Keep anything personal out of the gallery.

### Security
- The app needs only the **cloud name** and an **unsigned upload preset**. Never enter your Cloudinary **API key or API secret** anywhere in the app.
- The cloud name is not secret (it's part of every image link). The **preset name** is the only thing that allows uploading, which is why it should be random. It's stored only in your devices' browsers, never in the app's public code or the sync repo.
- Someone who learned both names could only **upload** files to your account. They couldn't view a list of your images, change or delete them, or touch account settings. With no credit card on the account, the worst case is the free quota filling up and uploads pausing.
- **If you suspect misuse:** delete the preset in Cloudinary, create a new one with a new random name, and enter it in *Settings → Gallery* on your devices. Existing images keep working.
- **Backups:** Export JSON includes the gallery's links, not the images themselves (those live on Cloudinary).

## Backups
Every change is saved to IndexedDB immediately. Backups protect you if the browser's data gets wiped.

- **Auto-backup** (Settings → Auto-backup, Chrome/Edge desktop): pick a file once, ideally in a synced folder like OneDrive. Medialog rewrites it about 2 seconds after your last change, and right away when you close or hide the app. Several quick changes become one write.
  - Browsers usually ask for file permission again in each new session. When that happens, a **⚠ Backup** button appears in the header, and one click resumes.
  - Automatic writes never replace the file with an *empty* database, so "Delete all data" stays recoverable.
- **Manual**: Settings → Export JSON / Import (merge or replace). This works in every browser. The file includes your uploaded images (as base64), so one file restores everything. Importing a backup also brings back items you had deleted.
- Settings also has a button that asks the browser to keep your data permanently.

## Notes
- Covers given as remote URLs need internet to display. Uploaded covers are stored locally and resized (600px; 1280px for landscape).
- **Releasing a new version:** after changing app files, bump `VERSION` (and set `RELEASED` to today) at the top of `public/sw.js`, then push. Use the next whole number for a new feature or behavior change (`'23.4'` → `'24'`), and add `.1` for a small UI adjustment (`'23'` → `'23.1'` → … → `'23.10'`). The version shows in *Settings → App*. Open copies download the update in the background (on launch, when you switch back to the app, or via *Check for updates*), then show a **"A new version is ready"** bar with a Reload button.
