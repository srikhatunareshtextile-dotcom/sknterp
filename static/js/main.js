
// ══════════════════════════════════════════════════════════════════════════
// STALE-DATA (CLOUD SNAPSHOT) WARNING BANNER
// ══════════════════════════════════════════════════════════════════════════
window.showSnapshotBanner = function(data) {
  const existing = document.getElementById('snapshot-stale-banner');
  // Some report endpoints return an array (each row tagged with from_snapshot/snapshot_time)
  // instead of a single object - normalize to check the first row in that case.
  const info = Array.isArray(data) ? (data[0] || {}) : (data || {});
  if (!info.from_snapshot || !info.snapshot_time) {
    if (existing) existing.remove();
    return;
  }
  const msg = `⚠️ Cloud data as of ${info.snapshot_time} (local PC sync se pehle ka data ho sakta hai — PC pe "Manual Sync" chalayein)`;
  if (existing) {
    existing.querySelector('.banner-text').textContent = msg;
    return;
  }
  const banner = document.createElement('div');
  banner.id = 'snapshot-stale-banner';
  banner.style.cssText = 'position:relative;z-index:100;background:#fff3cd;color:#7a5b00;padding:6px 12px;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffe08a;margin-bottom:6px;';
  banner.innerHTML = `<span class="banner-text">${msg}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:#7a5b00;font-weight:bold;cursor:pointer;padding:0 4px;font-size:14px;">✕</button>`;
  document.body.insertBefore(banner, document.body.firstChild);
};

// ══════════════════════════════════════════════════════════════════════════
// LOCAL DEVICE PHOTO BACKUP (IndexedDB) + AUTO-RECOVERY
// Keeps a copy of every uploaded challan photo right on this phone/browser.
// If Render's server storage resets (free-tier sleep/restart), this device
// automatically re-uploads any photo missing from the server the next time
// the app is opened here.
// ══════════════════════════════════════════════════════════════════════════
window.sknLocalPhotoDB = (function() {
  const DB_NAME = 'sknt_local_photos';
  const STORE = 'challan_photos';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'local_key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function save(record) {
    try {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { console.warn('Local photo backup save failed:', e); return false; }
  }

  async function getAll() {
    try {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { console.warn('Local photo backup read failed:', e); return []; }
  }

  return { save, getAll };
})();

// Reads a File as base64 (for local backup before/alongside upload)
function sknFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Converts a base64 Data URL back into a File for re-upload
function sknBase64ToFile(base64, filename) {
  const [header, encoded] = base64.split('base64,');
  const mime = (header.match(/data:(.*);/) || [, 'image/jpeg'])[1];
  const bin = atob(encoded);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], filename, { type: mime });
}

// Checks this phone's local backup against the server's current image map,
// and silently re-uploads any photo the server has lost.
window.sknReconcileLocalPhotos = async function(serverImagesMap) {
  const localRecords = await window.sknLocalPhotoDB.getAll();
  if (!localRecords.length) return;

  const missing = localRecords.filter(rec => {
    const serverList = serverImagesMap[rec.challan_no] || [];
    return !serverList.some(img => String(img.id) === String(rec.image_id));
  });
  if (!missing.length) return;

  console.log(`Recovering ${missing.length} photo(s) missing from server (uploaded again from this device)...`);
  for (const rec of missing) {
    try {
      const file = sknBase64ToFile(rec.base64, rec.filename);
      const formData = new FormData();
      formData.append('challan_no', rec.challan_no);
      formData.append('files', file);
      const res = await fetch('/api/challan/upload_image', { method: 'POST', body: formData });
      const data = await res.json();
      if (!(res.ok && data.status === 'success')) {
        console.warn('Auto-recovery upload failed for', rec.filename, data.error);
      }
    } catch (e) {
      console.warn('Auto-recovery upload error for', rec.filename, e);
    }
  }
  if (typeof loadAllChallanImagesMap === 'function') await loadAllChallanImagesMap();
};

// ══════════════════════════════════════════════════════════════════════════
// BULLETPROOF GLOBAL TABLE VIEW & ZOOM ENGINE FOR ALL TABS
// ══════════════════════════════════════════════════════════════════════════
window.globalZoomStates = { as: 1.0, od: 1.0, ps: 1.0, req: 1.0, br: 1.0, oos: 1.0, ji: 1.0, jr: 1.0, fp: 1.0 };

window.switchViewMode = function(prefix, mode) {
  const tableBtn = document.getElementById(`${prefix}-btn-table-mode`);
  const cardBtn = document.getElementById(`${prefix}-btn-card-mode`);
  const wrapper = document.getElementById(`${prefix}-table-wrapper`);
  const toolbar = document.getElementById(`${prefix}-zoom-toolbar`);
  
  let listEl = document.getElementById(`${prefix}-list`);
  if (!listEl) {
    if (prefix === 'as') listEl = document.getElementById('all-stock-list');
    else if (prefix === 'od') listEl = document.getElementById('od-list');
    else if (prefix === 'ps') listEl = document.getElementById('pur-stock-list');
    else if (prefix === 'req') listEl = document.getElementById('req-report-list');
    else if (prefix === 'oos') listEl = document.getElementById('oos-report-list');
    else if (prefix === 'br') listEl = document.getElementById('br-list');
    else if (prefix === 'ji') listEl = document.getElementById('ji-list');
    else if (prefix === 'jr') listEl = document.getElementById('jr-list');
  }

  if (mode === 'table') {
    if (tableBtn) { tableBtn.classList.add("btn-primary", "active"); tableBtn.classList.remove("btn-secondary"); }
    if (cardBtn) { cardBtn.classList.add("btn-secondary"); cardBtn.classList.remove("btn-primary", "active"); }
    if (wrapper) wrapper.style.display = "block";
    if (toolbar) toolbar.style.display = "flex";
    if (listEl) listEl.style.display = "none";
  } else {
    if (cardBtn) { cardBtn.classList.add("btn-primary", "active"); cardBtn.classList.remove("btn-secondary"); }
    if (tableBtn) { tableBtn.classList.add("btn-secondary"); tableBtn.classList.remove("btn-primary", "active"); }
    if (wrapper) wrapper.style.display = "none";
    if (toolbar) toolbar.style.display = "none";
    if (listEl) listEl.style.display = "grid";
  }
};

window.zoomTable = function(prefix, delta) {
  if (!window.globalZoomStates[prefix]) window.globalZoomStates[prefix] = 1.0;
  if (delta === 0) {
    window.globalZoomStates[prefix] = 1.0;
  } else {
    window.globalZoomStates[prefix] = Math.min(Math.max(window.globalZoomStates[prefix] + delta, 0.6), 2.5);
  }
  const zoomPercent = Math.round(window.globalZoomStates[prefix] * 100) + "%";
  
  const badge = document.getElementById(`${prefix}-zoom-level`);
  if (badge) badge.textContent = zoomPercent;

  const wrapper = document.getElementById(`${prefix}-table-wrapper`);
  if (wrapper) {
    wrapper.style.setProperty("--table-zoom-scale", window.globalZoomStates[prefix].toString());
  }
};

window.syncTableViewsAllTabs = function() {
  const tabMappings = [
    { printId: 'all-stock-print-table', wrapperId: 'as-table-wrapper', prefix: 'as' },
    { printId: 'od-print-table', wrapperId: 'od-table-wrapper', prefix: 'od' },
    { printId: 'pur-stock-print-table', wrapperId: 'ps-table-wrapper', prefix: 'ps' },
    { printId: 'req-report-print-table', wrapperId: 'req-table-wrapper', prefix: 'req' },
    { printId: 'oos-report-print-table', wrapperId: 'oos-table-wrapper', prefix: 'oos' },
    { printId: 'br-print-table', wrapperId: 'br-table-wrapper', prefix: 'br' },
    { printId: 'ji-print-table', wrapperId: 'ji-table-wrapper', prefix: 'ji' },
    { printId: 'jr-print-table', wrapperId: 'jr-table-wrapper', prefix: 'jr' }
  ];

  tabMappings.forEach(m => {
    const pContainer = document.getElementById(m.printId);
    const wrapper = document.getElementById(m.wrapperId);
    if (pContainer && wrapper) {
      const origTable = pContainer.querySelector('table');
      if (origTable) {
        wrapper.innerHTML = origTable.outerHTML;
        const newTable = wrapper.querySelector('table');
        if (newTable) {
          newTable.className = "br-table print-table";
          newTable.style.width = "100%";
        }
      }
    }
  });
};

document.addEventListener("DOMContentLoaded", () => {
  // --- Global App State ---
  let currentActiveTab = "home";
  let activeSlipId = null;
  let activeSlipParty = null;
  let activeSlipGroup = null;
  let activeSlipHaste = null;
  let allSlips = [];
  let allReportData = [];
  let allOosData = [];
  let allStockData = [];
  let allOrderDetails = [];
  let currentSlipItemKeys = new Set();
  let allPackTypes = [];


  // Auto Date Masking Function: Allows user to type ONLY DIGITS and auto-inserts '/' slashes
  function applyAutoDateMask(inputEl) {
    if (!inputEl) return;
    inputEl.setAttribute("placeholder", "DD/MM/YYYY");
    
    inputEl.addEventListener("input", (e) => {
      let cursorPosition = inputEl.selectionStart;
      let rawVal = inputEl.value;
      let v = rawVal.replace(/\D/g, ""); // Digits only
      if (v.length > 8) v = v.substring(0, 8); // Max 8 digits: DDMMYYYY

      let formatted = "";
      if (v.length > 4) {
        formatted = `${v.substring(0, 2)}/${v.substring(2, 4)}/${v.substring(4)}`;
      } else if (v.length > 2) {
        formatted = `${v.substring(0, 2)}/${v.substring(2)}`;
      } else {
        formatted = v;
      }

      inputEl.value = formatted;
    });
  }

  function initDefaultDates() {
    const today = new Date();
    const currentMonth = today.getMonth() + 1; // 1 to 12
    const currentYear = today.getFullYear();

    // Financial Year Start Year (April 1st)
    const fyStartYear = currentMonth >= 4 ? currentYear : currentYear - 1;
    const fyStartDateStr = `01/04/${fyStartYear}`;

    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const todayStr = `${dd}/${mm}/${yyyy}`;

    const datePairs = [
      { fromId: "req-date-from", toId: "req-date-to" },
      { fromId: "oos-date-from", toId: "oos-date-to" },
      { fromId: "ps-date-from", toId: "ps-date-to" },
      { fromId: "br-date-from", toId: "br-date-to" },
      { fromId: "ji-date-from", toId: "ji-date-to" },
      { fromId: "jr-date-from", toId: "jr-date-to" }
    ];

    datePairs.forEach(pair => {
      const fromEl = document.getElementById(pair.fromId);
      const toEl = document.getElementById(pair.toId);
      if (fromEl) fromEl.value = fyStartDateStr;
      if (toEl) toEl.value = todayStr;
    });

    const slipDateEl = document.getElementById("slip-date");
    if (slipDateEl) slipDateEl.value = todayStr;

    // Attach auto date mask to ALL date inputs across all tabs
    document.querySelectorAll('input[id*="date"], input.date-mask').forEach(input => {
      applyAutoDateMask(input);
    });
  }
  initDefaultDates();


  // --- UI Elements ---
  const navItems = document.querySelectorAll(".nav-item");
  const viewSections = document.querySelectorAll(".view-section");
  const badgeSqlite = document.getElementById("badge-sqlite");
  const badgeSqlserver = document.getElementById("badge-sqlserver");
  
  // Dashboard Elements
  const statSlips = document.getElementById("stat-slips");
  const statSqlitePath = document.getElementById("stat-sqlite-path");
  const statServerStatus = document.getElementById("stat-server-status");
  const statServerMessage = document.getElementById("stat-server-message");
  
  // Modals
  const modalAddSlip = document.getElementById("modal-add-slip");
  const modalAddItem = document.getElementById("modal-add-item");
  const modalEditItem = document.getElementById("modal-edit-item");

  // Navigation Logic
  const drawerMenuItems = document.querySelectorAll(".menu-item");

  function switchTab(tabId) {
    currentActiveTab = tabId;
    navItems.forEach(item => {
      item.classList.toggle("active", item.getAttribute("data-tab") === tabId);
    });
    if (drawerMenuItems) {
      drawerMenuItems.forEach(item => {
        item.classList.toggle("active", item.getAttribute("data-tab") === tabId);
      });
    }
    viewSections.forEach(view => {
      view.classList.toggle("active", view.id === `view-${tabId}`);
    });
    
    // Fetch data accordingly
    if (tabId === "home") {
      loadDashboard();
    } else if (tabId === "slips") {
      loadPackingSlips();
    } else if (tabId === "settings") {
      loadSettings();
    } else if (tabId === "all-stock") {
      loadAllStock();
    } else if (tabId === "purchase-stock") {
      loadPurchaseStock();
    } else if (tabId === "oos-report") {
      loadOosReport();
    } else if (tabId === "bill-report") {
      loadBillReport();
    } else if (tabId === "order-details") {
      loadOrderDetails();
    } else if (tabId === "job-issue") {
      loadJobIssueReport();
    } else if (tabId === "job-reprocess") {
      loadJobReprocessReport();
    } else if (tabId === "folding-payment") {
      loadFoldingPayment();
    } else if (tabId === "req") {
      const btnGen = document.getElementById("btn-generate-req");
      if (btnGen) btnGen.click();
    }
  }

  navItems.forEach(item => {
    item.addEventListener("click", () => {
      switchTab(item.getAttribute("data-tab"));
    });
  });

  if (drawerMenuItems) {
    drawerMenuItems.forEach(item => {
      item.addEventListener("click", () => {
        switchTab(item.getAttribute("data-tab"));
        closeDrawer();
      });
    });
  }

  // Action Buttons Quick Links
  document.getElementById("quick-new-slip").addEventListener("click", () => {
    switchTab("slips");
    openAddSlipModal();
  });
  document.getElementById("quick-view-req").addEventListener("click", () => switchTab("req"));
  const quickEditSettings = document.getElementById("quick-edit-settings");
  if (quickEditSettings) {
    quickEditSettings.addEventListener("click", () => switchTab("settings"));
  }
  const quickJobIssue = document.getElementById("quick-job-issue");
  if (quickJobIssue) {
    quickJobIssue.addEventListener("click", () => switchTab("job-issue"));
  }
  const quickJobReprocess = document.getElementById("quick-job-reprocess");
  if (quickJobReprocess) {
    quickJobReprocess.addEventListener("click", () => switchTab("job-reprocess"));
  }

  // Drawer Control (Simple responsive side-nav overlay)
  const appDrawer = document.getElementById("app-drawer");
  const drawerOverlay = document.getElementById("drawer-overlay");
  const btnCloseDrawer = document.getElementById("btn-close-drawer");
  const btnOpenDrawer = document.getElementById("btn-open-drawer");
  
  function closeDrawer() {
    appDrawer.classList.remove("active");
    drawerOverlay.classList.remove("active");
  }

  if (btnOpenDrawer) {
    btnOpenDrawer.addEventListener("click", () => {
      appDrawer.classList.add("active");
      drawerOverlay.classList.add("active");
    });
  }

  if (btnCloseDrawer) {
    btnCloseDrawer.addEventListener("click", closeDrawer);
  }
  if (drawerOverlay) {
    drawerOverlay.addEventListener("click", closeDrawer);
  }

  // --- Modal Helpers ---
  function openModal(modal) {
    modal.classList.add("active");
  }
  function closeModal(modal) {
    modal.classList.remove("active");
  }

  function openAddSlipModal() {
    if (typeof loadPartiesAndGroups === "function") loadPartiesAndGroups();
    
    // Auto-fetch next slip no
    fetch('/api/slips/next_no' + ('/api/slips/next_no'.includes('?') ? '&' : '?') + '_t=' + Date.now())
      .then(res => res.json())
      .then(data => {
        if (data.next_slip_no) {
          document.getElementById("slip-no").value = data.next_slip_no;
        }
      })
      .catch(err => console.warn("Failed to fetch next slip no:", err));

    // Reset date to today's date
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    document.getElementById("slip-date").value = `${dd}/${mm}/${yyyy}`;

    // Reset segmented toggle to party
    document.getElementById("slip-type-party").checked = true;
    document.getElementById("slip-group-container").style.display = "none";
    document.getElementById("slip-group").value = "";
    if (document.getElementById("slip-group").required) {
      document.getElementById("slip-group").required = false;
    }
    
    openModal(modalAddSlip);
  }

  document.getElementById("modal-add-slip-close").addEventListener("click", () => closeModal(modalAddSlip));
  document.getElementById("modal-add-item-close").addEventListener("click", () => closeModal(modalAddItem));
  document.getElementById("modal-edit-item-close").addEventListener("click", () => closeModal(modalEditItem));
  document.getElementById("btn-add-slip").addEventListener("click", () => {
    openAddSlipModal();
  });

  // Close modals on clicking outside content
  window.addEventListener("click", (e) => {
    if (e.target === modalAddSlip) closeModal(modalAddSlip);
    if (e.target === modalAddItem) closeModal(modalAddItem);
    if (e.target === modalEditItem) closeModal(modalEditItem);
  });

  // --- Toast Notifier ---
  function showToast(msg) {
    const toast = document.getElementById("toast");
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 2500);
  }

  // --- 1. Load Dashboard Status ---
  function loadDashboard() {
    const bSqlite = document.getElementById("badge-sqlite");
    const bSqlserver = document.getElementById("badge-sqlserver");
    const sSlips = document.getElementById("stat-slips");
    const sPath = document.getElementById("stat-sqlite-path");
    const sStatus = document.getElementById("stat-server-status");
    const sMsg = document.getElementById("stat-server-message");

    fetch('/api/dashboard?_t=' + Date.now())
      .then(res => res.json())
      .then(data => {
        // SQLite indicators
        if (data.sqlite_status === "Online") {
          if (bSqlite) bSqlite.className = "badge badge-online";
          if (sSlips) sSlips.textContent = data.packing_slips_count !== undefined ? data.packing_slips_count : "0";
        } else {
          if (bSqlite) bSqlite.className = "badge badge-offline";
          if (sSlips) sSlips.textContent = "Error";
        }
        if (sPath) sPath.textContent = `Path: ${data.sqlite_path || 'Local'}`;

        // Last Sync Time indicators
        if (data.last_sync_time) {
          const syncTxt = "Last Synced: " + data.last_sync_time;
          const el1 = document.getElementById("cloud-sync-last-time");
          const el2 = document.getElementById("header-sync-time");
          if (el1) el1.innerText = syncTxt;
          if (el2) el2.innerText = "Sync: " + data.last_sync_time;
        }

        // SQL Server indicators
        if (data.sql_server_status === "Online") {
          if (bSqlserver) bSqlserver.className = "badge badge-online";
          if (sStatus) {
            sStatus.textContent = "Connected";
            sStatus.className = "card-value text-success";
          }
          if (sMsg) sMsg.textContent = `${data.sql_server_details?.server || ''} \\ ${data.sql_server_details?.database || ''}`;
        } else {
          if (bSqlserver) bSqlserver.className = "badge badge-offline";
          if (sStatus) {
            sStatus.textContent = "Offline";
            sStatus.className = "card-value text-danger";
          }
          if (sMsg) sMsg.textContent = data.sql_server_message || "Disconnected";
        }
      })
      .catch(err => {
        console.error("Dashboard fetch error:", err);
        if (bSqlite) bSqlite.className = "badge badge-offline";
        if (bSqlserver) bSqlserver.className = "badge badge-offline";
        if (sStatus) {
          sStatus.textContent = "Offline";
          sStatus.className = "card-value text-danger";
        }
        if (sMsg) sMsg.textContent = "Failed to connect to server";
      });
  }

  // --- 2. Load & Search Packing Slips ---
  function loadPackingSlips() {
    const listContainer = document.getElementById("slips-list");
    listContainer.innerHTML = `
      <div class="loading-state">
        <i class="fa-solid fa-circle-notch fa-spin"></i> Loading Slips...
      </div>`;

    fetch('/api/slips' + ('/api/slips'.includes('?') ? '&' : '?') + '_t=' + Date.now())
      .then(res => res.json())
      .then(data => {
        allSlips = data;
        renderSlips(allSlips);
      })
      .catch(err => {
        listContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Failed to load packing slips</p></div>`;
      });
  }

  function renderSlips(slips) {
    const listContainer = document.getElementById("slips-list");
    if (slips.length === 0) {
      listContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>No packing slips found</p></div>`;
      return;
    }

    listContainer.innerHTML = "";
    slips.forEach(slip => {
      const card = document.createElement("div");
      card.className = "list-card";
      card.innerHTML = `
        <div class="list-card-left">
          <span class="list-card-title">${slip.party}</span>
          <span class="list-card-sub">Slip No: ${slip.slip_no || 'None'} | Group: ${slip.group_name || 'None'}</span>
        </div>
        <div class="list-card-right">
          <span class="list-card-date">${slip.slip_date}</span>
          <span class="badge badge-info">${slip.view_type}</span>
        </div>`;
      card.addEventListener("click", () => {
        showSlipDetail(slip.id);
      });
      listContainer.appendChild(card);
    });
  }

  // Live filter packing slips
  document.getElementById("slip-search-input").addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase().trim();
    const filtered = allSlips.filter(slip => 
      slip.party.toLowerCase().includes(query) || 
      (slip.slip_no && slip.slip_no.toLowerCase().includes(query)) ||
      (slip.group_name && slip.group_name.toLowerCase().includes(query))
    );
    renderSlips(filtered);
  });

  // --- 3. View Packing Slip Details ---
  function showSlipDetail(slipId) {
    activeSlipId = slipId;
    switchTab("slip-detail");
    
    const itemsList = document.getElementById("slip-items-list");
    itemsList.innerHTML = `<div class="loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading items...</div>`;

    fetch(`/api/slips/${slipId}`)
      .then(res => res.json())
      .then(data => {
        const slip = data.slip;
        activeSlipParty = slip.party;
        activeSlipGroup = slip.group_name;
        activeSlipHaste = slip.haste;
        
        // Bind Meta Details
        document.getElementById("detail-slip-no").textContent = slip.slip_no || "-";
        document.getElementById("detail-slip-date").textContent = slip.slip_date || "-";
        document.getElementById("detail-party").textContent = slip.party || "-";
        document.getElementById("detail-group-name").textContent = slip.group_name || "-";
        if (document.getElementById("detail-haste")) {
          document.getElementById("detail-haste").textContent = slip.haste || "-";
        }
        document.getElementById("detail-view-type").textContent = slip.view_type || "-";
        document.getElementById("detail-remarks").textContent = slip.remarks || "-";

        // Render Pack Types in Modal Dropdown
        allPackTypes = data.pack_types || [];
        const packSelect = document.getElementById("item-pack-type");
        packSelect.innerHTML = "";
        allPackTypes.forEach(pt => {
          const opt = document.createElement("option");
          opt.value = pt;
          opt.textContent = pt;
          packSelect.appendChild(opt);
        });

        // Render Items
        currentSlipItemKeys = new Set(data.items.map(item => `${(item.order_no || '').toUpperCase()}||${(item.item_name || '').toUpperCase()}`));
        renderSlipItems(data.items);
      })
      .catch(err => {
        itemsList.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Failed to load slip details</p></div>`;
      });
  }

  function renderSlipItems(items) {
    const itemsList = document.getElementById("slip-items-list");
    if (items.length === 0) {
      itemsList.innerHTML = `<div class="empty-state"><i class="fa-solid fa-box"></i><p>No items added yet</p></div>`;
      return;
    }

    itemsList.innerHTML = "";
    items.forEach(item => {
      const card = document.createElement("div");
      card.className = "item-list-card";
      card.innerHTML = `
        <div class="item-title-row">
          <span>${item.item_name}</span>
          <div style="display: flex; gap: 10px; align-items: center;">
            <button class="btn-icon-edit" data-id="${item.id}" style="background: none; border: none; color: var(--primary); cursor: pointer; font-size: 14px;"><i class="fa-solid fa-pen-to-square"></i></button>
            <button class="btn-icon-delete" data-id="${item.id}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
        <div class="item-sub-details">
          <div class="grid-cell" data-label="Order"><span class="grid-cell-label">Order</span><span class="grid-cell-val">${item.order_pcs}</span></div>
          <div class="grid-cell" data-label="Stock"><span class="grid-cell-label">Stock</span><span class="grid-cell-val">${item.stock_pcs}</span></div>
          <div class="grid-cell" data-label="Balance"><span class="grid-cell-label">Balance</span><span class="grid-cell-val">${item.bal_pcs}</span></div>
          <div class="grid-cell" data-label="Pack"><span class="grid-cell-label">Pack</span><span class="grid-cell-val">${item.pack_pcs} ${item.pack_type}</span></div>
        </div>`;
      
      card.querySelector(".btn-icon-edit").addEventListener("click", (e) => {
        e.stopPropagation();
        openEditItemModal(item);
      });
      card.querySelector(".btn-icon-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        if(confirm("Delete this item?")) {
          deleteSlipItem(item.id);
        }
      });
      itemsList.appendChild(card);
    });

    // Generate print table
    const printTableContainer = document.getElementById("slip-print-table");
    if (printTableContainer) {
      const slipNo = document.getElementById("detail-slip-no").textContent;
      const slipDate = document.getElementById("detail-slip-date").textContent;
      const party = document.getElementById("detail-party").textContent;
      const group = document.getElementById("detail-group-name").textContent;
      const haste = document.getElementById("detail-haste") ? document.getElementById("detail-haste").textContent : "-";
      const viewType = document.getElementById("detail-view-type").textContent;
      const remarks = document.getElementById("detail-remarks").textContent;

      let tableHtml = `
        <div class="print-header">
          <div class="print-title">Sri Khatu Naresh Textile</div>
          <div class="print-subtitle">Packing Slip Details Report</div>
          
          <div class="print-meta-grid">
            <div class="print-meta-item"><span class="print-meta-label">Slip No:</span><span class="print-meta-value">${slipNo}</span></div>
            <div class="print-meta-item"><span class="print-meta-label">Date:</span><span class="print-meta-value">${slipDate}</span></div>
            <div class="print-meta-item"><span class="print-meta-label">Party Name:</span><span class="print-meta-value" style="font-weight: 700;">${party}</span></div>
            <div class="print-meta-item"><span class="print-meta-label">Group Name:</span><span class="print-meta-value">${group}</span></div>
            <div class="print-meta-item"><span class="print-meta-label">Haste (Broker):</span><span class="print-meta-value">${haste}</span></div>
            <div class="print-meta-item"><span class="print-meta-label">Selection Type:</span><span class="print-meta-value">${viewType}</span></div>
          </div>
          ${remarks && remarks !== "-" ? `<div style="margin-top: 8px; font-size: 11px; font-style: italic;"><strong>Remarks:</strong> ${remarks}</div>` : ""}
        </div>
        <table class="print-table">
          <thead>
            <tr>
              <th style="width: 5%;">#</th>
              <th style="width: 45%;">Item Name</th>
              <th style="width: 12%;">Order Pcs</th>
              <th style="width: 12%;">Stock Pcs</th>
              <th style="width: 12%;">Balance Pcs</th>
              <th style="width: 14%;">Packed Pcs</th>
            </tr>
          </thead>
          <tbody>
      `;
      
      items.forEach((item, idx) => {
        tableHtml += `
          <tr>
            <td>${idx + 1}</td>
            <td style="font-weight: bold;">${item.item_name}</td>
            <td>${item.order_pcs}</td>
            <td>${item.stock_pcs}</td>
            <td>${item.bal_pcs}</td>
            <td style="font-weight: bold; color: #1e70e6;">${item.pack_pcs} ${item.pack_type || 'PCS'}</td>
          </tr>
        `;
      });
      
      tableHtml += `
          </tbody>
        </table>
      `;
      printTableContainer.innerHTML = tableHtml;
    }
  }

  function openEditItemModal(item) {
    document.getElementById("edit-item-id").value = item.id;
    document.getElementById("edit-item-name-display").textContent = item.item_name;
    document.getElementById("edit-item-order-pcs").textContent = item.order_pcs;
    document.getElementById("edit-item-bal-pcs").textContent = item.bal_pcs;
    document.getElementById("edit-item-pack-pcs").value = item.pack_pcs;

    const editPackTypeSelect = document.getElementById("edit-item-pack-type");
    editPackTypeSelect.innerHTML = "";
    allPackTypes.forEach(pt => {
      const opt = document.createElement("option");
      opt.value = pt;
      opt.textContent = pt;
      editPackTypeSelect.appendChild(opt);
    });
    editPackTypeSelect.value = item.pack_type || "PCS";

    openModal(modalEditItem);
  }

  document.getElementById("form-edit-item").addEventListener("submit", (e) => {
    e.preventDefault();
    const itemId = document.getElementById("edit-item-id").value;
    const packPcs = parseFloat(document.getElementById("edit-item-pack-pcs").value) || 0.0;
    const packType = document.getElementById("edit-item-pack-type").value;

    fetch(`/api/slips/items/${itemId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pack_pcs: packPcs, pack_type: packType })
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert("Error: " + data.error);
        } else {
          closeModal(modalEditItem);
          showToast("Item updated successfully");
          if (activeSlipId) {
            showSlipDetail(activeSlipId);
          }
        }
      })
      .catch(err => {
        console.error("Failed to update item:", err);
        alert("Failed to update item quantity");
      });
  });

  document.getElementById("btn-back-to-slips").addEventListener("click", () => {
    switchTab("slips");
  });

  // Segmented toggle event handler for creating packing slips
  const slipTypeRadios = document.querySelectorAll('input[name="slip_type"]');
  const slipGroupContainer = document.getElementById("slip-group-container");
  const slipGroupSelect = document.getElementById("slip-group");

  slipTypeRadios.forEach(radio => {
    radio.addEventListener("change", (e) => {
      if (e.target.value === "group") {
        slipGroupContainer.style.display = "block";
        slipGroupSelect.required = true;
      } else {
        slipGroupContainer.style.display = "none";
        slipGroupSelect.required = false;
        slipGroupSelect.value = "";
      }
    });
  });

  // Create Packing Slip Form Submission
  document.getElementById("form-add-slip").addEventListener("submit", (e) => {
    e.preventDefault();
    const slipData = {
      party: document.getElementById("slip-party").value.trim(),
      slip_date: document.getElementById("slip-date").value.trim(),
      slip_no: document.getElementById("slip-no").value.trim(),
      group_name: document.getElementById("slip-group").value.trim(),
      haste: document.getElementById("slip-haste") ? document.getElementById("slip-haste").value.trim() : "",
      view_type: "ALL",
      remarks: document.getElementById("slip-remarks").value.trim()
    };

    fetch("/api/slips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slipData)
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
        } else {
          closeModal(modalAddSlip);
          document.getElementById("form-add-slip").reset();
          showToast(data.message || "Packing Slip Created!");
          loadPackingSlips();
          if (data.id) {
            showSlipDetail(data.id);
          }
        }
      })
      .catch(err => alert("Failed to create Packing Slip"));
  });

  // Delete Packing Slip Button
  document.getElementById("btn-delete-slip").addEventListener("click", () => {
    if (activeSlipId && confirm("Are you sure you want to delete this entire packing slip and all its items?")) {
      fetch(`/api/slips/${activeSlipId}`, { method: "DELETE" })
        .then(res => res.json())
        .then(data => {
          showToast("Packing Slip Deleted");
          switchTab("slips");
        })
        .catch(err => alert("Failed to delete Packing Slip"));
    }
  });

  // Print Packing Slip Button
  document.getElementById("btn-print-slip").addEventListener("click", () => {
    window.print();
  });

  // Tabs switching inside Add Item Modal
  const tabBtnSelect = document.getElementById("tab-btn-select-items");
  const tabBtnManual = document.getElementById("tab-btn-manual-item");
  const selectContainer = document.getElementById("modal-select-items-container");
  const manualForm = document.getElementById("form-add-item");

  if (tabBtnSelect && tabBtnManual) {
    tabBtnSelect.addEventListener("click", () => {
      tabBtnSelect.classList.add("active");
      tabBtnSelect.style.borderBottom = "2px solid var(--primary)";
      tabBtnSelect.style.color = "var(--text-main)";
      
      tabBtnManual.classList.remove("active");
      tabBtnManual.style.borderBottom = "none";
      tabBtnManual.style.color = "var(--text-sub)";
      
      selectContainer.style.display = "block";
      manualForm.style.display = "none";
    });

    tabBtnManual.addEventListener("click", () => {
      tabBtnManual.classList.add("active");
      tabBtnManual.style.borderBottom = "2px solid var(--primary)";
      tabBtnManual.style.color = "var(--text-main)";
      
      tabBtnSelect.classList.remove("active");
      tabBtnSelect.style.borderBottom = "none";
      tabBtnSelect.style.color = "var(--text-sub)";
      
      selectContainer.style.display = "none";
      manualForm.style.display = "block";
    });
  }

  // Load Pending Items from SQL Server for Select tab
  function loadPendingItemsForSelect() {
    const listContainer = document.getElementById("modal-pending-items-list");
    if (!activeSlipParty) {
      listContainer.innerHTML = `<div class="empty-state"><p>No party selected for this slip</p></div>`;
      return;
    }

    listContainer.innerHTML = `
      <div class="loading-state">
        <i class="fa-solid fa-circle-notch fa-spin"></i> Loading pending orders...
      </div>`;

    let url = `/api/parties/${encodeURIComponent(activeSlipParty)}/pending_items?slip_id=${activeSlipId}`;
    if (activeSlipGroup && activeSlipGroup.trim()) {
      url += `&group=${encodeURIComponent(activeSlipGroup.trim())}`;
    }
    if (activeSlipHaste && activeSlipHaste.trim()) {
      url += `&haste=${encodeURIComponent(activeSlipHaste.trim())}`;
    }

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          listContainer.innerHTML = `<div class="empty-state"><p class="text-danger">${data.error}</p></div>`;
          return;
        }

        // Filter out items already present in the current slip to avoid duplicates
        const filtered = data.filter(item => {
          const key = `${(item.order_no || '').toUpperCase()}||${(item.item_name || '').toUpperCase()}`;
          return !currentSlipItemKeys.has(key);
        });

        if (filtered.length === 0) {
          listContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-check-double text-success"></i><p>All items are packed or no orders found!</p></div>`;
          return;
        }

        listContainer.innerHTML = "";

        // Add Select All Row
        const selectAllRow = document.createElement("div");
        selectAllRow.className = "select-all-row";
        selectAllRow.style.display = "flex";
        selectAllRow.style.alignItems = "center";
        selectAllRow.style.padding = "8px 10px";
        selectAllRow.style.borderBottom = "1px solid var(--bg-card-border)";
        selectAllRow.style.marginBottom = "8px";
        selectAllRow.style.gap = "10px";
        selectAllRow.innerHTML = `
          <input type="checkbox" id="check-select-all-items" style="width: 18px; height: 18px; accent-color: var(--primary); cursor: pointer;">
          <label for="check-select-all-items" style="font-size: 13px; font-weight: 600; color: var(--text-main); cursor: pointer; user-select: none;">Select All Pending Items</label>
        `;
        listContainer.appendChild(selectAllRow);

        const selectAllCheck = selectAllRow.querySelector("#check-select-all-items");
        selectAllCheck.addEventListener("change", (e) => {
          const isChecked = e.target.checked;
          const checks = listContainer.querySelectorAll(".pending-item-check");
          checks.forEach(c => {
            c.checked = isChecked;
          });
        });
        filtered.forEach(item => {
          const row = document.createElement("div");
          row.className = "pending-item-row";
          row.style.display = "flex";
          row.style.alignItems = "center";
          row.style.justifyContent = "space-between";
          row.style.background = "rgba(255, 255, 255, 0.02)";
          row.style.border = "1px solid var(--bg-card-border)";
          row.style.padding = "10px";
          row.style.borderRadius = "8px";
          row.style.gap = "10px";
          row.style.marginBottom = "8px";

          row.dataset.itemJson = JSON.stringify(item);

          row.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; flex: 1;">
              <input type="checkbox" class="pending-item-check" style="width: 18px; height: 18px; accent-color: var(--primary);">
              <div style="display: flex; flex-direction: column; gap: 2px;">
                <span class="font-bold" style="font-size: 13px; color: var(--text-main);">${item.item_name}</span>
                <span style="font-size: 11px; color: var(--text-sub);">Ord: ${item.order_no} | Bal: ${item.bal_pcs} | Stock: ${item.stock_pcs}</span>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 4px; width: 80px;">
              <input type="number" class="pending-item-qty" value="${item.pack_pcs}" min="0" max="${item.bal_pcs}" style="width: 100%; padding: 4px; border: 1px solid var(--bg-card-border); border-radius: 4px; background: rgba(0,0,0,0.3); color: var(--text-main); font-size: 12px; text-align: center;">
            </div>`;
          
          listContainer.appendChild(row);
        });
      })
      .catch(err => {
        listContainer.innerHTML = `<div class="empty-state"><p class="text-danger">Failed to load pending items</p></div>`;
      });
  }

  // Modal trigger for adding items
  document.getElementById("btn-add-item-modal").addEventListener("click", () => {
    if (tabBtnSelect) tabBtnSelect.click();
    openModal(modalAddItem);
    loadPendingItemsForSelect();
  });

  // Bulk Add selected items handler
  document.getElementById("btn-add-selected-items").addEventListener("click", () => {
    if (!activeSlipId) return;

    const selectedItems = [];
    const rows = document.querySelectorAll("#modal-pending-items-list .pending-item-row");
    
    rows.forEach(row => {
      const checkbox = row.querySelector(".pending-item-check");
      if (checkbox && checkbox.checked) {
        const itemData = JSON.parse(row.dataset.itemJson);
        const qtyInput = row.querySelector(".pending-item-qty");
        const packPcs = parseFloat(qtyInput.value) || 0;
        
        itemData.pack_pcs = packPcs;
        selectedItems.push(itemData);
      }
    });

    if (selectedItems.length === 0) {
      alert("Please select at least one item first!");
      return;
    }

    fetch(`/api/slips/${activeSlipId}/items/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: selectedItems })
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
        } else {
          closeModal(modalAddItem);
          showToast(data.message || "Items added successfully");
          showSlipDetail(activeSlipId);
        }
      })
      .catch(err => alert("Failed to add selected items"));
  });

  // Add Item Form Submission
  document.getElementById("form-add-item").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!activeSlipId) return;

    const itemData = {
      item_name: document.getElementById("item-name").value.trim(),
      order_no: document.getElementById("item-order-no").value.trim(),
      order_date: document.getElementById("item-order-date").value.trim(),
      group_name: document.getElementById("item-group").value.trim(),
      order_pcs: parseFloat(document.getElementById("item-order-pcs").value) || 0,
      stock_pcs: parseFloat(document.getElementById("item-stock-pcs").value) || 0,
      bal_pcs: parseFloat(document.getElementById("item-bal-pcs").value) || 0,
      pack_pcs: parseFloat(document.getElementById("item-pack-pcs").value) || 0,
      pack_type: document.getElementById("item-pack-type").value
    };

    fetch(`/api/slips/${activeSlipId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(itemData)
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
        } else {
          closeModal(modalAddItem);
          document.getElementById("form-add-item").reset();
          showToast("Item Added");
          showSlipDetail(activeSlipId);
        }
      })
      .catch(err => alert("Failed to add item"));
  });

  function deleteSlipItem(itemId) {
    fetch(`/api/slips/items/${itemId}`, { method: "DELETE" })
      .then(res => res.json())
      .then(data => {
        showToast("Item Deleted");
        showSlipDetail(activeSlipId);
      })
      .catch(err => alert("Failed to delete item"));
  }

  // WhatsApp Share Builder
  document.getElementById("btn-share-whatsapp").addEventListener("click", () => {
    if (!activeSlipId) return;
    
    fetch(`/api/slips/${activeSlipId}`)
      .then(res => res.json())
      .then(data => {
        const slip = data.slip;
        const items = data.items;
        
        let text = `*Packing Slip details - Sri Khatu Naresh Textile*\n\n`;
        text += `*Party Name:* ${slip.party}\n`;
        text += `*Date:* ${slip.slip_date}\n`;
        if (slip.slip_no) text += `*Slip No:* ${slip.slip_no}\n`;
        if (slip.remarks) text += `*Remarks:* ${slip.remarks}\n`;
        text += `\n*Items:*\n`;
        
        items.forEach((item, index) => {
          text += `${index + 1}. *${item.item_name}*\n`;
          text += `   Order: ${item.order_pcs} | Stock: ${item.stock_pcs} | Balance: ${item.bal_pcs}\n`;
          text += `   Packed: ${item.pack_pcs} ${item.pack_type}\n\n`;
        });

        const mobilePrompt = prompt("Enter receiver's mobile number with country code (e.g. 919876543210):\n(Leave empty to select contact inside WhatsApp)");
        if (mobilePrompt === null) return; // user cancelled
        const mobile = mobilePrompt.trim().replace("+", "").replace(" ", "");
        const encoded = encodeURIComponent(text);
        const url = mobile 
          ? `https://api.whatsapp.com/send?phone=${mobile}&text=${encoded}`
          : `https://api.whatsapp.com/send?text=${encoded}`;
        window.open(url, "_blank");
      })
      .catch(err => alert("Failed to construct WhatsApp share message"));
  });

  // --- 4. REQ Procurement Report Generation ---
  const btnGenerateReq = document.getElementById("btn-generate-req");
  const reqListContainer = document.getElementById("req-report-list");

  btnGenerateReq.addEventListener("click", () => {
    const fromDate = document.getElementById("req-date-from").value.trim();
    const toDate = document.getElementById("req-date-to").value.trim();
    const includeOpening = document.getElementById("req-include-opening").checked;

    reqListContainer.innerHTML = `
      <div class="loading-state">
        <i class="fa-solid fa-rotate fa-spin"></i> Querying SQL Server...
      </div>`;
    document.getElementById("report-summary-bar").style.display = "none";

    const url = `/api/req_report?date_from=${encodeURIComponent(fromDate)}&date_to=${encodeURIComponent(toDate)}&include_opening=${includeOpening}`;
    
    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          reqListContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation text-danger"></i><p>${data.error}</p></div>`;
          return;
        }
        allReportData = data;
        window.showSnapshotBanner(data);
        filterAndRenderReqReport();
      })
      .catch(err => {
        reqListContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation text-danger"></i><p>Network / Server error occurred</p></div>`;
      });
  });

  function filterAndRenderReqReport() {
    // Auto-collapse filter card after rendering report
    const reqCard = document.getElementById("req-filter-card");
    if (reqCard) reqCard.classList.add("collapsed");

    const searchQuery = document.getElementById("req-search-input").value.toUpperCase().trim();
    const oosOnly = document.getElementById("req-oos-only") ? document.getElementById("req-oos-only").checked : false;

    let filtered = allReportData;
    if (searchQuery) {
      filtered = filtered.filter(row => row.group_name.includes(searchQuery));
    }
    if (oosOnly) {
      filtered = filtered.filter(row => row.status === "OUT OF STOCK");
    }

    if (filtered.length === 0) {
      reqListContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>No records found matching constraints</p></div>`;
      document.getElementById("report-summary-bar").style.display = "none";
      return;
    }

    reqListContainer.innerHTML = "";
    let shortages = 0;

    // Group items by latest_order_date
    const groupsByDate = {};
    const datesOrder = [];

    filtered.forEach(row => {
      if (row.status === "OUT OF STOCK") {
        shortages++;
      }
      const date = row.latest_order_date || "No Order Date";
      if (!groupsByDate[date]) {
        groupsByDate[date] = [];
        datesOrder.push(date);
      }
      groupsByDate[date].push(row);
    });

    datesOrder.forEach(date => {
      const dateHeader = document.createElement("div");
      dateHeader.className = "report-date-header";
      dateHeader.style.fontWeight = "700";
      dateHeader.style.fontSize = "13px";
      dateHeader.style.color = "#10b981";
      dateHeader.style.margin = "20px 0 10px 4px";
      dateHeader.style.borderBottom = "1px solid var(--bg-card-border)";
      dateHeader.style.paddingBottom = "6px";
      dateHeader.style.display = "flex";
      dateHeader.style.alignItems = "center";
      dateHeader.style.gap = "8px";
      dateHeader.innerHTML = `<i class="fa-solid fa-calendar-day"></i> <span>Order Date: ${date}</span>`;
      reqListContainer.appendChild(dateHeader);

      groupsByDate[date].forEach(row => {
        const card = document.createElement("div");
        let badgeClass = "badge-available";
        let statusCardClass = "card-available";
        if (row.status === "EXACT") {
          badgeClass = "badge-exact";
          statusCardClass = "card-exact";
        } else if (row.status === "OUT OF STOCK") {
          badgeClass = "badge-oos";
          statusCardClass = "card-oos";
        }
        card.className = `report-card ${statusCardClass}`;
        
        card.innerHTML = `
          <div class="report-header-row">
            <span class="font-bold">${row.group_name}</span>
            <span class="badge ${badgeClass}">${row.status}</span>
          </div>
          <div class="report-details-grid">
            <div class="grid-cell" data-label="Order"><span class="grid-cell-label">Order</span><span class="grid-cell-val">${row.order_pcs}</span></div>
            <div class="grid-cell" data-label="Stock"><span class="grid-cell-label">Stock</span><span class="grid-cell-val">${row.stock_pcs}</span></div>
            <div class="grid-cell" data-label="Job Iss"><span class="grid-cell-label">Job Iss</span><span class="grid-cell-val">${row.job_issue_pcs}</span></div>
            <div class="grid-cell" data-label="Job Rep"><span class="grid-cell-label">Job Rep</span><span class="grid-cell-val">${row.job_reprocess_pcs}</span></div>
          </div>
          <div class="meta-row" style="margin-top: 4px; font-size: 11px;">
            <span class="meta-label">Procurement Requirement:</span>
            <span class="meta-value ${row.req_pcs > 0 ? 'text-danger' : 'text-success'}">${row.req_pcs} Pcs</span>
          </div>`;
        
        reqListContainer.appendChild(card);
      });
    });

    
    // Populate High-Contrast Table View directly (Same as Sale Bill Report)
    const reqWrapper = document.getElementById("req-table-wrapper");
    if (reqWrapper) {
      let reqTableHtml = `<table class="br-table print-table">
        <thead>
          <tr>
            <th>#</th>
            <th>GROUP NAME</th>
            <th>ORDER DATE</th>
            <th style="text-align:right;">ORDER PCS</th>
            <th style="text-align:right;">STOCK PCS</th>
            <th style="text-align:right;">JOB ISSUE</th>
            <th style="text-align:right;">JOB REPROC</th>
            <th style="text-align:right;">REQ SHORTAGE</th>
            <th style="text-align:center;">STATUS</th>
          </tr>
        </thead>
        <tbody>`;
      
      let rIdx = 1;
      datesOrder.forEach(date => {
        reqTableHtml += `<tr class="br-group-header-row"><td colspan="9"><i class="fa-solid fa-calendar-day"></i> Order Date : ${date}</td></tr>`;
        groupsByDate[date].forEach(row => {
          let statusColor = row.status === "OUT OF STOCK" ? "#ef4444" : (row.status === "EXACT" ? "#3b82f6" : "#10b981");
          reqTableHtml += `
            <tr>
              <td>${rIdx++}</td>
              <td class="cell-group" style="font-weight:700; color:#1e40af;">${row.group_name}</td>
              <td>${row.latest_order_date || "-"}</td>
              <td style="text-align:right;">${row.order_pcs}</td>
              <td style="text-align:right;">${row.stock_pcs}</td>
              <td style="text-align:right;">${row.job_issue_pcs}</td>
              <td style="text-align:right;">${row.job_reprocess_pcs}</td>
              <td style="text-align:right; font-weight:700; color:#ef4444;">${row.req_pcs} Pcs</td>
              <td style="text-align:center;"><span class="badge" style="background:${statusColor}; color:#fff;">${row.status}</span></td>
            </tr>
          `;
        });
      });
      reqTableHtml += `</tbody></table>`;
      reqWrapper.innerHTML = reqTableHtml;
    }

    // Generate print table
    const printTableContainer = document.getElementById("req-print-table");
    if (printTableContainer) {
      let tableHtml = `
        <div class="print-header">
          <div class="print-title">Sri Khatu Naresh Textile</div>
          <div class="print-subtitle">REQ Procurement Report — Generated on ${new Date().toLocaleDateString('en-GB')}</div>
        </div>
        <table class="print-table">
          <thead>
            <tr>
              <th style="width: 5%;">#</th>
              <th style="width: 25%;">Group Name</th>
              <th style="width: 15%;">Order Date</th>
              <th style="width: 12%;">Order Pcs</th>
              <th style="width: 12%;">Stock Pcs</th>
              <th style="width: 10%;">Job Issue</th>
              <th style="width: 10%;">Job Reproc</th>
              <th style="width: 11%;">Required Pcs</th>
            </tr>
          </thead>
          <tbody>
      `;
      
      let printIdx = 1;
      datesOrder.forEach(date => {
        groupsByDate[date].forEach(row => {
          const isOos = row.status === "OUT OF STOCK";
          const reqColor = isOos ? "color: #ef4444; font-weight: bold;" : "color: #10b981;";
          tableHtml += `
            <tr>
              <td>${printIdx++}</td>
              <td style="font-weight: bold;">${row.group_name}</td>
              <td>${row.latest_order_date || "-"}</td>
              <td>${row.order_pcs}</td>
              <td>${row.stock_pcs}</td>
              <td>${row.job_issue_pcs}</td>
              <td>${row.job_reprocess_pcs}</td>
              <td style="${reqColor}">${row.req_pcs} Pcs</td>
            </tr>
          `;
        });
      });
      
      tableHtml += `
          </tbody>
        </table>
      `;
      printTableContainer.innerHTML = tableHtml;
    }

    // Render Stats Bar
    document.getElementById("report-summary-bar").style.display = "flex";
    document.getElementById("req-total-groups").textContent = filtered.length;
    document.getElementById("req-total-shortages").textContent = shortages;
  }

  // Live filter REQ Report
  document.getElementById("req-search-input").addEventListener("input", filterAndRenderReqReport);
  if (document.getElementById("req-oos-only")) {
    document.getElementById("req-oos-only").addEventListener("change", filterAndRenderReqReport);
  }

  // --- OOS Report Functions ---
  const btnGenerateOos = document.getElementById("btn-generate-oos");
  const oosListContainer = document.getElementById("oos-report-list");

  function loadOosReport() {
    generateOosReport();
  }

  function generateOosReport() {
    const fromDate = document.getElementById("oos-date-from").value.trim();
    const toDate = document.getElementById("oos-date-to").value.trim();
    const includeOpening = document.getElementById("oos-include-opening").checked;

    if (oosListContainer) {
      oosListContainer.innerHTML = `
        <div class="loading-state">
          <i class="fa-solid fa-rotate fa-spin"></i> Querying SQL Server...
        </div>`;
    }
    const summaryBar = document.getElementById("oos-summary-bar");
    if (summaryBar) summaryBar.style.display = "none";

    const url = `/api/req_report?date_from=${encodeURIComponent(fromDate)}&date_to=${encodeURIComponent(toDate)}&include_opening=${includeOpening}`;
    
    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          if (oosListContainer) {
            oosListContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation text-danger"></i><p>${data.error}</p></div>`;
          }
          return;
        }
        allOosData = data.filter(row => row.status === "OUT OF STOCK");
        filterAndRenderOosReport();
      })
      .catch(err => {
        if (oosListContainer) {
          oosListContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation text-danger"></i><p>Network / Server error occurred</p></div>`;
        }
      });
  }

  function filterAndRenderOosReport() {
    // Auto-collapse filter card after rendering report
    const oosCard = document.getElementById("oos-filter-card");
    if (oosCard) oosCard.classList.add("collapsed");

    if (!oosListContainer) return;

    const searchQuery = document.getElementById("oos-search-input").value.toUpperCase().trim();

    let filtered = allOosData;
    if (searchQuery) {
      filtered = filtered.filter(row => row.group_name.includes(searchQuery));
    }

    if (filtered.length === 0) {
      oosListContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>No out of stock records found</p></div>`;
      document.getElementById("oos-summary-bar").style.display = "none";
      return;
    }

    oosListContainer.innerHTML = "";

    // Group items by latest_order_date
    const groupsByDate = {};
    const datesOrder = [];

    filtered.forEach(row => {
      const date = row.latest_order_date || "No Order Date";
      if (!groupsByDate[date]) {
        groupsByDate[date] = [];
        datesOrder.push(date);
      }
      groupsByDate[date].push(row);
    });

    datesOrder.forEach(date => {
      const dateHeader = document.createElement("div");
      dateHeader.className = "report-date-header";
      dateHeader.style.fontWeight = "700";
      dateHeader.style.fontSize = "13px";
      dateHeader.style.color = "#ef4444";
      dateHeader.style.margin = "20px 0 10px 4px";
      dateHeader.style.borderBottom = "1px solid var(--bg-card-border)";
      dateHeader.style.paddingBottom = "6px";
      dateHeader.style.display = "flex";
      dateHeader.style.alignItems = "center";
      dateHeader.style.gap = "8px";
      dateHeader.innerHTML = `<i class="fa-solid fa-calendar-day"></i> <span>Order Date: ${date}</span>`;
      oosListContainer.appendChild(dateHeader);

      groupsByDate[date].forEach(row => {
        const card = document.createElement("div");
        card.className = "report-card card-oos";

        card.innerHTML = `
          <div class="report-header-row">
            <span class="font-bold">${row.group_name}</span>
            <span class="badge badge-oos">${row.status}</span>
          </div>
          <div class="report-details-grid">
            <div class="grid-cell" data-label="Order"><span class="grid-cell-label">Order</span><span class="grid-cell-val">${row.order_pcs}</span></div>
            <div class="grid-cell" data-label="Stock"><span class="grid-cell-label">Stock</span><span class="grid-cell-val">${row.stock_pcs}</span></div>
            <div class="grid-cell" data-label="Job Iss"><span class="grid-cell-label">Job Iss</span><span class="grid-cell-val">${row.job_issue_pcs}</span></div>
            <div class="grid-cell" data-label="Job Rep"><span class="grid-cell-label">Job Rep</span><span class="grid-cell-val">${row.job_reprocess_pcs}</span></div>
          </div>
          <div class="meta-row" style="margin-top: 4px; font-size: 11px;">
            <span class="meta-label">Procurement Requirement:</span>
            <span class="meta-value text-danger">${row.req_pcs} Pcs</span>
          </div>`;
        
        oosListContainer.appendChild(card);
      });
    });

    
    // Populate High-Contrast Table View directly (Same as Sale Bill Report)
    const oosWrapper = document.getElementById("oos-table-wrapper");
    if (oosWrapper) {
      let oosTableHtml = `<table class="br-table print-table">
        <thead>
          <tr style="background:#ef4444 !important; color:#fff;">
            <th>#</th>
            <th>GROUP NAME</th>
            <th>ORDER DATE</th>
            <th style="text-align:right;">ORDER PCS</th>
            <th style="text-align:right;">STOCK PCS</th>
            <th style="text-align:right;">JOB ISSUE</th>
            <th style="text-align:right;">JOB REPROCESS</th>
            <th style="text-align:right;">SHORTAGE PCS</th>
          </tr>
        </thead>
        <tbody>`;
      
      let oIdx = 1;
      datesOrder.forEach(date => {
        oosTableHtml += `<tr class="br-group-header-row" style="background:#fee2e2 !important; color:#991b1b !important;"><td colspan="8"><i class="fa-solid fa-calendar-day"></i> Order Date : ${date}</td></tr>`;
        groupsByDate[date].forEach(row => {
          oosTableHtml += `
            <tr>
              <td>${oIdx++}</td>
              <td class="cell-group" style="font-weight:700; color:#dc2626;">${row.group_name}</td>
              <td>${row.latest_order_date || "-"}</td>
              <td style="text-align:right;">${row.order_pcs}</td>
              <td style="text-align:right;">${row.stock_pcs}</td>
              <td style="text-align:right;">${row.job_issue_pcs}</td>
              <td style="text-align:right;">${row.job_reprocess_pcs}</td>
              <td style="text-align:right; font-weight:700; color:#dc2626;">${row.req_pcs} Pcs</td>
            </tr>
          `;
        });
      });
      oosTableHtml += `</tbody></table>`;
      oosWrapper.innerHTML = oosTableHtml;
    }

    // Generate print table
    const printTableContainer = document.getElementById("oos-print-table");
    if (printTableContainer) {
      let tableHtml = `
        <div class="print-header">
          <div class="print-title" style="color: #ef4444 !important;">Sri Khatu Naresh Textile</div>
          <div class="print-subtitle">OOS Report (Shortages) — Generated on ${new Date().toLocaleDateString('en-GB')}</div>
        </div>
        <table class="print-table">
          <thead>
            <tr>
              <th style="width: 5%; background-color: #ef4444 !important; border: 1px solid #b91c1c !important;">#</th>
              <th style="width: 25%; background-color: #ef4444 !important; border: 1px solid #b91c1c !important;">Group Name</th>
              <th style="width: 14%; background-color: #ef4444 !important; border: 1px solid #b91c1c !important;">Order Date</th>
              <th style="width: 11%; background-color: #ef4444 !important; border: 1px solid #b91c1c !important;">Order Pcs</th>
              <th style="width: 11%; background-color: #ef4444 !important; border: 1px solid #b91c1c !important;">Stock Pcs</th>
              <th style="width: 11%; background-color: #ef4444 !important; border: 1px solid #b91c1c !important;">Job Issue</th>
              <th style="width: 11%; background-color: #ef4444 !important; border: 1px solid #b91c1c !important;">Job Reprocess</th>
              <th style="width: 12%; background-color: #ef4444 !important; border: 1px solid #b91c1c !important;">Shortage Pcs</th>
            </tr>
          </thead>
          <tbody>
      `;
      
      let printIdx = 1;
      datesOrder.forEach(date => {
        groupsByDate[date].forEach(row => {
          tableHtml += `
            <tr>
              <td>${printIdx++}</td>
              <td style="font-weight: bold; color: #ef4444;">${row.group_name}</td>
              <td>${row.latest_order_date || "-"}</td>
              <td>${row.order_pcs}</td>
              <td>${row.stock_pcs}</td>
              <td>${row.job_issue_pcs}</td>
              <td>${row.job_reprocess_pcs}</td>
              <td style="color: #ef4444; font-weight: bold;">${row.req_pcs} Pcs</td>
            </tr>
          `;
        });
      });

      
      tableHtml += `
          </tbody>
        </table>
      `;
      printTableContainer.innerHTML = tableHtml;
    }

    // Render Stats Bar
    document.getElementById("oos-summary-bar").style.display = "flex";
    document.getElementById("oos-total-groups").textContent = filtered.length;
  }

  if (btnGenerateOos) {
    btnGenerateOos.addEventListener("click", generateOosReport);
  }
  const oosSearchInput = document.getElementById("oos-search-input");
  if (oosSearchInput) {
    oosSearchInput.addEventListener("input", filterAndRenderOosReport);
  }

  // --- 5. Settings Handler ---
  const settingsForm = document.getElementById("settings-form");
  const setTrustedCheck = document.getElementById("set-db-trusted");
  const authFields = document.getElementById("auth-fields");

  if (setTrustedCheck && authFields) {
    setTrustedCheck.addEventListener("change", () => {
      authFields.style.display = setTrustedCheck.checked ? "none" : "block";
    });
  }

  function loadSettings() {
    fetch('/api/settings' + ('/api/settings'.includes('?') ? '&' : '?') + '_t=' + Date.now())
      .then(res => res.json())
      .then(data => {
        document.getElementById("set-db-server").value = data.db_server || "";
        document.getElementById("set-db-name").value = data.db_name || "";
        document.getElementById("set-db-prev").value = data.db_prev || "";
        document.getElementById("set-db-user").value = data.db_user || "";
        if (setTrustedCheck) setTrustedCheck.checked = data.db_trusted;
        if (authFields) authFields.style.display = data.db_trusted ? "none" : "block";
        document.getElementById("set-lan-db-path").value = data.lan_db_path || "";
      })
      .catch(err => alert("Failed to load settings from server"));
  }

  if (settingsForm) {
    settingsForm.addEventListener("submit", (e) => {
      e.preventDefault();
    const configData = {
      db_server: document.getElementById("set-db-server").value.trim(),
      db_name: document.getElementById("set-db-name").value.trim(),
      db_prev: document.getElementById("set-db-prev").value.trim(),
      db_user: document.getElementById("set-db-user").value.trim(),
      db_password: document.getElementById("set-db-password").value.trim(),
      db_trusted: setTrustedCheck.checked,
      lan_db_path: document.getElementById("set-lan-db-path").value.trim()
    };

    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configData)
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
        } else {
          showToast("Configurations Saved!");
          loadDashboard();
        }
      })
      .catch(err => alert("Failed to save settings to server"));
    });
  }


  // ══════════════════════════════════════════════════════════════════════════
  // UNIVERSAL TABLE VIEW & ZOOM ENGINE FOR ALL TABS
  // ══════════════════════════════════════════════════════════════════════════
  const tabZoomStates = {};

  function setTabZoom(prefix, factor) {
    if (!tabZoomStates[prefix]) tabZoomStates[prefix] = 1.0;
    tabZoomStates[prefix] = Math.min(Math.max(factor, 0.6), 2.5);
    const zoomPercent = Math.round(tabZoomStates[prefix] * 100) + "%";

    const badge = document.querySelector(`.${prefix}-zoom-level`);
    if (badge) badge.textContent = zoomPercent;

    const wrapper = document.getElementById(`${prefix}-table-wrapper`);
    if (wrapper) {
      wrapper.style.setProperty("--table-zoom-scale", tabZoomStates[prefix].toString());
    }
  }

  ['as', 'od', 'ps', 'req', 'br', 'oos'].forEach(prefix => {
    tabZoomStates[prefix] = 1.0;

    document.querySelector(`.${prefix}-btn-zoom-in`)?.addEventListener("click", () => {
      setTabZoom(prefix, tabZoomStates[prefix] + 0.15);
    });
    document.querySelector(`.${prefix}-btn-zoom-out`)?.addEventListener("click", () => {
      setTabZoom(prefix, tabZoomStates[prefix] - 0.15);
    });
    document.querySelector(`.${prefix}-btn-zoom-reset`)?.addEventListener("click", () => {
      setTabZoom(prefix, 1.0);
    });

    const wrapper = document.getElementById(`${prefix}-table-wrapper`);
    if (wrapper) {
      wrapper.addEventListener("wheel", (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          setTabZoom(prefix, tabZoomStates[prefix] + (e.deltaY < 0 ? 0.1 : -0.1));
        }
      }, { passive: false });
    }
  });

  // Global Sync Function to copy printable table into visible table wrapper for ALL TABS
  window.syncTableViewsAllTabs = function() {
    const tabMappings = [
      { printId: 'all-stock-print-table', wrapperId: 'as-table-wrapper' },
      { printId: 'od-print-table', wrapperId: 'od-table-wrapper' },
      { printId: 'pur-stock-print-table', wrapperId: 'ps-table-wrapper' },
      { printId: 'req-report-print-table', wrapperId: 'req-table-wrapper' },
      { printId: 'oos-report-print-table', wrapperId: 'oos-table-wrapper' }
    ];

    tabMappings.forEach(m => {
      const pContainer = document.getElementById(m.printId);
      const wrapper = document.getElementById(m.wrapperId);
      if (pContainer && wrapper) {
        const table = pContainer.querySelector('table');
        if (table) {
          wrapper.innerHTML = table.outerHTML;
          const tEl = wrapper.querySelector('table');
          if (tEl) {
            tEl.className = "br-table print-table";
            tEl.style.width = "100%";
          }
        }
      }
    });
  };

  // --- Initial Startup ---
  // Default to today's date for 'To Date'
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  document.getElementById("req-date-to").value = `${dd}/${mm}/${yyyy}`;
  const oosDateToInput = document.getElementById("oos-date-to");
  if (oosDateToInput) {
    oosDateToInput.value = `${dd}/${mm}/${yyyy}`;
  }
  document.getElementById("slip-date").value = `${dd}/${mm}/${yyyy}`;

  // Fetch parties and groups list for autocomplete suggestions
  function loadPartiesAndGroups() {
    fetch('/api/parties' + ('/api/parties'.includes('?') ? '&' : '?') + '_t=' + Date.now())
      .then(res => res.json())
      .then(data => {
        // Populate standard datalist
        const datalist = document.getElementById("parties-datalist");
        if (datalist) {
          datalist.innerHTML = "";
          data.forEach(party => {
            const option = document.createElement("option");
            option.value = party;
            datalist.appendChild(option);
          });
        }

        // Populate Order Details Party selection dropdown
        const odPartySelect = document.getElementById("od-party");
        if (odPartySelect) {
          odPartySelect.innerHTML = '<option value="">All Parties</option>';
          data.forEach(party => {
            const option = document.createElement("option");
            option.value = party;
            option.textContent = party;
            odPartySelect.appendChild(option);
          });
        }
      })
      .catch(err => console.warn("Failed to load parties datalist:", err));

    fetch('/api/groups' + ('/api/groups'.includes('?') ? '&' : '?') + '_t=' + Date.now())
      .then(res => res.json())
      .then(data => {
        // Populate standard datalist
        const datalist = document.getElementById("groups-datalist");
        if (datalist) {
          datalist.innerHTML = "";
          data.forEach(group => {
            const option = document.createElement("option");
            option.value = group;
            datalist.appendChild(option);
          });
        }

        // Populate Slip modal Group selection dropdown
        const slipGroupSelect = document.getElementById("slip-group");
        if (slipGroupSelect) {
          slipGroupSelect.innerHTML = '<option value="">Select Group</option>';
          data.forEach(group => {
            const option = document.createElement("option");
            option.value = group;
            option.textContent = group;
            slipGroupSelect.appendChild(option);
          });
        }

        // Populate Order Details Group selection dropdown
        const odGroupSelect = document.getElementById("od-group");
        if (odGroupSelect) {
          odGroupSelect.innerHTML = '<option value="">All Groups</option>';
          data.forEach(group => {
            const option = document.createElement("option");
            option.value = group;
            option.textContent = group;
            odGroupSelect.appendChild(option);
          });
        }
      })
      .catch(err => console.warn("Failed to load groups datalist:", err));
  }

  // Initial load
  loadDashboard();
  loadPartiesAndGroups();

  // --- 6. Haste Dropdown Populating ---
  const slipPartyInput = document.getElementById("slip-party");
  const slipHasteSelect = document.getElementById("slip-haste");
  
  if (slipPartyInput && slipHasteSelect) {
    const updateHasteDropdown = () => {
      const partyVal = slipPartyInput.value.trim();
      if (!partyVal) {
        slipHasteSelect.innerHTML = '<option value="">Select Haste (Optional)</option>';
        return;
      }
      fetch(`/api/parties/${encodeURIComponent(partyVal)}/hastes`)
        .then(res => res.json())
        .then(hastes => {
          slipHasteSelect.innerHTML = '<option value="">Select Haste (Optional)</option>';
          hastes.forEach(h => {
            const opt = document.createElement("option");
            opt.value = h;
            opt.textContent = h;
            slipHasteSelect.appendChild(opt);
          });
        })
        .catch(err => {
          console.warn("Failed to fetch hastes:", err);
          slipHasteSelect.innerHTML = '<option value="">Select Haste (Optional)</option>';
        });
    };
    
    slipPartyInput.addEventListener("change", updateHasteDropdown);
    slipPartyInput.addEventListener("blur", updateHasteDropdown);
  }

  // Populate Haste dynamically for Order Details when party is selected
  const odPartySelect = document.getElementById("od-party");
  const odHasteSelect = document.getElementById("od-haste");
  
  if (odPartySelect && odHasteSelect) {
    const updateOdHasteDropdown = () => {
      const partyVal = odPartySelect.value;
      if (!partyVal) {
        odHasteSelect.innerHTML = '<option value="">All Haste</option>';
        return;
      }
      fetch(`/api/parties/${encodeURIComponent(partyVal)}/hastes`)
        .then(res => res.json())
        .then(hastes => {
          odHasteSelect.innerHTML = '<option value="">All Haste</option>';
          hastes.forEach(h => {
            const opt = document.createElement("option");
            opt.value = h;
            opt.textContent = h;
            odHasteSelect.appendChild(opt);
          });
        })
        .catch(err => {
          console.warn("Failed to fetch order details hastes:", err);
          odHasteSelect.innerHTML = '<option value="">All Haste</option>';
        });
    };
    odPartySelect.addEventListener("change", updateOdHasteDropdown);
  }

  // --- 7. All Stock Report Functions ---
  function loadAllStock() {
    const listContainer = document.getElementById("all-stock-list");
    listContainer.innerHTML = `
      <div class="loading-state">
        <i class="fa-solid fa-circle-notch fa-spin"></i> Loading Stock...
      </div>`;
    document.getElementById("all-stock-summary").style.display = "none";

    const viewTypeEl = document.getElementById("all-stock-view-type");
    const itemTypeEl = document.getElementById("all-stock-item-type");
    const viewType = viewTypeEl ? viewTypeEl.value : "group";
    const itemType = itemTypeEl ? itemTypeEl.value : "EXCLUDE_GREY";

    const url = `/api/all_stock?include_opening=false&view_type=${encodeURIComponent(viewType)}&item_type=${encodeURIComponent(itemType)}&_t=${Date.now()}`;

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          listContainer.innerHTML = `<div class="empty-state"><p class="text-danger">${data.error}</p></div>`;
          return;
        }
        allStockData = data;
        window.showSnapshotBanner(data);
        filterAndRenderAllStock();
      })
      .catch(err => {
        listContainer.innerHTML = `<div class="empty-state"><p class="text-danger">Failed to connect to server</p></div>`;
      });
  }

  
  // Helper to bind View Mode Switcher and Sync Table for any tab
  function bindTabTableAndCards(prefix, printTableId, listId, wrapperId, toolbarId) {
    const tableBtn = document.getElementById(`${prefix}-btn-table-mode`);
    const cardBtn = document.getElementById(`${prefix}-btn-card-mode`);
    const wrapper = document.getElementById(wrapperId);
    const toolbar = document.getElementById(toolbarId);
    const list = document.getElementById(listId);

    if (tableBtn && cardBtn) {
      tableBtn.onclick = () => {
        tableBtn.classList.add("btn-primary", "active");
        tableBtn.classList.remove("btn-secondary");
        cardBtn.classList.add("btn-secondary");
        cardBtn.classList.remove("btn-primary", "active");
        if (wrapper) wrapper.style.display = "block";
        if (toolbar) toolbar.style.display = "flex";
        if (list) list.style.display = "none";
      };
      cardBtn.onclick = () => {
        cardBtn.classList.add("btn-primary", "active");
        cardBtn.classList.remove("btn-secondary");
        tableBtn.classList.add("btn-secondary");
        tableBtn.classList.remove("btn-primary", "active");
        if (wrapper) wrapper.style.display = "none";
        if (toolbar) toolbar.style.display = "none";
        if (list) list.style.display = "grid";
      };
    }

    // Sync Printable Table into visible wrapper
    const pContainer = document.getElementById(printTableId);
    if (pContainer && wrapper) {
      const origTable = pContainer.querySelector('table');
      if (origTable) {
        wrapper.innerHTML = origTable.outerHTML;
        const newTable = wrapper.querySelector('table');
        if (newTable) {
          newTable.className = "br-table print-table";
          newTable.style.width = "100%";
        }
      }
    }
  }

  window.syncAllTabsTableViews = function() {
    bindTabTableAndCards('as', 'all-stock-print-table', 'all-stock-list', 'as-table-wrapper', 'as-zoom-toolbar');
    bindTabTableAndCards('od', 'od-print-table', 'od-list', 'od-table-wrapper', 'od-zoom-toolbar');
    bindTabTableAndCards('ps', 'pur-stock-print-table', 'pur-stock-list', 'ps-table-wrapper', 'ps-zoom-toolbar');
    bindTabTableAndCards('req', 'req-report-print-table', 'req-report-list', 'req-table-wrapper', 'req-zoom-toolbar');
  };

function filterAndRenderAllStock() {
    // Auto-collapse filter card after rendering report
    const stockCard = document.getElementById("all-stock-filter-card");
    if (stockCard) stockCard.classList.add("collapsed");
    const listContainer = document.getElementById("all-stock-list");
    const searchQuery = document.getElementById("all-stock-search").value.toUpperCase().trim();
    const nonZeroOnly = document.getElementById("all-stock-nonzero").checked;

    let filtered = allStockData;
    if (searchQuery) {
      filtered = filtered.filter(row => row.group_name.toUpperCase().includes(searchQuery));
    }
    if (nonZeroOnly) {
      filtered = filtered.filter(row => row.total_stock_pcs !== 0);
    }

    if (filtered.length === 0) {
      listContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-box-open"></i><p>No stock records found</p></div>`;
      document.getElementById("all-stock-summary").style.display = "none";
      return;
    }

    listContainer.innerHTML = "";
    let totalFin = 0;
    let totalJi = 0;
    let totalJr = 0;
    let totalAll = 0;

    filtered.forEach(row => {
      totalFin += row.stock_pcs;
      totalJi += row.job_issue_pcs;
      totalJr += row.job_reprocess_pcs;
      totalAll += row.total_stock_pcs;

      const card = document.createElement("div");
      card.className = "report-card";
      card.innerHTML = `
        <div class="report-header-row">
          <span class="font-bold" style="font-size: 15px; color: #0f172a;">${row.group_name}</span>
          <span class="badge ${row.total_stock_pcs > 0 ? 'badge-available' : 'badge-oos'}">${row.total_stock_pcs} Pcs</span>
        </div>
        <div class="report-details-grid" style="grid-template-columns: repeat(3, 1fr);">
          <div class="grid-cell">
            <span class="grid-cell-label cell-finish-label">Finish</span>
            <span class="grid-cell-val cell-finish-val">${row.stock_pcs}</span>
          </div>
          <div class="grid-cell">
            <span class="grid-cell-label cell-job-issue-label">Job Issue</span>
            <span class="grid-cell-val cell-job-issue-val">${row.job_issue_pcs}</span>
          </div>
          <div class="grid-cell">
            <span class="grid-cell-label cell-job-reproc-label">Job Reproc</span>
            <span class="grid-cell-val cell-job-reproc-val">${row.job_reprocess_pcs}</span>
          </div>
        </div>
      `;
      listContainer.appendChild(card);
    });

    // Generate print table
    const printTableContainer = document.getElementById("all-stock-print-table");
    if (printTableContainer) {
      let tableHtml = `
        <div class="print-header">
          <div class="print-title">Sri Khatu Naresh Textile</div>
          <div class="print-subtitle">All Stock Report — Generated on ${new Date().toLocaleDateString('en-GB')}</div>
        </div>
        <table class="print-table">
          <thead>
            <tr>
              <th style="width: 5%;">#</th>
              <th style="width: 35%;">Group Name</th>
              <th style="width: 15%;">Finish Stock</th>
              <th style="width: 15%;">Job Issue</th>
              <th style="width: 15%;">Job Reprocess</th>
              <th style="width: 15%;">Total Stock</th>
            </tr>
          </thead>
          <tbody>
      `;
      
      filtered.forEach((row, idx) => {
        tableHtml += `
          <tr>
            <td>${idx + 1}</td>
            <td style="font-weight: bold;">${row.group_name}</td>
            <td>${row.stock_pcs}</td>
            <td>${row.job_issue_pcs}</td>
            <td>${row.job_reprocess_pcs}</td>
            <td style="font-weight: bold; color: #10b981;">${row.total_stock_pcs} Pcs</td>
          </tr>
        `;
      });
      
      tableHtml += `
          </tbody>
        </table>
      `;
      printTableContainer.innerHTML = tableHtml;
    }

    document.getElementById("all-stock-summary").style.display = "block";
    document.getElementById("as-total-fin").textContent = totalFin;
    document.getElementById("as-total-ji").textContent = totalJi;
    document.getElementById("as-total-jr").textContent = totalJr;
    document.getElementById("as-total-all").textContent = totalAll;
  }

  // --- 8. Order Details Functions ---
  function loadOrderDetails() {
    const status = document.getElementById("od-status").value;
    const sort = document.getElementById("od-sort").value;
    const party = document.getElementById("od-party").value;
    const group = document.getElementById("od-group").value;
    const haste = document.getElementById("od-haste") ? document.getElementById("od-haste").value : "";
    const includeOpening = document.getElementById("od-include-opening") ? document.getElementById("od-include-opening").checked : false;

    const listContainer = document.getElementById("od-list");
    listContainer.innerHTML = `
      <div class="loading-state">
        <i class="fa-solid fa-circle-notch fa-spin"></i> Querying Orders...
      </div>`;
    document.getElementById("od-summary").style.display = "none";

    const params = new URLSearchParams({
      status: status,
      sort_by: sort,
      party: party,
      group: group,
      haste: haste,
      include_opening: includeOpening
    });

    fetch(`/api/order_details?${params.toString()}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          listContainer.innerHTML = `<div class="empty-state"><p class="text-danger">${data.error}</p></div>`;
          return;
        }
        allOrderDetails = data;
        window.showSnapshotBanner(data);
        loadItemChallanMap().finally(filterAndRenderOrderDetails);
      })
      .catch(err => {
        listContainer.innerHTML = `<div class="empty-state"><p class="text-danger">Failed to connect to server</p></div>`;
      });
  }

  function filterAndRenderOrderDetails() {
    // Auto-collapse filter card after rendering report
    const odCard = document.getElementById("od-filter-card");
    if (odCard) odCard.classList.add("collapsed");

    const listContainer = document.getElementById("od-list");
    const searchQuery = document.getElementById("od-search").value.toUpperCase().trim();
    const oosOnly = document.getElementById("od-oos-only") ? document.getElementById("od-oos-only").checked : false;

    let filtered = allOrderDetails;
    if (searchQuery) {
      filtered = filtered.filter(row => 
        row.party.toUpperCase().includes(searchQuery) ||
        row.group_name.toUpperCase().includes(searchQuery) ||
        row.item_name.toUpperCase().includes(searchQuery) ||
        row.order_no.toUpperCase().includes(searchQuery)
      );
    }
    if (oosOnly) {
      filtered = filtered.filter(row => row.is_oos);
    }

    if (filtered.length === 0) {
      listContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-magnifying-glass"></i><p>No orders found</p></div>`;
      document.getElementById("od-summary").style.display = "none";
      return;
    }

    listContainer.innerHTML = "";
    let totalOrders = new Set(filtered.map(x => x.order_no)).size;
    let totalOrderPcs = 0;
    let totalBalPcs = 0;

    filtered.forEach(row => {
      totalOrderPcs += row.order_pcs;
      totalBalPcs += row.bal_pcs;

      const card = document.createElement("div");
      card.className = "report-card";
      
      const badgeClass = row.status.toLowerCase() === "pending" ? "badge-oos" : "badge-available";
      const photoHtml = renderInlineGroupPhoto(row.group_name) || renderInlineGroupPhoto(row.item_name) || renderInlineChallanPhoto(window.itemChallanMap[row.item_name.toUpperCase().trim()]);
      
      card.innerHTML = `
        <div class="report-header-row">
          <div>
            <span class="font-bold" style="font-size:15px; color:#0f172a;">${row.item_name}</span> ${photoHtml}
            <div style="font-size:12px; color:#475569; margin-top:3px;">
              Ord No: <span class="font-bold" style="color:#1d4ed8;">${row.order_no}</span> | Date: <span style="color:#0f172a;">${row.order_date}</span>
            </div>
          </div>
          <span class="badge ${badgeClass}">${row.status}</span>
        </div>
        <div class="report-details-grid" style="grid-template-columns: repeat(3, 1fr); margin-top:8px;">
          <div class="grid-cell">
            <span class="grid-cell-label" style="color:#475569;">Order Pcs</span>
            <span class="grid-cell-val" style="color:#0f172a;">${row.order_pcs}</span>
          </div>
          <div class="grid-cell">
            <span class="grid-cell-label" style="color:#475569;">Billed Pcs</span>
            <span class="grid-cell-val" style="color:#0f172a;">${row.bill_pcs}</span>
          </div>
          <div class="grid-cell">
            <span class="grid-cell-label cell-balance-label">Balance Pcs</span>
            <span class="grid-cell-val cell-balance-val">${row.bal_pcs}</span>
          </div>
        </div>
        <div style="margin-top:10px; padding-top:8px; border-top:1px solid #e2e8f0; font-size:12px; display:flex; justify-content:space-between; color:#475569;">
          <span>Party: <strong style="color:#0f172a;">${row.party}</strong></span>
          <span>Group: <strong style="color:#0f172a;">${row.group_name}</strong></span>
        </div>
      `;
      listContainer.appendChild(card);
    });

    // Generate print table
    const printTableContainer = document.getElementById("od-print-table");
    if (printTableContainer) {
      let tableHtml = `
        <div class="print-header">
          <div class="print-title">Sri Khatu Naresh Textile</div>
          <div class="print-subtitle">Order Details Report — Generated on ${new Date().toLocaleDateString('en-GB')}</div>
        </div>
        <table class="print-table">
          <thead>
            <tr>
              <th style="width: 5%;">#</th>
              <th style="width: 8%; text-align:center;">Photo</th>
              <th style="width: 15%;">Party</th>
              <th style="width: 10%;">Order No</th>
              <th style="width: 10%;">Date</th>
              <th style="width: 10%;">Billed Pcs</th>
              <th style="width: 10%;">Balance Pcs</th>
              <th style="width: 8%;">Status</th>
            </tr>
          </thead>
          <tbody>
      `;
      
      filtered.forEach((row, idx) => {
        const statusColor = row.status.toLowerCase() === "pending" ? "color: #ef4444;" : "color: #10b981;";
        tableHtml += `
          <tr>
            <td>${idx + 1}</td>
            <td>${row.party}</td>
            <td style="font-weight: bold;">${row.order_no}</td>
            <td>${row.order_date}</td>
            <td style="font-weight: bold;">${row.item_name}</td>
            <td>${row.order_pcs}</td>
            <td>${row.bill_pcs}</td>
            <td style="font-weight: bold; color: #ef4444;">${row.bal_pcs}</td>
            <td style="${statusColor} font-weight: bold;">${row.status}</td>
          </tr>
        `;
      });
      
      tableHtml += `
          </tbody>
        </table>
      `;
      printTableContainer.innerHTML = tableHtml;
    }

    document.getElementById("od-summary").style.display = "block";
    document.getElementById("od-total-orders").textContent = totalOrders;
    document.getElementById("od-total-pcs").textContent = Math.round(totalOrderPcs);
    document.getElementById("od-total-bal").textContent = Math.round(totalBalPcs);
  }

  // --- 9. Print Handler ---
  window.printCurrentView = function() {
    window.print();
  };

  // Global card collapsible toggling
  window.toggleCardCollapse = function(cardId) {
    const card = document.getElementById(cardId);
    if (card) {
      card.classList.toggle("collapsed");
    }
  };

  // Floating Scroll-to-Top wiring
  const appContent = document.querySelector(".app-content");
  const btnScrollTop = document.getElementById("btn-scroll-top");

  if (appContent && btnScrollTop) {
    appContent.addEventListener("scroll", () => {
      if (appContent.scrollTop > 300) {
        btnScrollTop.classList.add("show");
      } else {
        btnScrollTop.classList.remove("show");
      }
    });

    btnScrollTop.addEventListener("click", () => {
      appContent.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    });
  }

  // --- 10. Wire up All Stock & Order Details event listeners ---
  document.getElementById("btn-load-all-stock").addEventListener("click", loadAllStock);
  document.getElementById("all-stock-search").addEventListener("input", filterAndRenderAllStock);
  const btnLoadAllStock = document.getElementById("btn-load-all-stock");
  if (btnLoadAllStock) {
    btnLoadAllStock.addEventListener("click", loadAllStock);
  }
  const viewTypeSelect = document.getElementById("all-stock-view-type");
  if (viewTypeSelect) {
    viewTypeSelect.addEventListener("change", loadAllStock);
  }
  const itemTypeSelect = document.getElementById("all-stock-item-type");
  if (itemTypeSelect) {
    itemTypeSelect.addEventListener("change", loadAllStock);
  }
  const nonZeroCheck = document.getElementById("all-stock-nonzero");
  if (nonZeroCheck) {
    nonZeroCheck.addEventListener("change", filterAndRenderAllStock);
  }
  document.getElementById("all-stock-nonzero").addEventListener("change", filterAndRenderAllStock);

  document.getElementById("btn-load-orders").addEventListener("click", loadOrderDetails);
  document.getElementById("od-search").addEventListener("input", filterAndRenderOrderDetails);
  document.getElementById("od-status").addEventListener("change", loadOrderDetails);
  document.getElementById("od-sort").addEventListener("change", loadOrderDetails);
  document.getElementById("od-party").addEventListener("change", loadOrderDetails);
  document.getElementById("od-group").addEventListener("change", loadOrderDetails);
  if (document.getElementById("od-haste")) {
    document.getElementById("od-haste").addEventListener("change", loadOrderDetails);
  }
  if (document.getElementById("od-oos-only")) {
    document.getElementById("od-oos-only").addEventListener("change", filterAndRenderOrderDetails);
  }

  // --- WhatsApp Quick Share Event Listeners ---
  const waShareContentType = document.getElementById("wa-share-content-type");
  const waShareMessage = document.getElementById("wa-share-message");

  if (waShareContentType && waShareMessage) {
    waShareContentType.addEventListener("change", () => {
      const type = waShareContentType.value;
      if (type === "custom") {
        waShareMessage.value = "";
      } else if (type === "req" || type === "oos") {
        waShareMessage.value = "Fetching report data...";
        fetch('/api/req_report?include_opening=true' + ('/api/req_report?include_opening=true'.includes('?') ? '&' : '?') + '_t=' + Date.now())
          .then(res => res.json())
          .then(data => {
            if (data.error) {
              waShareMessage.value = `Error fetching data: ${data.error}`;
              return;
            }
            
            let text = "";
            if (type === "req") {
              text = `*Sri Khatu Naresh Textile*\n*REQ Procurement Report*\nDate: ${new Date().toLocaleDateString('en-GB')}\n\n`;
              data.forEach((row, index) => {
                text += `${index + 1}. *${row.group_name}* - ${row.status}\n`;
                text += `   Order: ${row.order_pcs} | Stock: ${row.stock_pcs} | Req: ${row.req_pcs}\n\n`;
              });
            } else {
              const oosItems = data.filter(row => row.status === "OUT OF STOCK");
              text = `*Sri Khatu Naresh Textile*\n*OOS Report (Shortages)*\nDate: ${new Date().toLocaleDateString('en-GB')}\n\n`;
              if (oosItems.length === 0) {
                text += "No items currently out of stock!";
              } else {
                oosItems.forEach((row, index) => {
                  text += `${index + 1}. *${row.group_name}* (Shortage: ${row.req_pcs} Pcs)\n`;
                  text += `   Order: ${row.order_pcs} | Stock: ${row.stock_pcs} | Job Iss: ${row.job_issue_pcs}\n\n`;
                });
              }
            }
            waShareMessage.value = text;
          })
          .catch(err => {
            waShareMessage.value = "Failed to load report data from server.";
          });
      }
    });
  }

  const btnWaShareText = document.getElementById("btn-wa-share-text");
  if (btnWaShareText) {
    btnWaShareText.addEventListener("click", () => {
      const mobile = document.getElementById("wa-share-mobile").value.trim().replace("+", "").replace(" ", "");
      const message = waShareMessage ? waShareMessage.value : "";
      if (!message.trim()) {
        alert("Please enter a message or select a report content!");
        return;
      }
      
      const encoded = encodeURIComponent(message);
      const url = mobile 
        ? `https://api.whatsapp.com/send?phone=${mobile}&text=${encoded}`
        : `https://api.whatsapp.com/send?text=${encoded}`;
      
      window.open(url, "_blank");
    });
  }

  const btnWaSharePdf = document.getElementById("btn-wa-share-pdf");
  if (btnWaSharePdf) {
    btnWaSharePdf.addEventListener("click", () => {
      const type = waShareContentType ? waShareContentType.value : "custom";
      if (type === "req") {
        switchTab("req");
        setTimeout(() => window.print(), 500);
      } else if (type === "oos" || type === "custom") {
        switchTab("oos-report");
        setTimeout(() => window.print(), 500);
      }
    });
  }
  // --- 9. Purchase Stock Report Functions (Detailed Challan View) ---
  let allPurchaseStockData = [];

  // Set default dates for purchase stock
  (function initPurStockDates() {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const todayStr = `${dd}/${mm}/${yyyy}`;
    // Financial year start: April 1
    const fyStart = `01/04/${today.getMonth() >= 3 ? yyyy : yyyy - 1}`;
    const psFrom = document.getElementById("ps-date-from");
    const psTo = document.getElementById("ps-date-to");
    if (psFrom && !psFrom.value) psFrom.value = fyStart;
    if (psTo && !psTo.value) psTo.value = todayStr;
  })();

  function loadPurchaseStock() {
    const listContainer = document.getElementById("pur-stock-list");
    listContainer.innerHTML = `
      <div class="loading-state">
        <i class="fa-solid fa-circle-notch fa-spin"></i> Loading Purchase Stock...
      </div>`;
    document.getElementById("pur-stock-summary").style.display = "none";

    const dateFrom = (document.getElementById("ps-date-from") || {}).value || "";
    const dateTo = (document.getElementById("ps-date-to") || {}).value || "";
    const statusEl = document.querySelector('input[name="ps-status"]:checked');
    const status = statusEl ? statusEl.value : "pending";
    const includeOpening = (document.getElementById("ps-include-opening") || {}).checked ? "true" : "false";
    const showRecPlainPcs = (document.getElementById("ps-show-rec-plain-pcs") || {}).checked ? "true" : "false";

    const params = new URLSearchParams({
      date_from: dateFrom,
      date_to: dateTo,
      status: status,
      include_opening: includeOpening,
      show_rec_plain_pcs: showRecPlainPcs
    });

    fetch(`/api/purchase_stock?${params.toString()}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          listContainer.innerHTML = `<div class="empty-state"><p class="text-danger">${data.error}</p></div>`;
          return;
        }
        allPurchaseStockData = data;
        window.showSnapshotBanner(data);
        filterAndRenderPurchaseStock();
      })
      .catch(err => {
        listContainer.innerHTML = `<div class="empty-state"><p class="text-danger">Failed to connect to server</p></div>`;
      });
  }

  function filterAndRenderPurchaseStock() {
    // Auto-collapse filter card
    const psCard = document.getElementById("ps-filter-card");
    if (psCard) psCard.classList.add("collapsed");

    const listContainer = document.getElementById("pur-stock-list");
    const searchQuery = (document.getElementById("pur-stock-search").value || "").toUpperCase().trim();

    let filtered = allPurchaseStockData;
    if (searchQuery) {
      filtered = filtered.filter(row =>
        (row.party || "").toUpperCase().includes(searchQuery) ||
        (row.itemname || "").toUpperCase().includes(searchQuery)
      );
    }

    if (filtered.length === 0) {
      listContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-box-open"></i><p>No purchase stock records found</p></div>`;
      document.getElementById("pur-stock-summary").style.display = "none";
      return;
    }

    // Group by party
    const grouped = {};
    filtered.forEach(row => {
      const party = row.party || "UNKNOWN";
      if (!grouped[party]) grouped[party] = [];
      grouped[party].push(row);
    });

    listContainer.innerHTML = "";
    let totalPcs = 0, totalBal = 0, totalEntries = 0;
    const partyNames = Object.keys(grouped).sort();

    partyNames.forEach(party => {
      const rows = grouped[party];
      let partyPcs = 0, partyBal = 0, partyCut = 0;

      // Party Header
      const partyHeader = document.createElement("div");
      partyHeader.className = "report-card";
      partyHeader.style.cssText = "background:linear-gradient(135deg,#1e3a5f,#2d5a87);color:#fff;padding:10px 14px;margin-bottom:2px;border-radius:10px;cursor:pointer;";
      partyHeader.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:14px;"><i class="fa-solid fa-user-tie" style="margin-right:6px;opacity:0.7;"></i>Party : ${party}</span>
          <span class="badge badge-available" style="font-size:11px;">${rows.length} entries</span>
        </div>
      `;
      listContainer.appendChild(partyHeader);

      // Individual rows
      rows.forEach(row => {
        totalEntries++;
        partyPcs += row.pcs;
        partyBal += row.balpcs;
        partyCut += row.cut;
        totalPcs += row.pcs;
        totalBal += row.balpcs;

        const card = document.createElement("div");
        card.className = "report-card";
        const borderColor = row.source === "REC PLAIN" ? "#f59e0b" : "#3b82f6";
        card.style.cssText = `margin-bottom:1px;border-left:3px solid ${borderColor};padding:8px 10px;`;
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <div style="display:flex;flex-direction:column;gap:2px;flex:1;">
              <span style="font-weight:700;font-size:14px;color:#0f172a;">${row.itemname} ${row.source === "REC PLAIN" ? '<span class="badge" style="background:#fff3e0;color:#e65100;font-size:10px;padding:2px 6px;margin-left:6px;border:1px solid #ffe0b2;font-weight:600;display:inline-block;vertical-align:middle;">Plain Rec</span>' : ''}${row.opening === "Y" ? '<span class="badge" style="background:#e8f5e9;color:#2e7d32;font-size:10px;padding:2px 6px;margin-left:6px;border:1px solid #c8e6c9;font-weight:600;display:inline-block;vertical-align:middle;">Opening</span>' : ''}</span>
              <span style="font-size:11px;color:#475569;">${row.date} | Serial: <strong style="color:#0f172a;">${row.serial}</strong> | Bill: <strong style="color:#0f172a;">${row.billno || '-'}</strong> ${renderInlineChallanPhoto(row.billno || row.serial)}</span>
            </div>
            <span class="badge ${row.balpcs > 0 ? 'badge-available' : 'badge-oos'}" style="font-size:11px;white-space:nowrap;margin-left:8px;">${row.balpcs.toFixed(2)} Bal</span>
          </div>
          <div class="report-details-grid" style="grid-template-columns: repeat(4, 1fr); padding:6px 8px; gap:4px;">
            <div class="grid-cell">
              <span class="grid-cell-label" style="font-size:10px;color:#475569;">Lot</span>
              <span class="grid-cell-val" style="font-size:13px;color:#0f172a;">${row.lotno || '-'}</span>
            </div>
            <div class="grid-cell">
              <span class="grid-cell-label" style="font-size:10px;color:#475569;">Cut</span>
              <span class="grid-cell-val" style="font-size:13px;color:#0f172a;">${row.cut.toFixed(4)}</span>
            </div>
            <div class="grid-cell">
              <span class="grid-cell-label" style="font-size:10px;color:#475569;">Rate</span>
              <span class="grid-cell-val" style="font-size:13px;color:#0f172a;">${row.rate.toFixed(2)}</span>
            </div>
            <div class="grid-cell">
              <span class="grid-cell-label font-bold" style="font-size:10px;color:#475569;">PCS</span>
              <span class="grid-cell-val font-bold" style="font-size:13px;color:#1d4ed8;">${row.pcs.toFixed(2)}</span>
            </div>
          </div>
          <div class="report-details-grid" style="grid-template-columns: repeat(3, 1fr); padding:6px 8px; gap:4px; margin-top:4px;">
            <div class="grid-cell">
              <span class="grid-cell-label cell-balance-label" style="font-size:10px;">RetPcs</span>
              <span class="grid-cell-val cell-balance-val" style="font-size:13px;">${row.retpcs.toFixed(2)}</span>
            </div>
            <div class="grid-cell">
              <span class="grid-cell-label cell-job-issue-label" style="font-size:10px;">SecPcs</span>
              <span class="grid-cell-val cell-job-issue-val" style="font-size:13px;">${row.spcs.toFixed(2)}</span>
            </div>
            <div class="grid-cell">
              <span class="grid-cell-label cell-success-label" style="font-size:10px;">BalPcs</span>
              <span class="grid-cell-val cell-success-val" style="font-size:13px;">${row.balpcs.toFixed(2)}</span>
            </div>
          </div>
        `;
        listContainer.appendChild(card);
      });

      // Party subtotal row
      const subtotal = document.createElement("div");
      subtotal.className = "report-card";
      subtotal.style.cssText = "background:var(--bg-card-alt,#f0f4f8);padding:8px 14px;margin-bottom:12px;border-radius:0 0 10px 10px;border-top:2px solid #3b82f6;";
      subtotal.innerHTML = `
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <span style="font-size:12px;font-weight:700;color:var(--text-sub);">Subtotal (${party})</span>
          <div style="display:flex;gap:16px;flex-wrap:wrap;">
            <span style="font-size:12px;"><strong>Cut:</strong> ${partyCut.toFixed(2)}</span>
            <span style="font-size:12px;"><strong>PCS:</strong> ${partyPcs.toFixed(2)}</span>
            <span style="font-size:12px;color:#10b981;"><strong>BAL:</strong> ${partyBal.toFixed(2)}</span>
          </div>
        </div>
      `;
      listContainer.appendChild(subtotal);
    });

    // Generate print table
    const printTableContainer = document.getElementById("pur-stock-print-table");
    if (printTableContainer) {
      let tableHtml = `
        <div class="print-header">
          <div class="print-title">Sri Khatu Naresh Textile</div>
          <div class="print-subtitle">Purchase Stock Report — Generated on ${new Date().toLocaleDateString('en-GB')}</div>
        </div>
        <table class="print-table">
          <thead>
            <tr>
              <th style="width:9%;">DATE</th>
              <th style="width:5%;">SERIAL</th>
              <th style="width:7%;">BILLNO</th>
              <th style="width:5%;">LOTNO</th>
              <th style="width:22%;">ITEMNAME</th>
              <th style="width:8%;">CUT</th>
              <th style="width:8%;">RATE</th>
              <th style="width:8%;">PCS</th>
              <th style="width:8%;">RETPCS</th>
              <th style="width:8%;">SECPCS</th>
              <th style="width:8%;">BALPCS</th>
            </tr>
          </thead>
          <tbody>
      `;
      partyNames.forEach(party => {
        const rows = grouped[party];
        let pPcs = 0, pBal = 0, pCut = 0;
        tableHtml += `<tr style="background:#1e3a5f;color:#fff;"><td colspan="11" style="font-weight:bold;padding:6px;">Party : ${party}</td></tr>`;
        rows.forEach(row => {
          pPcs += row.pcs; pBal += row.balpcs; pCut += row.cut;
          const displayItemName = row.itemname + (row.source === "REC PLAIN" ? " (Plain Rec)" : "");
          tableHtml += `
            <tr>
              <td>${row.date}</td>
              <td>${row.serial}</td>
              <td>${row.billno || '-'}</td>
              <td>${row.lotno || '-'}</td>
              <td style="font-weight:bold;">${displayItemName} ${renderInlineChallanPhoto(row.billno || row.serial)}</td>
              <td>${row.cut.toFixed(4)}</td>
              <td>${row.rate.toFixed(4)}</td>
              <td style="font-weight:bold;">${row.pcs.toFixed(2)}</td>
              <td>${row.retpcs.toFixed(2)}</td>
              <td>${row.spcs.toFixed(2)}</td>
              <td style="font-weight:bold;">${row.balpcs.toFixed(2)}</td>
            </tr>`;
        });
        tableHtml += `<tr style="background:#e8f0fe;font-weight:bold;">
          <td colspan="5" style="text-align:right;">Subtotal:</td>
          <td>${pCut.toFixed(2)}</td><td></td>
          <td>${pPcs.toFixed(2)}</td><td></td><td></td>
          <td>${pBal.toFixed(2)}</td>
        </tr>`;
      });
      tableHtml += `</tbody></table>`;
      printTableContainer.innerHTML = tableHtml;
    }

    // Update summary
    document.getElementById("pur-stock-summary").style.display = "block";
    document.getElementById("ps-total-parties").textContent = partyNames.length;
    document.getElementById("ps-total-items").textContent = totalEntries;
    document.getElementById("ps-total-pcs").textContent = totalPcs.toFixed(0);
    document.getElementById("ps-total-bal").textContent = totalBal.toFixed(0);
  }

  // Bind events for Purchase Stock
  const purStockSearch = document.getElementById("pur-stock-search");
  if (purStockSearch) {
    purStockSearch.addEventListener("input", filterAndRenderPurchaseStock);
  }
  const btnLoadPurStock = document.getElementById("btn-load-pur-stock");
  if (btnLoadPurStock) {
    btnLoadPurStock.addEventListener("click", loadPurchaseStock);
  }

  // --- Sale Bill Report State & Handlers ---
  let allBillReportData = [];
  let billFiltersLoaded = false;

  async function loadBillReportFilters() {
    if (billFiltersLoaded) return;
    try {
      const res = await fetch('/api/reports/bill_report_filters' + ('/api/reports/bill_report_filters'.includes('?') ? '&' : '?') + '_t=' + Date.now());
      const data = await res.json();
      if (data.status === "success") {
        const partyDatalist = document.getElementById("br-parties-datalist");
        if (partyDatalist && data.parties) {
          partyDatalist.innerHTML = data.parties.map(p => `<option value="${p}">`).join('');
        }
        const groupDatalist = document.getElementById("br-groups-datalist");
        if (groupDatalist && data.groups) {
          groupDatalist.innerHTML = data.groups.map(g => `<option value="${g}">`).join('');
        }
        billFiltersLoaded = true;
      }
    } catch (e) {
      console.warn("Failed to load bill report filter datalists:", e);
    }
  }

  async function loadBillReport() {
    loadBillReportFilters();
    const brList = document.getElementById("br-list");
    if (!brList) return;
    brList.innerHTML = `<div class="loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Sale Bill Data...</div>`;

    const dateFrom = document.getElementById("br-date-from")?.value || "";
    const dateTo = document.getElementById("br-date-to")?.value || "";
    const sortBy = document.getElementById("br-sort-by")?.value || "group";
    const party = document.getElementById("br-party")?.value || "";
    const group = document.getElementById("br-group")?.value || "";
    const seeOldYear = document.getElementById("br-see-old-year")?.checked ? "true" : "false";

    try {
      const params = new URLSearchParams({
        date_from: dateFrom,
        date_to: dateTo,
        sort_by: sortBy,
        party: party,
        group: group,
        see_old_year: seeOldYear
      });

      const res = await fetch(`/api/reports/bill_report?${params.toString()}`);
      const data = await res.json();

      if (data.status === "success") {
        allBillReportData = data.data || [];
        window.showSnapshotBanner(data);
        filterAndRenderBillReport();
      } else {
        brList.innerHTML = `<div class="empty-state" style="color:var(--danger);">${data.error || "Failed to load Sale Bill Data"}</div>`;
      }
    } catch (e) {
      brList.innerHTML = `<div class="empty-state" style="color:var(--danger);">Error connecting to server: ${e.message}</div>`;
    }
  }

  function filterAndRenderBillReport() {
    // Auto-collapse filter card after generating report
    const brFilterCard = document.getElementById("br-filter-card");
    if (brFilterCard) brFilterCard.classList.add("collapsed");

    const brList = document.getElementById("br-list");
    const brTableWrapper = document.getElementById("br-table-wrapper");
    const printTableContainer = document.getElementById("br-print-table");
    const searchTerm = (document.getElementById("br-search")?.value || "").toLowerCase().trim();
    const sortBy = document.getElementById("br-sort-by")?.value || "date";

    let filtered = allBillReportData.filter(item => {
      if (!searchTerm) return true;
      return item.bill_no.toLowerCase().includes(searchTerm) ||
             item.party_name.toLowerCase().includes(searchTerm) ||
             item.group_name.toLowerCase().includes(searchTerm) ||
             item.item_name.toLowerCase().includes(searchTerm) ||
             item.date.toLowerCase().includes(searchTerm);
    });

    if (filtered.length === 0) {
      if (brList) brList.innerHTML = `<div class="empty-state">No sale bills found for selected criteria.</div>`;
      if (brTableWrapper) brTableWrapper.innerHTML = `<div class="empty-state" style="padding:20px; text-align:center;">No sale bills found for selected criteria.</div>`;
      if (printTableContainer) printTableContainer.innerHTML = "";
      const brSum = document.getElementById("br-summary");
      if (brSum) brSum.style.display = "none";
      return;
    }

    let totalPcs = 0;
    const billNumbers = new Set();

    filtered.forEach(r => {
      totalPcs += r.pcs;
      if (r.bill_no) billNumbers.add(r.bill_no);
    });

    // Render Cards List View (Without Amount)
    let html = ``;
    filtered.forEach(item => {
      const yearBadge = item.db_label === "Previous" ? `<span class="badge badge-warning" style="font-size:10px; margin-left:4px;">Prev Yr</span>` : "";
      html += `
        <div class="br-data-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span style="font-weight:700; color:var(--primary); font-size:15px;">Bill #${item.bill_no} ${yearBadge}</span>
            <span style="font-size:12px; color:var(--text-sub); font-weight:600;"><i class="fa-solid fa-calendar-days"></i> ${item.date}</span>
          </div>
          <div style="font-size:14px; font-weight:700; color:#0f172a; margin-bottom:6px;">
            <i class="fa-solid fa-building" style="color:#2563eb; margin-right:6px;"></i> ${item.party_name}
          </div>
          <div style="font-size:12px; color:#475569; margin-bottom:8px; display:flex; gap:12px; flex-wrap:wrap;">
            <span><i class="fa-solid fa-layer-group"></i> <b>Group:</b> ${item.group_name || 'BLANK'}</span>
            <span><i class="fa-solid fa-tag"></i> <b>Item:</b> ${item.item_name}</span>
          </div>
          <div style="display:flex; justify-content:space-between; background:#f8fafc; padding:8px 12px; border-radius:8px; font-size:13px; border:1px solid #e2e8f0;">
            <span><b>Pcs:</b> <span style="color:#d97706; font-weight:800; font-size:14px;">${item.pcs.toFixed(2)}</span></span>
            <span><b>Rate:</b> ₹${item.rate.toFixed(2)}</span>
            <span><b>Pack:</b> ${item.pack_type || '-'}</span>
          </div>
        </div>
      `;
    });

    // Render High-Contrast Ultra-Readable Printable Table (Without Amount)
    let tableHtml = `<table class="br-table print-table">
      <thead>
        <tr>
          <th>BILL NO</th>
          <th>DATE</th>
          <th>PARTY NAME</th>
          <th>GROUP NAME</th>
          <th>ITEM NAME</th>
          <th style="text-align:right;">PCS</th>
          <th style="text-align:right;">RATE</th>
          <th style="text-align:center;">PACK TYPE</th>
        </tr>
      </thead>
      <tbody>`;

    if (sortBy === "party" || sortBy === "group" || sortBy === "item") {
      // Group Pattern Rendering
      const groupKey = sortBy === "party" ? "party_name" : (sortBy === "group" ? "group_name" : "item_name");
      const groupLabel = sortBy === "party" ? "Party" : (sortBy === "group" ? "GroupName" : "ItemName");
      
      const groupsMap = new Map();
      filtered.forEach(item => {
        const key = item[groupKey] || "(BLANK)";
        if (!groupsMap.has(key)) groupsMap.set(key, []);
        groupsMap.get(key).push(item);
      });

      groupsMap.forEach((items, keyVal) => {
        let grpPcs = 0;
        tableHtml += `<tr class="br-group-header-row">
          <td colspan="8"><i class="fa-solid fa-folder-open"></i> ${groupLabel} : ${keyVal} (${items.length} entries)</td>
        </tr>`;

        items.forEach(item => {
          grpPcs += item.pcs;
          tableHtml += `
            <tr>
              <td style="font-weight:700; color:#1e40af;">${item.bill_no}</td>
              <td>${item.date}</td>
              <td class="cell-party" style="text-align:left; font-weight:600;">${item.party_name}</td>
              <td style="text-align:left;">${item.group_name}</td>
              <td class="cell-item" style="text-align:left; font-weight:600;">${item.item_name}</td>
              <td style="text-align:right; font-weight:700; color:#d97706;">${item.pcs.toFixed(2)}</td>
              <td style="text-align:right;">₹${item.rate.toFixed(2)}</td>
              <td style="text-align:center;">${item.pack_type || ''}</td>
            </tr>
          `;
        });

        tableHtml += `<tr class="br-subtotal-row">
          <td colspan="5" style="text-align:right;">Subtotal (${keyVal}):</td>
          <td style="text-align:right; color:#d97706; font-size:14px;">${grpPcs.toFixed(2)} Pcs</td>
          <td colspan="2"></td>
        </tr>`;
      });

    } else {
      // Date Wise Default Flat Table Rendering
      filtered.forEach(item => {
        tableHtml += `
          <tr>
            <td style="font-weight:700; color:#1e40af;">${item.bill_no}</td>
            <td>${item.date}</td>
            <td class="cell-party" style="text-align:left; font-weight:600;">${item.party_name}</td>
            <td style="text-align:left;">${item.group_name}</td>
            <td class="cell-item" style="text-align:left; font-weight:600;">${item.item_name}</td>
            <td style="text-align:right; font-weight:700; color:#d97706;">${item.pcs.toFixed(2)}</td>
            <td style="text-align:right;">₹${item.rate.toFixed(2)}</td>
            <td style="text-align:center;">${item.pack_type || ''}</td>
          </tr>
        `;
      });
    }

    tableHtml += `
      <tr class="br-grand-total-row">
        <td colspan="5" style="text-align:right;">GRAND TOTAL (${filtered.length} entries):</td>
        <td style="text-align:right; color:#d97706; font-size:15px;">${totalPcs.toFixed(2)} Pcs</td>
        <td colspan="2"></td>
      </tr>
      </tbody></table>
    `;

    if (brList) brList.innerHTML = html;
    if (brTableWrapper) brTableWrapper.innerHTML = tableHtml;
    if (printTableContainer) printTableContainer.innerHTML = tableHtml;

    // Summary Card
    const brSummary = document.getElementById("br-summary");
    if (brSummary) {
      brSummary.style.display = "block";
      const totalBillsEl = document.getElementById("br-total-bills");
      if (totalBillsEl) totalBillsEl.textContent = billNumbers.size;
      const totalEntriesEl = document.getElementById("br-total-entries");
      if (totalEntriesEl) totalEntriesEl.textContent = filtered.length;
      const totalPcsEl = document.getElementById("br-total-pcs");
      if (totalPcsEl) totalPcsEl.textContent = totalPcs.toFixed(0);
    }
  }

  // --- Table Zoom Control State & Logic ---
  let currentTableZoom = 1.0;

  function setTableZoom(zoomFactor) {
    currentTableZoom = Math.min(Math.max(zoomFactor, 0.6), 2.5);
    const zoomPercent = Math.round(currentTableZoom * 100) + "%";
    
    const zoomBadge = document.getElementById("br-zoom-level");
    if (zoomBadge) zoomBadge.textContent = zoomPercent;
    
    const tableWrapper = document.getElementById("br-table-wrapper");
    if (tableWrapper) {
      tableWrapper.style.setProperty("--table-zoom-scale", currentTableZoom.toString());
    }
  }

  document.getElementById("br-btn-zoom-in")?.addEventListener("click", () => setTableZoom(currentTableZoom + 0.15));
  document.getElementById("br-btn-zoom-out")?.addEventListener("click", () => setTableZoom(currentTableZoom - 0.15));
  document.getElementById("br-btn-zoom-reset")?.addEventListener("click", () => setTableZoom(1.0));

  const tableWrapperEl = document.getElementById("br-table-wrapper");
  if (tableWrapperEl) {
    tableWrapperEl.addEventListener("wheel", (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        setTableZoom(currentTableZoom + (e.deltaY < 0 ? 0.1 : -0.1));
      }
    }, { passive: false });
  }

  // Bind View Mode Toggle Handlers
  const brBtnTable = document.getElementById("br-btn-table-mode");
  const brBtnCard = document.getElementById("br-btn-card-mode");
  const brZoomToolbar = document.getElementById("br-zoom-toolbar");
  if (brBtnTable && brBtnCard) {
    brBtnTable.addEventListener("click", () => {
      brBtnTable.classList.add("btn-primary", "active");
      brBtnTable.classList.remove("btn-secondary");
      brBtnCard.classList.add("btn-secondary");
      brBtnCard.classList.remove("btn-primary", "active");
      if (tableWrapperEl) tableWrapperEl.style.display = "block";
      if (brZoomToolbar) brZoomToolbar.style.display = "flex";
      document.getElementById("br-list").style.display = "none";
    });
    brBtnCard.addEventListener("click", () => {
      brBtnCard.classList.add("btn-primary", "active");
      brBtnCard.classList.remove("btn-secondary");
      brBtnTable.classList.add("btn-secondary");
      brBtnTable.classList.remove("btn-primary", "active");
      if (tableWrapperEl) tableWrapperEl.style.display = "none";
      if (brZoomToolbar) brZoomToolbar.style.display = "none";
      document.getElementById("br-list").style.display = "grid";
    });
  }

  const brSearch = document.getElementById("br-search");
  if (brSearch) brSearch.addEventListener("input", filterAndRenderBillReport);
  const btnLoadBillReport = document.getElementById("btn-load-bill-report");
  if (btnLoadBillReport) btnLoadBillReport.addEventListener("click", loadBillReport);

  // ══════════════════════════════════════════════════════════════════════════
  // JOB WORK ISSUE REPORT ENGINE
  // ══════════════════════════════════════════════════════════════════════════
  let allJobIssueData = [];

  // Auto-fetch jobbers, items, and inward types for autocomplete
  function loadJobFilters() {
    fetch('/api/job_filters')
      .then(r => r.json())
      .then(data => {
        if (data.status !== 'success') return;
        const jobbersList = ['ji-jobbers-list', 'jr-jobbers-list'];
        const itemsList = ['ji-items-list', 'jr-items-list'];
        jobbersList.forEach(id => {
          const dl = document.getElementById(id);
          if (dl) dl.innerHTML = data.jobbers.map(j => `<option value="${j}">`).join('');
        });
        itemsList.forEach(id => {
          const dl = document.getElementById(id);
          if (dl) dl.innerHTML = data.items.map(i => `<option value="${i}">`).join('');
        });
        if (data.inw_types && data.inw_types.length) {
          ['ji-inw-type', 'jr-inw-type'].forEach(id => {
            const sel = document.getElementById(id);
            if (sel) {
              const curr = sel.value;
              sel.innerHTML = '<option value="All">All Inward Types</option>' + 
                data.inw_types.map(t => `<option value="${t}">${t}</option>`).join('');
              sel.value = curr || "All";
            }
          });
        }
      })
      .catch(() => {});
  }
  loadJobFilters(); // Load on page start

  window.loadJobIssueReport = function() {
    const btnLoad = document.getElementById("btn-load-job-issue");
    if (btnLoad) {
      btnLoad.disabled = true;
      btnLoad.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Loading...`;
    }

    const dateFrom = document.getElementById("ji-date-from")?.value || "";
    const dateTo = document.getElementById("ji-date-to")?.value || "";
    const recUpto = document.getElementById("ji-rec-upto")?.value || "";
    const jobber = document.getElementById("ji-jobber")?.value || "";
    const item = document.getElementById("ji-item")?.value || "";
    const inwType = document.getElementById("ji-inw-type")?.value || "All";
    const statusEl = document.querySelector('input[name="ji_status"]:checked');
    const statusVal = statusEl ? statusEl.value : "Pending";
    const includeOpening = document.getElementById("ji-include-opening")?.checked ? "true" : "false";

    let url = `/api/job_issue_report?status=${encodeURIComponent(statusVal)}&jobber=${encodeURIComponent(jobber)}&item=${encodeURIComponent(item)}&inw_type=${encodeURIComponent(inwType)}&date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}&rec_upto=${encodeURIComponent(recUpto)}&include_opening=${includeOpening}`;

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (btnLoad) {
          btnLoad.disabled = false;
          btnLoad.innerHTML = `<i class="fa-solid fa-bolt"></i> Load Job Work Issue Report`;
        }
        if (data.status === "success") {
          allJobIssueData = data.data || [];
          window.showSnapshotBanner(data);
          filterAndRenderJobIssue();
          const jiCard = document.getElementById("ji-filter-card") || document.getElementById("jobIssueReportCard");
          if (jiCard) jiCard.classList.add("collapsed");
        } else {
          alert(data.error || "Failed to load Job Work Issue data");
        }
      })
      .catch(err => {
        if (btnLoad) {
          btnLoad.disabled = false;
          btnLoad.innerHTML = `<i class="fa-solid fa-bolt"></i> Load Job Work Issue Report`;
        }
        console.error("Job Issue Load Error:", err);
        alert("Error connecting to server to load Job Work Issue report.");
      });
  };

  function getFilteredJobIssueData() {
    const searchTerm = (document.getElementById("ji-search")?.value || "").toLowerCase().trim();
    return allJobIssueData.filter(row => {
      if (!searchTerm) return true;
      return (
        (row.date && row.date.toLowerCase().includes(searchTerm)) ||
        (row.jobber && row.jobber.toLowerCase().includes(searchTerm)) ||
        (row.isssr && row.isssr.toLowerCase().includes(searchTerm)) ||
        (row.jobitem && row.jobitem.toLowerCase().includes(searchTerm)) ||
        (row.itemname && row.itemname.toLowerCase().includes(searchTerm)) ||
        (row.agent && row.agent.toLowerCase().includes(searchTerm)) ||
        (row.series && row.series.toLowerCase().includes(searchTerm)) ||
        (row.lotno && row.lotno.toLowerCase().includes(searchTerm)) ||
        (row.fabrics && row.fabrics.toLowerCase().includes(searchTerm)) ||
        (row.purchase_bill_no && row.purchase_bill_no.toLowerCase().includes(searchTerm)) ||
        (row.inwtype && row.inwtype.toLowerCase().includes(searchTerm))
      );
    });
  }

  function filterAndRenderJobIssue() {
    const filtered = getFilteredJobIssueData();

    const jiList = document.getElementById("ji-list");
    const jiTableWrapper = document.getElementById("ji-table-wrapper");
    const printTableContainer = document.getElementById("ji-print-table");

    if (!filtered.length) {
      const emptyHtml = `<div class="empty-state" style="padding: 30px; text-align: center;"><i class="fa-solid fa-folder-open" style="font-size:36px; color:var(--text-sub);"></i><p style="margin-top:10px; color:var(--text-sub); font-weight:600;">No Job Work Issue records found matching filters.</p></div>`;
      if (jiList) jiList.innerHTML = emptyHtml;
      if (jiTableWrapper) jiTableWrapper.innerHTML = emptyHtml;
      if (printTableContainer) printTableContainer.innerHTML = "";
      const sumEl = document.getElementById("ji-summary");
      if (sumEl) sumEl.style.display = "none";
      return;
    }

    let totalPcs = 0, totalPlainPcs = 0, totalRecPcs = 0, totalSecPcs = 0, totalShtPcs = 0, totalBalPcs = 0, totalWastePcs = 0, totalRetPcs = 0;

    const groupPattern = document.getElementById("ji-group-pattern")?.value || "None";

    let tableHtml = "";

    if (groupPattern !== "None") {
      // ════════════════════════════════════════════════════════════════════════
      // GROUP PATTERN RENDER (LotNo, InwType, Agent, ItemName, JobItem, Series, Jobber, Fabrics)
      // ════════════════════════════════════════════════════════════════════════
      const groupKeyMap = {
        'Jobber': 'jobber',
        'JobItem': 'jobitem',
        'Agent': 'agent',
        'LotNo': 'lotno',
        'Series': 'series',
        'InwType': 'inwtype',
        'ItemName': 'itemname',
        'Fabrics': 'fabrics'
      };
      const keyField = groupKeyMap[groupPattern] || 'jobber';

      const groups = {};
      filtered.forEach(row => {
        const val = (row[keyField] || 'UNSPECIFIED').toString().trim() || 'UNSPECIFIED';
        if (!groups[val]) {
          groups[val] = {
            name: val,
            rows: [],
            count: 0,
            pcs: 0,
            plainpcs: 0,
            recpcs: 0,
            secpcs: 0,
            shtpcs: 0,
            balpcs: 0,
            wastepcs: 0,
            retpcs: 0
          };
        }
        groups[val].rows.push(row);
        groups[val].count += 1;
        if (!row.is_opening) {
          groups[val].pcs += row.pcs;
          groups[val].plainpcs += row.plainpcs;
          groups[val].recpcs += row.recpcs;
          groups[val].secpcs += row.secpcs;
          groups[val].shtpcs += row.shtpcs;
          groups[val].wastepcs += row.wastepcs;
          groups[val].retpcs += row.retpcs;
          totalPcs += row.pcs;
          totalPlainPcs += row.plainpcs;
          totalRecPcs += row.recpcs;
          totalSecPcs += row.secpcs;
          totalShtPcs += row.shtpcs;
          totalWastePcs += row.wastepcs;
          totalRetPcs += row.retpcs;
        }
        groups[val].balpcs += row.balpcs;
        totalBalPcs += row.balpcs;
      });

      const sortedGroupKeys = Object.keys(groups).sort((a,b) => groups[b].balpcs - groups[a].balpcs);

      tableHtml = `
        <div style="background:#2563eb; color:#ffffff; padding:8px 12px; font-weight:700; font-size:13px; border-radius:8px 8px 0 0; display:flex; justify-space-between; align-items:center;">
          <span><i class="fa-solid fa-layer-group"></i> GROUPED BY: ${groupPattern.toUpperCase()} (${sortedGroupKeys.length} Groups)</span>
        </div>
        <table class="br-table print-table" style="width:100%;">
          <thead>
            <tr style="background:#0f172a; color:#ffffff;">
              <th style="text-align:left;">${groupPattern.toUpperCase()} GROUP</th>
              <th style="text-align:center;">CHALLANS</th>
              <th style="text-align:right;">ISSUED PCS</th>
              <th style="text-align:right;">REC PCS</th>
              <th style="text-align:right;">SEC PCS</th>
              <th style="text-align:right;">SHT PCS</th>
              <th style="text-align:right;">BAL PCS</th>
              <th style="text-align:right;">WASTE PCS</th>
              <th style="text-align:right;">RET PCS</th>
            </tr>
          </thead>
          <tbody>
      `;

      sortedGroupKeys.forEach((gKey, idx) => {
        const g = groups[gKey];
        tableHtml += `
          <tr style="background:${idx % 2 === 0 ? '#f8fafc' : '#ffffff'}; font-weight:700;">
            <td style="text-align:left; color:#1d4ed8; font-size:13px;">${g.name}</td>
            <td style="text-align:center;"><span class="badge badge-info" style="background:#3b82f6; color:#fff; font-size:11px; padding:2px 8px;">${g.count}</span></td>
            <td style="text-align:right; color:#1d4ed8;">${g.pcs.toFixed(0)}</td>
            <td style="text-align:right; color:#047857;">${g.recpcs.toFixed(0)}</td>
            <td style="text-align:right;">${g.secpcs.toFixed(0)}</td>
            <td style="text-align:right;">${g.shtpcs.toFixed(0)}</td>
            <td style="text-align:right; color:${g.balpcs > 0 ? '#dc2626' : '#0f172a'}; font-size:14px;">${g.balpcs.toFixed(0)}</td>
            <td style="text-align:right;">${g.wastepcs.toFixed(0)}</td>
            <td style="text-align:right;">${g.retpcs.toFixed(0)}</td>
          </tr>
        `;
      });

      tableHtml += `
        <tr class="br-grand-total-row">
          <td style="text-align:left;">GRAND TOTAL (${sortedGroupKeys.length} Groups / ${filtered.length} Entries):</td>
          <td style="text-align:center;">${filtered.length}</td>
          <td style="text-align:right; color:#1d4ed8; font-size:14px;">${totalPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#047857; font-size:14px;">${totalRecPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalSecPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalShtPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#dc2626; font-size:15px;">${totalBalPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalWastePcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalRetPcs.toFixed(0)}</td>
        </tr>
        </tbody></table>
      `;
    } else {
      // ════════════════════════════════════════════════════════════════════════
      // FULL DETAILED TABLE RENDER MATCHING EXCEL HEADERS EXACTLY
      // DATE | JOBBER | ISSSR | JOBITEM | PCS | PLAIN PCS | RATE | REC PCS | SEC PCS | SHT PCS | BAL PCS | WASTE PCS | RET PCS | Purc Sr | fabrics
      // ════════════════════════════════════════════════════════════════════════
      tableHtml = `
        <table class="br-table print-table" style="width:100%;">
          <thead>
            <tr style="background:#eab308; color:#000000; font-weight:800;">
              <th style="text-align:center; width:65px;">PHOTO</th>
              <th>DATE</th>
              <th>JOBBER</th>
              <th>ISSSR</th>
              <th>JOBITEM</th>
              <th>PCS</th>
              <th>PLAIN PCS</th>
              <th>RATE</th>
              <th>REC PCS</th>
              <th>SEC PCS</th>
              <th>SHT PCS</th>
              <th>BAL PCS</th>
              <th>WASTE PCS</th>
              <th>RET PCS</th>
              <th>Purc Sr</th>
              <th>fabrics</th>
              <th>AGENT</th>
              <th>LOT NO</th>
              <th>SERIES</th>
              <th>INWARD TYPE</th>
              <th>STAT</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
      `;

      filtered.forEach(row => {
        const isOpening = row.is_opening === true;
        if (!isOpening) {
          totalPcs += row.pcs;
          totalPlainPcs += row.plainpcs;
          totalRecPcs += row.recpcs;
          totalSecPcs += row.secpcs;
          totalShtPcs += row.shtpcs;
          totalWastePcs += row.wastepcs;
          totalRetPcs += row.retpcs;
        }
        totalBalPcs += row.balpcs;

        const rowBg = isOpening ? 'background:#fef9c3;' : '';
        const dateCell = isOpening ? `<span style="background:#fbbf24;color:#78350f;padding:2px 6px;border-radius:4px;font-weight:800;font-size:11px;">OPG</span>` : row.date;
        const statBadge = isOpening ? `<span style="background:#fbbf24;color:#78350f;padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px;">OPENING</span>` : (row.stat === 'C' ? `<span style="color:#16a34a;font-weight:700;">CLOSE</span>` : `<span style="color:#dc2626;font-weight:700;">PENDING</span>`);

        const jsonStr = encodeURIComponent(JSON.stringify(row));

        tableHtml += `
          <tr style="${rowBg}">
            <td style="text-align:center; vertical-align:middle; padding:4px !important;">
              ${renderInlineChallanPhoto(row.isssr || row.issno)}
            </td>
            <td>${dateCell}</td>
            <td class="cell-party" style="font-weight:700; text-align:left;">${row.jobber}</td>
            <td style="font-weight:700; color:#1d4ed8;">${row.isssr}</td>
            <td class="cell-item" style="text-align:left; font-weight:600;">${row.jobitem}</td>
            <td style="text-align:right; font-weight:700; color:#1d4ed8;">${row.pcs.toFixed(0)}</td>
            <td style="text-align:right;">${row.plainpcs.toFixed(0)}</td>
            <td style="text-align:right;">${isOpening ? '-' : '₹' + row.rate.toFixed(2)}</td>
            <td style="text-align:right; font-weight:700; color:#047857;">${row.recpcs.toFixed(0)}</td>
            <td style="text-align:right;">${row.secpcs.toFixed(0)}</td>
            <td style="text-align:right;">${row.shtpcs.toFixed(0)}</td>
            <td style="text-align:right; font-weight:700; color:${row.balpcs > 0 ? '#dc2626' : '#0f172a'}; font-size:13px;">${row.balpcs.toFixed(0)}</td>
            <td style="text-align:right;">${row.wastepcs.toFixed(0)}</td>
            <td style="text-align:right;">${row.retpcs.toFixed(0)}</td>
            <td style="font-weight:600; color:#475569;">${row.purchase_bill_no || '-'}</td>
            <td style="text-align:left;">${row.fabrics || row.itemname || '-'}</td>
            <td style="text-align:left; font-size:11px;">${row.agent || '-'}</td>
            <td style="text-align:center; font-size:11px;">${row.lotno || '-'}</td>
            <td style="text-align:center; font-size:11px; font-weight:600;">${row.series || '-'}</td>
            <td style="text-align:center; font-size:11px; font-weight:600;">${row.inwtype || '-'}</td>
            <td style="text-align:center;">${statBadge}</td>
            <td style="text-align:center; white-space:nowrap;">
              <button type="button" class="btn btn-sm btn-secondary" onclick="openChallanModal('${jsonStr}')" style="padding:3px 8px; font-size:11px;" title="View Details"><i class="fa-solid fa-eye"></i> Details</button>
            </td>
          </tr>
        `;

      });

      tableHtml += `
        <tr class="br-grand-total-row">
          <td colspan="4" style="text-align:right;">GRAND TOTAL (${filtered.length} entries):</td>
          <td style="text-align:right; color:#1d4ed8; font-size:14px;">${totalPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalPlainPcs.toFixed(0)}</td>
          <td></td>
          <td style="text-align:right; color:#047857; font-size:14px;">${totalRecPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalSecPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalShtPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#dc2626; font-size:15px;">${totalBalPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalWastePcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalRetPcs.toFixed(0)}</td>
          <td colspan="8"></td>
        </tr>
        </tbody></table>
      `;
    }

    let cardHtml = "";
    filtered.forEach(row => {
      const isOpening = row.is_opening === true;
      const jsonStr = encodeURIComponent(JSON.stringify(row));
      cardHtml += `
        <div class="card" style="background:${isOpening ? '#fef9c3' : '#ffffff'}; border:1px solid ${isOpening ? '#fbbf24' : '#cbd5e1'}; border-radius:10px; padding:12px; margin-bottom:10px; color:#0f172a; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">
            <span style="font-weight:800; font-size:14px; color:#0f172a;">${row.jobber}</span>
            <div style="display:flex; gap:6px; align-items:center;">
              <span style="font-size:11px; background:${isOpening ? '#fbbf24' : '#dbeafe'}; color:${isOpening ? '#78350f' : '#1e40af'}; font-weight:700; padding:2px 8px; border-radius:4px;">${isOpening ? 'OPENING' : row.isssr}</span>
              ${renderInlineChallanPhoto(row.isssr || row.issno)}
              <button type="button" class="btn btn-sm btn-secondary" onclick="openChallanModal('${jsonStr}')" style="padding:2px 6px; font-size:10px;"><i class="fa-solid fa-eye"></i></button>
            </div>
          </div>


          <div style="font-size:13px; font-weight:700; color:#1d4ed8; margin-bottom:6px;">${row.jobitem} ${row.fabrics ? '(' + row.fabrics + ')' : ''}</div>
          <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; font-size:12px; background:#f8fafc; padding:8px; border-radius:6px; margin-bottom:6px;">
            <div><span style="color:#64748b; font-size:10px; display:block;">PCS</span><strong style="color:#1d4ed8;">${row.pcs.toFixed(0)}</strong></div>
            <div><span style="color:#64748b; font-size:10px; display:block;">REC PCS</span><strong style="color:#047857;">${row.recpcs.toFixed(0)}</strong></div>
            <div><span style="color:#64748b; font-size:10px; display:block;">BAL PCS</span><strong style="color:${row.balpcs > 0 ? '#dc2626' : '#0f172a'};">${row.balpcs.toFixed(0)}</strong></div>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:11px; color:#475569;">
            <span>Date: <strong>${row.date}</strong></span>
            <span>Rate: <strong>${isOpening ? '-' : '₹' + row.rate.toFixed(2)}</strong></span>
            ${row.agent ? `<span>Agent: <strong>${row.agent}</strong></span>` : ''}
          </div>
        </div>
      `;
    });

    if (jiList) jiList.innerHTML = cardHtml;
    if (jiTableWrapper) jiTableWrapper.innerHTML = tableHtml;
    if (printTableContainer) printTableContainer.innerHTML = tableHtml;

    const summaryEl = document.getElementById("ji-summary");
    if (summaryEl) {
      summaryEl.style.display = "block";
      document.getElementById("ji-total-rows").textContent = filtered.length;
      document.getElementById("ji-total-pcs").textContent = totalPcs.toFixed(0);
      document.getElementById("ji-total-recpcs").textContent = totalRecPcs.toFixed(0);
      document.getElementById("ji-total-balpcs").textContent = totalBalPcs.toFixed(0);
    }

    renderJobIssuePartySummary();
  }

  function renderJobIssuePartySummary() {
    const wrapper = document.getElementById("ji-summary-wrapper");
    if (!wrapper) return;

    const filtered = getFilteredJobIssueData();
    if (!filtered.length) {
      wrapper.innerHTML = `<div class="empty-state" style="padding:20px; text-align:center; color:var(--text-sub);">No records for Party Summary</div>`;
      return;
    }

    const parties = {};
    filtered.forEach(r => {
      const party = r.jobber || 'UNSPECIFIED';
      if (!parties[party]) {
        parties[party] = {
          party: party,
          count: 0,
          pcs: 0,
          recpcs: 0,
          secpcs: 0,
          shtpcs: 0,
          balpcs: 0,
          wastepcs: 0,
          retpcs: 0
        };
      }
      parties[party].count += 1;
      if (!r.is_opening) {
        parties[party].pcs += r.pcs;
        parties[party].recpcs += r.recpcs;
        parties[party].secpcs += r.secpcs;
        parties[party].shtpcs += r.shtpcs;
        parties[party].wastepcs += r.wastepcs;
        parties[party].retpcs += r.retpcs;
      }
      parties[party].balpcs += r.balpcs;
    });

    const sortedParties = Object.values(parties).sort((a, b) => b.balpcs - a.balpcs);

    let gPcs = 0, gRec = 0, gSec = 0, gSht = 0, gBal = 0, gWaste = 0, gRet = 0, gCount = 0;

    let html = `
      <table class="br-table print-table" style="width:100%;">
        <thead>
          <tr style="background:#1e293b; color:#ffffff;">
            <th style="text-align:left;">S.NO</th>
            <th style="text-align:left;">JOBBER / PARTY NAME</th>
            <th style="text-align:center;">CHALLANS</th>
            <th style="text-align:right;">ISSUED PCS</th>
            <th style="text-align:right;">REC PCS</th>
            <th style="text-align:right;">SEC PCS</th>
            <th style="text-align:right;">SHT PCS</th>
            <th style="text-align:right;">BAL PCS</th>
            <th style="text-align:right;">WASTE PCS</th>
            <th style="text-align:right;">RET PCS</th>
          </tr>
        </thead>
        <tbody>
    `;

    sortedParties.forEach((p, i) => {
      gCount += p.count;
      gPcs += p.pcs;
      gRec += p.recpcs;
      gSec += p.secpcs;
      gSht += p.shtpcs;
      gBal += p.balpcs;
      gWaste += p.wastepcs;
      gRet += p.retpcs;

      html += `
        <tr>
          <td style="text-align:left; font-weight:700;">${i + 1}</td>
          <td style="text-align:left; font-weight:700; color:#1d4ed8;">${p.party}</td>
          <td style="text-align:center;"><span class="badge badge-info" style="background:#3b82f6; color:#fff; font-size:11px; padding:2px 8px;">${p.count}</span></td>
          <td style="text-align:right; font-weight:700; color:#1d4ed8;">${p.pcs.toFixed(0)}</td>
          <td style="text-align:right; font-weight:700; color:#047857;">${p.recpcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.secpcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.shtpcs.toFixed(0)}</td>
          <td style="text-align:right; font-weight:700; color:${p.balpcs > 0 ? '#dc2626' : '#0f172a'}; font-size:13px;">${p.balpcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.wastepcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.retpcs.toFixed(0)}</td>
        </tr>
      `;
    });

    html += `
      <tr class="br-grand-total-row" style="background:#0f172a; color:#ffffff; font-weight:800;">
        <td colspan="2" style="text-align:left;">PARTY SUMMARY TOTAL (${sortedParties.length} Parties):</td>
        <td style="text-align:center;">${gCount}</td>
        <td style="text-align:right; color:#60a5fa; font-size:14px;">${gPcs.toFixed(0)}</td>
        <td style="text-align:right; color:#34d399; font-size:14px;">${gRec.toFixed(0)}</td>
        <td style="text-align:right;">${gSec.toFixed(0)}</td>
        <td style="text-align:right;">${gSht.toFixed(0)}</td>
        <td style="text-align:right; color:#f87171; font-size:15px;">${gBal.toFixed(0)}</td>
        <td style="text-align:right;">${gWaste.toFixed(0)}</td>
        <td style="text-align:right;">${gRet.toFixed(0)}</td>
      </tr>
      </tbody></table>
    `;

    wrapper.innerHTML = html;
  }

  function renderJobIssuePartySummary() {
    const wrapper = document.getElementById("ji-summary-wrapper");
    if (!wrapper) return;

    const filtered = getFilteredJobIssueData();
    if (!filtered.length) {
      wrapper.innerHTML = `<div class="empty-state" style="padding:20px; text-align:center; color:var(--text-sub);">No records for Party Summary</div>`;
      return;
    }

    // Group by Jobber
    const parties = {};
    filtered.forEach(r => {
      const party = r.jobber || 'UNSPECIFIED';
      if (!parties[party]) {
        parties[party] = {
          party: party,
          count: 0,
          pcs: 0,
          recpcs: 0,
          secpcs: 0,
          shtpcs: 0,
          balpcs: 0,
          wastepcs: 0,
          retpcs: 0
        };
      }
      parties[party].count += 1;
      if (!r.is_opening) {
        parties[party].pcs += r.pcs;
        parties[party].recpcs += r.recpcs;
        parties[party].secpcs += r.secpcs;
        parties[party].shtpcs += r.shtpcs;
        parties[party].wastepcs += r.wastepcs;
        parties[party].retpcs += r.retpcs;
      }
      parties[party].balpcs += r.balpcs;
    });

    const sortedParties = Object.values(parties).sort((a, b) => b.balpcs - a.balpcs);

    let gPcs = 0, gRec = 0, gSec = 0, gSht = 0, gBal = 0, gWaste = 0, gRet = 0, gCount = 0;

    let html = `
      <table class="br-table print-table" style="width:100%;">
        <thead>
          <tr style="background:#1e293b; color:#ffffff;">
            <th style="text-align:left;">S.NO</th>
            <th style="text-align:left;">JOBBER / PARTY NAME</th>
            <th style="text-align:center;">CHALLANS</th>
            <th style="text-align:right;">TOTAL PCS</th>
            <th style="text-align:right;">REC PCS</th>
            <th style="text-align:right;">SEC PCS</th>
            <th style="text-align:right;">SHT PCS</th>
            <th style="text-align:right;">BAL PCS</th>
            <th style="text-align:right;">WASTE PCS</th>
            <th style="text-align:right;">RET PCS</th>
          </tr>
        </thead>
        <tbody>
    `;

    sortedParties.forEach((p, idx) => {
      gCount += p.count;
      gPcs += p.pcs;
      gRec += p.recpcs;
      gSec += p.secpcs;
      gSht += p.shtpcs;
      gBal += p.balpcs;
      gWaste += p.wastepcs;
      gRet += p.retpcs;

      html += `
        <tr>
          <td>${idx + 1}</td>
          <td class="cell-party" style="font-weight:700; text-align:left;">${p.party}</td>
          <td style="text-align:center; font-weight:700; color:#1e40af;">${p.count}</td>
          <td style="text-align:right; font-weight:700; color:#1d4ed8;">${p.pcs.toFixed(0)}</td>
          <td style="text-align:right; font-weight:700; color:#047857;">${p.recpcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.secpcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.shtpcs.toFixed(0)}</td>
          <td style="text-align:right; font-weight:800; color:${p.balpcs > 0 ? '#dc2626' : '#0f172a'};">${p.balpcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.wastepcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.retpcs.toFixed(0)}</td>
        </tr>
      `;
    });

    html += `
      <tr class="br-grand-total-row">
        <td colspan="2" style="text-align:right; font-weight:800;">GRAND TOTAL (${sortedParties.length} Parties):</td>
        <td style="text-align:center; font-weight:800; color:#1e40af;">${gCount}</td>
        <td style="text-align:right; color:#1d4ed8; font-size:14px; font-weight:800;">${gPcs.toFixed(0)}</td>
        <td style="text-align:right; color:#047857; font-weight:800;">${gRec.toFixed(0)}</td>
        <td style="text-align:right; font-weight:800;">${gSec.toFixed(0)}</td>
        <td style="text-align:right; font-weight:800;">${gSht.toFixed(0)}</td>
        <td style="text-align:right; color:#dc2626; font-size:14px; font-weight:800;">${gBal.toFixed(0)}</td>
        <td style="text-align:right; font-weight:800;">${gWaste.toFixed(0)}</td>
        <td style="text-align:right; font-weight:800;">${gRet.toFixed(0)}</td>
      </tr>
      </tbody></table>
    `;

    wrapper.innerHTML = html;
  }

  const jiSearch = document.getElementById("ji-search");
  if (jiSearch) jiSearch.addEventListener("input", filterAndRenderJobIssue);
  const btnLoadJobIssue = document.getElementById("btn-load-job-issue");
  if (btnLoadJobIssue) btnLoadJobIssue.addEventListener("click", loadJobIssueReport);
  const jiInwType = document.getElementById("ji-inw-type");
  if (jiInwType) jiInwType.addEventListener("change", loadJobIssueReport);
  const jiIncludeOpening = document.getElementById("ji-include-opening");
  if (jiIncludeOpening) jiIncludeOpening.addEventListener("change", loadJobIssueReport);

  document.querySelectorAll('input[name="ji_status"]').forEach(r => {
    r.addEventListener("change", loadJobIssueReport);
  });


  // ══════════════════════════════════════════════════════════════════════════
  // JOB REPROCESS REPORT ENGINE
  // ══════════════════════════════════════════════════════════════════════════
  let allJobReprocessData = [];

  window.toggleAllJobTypes = function(selectAll) {
    document.querySelectorAll('.jr-jt-cb').forEach(cb => {
      cb.checked = selectAll;
    });
    loadJobReprocessReport();
  };

  window.loadJobReprocessReport = function() {
    const btnLoad = document.getElementById("btn-load-job-reprocess");
    if (btnLoad) {
      btnLoad.disabled = true;
      btnLoad.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Loading...`;
    }

    const dateFrom = document.getElementById("jr-date-from")?.value || "";
    const dateTo = document.getElementById("jr-date-to")?.value || "";
    const jobber = document.getElementById("jr-jobber")?.value || "";
    const item = document.getElementById("jr-item")?.value || "";
    const inwType = document.getElementById("jr-inw-type")?.value || "All";
    
    const checkedJt = Array.from(document.querySelectorAll('.jr-jt-cb:checked')).map(cb => cb.value);
    const jobTypeParam = checkedJt.length ? checkedJt.join(",") : "All";

    const statusEl = document.querySelector('input[name="jr_status"]:checked');
    const statusVal = statusEl ? statusEl.value : "Pending";
    const includeOpening = document.getElementById("jr-include-opening")?.checked ? "true" : "false";

    let url = `/api/job_reprocess_report?job_type=${encodeURIComponent(jobTypeParam)}&status=${encodeURIComponent(statusVal)}&jobber=${encodeURIComponent(jobber)}&item=${encodeURIComponent(item)}&inw_type=${encodeURIComponent(inwType)}&date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}&include_opening=${includeOpening}`;

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (btnLoad) {
          btnLoad.disabled = false;
          btnLoad.innerHTML = `<i class="fa-solid fa-bolt"></i> Load Job Reprocess Report`;
        }
        if (data.status === "success") {
          allJobReprocessData = data.data || [];
          filterAndRenderJobReprocess();
          window.showSnapshotBanner(data);
          const jrCard = document.getElementById("jr-filter-card") || document.getElementById("jobReprocessReportCard");
          if (jrCard) jrCard.classList.add("collapsed");
        } else {
          alert(data.error || "Failed to load Job Reprocess data");
        }
      })
      .catch(err => {
        if (btnLoad) {
          btnLoad.disabled = false;
          btnLoad.innerHTML = `<i class="fa-solid fa-bolt"></i> Load Job Reprocess Report`;
        }
        console.error("Job Reprocess Load Error:", err);
        alert("Error connecting to server to load Job Reprocess report.");
      });
  };

  function getFilteredJobReprocessData() {
    const searchTerm = (document.getElementById("jr-search")?.value || "").toLowerCase().trim();
    return allJobReprocessData.filter(row => {
      if (!searchTerm) return true;
      return (
        (row.issno && row.issno.toLowerCase().includes(searchTerm)) ||
        (row.recsr && row.recsr.toLowerCase().includes(searchTerm)) ||
        (row.date && row.date.toLowerCase().includes(searchTerm)) ||
        (row.jobber && row.jobber.toLowerCase().includes(searchTerm)) ||
        (row.jobitem && row.jobitem.toLowerCase().includes(searchTerm)) ||
        (row.itemname && row.itemname.toLowerCase().includes(searchTerm)) ||
        (row.agent && row.agent.toLowerCase().includes(searchTerm)) ||
        (row.series && row.series.toLowerCase().includes(searchTerm)) ||
        (row.lotno && row.lotno.toLowerCase().includes(searchTerm)) ||
        (row.jobtype && row.jobtype.toLowerCase().includes(searchTerm)) ||
        (row.inwtype && row.inwtype.toLowerCase().includes(searchTerm))
      );
    });
  }

  function filterAndRenderJobReprocess() {
    const filtered = getFilteredJobReprocessData();

    const jrList = document.getElementById("jr-list");
    const jrTableWrapper = document.getElementById("jr-table-wrapper");
    const printTableContainer = document.getElementById("jr-print-table");

    if (!filtered.length) {
      const emptyHtml = `<div class="empty-state" style="padding: 30px; text-align: center;"><i class="fa-solid fa-folder-open" style="font-size:36px; color:var(--text-sub);"></i><p style="margin-top:10px; color:var(--text-sub); font-weight:600;">No Job Reprocess records found matching filters.</p></div>`;
      if (jrList) jrList.innerHTML = emptyHtml;
      if (jrTableWrapper) jrTableWrapper.innerHTML = emptyHtml;
      if (printTableContainer) printTableContainer.innerHTML = "";
      const sumEl = document.getElementById("jr-summary");
      if (sumEl) sumEl.style.display = "none";
      return;
    }

    let totalPcs = 0, totalRecPcs = 0, totalPlainPcs = 0, totalRfPcs = 0, totalSecPcs = 0, totalShtPcs = 0, totalBalPcs = 0;

    const groupPattern = document.getElementById("jr-group-pattern")?.value || "None";

    let tableHtml = "";

    if (groupPattern !== "None") {
      const groupKeyMap = {
        'Jobber': 'jobber',
        'JobItem': 'jobitem',
        'Agent': 'agent',
        'LotNo': 'lotno',
        'Series': 'series',
        'InwType': 'inwtype',
        'JobType': 'jobtype'
      };
      const keyField = groupKeyMap[groupPattern] || 'jobber';

      const groups = {};
      filtered.forEach(row => {
        const val = (row[keyField] || 'UNSPECIFIED').toString().trim() || 'UNSPECIFIED';
        if (!groups[val]) {
          groups[val] = {
            name: val,
            rows: [],
            count: 0,
            pcs: 0,
            recpcs: 0,
            plainpcs: 0,
            rfpcs: 0,
            secpcs: 0,
            shtpcs: 0,
            balpcs: 0
          };
        }
        groups[val].rows.push(row);
        groups[val].count += 1;
        if (!row.is_opening) {
          groups[val].pcs += row.pcs;
          groups[val].recpcs += row.recpcs;
          groups[val].plainpcs += row.plainpcs;
          groups[val].rfpcs += row.rfpcs;
          groups[val].secpcs += row.secpcs;
          groups[val].shtpcs += row.shtpcs;
          totalPcs += row.pcs;
          totalRecPcs += row.recpcs;
          totalPlainPcs += row.plainpcs;
          totalRfPcs += row.rfpcs;
          totalSecPcs += row.secpcs;
          totalShtPcs += row.shtpcs;
        }
        groups[val].balpcs += row.balpcs;
        totalBalPcs += row.balpcs;
      });

      const sortedGroupKeys = Object.keys(groups).sort((a,b) => groups[b].balpcs - groups[a].balpcs);

      tableHtml = `
        <div style="background:#2563eb; color:#ffffff; padding:8px 12px; font-weight:700; font-size:13px; border-radius:8px 8px 0 0; display:flex; justify-space-between; align-items:center;">
          <span><i class="fa-solid fa-layer-group"></i> GROUPED BY: ${groupPattern.toUpperCase()} (${sortedGroupKeys.length} Groups)</span>
        </div>
        <table class="br-table print-table" style="width:100%;">
          <thead>
            <tr style="background:#0f172a; color:#ffffff;">
              <th style="text-align:left;">${groupPattern.toUpperCase()} GROUP</th>
              <th style="text-align:center;">CHALLANS</th>
              <th style="text-align:right;">ISSUED PCS</th>
              <th style="text-align:right;">REC PCS</th>
              <th style="text-align:right;">PLAIN PCS</th>
              <th style="text-align:right;">RF PCS</th>
              <th style="text-align:right;">SEC PCS</th>
              <th style="text-align:right;">SHT PCS</th>
              <th style="text-align:right;">BAL PCS</th>
            </tr>
          </thead>
          <tbody>
      `;

      sortedGroupKeys.forEach((gKey, idx) => {
        const g = groups[gKey];
        tableHtml += `
          <tr style="background:${idx % 2 === 0 ? '#f8fafc' : '#ffffff'}; font-weight:700;">
            <td style="text-align:left; color:#1d4ed8; font-size:13px;">${g.name}</td>
            <td style="text-align:center;"><span class="badge badge-info" style="background:#3b82f6; color:#fff; font-size:11px; padding:2px 8px;">${g.count}</span></td>
            <td style="text-align:right; color:#1d4ed8;">${g.pcs.toFixed(0)}</td>
            <td style="text-align:right; color:#047857;">${g.recpcs.toFixed(0)}</td>
            <td style="text-align:right;">${g.plainpcs.toFixed(0)}</td>
            <td style="text-align:right; color:#047857;">${g.rfpcs.toFixed(0)}</td>
            <td style="text-align:right;">${g.secpcs.toFixed(0)}</td>
            <td style="text-align:right;">${g.shtpcs.toFixed(0)}</td>
            <td style="text-align:right; color:${g.balpcs > 0 ? '#dc2626' : '#0f172a'}; font-size:14px;">${g.balpcs.toFixed(0)}</td>
          </tr>
        `;
      });

      tableHtml += `
        <tr class="br-grand-total-row">
          <td style="text-align:left;">GRAND TOTAL (${sortedGroupKeys.length} Groups / ${filtered.length} Entries):</td>
          <td style="text-align:center;">${filtered.length}</td>
          <td style="text-align:right; color:#1d4ed8; font-size:14px;">${totalPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#047857; font-size:14px;">${totalRecPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalPlainPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#047857; font-size:14px;">${totalRfPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalSecPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalShtPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#dc2626; font-size:15px;">${totalBalPcs.toFixed(0)}</td>
        </tr>
        </tbody></table>
      `;
    } else {
      tableHtml = `
        <table class="br-table print-table" style="width:100%;">
          <thead>
            <tr>
              <th style="text-align:center; width:65px;">PHOTO</th>
              <th>ISSNO</th>
              <th>RECSR</th>
              <th>DATE</th>
              <th>JOBBER</th>
              <th>JOBITEM</th>
              <th>ITEM NAME</th>
              <th>AGENT</th>
              <th>LOT NO</th>
              <th>SERIES</th>
              <th>PCS</th>
              <th>RECPCS</th>
              <th>PLAINPCS</th>
              <th>RFPCS</th>
              <th>SECPCS</th>
              <th>SHTPCS</th>
              <th>BALPCS</th>
              <th>RATE</th>
              <th>JOBTYPE</th>
              <th>INWARD TYPE</th>
              <th>STAT</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
      `;

      filtered.forEach(row => {
        const isOpening = row.is_opening === true;
        if (!isOpening) {
          totalPcs += row.pcs;
          totalRecPcs += row.recpcs;
          totalPlainPcs += row.plainpcs;
          totalRfPcs += row.rfpcs;
          totalSecPcs += row.secpcs;
          totalShtPcs += row.shtpcs;
        }
        totalBalPcs += row.balpcs;

        const rowBg = isOpening ? 'background:#fef9c3;' : '';
        const dateCell = isOpening ? `<span style="background:#fbbf24;color:#78350f;padding:2px 6px;border-radius:4px;font-weight:800;font-size:11px;">OPG</span>` : row.date;
        const statBadge = isOpening ? `<span style="background:#fbbf24;color:#78350f;padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px;">OPENING</span>` : (row.stat === 'C' ? `<span style="color:#16a34a;font-weight:700;">CLOSE</span>` : `<span style="color:#dc2626;font-weight:700;">PENDING</span>`);

        const jsonStr = encodeURIComponent(JSON.stringify(row));

        tableHtml += `
          <tr style="${rowBg}">
            <td style="text-align:center; vertical-align:middle; padding:4px !important;">
              ${renderInlineChallanPhoto(row.issno || row.recsr)}
            </td>
            <td style="font-weight:700; color:#1d4ed8;">${row.issno}</td>
            <td style="font-weight:700; color:#047857;">${row.recsr}</td>
            <td>${dateCell}</td>
            <td class="cell-party" style="font-weight:700; text-align:left;">${row.jobber}</td>
            <td class="cell-item" style="text-align:left; font-weight:600;">${row.jobitem}</td>
            <td style="text-align:left; font-size:11px;">${row.itemname || '-'}</td>
            <td style="text-align:left; font-size:11px;">${row.agent || '-'}</td>
            <td style="text-align:center; font-size:11px;">${row.lotno || '-'}</td>
            <td style="text-align:center; font-size:11px; font-weight:600;">${row.series || '-'}</td>
            <td style="text-align:right; font-weight:700; color:#1d4ed8;">${row.pcs.toFixed(0)}</td>
            <td style="text-align:right; font-weight:700; color:#047857;">${row.recpcs.toFixed(0)}</td>
            <td style="text-align:right;">${row.plainpcs.toFixed(0)}</td>
            <td style="text-align:right; font-weight:700; color:#047857;">${row.rfpcs.toFixed(0)}</td>
            <td style="text-align:right;">${row.secpcs.toFixed(0)}</td>
            <td style="text-align:right;">${row.shtpcs.toFixed(0)}</td>
            <td style="text-align:right; font-weight:700; color:${row.balpcs > 0 ? '#dc2626' : '#0f172a'}; font-size:13px;">${row.balpcs.toFixed(0)}</td>
            <td style="text-align:right;">${isOpening ? '-' : '₹' + row.rate.toFixed(2)}</td>
            <td style="text-align:center; font-size:11px; font-weight:700;">${row.jobtype || '-'}</td>
            <td style="text-align:center; font-size:11px; font-weight:600;">${row.inwtype || '-'}</td>
            <td style="text-align:center;">${statBadge}</td>
            <td style="text-align:center; white-space:nowrap;">
              <button type="button" class="btn btn-sm btn-secondary" onclick="openChallanModal('${jsonStr}')" style="padding:3px 8px; font-size:11px;" title="View Details"><i class="fa-solid fa-eye"></i> Details</button>
            </td>
          </tr>
        `;

      });

      tableHtml += `
        <tr class="br-grand-total-row">
          <td colspan="10" style="text-align:right;">GRAND TOTAL (${filtered.length} entries):</td>
          <td style="text-align:right; color:#1d4ed8; font-size:14px;">${totalPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#047857; font-size:14px;">${totalRecPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalPlainPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#047857; font-size:14px;">${totalRfPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalSecPcs.toFixed(0)}</td>
          <td style="text-align:right;">${totalShtPcs.toFixed(0)}</td>
          <td style="text-align:right; color:#dc2626; font-size:15px;">${totalBalPcs.toFixed(0)}</td>
          <td colspan="5"></td>
        </tr>
        </tbody></table>
      `;
    }

    let cardHtml = "";
    filtered.forEach(row => {
      const isOpening = row.is_opening === true;
      const jsonStr = encodeURIComponent(JSON.stringify(row));
      cardHtml += `
        <div class="card" style="background:${isOpening ? '#fef9c3' : '#ffffff'}; border:1px solid ${isOpening ? '#fbbf24' : '#cbd5e1'}; border-radius:10px; padding:12px; margin-bottom:10px; color:#0f172a; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">
            <span style="font-weight:800; font-size:14px; color:#0f172a;">${row.jobber}</span>
            <div style="display:flex; gap:6px; align-items:center;">
              <span style="font-size:11px; background:${isOpening ? '#fbbf24' : '#dbeafe'}; color:${isOpening ? '#78350f' : '#1e40af'}; font-weight:700; padding:2px 8px; border-radius:4px;">ISS: ${row.issno}</span>
              <span style="font-size:11px; background:#d1fae5; color:#065f46; font-weight:700; padding:2px 6px; border-radius:4px;">REC: ${row.recsr}</span>
              ${renderInlineChallanPhoto(row.issno || row.recsr)}
              <button type="button" class="btn btn-sm btn-secondary" onclick="openChallanModal('${jsonStr}')" style="padding:2px 6px; font-size:10px;"><i class="fa-solid fa-eye"></i></button>
            </div>
          </div>

          <div style="font-size:13px; font-weight:700; color:#1d4ed8; margin-bottom:6px;">${row.jobitem} ${row.jobtype ? '[' + row.jobtype + ']' : ''}</div>
          <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; font-size:12px; background:#f8fafc; padding:8px; border-radius:6px; margin-bottom:6px;">
            <div><span style="color:#64748b; font-size:10px; display:block;">PCS</span><strong style="color:#1d4ed8;">${row.pcs.toFixed(0)}</strong></div>
            <div><span style="color:#64748b; font-size:10px; display:block;">RF PCS</span><strong style="color:#047857;">${row.rfpcs.toFixed(0)}</strong></div>
            <div><span style="color:#64748b; font-size:10px; display:block;">BAL PCS</span><strong style="color:${row.balpcs > 0 ? '#dc2626' : '#0f172a'};">${row.balpcs.toFixed(0)}</strong></div>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:11px; color:#475569;">
            <span>Date: <strong>${row.date}</strong></span>
            <span>Rate: <strong>${isOpening ? '-' : '₹' + row.rate.toFixed(2)}</strong></span>
            ${row.agent ? `<span>Agent: <strong>${row.agent}</strong></span>` : ''}
          </div>
        </div>
      `;
    });

    if (jrList) jrList.innerHTML = cardHtml;
    if (jrTableWrapper) jrTableWrapper.innerHTML = tableHtml;
    if (printTableContainer) printTableContainer.innerHTML = tableHtml;

    const summaryEl = document.getElementById("jr-summary");
    if (summaryEl) {
      summaryEl.style.display = "block";
      document.getElementById("jr-total-rows").textContent = filtered.length;
      document.getElementById("jr-total-pcs").textContent = totalPcs.toFixed(0);
      document.getElementById("jr-total-rfpcs").textContent = totalRfPcs.toFixed(0);
      document.getElementById("jr-total-balpcs").textContent = totalBalPcs.toFixed(0);
    }

    renderJobReprocessPartySummary();
  }

  function renderJobReprocessPartySummary() {
    const wrapper = document.getElementById("jr-summary-wrapper");
    if (!wrapper) return;

    const filtered = getFilteredJobReprocessData();
    if (!filtered.length) {
      wrapper.innerHTML = `<div class="empty-state" style="padding:20px; text-align:center; color:var(--text-sub);">No records for Party Summary</div>`;
      return;
    }

    const parties = {};
    filtered.forEach(r => {
      const party = r.jobber || 'UNSPECIFIED';
      if (!parties[party]) {
        parties[party] = {
          party: party,
          count: 0,
          pcs: 0,
          plainpcs: 0,
          rfpcs: 0,
          balpcs: 0
        };
      }
      parties[party].count += 1;
      if (!r.is_opening) {
        parties[party].pcs += r.pcs;
        parties[party].plainpcs += r.plainpcs;
        parties[party].rfpcs += r.rfpcs;
      }
      parties[party].balpcs += r.balpcs;
    });

    const sortedParties = Object.values(parties).sort((a, b) => b.balpcs - a.balpcs);

    let gPcs = 0, gPlain = 0, gRf = 0, gBal = 0, gCount = 0;

    let html = `
      <table class="br-table print-table" style="width:100%;">
        <thead>
          <tr style="background:#1e293b; color:#ffffff;">
            <th style="text-align:left;">S.NO</th>
            <th style="text-align:left;">JOBBER / PARTY NAME</th>
            <th style="text-align:center;">CHALLANS</th>
            <th style="text-align:right;">TOTAL PCS</th>
            <th style="text-align:right;">PLAIN PCS</th>
            <th style="text-align:right;">RF PCS</th>
            <th style="text-align:right;">BAL PCS</th>
          </tr>
        </thead>
        <tbody>
    `;

    sortedParties.forEach((p, idx) => {
      gCount += p.count;
      gPcs += p.pcs;
      gPlain += p.plainpcs;
      gRf += p.rfpcs;
      gBal += p.balpcs;

      html += `
        <tr>
          <td>${idx + 1}</td>
          <td class="cell-party" style="font-weight:700; text-align:left;">${p.party}</td>
          <td style="text-align:center; font-weight:700; color:#1e40af;">${p.count}</td>
          <td style="text-align:right; font-weight:700; color:#1d4ed8;">${p.pcs.toFixed(0)}</td>
          <td style="text-align:right;">${p.plainpcs.toFixed(0)}</td>
          <td style="text-align:right; font-weight:700; color:#047857;">${p.rfpcs.toFixed(0)}</td>
          <td style="text-align:right; font-weight:800; color:${p.balpcs > 0 ? '#dc2626' : '#0f172a'};">${p.balpcs.toFixed(0)}</td>
        </tr>
      `;
    });

    html += `
      <tr class="br-grand-total-row">
        <td colspan="2" style="text-align:right; font-weight:800;">GRAND TOTAL (${sortedParties.length} Parties):</td>
        <td style="text-align:center; font-weight:800; color:#1e40af;">${gCount}</td>
        <td style="text-align:right; color:#1d4ed8; font-size:14px; font-weight:800;">${gPcs.toFixed(0)}</td>
        <td style="text-align:right; font-weight:800;">${gPlain.toFixed(0)}</td>
        <td style="text-align:right; color:#047857; font-weight:800;">${gRf.toFixed(0)}</td>
        <td style="text-align:right; color:#dc2626; font-size:14px; font-weight:800;">${gBal.toFixed(0)}</td>
      </tr>
      </tbody></table>
    `;

    wrapper.innerHTML = html;
  }

  const jrSearch = document.getElementById("jr-search");
  if (jrSearch) jrSearch.addEventListener("input", filterAndRenderJobReprocess);
  const btnLoadJobReprocess = document.getElementById("btn-load-job-reprocess");
  if (btnLoadJobReprocess) btnLoadJobReprocess.addEventListener("click", loadJobReprocessReport);
  const jrInwType = document.getElementById("jr-inw-type");
  if (jrInwType) jrInwType.addEventListener("change", loadJobReprocessReport);
  const jrJobType = document.getElementById("jr-job-type");
  if (jrJobType) jrJobType.addEventListener("change", loadJobReprocessReport);
  const jrIncludeOpening = document.getElementById("jr-include-opening");
  if (jrIncludeOpening) jrIncludeOpening.addEventListener("change", loadJobReprocessReport);

  // Status Radio Change Listeners for Job Reprocess
  document.querySelectorAll('input[name="jr_status"]').forEach(r => {
    r.addEventListener("change", loadJobReprocessReport);
  });

});

// --- Universal Action Functions (Print, Excel Export, WhatsApp Share) ---
window.exportCurrentViewToExcel = function(defaultName) {
  const activeView = document.querySelector('.view-section.active');
  if (!activeView) return;
  const viewId = activeView.id || 'report';
  const filename = (defaultName || viewId.replace('view-', '')) + '_' + new Date().toISOString().slice(0,10);
  
  let table = activeView.querySelector('.print-only-table-container table') || activeView.querySelector('table');
  if (table && typeof XLSX !== 'undefined') {
    const wb = XLSX.utils.table_to_book(table, {sheet: "Report"});
    XLSX.writeFile(wb, filename + ".xlsx");
  } else if (table) {
    // Fallback CSV download
    let csv = [];
    const rows = table.querySelectorAll("tr");
    for (let i = 0; i < rows.length; i++) {
      let row = [], cols = rows[i].querySelectorAll("td, th");
      for (let j = 0; j < cols.length; j++) 
        row.push('"' + cols[j].innerText.replace(/"/g, '""') + '"');
      csv.push(row.join(","));
    }
    const blob = new Blob([csv.join("\n")], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename + ".csv";
    link.click();
  } else {
    alert("No table data found to export for current view.");
  }
};

window.shareCurrentViewToWhatsApp = function() {
  const activeView = document.querySelector('.view-section.active');
  if (!activeView) return;
  const title = activeView.querySelector('.view-title')?.innerText || "SKNT ERP Report";
  
  let text = `📊 *${title.toUpperCase()}*\n📅 Date: ${new Date().toLocaleDateString('en-GB')}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━\n`;

  // Find table rows to format full itemized data
  const table = activeView.querySelector('.br-report-table-wrapper table') || activeView.querySelector('.print-only-table-container table') || activeView.querySelector('table');
  
  if (table) {
    const rows = table.querySelectorAll("tr");
    let count = 0;
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Section Header (e.g. Party / GroupName / Order Date)
      if (row.classList.contains("br-group-header-row") || row.innerText.includes("Party :") || row.innerText.includes("GroupName :") || row.innerText.includes("ItemName :") || row.innerText.includes("Order Date :")) {
        const headerText = row.innerText.trim().replace(/\s+/g, ' ');
        text += `\n📂 *${headerText}*\n`;
        continue;
      }
      
      const ths = row.querySelectorAll("th");
      if (ths.length > 0) continue; // Skip th

      const tds = row.querySelectorAll("td");
      if (tds.length >= 2) {
        count++;
        let rowLine = [];
        tds.forEach((td) => {
          const val = td.innerText.trim();
          if (val) rowLine.push(val);
        });
        if (rowLine.length > 0) {
          text += `▪️ ${rowLine.join(" | ")}\n`;
        }
      }
      if (count >= 150) {
        text += `\n... (+ more items in full report)\n`;
        break;
      }
    }
  } else {
    const summaryDiv = activeView.querySelector('.sticky-summary');
    if (summaryDiv && summaryDiv.innerText) {
      text += summaryDiv.innerText.replace(/\s+/g, ' ') + "\n\n";
    }
  }

  text += `\n━━━━━━━━━━━━━━━━━━━━━\nGenerated via SKNT ERP App`;
  const waUrl = "https://api.whatsapp.com/send?text=" + encodeURIComponent(text);
  window.open(waUrl, "_blank");
};

// View Mode Switcher (Table / Card / Party Summary)
window.switchViewMode = function(prefix, mode) {
  const tableWrapper = document.getElementById(prefix + "-table-wrapper");
  const listWrapper = document.getElementById(prefix + "-list");
  const summaryWrapper = document.getElementById(prefix + "-summary-wrapper");
  const zoomToolbar = document.getElementById(prefix + "-zoom-toolbar");

  const btnTable = document.getElementById(prefix + "-btn-table-mode");
  const btnCard = document.getElementById(prefix + "-btn-card-mode");
  const btnSummary = document.getElementById(prefix + "-btn-summary-mode");

  [btnTable, btnCard, btnSummary].forEach(btn => {
    if (btn) {
      btn.classList.remove("btn-primary", "active");
      btn.classList.add("btn-secondary");
    }
  });

  if (mode === "table") {
    if (tableWrapper) tableWrapper.style.display = "block";
    if (listWrapper) listWrapper.style.display = "none";
    if (summaryWrapper) summaryWrapper.style.display = "none";
    if (zoomToolbar) zoomToolbar.style.display = "flex";
    if (btnTable) {
      btnTable.classList.remove("btn-secondary");
      btnTable.classList.add("btn-primary", "active");
    }
  } else if (mode === "card") {
    if (tableWrapper) tableWrapper.style.display = "none";
    if (listWrapper) listWrapper.style.display = "grid";
    if (summaryWrapper) summaryWrapper.style.display = "none";
    if (zoomToolbar) zoomToolbar.style.display = "none";
    if (btnCard) {
      btnCard.classList.remove("btn-secondary");
      btnCard.classList.add("btn-primary", "active");
    }
  } else if (mode === "summary") {
    if (tableWrapper) tableWrapper.style.display = "none";
    if (listWrapper) listWrapper.style.display = "none";
    if (summaryWrapper) summaryWrapper.style.display = "block";
    if (zoomToolbar) zoomToolbar.style.display = "flex";
    if (btnSummary) {
      btnSummary.classList.remove("btn-secondary");
      btnSummary.classList.add("btn-primary", "active");
    }
  }
};

// Table Zoom Controls
const currentZoomLevels = {};
window.zoomTable = function(prefix, delta) {
  if (!currentZoomLevels[prefix]) currentZoomLevels[prefix] = 1.0;
  if (delta === 0) {
    currentZoomLevels[prefix] = 1.0;
  } else {
    currentZoomLevels[prefix] = Math.min(Math.max(currentZoomLevels[prefix] + delta, 0.5), 1.6);
  }
  const pct = Math.round(currentZoomLevels[prefix] * 100);
  const badge = document.getElementById(prefix + "-zoom-level");
  if (badge) badge.textContent = pct + "%";

  const tableWrapper = document.getElementById(prefix + "-table-wrapper");
  const summaryWrapper = document.getElementById(prefix + "-summary-wrapper");
  [tableWrapper, summaryWrapper].forEach(w => {
    if (w) {
      const tbl = w.querySelector("table");
      if (tbl) tbl.style.zoom = currentZoomLevels[prefix];
    }
  });
};

// Challan Detail Modal Handler
window.openChallanModal = function(rowJson) {
  let row;
  try {
    row = typeof rowJson === 'string' ? JSON.parse(decodeURIComponent(rowJson)) : rowJson;
  } catch(e) {
    console.error("Failed to parse row JSON for modal:", e);
    return;
  }

  const modal = document.getElementById("challan-detail-modal");
  const body = document.getElementById("modal-challan-body");
  const title = document.getElementById("modal-challan-title");

  if (title) title.innerHTML = `<i class="fa-solid fa-file-lines" style="color:#3b82f6;"></i> Challan Details - ${row.jobber || row.isssr || row.issno}`;
  
  let html = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px; font-size:13px;">
      <div><strong style="color:var(--text-sub);">Party / Jobber:</strong> <div style="font-weight:700; color:var(--text-main);">${row.jobber || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Date:</strong> <div style="font-weight:700; color:var(--text-main);">${row.date || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Challan / Issue Serial:</strong> <div style="font-weight:700; color:#1d4ed8;">${row.isssr || row.issno || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Receive Serial:</strong> <div style="font-weight:700; color:#047857;">${row.recsr || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Job Item:</strong> <div style="font-weight:700; color:var(--text-main);">${row.jobitem || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Item Name:</strong> <div style="font-weight:700; color:var(--text-main);">${row.itemname || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Agent:</strong> <div style="font-weight:700; color:#4338ca;">${row.agent || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Lot No:</strong> <div style="font-weight:700; color:var(--text-main);">${row.lotno || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Series:</strong> <div style="font-weight:700; color:var(--text-main);">${row.series || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Fabrics / Group:</strong> <div style="font-weight:700; color:var(--text-main);">${row.fabrics || '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Rate:</strong> <div style="font-weight:700; color:var(--text-main);">${row.rate ? '₹' + row.rate.toFixed(2) : '-'}</div></div>
      <div><strong style="color:var(--text-sub);">Inward Type:</strong> <div style="font-weight:700; color:#854d0e;">${row.inwtype || '-'}</div></div>
      ${row.jobtype ? `<div><strong style="color:var(--text-sub);">Job Type:</strong> <div style="font-weight:700; color:#4338ca;">${row.jobtype}</div></div>` : ''}
      ${row.purchase_bill_no ? `<div><strong style="color:var(--text-sub);">Purchase Bill No:</strong> <div style="font-weight:700; color:var(--text-main);">${row.purchase_bill_no}</div></div>` : ''}
    </div>
    
    <div style="background:var(--bg-app); border:1px solid var(--bg-card-border); border-radius:8px; padding:12px; margin-top:10px;">
      <h4 style="margin:0 0 8px 0; font-size:12px; color:var(--text-sub); text-transform:uppercase;">Piece Breakdown</h4>
      <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; text-align:center;">
        <div style="background:var(--bg-card); padding:8px; border-radius:6px;"><div style="font-size:10px; color:var(--text-sub);">ISSUED PCS</div><strong style="font-size:15px; color:#1d4ed8;">${(row.pcs || 0).toFixed(0)}</strong></div>
        ${row.recpcs !== undefined ? `<div style="background:var(--bg-card); padding:8px; border-radius:6px;"><div style="font-size:10px; color:var(--text-sub);">REC PCS</div><strong style="font-size:15px; color:#047857;">${row.recpcs.toFixed(0)}</strong></div>` : ''}
        ${row.rfpcs !== undefined ? `<div style="background:var(--bg-card); padding:8px; border-radius:6px;"><div style="font-size:10px; color:var(--text-sub);">RF PCS</div><strong style="font-size:15px; color:#047857;">${row.rfpcs.toFixed(0)}</strong></div>` : ''}
        <div style="background:var(--bg-card); padding:8px; border-radius:6px;"><div style="font-size:10px; color:var(--text-sub);">BAL PCS</div><strong style="font-size:15px; color:${(row.balpcs || 0) > 0 ? '#dc2626' : '#0f172a'};">${(row.balpcs || 0).toFixed(0)}</strong></div>
        ${row.secpcs !== undefined ? `<div style="background:var(--bg-card); padding:8px; border-radius:6px;"><div style="font-size:10px; color:var(--text-sub);">SEC PCS</div><strong>${row.secpcs.toFixed(0)}</strong></div>` : ''}
        ${row.shtpcs !== undefined ? `<div style="background:var(--bg-card); padding:8px; border-radius:6px;"><div style="font-size:10px; color:var(--text-sub);">SHT PCS</div><strong>${row.shtpcs.toFixed(0)}</strong></div>` : ''}
        ${row.wastepcs !== undefined ? `<div style="background:var(--bg-card); padding:8px; border-radius:6px;"><div style="font-size:10px; color:var(--text-sub);">WASTE PCS</div><strong>${row.wastepcs.toFixed(0)}</strong></div>` : ''}
        ${row.retpcs !== undefined ? `<div style="background:var(--bg-card); padding:8px; border-radius:6px;"><div style="font-size:10px; color:var(--text-sub);">RET PCS</div><strong>${row.retpcs.toFixed(0)}</strong></div>` : ''}
      </div>
    </div>

    <div style="margin-top:14px;">
      <button type="button" class="btn btn-primary btn-block" onclick="openChallanImageModal('${row.issno || row.isssr || row.recsr || row.challan_no || 'Challan'}')" style="font-weight:700; padding:10px;"><i class="fa-solid fa-camera" style="color:#00c9ff;"></i> View & Upload Photos for this Challan</button>
    </div>
  `;
  
  if (body) body.innerHTML = html;
  if (modal) modal.style.display = "block";
};


window.closeChallanModal = function() {
  const modal = document.getElementById("challan-detail-modal");
  if (modal) modal.style.display = "none";
};

// ══════════════════════════════════════════════════════════════════════════
// FOLDING PAYMENT (CHARAK) CORE LOGIC & EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════
let allFoldingPaymentData = [];

window.loadFoldingPayment = function() {
  const wrapper = document.getElementById("fp-table-wrapper");
  if (wrapper) {
    wrapper.innerHTML = `
      <div class="loading-state" style="padding:40px; text-align:center;">
        <i class="fa-solid fa-circle-notch fa-spin fa-2x" style="color:#3b82f6;"></i>
        <div style="margin-top:10px; font-weight:600;">Loading Folding Payment Challans...</div>
      </div>`;
  }

  const worker = document.getElementById("fp-worker-filter") ? document.getElementById("fp-worker-filter").value : "";
  const status = document.getElementById("fp-status-filter") ? document.getElementById("fp-status-filter").value : "All";

  fetch(`/api/folding_payment?worker=${encodeURIComponent(worker)}&status=${encodeURIComponent(status)}`)
    .then(res => res.json())
    .then(data => {
      if (data.status === "success") {
        allFoldingPaymentData = data.data || [];
        window.showSnapshotBanner(data);
        
        // Populate worker dropdown if empty
        const workerSelect = document.getElementById("fp-worker-filter");
        if (workerSelect && data.workers && workerSelect.options.length <= 1) {
          data.workers.forEach(w => {
            const opt = document.createElement("option");
            opt.value = w;
            opt.textContent = w;
            workerSelect.appendChild(opt);
          });
        }
        
        renderFoldingPaymentTable();
      } else {
        if (wrapper) wrapper.innerHTML = `<div class="alert alert-danger" style="padding:20px;">${data.error || "Failed to load folding payments."}</div>`;
      }
    })
    .catch(err => {
      console.error("Error loading folding payment data:", err);
      if (wrapper) wrapper.innerHTML = `<div class="alert alert-danger" style="padding:20px;">Failed to connect to server: ${err}</div>`;
    });
};

function renderFoldingPaymentTable() {
  const wrapper = document.getElementById("fp-table-wrapper");
  const searchInput = document.getElementById("fp-search");
  const query = searchInput ? searchInput.value.toLowerCase().trim() : "";

  let filtered = allFoldingPaymentData.filter(r => {
    if (!query) return true;
    return (
      (r.challan_no && r.challan_no.toLowerCase().includes(query)) ||
      (r.series && r.series.toLowerCase().includes(query)) ||
      (r.worker_name && r.worker_name.toLowerCase().includes(query)) ||
      (r.job_item_name && r.job_item_name.toLowerCase().includes(query))
    );
  });

  // Calculate summary metrics
  let totalCount = filtered.length;
  let totalPcs = 0;
  let checkingPcs = 0;
  let charakPcs = 0;

  filtered.forEach(r => {
    totalPcs += (r.pcs || 0);
    checkingPcs += (r.checking_pcs || 0);
    charakPcs += (r.charak_pcs || 0);
  });

  const countEl = document.getElementById("fp-total-count");
  const totalPcsEl = document.getElementById("fp-total-pcs");
  const checkingPcsEl = document.getElementById("fp-checking-pcs");
  const charakPcsEl = document.getElementById("fp-charak-pcs");

  if (countEl) countEl.textContent = totalCount;
  if (totalPcsEl) totalPcsEl.textContent = totalPcs.toLocaleString();
  if (checkingPcsEl) checkingPcsEl.textContent = checkingPcs.toLocaleString();
  if (charakPcsEl) charakPcsEl.textContent = charakPcs.toLocaleString();

  if (filtered.length === 0) {
    if (wrapper) wrapper.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-sub);">No challans found matching criteria.</div>`;
    return;
  }

  let html = `
    <table class="br-table print-table" style="width:100%;">
      <thead>
        <tr>
          <th>S.No</th>
          <th>Challan No (Series)</th>
          <th>Worker / Jobber</th>
          <th>Job Item Name</th>
          <th>Issue Date</th>
          <th style="text-align:right;">Total Pcs</th>
          <th style="text-align:right;">Checking Pcs</th>
          <th style="text-align:right;">Charak Pcs</th>
          <th style="text-align:right;">Bal Pcs</th>
          <th style="text-align:center;">Checking Process</th>
          <th style="text-align:center;">Charak (Folding) Process</th>
        </tr>
      </thead>
      <tbody>`;

  filtered.forEach((r, idx) => {
    const isBothDone = r.checking_paid && r.charak_paid;
    const isAnyDone = r.checking_paid || r.charak_paid || (r.checking_pcs > 0) || (r.charak_pcs > 0);
    const trClass = isBothDone ? 'paid-row' : (isAnyDone ? 'paid-row-partial' : '');
    const encJobItem = encodeURIComponent(r.item_key || r.job_item_name || '');
    
    html += `
      <tr class="${trClass}" id="fp-row-${idx}">
        <td>${idx + 1}</td>
        <td>
          <strong>${r.challan_no}</strong> ${renderInlineChallanPhoto(r.challan_no)}
        </td>
        <td>${r.worker_name}</td>
        <td><strong>${r.job_item_name || '-'}</strong></td>
        <td>${r.iss_date || '-'}</td>
        <td style="text-align:right; font-weight:700; color:#1d4ed8; vertical-align:middle;">${(r.pcs || 0).toLocaleString()}</td>
        
        <!-- Checking Pcs Inline Input -->
        <td style="text-align:right; vertical-align:middle; padding:4px 6px;">
          ${r.checking_paid ? `
            <span style="font-weight:800; color:#16a34a; font-size:13px;"><i class="fa-solid fa-check"></i> ${(r.checking_pcs || r.pcs).toLocaleString()}</span>
          ` : `
            <input type="number" 
                   id="fp-chk-input-${idx}" 
                   value="${r.checking_pcs > 0 ? r.checking_pcs : ''}" 
                   placeholder="0" 
                   min="0" 
                   max="${r.pcs}" 
                   onchange="saveInlineFoldingPcs('${r.challan_no}', '${r.worker_id}', 'CHECKING', '${encodeURIComponent(r.worker_name)}', ${r.pcs}, this.value, '${encJobItem}')"
                   onkeydown="if(event.key==='Enter') this.blur();"
                   style="width:75px; text-align:right; font-weight:800; font-size:13px; color:#16a34a; background:#f0fdf4; border:1.5px solid #22c55e; padding:4px 6px; border-radius:6px; outline:none;" title="Type Checking Pcs here">
          `}
        </td>

        <!-- Charak Pcs Inline Input -->
        <td style="text-align:right; vertical-align:middle; padding:4px 6px;">
          ${r.charak_paid ? `
            <span style="font-weight:800; color:#0284c7; font-size:13px;"><i class="fa-solid fa-check"></i> ${(r.charak_pcs || r.pcs).toLocaleString()}</span>
          ` : `
            <input type="number" 
                   id="fp-chr-input-${idx}" 
                   value="${r.charak_pcs > 0 ? r.charak_pcs : ''}" 
                   placeholder="0" 
                   min="0" 
                   max="${r.pcs}" 
                   onchange="saveInlineFoldingPcs('${r.challan_no}', '${r.worker_id}', 'CHARAK', '${encodeURIComponent(r.worker_name)}', ${r.pcs}, this.value, '${encJobItem}')"
                   onkeydown="if(event.key==='Enter') this.blur();"
                   style="width:75px; text-align:right; font-weight:800; font-size:13px; color:#0284c7; background:#f0f9ff; border:1.5px solid #0284c7; padding:4px 6px; border-radius:6px; outline:none;" title="Type Charak Pcs here">
          `}
        </td>

        <td style="text-align:right; font-weight:700; color:${(r.bal_pcs || 0) > 0 ? '#ef4444' : '#10b981'}; vertical-align:middle;">${(r.bal_pcs || 0).toLocaleString()}</td>

        <!-- Checking Process Action -->
        <td style="text-align:center; vertical-align:middle; border-right: 1px solid var(--bg-card-border);">
          ${r.checking_paid ? `
            <button type="button" class="undo-btn" style="padding:3px 8px; font-size:11px;" onclick="undoFoldingTick('${r.challan_no}', '${r.worker_id}', 'CHECKING', '${encJobItem}')"><i class="fa-solid fa-rotate-left"></i> Undo</button>
          ` : `
            <button type="button" class="tick-btn" style="background:#16a34a !important; padding:4px 8px; font-size:11px;" onclick="saveInlineFoldingPcs('${r.challan_no}', '${r.worker_id}', 'CHECKING', '${encodeURIComponent(r.worker_name)}', ${r.pcs}, ${r.pcs}, '${encJobItem}')" title="Full ${r.pcs} Pcs Done">
              <i class="fa-solid fa-check-double"></i> Full Done
            </button>
            ${r.checking_pcs > 0 ? `<button type="button" class="undo-btn" style="margin-left:4px; padding:3px 6px; font-size:10px;" onclick="undoFoldingTick('${r.challan_no}', '${r.worker_id}', 'CHECKING', '${encJobItem}')"><i class="fa-solid fa-rotate-left"></i> Reset</button>` : ''}
          `}
        </td>

        <!-- Charak (Folding) Process Action -->
        <td style="text-align:center; vertical-align:middle;">
          ${r.charak_paid ? `
            <button type="button" class="undo-btn" style="padding:3px 8px; font-size:11px;" onclick="undoFoldingTick('${r.challan_no}', '${r.worker_id}', 'CHARAK', '${encJobItem}')"><i class="fa-solid fa-rotate-left"></i> Undo</button>
          ` : `
            <button type="button" class="tick-btn" style="background:#0284c7 !important; padding:4px 8px; font-size:11px;" onclick="saveInlineFoldingPcs('${r.challan_no}', '${r.worker_id}', 'CHARAK', '${encodeURIComponent(r.worker_name)}', ${r.pcs}, ${r.pcs}, '${encJobItem}')" title="Full ${r.pcs} Pcs Done">
              <i class="fa-solid fa-check-double"></i> Full Done
            </button>
            ${r.charak_pcs > 0 ? `<button type="button" class="undo-btn" style="margin-left:4px; padding:3px 6px; font-size:10px;" onclick="undoFoldingTick('${r.challan_no}', '${r.worker_id}', 'CHARAK', '${encJobItem}')"><i class="fa-solid fa-rotate-left"></i> Reset</button>` : ''}
          `}
        </td>
      </tr>`;
  });


  html += `</tbody></table>`;
  if (wrapper) wrapper.innerHTML = html;
}

window.saveInlineFoldingPcs = function(challanNo, workerId, processType, encodedWorkerName, totalPcs, val, encodedJobItemName) {
  const workerName = decodeURIComponent(encodedWorkerName);
  const jobItemName = encodedJobItemName ? decodeURIComponent(encodedJobItemName) : '';
  const enteredPcs = parseFloat(val || 0);

  if (isNaN(enteredPcs) || enteredPcs < 0) return;

  fetch("/api/folding_payment/tick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challan_no: challanNo,
      worker_id: workerId,
      item_key: jobItemName,
      job_item_name: jobItemName,
      process_type: processType,
      worker_name: workerName,
      total_pcs: totalPcs,
      entered_pcs: enteredPcs,
      full_done: totalPcs > 0 && enteredPcs >= totalPcs
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.status === "success") {
      loadFoldingPayment();
    } else {
      alert("Error: " + (data.error || "Failed to update Pcs"));
    }
  })
  .catch(err => alert("Server error: " + err));
};

window.openFoldingPcsModal = function(challanNo, workerId, processType, encodedWorkerName, totalPcs, currentDonePcs) {
  const workerName = decodeURIComponent(encodedWorkerName);
  const titleEl = document.getElementById('fp-modal-process-title');
  const challanLabel = document.getElementById('fp-modal-challan-label');
  const workerLabel = document.getElementById('fp-modal-worker-label');
  
  const inChallan = document.getElementById('fp-modal-challan-no');
  const inWorkerId = document.getElementById('fp-modal-worker-id');
  const inWorkerName = document.getElementById('fp-modal-worker-name');
  const inProcType = document.getElementById('fp-modal-process-type');
  const inTotalPcs = document.getElementById('fp-modal-total-pcs');
  const inCurrDone = document.getElementById('fp-modal-current-done');

  const dispTotal = document.getElementById('fp-modal-disp-total');
  const dispDone = document.getElementById('fp-modal-disp-done');
  const dispRem = document.getElementById('fp-modal-disp-rem');
  const enterPcsInput = document.getElementById('fp-modal-enter-pcs');

  const remPcs = Math.max(0, totalPcs - currentDonePcs);

  if (titleEl) titleEl.textContent = processType === 'CHECKING' ? 'Checking' : 'Charak (Folding)';
  if (challanLabel) challanLabel.textContent = `Challan No: ${challanNo}`;
  if (workerLabel) workerLabel.textContent = `Worker: ${workerName}`;

  if (inChallan) inChallan.value = challanNo;
  if (inWorkerId) inWorkerId.value = workerId;
  if (inWorkerName) inWorkerName.value = workerName;
  if (inProcType) inProcType.value = processType;
  if (inTotalPcs) inTotalPcs.value = totalPcs;
  if (inCurrDone) inCurrDone.value = currentDonePcs;

  if (dispTotal) dispTotal.textContent = totalPcs.toLocaleString();
  if (dispDone) dispDone.textContent = currentDonePcs.toLocaleString();
  if (dispRem) dispRem.textContent = remPcs.toLocaleString();
  if (enterPcsInput) {
    enterPcsInput.value = remPcs > 0 ? remPcs : totalPcs;
    enterPcsInput.max = remPcs > 0 ? remPcs : totalPcs;
  }

  const modal = document.getElementById('modal-folding-pcs');
  if (modal) modal.style.display = 'flex';
};

window.submitFoldingPcs = function(isFullDone) {
  const challanNo = document.getElementById('fp-modal-challan-no').value;
  const workerId = document.getElementById('fp-modal-worker-id').value;
  const workerName = document.getElementById('fp-modal-worker-name').value;
  const processType = document.getElementById('fp-modal-process-type').value;
  const totalPcs = parseFloat(document.getElementById('fp-modal-total-pcs').value || 0);
  const enteredPcs = parseFloat(document.getElementById('fp-modal-enter-pcs').value || 0);

  if (!isFullDone && (!enteredPcs || enteredPcs <= 0)) {
    alert('Please enter a valid Pcs amount');
    return;
  }

  fetch("/api/folding_payment/tick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challan_no: challanNo,
      worker_id: workerId,
      process_type: processType,
      worker_name: workerName,
      total_pcs: totalPcs,
      entered_pcs: enteredPcs,
      full_done: isFullDone
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.status === "success") {
      const modal = document.getElementById('modal-folding-pcs');
      if (modal) modal.style.display = 'none';
      loadFoldingPayment();
    } else {
      alert("Error: " + (data.error || "Failed to update process"));
    }
  })
  .catch(err => alert("Server error: " + err));
};

window.submitFullFoldingPcs = function() {
  submitFoldingPcs(true);
};


window.tickFoldingPaid = function(challanNo, workerId, processType, encodedWorkerName, pcs, encodedJobItemName) {
  const workerName = decodeURIComponent(encodedWorkerName);
  const jobItemName = encodedJobItemName ? decodeURIComponent(encodedJobItemName) : '';
  const processTitle = processType === 'CHECKING' ? 'Checking' : 'Charak (Folding)';

  if (!confirm(`Challan No ${challanNo} (${workerName}) ka [${processTitle}] confirm aur lock karein?`)) return;

  fetch("/api/folding_payment/tick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challan_no: challanNo,
      worker_id: workerId,
      job_item_name: jobItemName,
      process_type: processType,
      worker_name: workerName,
      pcs: pcs
    })
  })
  .then(res => res.json().then(data => ({ status: res.status, data })))
  .then(resObj => {
    if (resObj.status === 409) {
      alert(`⚠️ YE CHALLAN (${processTitle}) PEHLE SE HI TICKED HAI!`);
      loadFoldingPayment();
    } else if (resObj.data.status === "success") {
      loadFoldingPayment();
    } else {
      alert("Error: " + (resObj.data.error || "Failed to tick process"));
    }
  })
  .catch(err => alert("Server error: " + err));
};

window.undoFoldingTick = function(challanNo, workerId, processType, encodedJobItemName) {
  const jobItemName = encodedJobItemName ? decodeURIComponent(encodedJobItemName) : '';
  const processTitle = processType === 'CHECKING' ? 'Checking' : 'Charak (Folding)';
  const reason = prompt(`Undo karne ki wajah likhein (${processTitle} reversal):`, "");
  if (reason === null) return; // Cancelled by user
  if (!confirm(`Pakka reverse karna hai Challan ${challanNo} ke [${processTitle}] tick ko?`)) return;

  fetch("/api/folding_payment/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challan_no: challanNo,
      worker_id: workerId,
      job_item_name: jobItemName,
      process_type: processType,
      reason: reason
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.status === "success") {
      loadFoldingPayment();
    } else {
      alert("Error: " + (data.error || "Failed to undo tick"));
    }
  })
  .catch(err => alert("Server error: " + err));
};

// Event Listeners for Folding Payment
document.addEventListener("DOMContentLoaded", () => {
  const btnLoadFp = document.getElementById("btn-load-folding-payment");
  if (btnLoadFp) {
    btnLoadFp.addEventListener("click", () => loadFoldingPayment());
  }
  const fpSearch = document.getElementById("fp-search");
  if (fpSearch) {
    fpSearch.addEventListener("input", () => renderFoldingPaymentTable());
  }
  const fpStatus = document.getElementById("fp-status-filter");
  if (fpStatus) {
    fpStatus.addEventListener("change", () => loadFoldingPayment());
  }
  const fpWorker = document.getElementById("fp-worker-filter");
  if (fpWorker) {
    fpWorker.addEventListener("change", () => loadFoldingPayment());
  }
});

// --- Register Service Worker for PWA ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(reg => console.log('Service Worker registered successfully:', reg.scope))
    .catch(err => console.warn('Service Worker registration failed:', err));
}

// --- User Profile & Authentication Setup ---
window.currentUserProfile = null;

async function initUserProfile() {
  try {
    const res = await fetch('/api/current_user');
    const data = await res.json();
    if (data.authenticated && data.user) {
      window.currentUserProfile = data.user;
      const user = data.user;
      const headerUserId = document.getElementById('header-user-id');
      const drawerUserName = document.getElementById('drawer-user-name');
      const drawerUserIdText = document.getElementById('drawer-user-id-text');
      const drawerUserRoleBadge = document.getElementById('drawer-user-role-badge');

      if (headerUserId) headerUserId.textContent = `User: ${user.user_id}`;
      if (drawerUserName) drawerUserName.textContent = user.name || user.username;
      if (drawerUserIdText) drawerUserIdText.textContent = `ID: ${user.user_id}`;
      if (drawerUserRoleBadge) drawerUserRoleBadge.textContent = user.role || 'User';

      // Admin Only User Management Section
      const adminMgmtCard = document.getElementById('card-admin-user-mgmt');
      if (adminMgmtCard) {
        if (user.role === 'Admin') {
          adminMgmtCard.style.display = 'block';
          loadAdminUserList();
        } else {
          adminMgmtCard.style.display = 'none';
        }
      }
    } else if (data.authenticated === false) {
      window.location.href = '/login';
    }
  } catch (err) {
    console.warn('Failed to load user profile:', err);
  }
}

async function loadAdminUserList() {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;

  loadActivityLogs();

  try {
    const res = await fetch('/api/users/list');
    const data = await res.json();

    if (data.status === 'success' && Array.isArray(data.users)) {
      if (data.users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:12px; color:var(--text-sub);">No users found</td></tr>';
        return;
      }

      let html = '';
      data.users.forEach(u => {
        const isSelf = window.currentUserProfile && window.currentUserProfile.user_id === u.user_id;
        const isMainAdmin = u.user_id === 'admin';
        
        const roleOptions = ['Admin', 'Supervisor', 'Staff'].map(r => 
          `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`
        ).join('');

        const roleSelector = isMainAdmin 
          ? `<span class="badge badge-user">Admin</span>`
          : `<select onchange="updateUserRole('${u.user_id}', this.value)" style="padding: 3px 8px; font-size: 12px; font-weight: 600; border-radius: 6px; border: 1px solid var(--bg-card-border); background: var(--bg-card); color: var(--text-main); cursor: pointer;">
              ${roleOptions}
            </select>`;

        html += `
          <tr>
            <td style="font-weight:600; color:var(--primary);">${u.user_id}</td>
            <td>${u.name}</td>
            <td>${roleSelector}</td>
            <td style="font-size:12px; color:var(--text-sub);"><i class="fa-solid fa-clock" style="margin-right:4px; color:#38bdf8;"></i> ${u.last_login || 'Never'}</td>
            <td>
              <button type="button" class="btn btn-sm btn-secondary" onclick="openResetPasswordModal('${u.user_id}', '${u.name}')" title="Reset Password" style="padding:4px 8px; font-size:11px;">
                <i class="fa-solid fa-key" style="color:#f59e0b;"></i> Password
              </button>
              ${!isMainAdmin && !isSelf ? `
                <button type="button" class="btn btn-sm btn-danger" onclick="deleteUserAccount('${u.user_id}')" title="Delete User" style="padding:4px 8px; font-size:11px; background:#ef4444; color:#fff; border:none; border-radius:4px; margin-left:4px;">
                  <i class="fa-solid fa-trash"></i>
                </button>
              ` : ''}
            </td>
          </tr>
        `;
      });
      tbody.innerHTML = html;
    } else {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:12px; color:#ef4444;">${data.error || 'Failed to load users'}</td></tr>`;
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:12px; color:#ef4444;">Error loading user list</td></tr>';
  }
}

async function loadActivityLogs() {
  const tbody = document.getElementById('activity-log-table-body');
  if (!tbody) return;

  try {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:12px; color:var(--text-sub);"><i class="fa-solid fa-spinner fa-spin"></i> Loading activity logs...</td></tr>';
    const res = await fetch('/api/activity_logs');
    const data = await res.json();

    if (data.status === 'success' && Array.isArray(data.logs)) {
      if (data.logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:12px; color:var(--text-sub);">No user activity recorded yet.</td></tr>';
        return;
      }

      let html = '';
      data.logs.forEach(log => {
        let actionBadge = `<span class="badge" style="background:#64748b; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">${log.action}</span>`;
        if (log.action === 'ADD') {
          actionBadge = `<span class="badge" style="background:#10b981; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">ADD</span>`;
        } else if (log.action === 'EDIT') {
          actionBadge = `<span class="badge" style="background:#3b82f6; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">EDIT</span>`;
        } else if (log.action === 'DELETE') {
          actionBadge = `<span class="badge" style="background:#ef4444; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">DELETE</span>`;
        } else if (log.action === 'TICK') {
          actionBadge = `<span class="badge" style="background:#8b5cf6; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">TICK</span>`;
        } else if (log.action === 'UNDO') {
          actionBadge = `<span class="badge" style="background:#f59e0b; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">UNDO</span>`;
        }

        html += `
          <tr>
            <td style="font-size:11px; color:var(--text-sub); white-space:nowrap;">${log.timestamp}</td>
            <td style="font-weight:600; color:var(--primary);">${log.user_name} (${log.user_id})</td>
            <td style="font-weight:600; font-size:11px;">${log.module}</td>
            <td>${actionBadge}</td>
            <td style="font-size:12px; color:var(--text-main);">${log.details}</td>
          </tr>
        `;
      });
      tbody.innerHTML = html;
    } else {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:12px; color:#ef4444;">${data.error || 'Failed to load logs'}</td></tr>`;
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:12px; color:#ef4444;">Error loading activity logs</td></tr>';
  }
}
window.loadActivityLogs = loadActivityLogs;

window.runWhatsAppChatImport = async function() {
  if (!confirm("Start auto-matching and importing WhatsApp Chat photos (from 15/06/2026 onwards)?")) return;
  try {
    const res = await fetch('/api/whatsapp_import/run', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.status === 'success') {
      alert(data.message);
      if (typeof loadAllChallanImagesMap === 'function') loadAllChallanImagesMap();
      if (typeof loadActivityLogs === 'function') loadActivityLogs();
    } else {
      alert('Import Error: ' + (data.error || 'Failed to import photos'));
    }
  } catch (err) {
    alert('Server Error: ' + err);
  }
};

window.updateUserRole = async function(userId, newRole) {
  try {
    const res = await fetch('/api/users/update_role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, role: newRole })
    });
    const data = await res.json();
    if (res.ok && data.status === 'success') {
      alert(data.message);
      loadAdminUserList();
    } else {
      alert('Error: ' + (data.error || 'Failed to update role'));
      loadAdminUserList();
    }
  } catch (err) {
    alert('Server error: ' + err);
    loadAdminUserList();
  }
};


window.openResetPasswordModal = function(userId, userName) {
  const modal = document.getElementById('modal-reset-password');
  const targetId = document.getElementById('reset-target-user-id');
  const targetName = document.getElementById('reset-target-user-name');
  const pwdInput = document.getElementById('reset-new-password');

  if (targetId) targetId.value = userId;
  if (targetName) targetName.textContent = `${userName} (${userId})`;
  if (pwdInput) pwdInput.value = '';
  if (modal) modal.style.display = 'flex';
};

window.deleteUserAccount = async function(userId) {
  if (!confirm(`Pakka User '${userId}' ko delete karna hai?`)) return;

  try {
    const res = await fetch('/api/users/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId })
    });
    const data = await res.json();
    if (res.ok && data.status === 'success') {
      alert(data.message);
      loadAdminUserList();
    } else {
      alert('Error: ' + (data.error || 'Failed to delete user'));
    }
  } catch (err) {
    alert('Server error: ' + err);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  initUserProfile();

  // Change My Password Form
  const formChangeMyPwd = document.getElementById('form-change-my-password');
  if (formChangeMyPwd) {
    formChangeMyPwd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPwd = document.getElementById('my-old-password').value;
      const newPwd = document.getElementById('my-new-password').value;

      try {
        const res = await fetch('/api/users/change_password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
          alert(data.message);
          formChangeMyPwd.reset();
        } else {
          alert('Error: ' + (data.error || 'Password update failed'));
        }
      } catch (err) {
        alert('Server error: ' + err);
      }
    });
  }

  // Open & Close Add User Modal
  const btnOpenAddUser = document.getElementById('btn-open-add-user-modal');
  const modalAddUser = document.getElementById('modal-add-user');
  const closeAddUser = document.getElementById('modal-add-user-close');

  if (btnOpenAddUser && modalAddUser) {
    btnOpenAddUser.addEventListener('click', () => { modalAddUser.style.display = 'flex'; });
  }
  if (closeAddUser && modalAddUser) {
    closeAddUser.addEventListener('click', () => { modalAddUser.style.display = 'none'; });
  }

  // Form Add User
  const formAddUser = document.getElementById('form-add-user');
  if (formAddUser) {
    formAddUser.addEventListener('submit', async (e) => {
      e.preventDefault();
      const userId = document.getElementById('add-user-id').value.trim();
      const name = document.getElementById('add-user-name').value.trim();
      const password = document.getElementById('add-user-password').value;
      const role = document.getElementById('add-user-role').value;

      try {
        const res = await fetch('/api/users/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, name: name, password: password, role: role })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
          alert(data.message);
          formAddUser.reset();
          if (modalAddUser) modalAddUser.style.display = 'none';
          loadAdminUserList();
        } else {
          alert('Error: ' + (data.error || 'Failed to add user'));
        }
      } catch (err) {
        alert('Server error: ' + err);
      }
    });
  }

  // Reset Password Modal Close & Form
  const modalResetPwd = document.getElementById('modal-reset-password');
  const closeResetPwd = document.getElementById('modal-reset-password-close');
  const formResetPwd = document.getElementById('form-reset-user-password');

  if (closeResetPwd && modalResetPwd) {
    closeResetPwd.addEventListener('click', () => { modalResetPwd.style.display = 'none'; });
  }

  if (formResetPwd) {
    formResetPwd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const targetUserId = document.getElementById('reset-target-user-id').value;
      const newPwd = document.getElementById('reset-new-password').value;

      try {
        const res = await fetch('/api/users/change_password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: targetUserId, new_password: newPwd })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
          alert(data.message);
          if (modalResetPwd) modalResetPwd.style.display = 'none';
        } else {
          alert('Error: ' + (data.error || 'Password reset failed'));
        }
      } catch (err) {
        alert('Server error: ' + err);
      }
    });
  }

  // Initialize Theme Engine (Light / Dark Mode)
  initThemeEngine();
});

// --- Theme Engine (Light / Dark Mode Switcher) ---
function initThemeEngine() {
  const btnThemeToggle = document.getElementById('btn-theme-toggle');
  const themeIcon = document.getElementById('theme-icon');
  const themeText = document.getElementById('theme-text');

  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      document.body.setAttribute('data-theme', 'light');
      if (themeIcon) { themeIcon.className = 'fa-solid fa-moon'; }
      if (themeText) { themeText.textContent = 'Dark Mode'; }
    } else {
      document.documentElement.removeAttribute('data-theme');
      document.body.removeAttribute('data-theme');
      if (themeIcon) { themeIcon.className = 'fa-solid fa-sun'; }
      if (themeText) { themeText.textContent = 'Light Mode'; }
    }
  }

  const savedTheme = localStorage.getItem('sknt_app_theme') || 'light'; // Default to clean bright Light theme
  applyTheme(savedTheme);

  if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      const newTheme = currentTheme === 'light' ? 'dark' : 'light';
      localStorage.setItem('sknt_app_theme', newTheme);
      applyTheme(newTheme);
    });
  }
}

// --- Global Challan Photo Store & Helpers ---
window.allChallanImagesMap = {};

window.loadAllChallanImagesMap = async function() {
  try {
    const res = await fetch('/api/challan/all_images_map');
    const data = await res.json();
    if (data.status === 'success') {
      window.allChallanImagesMap = data.data || {};
      // Silently re-upload any photo this device has backed up locally
      // but which the server no longer has (e.g. Render storage reset).
      if (typeof window.sknReconcileLocalPhotos === 'function' && !window._sknReconcileInFlight) {
        window._sknReconcileInFlight = true;
        window.sknReconcileLocalPhotos(window.allChallanImagesMap)
          .finally(() => { window._sknReconcileInFlight = false; });
      }
    }
  } catch(e) {
    console.error('Failed to load all images map:', e);
  }
};

window.itemChallanMap = {};
window.loadItemChallanMap = async function() {
  try {
    const res = await fetch('/api/item_challan_map');
    const data = await res.json();
    if (data.status === 'success') window.itemChallanMap = data.data || {};
  } catch (e) { console.warn('Failed to load item-photo map:', e); }
};
function loadItemChallanMap() { return window.loadItemChallanMap(); }

window.renderInlineChallanPhoto = function(challanNo) {
  if (!challanNo) return '';
  const cno = String(challanNo).trim().toUpperCase();
  const images = window.allChallanImagesMap[cno] || [];

  if (images.length > 0) {
    const firstImg = images[0];
    return `
      <div class="inline-photo-cell" style="display:inline-flex; align-items:center; justify-content:center; position:relative; vertical-align:middle;">
        <img src="${firstImg.url}" alt="Item Photo" onclick="viewFullPhoto('${firstImg.url}')" style="width:52px; height:52px; object-fit:cover; border-radius:8px; border:2px solid #00c9ff; cursor:pointer; box-shadow:0 3px 8px rgba(0,0,0,0.3); transition:transform 0.2s;" title="Click to view full photo" onmouseover="this.style.transform='scale(1.15)'" onmouseout="this.style.transform='scale(1)'">
        ${images.length > 1 ? `<span class="badge" onclick="openChallanImageModal('${cno}')" style="position:absolute; top:-4px; right:-6px; background:#00c9ff; color:#0f172a; font-size:9px; padding:1px 5px; border-radius:10px; font-weight:800; cursor:pointer; box-shadow:0 2px 4px rgba(0,0,0,0.4);">+${images.length - 1}</span>` : ''}
      </div>
    `;
  } else {
    return `
      <button type="button" class="btn btn-sm btn-secondary" onclick="openChallanImageModal('${cno}')" title="Attach Photo / Camera" style="padding:4px 8px; font-size:11px; font-weight:600;">
        <i class="fa-solid fa-camera" style="color:#00c9ff;"></i> +Photo
      </button>
    `;
  }
};


// Load images map initially
loadAllChallanImagesMap();

// --- Challan Photo Management ---
window.openChallanImageModal = function(challanNo) {
  const modal = document.getElementById('modal-challan-image');
  const titleNo = document.getElementById('modal-challan-title-no');
  const inputChallanNo = document.getElementById('upload-challan-no');
  const fileNameDisplay = document.getElementById('selected-file-name');
  const btnSubmit = document.getElementById('btn-submit-upload-image');
  const fileInput = document.getElementById('challan-image-file-input');
  const cameraInput = document.getElementById('challan-camera-input');

  if (titleNo) titleNo.textContent = challanNo;
  if (inputChallanNo) inputChallanNo.value = challanNo;
  if (fileNameDisplay) fileNameDisplay.textContent = '';
  if (btnSubmit) btnSubmit.style.display = 'none';
  if (fileInput) fileInput.value = '';
  if (cameraInput) cameraInput.value = '';

  if (modal) modal.style.display = 'flex';
  loadChallanPhotos(challanNo);
};

window.loadChallanPhotos = async function(challanNo) {
  const container = document.getElementById('challan-photos-container');
  if (!container) return;

  container.innerHTML = '<div class="loading-state"><i class="fa-solid fa-spinner fa-spin"></i> Loading photos...</div>';

  try {
    const res = await fetch(`/api/challan/images/${encodeURIComponent(challanNo)}`);
    const data = await res.json();

    if (data.status === 'success' && Array.isArray(data.images)) {
      if (data.images.length === 0) {
        container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1; padding:20px; text-align:center; color:var(--text-sub);"><i class="fa-solid fa-image" style="font-size:28px; margin-bottom:6px;"></i><p style="font-size:12px;">Is Challan ke liye koi photo attached nahi hai</p></div>';
        return;
      }

      let html = '';
      data.images.forEach(img => {
        html += `
          <div class="photo-card" style="position:relative; background:var(--bg-card); border:1px solid var(--bg-card-border); border-radius:10px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.15);">
            <img src="${img.url}" alt="Challan Photo" onclick="viewFullPhoto('${img.url}')" style="width:100%; height:110px; object-fit:cover; cursor:pointer; display:block;">
            <div style="padding:6px 8px; font-size:10px; display:flex; justify-content:space-between; align-items:center; background:var(--bg-app);">
              <span style="color:var(--text-sub); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80px;" title="${img.uploaded_at}">${img.uploaded_at ? img.uploaded_at.split(' ')[0] : 'Photo'}</span>
              <button type="button" onclick="deleteChallanPhoto('${challanNo}', '${img.id}')" title="Delete Photo" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:12px; padding:2px;"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
        `;
      });
      container.innerHTML = html;
    } else {
      container.innerHTML = `<div class="empty-state" style="grid-column: 1/-1; color:#ef4444;">${data.error || 'Failed to load photos'}</div>`;
    }
  } catch (err) {
    container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1; color:#ef4444;">Error loading photos</div>';
  }
};

window.viewFullPhoto = function(url) {
  const modal = document.getElementById('modal-full-photo');
  const img = document.getElementById('full-photo-img');
  if (img) img.src = url;
  if (modal) modal.style.display = 'flex';
};

window.deleteChallanPhoto = async function(challanNo, imageId) {
  if (!confirm('Pakka ye photo delete karni hai?')) return;

  try {
    const res = await fetch('/api/challan/delete_image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challan_no: challanNo, image_id: imageId })
    });
    const data = await res.json();
    if (res.ok && data.status === 'success') {
      await loadAllChallanImagesMap();
      loadChallanPhotos(challanNo);
    } else {
      alert('Error: ' + (data.error || 'Failed to delete photo'));
    }
  } catch (err) {
    alert('Server error: ' + err);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  // Modal Closes
  const modalChallanImg = document.getElementById('modal-challan-image');
  const closeChallanImg = document.getElementById('modal-challan-image-close');
  if (closeChallanImg && modalChallanImg) {
    closeChallanImg.addEventListener('click', () => { modalChallanImg.style.display = 'none'; });
  }

  const modalFullPhoto = document.getElementById('modal-full-photo');
  const closeFullPhoto = document.getElementById('modal-full-photo-close');
  if (closeFullPhoto && modalFullPhoto) {
    closeFullPhoto.addEventListener('click', () => { modalFullPhoto.style.display = 'none'; });
  }

  const modalFoldingPcs = document.getElementById('modal-folding-pcs');
  const closeFoldingPcs = document.getElementById('modal-folding-pcs-close');
  if (closeFoldingPcs && modalFoldingPcs) {
    closeFoldingPcs.addEventListener('click', () => { modalFoldingPcs.style.display = 'none'; });
  }

  const formFoldingPcs = document.getElementById('form-folding-pcs');
  if (formFoldingPcs) {
    formFoldingPcs.addEventListener('submit', (e) => {
      e.preventDefault();
      submitFoldingPcs(false);
    });
  }


  // File & Camera Input Change
  const fileInput = document.getElementById('challan-image-file-input');
  const cameraInput = document.getElementById('challan-camera-input');
  const fileNameDisplay = document.getElementById('selected-file-name');
  const btnSubmit = document.getElementById('btn-submit-upload-image');
  const formUploadImg = document.getElementById('form-upload-challan-image');

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        const count = fileInput.files.length;
        if (fileNameDisplay) fileNameDisplay.textContent = `Selected: ${count} photo(s) (${fileInput.files[0].name}${count > 1 ? ', ...' : ''})`;
        if (btnSubmit) btnSubmit.style.display = 'block';
      }
    });
  }

  if (cameraInput) {
    cameraInput.addEventListener('change', () => {
      if (cameraInput.files && cameraInput.files[0]) {
        if (fileInput) {
          try {
            const dt = new DataTransfer();
            dt.items.add(cameraInput.files[0]);
            fileInput.files = dt.files;
          } catch(e) {}
        }
        if (fileNameDisplay) fileNameDisplay.textContent = `Captured Photo: ${cameraInput.files[0].name || 'Camera Photo'}`;
        if (btnSubmit) btnSubmit.style.display = 'block';
        if (formUploadImg) {
          formUploadImg.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
    });
  }

  // Form Upload Submit (Supports Multi-File)
  if (formUploadImg) {
    formUploadImg.addEventListener('submit', async (e) => {
      e.preventDefault();
      const challanNo = document.getElementById('upload-challan-no').value;
      const formData = new FormData();
      formData.append('challan_no', challanNo);

      let fileCount = 0;
      if (fileInput && fileInput.files && fileInput.files.length > 0) {
        for (let i = 0; i < fileInput.files.length; i++) {
          formData.append('files', fileInput.files[i]);
          fileCount++;
        }
      } else if (cameraInput && cameraInput.files && cameraInput.files.length > 0) {
        formData.append('files', cameraInput.files[0]);
        fileCount++;
      }

      if (!challanNo || fileCount === 0) {
        alert('Please select or capture at least one image file');
        return;
      }

      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading ${fileCount} photo(s)...`;
      }

      const filesToUpload = [];
      if (fileInput && fileInput.files && fileInput.files.length > 0) {
        for (let i = 0; i < fileInput.files.length; i++) filesToUpload.push(fileInput.files[i]);
      } else if (cameraInput && cameraInput.files && cameraInput.files[0]) {
        filesToUpload.push(cameraInput.files[0]);
      }

      try {
        const res = await fetch('/api/challan/upload_image', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
          // Backup each uploaded photo locally on this device (IndexedDB),
          // so it can be auto-recovered later if Render's storage resets.
          if (Array.isArray(data.images)) {
            for (let i = 0; i < data.images.length; i++) {
              const rec = data.images[i];
              const srcFile = filesToUpload[i];
              if (!srcFile) continue;
              try {
                const base64 = await sknFileToBase64(srcFile);
                await window.sknLocalPhotoDB.save({
                  local_key: `${challanNo}_${rec.id}`,
                  challan_no: challanNo,
                  image_id: rec.id,
                  filename: rec.filename,
                  base64: base64
                });
              } catch (e) { console.warn('Local backup save failed:', e); }
            }
          }
          formUploadImg.reset();
          if (fileNameDisplay) fileNameDisplay.textContent = '';
          if (btnSubmit) btnSubmit.style.display = 'none';
          await loadAllChallanImagesMap();
          loadChallanPhotos(challanNo);
        } else {
          alert('Error: ' + (data.error || 'Failed to upload photo(s)'));
        }
      } catch (err) {
        alert('Server error: ' + err);
      } finally {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.innerHTML = '<i class="fa-solid fa-upload"></i> Save & Attach Photo(s)';
        }
      }
    });
  }
});

// Window function for Zoomed Photo Printing directly from Fullscreen Preview Modal
window.printZoomedPhoto = function() {
  const imgEl = document.getElementById('full-photo-img');
  if (!imgEl || !imgEl.src) {
    alert('No photo loaded to print');
    return;
  }

  const preset = document.getElementById('full-photo-paper-preset')?.value || 'a4_4';
  const currentChallanNo = document.getElementById('upload-challan-no')?.value || 'Challan';
  const attachedImages = (window.allChallanImagesMap && window.allChallanImagesMap[currentChallanNo]) ? window.allChallanImagesMap[currentChallanNo] : [];

  const printWin = window.open('', '_blank');
  if (!printWin) {
    alert('Pop-up blocked. Please allow pop-ups to print photos.');
    return;
  }

  let pageSize = 'A4 portrait';
  let pageMargin = '8mm';
  let cols = 2, targetCount = 4, maxHeight = '120mm';

  if (preset === 'a4_4') {
    pageSize = 'A4 portrait'; cols = 2; targetCount = 4; maxHeight = '120mm';
  } else if (preset === 'a4_2') {
    pageSize = 'A4 portrait'; cols = 1; targetCount = 2; maxHeight = '130mm';
  } else if (preset === 'a4_1') {
    pageSize = 'A4 portrait'; cols = 1; targetCount = 1; maxHeight = '260mm';
  } else if (preset === 'half_2') {
    pageSize = 'A5 landscape'; pageMargin = '5mm'; cols = 2; targetCount = 2; maxHeight = '120mm';
  } else if (preset === 'half_4') {
    pageSize = 'A5 portrait'; pageMargin = '5mm'; cols = 2; targetCount = 4; maxHeight = '65mm';
  } else if (preset === 'half_1') {
    pageSize = 'A5 portrait'; pageMargin = '5mm'; cols = 1; targetCount = 1; maxHeight = '180mm';
  } else if (preset === '3x4') {
    pageSize = 'A4 portrait'; cols = 3; targetCount = 12; maxHeight = '60mm';
  } else if (preset === '5x4') {
    pageSize = 'A4 portrait'; cols = 5; targetCount = 20; maxHeight = '60mm';
  }

  // Use exact distinct attached photos without creating duplicate copies
  let photoUrls = [];
  if (attachedImages && attachedImages.length > 0) {
    photoUrls = attachedImages.slice(0, targetCount).map(img => img.url);
  } else if (imgEl && imgEl.src) {
    photoUrls = [imgEl.src];
  }

  let cardsHtml = photoUrls.map((url, idx) => `
    <div class="photo-card">
      <img src="${url}" alt="Photo ${idx+1}">
      <div class="photo-caption">${currentChallanNo} (${idx+1}/${photoUrls.length})</div>
    </div>
  `).join('');

  printWin.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Print Photo - ${currentChallanNo}</title>
      <style>
        @page { size: ${pageSize}; margin: ${pageMargin}; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 4px; background: #fff; color: #000; }
        .header { text-align: center; margin-bottom: 8px; border-bottom: 2px solid #0f172a; padding-bottom: 4px; }
        .header h3 { margin: 0; font-size: 14px; text-transform: uppercase; color: #0f172a; }
        .header p { margin: 2px 0 0 0; font-size: 10px; color: #475569; font-weight: 600; }
        .photo-grid {
          display: grid;
          grid-template-columns: repeat(${cols}, 1fr);
          gap: 8px;
        }
        .photo-card {
          border: 1px solid #cbd5e1;
          border-radius: 6px;
          padding: 4px;
          text-align: center;
          background: #fff;
          break-inside: avoid;
          page-break-inside: avoid;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
        }
        .photo-card img {
          max-width: 100%;
          max-height: ${maxHeight};
          object-fit: contain;
          border-radius: 4px;
        }
        .photo-caption {
          font-size: 9px;
          font-weight: 700;
          margin-top: 3px;
          color: #334155;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h3>Photo Print - ${currentChallanNo}</h3>
        <p>Preset: ${preset} | Photos: ${photoUrls.length} | Printed: ${new Date().toLocaleString()}</p>
      </div>
      <div class="photo-grid">
        ${cardsHtml}
      </div>
      <script>
        window.onload = function() {
          setTimeout(function() { window.print(); }, 400);
        };
      </script>
    </body>
    </html>
  `);
  printWin.document.close();
};

// Window function for Photo Sheet Printing with customizable paper presets & layout
window.printChallanPhotosSheet = function() {
  const challanNo = document.getElementById('upload-challan-no')?.value;
  if (!challanNo) return;
  const layout = document.getElementById('photo-print-layout')?.value || 'a4_4';
  const images = (window.allChallanImagesMap && window.allChallanImagesMap[challanNo]) ? window.allChallanImagesMap[challanNo] : [];
  
  if (!images.length) {
    alert('No photos available to print for this Challan');
    return;
  }

  let pageSize = 'A4 portrait';
  let pageMargin = '8mm';
  let cols = 2, maxHeight = '120mm';

  if (layout === 'a4_4') {
    pageSize = 'A4 portrait'; cols = 2; maxHeight = '120mm';
  } else if (layout === 'a4_2') {
    pageSize = 'A4 portrait'; cols = 1; maxHeight = '130mm';
  } else if (layout === 'a4_1') {
    pageSize = 'A4 portrait'; cols = 1; maxHeight = '260mm';
  } else if (layout === 'half_2') {
    pageSize = 'A5 landscape'; pageMargin = '5mm'; cols = 2; maxHeight = '120mm';
  } else if (layout === 'half_4') {
    pageSize = 'A5 portrait'; pageMargin = '5mm'; cols = 2; maxHeight = '65mm';
  } else if (layout === 'half_1') {
    pageSize = 'A5 portrait'; pageMargin = '5mm'; cols = 1; maxHeight = '180mm';
  } else if (layout === '3x4') {
    pageSize = 'A4 portrait'; cols = 3; maxHeight = '60mm';
  } else if (layout === '5x4') {
    pageSize = 'A4 portrait'; cols = 5; maxHeight = '60mm';
  } else if (layout === '4x5') {
    pageSize = 'A4 portrait'; cols = 4; maxHeight = '60mm';
  }

  const printWin = window.open('', '_blank');
  if (!printWin) {
    alert('Pop-up blocked. Please allow pop-ups to print photos.');
    return;
  }

  let imgGridHtml = images.map((img, idx) => `
    <div class="photo-card">
      <img src="${img.url}" alt="Challan ${challanNo} Photo ${idx+1}">
      <div class="photo-caption">Challan #${challanNo} (${idx+1}/${images.length})</div>
    </div>
  `).join('');

  printWin.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Print Photo Sheet - Challan ${challanNo}</title>
      <style>
        @page { size: ${pageSize}; margin: ${pageMargin}; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 6px; background: #fff; color: #000; }
        .header { text-align: center; margin-bottom: 10px; border-bottom: 2px solid #0f172a; padding-bottom: 4px; }
        .header h2 { margin: 0; font-size: 16px; text-transform: uppercase; letter-spacing: 0.5px; color: #0f172a; }
        .header p { margin: 2px 0 0 0; font-size: 10px; color: #475569; font-weight: 600; }
        .photo-grid {
          display: grid;
          grid-template-columns: repeat(${cols}, 1fr);
          gap: 8px;
        }
        .photo-card {
          border: 1px solid #cbd5e1;
          border-radius: 6px;
          padding: 6px;
          text-align: center;
          background: #fff;
          break-inside: avoid;
          page-break-inside: avoid;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
        }
        .photo-card img {
          max-width: 100%;
          max-height: ${maxHeight};
          object-fit: contain;
          border-radius: 4px;
        }
        .photo-caption {
          font-size: 9px;
          font-weight: 700;
          margin-top: 4px;
          color: #334155;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>Challan Photo Sheet - ${challanNo}</h2>
        <p>Printed: ${new Date().toLocaleString()} | Preset: ${layout} | Total Photos: ${images.length}</p>
      </div>
      <div class="photo-grid">
        ${imgGridHtml}
      </div>
      <script>
        window.onload = function() {
          setTimeout(function() { window.print(); }, 400);
        };
      </script>
    </body>
    </html>
  `);
  printWin.document.close();
};

window.triggerCloudSyncExport = function() {
  const btn = document.getElementById('btn-cloud-sync-now');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing...';
  }

  fetch('/api/cloud_sync/manual_trigger', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Sync Now';
      }
      if (data.status === 'success') {
        const lastEl = document.getElementById('cloud-sync-last-time');
        if (lastEl) lastEl.innerText = 'Last Synced: ' + (data.sync_time || 'Just Now');
        const statusMsg = data.cloud_push_status ? (' (' + data.cloud_push_status + ')') : '';
        alert('✅ Manual Sync Completed!\n\nFresh ERP snapshot exported successfully' + statusMsg + '.\nSynced at: ' + data.sync_time);
      } else {
        alert('❌ Sync Error: ' + (data.error || 'Failed to sync to cloud.'));
      }
    })
    .catch(err => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Sync Now';
      }
      alert('❌ Connection Error: ' + err.message);
    });
};


window.checkCloudSyncStatus = function() {
  fetch('/api/cloud_sync/status')
    .then(res => res.json())
    .then(data => {
      if (data && data.last_sync_time) {
        const lastEl = document.getElementById('cloud-sync-last-time');
        if (lastEl) lastEl.innerText = 'Last Synced: ' + data.last_sync_time;
      }
    })
    .catch(() => {});
};

document.addEventListener('DOMContentLoaded', function() {
  checkCloudSyncStatus();
});





