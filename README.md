# Celume Ops Platform — Backend

Internal operations dashboard backend for Celume Studios. Built on [AppFlowy-Cloud](https://github.com/AppFlowy-IO/AppFlowy-Cloud) with a custom Node.js API for attendance tracking, task review workflows, and analytics.

## Architecture

- **AppFlowy-Cloud** — Collaboration backend (PostgreSQL, GoTrue auth, Redis, Minio, Nginx)
- **Custom API** — Express.js service for operations-specific endpoints (attendance, task reviews, analytics)
- Both share the same PostgreSQL database and GoTrue JWT authentication

## Prerequisites

- [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/) (with WSL 2 backend)
- [Git](https://git-scm.com/downloads) (with submodule support)

## Getting Started

### 1. Clone with submodules

```bash
git clone --recurse-submodules https://github.com/your-org/operation_website_backend.git
cd operation_website_backend
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:
- `POSTGRES_PASSWORD` — database password
- `GOTRUE_JWT_SECRET` — shared JWT secret (must match across all services)
- `GOTRUE_ADMIN_EMAIL` / `GOTRUE_ADMIN_PASSWORD` — initial admin credentials

### 3. Start everything

```bash
docker compose up -d
```

This launches all AppFlowy-Cloud services and the custom API in one command.

### 4. Run database migrations

Once PostgreSQL is healthy, apply the custom migrations:

```bash
docker compose exec postgres psql -U postgres -d postgres -f /app/migrations/001_attendance.sql
docker compose exec postgres psql -U postgres -d postgres -f /app/migrations/002_review_workflow.sql
```

Or copy and run them manually:

```bash
docker compose cp migrations/001_attendance.sql postgres:/tmp/
docker compose cp migrations/002_review_workflow.sql postgres:/tmp/
docker compose exec postgres psql -U postgres -d postgres -f /tmp/001_attendance.sql
docker compose exec postgres psql -U postgres -d postgres -f /tmp/002_review_workflow.sql
```

## Services & Ports

| Service | Port | Description |
|---------|------|-------------|
| Nginx | 80 / 443 | Reverse proxy for AppFlowy |
| PostgreSQL | 5432 | Shared database |
| Redis | 6379 | Cache / pub-sub |
| GoTrue | 9999 (internal) | Authentication |
| AppFlowy Cloud | 8000 (internal) | Collaboration API |
| Custom API | 3001 | Operations endpoints |

## Custom API Endpoints

All endpoints require a valid GoTrue JWT in the `Authorization: Bearer <token>` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/attendance` | Get attendance records |
| POST | `/attendance/checkin` | Check in for the day |
| POST | `/attendance/checkout` | Check out for the day |
| GET | `/tasks/review-queue` | Get tasks pending review |
| POST | `/tasks/:id/submit` | Submit a task for review |
| POST | `/tasks/:id/approve` | Approve a submitted task |
| POST | `/tasks/:id/reject` | Reject a submitted task |
| GET | `/analytics/summary` | Get attendance and task stats |
| GET | `/health` | Health check (no auth required) |
