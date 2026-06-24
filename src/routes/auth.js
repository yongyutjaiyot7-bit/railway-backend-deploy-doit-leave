const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

module.exports = function (db) {
  const router = express.Router();

  // POST /api/auth/register
  router.post('/register', async (req, res) => {
    const { employee_id, name, email, password, role, department, division, unit } = req.body;
    const validRoles = ['employee', 'unit_head', 'department_head', 'division_manager', 'hr_admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: 'role ไม่ถูกต้อง' });
    }
    try {
      const hash = await bcrypt.hash(password, 10);
      const stmt = db.prepare(`
        INSERT INTO users (employee_id, name, email, password, role, department, division, unit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(employee_id, name, email, hash, role, department, division, unit);
      const year = new Date().getFullYear();
      const leaveTypes = db.prepare('SELECT * FROM leave_types').all();
      const balStmt = db.prepare(`
        INSERT OR IGNORE INTO leave_balances (employee_id, leave_type_id, year, total_days)
        VALUES (?, ?, ?, ?)
      `);
      leaveTypes.forEach(lt => balStmt.run(result.lastInsertRowid, lt.id, year, lt.max_days_per_year));
      res.status(201).json({ message: 'ลงทะเบียนสำเร็จ', id: result.lastInsertRowid });
    } catch (e) {
      if (String(e).includes('UNIQUE')) {
        return res.status(409).json({ message: 'รหัสพนักงานหรืออีเมลซ้ำ' });
      }
      res.status(500).json({ message: e.message });
    }
  });

  // POST /api/auth/logout — ล้าง session (JWT stateless → client ล้าง token เอง; endpoint นี้เพื่อ audit log)
  router.post('/logout', (req, res) => {
    // JWT ไม่มี server-side session — แค่ acknowledge คำขอ
    res.json({ message: 'ออกจากระบบสำเร็จ' });
  });

  // GET /api/auth/me — ข้อมูลผู้ใช้ปัจจุบัน (รวม employee_type ล่าสุดจาก DB)
  router.get('/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'Unauthorized' });
    try {
      const token = authHeader.split(' ')[1];
      const payload = require('jsonwebtoken').verify(token, JWT_SECRET);
      const user = db.prepare('SELECT id,employee_id,name,email,role,department,division,unit,employee_type,probation_start_date FROM users WHERE id=?').get(payload.id);
      if (!user) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });
      res.json({ id: user.id, employee_id: user.employee_id, name: user.name, role: user.role, employee_type: user.employee_type || 'monthly', probation_start_date: user.probation_start_date || null });
    } catch(e) {
      res.status(401).json({ message: 'Token ไม่ถูกต้อง' });
    }
  });

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    const token = jwt.sign(
      { id: user.id, employee_id: user.employee_id, name: user.name, role: user.role, department: user.department, division: user.division, unit: user.unit },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, user: { id: user.id, employee_id: user.employee_id, name: user.name, role: user.role, employee_type: user.employee_type || 'monthly', probation_start_date: user.probation_start_date || null } });
  });

  return router;
};
