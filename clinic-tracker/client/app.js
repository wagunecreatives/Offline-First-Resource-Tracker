import { openDB, getRecords, getConflicts, saveRecordAndEnqueue, getPendingCount } from './db.js';
import { triggerSync } from './sync.js';

let db;

async function init() {
    db = await openDB();
    await loadSeedIfEmpty();
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js');
    }

    document.getElementById('supply-form').addEventListener('submit', handleCreate);
    document.getElementById('sync-btn').addEventListener('click', () => triggerSync(db, refreshUI));
    
    window.addEventListener('online', () => { updateNetworkStatus(); triggerSync(db, refreshUI); });
    window.addEventListener('offline', updateNetworkStatus);
    
    refreshUI();
}

async function loadSeedIfEmpty() {
    const records = await getRecords(db);
    if (records.length === 0) {
        const res = await fetch('/seed.json');
        const seed = await res.json();
        for (const item of seed) {
            const record = {
                ...item,
                id: crypto.randomUUID(),
                _syncStatus: 'synced',
                _localVersion: '1',
                _lastModified: Date.now()
            };
            await new Promise((resolve) => {
                const t = db.transaction('records', 'readwrite');
                t.objectStore('records').put(record);
                t.oncomplete = resolve;
            });
        }
    }
}

async function handleCreate(e) {
    e.preventDefault();
    const name = document.getElementById('name').value;
    const quantity = parseInt(document.getElementById('qty').value);
    const location = document.getElementById('location').value;
    
    const record = {
        id: crypto.randomUUID(),
        name,
        quantity,
        location,
        _syncStatus: 'pending',
        _localVersion: '1',
        _lastModified: Date.now()
    };
    
    const op = {
        operationId: crypto.randomUUID(),
        recordId: record.id,
        type: 'create',
        payload: record,
        baseVersion: '0',
        createdAt: Date.now(),
        status: 'pending'
    };
    
    await saveRecordAndEnqueue(db, record, op);
    e.target.reset();
    refreshUI();
    triggerSync(db, refreshUI);
}

async function refreshUI() {
    updateNetworkStatus();
    
    const pending = await getPendingCount(db);
    document.getElementById('pending-count').textContent = `${pending} Pending`;
    
    const records = await getRecords(db);
    const list = document.getElementById('list-container');
    list.innerHTML = records.map(r => `
        <li>
            <div>
                <strong>${r.name}</strong> - ${r.quantity} units (${r.location})
                <br><small style="color:gray">ID: ${r.id.substring(0,8)}...</small>
            </div>
            <span class="badge ${r._syncStatus}">${r._syncStatus}</span>
        </li>
    `).join('');

    const conflicts = await getConflicts(db);
    const cContainer = document.getElementById('conflict-container');
    if (conflicts.length === 0) {
        cContainer.innerHTML = "No conflicts detected.";
    } else {
        cContainer.innerHTML = conflicts.map(c => `
            <div style="border: 1px solid #9c27b0; padding: 10px; margin-bottom: 10px; border-radius: 4px;">
                <strong>Conflict on Record:</strong> ${c.recordId.substring(0,8)}...<br>
                <strong>Winner:</strong> ${JSON.stringify(c.winningValue)}<br>
                <strong>Loser (Rejected):</strong> ${JSON.stringify(c.losingValue)}
            </div>
        `).join('');
    }
}

function updateNetworkStatus() {
    const el = document.getElementById('network-status');
    if (navigator.onLine) {
        el.textContent = 'Online';
        el.className = 'badge online';
    } else {
        el.textContent = 'Offline';
        el.className = 'badge offline';
    }
}

init();