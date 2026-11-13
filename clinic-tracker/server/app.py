import os
import atexit
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from db import pool, init_db
from sync_logic import apply_operation

app = Flask(__name__, static_folder='../client', static_url_path='')
CORS(app)

# Initialize DB schema on startup
init_db()

# Ensure connections close gracefully when gunicorn shuts down
atexit.register(pool.close)

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.get("/healthz")
def healthz():
    try:
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return jsonify({"status": "ok", "db": "ok"}), 200
    except Exception as e:
        return jsonify({"status": "error", "db": str(e)}), 503

@app.post("/sync/apply")
def sync_apply():
    op = request.get_json(force=True)
    required = {"operationId", "recordId", "type", "payload"}
    if not required.issubset(op):
        return jsonify({"error": "missing fields"}), 400
        
    try:
        with pool.connection() as conn:
            result = apply_operation(conn, op)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"status": "service_error", "stage": "apply", "detail": str(e)}), 500

# --- NEW: PULL ENDPOINT ---
@app.get("/sync/pull")
def sync_pull():
    try:
        with pool.connection() as conn:
            # Fetch ALL records (including tombstones so deletions sync down)
            rows = conn.execute(
                "SELECT payload FROM records"
            ).fetchall()
            
            # row[0] is the JSONB payload dictionary
            records = [row[0] for row in rows]
            return jsonify(records), 200
    except Exception as e:
        return jsonify({"status": "service_error", "stage": "pull", "detail": str(e)}), 500

if __name__ == '__main__':
    try:
        app.run(host='0.0.0.0', port=5000)
    except KeyboardInterrupt:
        pass