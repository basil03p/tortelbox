# TorBox Telegram Bot

A lightweight, standalone Node.js service for controlling TorBox from Telegram. Supports Torrents, Usenet, WebDL / Debrid hosters, RSS feeds, search, and automated ready-state notifications.

---

## Capabilities

* **Torrents**: List, add via magnet/file, pause, resume, delete, check infohash cache state (`/checkcached`), or force cached-only additions (`/addcached`).
* **Usenet & WebDL / Debrid**: Full lifecycle management for NZB files and direct debrid hoster links (1Fichier, Rapidgator, DDownload, Mega, Google Drive, etc.).
* **Smart Auto-Detection**: Send magnet links, `.torrent` / `.nzb` files, or raw infohashes directly to the bot.
* **Link Privacy**: Download links are generated on-demand and delivered via private direct message only. Links are time-limited by TorBox CDN and can be regenerated at any time with `/getlink` or `/mydownloads`.
* **Background Monitoring**: Polls TorBox in the background and sends a notification as soon as a download finishes.
* **Plan Awareness**: Auto-detects user plan (Free, Essential, Pro, Ultimate) and enforces feature boundaries locally.
* **Access Control**: Restrict bot usage to designated Telegram user IDs (`ALLOWED_USERS`), managed via environment configuration or admin commands (`/adduser`, `/removeuser`).
* **Web Admin Panel**: Password-protected web dashboard (`http://localhost:3001/admin`) for monitoring system stats and managing access permissions.

---

## Quick Start

### 1. Installation

```bash
cd tgbot
npm install
```

### 2. Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TORBOX_API_KEY=your_torbox_api_key

# Admin user ID (Telegram ID)
BOT_ADMIN_ID=your_telegram_id

# Web Admin Panel login credentials
ADMIN_WEB_USERNAME=admin
ADMIN_WEB_PASSWORD=your_admin_password

# Whitelist Telegram IDs (comma-separated; leave empty for public access)
ALLOWED_USERS=123456789,987654321
```

### 3. Execution

```bash
npm start
```

For local development with auto-reload:

```bash
npm run dev
```

---

## Command Reference

| Command | Arguments | Description |
|---|---|---|
| `/start` | | Initialize bot and view status summary |
| `/status` | | Display active downloads across all engines (progress, speed, ETA) |
| `/debrid` | `<url>` | Unrestrict and download premium hoster links |
| `/mydownloads` | | View recent tracked downloads with one-tap link generation |
| `/getlink` | `<id>` | Request a fresh, private CDN download link |
| `/torrents` | | List torrent downloads (paginated) |
| `/addmagnet` | `<magnet>` | Add torrent via magnet URI |
| `/addcached` | `<hash/magnet>` | Add torrent strictly if present in TorBox cache |
| `/checkcached`| `<hash/magnet>` | Query TorBox cache status for infohash |
| `/torrent` | `<id>` | View torrent details and file list |
| `/usenet` | | List Usenet downloads (Essential+) |
| `/addnzb` | `<url>` | Add Usenet download via NZB URL (Essential+) |
| `/webdl` | | List WebDL items (Essential+) |
| `/addwebdl` | `<url>` | Add web download (Essential+) |
| `/search` | `<query>` | Search TorBox catalog |
| `/rss` | | Manage RSS feeds (Essential+) |
| `/addrss` | `<url>` | Add RSS feed (Essential+) |
| `/queued` | | Inspect queued items |
| `/notifications`| | View account notifications |
| `/me` | | Profile details, plan tier, and account limits |
| `/stats` | | Personal account download metrics |
| `/setkey` | `<key>` | Configure personal TorBox API key |
| `/help` | | Full command overview |

---

## Deployment (Render)

This bot can run as either a **Web Service** (recommended, exposes the Web Admin Panel) or a **Background Worker** on Render.

1. Connect your repository to Render.
2. Render automatically detects `render.yaml`.
3. Set secret variables (`TELEGRAM_BOT_TOKEN`, `TORBOX_API_KEY`, `ADMIN_WEB_PASSWORD`) in the Render Environment tab.

---

## Architecture & Storage

* **Database**: SQLite (`data/bot.db`) with WAL mode via `better-sqlite3`.
* **State Management**: API keys, user whitelists, and active download tasks persist across server restarts.
* **Polling Engine**: Asynchronous periodic monitor queries TorBox API status for active items without blocking main thread interactions.
* **HTTP Admin Server**: Built-in Express dashboard with session cookie authentication.
