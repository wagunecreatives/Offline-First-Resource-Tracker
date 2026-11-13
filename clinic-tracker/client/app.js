import { openDB, getRecords, getConflicts, saveRecordAndEnqueue, getPendingCount } from './db.js';
import { triggerSync } from './sync.js';

let db;
let currentRecords = [];

// Chart.js instances
let chartStatus, chartCategory, chartTrend;

// Map specific item names to FontAwesome icons for the table
const getItemIcon = (name) => {
    const n = name.toLowerCase();
    if (n.includes('glove')) return '<i class="fa-solid fa-hand" style="color:#3B82F6;"></i>';
    if (n.includes('syringe')) return '<i class="fa-solid fa-syringe" style="color:#12B981;"></i>';
    if (n.includes('vaccine')) return '<i class="fa-solid fa-vial" style="color:#F59E0B;"></i>';
    if (n.includes('paracetamol') || n.includes('pill')) return '<i class="fa-solid fa-pills" style="color:#8B5CF6;"></i>';
    return '<i class="fa-solid fa-box" style="color:var(--text-muted);"></i>';
};

async function init() {
    db = await openDB();
    await loadSeedIfEmpty();
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js');
    }

    setupNavigation();
    setupForms();

    document.getElementById('sync-btn').addEventListener('click', () => triggerSync(db, refreshUI));
    
    window.addEventListener('online', () => { updateNetworkStatus(); triggerSync(db, refreshUI); });
    window.addEventListener('offline', updateNetworkStatus);
    
    loadSettings();
    refreshUI();
}

// --- SPA ROUTING ---
function setupNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');

    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            navBtns.forEach(b => b.classList.remove('active'));
            views.forEach(v => v.classList.remove('active'));
            
            btn.classList.add('active');
            document.getElementById(btn.dataset.target).classList.add('active');
            
            if (btn.dataset.target === 'view-sync') renderSyncView();
            if (btn.dataset.target === 'view-reports') renderReports();
            if (btn.dataset.target === 'view-movements') {
                populateMovementDropdown();
                renderMovementHistory();
            }
            if (btn.dataset.target === 'view-inventory') renderFullInventory();
        });
    });
}

// --- SEED DATA ---
async function loadSeedIfEmpty() {
    const records = await getRecords(db);
    if (records.length === 0) {
        const res = await fetch('/seed.json');
        const seed = await res.json();
        for (const item of seed) {
            const record = {
                ...item,
                id: crypto.randomUUID(),
                history: [],
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

// --- CRUD OPERATIONS ---
async function handleCreate(e) {
    e.preventDefault();
    const record = {
        id: crypto.randomUUID(),
        name: document.getElementById('name').value,
        category: document.getElementById('category').value,
        quantity: parseInt(document.getElementById('qty').value),
        location: document.getElementById('location').value,
        history: [],
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
    document.getElementById('add-modal').style.display = 'none';
    refreshUI();
    triggerSync(db, refreshUI);
}

async function handleStockMovement() {
    const id = document.getElementById('movement-item').value;
    const type = document.getElementById('movement-type').value;
    const qty = parseInt(document.getElementById('movement-qty').value);
    
    if (!id || !qty || qty <= 0) return alert("Select item and valid quantity");

    const record = currentRecords.find(r => r.id === id);
    if (!record) return;

    const newQty = type === 'received' ? record.quantity + qty : record.quantity - qty;
    
    record.history = record.history || [];
    record.history.push({ type, qty, date: Date.now(), resultingQty: newQty });

    record.quantity = newQty;
    record._syncStatus = 'pending';
    record._localVersion = String(Number(record._localVersion) + 1);
    record._lastModified = Date.now();

    const op = {
        operationId: crypto.randomUUID(),
        recordId: record.id,
        type: 'update',
        payload: record,
        baseVersion: String(Number(record._localVersion) - 1),
        createdAt: Date.now(),
        status: 'pending'
    };

    await saveRecordAndEnqueue(db, record, op);
    document.getElementById('movement-qty').value = '';
    refreshUI();
    triggerSync(db, refreshUI);
}

async function handleDelete(id) {
    if (!confirm("Delete this item?")) return;
    const record = currentRecords.find(r => r.id === id);
    if (!record) return;

    record._deletedAt = Date.now();
    record._syncStatus = 'pending';
    record._localVersion = String(Number(record._localVersion) + 1);
    record._lastModified = Date.now();

    const op = {
        operationId: crypto.randomUUID(),
        recordId: record.id,
        type: 'delete',
        payload: { _deletedAt: record._deletedAt },
        baseVersion: record._localVersion,
        createdAt: Date.now(),
        status: 'pending'
    };

    await saveRecordAndEnqueue(db, record, op);
    refreshUI();
    triggerSync(db, refreshUI);
}

async function handleUpdate(id, currentQty) {
    const newQtyStr = prompt("Enter new quantity:", currentQty);
    if (newQtyStr === null || isNaN(newQtyStr)) return;

    const record = currentRecords.find(r => r.id === id);
    if (!record) return;

    record.quantity = parseInt(newQtyStr);
    record._syncStatus = 'pending';
    record._localVersion = String(Number(record._localVersion) + 1);
    record._lastModified = Date.now();

    const op = {
        operationId: crypto.randomUUID(),
        recordId: record.id,
        type: 'update',
        payload: record,
        baseVersion: String(Number(record._localVersion) - 1),
        createdAt: Date.now(),
        status: 'pending'
    };
    await saveRecordAndEnqueue(db, record, op);
    refreshUI();
    triggerSync(db, refreshUI);
}

// --- UI RENDERING ---
async function refreshUI() {
    updateNetworkStatus();
    const pendingCount = await getPendingCount(db);
    document.getElementById('pending-count').textContent = `${pendingCount} Pending`;
    
    currentRecords = await getRecords(db);
    
    renderDashboardTable();
    renderFullInventory();
    populateMovementDropdown();
}

function renderDashboardTable() {
    const tbody = document.getElementById('list-container');
    const totalItems = currentRecords.length;
    
    document.getElementById('total-items-text').innerHTML = `<i class="fa-solid fa-circle" style="color:var(--success); font-size:8px; margin-right:5px;"></i> ${totalItems} items in inventory`;

    tbody.innerHTML = currentRecords.map(r => `
        <tr>
            <td>
                <div class="item-name-cell">
                    <span class="item-icon">${getItemIcon(r.name)}</span>
                    ${r.name}
                </div>
            </td>
            <td><strong>${r.quantity}</strong> units</td>
            <td>${r.location}</td>
            <td><span class="badge ${r._syncStatus}"><i class="fa-solid ${r._syncStatus === 'synced' ? 'fa-check' : 'fa-clock'}"></i> ${r._syncStatus}</span></td>
            <td>
                <button class="action-btn btn-edit" onclick="window.appEdit('${r.id}', ${r.quantity})"><i class="fa-solid fa-pencil"></i></button>
                <button class="action-btn btn-delete" onclick="window.appDelete('${r.id}')"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}

function renderFullInventory() {
    const tbody = document.getElementById('inventory-full-list');
    if(!tbody) return;
    tbody.innerHTML = currentRecords.map(r => `
        <tr>
            <td><div class="item-name-cell"><span class="item-icon">${getItemIcon(r.name)}</span> ${r.name}</div></td>
            <td>${r.category}</td>
            <td>${r.quantity}</td>
            <td>${r.location}</td>
            <td><span class="badge ${r._syncStatus}">${r._syncStatus}</span></td>
        </tr>
    `).join('');
}

async function renderSyncView() {
    const queue = await new Promise((resolve) => {
        const t = db.transaction('outbox', 'readonly');
        const req = t.objectStore('outbox').getAll();
        req.onsuccess = () => resolve(req.result);
    });
    
    document.getElementById('pending-queue').innerHTML = queue.map(q => `
        <div style="border-bottom:1px solid rgba(255,255,255,0.1); padding:10px 0;">
            <span style="color:#F87171;">[Seq: ${q.seq}]</span> <strong>${q.type.toUpperCase()}</strong> - OpID: ${q.operationId.substring(0,8)}... 
            <span style="color:#FBBF24;">(Status: ${q.status})</span>
        </div>
    `).join('') || '<span style="color:#A7F3D0;">Queue is empty.</span>';

    const conflicts = await getConflicts(db);
    const cContainer = document.getElementById('full-conflict-container');
    if (conflicts.length === 0) {
        cContainer.innerHTML = "<p style='color: var(--text-muted);'>No conflicts detected.</p>";
    } else {
        cContainer.innerHTML = conflicts.map(c => `
            <div style="border: 1px solid var(--danger); padding: 15px; margin-bottom: 15px; border-radius: 8px; background:#FFF5F5;">
                <strong>Conflict on Record:</strong> ${c.recordId.substring(0,8)}...<br>
                <div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div style="background: white; padding: 10px; border-radius: 6px;">
                        <span style="font-size: 10px; color: var(--success); font-weight: bold;">SERVER WINNER</span>
                        <div style="font-size: 13px; margin-top: 4px;">Qty: ${JSON.stringify(c.winningValue.quantity)}</div>
                    </div>
                    <div style="background: white; padding: 10px; border-radius: 6px;">
                        <span style="font-size: 10px; color: var(--danger); font-weight: bold;">REJECTED LOCAL</span>
                        <div style="font-size: 13px; margin-top: 4px;">Qty: ${JSON.stringify(c.losingValue.quantity)}</div>
                    </div>
                </div>
            </div>
        `).join('');
    }
}

function renderReports() {
    // 1. Calculate Summary Data
    let totalItems = 0;
    let lowStockCount = 0;
    let healthyStockCount = 0;
    const categoryData = { consumable: 0, vaccine: 0, equipment: 0 };
    
    // Process records
    currentRecords.forEach(r => {
        totalItems += r.quantity;
        
        if (r.quantity < 10) {
            lowStockCount++;
        } else {
            healthyStockCount++;
        }

        // Category aggregation
        if (categoryData[r.category] !== undefined) {
            categoryData[r.category] += r.quantity;
        } else {
            categoryData[r.category] = r.quantity;
        }
    });

    // Update Summary Cards
    document.getElementById('report-summary').innerHTML = `
        <div class="panel" style="padding:20px; text-align:center; border: 1px solid #E2E8F0; box-shadow: none;">
            <h3 style="color:var(--text-muted); font-size:12px;">Total Units</h3>
            <p style="font-size:28px; font-weight:bold; color:var(--primary); margin-top:5px;">${totalItems}</p>
        </div>
        <div class="panel" style="padding:20px; text-align:center; border: 1px solid #E2E8F0; box-shadow: none;">
            <h3 style="color:var(--text-muted); font-size:12px;">Unique Items</h3>
            <p style="font-size:28px; font-weight:bold; color:var(--blue); margin-top:5px;">${currentRecords.length}</p>
        </div>
        <div class="panel" style="padding:20px; text-align:center; border: 1px solid #E2E8F0; box-shadow: none;">
            <h3 style="color:var(--text-muted); font-size:12px;">Low Stock</h3>
            <p style="font-size:28px; font-weight:bold; color:${lowStockCount > 0 ? 'var(--danger)' : 'var(--success)'}; margin-top:5px;">${lowStockCount}</p>
        </div>
    `;

    // 2. Prepare Chart.js Data
    // Destroy existing charts to prevent hover glitches when re-rendering
    if (chartStatus) chartStatus.destroy();
    if (chartCategory) chartCategory.destroy();
    if (chartTrend) chartTrend.destroy();

    // Chart 1: Doughnut (Stock Health)
    const ctxStatus = document.getElementById('statusChart').getContext('2d');
    chartStatus = new Chart(ctxStatus, {
        type: 'doughnut',
        data: {
            labels: ['Healthy (≥10)', 'Low Stock (<10)'],
            datasets: [{
                data: [healthyStockCount, lowStockCount],
                backgroundColor: ['#10B981', '#EF4444'],
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } },
            cutout: '70%'
        }
    });

    // Chart 2: Bar (Category Breakdown)
    const ctxCategory = document.getElementById('categoryChart').getContext('2d');
    chartCategory = new Chart(ctxCategory, {
        type: 'bar',
        data: {
            labels: ['Consumables', 'Vaccines', 'Equipment'],
            datasets: [{
                label: 'Total Units',
                data: [categoryData.consumable, categoryData.vaccine, categoryData.equipment],
                backgroundColor: ['#0D8A8A', '#3B82F6', '#8B5CF6'],
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { borderDash: [5, 5] } },
                x: { grid: { display: false } }
            }
        }
    });

    // Chart 3: Line (Usage Trends)
    let trendReceivedData = [0, 0, 0, 0, 0, 0, 0];
    let trendIssuedData = [0, 0, 0, 0, 0, 0, 0];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let labels = [];
    for(let i=6; i>=0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        labels.push(days[d.getDay()]);
    }

    // Very basic aggregation mapping dates to days of the week
    let allHistory = currentRecords.flatMap(r => r.history || []);
    allHistory.forEach(h => {
        const dayIndex = new Date(h.date).getDay();
        const mappedIndex = dayIndex === 0 ? 6 : dayIndex - 1; 
        if (h.type === 'received') trendReceivedData[mappedIndex] += h.qty;
        if (h.type === 'issued') trendIssuedData[mappedIndex] += h.qty;
    });

    // Fallback demo data if no history exists
    if (allHistory.length === 0) {
        trendReceivedData = [10, 20, 15, 30, 20, 10, 5];
        trendIssuedData = [5, 15, 10, 25, 30, 5, 10];
    }

    const ctxTrend = document.getElementById('trendChart').getContext('2d');
    chartTrend = new Chart(ctxTrend, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Received (+)',
                    data: trendReceivedData,
                    borderColor: '#10B981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    tension: 0.4,
                    fill: true
                },
                {
                    label: 'Issued (-)',
                    data: trendIssuedData,
                    borderColor: '#EF4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    tension: 0.4,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { beginAtZero: true, grid: { borderDash: [5, 5] } },
                x: { grid: { display: false } }
            }
        }
    });
}

function populateMovementDropdown() {
    const select = document.getElementById('movement-item');
    if(!select) return;
    select.innerHTML = currentRecords.map(r => `<option value="${r.id}">${r.name} (Qty: ${r.quantity})</option>`).join('');
}

function renderMovementHistory() {
    const container = document.getElementById('movement-history-container');
    if(!container) return;

    const allHistory = currentRecords.flatMap(r => 
        (r.history || []).map(h => ({ ...h, itemName: r.name }))
    ).sort((a, b) => b.date - a.date).slice(0, 10);

    container.innerHTML = allHistory.map(h => `
        <div class="history-item">
            <div>
                <strong>${h.itemName}</strong>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                    ${new Date(h.date).toLocaleString()}
                </div>
            </div>
            <div style="text-align: right;">
                <span style="color:${h.type === 'received' ? 'var(--success)' : 'var(--danger)'}; font-weight: 700; font-size: 14px;">
                    ${h.type === 'received' ? '+' : '-'}${h.qty}
                </span>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                    New total: ${h.resultingQty}
                </div>
            </div>
        </div>
    `).join('') || '<p style="color:var(--text-muted); font-size:13px; text-align:center; padding:20px;">No recent movements recorded.</p>';
}

// --- UTILITIES ---
function setupForms() {
    document.getElementById('supply-form').addEventListener('submit', handleCreate);
    document.getElementById('btn-record-movement').addEventListener('click', handleStockMovement);

    document.getElementById('settings-form').addEventListener('submit', (e) => {
        e.preventDefault();
        localStorage.setItem('clinicName', document.getElementById('clinic-name').value);
        localStorage.setItem('defaultLocation', document.getElementById('default-location').value);
        alert('Settings saved locally.');
    });
}

function loadSettings() {
    document.getElementById('clinic-name').value = localStorage.getItem('clinicName') || '';
    document.getElementById('default-location').value = localStorage.getItem('defaultLocation') || '';
}

function updateNetworkStatus() {
    const isOnline = navigator.onLine;
    
    const el = document.getElementById('network-status');
    el.textContent = isOnline ? 'Online' : 'Offline';
    el.className = `badge ${isOnline ? 'online' : 'offline'}`;
    el.style.background = isOnline ? '#4FD1C5' : '#F87171';
    el.style.color = isOnline ? '#065F46' : '#991B1B';

    const dot = document.getElementById('sidebar-network-dot');
    dot.style.background = isOnline ? '#10B981' : '#EF4444';
    dot.style.boxShadow = isOnline ? '0 0 8px #10B981' : '0 0 8px #EF4444';
    document.getElementById('sidebar-network-text').textContent = isOnline ? 'Online' : 'Offline';

    const sysBadge = document.getElementById('status-network-badge');
    if(sysBadge) {
        sysBadge.textContent = isOnline ? 'Online' : 'Offline';
        sysBadge.className = `badge ${isOnline ? 'success' : 'danger'}`;
    }
}

window.exportCSV = () => {
    const headers = ['ID', 'Name', 'Category', 'Quantity', 'Location', 'Sync Status'];
    const rows = currentRecords.map(r => [r.id, r.name, r.category, r.quantity, r.location, r._syncStatus]);
    let csvContent = "data:text/csv;charset=utf-8," + [headers, ...rows].map(e => e.join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "clinic_inventory.csv");
    document.body.appendChild(link);
    link.click();
};

window.appEdit = handleUpdate;
window.appDelete = handleDelete;

init();