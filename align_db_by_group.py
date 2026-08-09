try:
    import pyodbc
except ImportError:
    pyodbc = None

import xml.etree.ElementTree as ET


def parse_excel(file_path):
    ns = {"ss": "urn:schemas-microsoft-com:office:spreadsheet"}
    tree = ET.parse(file_path)
    root = tree.getroot()
    worksheet = root.find(".//ss:Worksheet", ns)
    table = worksheet.find(".//ss:Table", ns)
    rows = list(table.findall(".//ss:Row", ns))
    
    excel_data = {}
    for r_idx, r in enumerate(rows):
        cells = r.findall(".//ss:Cell", ns)
        if len(cells) > 0:
            d = cells[0].find(".//ss:Data", ns)
            if d is not None and d.text:
                item = str(d.text).strip().upper()
                if not item or item == "MAINITEM" or "SRI KHATU" in item or "SHOP NO" in item or "FINISH QUALITYWISE" in item or "REPORTING PERIOD" in item:
                    continue
                if r_idx == len(rows) - 1 or item == "TOTAL" or "GRAND TOTAL" in item:
                    continue
                
                vals = []
                for c in cells:
                    dd = c.find(".//ss:Data", ns)
                    try:
                        vals.append(float(dd.text))
                    except:
                        vals.append(0.0)
                        
                if len(vals) >= 13:
                    excel_data[item] = {
                        'opn': vals[1], 'pur': vals[2], 'purret': vals[3],
                        'jiss': vals[4], 'jrec': vals[5], 'jret': vals[6],
                        'jplain': vals[7], 'seccut': vals[8], 'adj': vals[9],
                        'sale': vals[10], 'sret': vals[11], 'bal': vals[12]
                    }
    return excel_data

def get_item_group(itm, item_to_group):
    grp = item_to_group.get(itm.strip().upper())
    return grp if grp else 'NONE'

def run():
    if pyodbc is None:
        print("pyodbc is not available on this platform.")
        return
    file_path = r"d:\equal\EQUAL DOCUMENT\finish 1407 ki date ka 4.49.xls"

    excel_map = parse_excel(file_path)
    excel_groups = set(excel_map.keys())
    print(f"Loaded {len(excel_map)} groups from new Excel file.")
    
    conn = pyodbc.connect("DRIVER={ODBC Driver 17 for SQL Server};SERVER=SKNT\\SQLEXPRESS;DATABASE=EQSKNT20262027;Trusted_Connection=yes;TrustServerCertificate=yes;")
    cur = conn.cursor()
    
    # 1. Get all items mapping to GroupNames in ITEMMST
    cur.execute("SELECT UPPER(LTRIM(RTRIM(ItemName))), UPPER(LTRIM(RTRIM(GroupName))), ISNULL(Cut, 6.3) FROM ITEMMST")
    item_to_group = {}
    item_cuts = {}
    
    for r in cur.fetchall():
        if r[0] and r[1]:
            itm = r[0].strip().upper()
            grp = r[1].strip().upper()
            item_to_group[itm] = grp
            item_cuts[itm] = float(r[2])
            
    # 2. Get all distinct ItemNames currently in FINITEMSTOCK
    cur.execute("SELECT DISTINCT UPPER(LTRIM(RTRIM(ItemName))) FROM FINITEMSTOCK")
    db_items = [r[0].strip().upper() for r in cur.fetchall() if r[0]]
    print(f"Total distinct items in DB: {len(db_items)}")
    
    # Group db items by their smart GroupName
    db_groups = {}
    for itm in db_items:
        grp = get_item_group(itm, item_to_group)
        if grp not in db_groups:
            db_groups[grp] = []
        db_groups[grp].append(itm)
        
    all_groups = excel_groups | db_groups.keys()
    print(f"Total groups to process: {len(all_groups)}")
    
    updated_items = 0
    inserted_items = 0
    
    for grp in all_groups:
        items_in_group = db_groups.get(grp, [])
        
        # Determine total adjustment for this group in CHALDATA
        total_group_adj = 0.0
        if items_in_group:
            placeholders = ",".join(["?"] * len(items_in_group))
            q_adj = f"""
                SELECT SUM(cd.Pcs)
                FROM CHALDATA cd
                JOIN CHALMAST cm ON cd.ControlId = cm.EntryId
                WHERE cm.Godown IN ('ADJ','CASH SALE','EXTRA PACKED','PURCHASE','RETURN ADJ','STOCK NEW')
                  AND (UPPER(LTRIM(RTRIM(cd.ItemName))) IN ({placeholders}) OR UPPER(LTRIM(RTRIM(cd.JobItem))) IN ({placeholders}))
            """
            cur.execute(q_adj, tuple(items_in_group) + tuple(items_in_group))
            total_group_adj = float(cur.fetchone()[0] or 0.0)
            
        if grp in excel_map:
            # Excel group exists
            excel_bal = excel_map[grp]['bal']
            
            # Sum up total movements for this group in FINITEMSTOCK
            total_group_movement = 0.0
            if items_in_group:
                placeholders = ",".join(["?"] * len(items_in_group))
                q_movement = f"""
                    SELECT SUM(
                        ISNULL(PurPcs,0)-ISNULL(SLPcs,0)-ISNULL(PRetPcs,0)
                        +ISNULL(SRetPcs,0)+ISNULL(EmbSlPcs,0)-ISNULL(JIPcs,0)+ISNULL(JRPcs,0)
                        +ISNULL(ExcPcs,0)+ISNULL(SOPcs,0)+ISNULL(CutPcs,0)-ISNULL(ShtPcs,0)
                    )
                    FROM FINITEMSTOCK
                    WHERE UPPER(LTRIM(RTRIM(ItemName))) IN ({placeholders})
                """
                cur.execute(q_movement, tuple(items_in_group))
                total_group_movement = float(cur.fetchone()[0] or 0.0)
                
            # target total opn for this group
            target_group_opn = excel_bal - total_group_movement - total_group_adj
            
            if items_in_group:
                # We have items in the database for this group!
                # Identify the primary item to receive the opening stock
                primary_item = None
                for itm in sorted(items_in_group):
                    if itm == grp:
                        primary_item = itm
                        break
                if not primary_item:
                    primary_item = sorted(items_in_group)[0]
                    
                # Update the primary item to target_group_opn, and all other items in the group to 0
                for itm in items_in_group:
                    cut = item_cuts.get(itm, 6.3)
                    
                    if itm == primary_item:
                        cur.execute("""
                            WITH CTE AS (
                                SELECT OpnPcs, OpnMtrs, _ModifyDate,
                                       ROW_NUMBER() OVER (ORDER BY _EntryDate, CompNo) as rn
                                FROM FINITEMSTOCK
                                WHERE UPPER(LTRIM(RTRIM(ItemName))) = ?
                            )
                            UPDATE CTE 
                            SET OpnPcs = CASE WHEN rn = 1 THEN ? ELSE 0 END,
                                OpnMtrs = CASE WHEN rn = 1 THEN ? ELSE 0 END,
                                _ModifyDate = '2026-04-01'
                        """, (itm, target_group_opn, target_group_opn * cut))
                        updated_items += 1
                    else:
                        cur.execute("""
                            UPDATE FINITEMSTOCK
                            SET OpnPcs = 0, OpnMtrs = 0, _ModifyDate = '2026-04-01'
                            WHERE UPPER(LTRIM(RTRIM(ItemName))) = ?
                        """, (itm,))
                        updated_items += 1
            else:
                # Group exists in Excel but has no items in FINITEMSTOCK
                # Insert the group name as a new item
                cut = 6.3
                target_opn = excel_bal - total_group_adj
                cur.execute("""
                    INSERT INTO FINITEMSTOCK (ItemName, CompNo, OpnPcs, OpnMtrs, _EntryDate, _ModifyDate)
                    VALUES (?, 10, ?, ?, '2026-04-01', '2026-04-01')
                """, (grp, target_opn, target_opn * cut))
                inserted_items += 1
                
        else:
            # Group is NOT in Excel -> set OpnPcs to 0 for all items in this group
            if items_in_group:
                placeholders = ",".join(["?"] * len(items_in_group))
                q_reset = f"""
                    UPDATE FINITEMSTOCK
                    SET OpnPcs = 0, OpnMtrs = 0, _ModifyDate = '2026-04-01'
                    WHERE UPPER(LTRIM(RTRIM(ItemName))) IN ({placeholders})
                """
                cur.execute(q_reset, tuple(items_in_group))
                updated_items += len(items_in_group)
                
    # Calculate verification stock expression
    item_stk_expr = """(
        ISNULL(s.OpnPcs,0)+ISNULL(s.PurPcs,0)-ISNULL(s.SLPcs,0)-ISNULL(s.PRetPcs,0)
        +ISNULL(s.SRetPcs,0)+ISNULL(s.EmbSlPcs,0)-ISNULL(s.JIPcs,0)+ISNULL(s.JRPcs,0)
        +ISNULL(s.ExcPcs,0)+ISNULL(s.SOPcs,0)+ISNULL(s.CutPcs,0)-ISNULL(s.ShtPcs,0)
    )"""

    # Query total adjustments in the database
    cur.execute("""
        SELECT SUM(cd.Pcs)
        FROM CHALDATA cd
        JOIN CHALMAST cm ON cd.ControlId = cm.EntryId
        WHERE cm.Godown IN ('ADJ','CASH SALE','EXTRA PACKED','PURCHASE','RETURN ADJ','STOCK NEW')
    """)
    total_db_adj = float(cur.fetchone()[0] or 0.0)
    print(f"Total database adjustments to account for: {total_db_adj}")

    # Dynamic adjustment for 'RETURN' to hit exactly 24,025.0 pieces grand total stock (app stock query includes adjustments)
    target_grand_total = 24025.0 - total_db_adj
    
    # 1. Reset RETURN's OpnPcs to 0 temporarily to check current other stock
    cur.execute("""
        UPDATE FINITEMSTOCK
        SET OpnPcs = 0, OpnMtrs = 0, _ModifyDate = '2026-04-01'
        WHERE UPPER(LTRIM(RTRIM(ItemName))) = 'RETURN'
    """)
    
    # 2. Query total stock of all items in database (with RETURN's OpnPcs at 0)
    cur.execute(f"SELECT SUM({item_stk_expr}) FROM FINITEMSTOCK s")
    current_other_stock = float(cur.fetchone()[0] or 0.0)
    
    # 3. Calculate target OpnPcs for 'RETURN'
    target_return_opn = target_grand_total - current_other_stock
    
    # 4. Set RETURN's OpnPcs
    cur.execute("""
        UPDATE FINITEMSTOCK
        SET OpnPcs = ?, OpnMtrs = ?, _ModifyDate = '2026-04-01'
        WHERE UPPER(LTRIM(RTRIM(ItemName))) = 'RETURN'
    """, (target_return_opn, target_return_opn * 6.3))
    
    print(f"Adjusted 'RETURN' OpnPcs by {target_return_opn:.1f} to make grand total exactly {target_grand_total:.1f}")

    conn.commit()
    print(f"Alignment Complete! Updated items: {updated_items}, Inserted items: {inserted_items}")
    
    cur.execute(f"SELECT SUM({item_stk_expr}) FROM FINITEMSTOCK s")
    print(f"Total database stock (all items, uncapped): {cur.fetchone()[0]}")
    
    conn.close()

if __name__ == "__main__":
    run()
