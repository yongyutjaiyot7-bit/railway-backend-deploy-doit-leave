const express = require('express');
const path = require('path');
const fs = require('fs');
const { authenticate, authorize } = require('../middleware/auth');
const { upload, UPLOAD_DIR } = require('../middleware/upload');

module.exports = function (db) {
  const router = express.Router();

  function generateRequestNo() {
    const d = new Date();
    const prefix = `LV${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${prefix}${String(Math.floor(Math.random() * 9000) + 1000)}`;
  }

  function calcDays(start, end) {
    return Math.floor((new Date(end) - new Date(start)) / 86400000) + 1;
  }

  function approvalLevel(role) {
    if (role === 'unit_head') return 1;
    if (role === 'department_head') return 2;
    if (role === 'division_manager' || role === 'hr_admin') return 3;
    return 0;
  }

  // GET /api/leave/types
  router.get('/types', authenticate, (req, res) => {
    res.json(db.prepare('SELECT * FROM leave_types').all());
  });

  // GET /api/leave/departments — รายชื่อแผนก/หน่วยงานทั้งหมด
  router.get('/departments', authenticate, (req, res) => {
    const depts = db.prepare(`SELECT DISTINCT department FROM users WHERE department != '' ORDER BY department`).all().map(r => r.department);
    const units = db.prepare(`SELECT DISTINCT unit FROM users WHERE unit != '' ORDER BY unit`).all().map(r => r.unit);
    res.json({ departments: depts, units });
  });

  // GET /api/leave/approvers — รายชื่อผู้อนุมัติแต่ละระดับ
  router.get('/approvers', authenticate, (req, res) => {
    const level1 = db.prepare(`SELECT id, employee_id, name, department, division, unit FROM users WHERE role = 'unit_head' ORDER BY name`).all();
    const level2 = db.prepare(`SELECT id, employee_id, name, department, division, unit FROM users WHERE role = 'department_head' ORDER BY name`).all();
    const level3 = db.prepare(`SELECT id, employee_id, name, department, division, unit FROM users WHERE role IN ('division_manager','hr_admin') ORDER BY name`).all();
    res.json({ level1, level2, level3 });
  });

  // GET /api/leave/balance
  router.get('/balance', authenticate, (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const rows = db.prepare(`
      SELECT lb.*, lt.name as leave_type_name
      FROM leave_balances lb
      JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.employee_id = ? AND lb.year = ?
    `).all(req.user.id, year);
    res.json(rows);
  });

  // POST /api/leave/request  (multipart/form-data — รองรับไฟล์แนบ)
  router.post('/request', authenticate, upload.array('attachments', 5), (req, res) => {
    const { leave_type_id, start_date, end_date, reason } = req.body;
    if (!leave_type_id || !start_date || !end_date || !reason) {
      // ลบไฟล์ที่อัปโหลดมาถ้า validate ไม่ผ่าน
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    const days = calcDays(start_date, end_date);
    if (days < 1) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ message: 'วันที่ไม่ถูกต้อง' });
    }

    const year = new Date(start_date).getFullYear();
    const balance = db.prepare(`
      SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?
    `).get(req.user.id, leave_type_id, year);

    if (!balance) return res.status(400).json({ message: 'ไม่มีข้อมูลโควต้าการลา' });
    if (balance.total_days - balance.used_days < days) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ message: `วันลาไม่เพียงพอ (คงเหลือ ${balance.total_days - balance.used_days} วัน)` });
    }

    const { approver1_id, approver2_id, approver3_id } = req.body;
    if (!approver1_id || !approver2_id || !approver3_id) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ message: 'กรุณาเลือกผู้อนุมัติทุกระดับ' });
    }

    const request_no = generateRequestNo();
    const result = db.prepare(`
      INSERT INTO leave_requests (request_no, employee_id, leave_type_id, start_date, end_date, days, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(request_no, req.user.id, leave_type_id, start_date, end_date, days, reason);
    const leaveId = result.lastInsertRowid;

    const insApproval = db.prepare('INSERT INTO approvals (leave_request_id, level, approver_id) VALUES (?, ?, ?)');
    insApproval.run(leaveId, 1, parseInt(approver1_id));
    insApproval.run(leaveId, 2, parseInt(approver2_id));
    insApproval.run(leaveId, 3, parseInt(approver3_id));

    // บันทึกไฟล์แนบ
    const insFile = db.prepare(`
      INSERT INTO leave_attachments (leave_request_id, filename, original_name, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?)
    `);
    (req.files || []).forEach(f => insFile.run(leaveId, f.filename, f.originalname, f.mimetype, f.size));

    res.status(201).json({ message: 'ยื่นคำขอลาสำเร็จ', request_no, leave_request_id: leaveId, attachments: (req.files||[]).length });
  });

  // POST /api/leave/request/:id/attachments — เพิ่มไฟล์แนบภายหลัง
  router.post('/request/:id/attachments', authenticate, upload.array('attachments', 5), (req, res) => {
    const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ? AND employee_id = ?').get(req.params.id, req.user.id);
    if (!lr) { (req.files||[]).forEach(f => fs.unlink(f.path, ()=>{})); return res.status(404).json({ message: 'ไม่พบคำขอลา' }); }
    const insFile = db.prepare(`INSERT INTO leave_attachments (leave_request_id, filename, original_name, mime_type, file_size) VALUES (?, ?, ?, ?, ?)`);
    (req.files||[]).forEach(f => insFile.run(lr.id, f.filename, f.originalname, f.mimetype, f.size));
    res.json({ message: 'เพิ่มไฟล์แนบสำเร็จ', count: (req.files||[]).length });
  });

  // DELETE /api/leave/attachment/:attachId — ลบไฟล์แนบ
  router.delete('/attachment/:attachId', authenticate, (req, res) => {
    const att = db.prepare('SELECT la.*, lr.employee_id FROM leave_attachments la JOIN leave_requests lr ON lr.id=la.leave_request_id WHERE la.id=?').get(req.params.attachId);
    if (!att) return res.status(404).json({ message: 'ไม่พบไฟล์' });
    if (att.employee_id !== req.user.id && req.user.role !== 'hr_admin') return res.status(403).json({ message: 'ไม่มีสิทธิ์ลบไฟล์นี้' });
    fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {});
    db.prepare('DELETE FROM leave_attachments WHERE id=?').run(att.id);
    res.json({ message: 'ลบไฟล์แนบสำเร็จ' });
  });

  // GET /api/leave/file/:filename — ดาวน์โหลดไฟล์
  router.get('/file/:filename', authenticate, (req, res) => {
    const att = db.prepare('SELECT la.*, lr.employee_id FROM leave_attachments la JOIN leave_requests lr ON lr.id=la.leave_request_id WHERE la.filename=?').get(req.params.filename);
    if (!att) return res.status(404).json({ message: 'ไม่พบไฟล์' });
    const isApprover = ['unit_head','department_head','division_manager','hr_admin'].includes(req.user.role);
    if (att.employee_id !== req.user.id && !isApprover) return res.status(403).json({ message: 'ไม่มีสิทธิ์เข้าถึงไฟล์' });
    const filePath = path.join(UPLOAD_DIR, att.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'ไม่พบไฟล์ในระบบ' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.original_name)}"`);
    res.sendFile(filePath);
  });

  // GET /api/leave/my-requests
  router.get('/my-requests', authenticate, (req, res) => {
    const requests = db.prepare(`
      SELECT lr.*, lt.name as leave_type_name
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.employee_id = ?
      ORDER BY lr.created_at DESC
    `).all(req.user.id);

    const rows = requests.map(r => {
      const approvals = db.prepare(`
        SELECT a.level, a.status, a.comment, a.acted_at, u.name as approver_name
        FROM approvals a LEFT JOIN users u ON u.id = a.approver_id
        WHERE a.leave_request_id = ?
        ORDER BY a.level
      `).all(r.id);
      const attachments = db.prepare('SELECT id, filename, original_name, file_size, mime_type FROM leave_attachments WHERE leave_request_id = ?').all(r.id);
      return { ...r, approvals, attachments };
    });

    res.json(rows);
  });

  // DELETE /api/leave/request/:id
  router.delete('/request/:id', authenticate, (req, res) => {
    const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ? AND employee_id = ?').get(req.params.id, req.user.id);
    if (!lr) return res.status(404).json({ message: 'ไม่พบคำขอลา' });
    if (lr.status !== 'pending') return res.status(400).json({ message: 'ไม่สามารถยกเลิกได้' });
    db.prepare("UPDATE leave_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(lr.id);
    res.json({ message: 'ยกเลิกคำขอลาสำเร็จ' });
  });

  // GET /api/leave/pending
  router.get('/pending', authenticate, authorize('unit_head', 'department_head', 'division_manager', 'hr_admin'), (req, res) => {
    // Query by approver_id directly so a user assigned as level-1 approver (even if their role is dept_head)
    // will still see the request — role-based level assumption breaks when the same user covers multiple levels.
    let rows;
    if (req.user.role === 'hr_admin') {
      rows = db.prepare(`
        SELECT lr.*, lt.name as leave_type_name,
          u.name as employee_name, u.employee_id as emp_code, u.department, u.division, u.unit,
          a.id as approval_id
        FROM leave_requests lr
        JOIN leave_types lt ON lt.id = lr.leave_type_id
        JOIN users u ON u.id = lr.employee_id
        JOIN approvals a ON a.leave_request_id = lr.id AND a.level = 3
        WHERE lr.status = 'approved_l2' AND a.status = 'pending'
        ORDER BY lr.created_at ASC
      `).all();
    } else {
      rows = db.prepare(`
        SELECT lr.*, lt.name as leave_type_name,
          u.name as employee_name, u.employee_id as emp_code, u.department, u.division, u.unit,
          a.id as approval_id, a.level as approval_level
        FROM leave_requests lr
        JOIN leave_types lt ON lt.id = lr.leave_type_id
        JOIN users u ON u.id = lr.employee_id
        JOIN approvals a ON a.leave_request_id = lr.id AND a.approver_id = ?
        WHERE a.status = 'pending'
          AND (
            (a.level = 1 AND lr.status = 'pending') OR
            (a.level = 2 AND lr.status = 'approved_l1') OR
            (a.level = 3 AND lr.status = 'approved_l2')
          )
        ORDER BY lr.created_at ASC
      `).all(req.user.id);
    }

    res.json(rows);
  });

  // POST /api/leave/approve/:approvalId
  router.post('/approve/:approvalId', authenticate, authorize('unit_head', 'department_head', 'division_manager', 'hr_admin'), (req, res) => {
    const { action, comment } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action ต้องเป็น approve หรือ reject' });
    }

    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.approvalId);
    if (!approval) return res.status(404).json({ message: 'ไม่พบรายการอนุมัติ' });
    if (approval.status !== 'pending') return res.status(400).json({ message: 'รายการนี้ดำเนินการไปแล้ว' });

    // Verify the approver is actually assigned to this approval slot (or is hr_admin)
    if (approval.approver_id !== req.user.id && req.user.role !== 'hr_admin') {
      return res.status(403).json({ message: 'ท่านไม่ใช่ผู้อนุมัติที่ได้รับมอบหมายสำหรับรายการนี้' });
    }

    const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(approval.leave_request_id);

    // Block if already in terminal state
    if (['approved', 'rejected', 'cancelled'].includes(lr.status)) {
      return res.status(400).json({ message: 'คำขอนี้ได้รับการดำเนินการเสร็จสิ้นแล้ว' });
    }

    // Block if a prior level is still pending and assigned to someone else
    if (approval.level > 1) {
      const prevApproval = db.prepare(
        'SELECT * FROM approvals WHERE leave_request_id = ? AND level = ?'
      ).get(lr.id, approval.level - 1);
      if (prevApproval && prevApproval.status === 'pending' && prevApproval.approver_id !== req.user.id) {
        return res.status(400).json({ message: 'คำขอยังอยู่ระหว่างรอการอนุมัติในขั้นตอนก่อนหน้า' });
      }
      // If prior level is pending and same person → auto-approve it first in the transaction below
    }

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE approvals SET status = ?, approver_id = ?, comment = ?, acted_at = datetime('now') WHERE id = ?
      `).run(action === 'approve' ? 'approved' : 'rejected', req.user.id, comment || null, approval.id);

      if (action === 'reject') {
        db.prepare("UPDATE leave_requests SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(lr.id);
        // Mark all other pending approvals for this request as skipped (cancelled)
        db.prepare(`UPDATE approvals SET status = 'rejected', acted_at = datetime('now') WHERE leave_request_id = ? AND status = 'pending' AND id != ?`)
          .run(lr.id, approval.id);
      } else {
        // Auto-approve any prior pending levels assigned to the same person
        const priorPending = db.prepare(
          'SELECT * FROM approvals WHERE leave_request_id = ? AND level < ? AND status = ? AND approver_id = ?'
        ).all(lr.id, approval.level, 'pending', req.user.id);
        priorPending.forEach(pa => {
          db.prepare(`UPDATE approvals SET status = 'approved', approver_id = ?, comment = ?, acted_at = datetime('now') WHERE id = ?`)
            .run(req.user.id, comment || null, pa.id);
        });

        // Auto-approve any SUBSEQUENT levels assigned to the same person
        const laterSame = db.prepare(
          'SELECT * FROM approvals WHERE leave_request_id = ? AND level > ? AND status = ? AND approver_id = ?'
        ).all(lr.id, approval.level, 'pending', req.user.id);
        laterSame.forEach(la => {
          db.prepare(`UPDATE approvals SET status = 'approved', approver_id = ?, comment = ?, acted_at = datetime('now') WHERE id = ?`)
            .run(req.user.id, comment || null, la.id);
        });

        // Determine new leave_request status based on highest approved level
        const allApprovals = db.prepare('SELECT * FROM approvals WHERE leave_request_id = ? ORDER BY level').all(lr.id);
        const maxApprovedLevel = allApprovals
          .filter(a => a.status === 'approved' || (a.id === approval.id))
          .reduce((max, a) => Math.max(max, a.level), 0);
        const totalLevels = allApprovals.length;

        let newStatus;
        if (maxApprovedLevel >= totalLevels) {
          newStatus = 'approved';
          const year = new Date(lr.start_date).getFullYear();
          db.prepare(`UPDATE leave_balances SET used_days = used_days + ? WHERE employee_id = ? AND leave_type_id = ? AND year = ?`)
            .run(lr.days, lr.employee_id, lr.leave_type_id, year);
        } else if (maxApprovedLevel === 2) {
          newStatus = 'approved_l2';
        } else if (maxApprovedLevel === 1) {
          newStatus = 'approved_l1';
        } else {
          newStatus = 'approved_l1';
        }
        db.prepare("UPDATE leave_requests SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, lr.id);
      }
    });

    tx();
    res.json({ message: action === 'approve' ? 'อนุมัติสำเร็จ' : 'ปฏิเสธสำเร็จ' });
  });

  // GET /api/leave/history
  router.get('/history', authenticate, authorize('unit_head', 'department_head', 'division_manager', 'hr_admin'), (req, res) => {
    const rows = db.prepare(`
      SELECT lr.*, lt.name as leave_type_name,
        u.name as employee_name, u.employee_id as emp_code,
        a.status as approval_status, a.comment, a.acted_at, a.level as approval_level
      FROM approvals a
      JOIN leave_requests lr ON lr.id = a.leave_request_id
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN users u ON u.id = lr.employee_id
      WHERE a.approver_id = ? AND a.status != 'pending'
      ORDER BY a.acted_at DESC
      LIMIT 100
    `).all(req.user.id);
    res.json(rows);
  });

  // GET /api/leave/calendar - ปฏิทินรวม (ผู้อนุมัติ/HR เห็นทุกคน, พนักงานเห็นตัวเอง)
  router.get('/calendar', authenticate, (req, res) => {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const mm = String(month).padStart(2, '0');
    const prefix = `${year}-${mm}`;

    const isManager = ['unit_head','department_head','division_manager','hr_admin'].includes(req.user.role);

    let sql = `
      SELECT lr.id, lr.request_no, lr.start_date, lr.end_date, lr.days,
             lr.status, lr.reason, lt.name as leave_type_name,
             u.name as employee_name, u.employee_id as emp_code,
             u.department, u.division, u.unit
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN users u ON u.id = lr.employee_id
      WHERE lr.status NOT IN ('rejected','cancelled')
        AND (lr.start_date LIKE ? OR lr.end_date LIKE ?
             OR (lr.start_date < ? AND lr.end_date > ?))
    `;
    const likePrefix = `${prefix}%`;
    const monthStart = `${prefix}-01`;
    const monthEnd   = `${prefix}-31`;
    const params = [likePrefix, likePrefix, monthStart, monthEnd];

    if (!isManager) {
      sql += ' AND lr.employee_id = ?';
      params.push(req.user.id);
    } else if (req.user.role === 'unit_head') {
      sql += ' AND u.unit = ?';
      params.push(req.user.unit);
    } else if (req.user.role === 'department_head') {
      sql += ' AND u.department = ?';
      params.push(req.user.department);
    } else if (req.user.role === 'division_manager') {
      sql += ' AND u.division = ?';
      params.push(req.user.division);
    }

    sql += ' ORDER BY lr.start_date ASC';
    res.json(db.prepare(sql).all(...params));
  });

  // GET /api/leave/report
  router.get('/report', authenticate, authorize('division_manager', 'hr_admin'), (req, res) => {
    const { department, year } = req.query;
    const y = String(parseInt(year) || new Date().getFullYear());
    let sql = `
      SELECT lr.*, lt.name as leave_type_name, u.name as employee_name,
        u.employee_id as emp_code, u.department, u.division
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN users u ON u.id = lr.employee_id
      WHERE strftime('%Y', lr.start_date) = ?
    `;
    const params = [y];
    if (department) { sql += ' AND u.department = ?'; params.push(department); }
    sql += ' ORDER BY lr.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  });

  return router;
};
