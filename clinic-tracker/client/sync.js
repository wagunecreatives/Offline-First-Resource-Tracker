import { getOutboxHead, commitAck } from './db.js';

let draining = false;

export async function triggerSync(db, onUpdate) {
    if (!navigator.onLine || draining) return;
    draining = true;
    
    try {
        while (true) {
            const head = await getOutboxHead(db);
            if (!head) break;
            
            // Client-side safety net: check opLog
            const isAcked = await new Promise((resolve) => {
                const t = db.transaction('opLog', 'readonly');
                const req = t.objectStore('opLog').get(head.operationId);
                req.onsuccess = () => resolve(!!req.result);
            });
            
            if (isAcked) {
                await new Promise((resolve) => {
                    const t = db.transaction('outbox', 'readwrite');
                    t.objectStore('outbox').delete(head.seq);
                    t.oncomplete = resolve;
                });
                continue;
            }
            
            try {
                const res = await fetch('/sync/apply', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(head)
                });
                if (!res.ok) throw new Error(`Server returned ${res.status}`);
                
                const ack = await res.json();
                if (ack.operationId !== head.operationId) throw new Error('Ack mismatch');
                
                await commitAck(db, head, ack);
            } catch (err) {
                console.error('Sync failed, retaining head:', err);
                // Mark failed and break the loop.
                await new Promise((resolve) => {
                    const t = db.transaction('outbox', 'readwrite');
                    const req = t.objectStore('outbox').get(head.seq);
                    req.onsuccess = () => {
                        if (req.result) {
                            req.result.status = 'failed';
                            t.objectStore('outbox').put(req.result);
                        }
                    };
                    t.oncomplete = resolve;
                });
                break;
            }
        }
    } finally {
        draining = false;
        if (onUpdate) onUpdate();
    }
}

// --- NEW: PULL FUNCTION ---
export async function pullFromServer(db, onUpdate) {
    if (!navigator.onLine) return;
    
    try {
        const res = await fetch('/sync/pull');
        if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
        
        const serverRecords = await res.json();
        if (!serverRecords || serverRecords.length === 0) return;

        // 1. Get pending outbox operations to prevent overwriting local unsynced changes
        const txRead = db.transaction(['outbox'], 'readonly');
        const pendingOps = await txRead.objectStore('outbox').getAll();
        const pendingRecordIds = new Set(pendingOps.map(op => op.recordId));

        // 2. Apply server records to local DB
        const txWrite = db.transaction(['records'], 'readwrite');
        const recordsStore = txWrite.objectStore('records');

        for (const serverRec of serverRecords) {
            // Skip if we have local pending changes for this record
            if (pendingRecordIds.has(serverRec.id)) continue;
            
            const localRec = await recordsStore.get(serverRec.id);
            
            // If server has a tombstone (deleted) and local doesn't, mark it deleted locally
            if (serverRec._deletedAt && (!localRec || !localRec._deletedAt)) {
                recordsStore.put({ ...serverRec, _syncStatus: 'synced' });
                continue;
            }

            // If local doesn't exist or the server's timestamp is newer, update local
            if (!localRec || (serverRec._lastModified > localRec._lastModified)) {
                recordsStore.put({
                    ...serverRec,
                    _syncStatus: 'synced'
                });
            }
        }

        await txWrite.done;
        if (onUpdate) onUpdate();
        
    } catch (err) {
        console.error("Pull failed:", err);
    }
}