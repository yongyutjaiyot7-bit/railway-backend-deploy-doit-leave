const bcrypt = require('bcryptjs');
const { initDb } = require('./database');

const users = [
  { employee_id: 'EMP001', name: 'สมชาย ใจดี',    email: 'emp001@company.com', role: 'employee',         department: 'บัญชี', division: 'การเงิน', unit: 'หน่วยบัญชี1' },
  { employee_id: 'EMP002', name: 'สมหญิง รักดี',   email: 'emp002@company.com', role: 'employee',         department: 'บัญชี', division: 'การเงิน', unit: 'หน่วยบัญชี1' },
  { employee_id: 'UH001',  name: 'วิชัย หัวหน้า',  email: 'uh001@company.com',  role: 'unit_head',        department: 'บัญชี', division: 'การเงิน', unit: 'หน่วยบัญชี1' },
  { employee_id: 'DH001',  name: 'มานี แผนก',      email: 'dh001@company.com',  role: 'department_head',  department: 'บัญชี', division: 'การเงิน', unit: 'หัวหน้าแผนก' },
  { employee_id: 'DM001',  name: 'ประยุทธ ฝ่าย',   email: 'dm001@company.com',  role: 'division_manager', department: 'บัญชี', division: 'การเงิน', unit: 'ผู้จัดการฝ่าย' },
  { employee_id: 'HR001',  name: 'นิชา ทรัพยากร',  email: 'hr001@company.com',  role: 'hr_admin',         department: 'HR',    division: 'สนับสนุน', unit: 'HR' },
];

async function seed() {
  const db = await initDb();
  const hash = bcrypt.hashSync('password123', 10);
  const year = new Date().getFullYear();
  const leaveTypes = db.prepare('SELECT * FROM leave_types').all();

  users.forEach(u => {
    try {
      const r = db.prepare(`
        INSERT OR IGNORE INTO users (employee_id, name, email, password, role, department, division, unit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(u.employee_id, u.name, u.email, hash, u.role, u.department, u.division, u.unit);

      const uid = r.lastInsertRowid || db.prepare('SELECT id FROM users WHERE employee_id = ?').get(u.employee_id).id;
      leaveTypes.forEach(lt => {
        db.prepare('INSERT OR IGNORE INTO leave_balances (employee_id, leave_type_id, year, total_days) VALUES (?, ?, ?, ?)').run(uid, lt.id, year, lt.max_days_per_year);
      });
    } catch (e) { console.error(u.employee_id, e.message); }
  });

  console.log('Seed สำเร็จ — รหัสผ่านทุกคน: password123');
  console.log('Users:');
  users.forEach(u => console.log(`  ${u.employee_id} | ${u.role.padEnd(18)} | ${u.email}`));
  process.exit(0);
}

seed();
