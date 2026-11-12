# Clinic Resource Tracker (Offline-First)

An offline-first Progressive Web App for tracking medical supplies. Built for SDG 3 (Good Health & Well-Being).

## Tech Stack
- **Frontend:** HTML, CSS, Vanilla JS, IndexedDB, Service Worker
- **Backend:** Python Flask, PostgreSQL
- **Deployment:** PrimeCloud (Docker)

## DSA Implementation
1. **FIFO Queue:** Implemented in IndexedDB `outbox` store. Uses auto-increment `seq` to guarantee order. Failed operations block the queue; no operation is skipped.
2. **Record Hash Map:** IndexedDB `records` store keyed by `id`. Maintains optimistic UI state.
3. **Operation-ID Set:** 
   - *Client:* IndexedDB `opLog` prevents redundant network calls.
   - *Server:* PostgreSQL `processed_operations` table with `ON CONFLICT DO NOTHING` ensures atomic deduplication.
4. **Conflict Resolution (LWW):** 
   - Timestamps compared with a 5-second tolerance window.
   - Tie-breaker uses lexicographical comparison of `operationId`.
   - Losing edits are stored in `conflictLog` and displayed in the UI.

## Local Development
1. Run Postgres:
   ```bash
   docker run --name clinic-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres