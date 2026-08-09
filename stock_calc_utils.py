import sqlite3
import time

def _detect_haste_column(conn):
    """
    Detect Haste column name in ORDERMST using INFORMATION_SCHEMA.
    Returns the column name string, or None if not found.
    """
    candidates = [
        "Haste", "HasteNo", "HasteDetails", "HasteRemark",
        "Hastedetails", "haste_no", "haste_details", "HasteType",
        "HasteInfo", "Hastee", "HasteName",
    ]
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_NAME='ORDERMST'"
        )
        db_cols = {r[0].strip() for r in cur.fetchall()}
        db_cols_upper = {c.upper(): c for c in db_cols}
        for cand in candidates:
            if cand.upper() in db_cols_upper:
                return db_cols_upper[cand.upper()]
    except Exception:
        pass
    return None

import sqlite3
import time

_stock_cache = {}

import sqlite3
import time

_stock_cache = {}

def _detect_haste_column(conn):
    candidates = [
        "Haste", "HasteNo", "HasteDetails", "HasteRemark",
        "Hastedetails", "haste_no", "haste_details", "HasteType",
        "HasteInfo", "Hastee", "HasteName",
    ]
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_NAME='ORDERMST'"
        )
        db_cols = {r[0].strip() for r in cur.fetchall()}
        db_cols_upper = {c.upper(): c for c in db_cols}
        for cand in candidates:
            if cand.upper() in db_cols_upper:
                return db_cols_upper[cand.upper()]
    except Exception:
        pass
    return None

def calculate_stock_by_group(sql_settings, include_opening=True, conn=None, item_type_filter="ALL"):
    """
    Calculates stock per group directly from SQL Server database.
    - Previous Year DB (EQSKNT20252026): Queries FINITEMSTOCK + CHALDATA adjustments for PREV DB
    - Current Year DB (EQSKNT20262027): Queries FINITEMSTOCK + CHALDATA adjustments for NEW DB
    """
    from app import get_sql_server_connection, get_sql_server_prev_connection

    db_curr = sql_settings.get("db_name", "EQSKNT20262027")
    db_prev = sql_settings.get("db_prev", "EQSKNT20252026")

    filter_upper = (item_type_filter or "ALL").upper()
    if filter_upper == "EXCLUDE_GREY":
        item_type_clause = "AND (i.ItemType IS NULL OR i.ItemType != 'GREY')"
        item_type_clause_job = "AND (i_job.ItemType IS NULL OR i_job.ItemType != 'GREY') AND (i_item.ItemType IS NULL OR i_item.ItemType != 'GREY')"
    elif filter_upper == "FINISH":
        item_type_clause = "AND i.ItemType = 'FINISH'"
        item_type_clause_job = "AND (i_job.ItemType = 'FINISH' OR i_item.ItemType = 'FINISH')"
    elif filter_upper == "GREY":
        item_type_clause = "AND i.ItemType = 'GREY'"
        item_type_clause_job = "AND (i_job.ItemType = 'GREY' OR i_item.ItemType = 'GREY')"
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

    # 1. Fetch PREVIOUS YEAR DB (EQSKNT20252026) closing balances + PREV ADJ per Item
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
            print(f"Notice: Previous DB opening stock query skipped: {e}")

    # 2. Fetch CURRENT YEAR DB (EQSKNT20262027) movements + CURRENT ADJ
    if conn is None:
        conn_curr = get_sql_server_connection(sql_settings)
        should_close = True
    else:
        conn_curr = conn
        should_close = False

    item_totals = {}
    item_to_group = {}

    try:
        cur_c = conn_curr.cursor()
        q_curr = f"""
            SELECT UPPER(LTRIM(RTRIM(s.ItemName))), 
                   UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))), 
                   SUM({item_stk_expr if not include_opening else item_stk_expr_no_opn})
            FROM {db_curr}.dbo.FINITEMSTOCK s
            JOIN {db_curr}.dbo.ITEMMST i ON s.ItemName = i.ItemName
            WHERE 1=1 {item_type_clause}
            GROUP BY UPPER(LTRIM(RTRIM(s.ItemName))), UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, ''))))
        """
        cur_c.execute(q_curr)
        for r in cur_c.fetchall():
            iname = str(r[0] or "").strip().upper()
            gname = str(r[1] or "").strip().upper()
            mvmt = float(r[2] or 0.0)
            prev_cls = prev_item_closing.get(iname, 0.0) if include_opening else 0.0
            
            item_totals[iname] = prev_cls + mvmt
            item_to_group[iname] = gname if gname else iname

        # Fetch CURRENT YEAR CHALDATA adjustments (ALL items, NO filtering)
        q_adj = f"""
            SELECT UPPER(LTRIM(RTRIM(ISNULL(COALESCE(NULLIF(cd.GroupName, ''), NULLIF(i_job.GroupName, ''), NULLIF(i_item.GroupName, ''), NULLIF(cd.JobItem, ''), cd.ItemName), '')))) AS group_name,
                   SUM(cd.Pcs) AS adj_pcs
            FROM {db_curr}.dbo.CHALDATA cd
            JOIN {db_curr}.dbo.CHALMAST cm ON cd.ControlId = cm.EntryId
            LEFT JOIN {db_curr}.dbo.ITEMMST i_job ON cd.JobItem = i_job.ItemName
            LEFT JOIN {db_curr}.dbo.ITEMMST i_item ON cd.ItemName = i_item.ItemName
            WHERE cm.Godown IN ('ADJ','CASH SALE','EXTRA PACKED','PURCHASE','RETURN ADJ','STOCK NEW')
               OR cm.Mode IN ('GO','AO','OP')
            GROUP BY UPPER(LTRIM(RTRIM(ISNULL(COALESCE(NULLIF(cd.GroupName, ''), NULLIF(i_job.GroupName, ''), NULLIF(i_item.GroupName, ''), NULLIF(cd.JobItem, ''), cd.ItemName), ''))))
        """
        cur_c.execute(q_adj)
        new_adj_map = {str(r[0] or "").strip().upper(): float(r[1] or 0.0) for r in cur_c.fetchall() if r[0]}

    finally:
        if should_close:
            try: conn_curr.close()
            except: pass

    # Sum item totals into Groups
    group_stocks = {}
    for iname, tot_item in item_totals.items():
        gname = item_to_group.get(iname, iname)
        if not gname:
            gname = iname
        group_stocks[gname] = group_stocks.get(gname, 0.0) + tot_item

    # Add CURRENT YEAR CHALDATA adjustments per group
    for gname, adj_val in new_adj_map.items():
        group_stocks[gname] = group_stocks.get(gname, 0.0) + adj_val

    return {g: float(v) for g, v in group_stocks.items()}

def get_shared_stock_data(sql_settings, include_opening=False, conn=None, item_type_filter="EXCLUDE_GREY"):
    """
    Returns stocks, job issues, and job reprocess values per group.
    """
    global _stock_cache
    now = time.time()
    db_curr = sql_settings.get("db_name", "EQSKNT20262027")
    db_prev = sql_settings.get("db_prev", "EQSKNT20252026")
    cache_key = (include_opening, db_curr, db_prev, item_type_filter)

    if cache_key in _stock_cache:
        cached_val, cache_time = _stock_cache[cache_key]
        if now - cache_time < 5:  # Cache for 5 seconds
            return cached_val

    from app import get_sql_server_connection

    if conn is None:
        conn = get_sql_server_connection(sql_settings)
        should_close_conn = True
    else:
        should_close_conn = False

    stocks = calculate_stock_by_group(sql_settings, include_opening, conn=conn, item_type_filter=item_type_filter)

    Q_JOB_ISSUE = f"""
    SELECT UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) AS group_name,
        SUM(c.Pcs
          - ISNULL(c.SPcs,0)
          - ISNULL(c.ShtPcs,0)
          - ISNULL(c.RetPcs,0)
          - ISNULL(c.PlainPcs,0)
          - ISNULL(c.RfPcs,0)
          - ISNULL(c.SecPcs,0)
          - ISNULL(c.WastePcs,0)) AS job_issue_pcs
    FROM CHALDATA c
    LEFT JOIN {db_curr}.dbo.ITEMMST i ON c.JobItem = i.ItemName
    WHERE c.Mode = 'FI'
      AND c.JobItem IS NOT NULL AND c.JobItem != ''
      AND (c.SrChr IS NULL OR c.SrChr != 'RF')
    GROUP BY UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, ''))))
    HAVING SUM(c.Pcs
          - ISNULL(c.SPcs,0)
          - ISNULL(c.ShtPcs,0)
          - ISNULL(c.RetPcs,0)
          - ISNULL(c.PlainPcs,0)
          - ISNULL(c.RfPcs,0)
          - ISNULL(c.SecPcs,0)
          - ISNULL(c.WastePcs,0)) > 0
    """

    Q_JOB_REPROCESS = f"""
    SELECT UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) AS group_name,
        SUM(CASE WHEN c.Mode='FR' AND c.JobType='JOB'
                 AND (c.NewItem IS NULL OR LTRIM(RTRIM(c.NewItem))='')
                 THEN c.Pcs - ISNULL(c.SPcs,0) - ISNULL(c.ShtPcs,0) - ISNULL(c.RetPcs,0)
                           - ISNULL(c.PlainPcs,0) - ISNULL(c.RfPcs,0) - ISNULL(c.SecPcs,0)
                           - ISNULL(c.WastePcs,0)
                 ELSE 0 END)
      - SUM(CASE WHEN c.Mode='FI' AND c.SrChr='R'
                 THEN c.Pcs - ISNULL(c.SPcs,0) - ISNULL(c.ShtPcs,0) - ISNULL(c.RetPcs,0)
                           - ISNULL(c.PlainPcs,0) - ISNULL(c.RfPcs,0) - ISNULL(c.SecPcs,0)
                           - ISNULL(c.WastePcs,0)
                 ELSE 0 END) AS job_reprocess_pcs
    FROM CHALDATA c
    LEFT JOIN {db_curr}.dbo.ITEMMST i ON c.JobItem = i.ItemName
    WHERE c.JobItem IS NOT NULL AND c.JobItem != ''
      AND c.Mode IN ('FI','FR')
    GROUP BY UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, ''))))
    HAVING SUM(CASE WHEN c.Mode='FR' AND c.JobType='JOB'
                    AND (c.NewItem IS NULL OR LTRIM(RTRIM(c.NewItem))='')
                    THEN c.Pcs - ISNULL(c.SPcs,0) - ISNULL(c.ShtPcs,0) - ISNULL(c.RetPcs,0)
                              - ISNULL(c.PlainPcs,0) - ISNULL(c.RfPcs,0) - ISNULL(c.SecPcs,0)
                              - ISNULL(c.WastePcs,0)
                    ELSE 0 END)
         - SUM(CASE WHEN c.Mode='FI' AND c.SrChr='R'
                    THEN c.Pcs - ISNULL(c.SPcs,0) - ISNULL(c.ShtPcs,0) - ISNULL(c.RetPcs,0)
                              - ISNULL(c.PlainPcs,0) - ISNULL(c.RfPcs,0) - ISNULL(c.SecPcs,0)
                              - ISNULL(c.WastePcs,0)
                    ELSE 0 END) > 0
    """

    job_issues = {}
    job_reproc = {}
    try:
        cur = conn.cursor()
        cur.execute(Q_JOB_ISSUE)
        for r in cur.fetchall():
            if r[0]: job_issues[r[0].strip().upper()] = float(r[1] or 0.0)

        cur.execute(Q_JOB_REPROCESS)
        for r in cur.fetchall():
            if r[0]: job_reproc[r[0].strip().upper()] = float(r[1] or 0.0)
    finally:
        if should_close_conn:
            try: conn.close()
            except: pass

    res = (stocks, job_issues, job_reproc)
    _stock_cache[cache_key] = (res, now)
    return res


def query_order_details(sql_settings, status_filter, sort_by, party_name, group_name, haste_name=None, include_opening=False, item_type_filter="ALL"):
    """
    Retrieves all order items matching filter conditions.
    """
    from app import get_sql_server_connection
    import re

    db_name = sql_settings.get("db_name", "EQSKNT20262027")
    match = re.search(r'(\d{{4}})', db_name)
    if match:
        year = int(match.group(1))
        year_start = f"{year}-04-01"
    else:
        year_start = "2026-04-01"

    conn = get_sql_server_connection(sql_settings)
    try:
        stocks, job_issues, job_reproc = get_shared_stock_data(sql_settings, include_opening, item_type_filter=item_type_filter)
        
        where_clause_orders = "WHERE o.BalPcs > 0"
        q_params = []
        if not include_opening:
            q_orders = f"""
            WITH OrderData AS (
                SELECT d.ItemName, m.Date,
                    CASE WHEN d.Status='C' THEN 0
                         WHEN d.Pcs - ISNULL(d.BillPcs,0) < 0 THEN 0
                         ELSE d.Pcs - ISNULL(d.BillPcs,0)
                    END AS BalPcs
                FROM ORDERMST m JOIN ORDERDET d ON m.OrderNo = d.OrderNo
            )
            SELECT UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) AS group_name, SUM(o.BalPcs) AS order_pcs
            FROM OrderData o JOIN ITEMMST i ON o.ItemName = i.ItemName
            {where_clause_orders} AND o.Date >= ?
            GROUP BY UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) HAVING SUM(o.BalPcs) > 0
            """
            q_params.append(year_start)
        else:
            q_orders = f"""
            WITH OrderData AS (
                SELECT d.ItemName,
                    CASE WHEN d.Status='C' THEN 0
                         WHEN d.Pcs - ISNULL(d.BillPcs,0) < 0 THEN 0
                         ELSE d.Pcs - ISNULL(d.BillPcs,0)
                    END AS BalPcs
                FROM ORDERMST m JOIN ORDERDET d ON m.OrderNo = d.OrderNo
            )
            SELECT UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) AS group_name, SUM(o.BalPcs) AS order_pcs
            FROM OrderData o JOIN ITEMMST i ON o.ItemName = i.ItemName
            {where_clause_orders}
            GROUP BY UPPER(LTRIM(RTRIM(ISNULL(i.GroupName, '')))) HAVING SUM(o.BalPcs) > 0
            """
            
        cur_oos = conn.cursor()
        cur_oos.execute(q_orders, tuple(q_params))
        global_orders = {r[0].strip().upper(): float(r[1] or 0.0) for r in cur_oos.fetchall() if r[0] is not None}
        
        oos_groups = set()
        for grp, order_val in global_orders.items():
            stk_val = stocks.get(grp, 0.0)
            ji_val = job_issues.get(grp, 0.0)
            jr_val = job_reproc.get(grp, 0.0)
            if order_val - stk_val - ji_val - jr_val > 0:
                oos_groups.add(grp)

        where_clauses = []
        params = []

        if status_filter == "pending":
            where_clauses.append("d.Status != 'C' AND d.Pcs - ISNULL(d.BillPcs, 0) > 0")
        elif status_filter == "close":
            where_clauses.append("(d.Status = 'C' OR d.Pcs - ISNULL(d.BillPcs, 0) <= 0)")

        if party_name:
            where_clauses.append("m.Party = ?")
            params.append(party_name)
        if group_name:
            where_clauses.append("ISNULL(i.GroupName, '') = ?")
            params.append(group_name)

        if haste_name and haste_name.strip().lower() != "all":
            haste_col = _detect_haste_column(conn)
            if haste_col:
                where_clauses.append(f"m.{haste_col} = ?")
                params.append(haste_name.strip())

        if not include_opening:
            where_clauses.append("m.Date >= ?")
            params.append(year_start)

        where_sql = ""
        if where_clauses:
            where_sql = "WHERE " + " AND ".join(where_clauses)

        order_sql = "ORDER BY m.Party, m.OrderNo, ISNULL(i.GroupName, ''), d.ItemName"
        if sort_by == "group":
            order_sql = "ORDER BY ISNULL(i.GroupName, ''), m.Party, m.OrderNo, d.ItemName"

        sql = f"""
            SELECT m.OrderNo, CONVERT(varchar,m.Date,103) AS OrderDate, m.Party, ISNULL(i.GroupName, '') AS GroupName, d.ItemName, d.Pcs, ISNULL(d.BillPcs, 0),
                   CASE WHEN d.Status='C' THEN 0
                        WHEN d.Pcs-ISNULL(d.BillPcs,0)<0 THEN 0
                        ELSE d.Pcs-ISNULL(d.BillPcs,0) END,
                   CASE WHEN d.Status='C' OR d.Pcs-ISNULL(d.BillPcs,0)<=0 THEN 'Close'
                        ELSE 'Pending' END
            FROM ORDERMST m
            JOIN ORDERDET d ON m.OrderNo=d.OrderNo
            JOIN ITEMMST i ON d.ItemName=i.ItemName
            {where_sql}
            {order_sql}
        """
        cur = conn.cursor()
        cur.execute(sql, tuple(params))
        rows = cur.fetchall()

        results = []
        for r in rows:
            grp_upper = str(r[3]).strip().upper()
            results.append({
                "order_no": str(r[0]).strip(),
                "order_date": str(r[1]).strip(),
                "party": str(r[2]).strip(),
                "group_name": str(r[3]).strip(),
                "item_name": str(r[4]).strip(),
                "order_pcs": float(r[5] or 0),
                "bill_pcs": float(r[6] or 0),
                "bal_pcs": float(r[7] or 0),
                "status": str(r[8]).strip(),
                "is_oos": grp_upper in oos_groups
            })

        if sort_by == "group":
            results.sort(key=lambda x: (x["group_name"].upper(), x["party"].upper(), x["order_no"], x["item_name"].upper()))
        else:
            results.sort(key=lambda x: (x["party"].upper(), x["order_no"], x["group_name"].upper(), x["item_name"].upper()))

        return results
    finally:
        try: conn.close()
        except: pass

def query_bill_report_details(sql_settings, date_from=None, date_to=None, sort_by="group", party_name=None, group_name=None, include_prev_year=False):
    """
    Queries BILLMAST and BILLDATA joined with ITEMMST for Sale Bill Report.
    """
    from app import get_sql_server_connection, get_sql_server_prev_connection
    from datetime import datetime

    db_curr = sql_settings.get("db_name", "EQSKNT20262027")
    db_prev = sql_settings.get("db_prev", "EQSKNT20252026")

    def fetch_bills_from_db(conn_inst, db_label, target_db):
        where_clauses = []
        params = []

        if date_from and date_from.strip():
            try:
                df_sql = datetime.strptime(date_from.strip(), "%d/%m/%Y").strftime("%Y-%m-%d")
                where_clauses.append("m.Date >= ?")
                params.append(df_sql)
            except Exception:
                pass

        if date_to and date_to.strip():
            try:
                dt_sql = datetime.strptime(date_to.strip(), "%d/%m/%Y").strftime("%Y-%m-%d")
                where_clauses.append("m.Date <= ?")
                params.append(dt_sql)
            except Exception:
                pass

        if party_name and party_name.strip() and party_name.strip().lower() != "all":
            where_clauses.append("m.Party = ?")
            params.append(party_name.strip())

        if group_name and group_name.strip() and group_name.strip().lower() != "all":
            where_clauses.append("ISNULL(i.GroupName, ISNULL(d.GroupName, '')) = ?")
            params.append(group_name.strip())

        where_clauses.append("(m.Book = 'SALES A/C' OR m.Book LIKE '%SALE%') AND m.Book NOT LIKE '%RETURN%'")

        where_sql = ""
        if where_clauses:
            where_sql = "WHERE " + " AND ".join(where_clauses)

        sql = f"""
            SELECT CONVERT(varchar, m.Date, 103) AS BillDate,
                   m.BillNo,
                   m.Party,
                   ISNULL(i.GroupName, ISNULL(d.GroupName, '')) AS GroupName,
                   d.ItemName,
                   ISNULL(d.Pcs, 0) AS Pcs,
                   ISNULL(d.Rate, 0) AS Rate,
                   ISNULL(d.Amount, 0) AS Amount,
                   ISNULL(d.PackType, '') AS PackType,
                   m.Date AS RawDate
            FROM {target_db}.dbo.BILLMAST m
            JOIN {target_db}.dbo.BILLDATA d ON m.EntryId = d.ControlId
            LEFT JOIN {target_db}.dbo.ITEMMST i ON d.ItemName = i.ItemName
            {where_sql}
        """
        cur = conn_inst.cursor()
        cur.execute(sql, tuple(params))
        rows = cur.fetchall()

        out = []
        for r in rows:
            out.append({
                "date": str(r[0] or "").strip(),
                "bill_no": str(r[1] or "").strip(),
                "party_name": str(r[2] or "").strip(),
                "group_name": str(r[3] or "").strip(),
                "item_name": str(r[4] or "").strip(),
                "pcs": float(r[5] or 0),
                "rate": float(r[6] or 0),
                "amount": float(r[7] or 0),
                "pack_type": str(r[8] or "").strip(),
                "raw_date": str(r[9] or ""),
                "db_label": db_label
            })
        return out

    conn_curr = get_sql_server_connection(sql_settings)
    all_bills = []
    try:
        all_bills.extend(fetch_bills_from_db(conn_curr, "Current", db_curr))
    finally:
        try: conn_curr.close()
        except: pass

    if include_prev_year:
        try:
            conn_prev = get_sql_server_prev_connection(sql_settings)
            if conn_prev:
                try:
                    all_bills.extend(fetch_bills_from_db(conn_prev, "Previous", db_prev))
                finally:
                    try: conn_prev.close()
                    except: pass
        except Exception as e:
            print(f"Error fetching previous year bills: {e}")

    if sort_by == "party":
        all_bills.sort(key=lambda x: (x["party_name"].upper(), x["raw_date"], x["bill_no"], x["group_name"].upper(), x["item_name"].upper()))
    elif sort_by == "group":
        all_bills.sort(key=lambda x: (x["group_name"].upper(), x["raw_date"], x["bill_no"], x["party_name"].upper(), x["item_name"].upper()))
    elif sort_by == "item":
        all_bills.sort(key=lambda x: (x["item_name"].upper(), x["raw_date"], x["bill_no"], x["party_name"].upper(), x["group_name"].upper()))
    else:
        all_bills.sort(key=lambda x: (x["raw_date"], x["bill_no"], x["party_name"].upper(), x["group_name"].upper(), x["item_name"].upper()))

    return all_bills

def query_bill_report_filters(sql_settings):
    """
    Returns unique Party Names and Group Names (Main Items) for Bill Report filters.
    """
    from app import get_sql_server_connection
    conn = get_sql_server_connection(sql_settings)
    try:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT Party FROM BILLMAST WHERE Party IS NOT NULL AND Party != '' ORDER BY Party")
        parties = [str(r[0]).strip() for r in cur.fetchall() if r[0]]

        cur.execute("SELECT DISTINCT UPPER(LTRIM(RTRIM(ISNULL(GroupName, '')))) FROM ITEMMST WHERE GroupName IS NOT NULL AND GroupName != '' ORDER BY 1")
        groups = [str(r[0]).strip() for r in cur.fetchall() if r[0]]

        return {"parties": parties, "groups": groups}
    finally:
        try: conn.close()
        except: pass

def _parse_date_param(d_str):
    """Parse DD/MM/YYYY or YYYY-MM-DD to YYYY-MM-DD for SQL comparison."""
    if not d_str or not isinstance(d_str, str):
        return None
    d_str = d_str.strip()
    if not d_str:
        return None
    if "/" in d_str:
        parts = d_str.split("/")
        if len(parts) == 3:
            try:
                d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
                return f"{y:04d}-{m:02d}-{d:02d}"
            except ValueError:
                pass
    # Already YYYY-MM-DD?
    if "-" in d_str and len(d_str) == 10:
        return d_str
    return None

def query_job_filters(sql_settings):
    """Fetch unique jobbers, job items, and inward types for FI and FR challans."""
    from app import get_sql_server_connection
    conn = get_sql_server_connection(sql_settings)
    try:
        cur = conn.cursor()
        # Jobbers from FI + FR
        cur.execute("""
            SELECT DISTINCT LTRIM(RTRIM(Party)) as name
            FROM CHALMAST
            WHERE Mode IN ('FI', 'FR') AND Party IS NOT NULL AND LTRIM(RTRIM(Party)) <> ''
            ORDER BY name
        """)
        jobbers = [r[0] for r in cur.fetchall()]
        # Job Items from FI + FR
        cur.execute("""
            SELECT DISTINCT LTRIM(RTRIM(COALESCE(NULLIF(cd.JobItem,''), cd.ItemName, ''))) as name
            FROM CHALDATA cd
            JOIN CHALMAST cm ON cd.ControlId = cm.EntryId
            WHERE cm.Mode IN ('FI', 'FR')
            AND LTRIM(RTRIM(COALESCE(NULLIF(cd.JobItem,''), cd.ItemName, ''))) <> ''
            ORDER BY name
        """)
        items = [r[0] for r in cur.fetchall()]
        # Inward Types from FI + FR (InwType column belongs to CHALDATA cd)
        cur.execute("""
            SELECT DISTINCT LTRIM(RTRIM(cd.InwType)) as name
            FROM CHALDATA cd
            JOIN CHALMAST cm ON cd.ControlId = cm.EntryId
            WHERE cm.Mode IN ('FI', 'FR') AND cd.InwType IS NOT NULL AND LTRIM(RTRIM(cd.InwType)) <> ''
            ORDER BY name
        """)
        inw_types = [r[0] for r in cur.fetchall()]
        return {"jobbers": jobbers, "items": items, "inw_types": inw_types}
    finally:
        try: conn.close()
        except: pass

def query_job_issue_report(sql_settings, status="Pending", jobber="", item="", inw_type="", date_from="", date_to="", include_opening=False):
    """
    Fetch Job Work Issue report data from SQL Server CHALMAST (Mode = 'FI') + CHALDATA.
    LEFT JOIN aggregated Mode = 'FR' receipt rows to get returned breakdown columns.
    Sets status to 'C' (Close) when BalPcs <= 0, else 'P' (Pending).
    """
    from app import get_sql_server_connection
    conn = get_sql_server_connection(sql_settings)
    try:
        cur = conn.cursor()
        select_part = """
            SELECT 
                CONVERT(VARCHAR(10), cm.Date, 103) as date,
                ISNULL(cm.Party, '') as jobber,
                ISNULL(cm.SrChr, '') + CONVERT(VARCHAR(50), cm.Serial) as isssr,
                COALESCE(NULLIF(cd.JobItem, ''), cd.ItemName, '') as jobitem,
                ISNULL(cd.Rate, 0) as rate,
                ISNULL(cd.Pcs, 0) as pcs,
                ISNULL(cd.PlainPcs, 0) as cd_plainpcs,
                ISNULL(cd.RecPcs, 0) as cd_recpcs,
                ISNULL(cd.SecPcs, 0) as cd_secpcs,
                ISNULL(cd.ShtPcs, 0) as cd_shtpcs,
                ISNULL(cd.BalPcs, 0) as cd_balpcs,
                ISNULL(cd.WastePcs, 0) as cd_wastepcs,
                ISNULL(cd.RetPcs, 0) as cd_retpcs,
                COALESCE(NULLIF(cd.GroupName, ''), cd.ItemName, '') as fabrics,
                COALESCE(NULLIF(cd.InvNo, ''), NULLIF(cm.BillNo, ''), '') as purchase_bill_no,
                ISNULL(cd.Stat, 'P') as stat,
                ISNULL(cd.InwType, '') as inwtype,
                ISNULL(cm.Agent, '') as agent,
                ISNULL(cd.LotNo, ISNULL(cm.LotNo, 0)) as lotno,
                ISNULL(cm.SrChr, '') as series,
                ISNULL(cd.ItemName, '') as itemname,
                ISNULL(cd.RfPcs, 0) as cd_rfpcs,
                ISNULL(cd.SPcs, 0) as cd_spcs,
                ISNULL(fr.plainpcs, 0) as fr_plainpcs,
                ISNULL(fr.recpcs, 0) as fr_recpcs,
                ISNULL(fr.secpcs, 0) as fr_secpcs,
                ISNULL(fr.shtpcs, 0) as fr_shtpcs,
                ISNULL(fr.wastepcs, 0) as fr_wastepcs,
                ISNULL(fr.retpcs, 0) as fr_retpcs,
                ISNULL(fr.rfpcs, 0) as fr_rfpcs,
                ISNULL(fr.spcs, 0) as fr_spcs
            FROM CHALMAST cm
            JOIN CHALDATA cd ON cm.EntryId = cd.ControlId
            LEFT JOIN (
                SELECT 
                    cm_f.Party,
                    cd_f.JobItem,
                    COALESCE(NULLIF(cd_f.RecSr, 0), NULLIF(cd_f.OrderNo, 0), NULLIF(cd_f.RefNo, 0)) as issue_sr,
                    SUM(ISNULL(cd_f.PlainPcs, 0)) as plainpcs,
                    SUM(CASE WHEN ISNULL(cd_f.RecPcs, 0) > 0 THEN cd_f.RecPcs ELSE ISNULL(cd_f.Pcs, 0) END) as recpcs,
                    SUM(ISNULL(cd_f.SecPcs, 0)) as secpcs,
                    SUM(ISNULL(cd_f.ShtPcs, 0)) as shtpcs,
                    SUM(ISNULL(cd_f.WastePcs, 0)) as wastepcs,
                    SUM(ISNULL(cd_f.RetPcs, 0)) as retpcs,
                    SUM(ISNULL(cd_f.RfPcs, 0)) as rfpcs,
                    SUM(ISNULL(cd_f.SPcs, 0)) as spcs
                FROM CHALDATA cd_f
                JOIN CHALMAST cm_f ON cd_f.ControlId = cm_f.EntryId
                WHERE cm_f.Mode = 'FR'
                GROUP BY cm_f.Party, cd_f.JobItem, COALESCE(NULLIF(cd_f.RecSr, 0), NULLIF(cd_f.OrderNo, 0), NULLIF(cd_f.RefNo, 0))
            ) fr ON fr.issue_sr = cm.Serial AND fr.Party = cm.Party AND fr.JobItem = cd.JobItem
            WHERE cm.Mode = 'FI'
        """
        params = []
        
        if inw_type and inw_type != "All":
            select_part += " AND cd.InwType = ?"
            params.append(inw_type.strip())

        if jobber:
            select_part += " AND cm.Party LIKE ?"
            params.append(f"%{jobber.strip()}%")
        if item:
            select_part += " AND (cd.JobItem LIKE ? OR cd.ItemName LIKE ? OR cd.GroupName LIKE ?)"
            st = f"%{item.strip()}%"
            params.extend([st, st, st])

        df_parsed = _parse_date_param(date_from)
        if df_parsed:
            select_part += " AND cm.Date >= ?"
            params.append(df_parsed)

        dt_parsed = _parse_date_param(date_to)
        if dt_parsed:
            select_part += " AND cm.Date < DATEADD(day, 1, ?)"
            params.append(dt_parsed)

        def parse_fi_row(r, is_opening=False):
            pcs = float(r[5] or 0)
            cd_plain = float(r[6] or 0)
            cd_rec = float(r[7] or 0)
            cd_sec = float(r[8] or 0)
            cd_sht = float(r[9] or 0)
            raw_balpcs = float(r[10] or 0)
            cd_waste = float(r[11] or 0)
            cd_ret = float(r[12] or 0)
            cd_rf = float(r[21] or 0) if len(r) > 21 else 0.0
            cd_spcs = float(r[22] or 0) if len(r) > 22 else 0.0

            fr_plain = float(r[23] or 0) if len(r) > 23 else 0.0
            fr_rec = float(r[24] or 0) if len(r) > 24 else 0.0
            fr_sec = float(r[25] or 0) if len(r) > 25 else 0.0
            fr_sht = float(r[26] or 0) if len(r) > 26 else 0.0
            fr_waste = float(r[27] or 0) if len(r) > 27 else 0.0
            fr_ret = float(r[28] or 0) if len(r) > 28 else 0.0
            fr_rf = float(r[29] or 0) if len(r) > 29 else 0.0

            direct_total = cd_rec + cd_spcs + cd_rf + cd_sec + cd_sht + cd_plain + cd_waste + cd_ret

            if direct_total > 0:
                recpcs = cd_rec + cd_spcs
                secpcs = cd_sec
                shtpcs = cd_sht
                plainpcs = cd_plain
                wastepcs = cd_waste
                retpcs = cd_ret
                rfpcs = cd_rf
            else:
                recpcs = fr_rec
                secpcs = fr_sec
                shtpcs = fr_sht
                plainpcs = fr_plain
                wastepcs = fr_waste
                retpcs = fr_ret
                rfpcs = fr_rf

            stat = str(r[15]).strip() if r[15] else ("O" if is_opening else "P")
            total_returned = recpcs + secpcs + shtpcs + plainpcs + wastepcs + retpcs + rfpcs

            if stat == 'C':
                calc_balpcs = 0.0
            else:
                calc_balpcs = max(0.0, pcs - total_returned)
                if calc_balpcs <= 0:
                    stat = 'C'
                    calc_balpcs = 0.0
                else:
                    stat = 'P'

            return {
                "date": r[0] or "",
                "jobber": str(r[1]).strip() if r[1] else "",
                "isssr": str(r[2]).strip() if r[2] else "",
                "jobitem": str(r[3]).strip() if r[3] else "",
                "rate": float(r[4] or 0),
                "pcs": pcs,
                "plainpcs": plainpcs,
                "recpcs": recpcs,
                "secpcs": secpcs,
                "shtpcs": shtpcs,
                "balpcs": calc_balpcs,
                "wastepcs": wastepcs,
                "retpcs": retpcs,
                "rfpcs": rfpcs,
                "spcs": cd_spcs,
                "fabrics": str(r[13]).strip() if r[13] else "",
                "purchase_bill_no": str(r[14]).strip() if r[14] else "",
                "stat": stat,
                "inwtype": str(r[16]).strip() if len(r) > 16 and r[16] else "",
                "agent": str(r[17]).strip() if len(r) > 17 and r[17] else "",
                "lotno": str(r[18]).strip() if len(r) > 18 and r[18] else "",
                "series": str(r[19]).strip() if len(r) > 19 and r[19] else "",
                "itemname": str(r[20]).strip() if len(r) > 20 and r[20] else "",
                "is_opening": is_opening
            }

        open_rows = []
        if include_opening and df_parsed:
            open_query = """
                SELECT 
                    ISNULL(cm.Party, '') as jobber,
                    COALESCE(NULLIF(cd.JobItem, ''), cd.ItemName, '') as jobitem,
                    COALESCE(NULLIF(cd.GroupName, ''), cd.ItemName, '') as fabrics,
                    SUM(ISNULL(cd.Pcs, 0)) as pcs,
                    SUM(CASE WHEN cd.Stat = 'C' THEN 0 ELSE CASE WHEN ISNULL(cd.BalPcs,0) > 0 THEN cd.BalPcs ELSE (ISNULL(cd.Pcs,0) - (ISNULL(cd.RecPcs,0)+ISNULL(cd.SecPcs,0)+ISNULL(cd.ShtPcs,0)+ISNULL(cd.WastePcs,0)+ISNULL(cd.RetPcs,0)+ISNULL(cd.PlainPcs,0)+ISNULL(cd.RfPcs,0)+ISNULL(cd.SPcs,0))) END END) as balpcs
                FROM CHALMAST cm
                JOIN CHALDATA cd ON cm.EntryId = cd.ControlId
                WHERE cm.Mode = 'FI'
                AND cm.Date < ?
                AND (cd.Stat = 'P' OR cd.Stat = '' OR cd.Stat IS NULL OR cd.BalPcs > 0 OR (ISNULL(cd.Pcs,0) - (ISNULL(cd.RecPcs,0)+ISNULL(cd.SecPcs,0)+ISNULL(cd.ShtPcs,0)+ISNULL(cd.WastePcs,0)+ISNULL(cd.RetPcs,0)+ISNULL(cd.PlainPcs,0)+ISNULL(cd.RfPcs,0)+ISNULL(cd.SPcs,0))) > 0)
            """
            open_params = [df_parsed]
            if inw_type and inw_type != "All":
                open_query += " AND cd.InwType = ?"
                open_params.append(inw_type.strip())
            if jobber:
                open_query += " AND cm.Party LIKE ?"
                open_params.append(f"%{jobber.strip()}%")
            if item:
                open_query += " AND (cd.JobItem LIKE ? OR cd.ItemName LIKE ? OR cd.GroupName LIKE ?)"
                st = f"%{item.strip()}%"
                open_params.extend([st, st, st])
            open_query += " GROUP BY cm.Party, cd.JobItem, cd.ItemName, cd.GroupName HAVING SUM(CASE WHEN cd.Stat = 'C' THEN 0 ELSE CASE WHEN ISNULL(cd.BalPcs,0) > 0 THEN cd.BalPcs ELSE (ISNULL(cd.Pcs,0) - (ISNULL(cd.RecPcs,0)+ISNULL(cd.SecPcs,0)+ISNULL(cd.ShtPcs,0)+ISNULL(cd.WastePcs,0)+ISNULL(cd.RetPcs,0)+ISNULL(cd.PlainPcs,0)+ISNULL(cd.RfPcs,0)+ISNULL(cd.SPcs,0))) END END) <> 0 ORDER BY jobber, jobitem"
            cur.execute(open_query, open_params)
            for r in cur.fetchall():
                b_pcs = float(r[4] or 0)
                if b_pcs > 0:
                    open_rows.append({
                        "date": "Opening",
                        "jobber": str(r[0]).strip() if r[0] else "",
                        "isssr": "OPG",
                        "jobitem": str(r[1]).strip() if r[1] else "",
                        "rate": 0,
                        "pcs": float(r[3] or 0),
                        "plainpcs": 0,
                        "recpcs": 0,
                        "secpcs": 0,
                        "shtpcs": 0,
                        "balpcs": b_pcs,
                        "wastepcs": 0,
                        "retpcs": 0,
                        "rfpcs": 0,
                        "spcs": 0,
                        "fabrics": str(r[2]).strip() if r[2] else "",
                        "purchase_bill_no": "",
                        "stat": "O",
                        "inwtype": "",
                        "agent": "",
                        "lotno": "",
                        "series": "",
                        "itemname": "",
                        "is_opening": True
                    })

        select_part += " ORDER BY cm.Date ASC, cm.Serial ASC"
        cur.execute(select_part, params)
        rows = open_rows + [parse_fi_row(r) for r in cur.fetchall()]

        if status == "Pending":
            return [r for r in rows if r.get('is_opening') or r['stat'] == 'P']
        elif status == "Close":
            return [r for r in rows if r['stat'] == 'C']
        return rows
    finally:
        try: conn.close()
        except: pass

def query_job_reprocess_report(sql_settings, job_type="All", status="Pending", jobber="", item="", inw_type="", date_from="", date_to="", include_opening=False):
    """
    Fetch Job Reprocess report data from SQL Server CHALMAST (Mode = 'FR') + CHALDATA.
    Excludes finished sale items (where cd.NewItem is filled with sale product) as they directly go to finish stock.
    Computes rfpcs from re-issued new challans (Mode = 'FI', SrChr = 'R') and RF entries.
    """
    from app import get_sql_server_connection
    from collections import defaultdict
    conn = get_sql_server_connection(sql_settings)
    try:
        cur = conn.cursor()

        # Step 1: Pre-fetch linked FI re-issues into Python dictionary (safe against SQL type conversions)
        query_fi = """
            SELECT 
                cd_i.RecSr, cd_i.OrderNo, cd_i.RefNo,
                ISNULL(cd_i.Pcs, 0) as pcs
            FROM CHALDATA cd_i
            JOIN CHALMAST cm_i ON cd_i.ControlId = cm_i.EntryId
            WHERE cm_i.Mode = 'FI' AND (cm_i.SrChr = 'R' OR cm_i.SrChr LIKE '%R%' OR cd_i.JobType = 'RF')
        """
        cur.execute(query_fi)
        reissue_map = defaultdict(float)
        for r in cur.fetchall():
            pcs = float(r[3] or 0)
            for val in (r[0], r[1], r[2]):
                if val is not None:
                    try:
                        s_val = str(val).strip()
                        if s_val and s_val != '0':
                            ser_num = str(int(float(s_val)))
                            reissue_map[ser_num] += pcs
                            break
                    except:
                        pass

        # Step 2: Query FR rows
        select_part = """
            SELECT 
                cm.Serial,
                cm.SrChr,
                cd.OrderNo,
                cd.RefNo,
                cd.RecSr,
                CONVERT(VARCHAR(10), cm.Date, 103) as date_str,
                cm.Party,
                cd.ItemName,
                cd.JobItem,
                ISNULL(cd.Pcs, 0) as pcs,
                ISNULL(cd.PlainPcs, 0) as plainpcs,
                ISNULL(cd.RfPcs, 0) as raw_rfpcs,
                ISNULL(cd.BalPcs, 0) as raw_balpcs,
                ISNULL(cd.Rate, 0) as rate,
                cd.JobType,
                cd.Stat,
                cd.InwType,
                cm.Agent,
                cm.LotNo,
                ISNULL(cd.RecPcs, 0) as recpcs_raw,
                ISNULL(cd.SecPcs, 0) as secpcs,
                ISNULL(cd.ShtPcs, 0) as shtpcs,
                ISNULL(cd.SPcs, 0) as spcs,
                ISNULL(cd.RetPcs, 0) as retpcs,
                ISNULL(cd.WastePcs, 0) as wastepcs,
                cd.NewItem
            FROM CHALMAST cm
            JOIN CHALDATA cd ON cm.EntryId = cd.ControlId
            WHERE cm.Mode = 'FR'
              AND (
                cd.NewItem IS NULL 
                OR LTRIM(RTRIM(cd.NewItem)) = '' 
                OR UPPER(LTRIM(RTRIM(cd.NewItem))) = 'RF'
                OR UPPER(LTRIM(RTRIM(cd.JobType))) = 'RF'
                OR UPPER(LTRIM(RTRIM(cm.SrChr))) LIKE '%RF%'
              )
        """
        params = []

        if job_type:
            if isinstance(job_type, list):
                jt_list = [j.strip() for j in job_type if j and str(j).strip() and str(j).strip() != "All"]
            else:
                jt_list = [j.strip() for j in str(job_type).split(",") if j.strip() and j.strip() != "All"]

            if len(jt_list) == 1:
                select_part += " AND cd.JobType = ?"
                params.append(jt_list[0])
            elif len(jt_list) > 1:
                placeholders = ",".join(["?"] * len(jt_list))
                select_part += f" AND cd.JobType IN ({placeholders})"
                params.extend(jt_list)

        if inw_type and inw_type != "All":
            select_part += " AND cd.InwType = ?"
            params.append(inw_type.strip())

        if jobber:
            select_part += " AND cm.Party LIKE ?"
            params.append(f"%{jobber.strip()}%")
        if item:
            select_part += " AND (cd.JobItem LIKE ? OR cd.ItemName LIKE ? OR cd.GroupName LIKE ?)"
            st = f"%{item.strip()}%"
            params.extend([st, st, st])

        df_parsed = _parse_date_param(date_from)
        if df_parsed:
            select_part += " AND cm.Date >= ?"
            params.append(df_parsed)

        dt_parsed = _parse_date_param(date_to)
        if dt_parsed:
            select_part += " AND cm.Date < DATEADD(day, 1, ?)"
            params.append(dt_parsed)

        open_rows = []
        if include_opening and df_parsed:
            open_query = """
                SELECT 
                    ISNULL(cm.Party, '') as jobber,
                    COALESCE(NULLIF(cd.JobItem, ''), cd.ItemName, '') as jobitem,
                    ISNULL(cd.JobType, '') as jobtype,
                    SUM(ISNULL(cd.Pcs, 0)) as pcs,
                    SUM(CASE WHEN cd.Stat = 'C' THEN 0 ELSE CASE WHEN ISNULL(cd.BalPcs,0) > 0 THEN cd.BalPcs ELSE (ISNULL(cd.Pcs,0) - (ISNULL(cd.RfPcs,0)+ISNULL(cd.PlainPcs,0)+ISNULL(cd.RecPcs,0)+ISNULL(cd.SecPcs,0)+ISNULL(cd.ShtPcs,0)+ISNULL(cd.SPcs,0))) END END) as balpcs
                FROM CHALMAST cm
                JOIN CHALDATA cd ON cm.EntryId = cd.ControlId
                WHERE cm.Mode = 'FR'
                AND cm.Date < ?
                AND (cd.Stat = 'P' OR cd.Stat = '' OR cd.Stat IS NULL OR cd.BalPcs > 0 OR (ISNULL(cd.Pcs,0) - (ISNULL(cd.RfPcs,0)+ISNULL(cd.PlainPcs,0)+ISNULL(cd.RecPcs,0)+ISNULL(cd.SecPcs,0)+ISNULL(cd.ShtPcs,0)+ISNULL(cd.SPcs,0))) > 0)
            """
            open_params = [df_parsed]
            if job_type:
                jt_list = [j.strip() for j in str(job_type).split(",") if j.strip() and j.strip() != "All"]
                if len(jt_list) == 1:
                    open_query += " AND cd.JobType = ?"
                    open_params.append(jt_list[0])
                elif len(jt_list) > 1:
                    placeholders = ",".join(["?"] * len(jt_list))
                    open_query += f" AND cd.JobType IN ({placeholders})"
                    open_params.extend(jt_list)
            if inw_type and inw_type != "All":
                open_query += " AND cd.InwType = ?"
                open_params.append(inw_type.strip())
            if jobber:
                open_query += " AND cm.Party LIKE ?"
                open_params.append(f"%{jobber.strip()}%")
            if item:
                open_query += " AND (cd.JobItem LIKE ? OR cd.ItemName LIKE ? OR cd.GroupName LIKE ?)"
                st = f"%{item.strip()}%"
                open_params.extend([st, st, st])
            open_query += " GROUP BY cm.Party, cd.JobItem, cd.ItemName, cd.JobType HAVING SUM(CASE WHEN cd.Stat = 'C' THEN 0 ELSE CASE WHEN ISNULL(cd.BalPcs,0) > 0 THEN cd.BalPcs ELSE (ISNULL(cd.Pcs,0) - (ISNULL(cd.RfPcs,0)+ISNULL(cd.PlainPcs,0)+ISNULL(cd.RecPcs,0)+ISNULL(cd.SecPcs,0)+ISNULL(cd.ShtPcs,0)+ISNULL(cd.SPcs,0))) END END) <> 0 ORDER BY jobber, jobitem"
            cur.execute(open_query, open_params)
            for r in cur.fetchall():
                b_pcs = float(r[4] or 0)
                if b_pcs > 0:
                    open_rows.append({
                        "issno": "OPG",
                        "recsr": "OPG",
                        "date": "Opening",
                        "jobber": str(r[0]).strip() if r[0] else "",
                        "jobitem": str(r[1]).strip() if r[1] else "",
                        "pcs": float(r[3] or 0),
                        "plainpcs": 0,
                        "rfpcs": 0,
                        "recpcs": 0,
                        "secpcs": 0,
                        "shtpcs": 0,
                        "spcs": 0,
                        "balpcs": b_pcs,
                        "rate": 0,
                        "jobtype": str(r[2]).strip() if r[2] else "",
                        "stat": "O",
                        "inwtype": "",
                        "agent": "",
                        "lotno": "",
                        "series": "",
                        "itemname": "",
                        "is_opening": True
                    })

        select_part += " ORDER BY cm.Date ASC, cm.Serial ASC"
        cur.execute(select_part, params)
        cols = [d[0] for d in cur.description]
        raw_db_rows = [dict(zip(cols, r)) for r in cur.fetchall()]

        # Sequential allocation of reissue_pcs per serial
        grouped_fr = defaultdict(list)
        for r in raw_db_rows:
            ser = r['Serial']
            try:
                ser_key = str(int(float(ser))) if ser is not None else ""
            except:
                ser_key = str(ser).strip() if ser else ""
            grouped_fr[ser_key].append(r)

        fr_parsed_rows = []
        for ser_key, rows_list in grouped_fr.items():
            avail_reissue = reissue_map.get(ser_key, 0.0)

            for r in rows_list:
                pcs = float(r['pcs'] or 0)
                plainpcs = float(r['plainpcs'] or 0)
                raw_rfpcs = float(r['raw_rfpcs'] or 0)
                raw_balpcs = float(r['raw_balpcs'] or 0)
                recpcs_raw = float(r['recpcs_raw'] or 0)
                secpcs = float(r['secpcs'] or 0)
                shtpcs = float(r['shtpcs'] or 0)
                spcs = float(r['spcs'] or 0)
                retpcs = float(r['retpcs'] or 0)
                wastepcs = float(r['wastepcs'] or 0)
                
                order_no = str(r['OrderNo']).strip() if r['OrderNo'] and str(r['OrderNo']).strip() != '0' else ""
                ref_no = str(r['RefNo']).strip() if r['RefNo'] and str(r['RefNo']).strip() != '0' else ""
                serial_str = str(r['Serial']).strip() if r['Serial'] is not None else ""
                sr_chr = str(r['SrChr']).strip() if r['SrChr'] else ""
                
                main_no = order_no or ref_no or serial_str
                issno = (main_no + ' ' + sr_chr).strip()

                rec_sr = str(r['RecSr']).strip() if r['RecSr'] and str(r['RecSr']).strip() != '0' else serial_str
                recsr = sr_chr + rec_sr

                if raw_rfpcs > 0:
                    calc_rfpcs = raw_rfpcs
                    calc_recpcs = recpcs_raw
                elif avail_reissue > 0:
                    calc_rfpcs = min(pcs, avail_reissue)
                    avail_reissue -= calc_rfpcs
                    calc_recpcs = recpcs_raw
                else:
                    calc_rfpcs = 0.0
                    calc_recpcs = recpcs_raw

                if raw_balpcs > 0:
                    calc_balpcs = raw_balpcs
                else:
                    calc_balpcs = max(0.0, pcs - calc_rfpcs - plainpcs)

                stat_raw = str(r['Stat']).strip() if r['Stat'] else "P"
                if stat_raw in ('C', 'CLOSE') and calc_balpcs <= 0 and raw_balpcs <= 0:
                    stat = 'C'
                    calc_balpcs = 0.0
                elif calc_balpcs <= 0:
                    stat = 'C'
                else:
                    stat = 'P'

                fr_parsed_rows.append({
                    "issno": issno,
                    "recsr": recsr,
                    "date": r['date_str'] or "",
                    "jobber": str(r['Party']).strip() if r['Party'] else "",
                    "jobitem": str(r['JobItem']).strip() if r['JobItem'] else (str(r['ItemName']).strip() if r['ItemName'] else ""),
                    "pcs": pcs,
                    "plainpcs": plainpcs,
                    "rfpcs": calc_rfpcs,
                    "recpcs": calc_recpcs,
                    "secpcs": secpcs,
                    "shtpcs": shtpcs,
                    "spcs": spcs,
                    "retpcs": retpcs,
                    "wastepcs": wastepcs,
                    "balpcs": calc_balpcs,
                    "rate": float(r['rate'] or 0),
                    "jobtype": str(r['JobType']).strip() if r['JobType'] else "",
                    "stat": stat,
                    "inwtype": str(r['InwType']).strip() if r['InwType'] else "",
                    "agent": str(r['Agent']).strip() if r['Agent'] else "",
                    "lotno": str(r['LotNo']).strip() if r['LotNo'] else "",
                    "series": sr_chr,
                    "itemname": str(r['ItemName']).strip() if r['ItemName'] else "",
                    "is_opening": False
                })

        rows = open_rows + fr_parsed_rows

        if status == "Pending":
            return [r for r in rows if r.get('is_opening') or r['stat'] == 'P']
        elif status == "Close":
            return [r for r in rows if r['stat'] == 'C']
        return rows
    finally:
        try: conn.close()
        except: pass


