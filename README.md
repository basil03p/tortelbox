# TorBox Manager

A modern, high-performance web interface and automation toolkit for [TorBox](https://torbox.app). Built with Next.js 15, React 19, and Tailwind CSS.

Includes an optional self-hosted Express backend for 24/7 background automation and a standalone Telegram Bot (`tgbot/`) for chat-based management.

---

## Key Features

### Download Management
* **Multi-Format Control**: Unified view for Torrents, Usenet (NZB), and WebDL / Debrid hosters.
* **Batch Operations**: Bulk enqueue torrent files, magnets, NZB links, or premium hoster URLs.
* **Granular File Selection**: Inspect multi-file archives and selectively download individual files.
* **List Synchronization**: Hybrid server-side sync with rev-tagged snapshots to minimize API polling overhead.
* **TorBox Airlock**: Filter and automate download locking/unlocking.

### Automation & Background Engine (Self-Hosted Backend)
* **Rule Engine**: Condition-based automation (seeding ratio, file age, speed thresholds, status changes).
* **Multi-User Isolation**: Independent per-user SQLite database instances with connection pooling.
* **Background Processing**: Asynchronous state diffing and speed aggregation.

### Telegram Integration (`tgbot/`)
* **Full Remote Control**: Complete management of torrents, usenet, web downloads, RSS, and account stats from Telegram.
* **Auto-Notifications**: Background polling auto-DMs the user as soon as a download finishes.
* **On-Demand Private Links**: Generates fresh time-limited CDN links via DM (`/getlink`).
* **Cache Inspection**: Query infohash cache status (`/checkcached`) and force cached-only additions (`/addcached`).
* **Access Control & Web Admin Panel**: Whitelist system (`ALLOWED_USERS`) and web administration dashboard (`http://localhost:3001/admin`).

### Security & Access Control
* **Web UI Login Protection**: Optional username and password gate (`WEB_USERNAME` / `WEB_PASSWORD`) for the Next.js interface.
* **Encrypted Storage**: Sensitive API keys encrypted at rest using AES-256-GCM.

---

## Project Architecture

```
torbox-app/
├── src/                    # Next.js 15 Web Application
│   ├── app/                # App Router pages and API routes
│   │   ├── [locale]/       # Internationalized pages
│   │   ├── auth/           # Login gate routes (/auth/login, /auth/api)
│   │   └── api/            # TorBox API proxies & sync handlers
│   ├── components/         # React UI components
│   ├── stores/             # Zustand client state
│   └── proxy.ts            # Middleware (Intl & auth gate)
├── tgbot/                  # Standalone Telegram Bot (Node.js + SQLite)
│   ├── src/                # Bot source code (api, db, monitor, admin, handlers)
│   ├── render.yaml         # Render deployment manifest
│   └── package.json
├── backend/                # Optional automation backend (Express + SQLite)
├── docker-compose.yml      # Multi-container deployment
└── README.md
```

---

## Getting Started

### Option A: Next.js Web UI Only

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Enter your TorBox API key from [torbox.app/settings](https://torbox.app/settings).

### Option B: Docker Compose (Web UI + Backend)

```bash
cp .env.example .env
docker compose up -d
```

### Option C: Telegram Bot Deployment

See [tgbot/README.md](tgbot/README.md) for full setup instructions.

```bash
cd tgbot
npm install
cp .env.example .env
npm start
```

---

## Configuration Reference

### Web Application (`.env`)

| Variable | Description | Default |
|---|---|---|
| `FRONTEND_URL` | Public origin URL for CORS | `http://localhost:3000` |
| `ENCRYPTION_KEY` | 32+ byte key for key-at-rest encryption | *Required* |
| `WEB_USERNAME` | Web UI login username (leave empty to disable login) | *Disabled* |
| `WEB_PASSWORD` | Web UI login password (leave empty to disable login) | *Disabled* |
| `ADMIN_API_KEY` | Secret key for `/api/admin` endpoints | *Disabled* |

### Telegram Bot (`tgbot/.env`)

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot API token from `@BotFather` |
| `TORBOX_API_KEY` | Default TorBox account API key |
| `BOT_ADMIN_ID` | Telegram user ID for admin operations |
| `ADMIN_WEB_USERNAME` | Username for Bot Web Admin Panel (`:3001/admin`) |
| `ADMIN_WEB_PASSWORD` | Password for Bot Web Admin Panel (`:3001/admin`) |
| `ALLOWED_USERS` | Comma-separated list of allowed Telegram user IDs |

---

## License

[GNU Affero General Public License v3.0](https://choosealicense.com/licenses/agpl-3.0/)
