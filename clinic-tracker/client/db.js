const DB_NAME = 'clinic-db';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore('records', { keyPath: 'id' });
      const outbox = db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      outbox.createIndex('by-status', 'status');
      db.createObjectStore('opLog', { keyPath: 'operationId' });
      const conflicts = db.createObjectStore('conflictLog', { keyPath: 'conflictId' });
      conflicts.createIndex('by-record', 'recordId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function tx(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = {};
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    names.forEach(n => stores[n] = t.objectStore(n));
    let result;
    try {
      result = fn(stores, t);
    } catch (err) {
      t.abort();
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getRecords(db) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('records', 'readonly');
    const req = t.objectStore('records').getAll();
    req.onsuccess = () => resolve(req.result.filter(r => !r._deletedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function getConflicts(db) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('conflictLog', 'readonly');
    const req = t.objectStore('conflictLog').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveRecordAndEnqueue(db, record, op) {
  return tx(db, ['records', 'outbox'], 'readwrite', (stores) => {
    stores.records.put(record);
    stores.outbox.add(op);
  });
}

export async function getOutboxHead(db) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('outbox', 'readonly');
    const idx = t.objectStore('outbox').index('by-status');
    const req = idx.openCursor('pending');
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

export async function commitAck(db, head, ack) {
  return tx(db, ['records', 'outbox', 'opLog', 'conflictLog'], 'readwrite', (stores) => {
    stores.opLog.put({ operationId: head.operationId, ackedAt: Date.now() });
    stores.outbox.delete(head.seq);
    
    const recReq = stores.records.get(head.recordId);
    recReq.onsuccess = () => {
        const rec = recReq.result;
        if (rec) {
            if (ack.conflict) {
                rec._syncStatus = 'conflicted';
                stores.conflictLog.put({ ...ack.conflict, resolvedAt: Date.now() });
            } else {
                rec._syncStatus = 'synced';
                rec._serverVersion = ack.serverVersion;
                rec._lastModified = ack.serverTimestamp || Date.now();
            }
            stores.records.put(rec);
        }
    };
  });
}

export async function getPendingCount(db) {
   return new Promise((resolve, reject) => {
       const t = db.transaction('outbox', 'readonly');
       const req = t.objectStore('outbox').count();
       req.onsuccess = () => resolve(req.result);
       req.onerror = () => reject(req.error);
   });
}