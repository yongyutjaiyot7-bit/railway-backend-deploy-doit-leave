const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const { authenticate } = require('../middleware/auth');

const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { upload, UPLOAD_DIR } = require('../middleware/upload');
const fs = require('fs');
const path = require('path');

module.exports = function (db) {
  const router = express.Router();

  // ตรวจสิทธิ์: hr_admin เข้าได้เสมอ หรือมี can_access_hr ใน user_menu_permissions
  router.use(authenticate, (req, res, next) => {
    if (req.user.role === 'hr_admin') return next();
    try {
      const perm = db.prepare('SELECT * FROM user_menu_permissions WHERE user_id=?').get(req.user.id) || {};
      if (!perm.can_access_hr) return res.status(403).json({ message: 'ไม่มีสิทธิ์เข้าถึง HR Panel' });

      const p = req.path, m = req.method;
      // เขียนข้อมูลพนักงาน ต้องมี can_manage_employees
      if ((p.startsWith('/employees') || p.startsWith('/import-employees')) && m !== 'GET') {
        if (!perm.can_manage_employees) return res.status(403).json({ message: 'ไม่มีสิทธิ์จัดการพนักงาน' });
      }
      // จัดการประเภทการลา
      if (p.startsWith('/leave-types') && m !== 'GET') {
        if (!perm.can_manage_leave_types) return res.status(403).json({ message: 'ไม่มีสิทธิ์จัดการประเภทการลา' });
      }
      // ตั้งค่าระบบ (permissions, dept-approvers, user-permissions)
      if ((p.startsWith('/permissions') || p.startsWith('/dept-approvers') || p.startsWith('/user-permissions')) && m !== 'GET') {
        if (!perm.can_manage_settings) return res.status(403).json({ message: 'ไม่มีสิทธิ์จัดการการตั้งค่า' });
      }
      // ดูรายการลา
      if (p.startsWith('/leave-records') || p.startsWith('/leave-record/')) {
        if (!perm.can_view_all_requests && !perm.can_view_hr_calendar) return res.status(403).json({ message: 'ไม่มีสิทธิ์ดูรายการลา' });
      }
      // รายงาน
      if (p.startsWith('/report') && !perm.can_view_report) return res.status(403).json({ message: 'ไม่มีสิทธิ์ดูรายงาน' });
      // export
      if ((p.startsWith('/export') || p.startsWith('/employee-template')) && !perm.can_export) return res.status(403).json({ message: 'ไม่มีสิทธิ์ export ข้อมูล' });

      next();
    } catch(e) {
      return res.status(403).json({ message: 'ไม่มีสิทธิ์ดำเนินการนี้' });
    }
  });

  // ===== จัดการพนักงาน =====

  // GET /api/hr/employees
  router.get('/employees', (req, res) => {
    const { search, department, division, role } = req.query;
    let sql = `SELECT u.id, u.employee_id, u.name, u.email, u.role,
                      u.department, u.division, u.unit, u.employee_type, u.probation_start_date, u.created_at
               FROM users u WHERE 1=1`;
    const params = [];
    if (search) { sql += ' AND (u.name LIKE ? OR u.employee_id LIKE ? OR u.email LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
    if (department) { sql += ' AND u.department = ?'; params.push(department); }
    if (division)   { sql += ' AND u.division = ?';   params.push(division); }
    if (role)       { sql += ' AND u.role = ?';       params.push(role); }
    sql += ' ORDER BY u.department, u.unit, u.name';
    res.json(db.prepare(sql).all(...params));
  });

  // GET /api/hr/employees/:id
  router.get('/employees/:id', (req, res) => {
    const u = db.prepare('SELECT id,employee_id,name,email,role,department,division,unit,employee_type,probation_start_date,created_at FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ message: 'ไม่พบพนักงาน' });
    // ดูโควต้าการลาด้วย
    const year = new Date().getFullYear();
    const balances = db.prepare(`
      SELECT lb.*, lt.name as leave_type_name
      FROM leave_balances lb JOIN leave_types lt ON lt.id=lb.leave_type_id
      WHERE lb.employee_id=? AND lb.year=?
    `).all(u.id, year);
    res.json({ ...u, balances });
  });

  // POST /api/hr/employees
  router.post('/employees', async (req, res) => {
    const { employee_id, name, email, password, role, department, division, unit, employee_type, probation_start_date, leave_quotas } = req.body;
    const validRoles = ['employee','unit_head','department_head','division_manager','hr_admin'];
    const validEmpTypes = ['monthly','daily','housekeeping'];
    if (!employee_id || !name || !email || !password || !role) {
      return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    if (!validRoles.includes(role)) return res.status(400).json({ message: 'role ไม่ถูกต้อง' });
    const empType = validEmpTypes.includes(employee_type) ? employee_type : 'monthly';
    try {
      const hash = await bcrypt.hash(password, 10);
      const r = db.prepare(`
        INSERT INTO users (employee_id,name,email,password,role,department,division,unit,employee_type,probation_start_date)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(employee_id, name, email, hash, role, department||'', division||'', unit||'', empType, probation_start_date||null);
      const uid = r.lastInsertRowid;
      const year = new Date().getFullYear();
      const types = db.prepare('SELECT * FROM leave_types').all();
      types.forEach(lt => {
        const quota = (leave_quotas && leave_quotas[lt.id]) ? Number(leave_quotas[lt.id]) : lt.max_days_per_year;
        db.prepare('INSERT OR IGNORE INTO leave_balances (employee_id,leave_type_id,year,total_days) VALUES (?,?,?,?)').run(uid, lt.id, year, quota);
      });
      res.status(201).json({ message: 'เพิ่มพนักงานสำเร็จ', id: uid });
    } catch (e) {
      if (String(e).includes('UNIQUE')) return res.status(409).json({ message: 'รหัสพนักงานหรืออีเมลซ้ำ' });
      res.status(500).json({ message: e.message });
    }
  });

  // PUT /api/hr/employees/:id
  router.put('/employees/:id', async (req, res) => {
    const { name, email, password, role, department, division, unit, employee_type, probation_start_date, leave_quotas } = req.body;
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ message: 'ไม่พบพนักงาน' });
    const validRoles = ['employee','unit_head','department_head','division_manager','hr_admin'];
    const validEmpTypes = ['monthly','daily','housekeeping'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ message: 'role ไม่ถูกต้อง' });
    const empType = employee_type && validEmpTypes.includes(employee_type) ? employee_type : (u.employee_type || 'monthly');
    try {
      let passwordField = u.password;
      if (password) passwordField = await bcrypt.hash(password, 10);
      db.prepare(`UPDATE users SET name=?,email=?,password=?,role=?,department=?,division=?,unit=?,employee_type=?,probation_start_date=? WHERE id=?`)
        .run(name||u.name, email||u.email, passwordField, role||u.role, department||u.department, division||u.division, unit||u.unit, empType, probation_start_date !== undefined ? (probation_start_date||null) : u.probation_start_date, u.id);
      // อัปเดตโควต้าการลาถ้าส่งมา
      if (leave_quotas) {
        const year = new Date().getFullYear();
        Object.entries(leave_quotas).forEach(([typeId, days]) => {
          db.prepare(`INSERT INTO leave_balances (employee_id,leave_type_id,year,total_days)
            VALUES (?,?,?,?) ON CONFLICT(employee_id,leave_type_id,year) DO UPDATE SET total_days=excluded.total_days`)
            .run(u.id, parseInt(typeId), year, parseInt(days));
        });
      }
      res.json({ message: 'อัปเดตข้อมูลพนักงานสำเร็จ' });
    } catch (e) {
      if (String(e).includes('UNIQUE')) return res.status(409).json({ message: 'อีเมลซ้ำ' });
      res.status(500).json({ message: e.message });
    }
  });

  // DELETE /api/hr/employees/:id
  router.delete('/employees/:id', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ message: 'ไม่พบพนักงาน' });
    if (u.role === 'hr_admin') return res.status(403).json({ message: 'ไม่สามารถลบ HR Admin ได้' });
    const hasLeave = db.prepare("SELECT COUNT(*) as c FROM leave_requests WHERE employee_id=? AND status NOT IN ('cancelled','rejected')").get(u.id);
    if (hasLeave && hasLeave.c > 0) return res.status(400).json({ message: `ไม่สามารถลบได้ มีประวัติการลา ${hasLeave.c} รายการ` });
    db.prepare('DELETE FROM leave_balances WHERE employee_id=?').run(u.id);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    res.json({ message: 'ลบพนักงานสำเร็จ' });
  });

  // ===== สิทธิ์การเข้าถึง =====

  // GET /api/hr/permissions
  router.get('/permissions', (req, res) => {
    res.json(db.prepare('SELECT * FROM access_permissions ORDER BY role').all());
  });

  // PUT /api/hr/permissions/:role
  router.put('/permissions/:role', (req, res) => {
    const { can_view_all_requests, can_export, can_manage_employees, can_manage_leave_types, can_view_report, description } = req.body;
    const p = db.prepare('SELECT * FROM access_permissions WHERE role=?').get(req.params.role);
    if (!p) return res.status(404).json({ message: 'ไม่พบ role' });
    db.prepare(`UPDATE access_permissions SET can_view_all_requests=?,can_export=?,can_manage_employees=?,can_manage_leave_types=?,can_view_report=?,description=? WHERE role=?`)
      .run(
        can_view_all_requests ?? p.can_view_all_requests,
        can_export            ?? p.can_export,
        can_manage_employees  ?? p.can_manage_employees,
        can_manage_leave_types ?? p.can_manage_leave_types,
        can_view_report       ?? p.can_view_report,
        description           ?? p.description,
        req.params.role
      );
    res.json({ message: 'อัปเดตสิทธิ์สำเร็จ' });
  });

  // POST /api/hr/permissions — เพิ่มบทบาทใหม่
  router.post('/permissions', (req, res) => {
    const { role, description } = req.body;
    if (!role) return res.status(400).json({ message: 'กรุณาระบุชื่อบทบาท' });
    const exists = db.prepare('SELECT role FROM access_permissions WHERE role=?').get(role);
    if (exists) return res.status(400).json({ message: 'บทบาทนี้มีอยู่แล้ว' });
    db.prepare('INSERT INTO access_permissions (role,description,can_view_all_requests,can_export,can_manage_employees,can_manage_leave_types,can_view_report) VALUES (?,?,0,0,0,0,0)')
      .run(role, description || '');
    res.json({ message: `เพิ่มบทบาท "${role}" สำเร็จ` });
  });

  // DELETE /api/hr/permissions/:role — ลบบทบาท
  router.delete('/permissions/:role', (req, res) => {
    const protected_roles = ['employee','unit_head','department_head','division_manager','hr_admin'];
    if (protected_roles.includes(req.params.role)) return res.status(400).json({ message: 'ไม่สามารถลบบทบาทหลักของระบบได้' });
    const p = db.prepare('SELECT * FROM access_permissions WHERE role=?').get(req.params.role);
    if (!p) return res.status(404).json({ message: 'ไม่พบบทบาท' });
    db.prepare('DELETE FROM access_permissions WHERE role=?').run(req.params.role);
    res.json({ message: `ลบบทบาท "${req.params.role}" สำเร็จ` });
  });

  // ===== สิทธิ์เฉพาะรายบุคคล =====
  const MENU_PERM_FIELDS = ['can_access_hr','can_view_dashboard_hr','can_manage_employees','can_manage_leave_types','can_manage_settings','can_view_hr_calendar','can_view_all_requests','can_view_report','can_export'];

  // ensure table exists at runtime (in case DB file predates migration)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS user_menu_permissions (
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
    )`);
  } catch(e) {}

  // GET /api/hr/user-permissions — รายชื่อพนักงานพร้อมสิทธิ์
  router.get('/user-permissions', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT u.id, u.employee_id, u.name, u.role, u.department,
               COALESCE(ump.can_access_hr,0) as can_access_hr,
               COALESCE(ump.can_view_dashboard_hr,0) as can_view_dashboard_hr,
               COALESCE(ump.can_manage_employees,0) as can_manage_employees,
               COALESCE(ump.can_manage_leave_types,0) as can_manage_leave_types,
               COALESCE(ump.can_manage_settings,0) as can_manage_settings,
               COALESCE(ump.can_view_hr_calendar,0) as can_view_hr_calendar,
               COALESCE(ump.can_view_all_requests,0) as can_view_all_requests,
               COALESCE(ump.can_view_report,0) as can_view_report,
               COALESCE(ump.can_export,0) as can_export
        FROM users u
        LEFT JOIN user_menu_permissions ump ON ump.user_id = u.id
        WHERE u.role != 'hr_admin'
        ORDER BY u.department, u.name
      `).all();
      res.json(rows);
    } catch(e) {
      res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + e.message });
    }
  });

  // PUT /api/hr/user-permissions/:userId — upsert สิทธิ์รายบุคคล
  router.put('/user-permissions/:userId', (req, res) => {
    try {
      const uid = Number(req.params.userId);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
      if (!u) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });
      const fields = {};
      MENU_PERM_FIELDS.forEach(f => { if (req.body[f] !== undefined) fields[f] = req.body[f] ? 1 : 0; });
      const existing = db.prepare('SELECT id FROM user_menu_permissions WHERE user_id=?').get(uid);
      if (existing) {
        if (Object.keys(fields).length > 0) {
          const sets = Object.keys(fields).map(f => `${f}=?`).join(',');
          db.prepare(`UPDATE user_menu_permissions SET ${sets}, updated_at=datetime('now') WHERE user_id=?`).run(...Object.values(fields), uid);
        }
      } else {
        const cols = ['user_id', ...Object.keys(fields)].join(',');
        const vals = [uid, ...Object.values(fields)];
        db.prepare(`INSERT INTO user_menu_permissions (${cols}) VALUES (${vals.map(()=>'?').join(',')})`).run(...vals);
      }
      res.json({ message: 'บันทึกสิทธิ์สำเร็จ' });
    } catch(e) {
      res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + e.message });
    }
  });

  // ===== กำหนดผู้อนุมัติต่อแผนก =====

  // GET /api/hr/dept-approvers
  router.get('/dept-approvers', (req, res) => {
    const rows = db.prepare(`
      SELECT da.*, u.name as approver_name, u.employee_id as approver_emp_id, u.role as approver_role
      FROM dept_approvers da JOIN users u ON u.id=da.approver_user_id
      ORDER BY da.department, da.level
    `).all();
    // รายชื่อแผนกทั้งหมด
    const depts = db.prepare("SELECT DISTINCT department FROM users WHERE department != '' ORDER BY department").all().map(r => r.department);
    res.json({ approvers: rows, departments: depts });
  });

  // PUT /api/hr/dept-approvers  — upsert ผู้อนุมัติ
  router.put('/dept-approvers', (req, res) => {
    const { department, level, approver_user_id } = req.body;
    if (!department || !level || !approver_user_id) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ' });
    if (![1,2].includes(Number(level))) return res.status(400).json({ message: 'level ต้องเป็น 1 หรือ 2' });
    const approver = db.prepare('SELECT * FROM users WHERE id=?').get(approver_user_id);
    if (!approver) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });
    const exactDup = db.prepare('SELECT id FROM dept_approvers WHERE department=? AND level=? AND approver_user_id=?').get(department, Number(level), Number(approver_user_id));
    if (exactDup) return res.status(409).json({ message: `${approver.name} (${approver.employee_id}) เป็นผู้อนุมัติระดับ ${level} แผนก ${department} อยู่แล้ว` });
    db.prepare(`INSERT INTO dept_approvers (department,level,approver_user_id) VALUES (?,?,?)
      ON CONFLICT(department,level) DO UPDATE SET approver_user_id=excluded.approver_user_id, created_at=datetime('now')`)
      .run(department, Number(level), Number(approver_user_id));
    res.json({ message: `กำหนดผู้อนุมัติระดับ ${level} แผนก ${department} สำเร็จ` });
  });

  // PUT /api/hr/dept-approvers/:id — update approver + level ตาม id
  router.put('/dept-approvers/:id', (req, res) => {
    const { approver_user_id, level, department } = req.body;
    if (!approver_user_id) return res.status(400).json({ message: 'กรุณาเลือกผู้อนุมัติ' });
    const row = db.prepare('SELECT * FROM dept_approvers WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ message: 'ไม่พบรายการ' });
    const approver = db.prepare('SELECT * FROM users WHERE id=?').get(approver_user_id);
    if (!approver) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });
    const newLevel = level ? Number(level) : row.level;
    const newDept = department || row.department;
    // ตรวจสอบ (แผนก + ระดับ + คนเดิม) ซ้ำทั้ง 3 ช่อง (ยกเว้น row ที่กำลังแก้ไข)
    const dupExact = db.prepare('SELECT id FROM dept_approvers WHERE department=? AND level=? AND approver_user_id=? AND id!=?').get(newDept, newLevel, Number(approver_user_id), Number(req.params.id));
    if (dupExact) return res.status(409).json({ message: `${approver.name} (${approver.employee_id}) เป็นผู้อนุมัติระดับ ${newLevel} แผนก ${newDept} อยู่แล้ว` });
    // ตรวจสอบ UNIQUE(department, level) slot ซ้ำกับแถวอื่น (ยกเว้น row ที่กำลังแก้ไข)
    const dupSlot = db.prepare('SELECT id FROM dept_approvers WHERE department=? AND level=? AND id!=?').get(newDept, newLevel, Number(req.params.id));
    if (dupSlot) return res.status(409).json({ message: `แผนก ${newDept} ระดับ ${newLevel} มีผู้อนุมัติอยู่แล้ว กรุณาลบก่อนหรือเลือกระดับอื่น` });
    try {
      db.prepare('UPDATE dept_approvers SET approver_user_id=?, level=?, department=? WHERE id=?').run(Number(approver_user_id), newLevel, newDept, Number(req.params.id));
      res.json({ message: `อัปเดตผู้อนุมัติระดับ ${newLevel} แผนก ${newDept} เป็น "${approver.name}" สำเร็จ` });
    } catch(e) {
      res.status(409).json({ message: 'ไม่สามารถอัปเดตได้: ข้อมูลซ้ำกับรายการที่มีอยู่แล้ว' });
    }
  });

  // DELETE /api/hr/dept-approvers/:id
  router.delete('/dept-approvers/:id', (req, res) => {
    const r = db.prepare('SELECT * FROM dept_approvers WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ message: 'ไม่พบรายการ' });
    db.prepare('DELETE FROM dept_approvers WHERE id=?').run(req.params.id);
    res.json({ message: 'ลบผู้อนุมัติสำเร็จ' });
  });

  // GET /api/hr/approver-candidates - รายชื่อผู้ที่เป็นผู้อนุมัติได้
  router.get('/approver-candidates', (req, res) => {
    const level = parseInt(req.query.level) || 0;
    // รวมจาก 2 แหล่ง: (1) role-based และ (2) dept_approvers ที่ HR Admin กำหนด
    const rolesByLevel = {
      1: ['unit_head','department_head','division_manager','hr_admin'],
      2: ['department_head','division_manager','hr_admin'],
    };
    const roles = rolesByLevel[level] || ['unit_head','department_head','division_manager','hr_admin'];
    const ph = roles.map(() => '?').join(',');
    const byRole = db.prepare(`
      SELECT id, employee_id, name, role, department, division, unit
      FROM users WHERE role IN (${ph})
    `).all(roles);
    // เพิ่มผู้ที่ HR Admin กำหนดไว้ใน dept_approvers ที่ level นี้
    const byDept = level > 0 ? db.prepare(`
      SELECT u.id, u.employee_id, u.name, u.role, u.department, u.division, u.unit
      FROM dept_approvers da JOIN users u ON u.id = da.approver_user_id
      WHERE da.level = ?
    `).all(level) : [];
    // merge + dedupe
    const seen = new Set();
    const result = [];
    [...byRole, ...byDept].forEach(u => {
      if (!seen.has(u.id)) { seen.add(u.id); result.push(u); }
    });
    result.sort((a, b) => a.name.localeCompare(b.name, 'th'));
    res.json(result);
  });

  // GET /api/hr/leave-types
  router.get('/leave-types', (req, res) => {
    res.json(db.prepare('SELECT * FROM leave_types').all());
  });

  // POST /api/hr/leave-types
  router.post('/leave-types', (req, res) => {
    const { code, name, max_days_per_year, requires_document, requires_doc_over_days } = req.body;
    if (!name || !max_days_per_year) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ' });
    const r = db.prepare('INSERT INTO leave_types (code,name,max_days_per_year,requires_document,requires_doc_over_days) VALUES (?,?,?,?,?)')
      .run(code||'', name, Number(max_days_per_year), requires_document ? 1 : 0, requires_doc_over_days ? Number(requires_doc_over_days) : 0);
    res.status(201).json({ message: 'เพิ่มประเภทการลาสำเร็จ', id: r.lastInsertRowid });
  });

  // PUT /api/hr/leave-types/:id
  router.put('/leave-types/:id', (req, res) => {
    const { code, name, max_days_per_year, requires_document, requires_doc_over_days } = req.body;
    const lt = db.prepare('SELECT * FROM leave_types WHERE id=?').get(req.params.id);
    if (!lt) return res.status(404).json({ message: 'ไม่พบประเภทการลา' });
    db.prepare('UPDATE leave_types SET code=?,name=?,max_days_per_year=?,requires_document=?,requires_doc_over_days=? WHERE id=?')
      .run(
        code !== undefined ? code : (lt.code||''),
        name||lt.name,
        max_days_per_year ? Number(max_days_per_year) : lt.max_days_per_year,
        requires_document !== undefined ? (requires_document?1:0) : lt.requires_document,
        requires_doc_over_days !== undefined ? Number(requires_doc_over_days) : (lt.requires_doc_over_days||0),
        lt.id
      );
    res.json({ message: 'อัปเดตประเภทการลาสำเร็จ' });
  });

  // DELETE /api/hr/leave-types/:id
  router.delete('/leave-types/:id', (req, res) => {
    const used = db.prepare('SELECT COUNT(*) as c FROM leave_requests WHERE leave_type_id=?').get(req.params.id);
    if (used && used.c > 0) return res.status(400).json({ message: `ไม่สามารถลบได้ มีการลาประเภทนี้ ${used.c} รายการ` });
    db.prepare('DELETE FROM leave_types WHERE id=?').run(req.params.id);
    res.json({ message: 'ลบประเภทการลาสำเร็จ' });
  });

  // GET /api/hr/stats
  router.get('/stats', (req, res) => {
    const year = new Date().getFullYear();
    const totalEmp   = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='employee'").get();
    const totalLeave = db.prepare("SELECT COUNT(*) as c FROM leave_requests WHERE strftime('%Y',start_date)=?").get(String(year));
    const pending    = db.prepare("SELECT COUNT(*) as c FROM leave_requests WHERE status IN ('pending','approved_l1')").get();
    const approved   = db.prepare("SELECT COUNT(*) as c, SUM(days) as d FROM leave_requests WHERE status='approved' AND strftime('%Y',start_date)=?").get(String(year));
    const byDept     = db.prepare(`SELECT u.department, COUNT(*) as total, SUM(lr.days) as days
                                   FROM leave_requests lr JOIN users u ON u.id=lr.employee_id
                                   WHERE lr.status='approved' AND strftime('%Y',lr.start_date)=?
                                   GROUP BY u.department ORDER BY days DESC`).all(String(year));
    res.json({ totalEmployees: totalEmp.c, totalLeave: totalLeave.c, pending: pending.c, approvedCount: approved.c, approvedDays: approved.d || 0, byDepartment: byDept });
  });

  // GET /api/hr/dashboard - ข้อมูลกราฟทั้งหมด
  router.get('/dashboard', (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const y = String(year);

    // สถิติหลัก
    const totalEmp  = db.prepare("SELECT COUNT(*) as c FROM users WHERE role NOT IN ('hr_admin','division_manager','department_head','unit_head')").get();
    const pending   = db.prepare("SELECT COUNT(*) as c FROM leave_requests WHERE status IN ('pending','approved_l1')").get();
    const approved  = db.prepare("SELECT COUNT(*) as c, SUM(days) as d FROM leave_requests WHERE status='approved' AND strftime('%Y',start_date)=?").get(y);
    const rejected  = db.prepare("SELECT COUNT(*) as c FROM leave_requests WHERE status='rejected' AND strftime('%Y',start_date)=?").get(y);

    // กราฟ: จำนวนวันลาแยกตามแผนก
    const byDept = db.prepare(`
      SELECT u.department, lt.name as leave_type, SUM(lr.days) as days, COUNT(*) as count
      FROM leave_requests lr
      JOIN users u ON u.id = lr.employee_id
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.status = 'approved' AND strftime('%Y', lr.start_date) = ?
      GROUP BY u.department, lt.name ORDER BY u.department, days DESC
    `).all(y);

    // กราฟ: รายเดือน (12 เดือน)
    const byMonth = db.prepare(`
      SELECT strftime('%m', lr.start_date) as month, SUM(lr.days) as days, COUNT(*) as count
      FROM leave_requests lr
      WHERE lr.status = 'approved' AND strftime('%Y', lr.start_date) = ?
      GROUP BY month ORDER BY month
    `).all(y);
    const monthly = Array.from({length:12}, (_, i) => {
      const m = String(i+1).padStart(2,'0');
      const found = byMonth.find(r => r.month === m);
      return { month: i+1, days: found ? found.days : 0, count: found ? found.count : 0 };
    });

    // กราฟ: แยกตามประเภทการลา
    const byType = db.prepare(`
      SELECT lt.name, SUM(lr.days) as days, COUNT(*) as count
      FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.status = 'approved' AND strftime('%Y', lr.start_date) = ?
      GROUP BY lt.name ORDER BY days DESC
    `).all(y);

    // กราฟ: รายปี (5 ปีย้อนหลัง)
    const byYear = db.prepare(`
      SELECT strftime('%Y', lr.start_date) as yr, SUM(lr.days) as days, COUNT(*) as count
      FROM leave_requests lr WHERE lr.status = 'approved'
        AND strftime('%Y', lr.start_date) >= ?
      GROUP BY yr ORDER BY yr
    `).all(String(year - 4));

    // วันลาคงเหลือ (รวมทุกคน ปีนี้)
    const balance = db.prepare(`
      SELECT lt.name, SUM(lb.total_days) as quota, SUM(lb.used_days) as used,
             SUM(lb.total_days - lb.used_days) as remaining
      FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
      JOIN users u ON u.id = lb.employee_id
      WHERE lb.year = ? AND u.role NOT IN ('hr_admin')
      GROUP BY lt.name ORDER BY lt.name
    `).all(year);

    // เทรนด์รายเดือนแยกตามประเภทการลา
    const byMonthType = db.prepare(`
      SELECT strftime('%m', lr.start_date) as month, lt.name as leave_type, SUM(lr.days) as days
      FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.status = 'approved' AND strftime('%Y', lr.start_date) = ?
      GROUP BY month, lt.name ORDER BY month, lt.name
    `).all(y);

    res.json({
      summary: { totalEmployees: totalEmp.c, pending: pending.c, approvedCount: approved.c, approvedDays: approved.d||0, rejected: rejected.c },
      byDept, monthly, byType, byYear, balance, byMonthType
    });
  });

  // ===== จัดการข้อมูลการลา =====

  // POST /api/hr/leave-records — เพิ่มบันทึกการลาย้อนหลัง (HR Admin)
  router.post('/leave-records', upload.array('attachments', 5), (req, res) => {
    const { employee_id, leave_type_id, start_date, end_date, days, hours, reason, status, checker_id, approver_id } = req.body;
    if (!employee_id || !leave_type_id || !start_date || !end_date)
      return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ (พนักงาน, ประเภทลา, วันที่)' });
    const emp = db.prepare('SELECT id FROM users WHERE employee_id=? OR id=?').get(employee_id, employee_id);
    if (!emp) return res.status(404).json({ message: `ไม่พบพนักงานรหัส ${employee_id}` });
    const lt = db.prepare('SELECT id,max_days_per_year FROM leave_types WHERE id=?').get(leave_type_id);
    if (!lt) return res.status(404).json({ message: 'ไม่พบประเภทการลา' });
    const d = new Date();
    const prefix = `HR${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const request_no = `${prefix}${String(Math.floor(Math.random()*9000)+1000)}`;
    const calcDays = days ? Number(days) : (Math.floor((new Date(end_date)-new Date(start_date))/86400000)+1);
    const recStatus = status || 'approved';
    const checkerId  = checker_id  ? Number(checker_id)  : req.user.id;
    const approverId = approver_id ? Number(approver_id) : null;
    const approvalStatus = recStatus === 'approved' ? 'approved' : recStatus === 'rejected' ? 'rejected' : 'pending';
    const r = db.prepare(`
      INSERT INTO leave_requests (request_no,employee_id,leave_type_id,start_date,end_date,days,hours,reason,status,is_backdated,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))
    `).run(request_no, emp.id, leave_type_id, start_date, end_date, calcDays, hours||0, reason||'-', recStatus);
    const leaveId = r.lastInsertRowid;
    // อัปเดต leave_balance ถ้า approved
    if (recStatus === 'approved') {
      const year = new Date(start_date).getFullYear();
      db.prepare(`INSERT OR IGNORE INTO leave_balances (employee_id,leave_type_id,year,total_days) VALUES (?,?,?,?)`)
        .run(emp.id, leave_type_id, year, lt.max_days_per_year||0);
      db.prepare(`UPDATE leave_balances SET used_days=used_days+? WHERE employee_id=? AND leave_type_id=? AND year=?`)
        .run(calcDays, emp.id, leave_type_id, year);
    }
    // level 1 — ผู้ตรวจสอบ
    db.prepare(`INSERT INTO approvals (leave_request_id,level,approver_id,status,acted_at) VALUES (?,1,?,?,datetime('now'))`)
      .run(leaveId, checkerId, approvalStatus);
    // level 2 — ผู้อนุมัติ (ถ้าระบุ)
    if (approverId) {
      db.prepare(`INSERT INTO approvals (leave_request_id,level,approver_id,status,acted_at) VALUES (?,2,?,?,datetime('now'))`)
        .run(leaveId, approverId, approvalStatus);
    }
    // บันทึกไฟล์แนบ
    const insFile = db.prepare(`INSERT INTO leave_attachments (leave_request_id,filename,original_name,mime_type,file_size) VALUES (?,?,?,?,?)`);
    (req.files || []).forEach(f => insFile.run(leaveId, f.filename, f.originalname, f.mimetype, f.size));
    res.status(201).json({ message: 'เพิ่มบันทึกการลาสำเร็จ', request_no, id: leaveId, attachments: (req.files||[]).length });
  });

  // GET /api/hr/leave-records
  router.get('/leave-records', (req, res) => {
    const { status, department, leave_type_id, year, month, search } = req.query;
    let sql = `
      SELECT lr.id, lr.request_no, lr.start_date, lr.end_date, lr.days, lr.hours, lr.reason,
             lr.status, lr.created_at, lr.updated_at,
             lt.name as leave_type_name, lt.id as leave_type_id,
             u.name as employee_name, u.employee_id as emp_code,
             u.department, u.division, u.unit
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN users u ON u.id = lr.employee_id
      WHERE 1=1
    `;
    const params = [];
    if (status)        { sql += ' AND lr.status = ?';                  params.push(status); }
    if (department)    { sql += ' AND u.department = ?';               params.push(department); }
    if (leave_type_id) { sql += ' AND lr.leave_type_id = ?';           params.push(leave_type_id); }
    if (year)          { sql += " AND strftime('%Y',lr.start_date)=?"; params.push(year); }
    if (month)         { sql += " AND strftime('%m',lr.start_date)=?"; params.push(String(month).padStart(2,'0')); }
    if (search)        { sql += ' AND (u.name LIKE ? OR u.employee_id LIKE ? OR lr.request_no LIKE ?)'; const s=`%${search}%`; params.push(s,s,s); }
    sql += ' ORDER BY lr.created_at DESC LIMIT 300';
    const rows = db.prepare(sql).all(...params);
    // ดึง approvals
    const result = rows.map(r => {
      const approvals = db.prepare(`
        SELECT a.id, a.level, a.status, a.comment, a.acted_at, a.approver_id, u.name as approver_name
        FROM approvals a LEFT JOIN users u ON u.id = a.approver_id
        WHERE a.leave_request_id = ? ORDER BY a.level
      `).all(r.id);
      return { ...r, approvals };
    });
    res.json(result);
  });

  // PUT /api/hr/leave-records/:id - แก้ไขข้อมูลการลา (HR override)
  router.put('/leave-records/:id', (req, res) => {
    const lr = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id);
    if (!lr) return res.status(404).json({ message: 'ไม่พบคำขอลา' });
    const { start_date, end_date, reason, status, leave_type_id, checker_id, approver_id } = req.body;
    const days = start_date && end_date ? Math.floor((new Date(end_date)-new Date(start_date))/86400000)+1 : lr.days;
    db.prepare(`UPDATE leave_requests SET start_date=?,end_date=?,days=?,reason=?,status=?,leave_type_id=?,updated_at=datetime('now') WHERE id=?`)
      .run(start_date||lr.start_date, end_date||lr.end_date, days, reason||lr.reason, status||lr.status, leave_type_id||lr.leave_type_id, lr.id);

    // helper: upsert approval level
    const upsertApproval = (level, userId) => {
      if (!userId) return;
      const existing = db.prepare('SELECT id FROM approvals WHERE leave_request_id=? AND level=?').get(lr.id, level);
      if (existing) {
        db.prepare(`UPDATE approvals SET approver_id=?,acted_at=datetime('now') WHERE id=?`).run(Number(userId), existing.id);
      } else {
        db.prepare(`INSERT INTO approvals (leave_request_id,level,approver_id,status,acted_at) VALUES (?,?,?,?,datetime('now'))`)
          .run(lr.id, level, Number(userId), status || lr.status);
      }
    };
    upsertApproval(1, checker_id);
    upsertApproval(2, approver_id);
    res.json({ message: 'แก้ไขข้อมูลการลาสำเร็จ' });
  });

  // DELETE /api/hr/leave-records/:id
  router.delete('/leave-records/:id', (req, res) => {
    const lr = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id);
    if (!lr) return res.status(404).json({ message: 'ไม่พบคำขอลา' });
    // คืนวันลาถ้าเคย approved
    if (lr.status === 'approved') {
      const year = new Date(lr.start_date).getFullYear();
      db.prepare('UPDATE leave_balances SET used_days = MAX(0, used_days - ?) WHERE employee_id=? AND leave_type_id=? AND year=?')
        .run(lr.days, lr.employee_id, lr.leave_type_id, year);
    }
    db.prepare('DELETE FROM approvals WHERE leave_request_id=?').run(lr.id);
    db.prepare('DELETE FROM leave_requests WHERE id=?').run(lr.id);
    res.json({ message: 'ลบคำขอลาสำเร็จ' });
  });

  // ===== GET /api/hr/employee-template — ดาวน์โหลด Excel template =====
  router.get('/employee-template', (req, res) => {
    const wb = XLSX.utils.book_new();
    const headers = [['รหัสพนักงาน*','ชื่อ-นามสกุล*','อีเมล*','รหัสผ่าน*','บทบาท*','แผนก','ฝ่าย','หน่วยงาน']];
    const example = [
      ['EMP011','สมชาย ใจดี','somchai@company.com','password123','employee','บัญชี','การเงิน','หน่วยบัญชี1'],
      ['UH002','มานี รักงาน','manee@company.com','password123','unit_head','IT','เทคโนโลยี','หน่วย Dev'],
    ];
    const note = [['หมายเหตุ: บทบาท (role) ใส่ได้ดังนี้: employee | unit_head | department_head | division_manager | hr_admin']];
    const ws = XLSX.utils.aoa_to_sheet([...headers, ...example, [], ...note]);
    ws['!cols'] = [18,22,28,16,18,14,14,18].map(w => ({ wch: w }));
    // style header row
    ['A1','B1','C1','D1','E1','F1','G1','H1'].forEach(c => {
      if (ws[c]) ws[c].s = { font: { bold: true }, fill: { fgColor: { rgb: '1e3a5f' } }, fontColor: { rgb: 'ffffff' } };
    });
    XLSX.utils.book_append_sheet(wb, ws, 'พนักงาน');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="employee_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  // ===== POST /api/hr/import-employees — นำเข้าพนักงานจาก Excel =====
  router.post('/import-employees', xlsUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'ไม่พบไฟล์' });
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // หา header row (แถวแรก)
      const dataRows = rows.slice(1).filter(r => r[0] && String(r[0]).trim() && !String(r[0]).startsWith('หมายเหตุ'));
      if (!dataRows.length) return res.status(400).json({ message: 'ไม่พบข้อมูลในไฟล์' });

      const validRoles = ['employee','unit_head','department_head','division_manager','hr_admin'];
      const year = new Date().getFullYear();
      const types = db.prepare('SELECT * FROM leave_types').all();

      const results = { success: 0, failed: 0, errors: [] };

      for (let i = 0; i < dataRows.length; i++) {
        const [employee_id, name, email, password, role, department, division, unit] = dataRows[i].map(v => String(v).trim());
        const rowNum = i + 2;

        if (!employee_id || !name || !email || !password || !role) {
          results.failed++;
          results.errors.push(`แถว ${rowNum}: ข้อมูลไม่ครบ (รหัส/ชื่อ/อีเมล/รหัสผ่าน/บทบาท)`);
          continue;
        }
        if (!validRoles.includes(role)) {
          results.failed++;
          results.errors.push(`แถว ${rowNum}: บทบาท "${role}" ไม่ถูกต้อง`);
          continue;
        }
        try {
          const hash = await bcrypt.hash(password, 10);
          const r = db.prepare(`INSERT INTO users (employee_id,name,email,password,role,department,division,unit) VALUES (?,?,?,?,?,?,?,?)`)
            .run(employee_id, name, email, hash, role, department||'', division||'', unit||'');
          const uid = r.lastInsertRowid;
          types.forEach(lt => {
            db.prepare('INSERT OR IGNORE INTO leave_balances (employee_id,leave_type_id,year,total_days) VALUES (?,?,?,?)').run(uid, lt.id, year, lt.max_days_per_year);
          });
          results.success++;
        } catch (e) {
          results.failed++;
          results.errors.push(`แถว ${rowNum} (${employee_id}): ${String(e).includes('UNIQUE') ? 'รหัสพนักงานหรืออีเมลซ้ำ' : e.message}`);
        }
      }

      res.json({ message: `นำเข้าสำเร็จ ${results.success} คน, ล้มเหลว ${results.failed} คน`, ...results });
    } catch (e) {
      res.status(500).json({ message: 'อ่านไฟล์ไม่ได้: ' + e.message });
    }
  });

  // ===== วันหยุดประเพณีบริษัท =====

  // GET /api/hr/company-holidays?year=YYYY
  router.get('/company-holidays', (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    res.json(db.prepare('SELECT * FROM company_holidays WHERE date LIKE ? ORDER BY date').all(`${year}%`));
  });

  // POST /api/hr/company-holidays  { date, name }
  router.post('/company-holidays', (req, res) => {
    if (req.user.role !== 'hr_admin') return res.status(403).json({ message: 'เฉพาะ HR Admin เท่านั้น' });
    const { date, name } = req.body;
    if (!date || !name) return res.status(400).json({ message: 'กรุณากรอกวันที่และชื่อวันหยุด' });
    try {
      const r = db.prepare('INSERT OR REPLACE INTO company_holidays (date, name, created_by) VALUES (?,?,?)').run(date, name.trim(), req.user.id);
      res.json({ message: 'บันทึกสำเร็จ', id: r.lastInsertRowid });
    } catch(e) { res.status(500).json({ message: e.message }); }
  });

  // DELETE /api/hr/company-holidays/:id
  router.delete('/company-holidays/:id', (req, res) => {
    if (req.user.role !== 'hr_admin') return res.status(403).json({ message: 'เฉพาะ HR Admin เท่านั้น' });
    db.prepare('DELETE FROM company_holidays WHERE id=?').run(req.params.id);
    res.json({ message: 'ลบสำเร็จ' });
  });

  // POST /api/hr/company-holidays/import — นำเข้า Excel/CSV
  router.post('/company-holidays/import', xlsUpload.single('file'), (req, res) => {
    if (req.user.role !== 'hr_admin') return res.status(403).json({ message: 'เฉพาะ HR Admin เท่านั้น' });
    if (!req.file) return res.status(400).json({ message: 'ไม่พบไฟล์' });
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const dataRows = rows.slice(1).filter(r => r[0] && r[1]);

      const ins = db.prepare('INSERT OR REPLACE INTO company_holidays (date, name, created_by) VALUES (?,?,?)');
      let success = 0, failed = 0;
      const errors = [];
      dataRows.forEach((r, i) => {
        try {
          let dateVal = r[0];
          // รองรับทั้ง Date object (cellDates), serial number, string
          if (dateVal instanceof Date) {
            const y = dateVal.getFullYear();
            const m = String(dateVal.getMonth()+1).padStart(2,'0');
            const d = String(dateVal.getDate()).padStart(2,'0');
            dateVal = `${y}-${m}-${d}`;
          } else {
            // try parse string YYYY-MM-DD or DD/MM/YYYY or serial
            dateVal = String(dateVal).trim();
            if (/^\d+$/.test(dateVal)) {
              // Excel serial
              const jsDate = new Date((parseInt(dateVal) - 25569) * 86400000);
              dateVal = jsDate.toISOString().slice(0,10);
            } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateVal)) {
              const [dd,mm,yyyy] = dateVal.split('/');
              dateVal = `${yyyy}-${mm}-${dd}`;
            }
          }
          const name = String(r[1]).trim();
          if (!dateVal || !name) throw new Error('ข้อมูลไม่ครบ');
          ins.run(dateVal, name, req.user.id);
          success++;
        } catch(e) {
          failed++;
          errors.push(`แถว ${i+2}: ${e.message}`);
        }
      });
      res.json({ message: `นำเข้าสำเร็จ ${success} รายการ, ล้มเหลว ${failed} รายการ`, success, failed, errors });
    } catch(e) {
      res.status(500).json({ message: 'อ่านไฟล์ไม่ได้: ' + e.message });
    }
  });

  // GET /api/hr/company-holidays/template — ดาวน์โหลด template
  router.get('/company-holidays/template', (req, res) => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['วันที่ (YYYY-MM-DD)', 'ชื่อวันหยุด'],
      ['2026-01-01', 'วันขึ้นปีใหม่'],
      ['2026-04-13', 'วันสงกรานต์'],
      ['2026-04-14', 'วันสงกรานต์'],
      ['', '--- ใส่รายการเพิ่มเติมต่อจากนี้ ---'],
    ]);
    ws['!cols'] = [{ wch: 20 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, ws, 'วันหยุด');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="holiday_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  // ===== วันทำงาน/วันหยุดพิเศษ (เสาร์) =====

  // GET /api/hr/work-schedule?year=YYYY
  router.get('/work-schedule', (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    const rows = db.prepare(`SELECT * FROM work_schedule WHERE date LIKE ? ORDER BY date`).all(`${year}%`);
    res.json(rows);
  });

  // POST /api/hr/work-schedule  { date, type, note }
  router.post('/work-schedule', (req, res) => {
    if (req.user.role !== 'hr_admin') return res.status(403).json({ message: 'เฉพาะ HR Admin เท่านั้น' });
    const { date, type, note } = req.body;
    if (!date || !['working_sat','holiday_sat'].includes(type)) {
      return res.status(400).json({ message: 'ข้อมูลไม่ถูกต้อง' });
    }
    // ตรวจว่าเป็นวันเสาร์
    const d = new Date(date + 'T12:00:00');
    if (d.getDay() !== 6) return res.status(400).json({ message: 'กำหนดได้เฉพาะวันเสาร์เท่านั้น' });
    try {
      const r = db.prepare(`INSERT OR REPLACE INTO work_schedule (date, type, note, created_by) VALUES (?,?,?,?)`)
        .run(date, type, note || '', req.user.id);
      res.json({ message: 'บันทึกสำเร็จ', id: r.lastInsertRowid });
    } catch(e) {
      res.status(500).json({ message: e.message });
    }
  });

  // DELETE /api/hr/work-schedule/:id
  router.delete('/work-schedule/:id', (req, res) => {
    if (req.user.role !== 'hr_admin') return res.status(403).json({ message: 'เฉพาะ HR Admin เท่านั้น' });
    db.prepare('DELETE FROM work_schedule WHERE id=?').run(req.params.id);
    res.json({ message: 'ลบสำเร็จ' });
  });

  return router;
};
