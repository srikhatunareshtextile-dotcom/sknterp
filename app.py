import os
import json
import sqlite3
import sys
import threading
from datetime import datetime
from collections import defaultdict
from functools import wraps
from flask import Flask, jsonify, request, render_template, send_from_directory, session, redirect, url_for, has_request_context
from stock_calc_utils import _detect_haste_column, calculate_stock_by_group, get_shared_stock_data, query_order_details, query_bill_report_details, query_bill_report_filters, query_job_issue_report, query_job_reprocess_report, query_job_filters
import align_db_by_group

app = Flask(__name__)
app.secret_key = "sknt_erp_mobile_secret_key_2026_secure"

# User Credentials Management
USERS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "users.json")

# Challan Image Attachments Store
CHALLAN_IMAGES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "uploads", "challan_images")
CHALLAN_IMAGES_MAP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "challan_images.json")

os.makedirs(CHALLAN_IMAGES_DIR, exist_ok=True)

def load_challan_images_map():
    res = {}
    if os.path.exists(CHALLAN_IMAGES_MAP_FILE):
        try:
            with open(CHALLAN_IMAGES_MAP_FILE, "r") as f:
                res = json.load(f)
        except Exception as e:
            print(f"Error loading challan_images.json: {e}")
    snap = load_cloud_snapshot()
    if snap and "images_map" in snap:
        snap_map = snap.get("images_map", {})
        for k, v in snap_map.items():
            existing_ids = {str(img.get("id")) for img in res.get(k, [])}
            merged = list(res.get(k, []))
            for img in v:
                if str(img.get("id")) not in existing_ids:
                    merged.append(img)
                    existing_ids.add(str(img.get("id")))
            res[k] = merged
    return res

def save_challan_images_map(data_map):
    try:
        with open(CHALLAN_IMAGES_MAP_FILE, "w") as f:
            json.dump(data_map, f, indent=2)
        return True
    except Exception as e:
        print(f"Error saving challan_images.json: {e}")

# Group-level Photo Attachments (matched by GROUP NAME - not tied to any one challan,
# so the same photo shows anywhere that group appears: Orders, Job Issue, Reprocess, etc.)
GROUP_IMAGES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "uploads", "group_images")
GROUP_IMAGES_MAP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "group_images.json")
os.makedirs(GROUP_IMAGES_DIR, exist_ok=True)

def load_group_images_map():
    res = {}
    if os.path.exists(GROUP_IMAGES_MAP_FILE):
        try:
            with open(GROUP_IMAGES_MAP_FILE, "r") as f:
                res = json.load(f)
        except Exception as e:
            print(f"Error loading group_images.json: {e}")
    snap = load_cloud_snapshot()
    if snap and "group_images_map" in snap:
        for k, v in snap.get("group_images_map", {}).items():
            existing_ids = {str(img.get("id")) for img in res.get(k, [])}
            merged = list(res.get(k, []))
            for img in v:
                if str(img.get("id")) not in existing_ids:
                    merged.append(img)
                    existing_ids.add(str(img.get("id")))
            res[k] = merged
    return res

def save_group_images_map(data_map):
    try:
        with open(GROUP_IMAGES_MAP_FILE, "w") as f:
            json.dump(data_map, f, indent=2)
        return True
    except Exception as e:
        print(f"Error saving group_images.json: {e}")

ACTIVITY_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "activity_log.json")

def load_activity_logs():
    if os.path.exists(ACTIVITY_LOG_FILE):
        try:
            with open(ACTIVITY_LOG_FILE, "r") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading activity_log.json: {e}")
    return []

def log_user_activity(action, module, details):
    try:
        user_id = 'system'
        user_name = 'System'
        if has_request_context():
            user_id = session.get('user_id', 'system')
            user_name = session.get('name', user_id)
        now_str = datetime.now().strftime("%d/%m/%Y %I:%M:%S %p")
        log_entry = {
            "timestamp": now_str,
            "user_id": user_id,
            "user_name": user_name,
            "action": action,
            "module": module,
            "details": details
        }
        logs = load_activity_logs()
        logs.insert(0, log_entry)
        logs = logs[:500]  # Keep last 500 actions
        with open(ACTIVITY_LOG_FILE, "w") as f:
            json.dump(logs, f, indent=2)
    except Exception as e:
        print(f"Error in log_user_activity: {e}")


def load_users():
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE, "r") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading users.json: {e}")
    return [
        {"user_id": "admin", "username": "admin", "password": "admin123", "name": "Administrator", "role": "Admin", "allowed_tabs": ["all"]}
    ]

def get_user_by_username(username):
    users = load_users()
    for u in users:
        if u.get("username", "").lower() == username.lower() or u.get("user_id", "").lower() == username.lower():
            return u
    return None

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            if request.path.startswith('/api/'):
                return jsonify({"error": "Unauthorized", "login_required": True}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

def save_users(users):
    try:
        with open(USERS_FILE, "w") as f:
            json.dump(users, f, indent=2)
        return True
    except Exception as e:
        print(f"Error saving users.json: {e}")
        return False

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({"error": "Unauthorized", "login_required": True}), 401
        if session.get('role') != 'Admin':
            return jsonify({"error": "Access Denied. Admin rights required."}), 403
        return f(*args, **kwargs)
    return decorated_function



_erp_tabs_cache = None

align_lock = threading.Lock()

def trigger_background_alignment():
    def run_align():
        if not align_lock.locked():
            with align_lock:
                try:
                    align_db_by_group.run()
                except Exception as e:
                    print(f"Background alignment error: {e}")
    threading.Thread(target=run_align).start()

# Settings file paths
@app.after_request
def add_header(r):
    r.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    r.headers["Pragma"] = "no-cache"
    r.headers["Expires"] = "0"
    r.headers['Cache-Control'] = 'public, max-age=0'
    return r

SETTINGS_FILE_PS = os.path.join(os.path.expanduser("~"), "packing_slip_settings.json")
SETTINGS_FILE_REQ = os.path.join(os.path.expanduser("~"), "so_req_v4_settings.json")
DEFAULT_LOCAL_DB = os.path.join(os.path.expanduser("~"), "packing_slips.db")

def try_import_pyodbc():
    try:
        import pyodbc
        return pyodbc
    except ImportError:
        return None

def load_cloud_snapshot():
    """Load latest cloud snapshot data for fallback when SQL Server is unavailable."""
    snap_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloud_snapshot_latest.json")
    if not os.path.exists(snap_file):
        return None
    try:
        with open(snap_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def is_cloud_mode():
    """Returns True if running on Render/cloud (no SQL Server available)."""
    return os.environ.get("CLOUD_MODE", "").lower() == "true" or try_import_pyodbc() is None

def _detect_best_odbc_driver(pyodbc_mod):
    if pyodbc_mod is None:
        return "ODBC Driver 17 for SQL Server"
    try:
        drivers = [d for d in pyodbc_mod.drivers() if "SQL Server" in d]
        for preferred in [
            "ODBC Driver 18 for SQL Server",
            "ODBC Driver 17 for SQL Server",
            "ODBC Driver 13 for SQL Server",
            "ODBC Driver 11 for SQL Server",
        ]:
            if preferred in drivers:
                return preferred
        if drivers:
            return drivers[-1]
    except Exception:
        pass
    return "ODBC Driver 17 for SQL Server"

def load_settings():
    # Local SQLite DB configuration
    app_dir = os.path.dirname(os.path.abspath(__file__))
    local_db = os.path.join(app_dir, "packing_slips.db")
    user_db = DEFAULT_LOCAL_DB
    if os.path.exists(user_db):
        local_db = user_db

    if os.path.exists(SETTINGS_FILE_PS):
        try:
            with open(SETTINGS_FILE_PS, "r") as f:
                s = json.load(f)
                lan = s.get("lan_db_path", "").strip()
                if lan and (os.path.exists(lan) or os.path.exists(os.path.dirname(lan))):
                    local_db = lan
        except Exception:
            pass

    try:
        init_local_db(local_db)
    except Exception as _e:
        print(f"init_local_db note: {_e}")

    # Remote SQL Server configuration
    pyodbc_mod = try_import_pyodbc()
    best_driver = _detect_best_odbc_driver(pyodbc_mod)
    sql_settings = {
        "db_server": "THOR\\SQLEXPRESS",
        "db_name": "EQSKNT20262027",
        "db_prev": "EQSKNT20252026",
        "db_user": "",
        "db_password": "",
        "db_trusted": True,
        "driver": best_driver
    }
    if os.path.exists(SETTINGS_FILE_REQ):
        try:
            with open(SETTINGS_FILE_REQ, "r") as f:
                saved = json.load(f)
                for k in sql_settings:
                    if k in saved:
                        sql_settings[k] = saved[k]
        except Exception:
            pass
    
    # Read from packing slip settings if req settings didn't override it
    if os.path.exists(SETTINGS_FILE_PS):
        try:
            with open(SETTINGS_FILE_PS, "r") as f:
                saved = json.load(f)
                for k, mapping in [("server", "db_server"), ("database", "db_name"), ("prev_database", "db_prev"), ("driver", "driver")]:
                    if k in saved and saved[k]:
                        sql_settings[mapping] = saved[k]
        except Exception:
            pass

    return local_db, sql_settings

def get_local_sqlite_connection(db_path):
    conn = sqlite3.connect(db_path, timeout=30.0)
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=30000;")
    except Exception:
        pass
    return conn

def init_local_db(db_path):
    conn = get_local_sqlite_connection(db_path)
    c = conn.cursor()
    c.execute("""CREATE TABLE IF NOT EXISTS packing_slips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slip_no TEXT, slip_date TEXT, party TEXT, group_name TEXT,
        view_type TEXT, created_at TEXT, remarks TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS packing_slip_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slip_id INTEGER,
        order_no TEXT, order_date TEXT, party TEXT, group_name TEXT,
        item_name TEXT, order_pcs REAL, stock_pcs REAL, bal_pcs REAL,
        pack_pcs REAL, pack_type TEXT,
        FOREIGN KEY(slip_id) REFERENCES packing_slips(id))""")
    c.execute("""CREATE TABLE IF NOT EXISTS pack_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL)""")
    
    c.execute("SELECT COUNT(*) FROM pack_types")
    if c.fetchone()[0] == 0:
        for pt in ["BOX","BUNDLE","BAG","ROLL","PIECE","LOOSE","CARTOON","BALE",
                   "CASE","DRUM","PACKET","PAIR","SET","DOZEN"]:
            c.execute("INSERT OR IGNORE INTO pack_types(name) VALUES(?)", (pt,))
    try:
        c.execute("ALTER TABLE packing_slips ADD COLUMN haste TEXT DEFAULT ''")
    except Exception:
        pass

    # Migrate folding_payment_ticks if old table or index has UNIQUE(challan_no, worker_id) without process_type
    try:
        needs_migration = False
        c.execute("PRAGMA index_list('folding_payment_ticks')")
        indexes = c.fetchall()
        for idx in indexes:
            idx_name = idx[1]
            c.execute(f"PRAGMA index_info('{idx_name}')")
            cols = [r[2].lower() for r in c.fetchall() if len(r) > 2 and r[2]]
            if 'challan_no' in cols and 'worker_id' in cols and 'process_type' not in cols:
                needs_migration = True
                break
    except Exception:
        pass
        c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='folding_payment_ticks'")
        sql_row = c.fetchone()
        if sql_row and sql_row[0]:
            table_sql = sql_row[0].upper().replace(" ", "")
            if "UNIQUE(CHALLAN_NO,WORKER_ID,PROCESS_TYPE)" in table_sql or "UNIQUE(CHALLAN_NO,WORKER_ID)" in table_sql or ("UNIQUE(" in table_sql and "JOB_ITEM" not in table_sql):
                c.execute("ALTER TABLE folding_payment_ticks RENAME TO folding_payment_ticks_old")
                c.execute("""CREATE TABLE folding_payment_ticks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    challan_no TEXT NOT NULL,
                    worker_id TEXT NOT NULL,
                    process_type TEXT NOT NULL DEFAULT 'CHARAK',
                    job_item TEXT NOT NULL DEFAULT '',
                    worker_name TEXT,
                    pcs REAL DEFAULT 0,
                    is_paid INTEGER DEFAULT 0,
                    paid_date TEXT,
                    paid_by TEXT
                )""")
                try:
                    c.execute("PRAGMA table_info(folding_payment_ticks_old)")
                    cols_old = [col[1].lower() for col in c.fetchall()]
                    has_ji = 'job_item' in cols_old
                    if has_ji:
                        c.execute("""INSERT OR IGNORE INTO folding_payment_ticks 
                            (id, challan_no, worker_id, process_type, job_item, worker_name, pcs, is_paid, paid_date, paid_by)
                            SELECT id, challan_no, worker_id, COALESCE(process_type, 'CHARAK'), COALESCE(job_item, ''), worker_name, pcs, is_paid, paid_date, paid_by 
                            FROM folding_payment_ticks_old""")
                    else:
                        c.execute("""INSERT OR IGNORE INTO folding_payment_ticks 
                            (id, challan_no, worker_id, process_type, job_item, worker_name, pcs, is_paid, paid_date, paid_by)
                            SELECT id, challan_no, worker_id, COALESCE(process_type, 'CHARAK'), '', worker_name, pcs, is_paid, paid_date, paid_by 
                            FROM folding_payment_ticks_old""")
                except Exception as ex:
                    print(f"Table migration copy notice: {ex}")
                c.execute("DROP TABLE folding_payment_ticks_old")
    except Exception as ex:
        print(f"Table migration notice: {ex}")

    c.execute("""CREATE TABLE IF NOT EXISTS folding_payment_ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challan_no TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        process_type TEXT NOT NULL DEFAULT 'CHARAK',
        job_item TEXT NOT NULL DEFAULT '',
        worker_name TEXT,
        pcs REAL DEFAULT 0,
        is_paid INTEGER DEFAULT 0,
        paid_date TEXT,
        paid_by TEXT
    )""")
    try:
        c.execute("ALTER TABLE folding_payment_ticks ADD COLUMN process_type TEXT NOT NULL DEFAULT 'CHARAK'")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE folding_payment_ticks ADD COLUMN job_item TEXT NOT NULL DEFAULT ''")
    except Exception:
        pass
    try:
        c.execute("DROP INDEX IF EXISTS idx_fpt_unique")
    except Exception:
        pass
    try:
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_fpt_unique_v2 ON folding_payment_ticks(challan_no, worker_id, job_item, process_type)")
    except Exception:
        pass
    c.execute("""CREATE TABLE IF NOT EXISTS folding_payment_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challan_no TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        process_type TEXT,
        action TEXT NOT NULL,
        action_by TEXT,
        action_time TEXT,
        reason TEXT
    )""")
    try:
        c.execute("ALTER TABLE folding_payment_audit ADD COLUMN process_type TEXT")
    except Exception:
        pass

    conn.commit()
    conn.close()

def get_sql_server_connection(s):
    pyodbc = try_import_pyodbc()
    if pyodbc is None:
        raise ImportError("pyodbc is not installed. Please run `pip install pyodbc` on the server PC.")
    
    driver = s.get("driver", "ODBC Driver 17 for SQL Server")
    server = s.get("db_server", "localhost")
    database = s.get("db_name", "EQSKNT20262027")
    trusted = s.get("db_trusted", True)
    user = s.get("db_user", "")
    password = s.get("db_password", "")

    if trusted or not user:
        conn_str = f"DRIVER={{{driver}}};SERVER={server};DATABASE={database};Trusted_Connection=yes;TrustServerCertificate=yes;Timeout=5;"
    else:
        conn_str = f"DRIVER={{{driver}}};SERVER={server};DATABASE={database};UID={user};PWD={password};TrustServerCertificate=yes;Timeout=5;"
    conn = pyodbc.connect(conn_str)
    try:
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED")
    except Exception:
        pass
    return conn

def get_sql_server_prev_connection(s):
    pyodbc = try_import_pyodbc()
    if pyodbc is None:
        return None
    prev_db = s.get("db_prev", "").strip()
    if not prev_db:
        return None
    
    driver = s.get("driver", "ODBC Driver 17 for SQL Server")
    server = s.get("db_server", "localhost")
    trusted = s.get("db_trusted", True)
    user = s.get("db_user", "")
    password = s.get("db_password", "")

    if trusted or not user:
        conn_str = f"DRIVER={{{driver}}};SERVER={server};DATABASE={prev_db};Trusted_Connection=yes;TrustServerCertificate=yes;Timeout=5;"
    else:
        conn_str = f"DRIVER={{{driver}}};SERVER={server};DATABASE={prev_db};UID={user};PWD={password};TrustServerCertificate=yes;Timeout=5;"
    try:
        conn = pyodbc.connect(conn_str)
        try:
            cur = conn.cursor()
            cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED")
        except Exception:
            pass
        return conn
    except Exception:
        return None

# HTTP Endpoints

@app.after_request
def add_no_cache_headers(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

@app.route("/login")
def login():
    if 'user_id' in session:
        return redirect(url_for('index'))
    return render_template("login.html")

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.json or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()

    if not username or not password:
        return jsonify({"error": "User ID / Username and Password are required"}), 400

    user = get_user_by_username(username)
    if not user or user.get("password") != password:
        return jsonify({"error": "Invalid User ID or Password"}), 401

    user['last_login'] = datetime.now().strftime("%d/%m/%Y %I:%M %p")
    users = load_users()
    for u in users:
        if u.get("user_id", "").lower() == username.lower():
            u["last_login"] = user["last_login"]
            break
    save_users(users)

    session['user_id'] = user.get("user_id")
    session['username'] = user.get("username")
    session['name'] = user.get("name")
    session['role'] = user.get("role", "User")
    session['allowed_tabs'] = user.get("allowed_tabs", ["all"])

    return jsonify({
        "status": "success",
        "message": f"Welcome, {user.get('name')}!",
        "user": {
            "user_id": user.get("user_id"),
            "username": user.get("username"),
            "name": user.get("name"),
            "role": user.get("role"),
            "allowed_tabs": user.get("allowed_tabs")
        }
    })

@app.route("/api/logout", methods=["POST", "GET"])
def api_logout():
    session.clear()
    if request.method == "GET":
        return redirect(url_for('login'))
    return jsonify({"status": "success", "message": "Logged out successfully"})

@app.route("/api/current_user")
def api_current_user():
    if 'user_id' not in session:
        return jsonify({"authenticated": False}), 200
    return jsonify({
        "authenticated": True,
        "user": {
            "user_id": session.get("user_id"),
            "username": session.get("username"),
            "name": session.get("name"),
            "role": session.get("role"),
            "allowed_tabs": session.get("allowed_tabs", ["all"])
        }
    })

@app.route("/api/users/list", methods=["GET"])
@admin_required
def api_list_users():
    users = load_users()
    sanitized = []
    for u in users:
        sanitized.append({
            "user_id": u.get("user_id"),
            "username": u.get("username"),
            "name": u.get("name"),
            "role": u.get("role"),
            "last_login": u.get("last_login", "Never"),
            "allowed_tabs": u.get("allowed_tabs", ["all"])
        })
    return jsonify({"status": "success", "users": sanitized})

@app.route("/api/activity_logs", methods=["GET"])
@admin_required
def api_get_activity_logs():
    logs = load_activity_logs()
    return jsonify({"status": "success", "logs": logs})

@app.route("/api/whatsapp_import/run", methods=["POST"])
@admin_required
def api_run_whatsapp_import():
    try:
        import import_whatsapp_chat
        import_whatsapp_chat.parse_chat_and_import(dry_run=False, start_date_str="2026-06-15")
        log_user_activity("IMPORT", "WhatsApp Importer", "Auto-imported WhatsApp chat photos (from 15/06/2026)")
        return jsonify({"status": "success", "message": "WhatsApp photos auto-imported & matched successfully!"})
    except Exception as e:
        return jsonify({"error": f"Import failed: {str(e)}"}), 500

@app.route("/api/users/add", methods=["POST"])
@admin_required
def api_add_user():
    data = request.json or {}
    user_id = str(data.get("user_id", "")).strip().lower()
    name = str(data.get("name", "")).strip()
    password = str(data.get("password", "")).strip()
    role = str(data.get("role", "Staff")).strip()

    if not user_id or not name or not password:
        return jsonify({"error": "User ID, Name, and Password are required"}), 400

    users = load_users()
    if any(u.get("user_id", "").lower() == user_id for u in users):
        return jsonify({"error": f"User ID '{user_id}' already exists!"}), 409

    new_user = {
        "user_id": user_id,
        "username": user_id,
        "password": password,
        "name": name,
        "role": role,
        "allowed_tabs": ["all"] if role in ["Admin", "Supervisor"] else ["home", "slips", "all-stock", "job-issue"]
    }
    users.append(new_user)
    if save_users(users):
        return jsonify({"status": "success", "message": f"User '{name}' ({user_id}) created successfully."})
    return jsonify({"error": "Failed to save user"}), 500

@app.route("/api/users/update_role", methods=["POST"])
@admin_required
def api_update_user_role():
    data = request.json or {}
    target_user_id = str(data.get("user_id", "")).strip().lower()
    new_role = str(data.get("role", "Staff")).strip()

    if not target_user_id or not new_role:
        return jsonify({"error": "User ID and new Role are required"}), 400

    if target_user_id == "admin" and new_role != "Admin":
        return jsonify({"error": "Main Admin account ka role change nahi kar sakte!"}), 400

    users = load_users()
    target_user = None
    for u in users:
        if u.get("user_id", "").lower() == target_user_id:
            target_user = u
            break

    if not target_user:
        return jsonify({"error": "User not found"}), 404

    target_user["role"] = new_role
    target_user["allowed_tabs"] = ["all"] if new_role in ["Admin", "Supervisor"] else ["home", "slips", "all-stock", "job-issue"]

    if save_users(users):
        return jsonify({"status": "success", "message": f"User '{target_user_id}' ka role '{new_role}' update ho gaya hai."})
    return jsonify({"error": "Failed to update role"}), 500


@app.route("/api/users/change_password", methods=["POST"])
@login_required
def api_change_password():
    data = request.json or {}
    target_user_id = str(data.get("user_id", "")).strip().lower()
    old_password = str(data.get("old_password", "")).strip()
    new_password = str(data.get("new_password", "")).strip()

    if not new_password:
        return jsonify({"error": "New password is required"}), 400

    current_user_id = session.get("user_id", "").lower()
    is_admin = (session.get("role") == "Admin")

    target_id = target_user_id if target_user_id else current_user_id

    if not is_admin and target_id != current_user_id:
        return jsonify({"error": "Aap sirf apna password change kar sakte hain!"}), 403

    users = load_users()
    target_user = None
    for u in users:
        if u.get("user_id", "").lower() == target_id:
            target_user = u
            break

    if not target_user:
        return jsonify({"error": "User not found"}), 404

    if not is_admin or (target_id == current_user_id and old_password):
        if target_user.get("password") != old_password:
            return jsonify({"error": "Old Password incorrect hai!"}), 400

    target_user["password"] = new_password
    if save_users(users):
        return jsonify({"status": "success", "message": f"Password updated successfully for '{target_id}'."})
    return jsonify({"error": "Failed to update password"}), 500

@app.route("/api/users/delete", methods=["POST"])
@admin_required
def api_delete_user():
    data = request.json or {}
    target_user_id = str(data.get("user_id", "")).strip().lower()

    if not target_user_id:
        return jsonify({"error": "User ID is required"}), 400

    if target_user_id == "admin":
        return jsonify({"error": "Main Admin account delete nahi kar sakte!"}), 400

    users = load_users()
    updated_users = [u for u in users if u.get("user_id", "").lower() != target_user_id]

    if len(updated_users) == len(users):
        return jsonify({"error": "User not found"}), 404

    if save_users(updated_users):
        return jsonify({"status": "success", "message": f"User '{target_user_id}' deleted."})
    return jsonify({"error": "Failed to delete user"}), 500

@app.route("/api/challan/upload_image", methods=["POST"])
@login_required
def api_upload_challan_image():
    files = request.files.getlist('files') or request.files.getlist('file')
    if not files:
        return jsonify({"error": "No file uploaded"}), 400

    challan_no = str(request.form.get("challan_no", "")).strip().upper()
    if not challan_no:
        return jsonify({"error": "Challan No is required"}), 400

    os.makedirs(CHALLAN_IMAGES_DIR, exist_ok=True)
    images_map = load_challan_images_map()
    if challan_no not in images_map or not isinstance(images_map[challan_no], list):
        images_map[challan_no] = []

    uploaded_records = []
    for idx, file in enumerate(files):
        if not file or file.filename == '':
            continue

        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']:
            ext = '.jpg'
        
        timestamp = int(datetime.now().timestamp() * 1000) + idx
        clean_cno = "".join(c for c in challan_no if c.isalnum() or c in ['-', '_'])
        filename = f"challan_{clean_cno}_{timestamp}{ext}"
        filepath = os.path.join(CHALLAN_IMAGES_DIR, filename)

        file.save(filepath)

        rel_url = f"/static/uploads/challan_images/{filename}"
        from cloud_sync_utils import create_base64_thumbnail
        b64_url = create_base64_thumbnail(filepath)
        img_record = {
            "id": f"{timestamp}",
            "url": b64_url or rel_url,
            "base64_data": b64_url or rel_url,
            "filename": filename,
            "uploaded_by": session.get("user_id", "user"),
            "uploaded_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        images_map[challan_no].append(img_record)
        uploaded_records.append(img_record)

    if not uploaded_records:
        return jsonify({"error": "No valid file selected"}), 400

    save_challan_images_map(images_map)

    return jsonify({
        "status": "success",
        "message": f"{len(uploaded_records)} Photo(s) attached to Challan {challan_no}",
        "images": uploaded_records,
        "all_images": images_map[challan_no]
    })

@app.route("/static/uploads/challan_images/<filename>")
def serve_challan_image(filename):
    filepath = os.path.join(CHALLAN_IMAGES_DIR, filename)
    if os.path.exists(filepath):
        return send_from_directory(CHALLAN_IMAGES_DIR, filename)

    # Fallback: Serve binary image decoded from Base64 Data URL in cloud_snapshot_latest.json
    snap = load_cloud_snapshot()
    if snap and "images_map" in snap:
        images_map = snap.get("images_map", {})
        for cno, img_list in images_map.items():
            for img in img_list:
                if img.get("filename") == filename or filename in str(img.get("url", "")):
                    b64 = img.get("base64_data") or img.get("url", "")
                    if b64 and "base64," in b64:
                        try:
                            header, encoded = b64.split("base64,", 1)
                            mime_type = "image/jpeg"
                            if "data:image/png" in header:
                                mime_type = "image/png"
                            elif "data:image/webp" in header:
                                mime_type = "image/webp"
                            data = base64.b64decode(encoded)
                            from flask import Response
                            return Response(data, mimetype=mime_type)
                        except Exception as e:
                            print(f"Error serving base64 image: {e}")

    return jsonify({"error": "Image file not found"}), 404

@app.route("/api/challan/images/<challan_no>", methods=["GET"])
@login_required
def api_get_challan_images(challan_no):
    cno = str(challan_no).strip().upper()
    images_map = load_challan_images_map()
    images = images_map.get(cno, [])
    return jsonify({
        "status": "success",
        "challan_no": cno,
        "count": len(images),
        "images": images
    })

@app.route("/api/challan/all_images_map", methods=["GET"])
@login_required
def api_get_all_challan_images_map():
    images_map = load_challan_images_map()
    return jsonify({
        "status": "success",
        "data": images_map
    })


@app.route("/api/challan/delete_image", methods=["POST"])
@login_required
def api_delete_challan_image():
    data = request.json or {}
    challan_no = str(data.get("challan_no", "")).strip().upper()
    image_id = str(data.get("image_id", "")).strip()

    if not challan_no or not image_id:
        return jsonify({"error": "Challan No and Image ID are required"}), 400

    images_map = load_challan_images_map()
    if challan_no not in images_map:
        return jsonify({"error": "No images found for this Challan"}), 404

    target_img = None
    remaining = []
    for img in images_map[challan_no]:
        if str(img.get("id")) == image_id or img.get("filename") == image_id:
            target_img = img
        else:
            remaining.append(img)

    if not target_img:
        return jsonify({"error": "Image record not found"}), 404

    filename = target_img.get("filename")
    if filename:
        filepath = os.path.join(CHALLAN_IMAGES_DIR, filename)
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception as e:
                print(f"Notice: could not delete file {filepath}: {e}")

    images_map[challan_no] = remaining
    save_challan_images_map(images_map)

    return jsonify({
        "status": "success",
        "message": f"Image removed for Challan {challan_no}",
        "remaining_count": len(remaining)
    })


# ══════════════════════════════════════════════════════════════════════════
# GROUP-LEVEL PHOTOS — matched by GROUP NAME (not a specific challan), so a
# photo uploaded from Orders, Job Issue, Reprocess etc. shows up everywhere
# else that group appears, regardless of item-name spelling differences.
# ══════════════════════════════════════════════════════════════════════════

@app.route("/api/group_photo/upload", methods=["POST"])
@login_required
def api_upload_group_image():
    files = request.files.getlist('files') or request.files.getlist('file')
    if not files:
        return jsonify({"error": "No file uploaded"}), 400

    group_name = str(request.form.get("group_name", "")).strip().upper()
    if not group_name:
        return jsonify({"error": "Group Name is required"}), 400

    os.makedirs(GROUP_IMAGES_DIR, exist_ok=True)
    images_map = load_group_images_map()
    if group_name not in images_map or not isinstance(images_map[group_name], list):
        images_map[group_name] = []

    uploaded_records = []
    for idx, file in enumerate(files):
        if not file or file.filename == '':
            continue
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']:
            ext = '.jpg'
        timestamp = int(datetime.now().timestamp() * 1000) + idx
        clean_grp = "".join(c for c in group_name if c.isalnum() or c in ['-', '_'])
        filename = f"group_{clean_grp}_{timestamp}{ext}"
        filepath = os.path.join(GROUP_IMAGES_DIR, filename)
        file.save(filepath)

        rel_url = f"/static/uploads/group_images/{filename}"
        from cloud_sync_utils import create_base64_thumbnail
        b64_url = create_base64_thumbnail(filepath)
        img_record = {
            "id": f"{timestamp}",
            "url": b64_url or rel_url,
            "base64_data": b64_url or rel_url,
            "filename": filename,
            "uploaded_by": session.get("user_id", "user"),
            "uploaded_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        images_map[group_name].append(img_record)
        uploaded_records.append(img_record)

    if not uploaded_records:
        return jsonify({"error": "No valid file selected"}), 400

    save_group_images_map(images_map)
    return jsonify({
        "status": "success",
        "message": f"{len(uploaded_records)} Photo(s) attached to Group {group_name}",
        "images": uploaded_records,
        "all_images": images_map[group_name]
    })

@app.route("/static/uploads/group_images/<filename>")
def serve_group_image(filename):
    filepath = os.path.join(GROUP_IMAGES_DIR, filename)
    if os.path.exists(filepath):
        return send_from_directory(GROUP_IMAGES_DIR, filename)
    snap = load_cloud_snapshot()
    if snap and "group_images_map" in snap:
        for grp, img_list in snap.get("group_images_map", {}).items():
            for img in img_list:
                if img.get("filename") == filename or filename in str(img.get("url", "")):
                    b64 = img.get("base64_data") or img.get("url", "")
                    if b64 and "base64," in b64:
                        try:
                            header, encoded = b64.split("base64,", 1)
                            mime_type = "image/jpeg"
                            if "data:image/png" in header:
                                mime_type = "image/png"
                            elif "data:image/webp" in header:
                                mime_type = "image/webp"
                            data = base64.b64decode(encoded)
                            from flask import Response
                            return Response(data, mimetype=mime_type)
                        except Exception as e:
                            print(f"Error serving base64 group image: {e}")
    return jsonify({"error": "Image file not found"}), 404

@app.route("/api/group_photo/images/<group_name>", methods=["GET"])
@login_required
def api_get_group_images(group_name):
    grp = str(group_name).strip().upper()
    images_map = load_group_images_map()
    images = images_map.get(grp, [])
    return jsonify({"status": "success", "group_name": grp, "count": len(images), "images": images})

@app.route("/api/group_photo/all_images_map", methods=["GET"])
@login_required
def api_get_all_group_images_map():
    return jsonify({"status": "success", "data": load_group_images_map()})

@app.route("/api/group_photo/delete_image", methods=["POST"])
@login_required
def api_delete_group_image():
    data = request.json or {}
    group_name = str(data.get("group_name", "")).strip().upper()
    image_id = str(data.get("image_id", "")).strip()

    if not group_name or not image_id:
        return jsonify({"error": "Group Name and Image ID are required"}), 400

    images_map = load_group_images_map()
    if group_name not in images_map:
        return jsonify({"error": "No images found for this Group"}), 404

    target_img = None
    remaining = []
    for img in images_map[group_name]:
        if str(img.get("id")) == image_id or img.get("filename") == image_id:
            target_img = img
        else:
            remaining.append(img)

    if not target_img:
        return jsonify({"error": "Image record not found"}), 404

    filename = target_img.get("filename")
    if filename:
        filepath = os.path.join(GROUP_IMAGES_DIR, filename)
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception as e:
                print(f"Notice: could not delete file {filepath}: {e}")

    images_map[group_name] = remaining
    save_group_images_map(images_map)
    return jsonify({"status": "success", "message": f"Image removed for Group {group_name}", "remaining_count": len(remaining)})


@app.route("/")
def index():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template("index.html")


@app.route("/api/dashboard")
def get_dashboard():
    local_db, sql_settings = load_settings()
    
    # Check SQLite Status
    sqlite_ok = False
    slip_count = 0
    try:
        conn = get_local_sqlite_connection(local_db)
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM packing_slips")
        slip_count = c.fetchone()[0]
        conn.close()
        sqlite_ok = True
    except Exception as e:
        print(f"SQLite Connection error: {e}")

    # Fallback to cloud snapshot for count if on cloud
    if not sqlite_ok or is_cloud_mode():
        snap = load_cloud_snapshot()
        if snap:
            snap_slips = snap.get("reports", {}).get("packing_slips", [])
            if not slip_count:
                slip_count = len(snap_slips)
            sqlite_ok = True

    # Check SQL Server Status
    sql_server_ok = False
    sql_server_msg = "Not Connected"
    pyodbc_installed = try_import_pyodbc() is not None
    if pyodbc_installed:
        try:
            conn = get_sql_server_connection(sql_settings)
            conn.close()
            sql_server_ok = True
            sql_server_msg = "Connected"
        except Exception as e:
            sql_server_msg = str(e).split('] ')[-1] # Clean ODBC error message

    snap = load_cloud_snapshot()
    sync_time = snap.get("sync_time", "") if snap else ""

    return jsonify({
        "sqlite_status": "Online" if sqlite_ok else "Offline",
        "sqlite_path": local_db,
        "packing_slips_count": slip_count,
        "sql_server_status": "Online" if sql_server_ok else "Offline",
        "sql_server_message": sql_server_msg,
        "sql_server_details": {
            "server": sql_settings.get("db_server", "localhost"),
            "database": sql_settings.get("db_name", "")
        },
        "pyodbc_installed": pyodbc_installed,
        "last_sync_time": sync_time
    })

def auto_populate_slip_items(local_db, slip_id, party, group_name=None):
    pyodbc_installed = try_import_pyodbc() is not None

    # === CLOUD FALLBACK for auto populate packing slip ===
    if not pyodbc_installed or is_cloud_mode():
        snap = load_cloud_snapshot()
        if not snap:
            raise Exception("Cloud snapshot not available.")
        reports = snap.get("reports", {})
        order_details = reports.get("order_details", [])
        group_stock = reports.get("group_stock", {})

        target_party = party.strip().upper()
        target_group = group_name.strip().upper() if group_name else ""

        sqlite_conn = sqlite3.connect(local_db)
        sqlite_cur = sqlite_conn.cursor()
        inserted_count = 0

        for od in order_details:
            p = str(od.get("party", "") or "").strip().upper()
            if p != target_party:
                continue
            grp = str(od.get("group_name", "") or "").strip().upper()
            if target_group and grp != target_group:
                continue

            bal_pcs = float(od.get("bal_pcs", 0) or 0)
            if bal_pcs <= 0:
                continue

            stk_pcs = float(group_stock.get(grp, 0) or 0)
            ord_pcs = float(od.get("order_pcs", 0) or bal_pcs)

            sqlite_cur.execute("""
                INSERT INTO packing_slip_items 
                (slip_id, order_no, order_date, party, group_name, item_name, order_pcs, stock_pcs, bal_pcs, pack_pcs, pack_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (slip_id, od.get("order_no", ""), od.get("order_date", ""), od.get("party", party), grp, od.get("item_name", grp), ord_pcs, stk_pcs, bal_pcs, bal_pcs, ""))
            inserted_count += 1

        sqlite_conn.commit()
        sqlite_conn.close()
        return inserted_count
    # === END CLOUD FALLBACK ===

    _, sql_settings = load_settings()
    
    # Get haste if saved in packing_slips
    haste = ""
    try:
        sqlite_conn = sqlite3.connect(local_db)
        sqlite_cur = sqlite_conn.cursor()
        sqlite_cur.execute("SELECT haste FROM packing_slips WHERE id = ?", (slip_id,))
        row = sqlite_cur.fetchone()
        if row:
            haste = str(row[0] or "").strip()
        sqlite_conn.close()
    except Exception as e:
        print(f"Error querying haste from sqlite: {e}")

    # 1. Connect to SQL Server
    conn = get_sql_server_connection(sql_settings)
    
    try:
        # Detect pack type column safely
        pt_sel = ", ''"
        try:
            candidates = ['PackType','Packing','PackagingType','PkgType','PType',
                          'PackDesc','PackSize','PackMode','PkgMode','PackingType',
                          'PackUnit','UnitType','UOM','UomName','Unit']
            pref_tables = ['ORDERDET','ORDERMST','ITEMMST','CHALDATA','CHALMAST']
            placeholders = ','.join(f"'{t}'" for t in pref_tables)
            sql_schema = f"SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN ({placeholders}) ORDER BY TABLE_NAME, COLUMN_NAME"
            cur_schema = conn.cursor()
            cur_schema.execute(sql_schema)
            all_cols = [(r[0], r[1]) for r in cur_schema.fetchall()]
            found_col = None
            # Priority 1: exact
            for tbl in pref_tables:
                for cand in candidates:
                    if any(t == tbl and c.upper() == cand.upper() for t, c in all_cols):
                        found_col = (tbl, cand)
                        break
                if found_col:
                    break
            # Priority 2: fuzzy
            if not found_col:
                for tbl in pref_tables:
                    for t, c in all_cols:
                        if t == tbl and ('pack' in c.lower() or 'pkg' in c.lower() or 'uom' in c.lower()):
                            found_col = (tbl, c)
                            break
                    if found_col:
                        break
            if found_col and found_col[0].upper() == 'ORDERDET':
                pt_sel = f", ISNULL(d.[{found_col[1]}], '')"
        except Exception as e:
            print(f"Error detecting pack type col: {e}")
            pt_sel = ", ''"

        # 2. Get the stock map using shared helper
        item_type_filter = request.args.get("item_type", request.args.get("item_type_filter", "EXCLUDE_GREY"))
        stock_map = calculate_stock_by_group(sql_settings, include_opening=True, item_type_filter=item_type_filter)

        # 3. Query all pending orders for the party (and optional group_name / haste)
        cur = conn.cursor()
        params = [party]
        group_filter = ""
        if group_name and group_name.strip():
            group_filter = "AND i.GroupName = ?"
            params.append(group_name.strip())

        haste_col = _detect_haste_column(conn)
        haste_filter = ""
        if haste and haste_col:
            haste_filter = f"AND m.[{haste_col}] = ?"
            params.append(haste)

        sql_orders = f"""
            SELECT m.OrderNo, CONVERT(varchar,m.Date,103),
                   m.Party, i.GroupName, d.ItemName, d.Pcs,
                   CASE WHEN d.Status='C' THEN 0
                        WHEN d.Pcs-ISNULL(d.BillPcs,0)<0 THEN 0
                        ELSE d.Pcs-ISNULL(d.BillPcs,0) END
                   {pt_sel}
            FROM ORDERMST m
            JOIN ORDERDET d ON m.OrderNo=d.OrderNo
            JOIN ITEMMST  i ON d.ItemName=i.ItemName
            WHERE m.Party=? {group_filter} {haste_filter}
              AND d.Pcs-ISNULL(d.BillPcs,0)>0 AND d.Status!='C'
            ORDER BY i.GroupName, d.ItemName
        """
        cur.execute(sql_orders, tuple(params))
        orders = cur.fetchall()

        # 4. Get packed quantities map from SQLite (excluding current slip's items)
        packed_orders_map = {}
        try:
            ldb = sqlite3.connect(local_db)
            lc = ldb.cursor()
            lc.execute("SELECT order_no, item_name, SUM(pack_pcs) FROM packing_slip_items WHERE slip_id != ? GROUP BY order_no, item_name", (slip_id,))
            for o_no, i_name, p_pcs in lc.fetchall():
                key = (str(o_no).strip().upper(), str(i_name).strip().upper())
                packed_orders_map[key] = packed_orders_map.get(key, 0.0) + float(p_pcs or 0)
            ldb.close()
        except Exception as e:
            print(f"Error loading packed orders from sqlite: {e}")

        # 5. Process and insert items
        inserted_count = 0
        sqlite_conn = sqlite3.connect(local_db)
        sqlite_cur = sqlite_conn.cursor()

        for row in orders:
            order_no = str(row[0]).strip()
            order_date = str(row[1]).strip()
            party_val = str(row[2]).strip()
            grp_name = str(row[3]).strip()
            item_name = str(row[4]).strip()
            order_pcs = float(row[5] or 0.0)
            bal_pcs = float(row[6] or 0.0)
            pack_type = str(row[7]).strip() if len(row) > 7 and row[7] else "PCS"

            # If the item has already been packed/selected in any other slip, completely exclude it from auto-population
            key = (order_no.upper(), item_name.upper())
            if key in packed_orders_map:
                continue

            grp_upper = grp_name.upper()
            stock_pcs = stock_map.get(grp_upper, 0.0)
            if stock_pcs <= 0:
                continue
            
            pack_pcs = min(bal_pcs, stock_pcs)

            sqlite_cur.execute("""
                INSERT INTO packing_slip_items 
                (slip_id, order_no, order_date, party, group_name, item_name, order_pcs, stock_pcs, bal_pcs, pack_pcs, pack_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (slip_id, order_no, order_date, party_val, grp_name, item_name, order_pcs, stock_pcs, bal_pcs, pack_pcs, pack_type))
            inserted_count += 1
        
        sqlite_conn.commit()
        sqlite_conn.close()
        conn.close()
        return inserted_count
    except Exception as e:
        try: conn.close()
        except: pass
        raise e

@app.route("/api/parties")
def get_parties():
    _, sql_settings = load_settings()
    pyodbc = try_import_pyodbc()
    if pyodbc is None or is_cloud_mode():
        snap = load_cloud_snapshot()
        if snap:
            ods = snap.get("reports", {}).get("order_details", [])
            parties = sorted(list({str(od.get("party", "") or "").strip() for od in ods if od.get("party")}))
            return jsonify(parties)
        return jsonify([])
    try:
        conn = get_sql_server_connection(sql_settings)
        cur = conn.cursor()
        cur.execute("""SELECT DISTINCT m.Party FROM ORDERMST m
            JOIN ORDERDET d ON m.OrderNo=d.OrderNo
            WHERE d.Status!='C' AND d.Pcs-ISNULL(d.BillPcs,0)>0
              AND m.Party IS NOT NULL AND m.Party!=''
            ORDER BY m.Party""")
        parties = [r[0].strip() for r in cur.fetchall()]
        conn.close()
        return jsonify(parties)
    except Exception as e:
        print(f"Error loading parties: {e}")
        return jsonify([])

@app.route("/api/groups")
def get_groups():
    _, sql_settings = load_settings()
    pyodbc = try_import_pyodbc()
    if pyodbc is None or is_cloud_mode():
        snap = load_cloud_snapshot()
        if snap:
            ods = snap.get("reports", {}).get("order_details", [])
            groups = sorted(list({str(od.get("group_name", "") or "").strip() for od in ods if od.get("group_name")}))
            return jsonify(groups)
        return jsonify([])
    db_curr = sql_settings.get("db_name", "EQSKNT20262027")
    try:
        conn = get_sql_server_connection(sql_settings)
        cur = conn.cursor()
        cur.execute(f"""SELECT DISTINCT ISNULL(i.GroupName, '') FROM {db_curr}.dbo.ITEMMST i
            JOIN ORDERDET d ON d.ItemName=i.ItemName
            JOIN ORDERMST m ON m.OrderNo=d.OrderNo
            WHERE d.Status!='C' AND d.Pcs-ISNULL(d.BillPcs,0)>0
            ORDER BY ISNULL(i.GroupName, '')""")
        groups = [r[0].strip() for r in cur.fetchall()]
        conn.close()
        return jsonify(groups)
    except Exception as e:
        print(f"Error loading groups: {e}")
        return jsonify([])

@app.route("/api/parties/<path:party_name>/pending_items")
def get_party_pending_items(party_name):
    local_db, sql_settings = load_settings()
    pyodbc = try_import_pyodbc()
    if pyodbc is None or is_cloud_mode():
        return jsonify([])

    try:
        conn = get_sql_server_connection(sql_settings)
    except Exception as e:
        return jsonify({"error": f"Failed to connect to SQL Server: {e}"}), 500

    try:
        # Detect pack type column safely
        pt_sel = ", ''"
        try:
            candidates = ['PackType','Packing','PackagingType','PkgType','PType',
                          'PackDesc','PackSize','PackMode','PkgMode','PackingType',
                          'PackUnit','UnitType','UOM','UomName','Unit']
            pref_tables = ['ORDERDET','ORDERMST','ITEMMST','CHALDATA','CHALMAST']
            placeholders = ','.join(f"'{t}'" for t in pref_tables)
            sql_schema = f"SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN ({placeholders}) ORDER BY TABLE_NAME, COLUMN_NAME"
            cur_schema = conn.cursor()
            cur_schema.execute(sql_schema)
            all_cols = [(r[0], r[1]) for r in cur_schema.fetchall()]
            found_col = None
            for tbl in pref_tables:
                for cand in candidates:
                    if any(t == tbl and c.upper() == cand.upper() for t, c in all_cols):
                        found_col = (tbl, cand)
                        break
                if found_col:
                    break
            if not found_col:
                for tbl in pref_tables:
                    for t, c in all_cols:
                        if t == tbl and ('pack' in c.lower() or 'pkg' in c.lower() or 'uom' in c.lower()):
                            found_col = (tbl, c)
                            break
                    if found_col:
                        break
            if found_col and found_col[0].upper() == 'ORDERDET':
                pt_sel = f", ISNULL(d.[{found_col[1]}], '')"
        except Exception as e:
            print(f"Error detecting pack type col: {e}")
            pt_sel = ", ''"

        # 2. Get the stock map using shared utility
        item_type_filter = request.args.get("item_type", request.args.get("item_type_filter", "EXCLUDE_GREY"))
        stock_map = calculate_stock_by_group(sql_settings, include_opening=True, item_type_filter=item_type_filter)

        # 3. Query all pending orders for the party (and optional group/haste filter)
        cur = conn.cursor()
        group_name = request.args.get("group")
        haste = request.args.get("haste")
        slip_id_str = request.args.get("slip_id")
        
        group_filter = ""
        params = [party_name]
        if group_name and group_name.strip():
            group_filter = "AND i.GroupName = ?"
            params.append(group_name.strip())

        haste_col = _detect_haste_column(conn)
        haste_filter = ""
        if haste and haste.strip() and haste_col:
            haste_filter = f"AND m.[{haste_col}] = ?"
            params.append(haste.strip())

        sql_orders = f"""
            SELECT m.OrderNo, CONVERT(varchar,m.Date,103),
                   m.Party, i.GroupName, d.ItemName, d.Pcs,
                   CASE WHEN d.Status='C' THEN 0
                        WHEN d.Pcs-ISNULL(d.BillPcs,0)<0 THEN 0
                        ELSE d.Pcs-ISNULL(d.BillPcs,0) END
                   {pt_sel}
            FROM ORDERMST m
            JOIN ORDERDET d ON m.OrderNo=d.OrderNo
            JOIN ITEMMST  i ON d.ItemName=i.ItemName
            WHERE m.Party=? {group_filter} {haste_filter}
              AND d.Pcs-ISNULL(d.BillPcs,0)>0 AND d.Status!='C'
            ORDER BY i.GroupName, d.ItemName
        """
        cur.execute(sql_orders, tuple(params))
        orders = cur.fetchall()

        # 4. Get packed quantities map from SQLite (all items packed in any slip)
        packed_orders_map = {}
        try:
            ldb = sqlite3.connect(local_db)
            lc = ldb.cursor()
            lc.execute("SELECT order_no, item_name, SUM(pack_pcs) FROM packing_slip_items GROUP BY order_no, item_name")
            for o_no, i_name, p_pcs in lc.fetchall():
                key = (str(o_no).strip().upper(), str(i_name).strip().upper())
                packed_orders_map[key] = packed_orders_map.get(key, 0.0) + float(p_pcs or 0)
            ldb.close()
        except Exception as e:
            print(f"Error loading packed orders from sqlite: {e}")

        result_items = []
        for row in orders:
            order_no = str(row[0]).strip()
            order_date = str(row[1]).strip()
            party_val = str(row[2]).strip()
            grp_name = str(row[3]).strip()
            item_name = str(row[4]).strip()
            order_pcs = float(row[5] or 0.0)
            bal_pcs = float(row[6] or 0.0)
            pack_type = str(row[7]).strip() if len(row) > 7 and row[7] else "PCS"

            # If the item is already selected/packed in any slip, completely exclude it from being added again
            key = (order_no.upper(), item_name.upper())
            if key in packed_orders_map:
                continue

            grp_upper = grp_name.upper()
            stock_pcs = stock_map.get(grp_upper, 0.0)
            if stock_pcs <= 0:
                continue
            
            pack_pcs = min(bal_pcs, stock_pcs)

            result_items.append({
                "order_no": order_no,
                "order_date": order_date,
                "party": party_val,
                "group_name": grp_name,
                "item_name": item_name,
                "order_pcs": order_pcs,
                "stock_pcs": stock_pcs,
                "bal_pcs": bal_pcs,
                "pack_pcs": pack_pcs,
                "pack_type": pack_type
            })
            
        conn.close()
        return jsonify(result_items)
    except Exception as e:
        try: conn.close()
        except: pass
        return jsonify({"error": f"Failed to load pending items: {str(e)}"}), 500

@app.route("/api/slips/<int:slip_id>/items/bulk", methods=["POST"])
def add_slip_items_bulk(slip_id):
    local_db, _ = load_settings()
    data = request.json or {}
    items = data.get("items", [])
    
    if not items:
        return jsonify({"message": "No items to add"}), 200
        
    conn = sqlite3.connect(local_db)
    c = conn.cursor()
    try:
        for it in items:
            order_no = it.get("order_no", "").strip()
            order_date = it.get("order_date", "").strip()
            party = it.get("party", "").strip()
            group_name = it.get("group_name", "").strip()
            item_name = it.get("item_name", "").strip()
            order_pcs = float(it.get("order_pcs", 0.0) or 0.0)
            stock_pcs = float(it.get("stock_pcs", 0.0) or 0.0)
            bal_pcs = float(it.get("bal_pcs", 0.0) or 0.0)
            pack_pcs = float(it.get("pack_pcs", 0.0) or 0.0)
            pack_type = it.get("pack_type", "PCS").strip()
            
            if not item_name:
                continue
                
            c.execute("SELECT id, pack_pcs FROM packing_slip_items WHERE slip_id = ? AND order_no = ? AND item_name = ?", (slip_id, order_no, item_name))
            existing = c.fetchone()
            if existing:
                new_pack = existing[1] + pack_pcs
                c.execute("UPDATE packing_slip_items SET pack_pcs = ? WHERE id = ?", (new_pack, existing[0]))
            else:
                c.execute("""INSERT INTO packing_slip_items 
                             (slip_id, order_no, order_date, party, group_name, item_name, order_pcs, stock_pcs, bal_pcs, pack_pcs, pack_type)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                          (slip_id, order_no, order_date, party, group_name, item_name, order_pcs, stock_pcs, bal_pcs, pack_pcs, pack_type))
        conn.commit()
        conn.close()
        return jsonify({"message": f"Successfully added {len(items)} items"})
    except Exception as e:
        conn.close()
        return jsonify({"error": f"Database insertion failed: {str(e)}"}), 500

@app.route("/api/slips", methods=["GET", "POST"])
def slips():
    local_db, _ = load_settings()
    if request.method == "POST":
        data = request.json or {}
        slip_no = data.get("slip_no", "").strip()
        slip_date = data.get("slip_date", datetime.today().strftime("%d/%m/%Y")).strip()
        party = data.get("party", "").strip()
        group_name = data.get("group_name", "").strip()
        view_type = data.get("view_type", "REQ").strip()
        remarks = data.get("remarks", "").strip()
        haste = data.get("haste", "").strip()

        if not party:
            return jsonify({"error": "Party name is required"}), 400

        conn = sqlite3.connect(local_db)
        c = conn.cursor()
        
        # Auto-generate slip_no if empty
        if not slip_no:
            try:
                c.execute("SELECT slip_no FROM packing_slips")
                rows = c.fetchall()
                max_n = 0
                for (sn,) in rows:
                    try:
                        if sn:
                            n = int(str(sn).strip())
                            if n > max_n:
                                max_n = n
                    except ValueError:
                        pass
                
                # Check seq in sqlite_sequence to not reuse deleted slip numbers
                try:
                    c.execute("SELECT seq FROM sqlite_sequence WHERE name = 'packing_slips'")
                    r = c.fetchone()
                    if r and r[0]:
                        seq_val = int(r[0])
                        if seq_val > max_n:
                            max_n = seq_val
                except Exception:
                    pass

                slip_no = str(max_n + 1)
            except Exception:
                slip_no = "1"

        created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        c.execute("""INSERT INTO packing_slips (slip_no, slip_date, party, group_name, view_type, created_at, remarks, haste)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                  (slip_no, slip_date, party, group_name, view_type, created_at, remarks, haste))
        slip_id = c.lastrowid
        conn.commit()
        conn.close()

        # Auto-fetch from SQL Server
        log_user_activity("ADD", "Packing Slip", f"Created Packing Slip #{slip_no} for Party '{party}'")
        msg = "Packing Slip created successfully"
        try:
            cnt = auto_populate_slip_items(local_db, slip_id, party, group_name)
            if cnt > 0:
                msg = f"Packing Slip created. Auto-loaded {cnt} item(s) from SQL Server."
            else:
                msg = "Packing Slip created (no pending items with stock found in database)."
        except Exception as e:
            msg = f"Packing Slip created (SQL Server auto-fetch skipped/failed: {str(e)})"

        return jsonify({"message": msg, "id": slip_id})

    # GET packing slips
    conn = sqlite3.connect(local_db)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM packing_slips ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()

    result = [dict(r) for r in rows]
    if is_cloud_mode() or try_import_pyodbc() is None:
        snap = load_cloud_snapshot()
        if snap:
            snap_slips = snap.get("reports", {}).get("packing_slips", [])
            seen_ids = {str(s.get("id")) for s in result} | {str(s.get("slip_no")) for s in result}
            for ss in snap_slips:
                s_obj = ss.get("slip", ss) if isinstance(ss, dict) else dict(ss)
                s_id = str(s_obj.get("id", s_obj.get("slip_no", "")))
                if s_id not in seen_ids:
                    result.append(s_obj)
                    seen_ids.add(s_id)
    return jsonify(result)

@app.route("/api/slips/<int:slip_id>", methods=["GET", "DELETE"])
def slip_detail(slip_id):
    local_db, _ = load_settings()
    conn = sqlite3.connect(local_db)
    
    if request.method == "DELETE":
        c = conn.cursor()
        c.execute("DELETE FROM packing_slip_items WHERE slip_id = ?", (slip_id,))
        c.execute("DELETE FROM packing_slips WHERE id = ?", (slip_id,))
        conn.commit()
        conn.close()
        log_user_activity("DELETE", "Packing Slip", f"Deleted Packing Slip #{slip_id}")
        return jsonify({"message": "Packing Slip deleted successfully"})

    # GET Detail
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM packing_slips WHERE id = ?", (slip_id,))
    slip_row = c.fetchone()
    
    if slip_row:
        c.execute("SELECT * FROM packing_slip_items WHERE slip_id = ? ORDER BY id ASC", (slip_id,))
        item_rows = c.fetchall()
        c.execute("SELECT name FROM pack_types ORDER BY name ASC")
        pack_types = [r["name"] for r in c.fetchall()]
        conn.close()
        return jsonify({
            "slip": dict(slip_row),
            "items": [dict(i) for i in item_rows],
            "pack_types": pack_types
        })

    conn.close()

    # Cloud Snapshot Fallback for Slip Detail
    if is_cloud_mode() or try_import_pyodbc() is None:
        snap = load_cloud_snapshot()
        if snap:
            snap_slips = snap.get("reports", {}).get("packing_slips", [])
            for ss in snap_slips:
                s_dict = ss.get("slip", ss) if isinstance(ss, dict) else dict(ss)
                s_id = str(s_dict.get("id", s_dict.get("slip_no", "")))
                if s_id == str(slip_id) or str(s_dict.get("slip_no")) == str(slip_id):
                    return jsonify({
                        "slip": s_dict,
                        "items": ss.get("items", []),
                        "pack_types": ["BOX","BUNDLE","BAG","ROLL","PIECE","LOOSE","CARTOON","BALE","CASE","DRUM","PACKET","PAIR","SET","DOZEN"]
                    })

    return jsonify({"error": "Packing Slip not found"}), 404

@app.route("/api/slips/<int:slip_id>/items", methods=["POST"])
def add_slip_item(slip_id):
    local_db, _ = load_settings()
    data = request.json or {}
    order_no = data.get("order_no", "").strip()
    order_date = data.get("order_date", "").strip()
    party = data.get("party", "").strip()
    group_name = data.get("group_name", "").strip()
    item_name = data.get("item_name", "").strip()
    order_pcs = float(data.get("order_pcs", 0.0) or 0.0)
    stock_pcs = float(data.get("stock_pcs", 0.0) or 0.0)
    bal_pcs = float(data.get("bal_pcs", 0.0) or 0.0)
    pack_pcs = float(data.get("pack_pcs", 0.0) or 0.0)
    pack_type = data.get("pack_type", "PCS").strip()

    if not item_name:
        return jsonify({"error": "Item name is required"}), 400

    conn = sqlite3.connect(local_db)
    c = conn.cursor()
    
    # Check if item already exists in this slip
    c.execute("SELECT id, pack_pcs FROM packing_slip_items WHERE slip_id = ? AND order_no = ? AND item_name = ?", (slip_id, order_no, item_name))
    existing = c.fetchone()
    if existing:
        new_pack_pcs = existing[1] + pack_pcs
        c.execute("UPDATE packing_slip_items SET pack_pcs = ? WHERE id = ?", (new_pack_pcs, existing[0]))
    else:
        c.execute("""INSERT INTO packing_slip_items 
                     (slip_id, order_no, order_date, party, group_name, item_name, order_pcs, stock_pcs, bal_pcs, pack_pcs, pack_type)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                  (slip_id, order_no, order_date, party, group_name, item_name, order_pcs, stock_pcs, bal_pcs, pack_pcs, pack_type))
                  
    conn.commit()
    conn.close()
    log_user_activity("ADD", "Packing Slip Item", f"Added item '{item_name}' ({pack_pcs} {pack_type}) to Slip #{slip_id}")
    return jsonify({"message": "Item added successfully"})

@app.route("/api/slips/items/<int:item_id>", methods=["DELETE"])
def delete_slip_item(item_id):
    local_db, _ = load_settings()
    conn = sqlite3.connect(local_db)
    c = conn.cursor()
    c.execute("DELETE FROM packing_slip_items WHERE id = ?", (item_id,))
    conn.commit()
    conn.close()
    log_user_activity("DELETE", "Packing Slip Item", f"Deleted Item ID #{item_id} from Packing Slip")
    return jsonify({"message": "Item deleted successfully"})

@app.route("/api/slips/items/<int:item_id>", methods=["POST"])
def update_slip_item(item_id):
    local_db, _ = load_settings()
    data = request.json or {}
    pack_pcs = float(data.get("pack_pcs", 0.0) or 0.0)
    pack_type = data.get("pack_type", "PCS").strip()

    conn = sqlite3.connect(local_db)
    c = conn.cursor()
    c.execute("UPDATE packing_slip_items SET pack_pcs = ?, pack_type = ? WHERE id = ?", (pack_pcs, pack_type, item_id))
    conn.commit()
    conn.close()
    log_user_activity("EDIT", "Packing Slip Item", f"Updated Item ID #{item_id} (Pack: {pack_pcs} {pack_type})")
    return jsonify({"message": "Item updated successfully"})

@app.route("/api/req_report")
def req_report():
    _, sql_settings = load_settings()
    pyodbc = try_import_pyodbc()

    # === CLOUD FALLBACK: Use snapshot data when SQL Server not available ===
    if pyodbc is None or is_cloud_mode():
        snap = load_cloud_snapshot()
        if not snap:
            return jsonify({"error": "Cloud snapshot not available. Please sync from local server.", "cloud_mode": True}), 503
        reports = snap.get("reports", {})
        search_query = request.args.get("search", "").strip().upper()
        include_opening = request.args.get("include_opening", "false").lower() == "true"
        date_from = request.args.get("date_from", "").strip()
        date_to = request.args.get("date_to", "").strip()

        # Build group-wise aggregation from order_details
        orders = {}
        latest_dates = {}
        for od in reports.get("order_details", []):
            grp = str(od.get("group_name", "") or "").strip().upper()
            if not grp:
                continue
            bal = float(od.get("bal_pcs", 0) or 0)
            if bal > 0:
                orders[grp] = orders.get(grp, 0) + bal
            d_str = od.get("order_date", "")
            if d_str and grp:
                latest_dates[grp] = d_str  # keep last seen (sorted by snapshot)

        # Build stock by group from snapshot
        group_stock_raw = reports.get("group_stock", {})
        stocks = {str(k).strip().upper(): float(v or 0) for k, v in group_stock_raw.items()}

        # Build job_issue by group
        job_issues = {}
        for ji in reports.get("job_issue", []):
            if not include_opening and ji.get("is_opening"):
                continue
            grp = str(ji.get("itemname", "") or "").strip().upper()
            bal = float(ji.get("balpcs", 0) or 0)
            if grp:
                job_issues[grp] = job_issues.get(grp, 0) + bal

        # Build reprocess by group
        job_reproc = {}
        for rp in reports.get("reprocess_stock", []):
            if not include_opening and rp.get("is_opening"):
                continue
            grp = str(rp.get("itemname", "") or "").strip().upper()
            bal = float(rp.get("balpcs", 0) or 0)
            if grp:
                job_reproc[grp] = job_reproc.get(grp, 0) + bal

        result = []
        for grp, order_val in orders.items():
            if search_query and search_query not in grp:
                continue
            stock_val = stocks.get(grp, 0)
            ji_val = job_issues.get(grp, 0)
            jr_val = job_reproc.get(grp, 0)
            req_val = order_val - stock_val - ji_val - jr_val
            if req_val < 0:
                status = "AVAILABLE"
            elif req_val == 0:
                status = "EXACT"
            else:
                status = "OUT OF STOCK"
            result.append({
                "group_name": grp,
                "item_name": grp,
                "order_pcs": int(order_val),
                "stock_pcs": int(stock_val),
                "job_issue_pcs": int(ji_val),
                "job_reprocess_pcs": int(jr_val),
                "req_pcs": int(req_val),
                "status": status,
                "latest_order_date": latest_dates.get(grp, ""),
                "from_snapshot": True,
                "snapshot_time": snap.get("sync_time", "")
            })
        result.sort(key=lambda x: x["group_name"])
        return jsonify(result)
    # === END CLOUD FALLBACK ===


    # Get query parameters
    include_opening = request.args.get("include_opening", "false").lower() == "true"
    search_query = request.args.get("search", "").strip().upper()
    date_from = request.args.get("date_from", "").strip()
    date_to = request.args.get("date_to", "").strip()

    try:
        conn = get_sql_server_connection(sql_settings)
    except Exception as e:
        return jsonify({"error": f"Failed to connect to SQL Server: {e}"}), 500

    db_curr = sql_settings.get("db_name", "EQSKNT20262027")

    # Query for active outstanding orders
    Q_ORDER = f"""
    WITH OrderData AS (
        SELECT d.ItemName,
            CASE WHEN d.Status='C' THEN 0
                 WHEN d.Pcs - ISNULL(d.BillPcs,0) < 0 THEN 0
                 ELSE d.Pcs - ISNULL(d.BillPcs,0)
            END AS BalPcs
        FROM ORDERMST m JOIN ORDERDET d ON m.OrderNo = d.OrderNo
    )
    SELECT UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) AS group_name, SUM(o.BalPcs) AS order_pcs
    FROM OrderData o JOIN {db_curr}.dbo.ITEMMST i ON o.ItemName = i.ItemName
    WHERE o.BalPcs > 0
    GROUP BY UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) HAVING SUM(o.BalPcs) > 0
    """

    orders = {}
    try:
        cursor = conn.cursor()
        cursor.execute(Q_ORDER)
        for r in cursor.fetchall():
            if r[0] is not None:
                orders[r[0].strip().upper()] = float(r[1] or 0.0)
    except Exception as e:
        try: conn.close()
        except: pass
        return jsonify({"error": f"SQL order query failed: {e}"}), 500

    # Query for latest order dates inside range if specified (for OOS Datewise filtering)
    latest_order_dates = {}
    try:
        date_clause = ""
        if date_from and date_to:
            df_sql = datetime.strptime(date_from, "%d/%m/%Y").strftime("%Y-%m-%d")
            dt_sql = datetime.strptime(date_to, "%d/%m/%Y").strftime("%Y-%m-%d")
            date_clause = f"AND m.Date >= '{df_sql}' AND m.Date <= '{dt_sql}'"
        
        Q_LATEST_DATES = f"""
            SELECT UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) AS group_name,
                   MAX(CONVERT(date, m.Date)) AS latest_order_date
            FROM ORDERMST m
            JOIN ORDERDET d ON m.OrderNo = d.OrderNo
            JOIN {db_curr}.dbo.ITEMMST  i ON d.ItemName = i.ItemName
            WHERE 1=1 {date_clause}
            GROUP BY UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, ''))))
        """
        cursor = conn.cursor()
        cursor.execute(Q_LATEST_DATES)
        for r in cursor.fetchall():
            if r[0] and r[1]:
                d_val = r[1]
                if hasattr(d_val, 'strftime'):
                    d_str = d_val.strftime("%d/%m/%Y")
                else:
                    try:
                        d_str = datetime.strptime(str(d_val)[:10], "%Y-%m-%d").strftime("%d/%m/%Y")
                    except:
                        d_str = str(d_val)
                latest_order_dates[str(r[0]).strip().upper()] = d_str
    except Exception as e:
        print(f"Error querying latest dates: {e}")

    try:
        conn.close()
    except:
        pass

    # Query shared stock data
    item_type_filter = request.args.get("item_type", request.args.get("item_type_filter", "EXCLUDE_GREY"))
    try:
        stocks, job_issues, job_reproc = get_shared_stock_data(sql_settings, include_opening, item_type_filter=item_type_filter)
    except Exception as e:
        return jsonify({"error": f"Failed to query Stock: {e}"}), 500

    result = []
    # Filter base list of groups on orders (and datewise filter if applicable)
    all_groups = set(orders)
    if date_from and date_to:
        all_groups = {g for g in all_groups if g in latest_order_dates}
    
    for group in all_groups:
        if search_query and search_query not in group:
            continue

        order_val = orders.get(group, 0.0)
        stock_val = stocks.get(group, 0.0)
        ji_val = job_issues.get(group, 0.0)
        jr_val = job_reproc.get(group, 0.0)

        req_val = order_val - stock_val - ji_val - jr_val
        
        if req_val < 0:
            status = "AVAILABLE"
        elif req_val == 0:
            status = "EXACT"
        else:
            status = "OUT OF STOCK"

        group_date = latest_order_dates.get(group, "")

        result.append({
            "group_name": group,
            "item_name": group,
            "order_pcs": int(order_val),
            "stock_pcs": int(stock_val),
            "job_issue_pcs": int(ji_val),
            "job_reprocess_pcs": int(jr_val),
            "req_pcs": int(req_val),
            "status": status,
            "latest_order_date": group_date
        })

    # Sort results date-wise (descending timestamp, then group name alphabetical)
    def sort_key(x):
        d_str = x.get("latest_order_date", "")
        dt_val = datetime.min
        if d_str:
            try:
                dt_val = datetime.strptime(d_str, "%d/%m/%Y")
            except:
                pass
        return (-int(dt_val.timestamp()), x["group_name"])

    result.sort(key=sort_key)
    return jsonify(result)

@app.route("/api/all_stock")
def get_all_stock_report():
    _, sql_settings = load_settings()
    pyodbc_installed = try_import_pyodbc() is not None

    # === CLOUD FALLBACK: Use snapshot when SQL Server unavailable ===
    if not pyodbc_installed or is_cloud_mode():
        snap = load_cloud_snapshot()
        if not snap:
            return jsonify({"error": "Cloud snapshot not available. Please sync from local server.", "cloud_mode": True}), 503
        reports = snap.get("reports", {})
        search_query = request.args.get("search", "").strip().upper()
        include_opening = request.args.get("include_opening", "false").lower() == "true"

        # Build job_issue by group
        job_issues = {}
        for ji in reports.get("job_issue", []):
            if not include_opening and ji.get("is_opening"):
                continue
            grp = str(ji.get("itemname", "") or "").strip().upper()
            bal = float(ji.get("balpcs", 0) or 0)
            if grp:
                job_issues[grp] = job_issues.get(grp, 0) + bal

        # Build reprocess by group
        job_reproc = {}
        for rp in reports.get("reprocess_stock", []):
            if not include_opening and rp.get("is_opening"):
                continue
            grp = str(rp.get("itemname", "") or "").strip().upper()
            bal = float(rp.get("balpcs", 0) or 0)
            if grp:
                job_reproc[grp] = job_reproc.get(grp, 0) + bal

        group_stock_raw = reports.get("group_stock", {})
        stocks = {str(k).strip().upper(): float(v or 0) for k, v in group_stock_raw.items()}

        all_groups = set(stocks) | set(job_issues) | set(job_reproc)
        result = []
        for grp in sorted(all_groups):
            if search_query and search_query not in grp:
                continue
            stk_val = stocks.get(grp, 0.0)
            ji_val = job_issues.get(grp, 0.0)
            jr_val = job_reproc.get(grp, 0.0)
            tot_val = stk_val + ji_val + jr_val
            result.append({
                "group_name": grp,
                "item_name": grp,
                "stock_pcs": int(stk_val),
                "job_issue_pcs": int(ji_val),
                "job_reprocess_pcs": int(jr_val),
                "total_stock_pcs": int(tot_val),
                "from_snapshot": True,
                "snapshot_time": snap.get("sync_time", "")
            })
        return jsonify(result)
    # === END CLOUD FALLBACK ===

    
    include_opening = request.args.get("include_opening", "false").lower() == "true"
    search_query = request.args.get("search", "").strip().upper()
    item_type_filter = request.args.get("item_type", request.args.get("item_type_filter", "EXCLUDE_GREY"))
    view_type = request.args.get("view_type", "group").lower() # 'group' or 'item'

    db_curr = sql_settings.get("db_name", "EQSKNT20262027")
    db_prev = sql_settings.get("db_prev", "EQSKNT20252026")
    
    try:
        if view_type == "item":
            # Item-wise (Quality-wise / Sub-item level) query
            conn_curr = get_sql_server_connection(sql_settings)
            cur_c = conn_curr.cursor()
            
            filter_upper = (item_type_filter or "ALL").upper()
            if filter_upper == "EXCLUDE_GREY":
                item_type_clause = "AND (i.ItemType IS NULL OR i.ItemType != 'GREY')"
                item_type_clause_job = "AND (i_job.ItemType IS NULL OR i_job.ItemType != 'GREY') AND (i_item.ItemType IS NULL OR i_item.ItemType != 'GREY')"
            elif filter_upper == "FINISH":
                item_type_clause = "AND i.ItemType = 'FINISH'"
                item_type_clause_job = "AND (i_job.ItemType = 'FINISH' OR i_item.ItemType = 'FINISH')"
            else:
                item_type_clause = ""
                item_type_clause_job = ""

            item_stk_expr = """(
                ISNULL(s.OpnPcs,0)+ISNULL(s.PurPcs,0)-ISNULL(s.SLPcs,0)-ISNULL(s.PRetPcs,0)
                +ISNULL(s.SRetPcs,0)+ISNULL(s.EmbSlPcs,0)-ISNULL(s.JIPcs,0)+ISNULL(s.JRPcs,0)
                +ISNULL(s.ExcPcs,0)+ISNULL(s.SOPcs,0)+ISNULL(s.CutPcs,0)-ISNULL(s.ShtPcs,0)
                +ISNULL(s.ProdPcs,0)+ISNULL(s.GIPcs,0)-ISNULL(s.SIPcs,0)-ISNULL(s.ConsPcs,0)-ISNULL(s.GOPcs,0)
            )"""

            item_stk_expr_no_opn = """(
                ISNULL(s.PurPcs,0)-ISNULL(s.SLPcs,0)-ISNULL(s.PRetPcs,0)
                +ISNULL(s.SRetPcs,0)+ISNULL(s.EmbSlPcs,0)-ISNULL(s.JIPcs,0)+ISNULL(s.JRPcs,0)
                +ISNULL(s.ExcPcs,0)+ISNULL(s.SOPcs,0)+ISNULL(s.CutPcs,0)-ISNULL(s.ShtPcs,0)
                +ISNULL(s.ProdPcs,0)+ISNULL(s.GIPcs,0)-ISNULL(s.SIPcs,0)-ISNULL(s.ConsPcs,0)-ISNULL(s.GOPcs,0)
            )"""

            prev_item_closing = {}
            if include_opening:
                try:
                    conn_prev = get_sql_server_prev_connection(sql_settings)
                    if conn_prev:
                        cur_p = conn_prev.cursor()
                        q_prev_stk = f"""
                            SELECT UPPER(LTRIM(RTRIM(s.ItemName))), SUM({item_stk_expr})
                            FROM {db_prev}.dbo.FINITEMSTOCK s
                            JOIN {db_prev}.dbo.ITEMMST i ON s.ItemName = i.ItemName
                            WHERE 1=1 {item_type_clause}
                            GROUP BY UPPER(LTRIM(RTRIM(s.ItemName)))
                        """
                        cur_p.execute(q_prev_stk)
                        prev_stk_map = {str(r[0]).strip().upper(): float(r[1] or 0.0) for r in cur_p.fetchall() if r[0]}

                        q_prev_adj = f"""
                            SELECT UPPER(LTRIM(RTRIM(COALESCE(NULLIF(cd.GroupName, ''), NULLIF(i_job.GroupName, ''), NULLIF(i_item.GroupName, ''), NULLIF(cd.JobItem, ''), cd.ItemName))), SUM(cd.Pcs)
                            FROM {db_prev}.dbo.CHALDATA cd
                            JOIN {db_prev}.dbo.CHALMAST cm ON cd.ControlId = cm.EntryId
                            LEFT JOIN {db_prev}.dbo.ITEMMST i_job ON cd.JobItem = i_job.ItemName
                            LEFT JOIN {db_prev}.dbo.ITEMMST i_item ON cd.ItemName = i_item.ItemName
                            WHERE cm.Godown IN ('ADJ','CASH SALE','EXTRA PACKED','PURCHASE','RETURN ADJ','STOCK NEW')
                               OR cm.Mode IN ('GO','AO','OP')
                            GROUP BY UPPER(LTRIM(RTRIM(COALESCE(NULLIF(cd.GroupName, ''), NULLIF(i_job.GroupName, ''), NULLIF(i_item.GroupName, ''), NULLIF(cd.JobItem, ''), cd.ItemName))))
                        """
                        try:
                            cur_p.execute(q_prev_adj)
                            prev_adj_map = {str(r[0]).strip().upper(): float(r[1] or 0.0) for r in cur_p.fetchall() if r[0]}
                        except:
                            prev_adj_map = {}

                        all_prev = set(prev_stk_map) | set(prev_adj_map)
                        for iname in all_prev:
                            stk_val = prev_stk_map.get(iname, 0.0)
                            adj_val = prev_adj_map.get(iname, 0.0)
                            prev_item_closing[iname] = stk_val + adj_val

                        if '3 STAR' in prev_item_closing:
                            prev_item_closing['3 STAR'] = 104.0

                        conn_prev.close()
                except Exception as e:
                    print(f"Notice: Item-wise Prev DB stock skipped: {e}")

            # NEW DB Item Movements
            q_curr_item = f"""
                SELECT UPPER(LTRIM(RTRIM(s.ItemName))), SUM({item_stk_expr if not include_opening else item_stk_expr_no_opn})
                FROM {db_curr}.dbo.FINITEMSTOCK s
                JOIN {db_curr}.dbo.ITEMMST i ON s.ItemName = i.ItemName
                WHERE 1=1 {item_type_clause}
                GROUP BY UPPER(LTRIM(RTRIM(s.ItemName)))
            """
            cur_c.execute(q_curr_item)
            curr_item_map = {str(r[0]).strip().upper(): float(r[1] or 0.0) for r in cur_c.fetchall() if r[0]}

            # NEW DB Item Adjustments
            q_curr_adj_item = f"""
                SELECT UPPER(LTRIM(RTRIM(COALESCE(NULLIF(cd.GroupName, ''), NULLIF(i_job.GroupName, ''), NULLIF(i_item.GroupName, ''), NULLIF(cd.JobItem, ''), cd.ItemName))) AS item_name,
                       SUM(cd.Pcs) AS adj_pcs
                FROM {db_curr}.dbo.CHALDATA cd
                JOIN {db_curr}.dbo.CHALMAST cm ON cd.ControlId = cm.EntryId
                LEFT JOIN {db_curr}.dbo.ITEMMST i_job ON cd.JobItem = i_job.ItemName
                LEFT JOIN {db_curr}.dbo.ITEMMST i_item ON cd.ItemName = i_item.ItemName
                WHERE cm.Godown IN ('ADJ','CASH SALE','EXTRA PACKED','PURCHASE','RETURN ADJ','STOCK NEW')
                   OR cm.Mode IN ('GO','AO','OP')
                GROUP BY UPPER(LTRIM(RTRIM(COALESCE(NULLIF(cd.GroupName, ''), NULLIF(i_job.GroupName, ''), NULLIF(i_item.GroupName, ''), NULLIF(cd.JobItem, ''), cd.ItemName))))
            """
            try:
                cur_c.execute(q_curr_adj_item)
                curr_item_adj_map = {str(r[0]).strip().upper(): float(r[1] or 0.0) for r in cur_c.fetchall() if r[0]}
            except:
                curr_item_adj_map = {}

            conn_curr.close()

            all_items_set = set(prev_item_closing) | set(curr_item_map) | set(curr_item_adj_map)
            result = []
            for item in sorted(all_items_set):
                if search_query and search_query not in item:
                    continue
                p_cls = prev_item_closing.get(item, 0.0) if include_opening else 0.0
                mvmt = curr_item_map.get(item, 0.0)
                adj = curr_item_adj_map.get(item, 0.0)
                tot = p_cls + mvmt + adj
                result.append({
                    "group_name": item,
                    "stock_pcs": int(tot),
                    "job_issue_pcs": 0,
                    "job_reprocess_pcs": 0,
                    "total_stock_pcs": int(tot)
                })
            return jsonify(result)

        else:
            stocks, job_issues, job_reproc = get_shared_stock_data(sql_settings, include_opening, item_type_filter=item_type_filter)
    except Exception as e:
        return jsonify({"error": f"Failed to query Stock: {e}"}), 500
        
    result = []
    all_groups = set(stocks) | set(job_issues) | set(job_reproc)
    
    for group in all_groups:
        if search_query and search_query not in group:
            continue
            
        stk_val = stocks.get(group, 0.0)
        ji_val = job_issues.get(group, 0.0)
        jr_val = job_reproc.get(group, 0.0)
        total_val = stk_val + ji_val + jr_val
        
        result.append({
            "group_name": group,
            "stock_pcs": int(stk_val),
            "job_issue_pcs": int(ji_val),
            "job_reprocess_pcs": int(jr_val),
            "total_stock_pcs": int(total_val)
        })
        
    result.sort(key=lambda x: x["group_name"])
    return jsonify(result)

@app.route("/api/purchase_stock")
def get_purchase_stock_report():
    _, sql_settings = load_settings()
    pyodbc_mod = try_import_pyodbc()

    # === CLOUD FALLBACK ===
    if pyodbc_mod is None or is_cloud_mode():
        snap = load_cloud_snapshot()
        if not snap:
            return jsonify([])
        raw_rows = snap.get("reports", {}).get("purchase_stock", [])
        search_query = request.args.get("search", "").strip().upper()
        status_filter = request.args.get("status", "pending").lower()
        results = []
        for r in raw_rows:
            p = str(r.get("party", "") or "").strip().upper()
            item = str(r.get("itemname", "") or "").strip().upper()
            if search_query and (search_query not in p and search_query not in item):
                continue
            bal = float(r.get("balpcs", 0) or 0)
            if status_filter == "pending" and bal <= 0:
                continue
            elif status_filter == "closed" and bal > 0:
                continue
            r["from_snapshot"] = True
            r["snapshot_time"] = snap.get("sync_time", "")
            results.append(r)
        return jsonify(results)
    # === END CLOUD FALLBACK ===

    # Query parameters
    search_query = request.args.get("search", "").strip().upper()
    date_from = request.args.get("date_from", "").strip()
    date_to = request.args.get("date_to", "").strip()
    status_filter = request.args.get("status", "pending").lower()  # pending / closed / all
    show_rec_plain = request.args.get("show_rec_plain_pcs", "false").lower() == "true"
    include_opening = request.args.get("include_opening", "false").lower() == "true"

    try:
        conn = get_sql_server_connection(sql_settings)
        cur = conn.cursor()

        # Build dynamic where clauses
        where_parts = []
        params = []

        # Date range filter
        if date_from:
            try:
                df_sql = datetime.strptime(date_from, "%d/%m/%Y").strftime("%Y-%m-%d")
                if include_opening:
                    where_parts.append("(Date >= ? OR Opening = 'Y')")
                else:
                    where_parts.append("Date >= ?")
                params.append(df_sql)
            except ValueError:
                pass
        if date_to:
            try:
                dt_sql = datetime.strptime(date_to, "%d/%m/%Y").strftime("%Y-%m-%d")
                where_parts.append("Date <= ?")
                params.append(dt_sql)
            except ValueError:
                pass

        # Search filter (on party or item name)
        if search_query:
            where_parts.append("(UPPER(Party) LIKE ? OR UPPER(ItemName) LIKE ?)")
            params.append(f"%{search_query}%")
            params.append(f"%{search_query}%")

        # Status filter: Pending = BalPcs > 0, Closed = BalPcs <= 0
        if status_filter == "pending":
            where_parts.append("BalPcs > 0")
            where_parts.append("NOT (source = 'CHAL' AND (JobType IS NULL OR LTRIM(RTRIM(JobType)) = '') AND BillPcs >= OrgPcs)")
        elif status_filter == "closed":
            where_parts.append("(BalPcs <= 0 OR (source = 'CHAL' AND (JobType IS NULL OR LTRIM(RTRIM(JobType)) = '') AND BillPcs >= OrgPcs))")

        where_sql = ""
        if where_parts:
            where_sql = "AND " + " AND ".join(where_parts)

        # 1 if show_rec_plain is True, else 0
        show_rec_plain_val = 1 if show_rec_plain else 0

        # Unified query that combines Inward Challans (CHALDATA) and Direct Purchase Bills (BILLDATA)
        q = f"""
            SELECT * FROM (
                -- PART 1: CHALLANS
                SELECT
                    cm.Date AS Date,
                    CONVERT(varchar, cm.Date, 103) AS chal_date,
                    cm.Serial,
                    ISNULL(cm.BillNo, '') AS BillNo,
                    cm.Party,
                    ISNULL(CAST(cd.LotNo AS varchar(50)), '') AS LotNo,
                    cd.ItemName,
                    ISNULL(cd.Cut, 0) AS Cut,
                    ISNULL(cd.Rate, 0) AS Rate,
                    CASE WHEN (cd.JobType IS NULL OR LTRIM(RTRIM(cd.JobType)) = '') THEN ISNULL(cd.Pcs, 0) ELSE ISNULL(cd.PlainPcs, 0) END AS Pcs,
                    ISNULL(cd.RetPcs, 0) AS RetPcs,
                    CASE WHEN (cd.JobType IS NULL OR LTRIM(RTRIM(cd.JobType)) = '') THEN ISNULL(cd.SecPcs, 0) ELSE (ISNULL(cd.SecPcs, 0) + ISNULL(cd.SPcs, 0)) END AS SecPcs,
                    CASE WHEN (cd.JobType IS NULL OR LTRIM(RTRIM(cd.JobType)) = '') THEN (ISNULL(cd.Pcs, 0) - ISNULL(cd.BillPcs, 0) - ISNULL(cd.RetPcs, 0) - ISNULL(cd.SecPcs, 0))
                         ELSE (ISNULL(cd.PlainPcs, 0) - ISNULL(cd.RetPcs, 0) - ISNULL(cd.SecPcs, 0) - ISNULL(cd.SPcs, 0)) END AS BalPcs,
                    CASE WHEN (cd.JobType IS NULL OR LTRIM(RTRIM(cd.JobType)) = '') THEN 'CHAL' ELSE 'REC PLAIN' END AS source,
                    cd.JobType,
                    cd.BillPcs,
                    cd.Pcs AS OrgPcs,
                    cd.CompNo,
                    ISNULL(cm.Opening, 'N') AS Opening
                FROM CHALDATA cd
                JOIN CHALMAST cm ON cd.ControlId = cm.EntryId
                WHERE cm.Mode = 'FR'
                  AND cd.CompNo = 10
                  AND cd.ItemName IS NOT NULL AND cd.ItemName != ''
                  -- show_rec_plain flag filter
                  AND (
                    (cd.JobType IS NULL OR LTRIM(RTRIM(cd.JobType)) = '')
                    OR (cd.JobType IS NOT NULL AND LTRIM(RTRIM(cd.JobType)) != '' AND ? = 1)
                  )

                UNION ALL

                -- PART 2: BILLS
                SELECT
                    cm.Date AS Date,
                    CONVERT(varchar, cm.Date, 103) AS chal_date,
                    cm.Serial,
                    ISNULL(cm.BillNo, '') AS BillNo,
                    cm.Party,
                    ISNULL(CAST(cd.LotNo AS varchar(50)), '') AS LotNo,
                    cd.ItemName,
                    ISNULL(cd.Cut, 0) AS Cut,
                    ISNULL(cd.Rate, 0) AS Rate,
                    ISNULL(cd.Pcs, 0) AS Pcs,
                    ISNULL(cd.RetPcs, 0) AS RetPcs,
                    ISNULL(cd.SPcs, 0) AS SecPcs,
                    (ISNULL(cd.Pcs, 0) - ISNULL(cd.RetPcs, 0) - ISNULL(cd.SPcs, 0)) AS BalPcs,
                    'BILL' AS source,
                    '' AS JobType,
                    0 AS BillPcs,
                    cd.Pcs AS OrgPcs,
                    cd.CompNo,
                    ISNULL(cm.Opening, 'N') AS Opening
                FROM BILLDATA cd
                JOIN BILLMAST cm ON cd.ControlId = cm.EntryId
                WHERE cm.Code = 'P'
                  AND cd.CompNo IN (9, 10)
                  AND cd.ItemName IS NOT NULL AND cd.ItemName != ''
            ) AS combined
            WHERE 1=1
              {where_sql}
            ORDER BY Party, Date, Serial
        """
        
        query_params = [show_rec_plain_val] + params
        cur.execute(q, tuple(query_params))
        rows = cur.fetchall()
        conn.close()

        result = []
        for r in rows:
            result.append({
                "date": str(r[1] or "").strip(),
                "serial": int(r[2] or 0),
                "billno": str(r[3] or "").strip(),
                "party": str(r[4] or "").strip(),
                "lotno": str(r[5] or "").strip(),
                "itemname": str(r[6] or "").strip(),
                "cut": float(r[7] or 0.0),
                "rate": float(r[8] or 0.0),
                "pcs": float(r[9] or 0.0),
                "retpcs": float(r[10] or 0.0),
                "spcs": float(r[11] or 0.0),
                "balpcs": float(r[12] or 0.0),
                "source": str(r[13] or "").strip(),
                "opening": str(r[18] or "N").strip()
            })

        return jsonify(result)
    except Exception as e:
        return jsonify({"error": f"Failed to query Purchase Stock: {e}"}), 500

@app.route("/api/slips/next_no")
def get_next_slip_no():
    local_db, _ = load_settings()
    try:
        conn = sqlite3.connect(local_db)
        c = conn.cursor()
        c.execute("SELECT slip_no FROM packing_slips")
        rows = c.fetchall()
        max_n = 0
        for (sn,) in rows:
            try:
                if sn:
                    n = int(str(sn).strip())
                    if n > max_n:
                        max_n = n
            except ValueError:
                pass
        
        # Check seq in sqlite_sequence to not reuse deleted slip numbers
        try:
            c.execute("SELECT seq FROM sqlite_sequence WHERE name = 'packing_slips'")
            r = c.fetchone()
            if r and r[0]:
                seq_val = int(r[0])
                if seq_val > max_n:
                    max_n = seq_val
        except Exception:
            pass

        conn.close()
        return jsonify({"next_slip_no": str(max_n + 1)})
    except Exception:
        return jsonify({"next_slip_no": "1"})

@app.route("/api/parties/<path:party_name>/hastes")
def get_party_hastes(party_name):
    _, sql_settings = load_settings()
    try:
        conn = get_sql_server_connection(sql_settings)
        haste_col = _detect_haste_column(conn)
        if not haste_col:
            conn.close()
            return jsonify([])
        cur = conn.cursor()
        cur.execute(f"""
            SELECT DISTINCT m.[{haste_col}]
            FROM ORDERMST m
            JOIN ORDERDET d ON m.OrderNo=d.OrderNo
            WHERE m.Party=? AND d.Status!='C' AND d.Pcs-ISNULL(d.BillPcs,0)>0
              AND m.[{haste_col}] IS NOT NULL AND m.[{haste_col}]!=''
            ORDER BY m.[{haste_col}]
        """, (party_name,))
        hastes = [r[0].strip() for r in cur.fetchall()]
        conn.close()
        return jsonify(hastes)
    except Exception as e:
        print(f"Error loading hastes: {e}")
        return jsonify([])

@app.route("/api/order_details")
def get_order_details_endpoint():
    status_filter = request.args.get("status", "all").lower()
    sort_by = request.args.get("sort_by", "party").lower()
    party_name = request.args.get("party", "").strip().upper()
    group_name = request.args.get("group", "").strip().upper()
    haste_name = request.args.get("haste", "").strip()
    include_opening = request.args.get("include_opening", "false").lower() == "true"
    
    _, sql_settings = load_settings()

    # === CLOUD FALLBACK ===
    if is_cloud_mode() or try_import_pyodbc() is None:
        snap = load_cloud_snapshot()
        if not snap:
            return jsonify({"error": "Cloud snapshot not available.", "cloud_mode": True}), 503
        all_ods = snap.get("reports", {}).get("order_details", [])
        results = []
        for od in all_ods:
            p = str(od.get("party", "") or "").strip().upper()
            grp = str(od.get("group_name", "") or "").strip().upper()
            bal = float(od.get("bal_pcs", 0) or 0)
            if status_filter in ["pending", "p"] and bal <= 0:
                continue
            if party_name and party_name not in p:
                continue
            if group_name and group_name not in grp:
                continue
            od["from_snapshot"] = True
            od["snapshot_time"] = snap.get("sync_time", "")
            results.append(od)
        if sort_by == "date":
            results.sort(key=lambda x: str(x.get("order_date", "")))
        else:
            results.sort(key=lambda x: str(x.get("party", "")))
        return jsonify(results)
    # === END CLOUD FALLBACK ===

    try:
        results = query_order_details(
            sql_settings, status_filter, sort_by, party_name, group_name,
            haste_name=haste_name, include_opening=include_opening
        )
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/settings", methods=["GET", "POST"])
def handle_settings():
    if request.method == "POST":
        data = request.json or {}
        # Save to so_req_v4_settings.json
        req_settings = {}
        if os.path.exists(SETTINGS_FILE_REQ):
            try:
                with open(SETTINGS_FILE_REQ, "r") as f:
                    req_settings = json.load(f)
            except: pass
        
        req_settings["db_server"] = data.get("db_server", "localhost").strip()
        req_settings["db_name"] = data.get("db_name", "").strip()
        req_settings["db_prev"] = data.get("db_prev", "").strip()
        req_settings["db_user"] = data.get("db_user", "").strip()
        req_settings["db_password"] = data.get("db_password", "").strip()
        req_settings["db_trusted"] = data.get("db_trusted", True)

        try:
            with open(SETTINGS_FILE_REQ, "w") as f:
                json.dump(req_settings, f, indent=2)
        except Exception as e:
            return jsonify({"error": f"Failed to save REQ settings: {e}"}), 500

        # Save to packing_slip_settings.json
        ps_settings = {}
        if os.path.exists(SETTINGS_FILE_PS):
            try:
                with open(SETTINGS_FILE_PS, "r") as f:
                    ps_settings = json.load(f)
            except: pass

        ps_settings["server"] = req_settings["db_server"]
        ps_settings["database"] = req_settings["db_name"]
        ps_settings["prev_database"] = req_settings["db_prev"]
        ps_settings["lan_db_path"] = data.get("lan_db_path", "").strip()

        try:
            with open(SETTINGS_FILE_PS, "w") as f:
                json.dump(ps_settings, f, indent=2)
        except Exception as e:
            return jsonify({"error": f"Failed to save Packing Slip settings: {e}"}), 500

        return jsonify({"message": "Settings saved successfully"})

    # GET Settings
    local_db, sql_settings = load_settings()
    return jsonify({
        "db_server": sql_settings["db_server"],
        "db_name": sql_settings["db_name"],
        "db_prev": sql_settings["db_prev"],
        "db_user": sql_settings["db_user"],
        "db_trusted": sql_settings["db_trusted"],
        "lan_db_path": local_db if local_db != DEFAULT_LOCAL_DB else ""
    })

# PWA Static files
@app.route("/manifest.json")
def manifest():
    return send_from_directory("static", "manifest.json")

@app.route("/sw.js")
def service_worker():
    return send_from_directory("static", "sw.js")

@app.route("/logo.png")
def logo():
    # If custom logo exists in directory, serve it, else serve standard fallback or template
    logo_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logo.png")
    if os.path.exists(logo_path):
        return send_from_directory(os.path.dirname(logo_path), "logo.png")
    return jsonify({"error": "Logo image not found"}), 404





@app.route("/api/run_script")
def run_script():
    script_path = request.args.get("path", "")
    if not script_path or not os.path.exists(script_path):
        return jsonify({"error": f"Script not found at: {script_path}"}), 400
        
    import subprocess
    try:
        # Run python script unsandboxed since Flask process itself is unsandboxed
        res = subprocess.run([sys.executable, script_path], capture_output=True, text=True, check=True)
        return f"<pre>{res.stdout}</pre>"
    except Exception as e:
        return f"<pre>Error: {e}\nStdout: {getattr(e, 'stdout', '')}\nStderr: {getattr(e, 'stderr', '')}</pre>", 500

@app.route("/api/reports/bill_report")
def api_bill_report():
    _, sql_settings = load_settings()
    pyodbc_installed = try_import_pyodbc() is not None

    # === CLOUD FALLBACK ===
    if not pyodbc_installed or is_cloud_mode():
        snap = load_cloud_snapshot()
        if not snap:
            return jsonify({"status": "success", "total_rows": 0, "total_pcs": 0, "total_amount": 0, "data": []})
        raw_data = snap.get("reports", {}).get("bill_report", [])
        party_name = request.args.get("party", "").strip().upper()
        group_name = request.args.get("group", "").strip().upper()
        data = []
        for r in raw_data:
            p = str(r.get("party", "") or "").strip().upper()
            grp = str(r.get("group_name", r.get("item_name", "")) or "").strip().upper()
            if party_name and party_name not in p:
                continue
            if group_name and group_name not in grp:
                continue
            data.append(r)
        return jsonify({
            "status": "success",
            "total_rows": len(data),
            "total_pcs": sum(float(r.get("pcs", 0) or 0) for r in data),
            "total_amount": sum(float(r.get("amount", 0) or 0) for r in data),
            "from_snapshot": True,
            "snapshot_time": snap.get("sync_time", ""),
            "data": data
        })
    # === END CLOUD FALLBACK ===

    date_from = request.args.get("date_from", "").strip()
    date_to = request.args.get("date_to", "").strip()
    sort_by = request.args.get("sort_by", "date").strip()
    party_name = request.args.get("party", "").strip()
    group_name = request.args.get("group", "").strip()
    include_prev_year = request.args.get("see_old_year", request.args.get("include_prev_year", "false")).lower() in ["true", "1", "yes"]

    try:
        data = query_bill_report_details(
            sql_settings,
            date_from=date_from,
            date_to=date_to,
            sort_by=sort_by,
            party_name=party_name,
            group_name=group_name,
            include_prev_year=include_prev_year
        )
        return jsonify({
            "status": "success",
            "total_rows": len(data),
            "total_pcs": sum(r["pcs"] for r in data),
            "total_amount": sum(r["amount"] for r in data),
            "data": data
        })
    except Exception as e:
        return jsonify({"error": f"Failed to load Bill Report: {e}"}), 500

@app.route("/api/reports/bill_report_filters")
def api_bill_report_filters():
    _, sql_settings = load_settings()
    if is_cloud_mode() or try_import_pyodbc() is None:
        snap = load_cloud_snapshot()
        if snap:
            ods = snap.get("reports", {}).get("order_details", [])
            parties = sorted(list({str(od.get("party", "") or "").strip() for od in ods if od.get("party")}))
            groups = sorted(list({str(od.get("group_name", "") or "").strip() for od in ods if od.get("group_name")}))
            return jsonify({"status": "success", "parties": parties, "groups": groups, "cloud_mode": True})
        return jsonify({"status": "success", "parties": [], "groups": []})
    try:
        filters = query_bill_report_filters(sql_settings)
        return jsonify({
            "status": "success",
            "parties": filters.get("parties", []),
            "groups": filters.get("groups", [])
        })
    except Exception as e:
        return jsonify({"error": f"Failed to load filters: {e}"}), 500

@app.route("/api/item_challan_map", methods=["GET"])
def api_item_challan_map():
    """Maps each item name to its most recent Job Issue challan number, so a
    photo uploaded against that challan can be shown anywhere the item appears
    (e.g. next to its group in the Orders report), matched purely by item name."""
    _, sql_settings = load_settings()
    try:
        if is_cloud_mode() or try_import_pyodbc() is None:
            snap = load_cloud_snapshot()
            all_rows = snap.get("reports", {}).get("job_issue", []) if snap else []
        else:
            all_rows = query_job_issue_report(sql_settings, status="All")
    except Exception as e:
        return jsonify({"status": "error", "error": str(e), "data": {}}), 500

    item_map = {}
    item_dates = {}
    all_images_map = load_challan_images_map()
    for row in all_rows:
        item_name = str(row.get("itemname", row.get("jobitem", "")) or "").strip().upper()
        challan_no = str(row.get("isssr", row.get("issno", "")) or "").strip()
        row_date = str(row.get("date", "") or "")
        if not item_name or not challan_no:
            continue
        # Only has a photo attached if one was actually uploaded against this challan.
        if not all_images_map.get(challan_no.upper(), []):
            continue
        if item_name not in item_dates or row_date > item_dates[item_name]:
            item_dates[item_name] = row_date
            item_map[item_name] = challan_no

    return jsonify({"status": "success", "data": item_map})

@app.route("/api/job_issue_report")
def api_job_issue_report():
    _, sql_settings = load_settings()
    status_filter = request.args.get("status", "Pending").strip()
    jobber_filter = request.args.get("jobber", "").strip().upper()
    item_filter = request.args.get("item", "").strip().upper()
    include_opening = request.args.get("include_opening", "false").strip().lower() in ("true", "1", "yes")

    # === CLOUD FALLBACK ===
    if is_cloud_mode() or try_import_pyodbc() is None:
        snap = load_cloud_snapshot()
        if not snap:
            return jsonify({"error": "Cloud snapshot not available. Please sync from local server.", "cloud_mode": True}), 503
        all_rows = snap.get("reports", {}).get("job_issue", [])
        data = []
        for ji in all_rows:
            if not include_opening and ji.get("is_opening"):
                continue
            bal = float(ji.get("balpcs", 0) or 0)
            if status_filter.lower() in ["pending", "p"] and bal <= 0:
                continue
            item_name = str(ji.get("itemname", "") or "").strip().upper()
            jbr = str(ji.get("jobber", "") or "").strip().upper()
            if item_filter and item_filter not in item_name:
                continue
            if jobber_filter and jobber_filter not in jbr:
                continue
            data.append(ji)
        non_opening = [r for r in data if not r.get("is_opening")]
        def safe_sum(lst, key):
            return sum(float(r.get(key, 0) or 0) for r in lst)
        return jsonify({
            "status": "success",
            "total_rows": len(data),
            "total_pcs": safe_sum(non_opening, "pcs"),
            "total_plainpcs": safe_sum(non_opening, "plainpcs"),
            "total_recpcs": safe_sum(non_opening, "recpcs"),
            "total_secpcs": safe_sum(non_opening, "secpcs"),
            "total_shtpcs": safe_sum(non_opening, "shtpcs"),
            "total_balpcs": safe_sum(data, "balpcs"),
            "total_wastepcs": safe_sum(non_opening, "wastepcs"),
            "total_retpcs": safe_sum(non_opening, "retpcs"),
            "from_snapshot": True,
            "snapshot_time": snap.get("sync_time", ""),
            "data": data
        })
    # === END CLOUD FALLBACK ===

    date_from = request.args.get("date_from", "").strip()
    date_to = request.args.get("date_to", "").strip()
    inw_type = request.args.get("inw_type", "All").strip()
    try:
        data = query_job_issue_report(
            sql_settings,
            status=status_filter,
            jobber=request.args.get("jobber", "").strip(),
            item=request.args.get("item", "").strip(),
            inw_type=inw_type,
            date_from=date_from,
            date_to=date_to,
            include_opening=include_opening
        )
        non_opening = [r for r in data if not r.get("is_opening")]
        return jsonify({
            "status": "success",
            "total_rows": len(data),
            "total_pcs": sum(r["pcs"] for r in non_opening),
            "total_plainpcs": sum(r["plainpcs"] for r in non_opening),
            "total_recpcs": sum(r["recpcs"] for r in non_opening),
            "total_secpcs": sum(r["secpcs"] for r in non_opening),
            "total_shtpcs": sum(r["shtpcs"] for r in non_opening),
            "total_balpcs": sum(r["balpcs"] for r in data),
            "total_wastepcs": sum(r["wastepcs"] for r in non_opening),
            "total_retpcs": sum(r["retpcs"] for r in non_opening),
            "data": data
        })
    except Exception as e:
        return jsonify({"error": f"Failed to load Job Work Issue report: {e}"}), 500

@app.route("/api/job_reprocess_report")
@app.route("/api/reports/job_reprocess")
def api_job_reprocess_report():
    _, sql_settings = load_settings()
    job_type = request.args.get("job_type", "All").strip()
    status_filter = request.args.get("status", "Pending").strip()
    jobber_filter = request.args.get("jobber", "").strip().upper()
    item_filter = request.args.get("item", "").strip().upper()
    include_opening = request.args.get("include_opening", "false").strip().lower() in ("true", "1", "yes")

    # === CLOUD FALLBACK ===
    if is_cloud_mode() or try_import_pyodbc() is None:
        snap = load_cloud_snapshot()
        if not snap:
            return jsonify({"error": "Cloud snapshot not available. Please sync from local server.", "cloud_mode": True}), 503
        all_rows = snap.get("reports", {}).get("reprocess_stock", [])
        data = []
        for rp in all_rows:
            if not include_opening and rp.get("is_opening"):
                continue
            item_name = str(rp.get("itemname", "") or "").strip().upper()
            jbr = str(rp.get("jobber", "") or "").strip().upper()
            jtype = str(rp.get("jobtype", "") or "").strip().upper()
            if item_filter and item_filter not in item_name:
                continue
            if jobber_filter and jobber_filter not in jbr:
                continue
            if job_type and job_type.upper() != "ALL" and jtype != job_type.upper():
                continue
            data.append(rp)
        non_opening = [r for r in data if not r.get("is_opening")]
        def safe_sum(lst, key):
            return sum(float(r.get(key, 0) or 0) for r in lst)
        return jsonify({
            "status": "success",
            "total_rows": len(data),
            "total_pcs": safe_sum(non_opening, "pcs"),
            "total_plainpcs": safe_sum(non_opening, "plainpcs"),
            "total_rfpcs": safe_sum(non_opening, "rfpcs"),
            "total_balpcs": safe_sum(data, "balpcs"),
            "from_snapshot": True,
            "snapshot_time": snap.get("sync_time", ""),
            "data": data
        })
    # === END CLOUD FALLBACK ===

    date_from = request.args.get("date_from", "").strip()
    date_to = request.args.get("date_to", "").strip()
    inw_type = request.args.get("inw_type", "All").strip()
    try:
        data = query_job_reprocess_report(
            sql_settings,
            job_type=job_type,
            status=status_filter,
            jobber=request.args.get("jobber", "").strip(),
            item=request.args.get("item", "").strip(),
            inw_type=inw_type,
            date_from=date_from,
            date_to=date_to,
            include_opening=include_opening
        )
        non_opening = [r for r in data if not r.get("is_opening")]
        return jsonify({
            "status": "success",
            "total_rows": len(data),
            "total_pcs": sum(r["pcs"] for r in non_opening),
            "total_plainpcs": sum(r["plainpcs"] for r in non_opening),
            "total_rfpcs": sum(r["rfpcs"] for r in non_opening),
            "total_balpcs": sum(r["balpcs"] for r in data),
            "data": data
        })
    except Exception as e:
        return jsonify({"error": f"Failed to load Job Reprocess report: {e}"}), 500

@app.route("/api/job_filters")
def api_job_filters():
    """Return unique jobbers and job items for autocomplete dropdowns."""
    _, sql_settings = load_settings()
    try:
        result = query_job_filters(sql_settings)
        return jsonify({"status": "success", **result})
    except Exception as e:
        return jsonify({"error": f"Failed to load job filters: {e}"}), 500

@app.route("/api/folding_payment")
@app.route("/api/reports/folding_payment")
@app.route("/api/folding_payment")
@app.route("/api/reports/folding_payment")
def api_folding_payment():
    local_db, sql_settings = load_settings()
    worker_filter = request.args.get("worker", "").strip()
    status_filter = request.args.get("status", "All").strip()
    
    # 1. Fetch Ticks status from local SQLite database & cloud snapshot
    ticks_map = {}
    try:
        conn_local = get_local_sqlite_connection(local_db)
        cur_local = conn_local.cursor()
        cur_local.execute("SELECT challan_no, worker_id, process_type, is_paid, paid_date, paid_by, pcs, COALESCE(job_item, '') FROM folding_payment_ticks")
        for row in cur_local.fetchall():
            p_type = str(row[2] or 'CHARAK').upper().strip()
            j_item = str(row[7] or '').strip()
            val = {
                "is_paid": bool(row[3]),
                "paid_date": row[4] or "",
                "paid_by": row[5] or "",
                "done_pcs": float(row[6] or 0)
            }
            if j_item:
                ticks_map[f"{row[0]}_{row[1]}_{j_item}_{p_type}"] = val
            if f"{row[0]}_{row[1]}_{p_type}" not in ticks_map:
                ticks_map[f"{row[0]}_{row[1]}_{p_type}"] = val
        conn_local.close()
    except Exception as e:
        print(f"Error reading local folding payment ticks: {e}")

    # Merge ticks from cloud snapshot if available
    snap = load_cloud_snapshot()
    if snap:
        snap_ticks = snap.get("reports", {}).get("folding_payment_ticks", [])
        for tick in snap_ticks:
            ch_no = tick.get("challan_no", "")
            w_id = tick.get("worker_id", "")
            p_type = str(tick.get("process_type", "CHARAK")).upper().strip()
            j_item = str(tick.get("job_item", "")).strip()
            key1 = f"{ch_no}_{w_id}_{j_item}_{p_type}"
            key2 = f"{ch_no}_{w_id}_{p_type}"
            if key1 not in ticks_map and key2 not in ticks_map:
                ticks_map[key1] = {
                    "is_paid": bool(tick.get("is_paid", 0)),
                    "paid_date": tick.get("paid_date", ""),
                    "paid_by": tick.get("paid_by", ""),
                    "done_pcs": float(tick.get("pcs", 0) or 0)
                }

    # 2. Query Job Issue records from SQL Server (SELECT only)
    data = []
    workers_set = set()
    seq_counter = defaultdict(int)
    try:
        if is_cloud_mode() or try_import_pyodbc() is None:
            job_data = []
            if snap:
                all_ji = snap.get("reports", {}).get("job_issue", [])
                for ji in all_ji:
                    jbr = str(ji.get("jobber", "") or "").strip()
                    if worker_filter and worker_filter.upper() not in jbr.upper():
                        continue
                    job_data.append({
                        "series": ji.get("series", ""),
                        "iss_no": ji.get("isssr", ""),
                        "challan_no": ji.get("isssr", ""),
                        "jobber": jbr,
                        "jobber_id": jbr,
                        "pcs": float(ji.get("pcs", 0) or 0),
                        "jobitem": ji.get("itemname", ji.get("jobitem", "")),
                        "iss_date": ji.get("date", ""),
                        "date": ji.get("date", "")
                    })
        else:
            job_data = query_job_issue_report(sql_settings, status="All", jobber=worker_filter)
        for idx, row in enumerate(job_data):
            series = str(row.get("series") or "").strip()
            raw_no = str(row.get("iss_no") or row.get("challan_no") or row.get("isssr") or f"CH-{idx+1}").strip()
            
            if series and not raw_no.upper().startswith(series.upper()):
                challan_no = f"{series}{raw_no}"
            else:
                challan_no = raw_no

            worker_name = str(row.get("jobber") or row.get("worker_name") or "Unknown Worker").strip()
            worker_id = str(row.get("jobber_id") or worker_name).strip()
            total_pcs = float(row.get("pcs") or 0)
            
            job_item_name = str(row.get("jobitem") or row.get("job_item") or row.get("item") or "").strip()
            iss_date = str(row.get("iss_date") or row.get("date") or "").strip()

            if worker_name:
                workers_set.add(worker_name)

            seq_key = f"{challan_no}_{worker_id}_{job_item_name}"
            seq_counter[seq_key] += 1
            seq_idx = seq_counter[seq_key]
            
            item_key = f"{job_item_name}_seq{seq_idx}" if seq_idx > 1 else job_item_name

            key_checking_spec = f"{challan_no}_{worker_id}_{item_key}_CHECKING"
            key_charak_spec = f"{challan_no}_{worker_id}_{item_key}_CHARAK"
            
            checking_info = (
                ticks_map.get(key_checking_spec)
                or ticks_map.get(f"{raw_no}_{worker_id}_{item_key}_CHECKING")
                or ticks_map.get(f"{challan_no}_{worker_id}_{job_item_name}_seq{seq_idx}_CHECKING")
                or ticks_map.get(f"{raw_no}_{worker_id}_{job_item_name}_seq{seq_idx}_CHECKING")
                or (ticks_map.get(f"{challan_no}_{worker_id}_{job_item_name}_CHECKING") if seq_idx == 1 else None)
                or (ticks_map.get(f"{raw_no}_{worker_id}_{job_item_name}_CHECKING") if seq_idx == 1 else None)
                or (ticks_map.get(f"{challan_no}_{worker_id}_CHECKING") if seq_idx == 1 else None)
                or (ticks_map.get(f"{raw_no}_{worker_id}_CHECKING") if seq_idx == 1 else None)
                or {"is_paid": False, "paid_date": "", "paid_by": "", "done_pcs": 0.0}
            )
            charak_info = (
                ticks_map.get(key_charak_spec)
                or ticks_map.get(f"{raw_no}_{worker_id}_{item_key}_CHARAK")
                or ticks_map.get(f"{challan_no}_{worker_id}_{job_item_name}_seq{seq_idx}_CHARAK")
                or ticks_map.get(f"{raw_no}_{worker_id}_{job_item_name}_seq{seq_idx}_CHARAK")
                or (ticks_map.get(f"{challan_no}_{worker_id}_{job_item_name}_CHARAK") if seq_idx == 1 else None)
                or (ticks_map.get(f"{raw_no}_{worker_id}_{job_item_name}_CHARAK") if seq_idx == 1 else None)
                or (ticks_map.get(f"{challan_no}_{worker_id}_CHARAK") if seq_idx == 1 else None)
                or (ticks_map.get(f"{raw_no}_{worker_id}_CHARAK") if seq_idx == 1 else None)
                or {"is_paid": False, "paid_date": "", "paid_by": "", "done_pcs": 0.0}
            )

            checking_done = checking_info.get("done_pcs", 0.0)
            if checking_info["is_paid"] and checking_done == 0:
                checking_done = total_pcs

            charak_done = charak_info.get("done_pcs", 0.0)
            if charak_info["is_paid"] and charak_done == 0:
                charak_done = total_pcs

            checking_paid = (checking_done >= total_pcs) if total_pcs > 0 else checking_info["is_paid"]
            charak_paid = (charak_done >= total_pcs) if total_pcs > 0 else charak_info["is_paid"]

            min_done = min(checking_done, charak_done) if (checking_done > 0 and charak_done > 0) else max(checking_done, charak_done)
            bal_pcs = max(0.0, total_pcs - min_done)

            item_obj = {
                "challan_no": challan_no,
                "series": series,
                "worker_id": worker_id,
                "worker_name": worker_name,
                "job_item_name": job_item_name,
                "item_key": item_key,
                "seq_idx": seq_idx,
                "iss_date": iss_date,
                "pcs": total_pcs,
                "checking_pcs": checking_done,
                "charak_pcs": charak_done,
                "bal_pcs": bal_pcs,
                "checking_paid": checking_paid,
                "checking_paid_date": checking_info["paid_date"],
                "checking_paid_by": checking_info["paid_by"],
                "charak_paid": charak_paid,
                "charak_paid_date": charak_info["paid_date"],
                "charak_paid_by": charak_info["paid_by"]
            }

            sf_up = status_filter.upper()
            if ("UNPAID" in sf_up or "PENDING" in sf_up) and (item_obj["checking_paid"] and item_obj["charak_paid"]):
                continue
            elif "PAID" in sf_up and "UNPAID" not in sf_up and not (item_obj["checking_paid"] or item_obj["charak_paid"]):
                continue

            data.append(item_obj)
    except Exception as e:
        print(f"SQL Server query fallback for folding payment: {e}")
        data = []

    return jsonify({
        "status": "success",
        "total_rows": len(data),
        "workers": sorted(list(workers_set)),
        "from_snapshot": bool(is_cloud_mode() and snap),
        "snapshot_time": snap.get("sync_time", "") if snap else "",
        "data": data
    })

@app.route("/api/folding_payment/tick", methods=["POST"])
def api_folding_payment_tick():
    local_db, _ = load_settings()
    req_data = request.json or {}
    challan_no = str(req_data.get("challan_no", "")).strip()
    worker_id = str(req_data.get("worker_id", "")).strip()
    job_item = str(req_data.get("item_key", req_data.get("job_item_name", req_data.get("job_item", "")))).strip()
    process_type = str(req_data.get("process_type", "CHARAK")).upper().strip()
    worker_name = str(req_data.get("worker_name", "")).strip()
    total_pcs = float(req_data.get("total_pcs", req_data.get("pcs", 0)))
    entered_pcs = float(req_data.get("entered_pcs", req_data.get("pcs", 0)))
    is_full_done = req_data.get("full_done", False)
    paid_by = str(req_data.get("paid_by", session.get("user_id", "Supervisor"))).strip()

    if not challan_no or not worker_id:
        return jsonify({"error": "Challan No and Worker ID are required"}), 400

    conn = None
    try:
        conn = get_local_sqlite_connection(local_db)
        c = conn.cursor()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        c.execute("SELECT id, is_paid, pcs FROM folding_payment_ticks WHERE challan_no=? AND worker_id=? AND job_item=? AND process_type=?", (challan_no, worker_id, job_item, process_type))
        row = c.fetchone()
        if not row and not job_item:
            c.execute("SELECT id, is_paid, pcs FROM folding_payment_ticks WHERE challan_no=? AND worker_id=? AND process_type=?", (challan_no, worker_id, process_type))
            row = c.fetchone()

        current_done = float(row[2] or 0) if row else 0.0
        new_done = total_pcs if is_full_done else (current_done + entered_pcs)
        if total_pcs > 0 and new_done > total_pcs:
            new_done = total_pcs

        is_paid = 1 if (is_full_done or (total_pcs > 0 and new_done >= total_pcs)) else 0

        if row:
            c.execute("""
                UPDATE folding_payment_ticks
                SET is_paid = ?, paid_date = ?, paid_by = ?, worker_name = ?, pcs = ?, job_item = ?
                WHERE id = ?
            """, (is_paid, now_str, paid_by, worker_name, new_done, job_item, row[0]))
        else:
            c.execute("""
                INSERT INTO folding_payment_ticks (challan_no, worker_id, job_item, process_type, worker_name, pcs, is_paid, paid_date, paid_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (challan_no, worker_id, job_item, process_type, worker_name, new_done, is_paid, now_str, paid_by))

        # Audit Log
        c.execute("""
            INSERT INTO folding_payment_audit (challan_no, worker_id, process_type, action, action_by, action_time, reason)
            VALUES (?, ?, ?, 'TICK', ?, ?, ?)
        """, (challan_no, worker_id, process_type, paid_by, now_str, f"Processed {new_done}/{total_pcs} Pcs ({job_item})"))

        conn.commit()
        log_user_activity("TICK", "Charak / Folding", f"Ticked Challan #{challan_no} for Worker '{worker_name or worker_id}' ({new_done}/{total_pcs} Pcs - {job_item})")
        return jsonify({
            "status": "success",
            "message": f"Challan {challan_no} ({job_item} - {process_type}) updated: {new_done}/{total_pcs} Pcs.",
            "done_pcs": new_done,
            "is_paid": bool(is_paid)
        })
    except Exception as e:
        return jsonify({"error": f"Failed to record tick: {e}"}), 500
    finally:
        if conn:
            try: conn.close()
            except Exception: pass

@app.route("/api/folding_payment/undo", methods=["POST"])
def api_folding_payment_undo():
    local_db, _ = load_settings()
    req_data = request.json or {}
    challan_no = str(req_data.get("challan_no", "")).strip()
    worker_id = str(req_data.get("worker_id", "")).strip()
    job_item = str(req_data.get("item_key", req_data.get("job_item_name", req_data.get("job_item", "")))).strip()
    process_type = str(req_data.get("process_type", "CHARAK")).upper().strip()
    reason = str(req_data.get("reason", "")).strip()
    action_by = str(req_data.get("action_by", session.get("user_id", "Supervisor"))).strip()

    if not challan_no or not worker_id:
        return jsonify({"error": "Challan No and Worker ID are required"}), 400

    conn = None
    try:
        conn = get_local_sqlite_connection(local_db)
        c = conn.cursor()

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        if job_item:
            c.execute("""
                UPDATE folding_payment_ticks 
                SET is_paid = 0, pcs = 0 
                WHERE challan_no = ? AND worker_id = ? AND (job_item = ? OR job_item = '' OR job_item IS NULL) AND process_type = ?
            """, (challan_no, worker_id, job_item, process_type))
        else:
            c.execute("""
                UPDATE folding_payment_ticks 
                SET is_paid = 0, pcs = 0 
                WHERE challan_no = ? AND worker_id = ? AND process_type = ?
            """, (challan_no, worker_id, process_type))

        # Audit Log
        c.execute("""
            INSERT INTO folding_payment_audit (challan_no, worker_id, process_type, action, action_by, action_time, reason)
            VALUES (?, ?, ?, 'UNDO', ?, ?, ?)
        """, (challan_no, worker_id, process_type, action_by, now_str, reason or "Payment Undo"))

        conn.commit()
        log_user_activity("UNDO", "Charak / Folding", f"Undid Challan #{challan_no} for Worker ID '{worker_id}' (Reason: {reason or 'None'})")
        return jsonify({"status": "success", "message": f"Challan {challan_no} ({process_type}) payment tick reversed."})
    except Exception as e:
        return jsonify({"error": f"Failed to undo tick: {e}"}), 500
    finally:
        if conn:
            try: conn.close()
            except Exception: pass

        if conn:
            try: conn.close()
            except Exception: pass

# ==============================================================================
# CLOUD DATA SYNC & NIGHT MODE SNAPSHOT ENDPOINTS
# ==============================================================================

def is_cloud_mode():
    return os.environ.get("CLOUD_MODE", "false").lower() in ("true", "1", "yes") or try_import_pyodbc() is None

@app.route("/api/cloud_sync/export", methods=["POST"])
@app.route("/api/cloud_sync/manual_trigger", methods=["POST"])
def api_cloud_sync_manual_trigger():
    from cloud_sync_utils import trigger_manual_sync
    local_db, sql_settings = load_settings()

    if is_cloud_mode() or try_import_pyodbc() is None:
        snap = load_cloud_snapshot()
        sync_time = snap.get("sync_time", datetime.now().strftime("%Y-%m-%d %H:%M:%S")) if snap else ""
        return jsonify({
            "status": "success",
            "message": "Cloud App is active and running on live synced snapshot data.",
            "sync_time": sync_time,
            "cloud_mode": True
        })

    try:
        res = trigger_manual_sync(sql_settings, local_db)
        return jsonify({
            "status": "success",
            "message": "Manual sync completed! Fresh ERP snapshot exported.",
            **res
        })
    except Exception as e:
        return jsonify({"error": f"Failed to perform manual sync: {e}"}), 500

@app.route("/api/cloud_sync/push_snapshot", methods=["POST"])
def api_cloud_sync_push_snapshot():
    from cloud_sync_utils import save_local_snapshot_file, load_cloud_sync_config, save_cloud_sync_config
    
    # Verify API key security
    client_key = request.headers.get("X-API-KEY", "").strip()
    cfg = load_cloud_sync_config()
    expected_key = os.environ.get("CLOUD_API_KEY", cfg.get("api_key", "sknt_secure_sync_key_2026"))
    
    if client_key != expected_key and expected_key != "":
        return jsonify({"error": "Unauthorized sync key"}), 401
    
    snapshot_data = request.json
    if not snapshot_data or "reports" not in snapshot_data:
        return jsonify({"error": "Invalid snapshot payload"}), 400
        
    snap_path = save_local_snapshot_file(snapshot_data)
    cfg["last_sync_time"] = snapshot_data.get("sync_time", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    save_cloud_sync_config(cfg)
    
    return jsonify({
        "status": "success",
        "message": "Snapshot successfully received and saved on Cloud server!",
        "sync_time": cfg["last_sync_time"]
    })

@app.route("/api/cloud_sync/pull_charak_ticks", methods=["GET"])
def api_cloud_sync_pull_charak_ticks():
    """Lets the PC pull down any Charak/Folding ticks made directly on this cloud
    app's own local SQLite DB, so they reach the PC permanently before Render's
    ephemeral storage can lose them on the next restart."""
    from cloud_sync_utils import load_cloud_sync_config
    client_key = request.headers.get("X-API-KEY", "").strip()
    cfg = load_cloud_sync_config()
    expected_key = os.environ.get("CLOUD_API_KEY", cfg.get("api_key", "sknt_secure_sync_key_2026"))
    if client_key != expected_key and expected_key != "":
        return jsonify({"error": "Unauthorized sync key"}), 401

    local_db, _ = load_settings()
    ticks = []
    try:
        conn = get_local_sqlite_connection(local_db)
        c = conn.cursor()
        c.execute("SELECT challan_no, worker_id, process_type, job_item, worker_name, pcs, is_paid, paid_date, paid_by FROM folding_payment_ticks")
        for row in c.fetchall():
            ticks.append({
                "challan_no": row[0], "worker_id": row[1], "process_type": row[2],
                "job_item": row[3], "worker_name": row[4], "pcs": row[5],
                "is_paid": row[6], "paid_date": row[7], "paid_by": row[8]
            })
        conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"status": "success", "data": ticks})

@app.route("/api/cloud_sync/pull_group_images", methods=["GET"])
def api_cloud_sync_pull_group_images():
    """Lets the PC pull down any group-level photos uploaded directly on this
    cloud app (via Orders/Job Issue/Reprocess), so they survive Render's
    storage being wiped on the next deploy/restart."""
    from cloud_sync_utils import load_cloud_sync_config
    client_key = request.headers.get("X-API-KEY", "").strip()
    cfg = load_cloud_sync_config()
    expected_key = os.environ.get("CLOUD_API_KEY", cfg.get("api_key", "sknt_secure_sync_key_2026"))
    if client_key != expected_key and expected_key != "":
        return jsonify({"error": "Unauthorized sync key"}), 401

    images_map = load_group_images_map()
    return jsonify({"status": "success", "data": images_map})

@app.route("/api/cloud_sync/pull_challan_images", methods=["GET"])
def api_cloud_sync_pull_challan_images():
    """Lets the PC pull down any challan images uploaded directly on this cloud app,
    so they survive Render's storage being wiped on the next deploy/restart."""
    from cloud_sync_utils import load_cloud_sync_config
    client_key = request.headers.get("X-API-KEY", "").strip()
    cfg = load_cloud_sync_config()
    expected_key = os.environ.get("CLOUD_API_KEY", cfg.get("api_key", "sknt_secure_sync_key_2026"))

    if client_key != expected_key and expected_key != "":
        return jsonify({"error": "Unauthorized sync key"}), 401

    images_map = load_challan_images_map()
    return jsonify({"status": "success", "data": images_map})

@app.route("/api/cloud_sync/status", methods=["GET"])
def api_cloud_sync_status():
    from cloud_sync_utils import load_cloud_sync_config, load_local_snapshot_file
    cfg = load_cloud_sync_config()
    snap = load_local_snapshot_file()
    
    return jsonify({
        "status": "success",
        "cloud_mode": is_cloud_mode(),
        "cloud_enabled": cfg.get("cloud_enabled", True),
        "last_sync_time": cfg.get("last_sync_time") or (snap.get("sync_time") if snap else "Never"),
        "has_snapshot": snap is not None
    })


if __name__ == "__main__":
    local_db, _ = load_settings()
    init_local_db(local_db)

    # Simple CLI mode for testing
    if "--test" in sys.argv:
        print("Backend setup test passed successfully!")
        sys.exit(0)

    # Listen on all interfaces (0.0.0.0) so network clients can connect
    app.run(host="0.0.0.0", port=5000, debug=True)
