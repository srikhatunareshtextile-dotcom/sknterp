import os
import json
import sqlite3
import requests
from datetime import datetime
from collections import defaultdict

CLOUD_SYNC_CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloud_sync_config.json")

def load_cloud_sync_config():
    if os.path.exists(CLOUD_SYNC_CONFIG_FILE):
        try:
            with open(CLOUD_SYNC_CONFIG_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "cloud_enabled": True,
        "cloud_url": "",
        "api_key": "",
        "last_sync_time": "",
        "auto_sync_interval_mins": 30
    }

def save_cloud_sync_config(cfg):
    try:
        with open(CLOUD_SYNC_CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        print(f"Error saving cloud sync config: {e}")

import base64

def export_all_reports_snapshot(sql_settings, local_db):
    """
    Exports clean snapshots of all main ERP reports for Cloud storage:
    1. Order Details Report
    2. Group Stock Report
    3. Job Issue Report
    4. Reprocess Stock Report
    5. Folding Payment (Charak) Ticks & Verification Status
    6. Packing Slips & Slip Items
    7. Base64 Encoded Challan Images Map
    """
    from stock_calc_utils import (
        query_order_details,
        calculate_stock_by_group,
        query_job_issue_report,
        query_job_reprocess_report
    )
    from app import load_challan_images_map, get_local_sqlite_connection

    # Convert Challan Images to base64 Data URIs so images render natively on Cloud!
    raw_images_map = load_challan_images_map()
    b64_images_map = {}
    base_dir = os.path.dirname(os.path.abspath(__file__))
    for challan_no, img_list in raw_images_map.items():
        b64_list = []
        for img in img_list:
            img_item = dict(img)
            url = img_item.get("url", "")
            if url and not url.startswith("data:image"):
                rel_p = url.lstrip("/")
                full_p = os.path.join(base_dir, rel_p)
                if os.path.exists(full_p):
                    try:
                        with open(full_p, "rb") as f:
                            b64_data = base64.b64encode(f.read()).decode("utf-8")
                            ext = os.path.splitext(full_p)[1].lower().lstrip(".") or "jpeg"
                            if ext == "jpg": ext = "jpeg"
                            img_item["url"] = f"data:image/{ext};base64,{b64_data}"
                    except Exception as ex:
                        print(f"Error encoding image {full_p}: {ex}")
            b64_list.append(img_item)
        b64_images_map[challan_no] = b64_list

    snapshot = {
        "sync_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "reports": {},
        "images_map": b64_images_map
    }

    # 1. Order Details
    try:
        snapshot["reports"]["order_details"] = query_order_details(sql_settings, "Pending", "date_desc", "", "")
    except Exception as e:
        snapshot["reports"]["order_details"] = []
        print(f"Cloud Export Order Details Error: {e}")

    # 2. Group Stock Summary
    try:
        stock_data = calculate_stock_by_group(sql_settings)
        snapshot["reports"]["group_stock"] = stock_data
    except Exception as e:
        snapshot["reports"]["group_stock"] = []
        print(f"Cloud Export Group Stock Error: {e}")

    # 3. Job Work Issue Report
    try:
        snapshot["reports"]["job_issue"] = query_job_issue_report(sql_settings, status="All")
    except Exception as e:
        snapshot["reports"]["job_issue"] = []
        print(f"Cloud Export Job Issue Error: {e}")

    # 4. Reprocess Stock Report
    try:
        snapshot["reports"]["reprocess_stock"] = query_job_reprocess_report(sql_settings, status="All")
    except Exception as e:
        snapshot["reports"]["reprocess_stock"] = []
        print(f"Cloud Export Reprocess Stock Error: {e}")

    # 5. Folding Payment Ticks
    ticks_data = []
    try:
        conn = get_local_sqlite_connection(local_db)
        c = conn.cursor()
        c.execute("""
            SELECT challan_no, worker_id, process_type, job_item, worker_name, pcs, is_paid, paid_date, paid_by 
            FROM folding_payment_ticks
        """)
        for r in c.fetchall():
            ticks_data.append({
                "challan_no": r[0],
                "worker_id": r[1],
                "process_type": r[2],
                "job_item": r[3] or "",
                "worker_name": r[4] or "",
                "pcs": float(r[5] or 0),
                "is_paid": bool(r[6]),
                "paid_date": r[7] or "",
                "paid_by": r[8] or ""
            })
        conn.close()
    except Exception as e:
        print(f"Cloud Export Folding Payment Ticks Error: {e}")

    snapshot["reports"]["folding_payment_ticks"] = ticks_data

    # 6. Packing Slips & Items
    slips_list = []
    try:
        conn = get_local_sqlite_connection(local_db)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute("SELECT * FROM packing_slips ORDER BY id DESC")
        for s in c.fetchall():
            s_dict = dict(s)
            c2 = conn.cursor()
            c2.execute("SELECT * FROM packing_slip_items WHERE slip_id = ?", (s_dict["id"],))
            s_dict["items"] = [dict(it) for it in c2.fetchall()]
            slips_list.append(s_dict)
        conn.close()
    except Exception as e:
        print(f"Cloud Export Packing Slips Error: {e}")

    snapshot["reports"]["packing_slips"] = slips_list
    return snapshot


def save_local_snapshot_file(snapshot):
    """Saves local offline fallback snapshot JSON file on disk."""
    snap_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloud_snapshot_latest.json")
    try:
        with open(snap_path, "w") as f:
            json.dump(snapshot, f, indent=2)
        print(f"Local snapshot file saved cleanly: {snap_path}")
        return snap_path
    except Exception as e:
        print(f"Error writing local snapshot file: {e}")
        return None

def load_local_snapshot_file():
    snap_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloud_snapshot_latest.json")
    if os.path.exists(snap_path):
        try:
            with open(snap_path, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return None

def pull_overnight_cloud_updates(local_db, cloud_ticks_data=None):
    """
    Pulls overnight ticks, payment verifications, and image attachments created on Cloud App
    back into the local SQLite database when the Office PC powers ON.
    """
    from app import get_local_sqlite_connection
    if not cloud_ticks_data:
        return 0

    pulled_count = 0
    try:
        conn = get_local_sqlite_connection(local_db)
        c = conn.cursor()
        for t in cloud_ticks_data:
            c.execute("""
                SELECT id FROM folding_payment_ticks 
                WHERE challan_no=? AND worker_id=? AND (job_item=? OR job_item='') AND process_type=?
            """, (t["challan_no"], t["worker_id"], t.get("job_item", ""), t["process_type"]))
            row = c.fetchone()
            if row:
                c.execute("""
                    UPDATE folding_payment_ticks 
                    SET is_paid=?, paid_date=?, paid_by=?, worker_name=?, pcs=?, job_item=?
                    WHERE id=?
                """, (1 if t["is_paid"] else 0, t["paid_date"], t["paid_by"], t["worker_name"], t["pcs"], t.get("job_item", ""), row[0]))
            else:
                c.execute("""
                    INSERT INTO folding_payment_ticks (challan_no, worker_id, process_type, job_item, worker_name, pcs, is_paid, paid_date, paid_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (t["challan_no"], t["worker_id"], t["process_type"], t.get("job_item", ""), t["worker_name"], t["pcs"], 1 if t["is_paid"] else 0, t["paid_date"], t["paid_by"]))
            pulled_count += 1
        conn.commit()
        conn.close()
        print(f"Pulled {pulled_count} overnight ticks into local SQLite database.")
    except Exception as e:
        print(f"Error pulling overnight cloud updates: {e}")

    return pulled_count

def push_snapshot_to_cloud(snapshot):
    """Pushes local snapshot payload to configured Cloud endpoint if cloud_url is set."""
    cfg = load_cloud_sync_config()
    if not cfg.get("cloud_enabled"):
        print("Cloud sync is disabled in config.")
        return False, "Cloud sync disabled"
    
    cloud_url = cfg.get("cloud_url", "").strip().rstrip("/")
    if not cloud_url:
        print("No cloud_url set in config. Saved locally only.")
        return True, "Saved locally (Cloud URL not set)"

    api_key = cfg.get("api_key", "sknt_secure_sync_key_2026")
    target_endpoint = f"{cloud_url}/api/cloud_sync/push_snapshot"

    try:
        headers = {
            "Content-Type": "application/json",
            "X-API-KEY": api_key
        }
        res = requests.post(target_endpoint, json=snapshot, headers=headers, timeout=30)
        if res.status_code == 200:
            print(f"Successfully pushed snapshot to Cloud ({cloud_url}).")
            return True, "Pushed to Cloud successfully"
        else:
            print(f"Cloud push returned status {res.status_code}: {res.text}")
            return False, f"Cloud HTTP {res.status_code}"
    except Exception as e:
        print(f"Error pushing snapshot to cloud: {e}")
        return False, f"Network error: {str(e)}"

def trigger_manual_sync(sql_settings, local_db):
    """Triggers an immediate snapshot export, saves locally, and pushes to Cloud."""
    snapshot = export_all_reports_snapshot(sql_settings, local_db)
    save_local_snapshot_file(snapshot)
    
    cfg = load_cloud_sync_config()
    cfg["last_sync_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    save_cloud_sync_config(cfg)
    
    success, msg = push_snapshot_to_cloud(snapshot)
    return {
        "success": True,
        "sync_time": cfg["last_sync_time"],
        "cloud_push_status": msg,
        "reports_synced": list(snapshot.get("reports", {}).keys())
    }

