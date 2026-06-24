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
    insPerm.run('division_manager', 1, 1, 0, 0, 1, 'ผู้จัดการฝ่าย อนุมัติระดับ 2 (ระดับอนุมัติ) และ export รายงาน');
    insPerm.run('hr_admin',         1, 1, 1, 1, 1, 'HR Admin เข้าถึงได้ทุกส่วน');
  }

  // Seed leave types
  const count = db.prepare('SELECT COUNT(*) as c FROM leave_types').get();
  if (!count || count.c === 0) {
    const ins = db.prepare('INSERT INTO leave_types (name, max_days_per_year, requires_document) VALUES (?, ?, ?)');
    ins.run('ลาป่วย', 30, 0);
    ins.run('ลากิจ', 10, 0);
    ins.run('ลาพักร้อน', 10, 0);
    ins.run('ลาคลอด', 98, 1);
    ins.run('ลาบวช', 15, 1);
  }

  return db;
}

module.exports = { initDb };
