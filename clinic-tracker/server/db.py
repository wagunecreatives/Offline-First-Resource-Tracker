import os
import psycopg
from psycopg_pool import ConnectionPool

DB_URI = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/clinic")
pool = ConnectionPool(DB_URI, min_size=1, max_size=10)

def init_db():
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY,
                    payload JSONB NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    server_timestamp BIGINT NOT NULL,
                    deleted_at BIGINT,
                    last_operation_id TEXT
                );
                CREATE TABLE IF NOT EXISTS processed_operations (
                    operation_id TEXT PRIMARY KEY,
                    result JSONB NOT NULL,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                );
            """)
        conn.commit()