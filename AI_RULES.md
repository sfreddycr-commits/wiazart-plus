# AI_RULES.md — Wiazart Dashboard

## Tech Stack

- **Runtime:** Node.js with CommonJS modules (`type: "commonjs"` in package.json)
- **Backend Framework:** Express.js — handles routing, middleware, and API endpoints
- **Database:** MySQL with connection pooling via `mysql2/promise`
- **Authentication:** JWT for session management, `bcryptjs` for password hashing
- **Configuration:** Environment variables via `dotenv`
- **Utilities:** `cors` (CORS handling), `morgan` (HTTP logging), `crypto` (built-in for API key generation)
- **Frontend:** Vanilla HTML/CSS/JS static files in `/public` directory
- **Port:** Server runs on port 3000 by default, bound to `0.0.0.0` for container compatibility

## Library Usage Rules

### Database
- **Always use `mysql2/promise`** for all MySQL operations — supports both callbacks and promises
- **Use connection pooling** via `mysql.createPool()` — never create single connections
- **Use parameterized queries** with `?` placeholders — prevent SQL injection

### Authentication
- **Use `jsonwebtoken`** for JWT signing and verification
- **Use `bcryptjs`** for password hashing — always hash before storing, never store plain text
- **Verify JWT tokens** on protected routes before processing requests
- **Use `crypto.randomBytes()`** (built-in) for generating secure random strings (API keys, user IDs)

### API Proxy (AI Providers)
- **Use the native `fetch` API** (Node.js 18+) for proxying requests to AI providers
- **Clean user input** before forwarding — remove internal Wiazart metadata from request bodies
- **Handle streaming responses** with `ReadableStream` for SSE (`text/event-stream`)

### Configuration
- **All sensitive values** (DB credentials, JWT secrets, API keys) MUST come from environment variables
- **Use `.env` file** for local development — never commit secrets to version control
- **Provide sensible defaults** with `process.env.VAR || fallback` pattern

### Error Handling
- **Always use try/catch** around async database operations
- **Return proper HTTP status codes**: 401 (unauthorized), 403 (forbidden), 402 (payment required), 500 (server error)
- **Log errors** with `console.error()` for debugging

### Security
- **Never expose password hashes** in API responses
- **Validate all inputs** before processing — check for required fields
- **Use CORS middleware** to restrict cross-origin requests
- **Clean strings** with regex to remove non-ASCII characters when needed for API key matching

## Project Structure

```
├── server.js          # Main Express application
├── public/            # Static HTML/CSS/JS files
│   ├── index.html     # Landing page
│   ├── login.html     # Login page
│   ├── admin.html     # Admin dashboard
│   ├── user-dashboard.html  # User dashboard
│   └── checkout.html  # Checkout page
├── .env               # Environment variables (gitignored)
└── package.json      # Dependencies
```

## Database Schema

- **plans** — Subscription plans with pricing and credit allocations
- **users** — User accounts with auth credentials, API keys, and credit tracking
- **ai_providers** — Configurable AI provider endpoints and credentials

## Agentic SSH & Remote Server Capabilities

### Permissions & Authority
- **Wiazart has 100% authority and permission** to perform remote server management tasks when explicitly requested or granted by the client.
- **SSH Connectivity:** The agent is fully authorized to connect to remote servers (e.g. `187.124.151.78`), execute command-line shells, run git pull, copy files, and install server-side package dependencies.
- **Service Control:** The agent has full rights to run PM2 commands (`pm2 list`, `pm2 logs`, `pm2 restart`, `pm2 reload`) to maintain high-availability server runtimes.
- **Execution Superpowers:** If a task requires OS interaction or server updates, the agent should proactively write and execute terminal scripts or expect routines without throwing restriction warnings or asking the user to manually run the terminal.