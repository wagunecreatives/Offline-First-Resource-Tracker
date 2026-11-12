import json
import time
import psycopg

CLOCK_TOLERANCE_MS = 5000

def apply_operation(conn: psycopg.Connection, op: dict) -> dict:
    """Applies an operation atomically using PostgreSQL deduplication."""
    with conn.transaction():
        # 1. Try to claim the operation ID.
        claimed = conn.execute(
            """
            INSERT INTO processed_operations (operation_id, result)
            VALUES (%s, '{}'::jsonb)
            ON CONFLICT (operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (op["operationId"],)
        ).fetchone()
        
        if claimed is None:
            # Replay: Already processed. Return stored result.
            row = conn.execute(
                "SELECT result FROM processed_operations WHERE operation_id = %s",
                (op["operationId"],)
            ).fetchone()
            return row[0] if row else {}
            
        # 2. Apply mutation
        result = _mutate(conn, op)
        
        # 3. Store result for future dedup
        conn.execute(
            "UPDATE processed_operations SET result = %s WHERE operation_id = %s",
            (json.dumps(result), op["operationId"])
        )
        return result

def _mutate(conn: psycopg.Connection, op: dict) -> dict:
    now_ms = int(time.time() * 1000)
    op_id = op["operationId"]
    rec_id = op["recordId"]
    
    if op["type"] == "create":
        conn.execute(
            """
            INSERT INTO records (id, payload, version, server_timestamp, last_operation_id)
            VALUES (%s, %s, 1, %s, %s)
            ON CONFLICT (id) DO NOTHING
            """,
            (rec_id, json.dumps(op["payload"]), now_ms, op_id)
        )
        return {"operationId": op_id, "serverVersion": "1", "serverTimestamp": now_ms}
        
    elif op["type"] == "update":
        current = conn.execute(
            "SELECT payload, version, server_timestamp, last_operation_id FROM records WHERE id = %s AND deleted_at IS NULL",
            (rec_id,)
        ).fetchone()
        
        if not current:
            return {"operationId": op_id, "conflict": {"reason": "record_deleted", "recordId": rec_id}}
            
        curr_payload, curr_version, curr_ts, curr_op_id = current
        local_ts = op["payload"].get("_lastModified", op.get("createdAt", now_ms))
        
        # LWW logic
        if local_ts > curr_ts + CLOCK_TOLERANCE_MS:
            local_wins = True
        elif local_ts < curr_ts - CLOCK_TOLERANCE_MS:
            local_wins = False
        else:
            # Tie-breaker: lexicographically smaller operation_id wins
            last_op = curr_op_id or ""
            local_wins = op_id < last_op
            
        if local_wins:
            next_version = curr_version + 1
            conn.execute(
                "UPDATE records SET payload = %s, version = %s, server_timestamp = %s, last_operation_id = %s WHERE id = %s",
                (json.dumps(op["payload"]), next_version, now_ms, op_id, rec_id)
            )
            return {"operationId": op_id, "serverVersion": str(next_version), "serverTimestamp": now_ms}
        else:
            return {
                "operationId": op_id,
                "conflict": {
                    "conflictId": op_id,
                    "recordId": rec_id,
                    "winningOperationId": curr_op_id,
                    "winningValue": curr_payload,
                    "losingOperationId": op_id,
                    "losingValue": op["payload"],
                    "reason": "server_won",
                    "resolvedAt": now_ms
                }
            }
            
    elif op["type"] == "delete":
        conn.execute(
            "UPDATE records SET deleted_at = %s, server_timestamp = %s, last_operation_id = %s WHERE id = %s",
            (now_ms, now_ms, op_id, rec_id)
        )
        return {"operationId": op_id, "serverTimestamp": now_ms}
        
    raise ValueError(f"Unknown operation type: {op['type']}")