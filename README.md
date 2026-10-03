# catchat — Production Architecture (Nginx + MySQL + Node.js)

`catchat` is an AI chat assistant powered by Google Gemini, equipped with:
- **Nginx** reverse proxy (serves static UI & routes API calls on port 8085).
- **MySQL / MariaDB** database (securely stores user Gemini API keys and chat histories).
- **Node.js (Express)** backend (proxies Gemini requests, communicates with MySQL over UNIX domain socket or TCP 3301).

---

## Architecture Overview

```
 [Browser / Client]
         │
         ▼ (Port 8085)
   ┌───────────┐
   │   Nginx   │ ── Static Files ──> (index.html, brand-curious-cat.webp)
   └─────┬─────┘
         │ /api/* (via unix:/data/backend.sock or TCP 3001)
         ▼
 ┌───────────────┐
 │ Node.js Server│ <───> [MySQL / MariaDB]
 └───────┬───────┘       (Stores user API keys & sessions in catchat_db)
         │
         ▼
 [Google Gemini API]
 (Key fetched from MySQL, never exposed to visitor)
```

---

## Quick Start (Start / Stop / Status)

Helper scripts are available in the `scripts/` directory:

```bash
# Start all services (MariaDB, Node backend, Nginx)
bash scripts/start.sh

# Check the health of all services
bash scripts/status.sh

# Stop all services
bash scripts/stop.sh
```

Once started:
- **Web App**: [http://localhost:8085](http://localhost:8085)
- **Direct Backend**: [http://localhost:3001](http://localhost:3001)
- **API Health**: [http://localhost:8085/api/health](http://localhost:8085/api/health)

---

## Database Configuration (MySQL / MariaDB)

- **Database Name**: `catchat_db`
- **Port**: `3307` (custom user-space port)
- **Socket**: `data/mysql.sock`
- **User**: `catbot`
- **Password**: `catbot_secret`
- **Schema File**: `data/schema.sql`

### Tables:
1. `user_keys`: Stores user/client Gemini API keys (`client_id`, `api_key`, timestamps).
2. `sessions`: Stores conversation metadata (`id`, `client_id`, `title`, `updated_at`).
3. `messages`: Stores conversation turns (`session_id`, `role`, `text`, `raw_text`, `html`).

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Returns health status and database connectivity (`mysql_connected`). |
| `GET` | `/api/key` | Checks if the current client has a Gemini key saved in MySQL. |
| `POST` | `/api/key` | Saves the visitor's Gemini API key into the MySQL `user_keys` table. |
| `DELETE` | `/api/key` | Removes the user's API key from the MySQL database. |
| `POST` | `/api/chat` | Fetches the user's key from MySQL and proxies the prompt to Gemini. |
| `GET` | `/api/sessions` | Lists chat sessions from MySQL for the client. |
| `PUT` | `/api/sessions/:id` | Saves/updates a chat session and messages in MySQL. |
| `DELETE` | `/api/sessions/:id` | Deletes a chat session from MySQL. |

---

## Storing Your Gemini API Key

1. Open [http://localhost:8080](http://localhost:8080).
2. Click the **API Key** button in the top bar.
3. Enter your Google Gemini API key and click **Save Key**.
4. The key is transmitted via `POST /api/key` and saved in the MySQL database. All future requests made by your browser will look up your key from MySQL without ever leaking it to the public.
# catbot
