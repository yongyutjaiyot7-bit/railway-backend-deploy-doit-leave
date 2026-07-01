const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../leave.db');

// wrapper ให้ใช้ API แบบเดิม (คล้าย better-sqlite3)
function createWrapper(sqlDb) {
  let inTransaction = false;

  function saveDb() {
    const data = sqlDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  function toArray(args) {
    if (args.length === 1 && Array.isArray(args[0])) return args[0];
    return args;
  }

  function lastInsertRowid() {
    const stmt = sqlDb.prepare('SELECT last_insert_rowid() as id');
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    return row.id;
  }

  class Statement {
    constructor(sql) { this._sql = sql; }

    run(...args) {
      const params = toArray(args);
      sqlDb.run(this._sql, params);
      const rowid = lastInsertRowid();
      const changes = sqlDb.getRowsModified();
      if (!inTransaction) saveDb();
      return { lastInsertRowid: rowid, changes };
    }

    get(...args) {
      const params = toArray(args);
      const stmt = sqlDb.prepare(this._sql);
      stmt.bind(params);
      const row = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free();
      return row;
    }

    all(...args) {
      const params = toArray(args);
      const stmt = sqlDb.prepare(this._sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
  }

  return {
    prepare: (sql) => new Statement(sql),

    exec(sql) {
      sqlDb.run(sql);
      saveDb();
    },

    run(sql, params = []) {
      sqlDb.run(sql, params);
      saveDb();
      return { lastInsertRowid: lastInsertRowid(), changes: sqlDb.getRowsModified() };
    },

    transaction(fn) {
      return (...args) => {
        inTransaction = true;
        sqlDb.run('BEGIN');
        try {
          const result = fn(...args);
          sqlDb.run('COMMIT');
          inTransaction = false;
          saveDb();
          return result;
        } catch (e) {
          inTransaction = false;
          try { sqlDb.run('ROLLBACK'); } catch (_) {}
          throw e;
        }
      };
    },
  };
}

async function initDb() {
  const SQL = await initSqlJs();
  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(buf);
  } else {
    sqlDb = new SQL.Database();
  }

  const db = createWrapper(sqlDb);

  sqlDb.run('PRAGMA foreign_keys = ON');

  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL,
      division TEXT NOT NULL,
      unit TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS leave_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      max_days_per_year INTEGER NOT NULL,
      requires_document INTEGER DEFAULT 0
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no TEXT UNIQUE NOT NULL,
      employee_id INTEGER NOT NULL,
      leave_type_id INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      days INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leave_request_id INTEGER NOT NULL,
      level INTEGER NOT NULL,
      approver_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      comment TEXT,
      acted_at TEXT
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS leave_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      leave_type_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      total_days INTEGER NOT NULL,
      used_days INTEGER NOT NULL DEFAULT 0,
      UNIQUE(employee_id, leave_type_id, year)
    )
  `);

  // ตารางไฟล์แนบ
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS leave_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leave_request_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      uploaded_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ตารางกำหนดผู้อนุมัติต่อแผนก (override role-based approval)
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS dept_approvers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department TEXT NOT NULL,
      level INTEGER NOT NULL CHECK(level IN (1,2)),
      approver_user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(department, level)
    )
  `);

  // ตารางสิทธิ์การเข้าถึงระบบ
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS access_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL UNIQUE,
      can_view_all_requests INTEGER DEFAULT 0,
      can_export INTEGER DEFAULT 0,
      can_manage_employees INTEGER DEFAULT 0,
      can_manage_leave_types INTEGER DEFAULT 0,
      can_view_report INTEGER DEFAULT 0,
      description TEXT
    )
  `);

  // Migration: add partial-day leave columns if not exist
  try { sqlDb.run('ALTER TABLE leave_requests ADD COLUMN hours REAL DEFAULT 0'); } catch(e) {}
  try { sqlDb.run('ALTER TABLE leave_requests ADD COLUMN start_datetime TEXT DEFAULT ""'); } catch(e) {}
  try { sqlDb.run('ALTER TABLE leave_requests ADD COLUMN end_datetime TEXT DEFAULT ""'); } catch(e) {}
  // Migration: employee type & probation for housekeeping; backdated flag for leave
  try { sqlDb.run("ALTER TABLE users ADD COLUMN employee_type TEXT DEFAULT 'monthly'"); } catch(e) {}
  try { sqlDb.run('ALTER TABLE users ADD COLUMN probation_start_date TEXT'); } catch(e) {}
  try { sqlDb.run('ALTER TABLE leave_requests ADD COLUMN is_backdated INTEGER DEFAULT 0'); } catch(e) {}
  // Migration: requires_doc_over_days — แนบเอกสารเมื่อลาเกิน N วัน (0 = ปิด)
  try { sqlDb.run('ALTER TABLE leave_types ADD COLUMN requires_doc_over_days INTEGER DEFAULT 0'); } catch(e) {}
  // Migration: leave type code
  try { sqlDb.run("ALTER TABLE leave_types ADD COLUMN code TEXT DEFAULT ''"); } catch(e) {}
  // Migration: over-quota unpaid excess flag
  try { sqlDb.run('ALTER TABLE leave_requests ADD COLUMN is_unpaid_excess INTEGER DEFAULT 0'); } catch(e) {}
  try { sqlDb.run('ALTER TABLE leave_requests ADD COLUMN unpaid_excess_days REAL DEFAULT 0'); } catch(e) {}
  // Migration: advance/backdate limits per leave type (0 = ไม่จำกัด/ไม่อนุญาต)
  try { sqlDb.run('ALTER TABLE leave_types ADD COLUMN advance_days INTEGER DEFAULT 0'); } catch(e) {}
  try { sqlDb.run('ALTER TABLE leave_types ADD COLUMN backdate_days INTEGER DEFAULT 0'); } catch(e) {}
  // Migration: deduplicate leave_types by name (keep lowest id per name)
  try {
    sqlDb.run(`DELETE FROM leave_types WHERE id NOT IN (
      SELECT MIN(id) FROM leave_types GROUP BY name
    )`);
    // clean up leave_balances that reference deleted leave_type ids
    sqlDb.run(`DELETE FROM leave_balances WHERE leave_type_id NOT IN (SELECT id FROM leave_types)`);
  } catch(e) {}
  // Migration: unique index on code (non-empty)
  try {
    sqlDb.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_types_code ON leave_types(code) WHERE code IS NOT NULL AND code != ''`);
  } catch(e) {}
  // Migration: reformat existing request_no to new format LV/HR{YY}{MMDD}{00001}{checkDigit}
  // ตรวจทั้ง LENGTH != 14 และ format เก่าที่ใช้ปี 4 หลัก (positions 3-6 เป็นปี เช่น 2026)
  try {
    const needReformat = sqlDb.prepare(`
      SELECT COUNT(*) as c FROM leave_requests
      WHERE LENGTH(request_no) != 14
         OR CAST(SUBSTR(request_no, 3, 4) AS INTEGER) BETWEEN 2020 AND 2099
    `).get();
    if (needReformat && needReformat.c > 0) {
      const rows = sqlDb.prepare(`SELECT id, request_no, created_at FROM leave_requests ORDER BY id ASC`).all();
      const upd  = sqlDb.prepare(`UPDATE leave_requests SET request_no=? WHERE id=?`);
      rows.forEach((r, idx) => {
        const prefix = r.request_no.startsWith('HR') ? 'HR' : 'LV';
        const dt = new Date(r.created_at || Date.now());
        const yy = String(dt.getFullYear()).slice(-2);
        const mm = String(dt.getMonth()+1).padStart(2,'0');
        const dd = String(dt.getDate()).padStart(2,'0');
        const seq = String(idx+1).padStart(5,'0');
        const body = `${prefix}${yy}${mm}${dd}${seq}`;
        const digits = body.replace(/\D/g,'');
        const check = digits.split('').reduce((s,c)=>s+parseInt(c),0) % 10;
        upd.run(`${body}${check}`, r.id);
      });
    }
  } catch(e) {}
  // Migration: per-user menu permissions
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS user_menu_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      can_access_hr INTEGER DEFAULT 0,
      can_view_dashboard_hr INTEGER DEFAULT 0,
      can_manage_employees INTEGER DEFAULT 0,
      can_manage_leave_types INTEGER DEFAULT 0,
      can_manage_settings INTEGER DEFAULT 0,
      can_view_hr_calendar INTEGER DEFAULT 0,
      can_view_all_requests INTEGER DEFAULT 0,
      can_view_report INTEGER DEFAULT 0,
      can_export INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const pCount = db.prepare('SELECT COUNT(*) as c FROM access_permissions').get();
  if (!pCount || pCount.c === 0) {
    const insPerm = db.prepare(`INSERT INTO access_permissions
      (role, can_view_all_requests, can_export, can_manage_employees, can_manage_leave_types, can_view_report, description) VALUES (?,?,?,?,?,?,?)`);
    insPerm.run('employee',         0, 0, 0, 0, 0, 'พนักงานทั่วไป ยื่นและดูคำขอของตนเองเท่านั้น');
    insPerm.run('unit_head',        1, 0, 0, 0, 0, 'หัวหน้าหน่วยงาน อนุมัติระดับ 1');
    insPerm.run('department_head',  1, 0, 0, 0, 1, 'หัวหน้าแผนก อนุมัติระดับ 2 และดูรายงานแผนก');
    insPerm.run('division_manager', 1, 1, 0, 0, 1, 'ผู้จัดการ อนุมัติระดับ 2 (ระดับอนุมัติ) และ export รายงาน');
    insPerm.run('hr_admin',         1, 1, 1, 1, 1, 'HR Admin เข้าถึงได้ทุกส่วน');
  }

  // ตารางวันหยุดประเพณีของบริษัท
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS company_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date)
    )
  `);

  // ตารางวันทำงาน/วันหยุดพิเศษ (เสาร์)
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS work_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('working_sat','holiday_sat')),
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ตาราง log การลบใบลา (เดิม)
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS leave_delete_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leave_request_id INTEGER NOT NULL,
      request_no TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      employee_id_code TEXT NOT NULL,
      leave_type TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      days REAL NOT NULL,
      hours REAL NOT NULL,
      status_before TEXT NOT NULL,
      deleted_by_user_id INTEGER NOT NULL,
      deleted_by_name TEXT NOT NULL,
      deleted_by_email TEXT NOT NULL,
      deleted_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // ตาราง log การลบทุกประเภท ทุกหน้า ทุกสิทธิ์
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS delete_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      table_name TEXT NOT NULL,
      record_id TEXT,
      record_summary TEXT,
      deleted_by_user_id INTEGER,
      deleted_by_name TEXT,
      deleted_by_email TEXT,
      deleted_by_role TEXT,
      ip_address TEXT,
      deleted_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // Seed วันหยุดประเพณี ปี 2026 (2569) — seed เฉพาะถ้ายังไม่มีข้อมูลปีนี้
  const chCount = db.prepare("SELECT COUNT(*) as c FROM company_holidays WHERE date LIKE '2026%'").get();
  if (!chCount || chCount.c === 0) {
    const insHol = db.prepare('INSERT OR IGNORE INTO company_holidays (date, name) VALUES (?,?)');
    insHol.run('2026-01-01', 'วันขึ้นปีใหม่');
    insHol.run('2026-01-02', 'วันขึ้นปีใหม่ (วันหยุดพิเศษบริษัทฯ)');
    insHol.run('2026-03-03', 'วันมาฆบูชา');
    insHol.run('2026-04-13', 'วันสงกรานต์');
    insHol.run('2026-04-14', 'วันสงกรานต์');
    insHol.run('2026-04-15', 'วันสงกรานต์');
    insHol.run('2026-04-16', 'วันสงกรานต์ (วันหยุดพิเศษบริษัทฯ)');
    insHol.run('2026-04-17', 'วันจักรี (แลกหยุด)');
    insHol.run('2026-05-01', 'วันแรงงาน');
    insHol.run('2026-07-27', 'วันเฉลิมฯ วันแม่ (แลกหยุด)');
    insHol.run('2026-07-28', 'วันเฉลิมพระชนมพรรษา ร.10');
    insHol.run('2026-07-29', 'วันอาสาฬหบูชา');
    insHol.run('2026-10-23', 'วันปิยมหาราช');
    insHol.run('2026-12-28', '(ชดเชย) วันคล้ายวันพระบรมราชสมภพ ร.9 (แลกหยุด)');
    insHol.run('2026-12-29', 'วันสิ้นปี (วันหยุดพิเศษบริษัทฯ)');
    insHol.run('2026-12-30', 'วันสิ้นปี (วันหยุดพิเศษบริษัทฯ)');
    insHol.run('2026-12-31', 'วันสิ้นปี');
  }

  // Leave types — ตรวจด้วย B04 (ลากิจบริษัท รายเดือน) ซึ่งเป็น type ใหม่
  const correctTypes = [
    // code,  name,                                   max_days, req_doc, req_doc_over_days
    ['01',  'ลาคลอด',                                120, 1, 0],   // กม. ไทย 98+22 = 120 วัน
    ['02',  'ลาเพื่อช่วยคู่สมรสคลอดบุตร',             15, 1, 0],
    ['04',  'ลาฌาปนกิจ',                               3, 0, 0],
    ['05',  'ลาสมรส',                                   3, 0, 0],
    ['06',  'ลาบวช',                                   15, 1, 0],
    ['07',  'ลาเพื่อการศึกษา',                         30, 1, 0],
    ['08',  'ลาทำหมัน',                                 3, 1, 0],
    ['09',  'ลา (แลกวันหยุดนักขัตฤกษ์)',                1, 0, 0],
    ['10',  'ลารักษาตัวเนื่องจากอุบัติเหตุในงาน',      30, 1, 0],
    ['11',  'ลาป่วย (โควิด)',                           14, 1, 0],
    ['12',  'ลาฝากครรภ์',                              12, 1, 0],
    ['B01', 'ลากิจกฎหมาย (รายเดือน)',                   3, 0, 0],  // กม.แรงงาน 3 วัน 8:00-18:00
    ['B02', 'ลากิจกฎหมาย (รายวัน)',                     3, 0, 0],  // กม.แรงงาน 3 วัน 8:00-17:00
    ['B03', 'พักงาน',                                    0, 0, 0],
    ['B04', 'ลากิจบริษัท (รายเดือน)',                   4, 0, 0],  // นโยบายบริษัท 4 วัน 8:00-18:00
    ['B4',  'ลากิจ (พิเศษ)',                             3, 0, 0],
    ['S02', 'ลาป่วย',                                   30, 0, 3],
    ['V03', 'ลาพักร้อน',                               10, 0, 0],
  ];
  const needReseed = !db.prepare("SELECT id FROM leave_types WHERE code='B04'").get();
  if (needReseed) {
    // ล้าง leave_balances + leave_types แล้ว seed ใหม่
    try { sqlDb.run('DELETE FROM leave_balances'); } catch(e) {}
    try { sqlDb.run('DELETE FROM leave_types'); } catch(e) {}
    const insLt = db.prepare('INSERT INTO leave_types (code,name,max_days_per_year,requires_document,requires_doc_over_days) VALUES (?,?,?,?,?)');
    for (const row of correctTypes) insLt.run(...row);
  } else {
    // อัปเดตชื่อ + โควต้า (ครอบคลุมกรณีเปลี่ยนจาก seed เก่า)
    const upLt = db.prepare('UPDATE leave_types SET name=?, max_days_per_year=? WHERE code=?');
    for (const [code, name, days] of correctTypes) upLt.run(name, days, code);
    // เพิ่ม type ใหม่ที่ยังไม่มี
    const insNew = db.prepare('INSERT OR IGNORE INTO leave_types (code,name,max_days_per_year,requires_document,requires_doc_over_days) VALUES (?,?,?,?,?)');
    for (const row of correctTypes) insNew.run(...row);
    // ตั้งค่า advance_days/backdate_days ให้ประเภทที่รู้กฎชัดเจน (เฉพาะถ้ายัง = 0)
    const setLimits = db.prepare('UPDATE leave_types SET advance_days=?, backdate_days=? WHERE code=? AND advance_days=0 AND backdate_days=0');
    setLimits.run(3,  0, 'B01'); // ลากิจกฎหมายรายเดือน: ล่วงหน้า 3 วัน, ย้อนหลังไม่ได้
    setLimits.run(3,  0, 'B02'); // ลากิจกฎหมายรายวัน
    setLimits.run(3,  0, 'B04'); // ลากิจบริษัทรายเดือน
    setLimits.run(0, 30, 'S02'); // ลาป่วย: ย้อนหลังได้ 30 วัน, ล่วงหน้าไม่จำกัด
  }

  return db;
}

module.exports = { initDb };
