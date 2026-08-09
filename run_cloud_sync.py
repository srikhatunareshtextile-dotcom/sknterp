import os
import sys
import time
import json
from datetime import datetime

# Ensure python can locate modules in mobile_app folder
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cloud_sync_utils import trigger_manual_sync, load_cloud_sync_config
from app import load_settings

def main():
    print("==================================================")
    print("   SRI KHATU NARESH ERP - AUTOMATED CLOUD SYNC    ")
    print("==================================================")
    print("Starting background Cloud Data Sync service...")

    while True:
        try:
            cfg = load_cloud_sync_config()
            interval_mins = cfg.get("auto_sync_interval_mins", 30)
            if interval_mins < 5:
                interval_mins = 5

            if cfg.get("cloud_enabled", True):
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Generating & Syncing ERP snapshot...")
                local_db, sql_settings = load_settings()
                res = trigger_manual_sync(sql_settings, local_db)
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Sync Result: {res.get('cloud_push_status')}")
            else:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Cloud Sync is disabled in configuration.")

            # Sleep for configured interval
            time.sleep(interval_mins * 60)
        except Exception as e:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Cloud sync loop error: {e}")
            time.sleep(300) # retry after 5 mins on error

if __name__ == "__main__":
    main()
