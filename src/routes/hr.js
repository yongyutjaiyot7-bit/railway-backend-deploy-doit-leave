const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const { authenticate, authorize } = require('../middleware/auth');

const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

module.exports = function (db) {
  const router = express.Router();
  router.use(authenticate, authorize('hr_admin'));

  // ===== จัดการพนักงาน =====

  // GET /api/hr/employees
  router.get('/employees', (req, res) => {
    const { search, department, division, role } = req.query;
    let sql = `SELECT u.id, u.employee_id, u.name, u.email, u.role,
                      u.department, u.division, u.unit, u.created_at
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
    const u = db.prepare('SELECT id,employee_id,name,email,role,department,division,unit,created_at FROM users WHERE id=?').get(req.params.id);
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
    const { employee_id, name, email, password, role, department, division, unit, leave_quotas } = req.body;
    const validRoles = ['employee','unit_head','department_head','division_manager','hr_admin'];
    if (!employee_id || !name || !email || !password || !role) {
      return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    if (!validRoles.includes(role)) return res.status(400).json({ message: 'role ไม่ถูกต้อง' });
    try {
      const hash = await bcrypt.hash(password, 10);
      const r = db.prepare(`
        INSERT INTO users (employee_id,name,email,password,role,department,division,unit)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(employee_id, name, email, hash, role, department||'', division||'', unit||'');
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
    const { name, email, password, role, department, division, unit, leave_quotas } = req.body;
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ message: 'ไม่พบพนักงาน' });
    const validRoles = ['employee','unit_head','department_head','division_manager','hr_admin'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ message: 'role ไม่ถูกต้อง' });
    try {
      let passwordField = u.password;
      if (password) passwordField = await bcrypt.hash(password, 10);
      db.prepare(`UPDATE users SET name=?,email=?,password=?,role=?,department=?,division=?,unit=? WHERE id=?`)
        .run(name||u.name, email||u.email, passwordField, role||u.role, department||u.department, division||u.division, unit||u.unit, u.id);
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
    db.prepare('UPDATE dept_approvers SET approver_user_id=?, level=?, department=? WHERE id=?').run(Number(approver_user_id), newLevel, newDept, Number(req.params.id));
    res.json({ message: `อัปเดตผู้อนุมัติระดับ ${newLevel} แผนก ${newDept} เป็น "${approver.name}" สำเร็จ` });
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
    // ระดับตรวจสอบ (1): หัวหน้าหน่วยงาน, หัวหน้าแผนก
    // ระดับอนุมัติ (2): ผู้จัดการฝ่ายขึ้นไป
    const roles = level === 1
      ? ['unit_head','department_head']
      : ['division_manager','hr_admin'];
    const placeholders = roles.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, employee_id, name, role, department, division, unit
      FROM users WHERE role IN (${placeholders})
      ORDER BY role, department, name
    `).all(roles);
    res.json(rows);
  });

  // GET /api/hr/leave-types
  router.get('/leave-types', (req, res) => {
    res.json(db.prepare('SELECT * FROM leave_types').all());
  });

  // POST /api/hr/leave-types
  router.post('/leave-types', (req, res) => {
    const { name, max_days_per_year, requires_document } = req.body;
    if (!name || !max_days_per_year) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ' });
    const r = db.prepare('INSERT INTO leave_types (name,max_days_per_year,requires_document) VALUES (?,?,?)').run(name, Number(max_days_per_year), requires_document ? 1 : 0);
    res.status(201).json({ message: 'เพิ่มประเภทการลาสำเร็จ', id: r.lastInsertRowid });
  });

  // PUT /api/hr/leave-types/:id
  router.put('/leave-types/:id', (req, res) => {
    const { name, max_days_per_year, requires_document } = req.body;
    const lt = db.prepare('SELECT * FROM leave_types WHERE id=?').get(req.params.id);
    if (!lt) return res.status(404).json({ message: 'ไม่พบประเภทการลา' });
    db.prepare('UPDATE leave_types SET name=?,max_days_per_year=?,requires_document=? WHERE id=?')
      .run(name||lt.name, max_days_per_year ? Number(max_days_per_year) : lt.max_days_per_year, requires_document !== undefined ? (requires_document?1:0) : lt.requires_document, lt.id);
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

    res.json({
      summary: { totalEmployees: totalEmp.c, pending: pending.c, approvedCount: approved.c, approvedDays: approved.d||0, rejected: rejected.c },
      byDept, monthly, byType, byYear, balance
    });
  });

  // ===== จัดการข้อมูลการลา =====

  // GET /api/hr/leave-records
  router.get('/leave-records', (req, res) => {
    const { status, department, leave_type_id, year, month, search } = req.query;
    let sql = `
      SELECT lr.id, lr.request_no, lr.start_date, lr.end_date, lr.days, lr.reason,
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
        SELECT a.level, a.status, a.comment, a.acted_at, u.name as approver_name
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
    const { start_date, end_date, reason, status, leave_type_id } = req.body;
    const days = start_date && end_date ? Math.floor((new Date(end_date)-new Date(start_date))/86400000)+1 : lr.days;
    db.prepare(`UPDATE leave_requests SET start_date=?,end_date=?,days=?,reason=?,status=?,leave_type_id=?,updated_at=datetime('now') WHERE id=?`)
      .run(start_date||lr.start_date, end_date||lr.end_date, days, reason||lr.reason, status||lr.status, leave_type_id||lr.leave_type_id, lr.id);
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

  return router;
};
