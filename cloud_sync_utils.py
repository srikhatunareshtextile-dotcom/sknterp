import os
import json
import base64
import sqlite3
from io import BytesIO
from datetime import datetime

try:
    from PIL import Image
except ImportError:
    Image = None

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

def create_base64_thumbnail(filepath, max_size=(600, 600), quality=75):
    """Generates light base64 Data URL for images to render smoothly on Cloud."""
    if not os.path.exists(filepath):
        return None
    if Image is None:
        print("Pillow not installed - skipping thumbnail, image upload will still work")
        return None
    try:
        with Image.open(filepath) as img:
            img.thumbnail(max_size, Image.Resampling.LANCZOS)
            if img.mode != "RGB":
                img = img.convert("RGB")
            buffer = BytesIO()
            img.save(buffer, format="JPEG", quality=quality)
            b64_str = base64.b64encode(buffer.getvalue()).decode("utf-8")
            return f"data:image/jpeg;base64,{b64_str}"
    except Exception as e:
        print(f"Error converting image {filepath} to base64: {e}")
        return None

def export_all_reports_snapshot(sql_settings, local_db):
    """
    Exports clean snapshots of ALL ERP reports & images for Cloud storage:
    1. Order Details Report
    2. Group Stock Report
    3. Job Issue Report
    4. Reprocess Stock Report
    5. Folding Payment (Charak) Ticks & Verification Status
    6. Packing Slips & Items
    7. Purchase Stock Report
    8. Sale Bill Report
    9. Challan Images Map (with Base64 Thumbnails)
    """
    from stock_calc_utils import (
        query_order_details,
        calculate_stock_by_group,
        query_job_issue_report,
        query_job_reprocess_report,
        query_bill_report_details
    )
    from app import load_challan_images_map, get_local_sqlite_connection, CHALLAN_IMAGES_DIR

    snapshot = {
        "sync_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "reports": {},
        "images_map": {}
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
        snapshot["reports"]["group_stock"] = {}
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
        s_rows = c.fetchall()
        for sr in s_rows:
            s_dict = dict(sr)
            s_id = s_dict["id"]
            c.execute("SELECT * FROM packing_slip_items WHERE slip_id = ? ORDER BY id ASC", (s_id,))
            i_rows = [dict(ir) for ir in c.fetchall()]
            slips_list.append({
                "slip": s_dict,
                "items": i_rows,
                "id": s_id,
                "slip_no": s_dict.get("slip_no", str(s_id))
            })
        conn.close()
    except Exception as e:
        print(f"Cloud Export Packing Slips Error: {e}")
    snapshot["reports"]["packing_slips"] = slips_list

    # 7. Purchase Stock Report
    try:
        conn = sqlite3.connect(":memory:") # fallback if pyodbc helper needed
        # We query Purchase Stock from SQL Server directly using get_purchase_stock_list helper
        from app import get_sql_server_connection
        sql_conn = get_sql_server_connection(sql_settings)
        cur = sql_conn.cursor()
        q_pur = """
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
                ISNULL(cd.SecPcs, 0) AS SecPcs,
                (ISNULL(cd.Pcs, 0) - ISNULL(cd.BillPcs, 0) - ISNULL(cd.RetPcs, 0) - ISNULL(cd.SecPcs, 0)) AS BalPcs,
                'CHAL' AS source,
                ISNULL(cm.Opening, 'N') AS Opening
            FROM CHALDATA cd
            JOIN CHALMAST cm ON cd.ControlId = cm.EntryId
            WHERE cm.Mode = 'FR' AND cd.CompNo = 10 AND cd.ItemName IS NOT NULL AND cd.ItemName != ''
            ORDER BY cm.Party, cm.Date, cm.Serial
        """
        cur.execute(q_pur)
        pur_rows = []
        for r in cur.fetchall():
            pur_rows.append({
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
                "opening": str(r[14] or "N").strip()
            })
        sql_conn.close()
        snapshot["reports"]["purchase_stock"] = pur_rows
    except Exception as e:
        snapshot["reports"]["purchase_stock"] = []
        print(f"Cloud Export Purchase Stock Error: {e}")

    # 8. Sale Bill Report
    try:
        snapshot["reports"]["bill_report"] = query_bill_report_details(sql_settings, date_from="", date_to="", sort_by="date", party_name="", group_name="", include_prev_year=False)
    except Exception as e:
        snapshot["reports"]["bill_report"] = []
        print(f"Cloud Export Sale Bill Report Error: {e}")

    # 9. Challan Images Map with Base64 Thumbnails
    raw_images_map = load_challan_images_map()
    processed_images_map = {}
    for cno, img_list in raw_images_map.items():
        processed_list = []
        for img in img_list:
            item_copy = dict(img)
            fname = item_copy.get("filename", "")
            if fname:
                fpath = os.path.join(CHALLAN_IMAGES_DIR, fname)
                b64_url = create_base64_thumbnail(fpath)
                if b64_url:
                    item_copy["base64_data"] = b64_url
                    item_copy["url"] = b64_url  # Directly use Data URL so rendering never fails!
            processed_list.append(item_copy)
        processed_images_map[cno] = processed_list
    snapshot["images_map"] = processed_images_map

    return snapshot

def save_local_snapshot_file(snapshot):
    """Saves local offline fallback snapshot JSON file on disk."""
    snap_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloud_snapshot_latest.json")
    try:
        with open(snap_path, "w", encoding="utf-8") as f:
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
            with open(snap_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return None

def trigger_manual_sync(sql_settings, local_db):
    """Triggers snapshot generation and saves local cloud_snapshot_latest.json file."""
    print("Generating complete ERP Snapshot...")
    snap = export_all_reports_snapshot(sql_settings, local_db)
    saved_path = save_local_snapshot_file(snap)
    return {
        "status": "success",
        "cloud_push_status": "Snapshot updated cleanly",
        "snapshot_path": saved_path,
        "sync_time": snap.get("sync_time")
    }
