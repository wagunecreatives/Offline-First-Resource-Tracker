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
                // Mark failed and break the loop. Do not process subsequent operations.
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