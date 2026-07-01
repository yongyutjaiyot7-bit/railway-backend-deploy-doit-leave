const express = require('express');
const path = require('path');
const fs = require('fs');
const { authenticate, authorize, authorizeOrPerm } = require('../middleware/auth');
const { upload, UPLOAD_DIR } = require('../middleware/upload');
const notifier = require('../utils/notifier');

module.exports = function (db) {
  const router = express.Router();

  function generateRequestNo() {
    const d = new Date();
    const prefix = `LV${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${prefix}${String(Math.floor(Math.random() * 9000) + 1000)}`;
  }

  // Reference working Saturday for monthly employees (alternate Saturdays)
  // 2026-01-10 is the reference working Saturday (2026-01-03 is holiday_sat)
  const WORKING_SAT_REF = new Date('2026-01-10T00:00:00');

  function isWorkingSaturday(d) {
    const pad = n => String(n).padStart(2,'0');
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    // ตรวจ DB ก่อน — override pattern
    try {
      const row = db.prepare('SELECT type FROM work_schedule WHERE date=?').get(dateStr);
      if (row) return row.type === 'working_sat';
    } catch(e) {}
    // fallback: alternating pattern
    const ref = new Date(WORKING_SAT_REF.getFullYear(), WORKING_SAT_REF.getMonth(), WORKING_SAT_REF.getDate());
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((target - ref) / 86400000);
    return diffDays % 14 === 0;
  }

  // Returns max work hours for a given date based on employee type
  function getWorkHoursForDay(dateStr, empType, probStartStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = d.getDay(); // 0=Sun, 1=Mon … 6=Sat
    if (dow === 0) return 0; // อาทิตย์ไม่ทำงาน
    // วันหยุดประเพณีบริษัท
    try {
      const hol = db.prepare('SELECT id FROM company_holidays WHERE date=?').get(dateStr);
      if (hol) return 0;
    } catch(e) {}

    if (empType === 'daily') {
      // รายวัน: จ-พฤ 9:00-18:00 หักพัก 1h = 8h, ศ-ส 8:00-17:00 หักพัก 1h = 8h
      return 8;
    }

    if (empType === 'housekeeping') {
      const passedProbation = probStartStr
        ? (new Date(dateStr + 'T00:00:00') - new Date(probStartStr + 'T00:00:00')) / 86400000 >= 120
        : false;
      if (passedProbation) {
        // แม่บ้านประจำ: จ-ศ 7:00-17:00 = 9h, ส = 3h
        if (dow <= 5) return 9;
        return 3;
      } else {
        // แม่บ้านทดลองงาน: จ-ส 7:00-16:00 = 8h (ทุกวัน)
        return 8;
      }
    }

    // monthly: จ-พฤ 8:00-18:00 หักพัก 1h = 9h, ศ 8:00-17:00 หักพัก 1h = 8h, ส 8:00-12:00 ไม่ทับพัก = 4h
    if (dow <= 4) return 9;
    if (dow === 5) return 8;
    return isWorkingSaturday(d) ? 4 : 0;
  }

  // Calculate leave hours and days based on employee type
  // For single-day: actual time range capped at max work hours for that day
  // For multi-day: sum full work hours per day in range
  function calcLeaveResult(startDate, endDate, startDt, endDt, empType, probStart) {
    const start = new Date(startDate + 'T00:00:00');
    const end   = new Date(endDate + 'T00:00:00');
    let totalHours = 0;
    let totalDays  = 0;

    const cur = new Date(start);
    while (cur <= end) {
      const pad = n => String(n).padStart(2, '0');
      const dateStr = `${cur.getFullYear()}-${pad(cur.getMonth()+1)}-${pad(cur.getDate())}`;
      const maxH = getWorkHoursForDay(dateStr, empType, probStart);

      if (maxH > 0) {
        if (startDate === endDate) {
          // ลาวันเดียว: ใช้เวลาจริง
          const actualH = (new Date(endDt) - new Date(startDt)) / 3600000;
          const h = Math.min(Math.max(0, actualH), maxH);
          totalHours += h;
          totalDays  += Math.max(0.5, Math.round((h / maxH) * 2) / 2);
        } else {
          // หลายวัน: นับเต็มวันทำงานต่อวัน
          totalHours += maxH;
          totalDays  += maxH < 5 ? 0.5 : 1; // เสาร์ 4h หรือ 3h = 0.5 วัน
        }
      }
      cur.setDate(cur.getDate() + 1);
    }

    return { hours: totalHours, days: Math.max(0.5, totalDays) };
  }

  // Format days for display
  function fmtDays(days, hours) {
    if (days >= 1) return `${days} วัน`;
    const h = Math.round(hours * 10) / 10;
    return `${h} ชั่วโมง`;
  }

  function approvalLevel(role) {
    if (role === 'unit_head' || role === 'department_head') return 1;
    if (role === 'division_manager' || role === 'hr_admin') return 2;
    return 0;
  }

  // GET /api/leave/types
  router.get('/types', authenticate, (req, res) => {
    res.json(db.prepare(`SELECT id, code, name, max_days_per_year, requires_document,
      COALESCE(requires_doc_over_days,0) as requires_doc_over_days,
      COALESCE(advance_days,0)  as advance_days,
      COALESCE(backdate_days,0) as backdate_days
      FROM leave_types ORDER BY id`).all());
  });

  // GET /api/leave/departments — รายชื่อแผนก/หน่วยงานทั้งหมด
  router.get('/departments', authenticate, (req, res) => {
    const depts = db.prepare(`SELECT DISTINCT department FROM users WHERE department != '' ORDER BY department`).all().map(r => r.department);
    const units = db.prepare(`SELECT DISTINCT unit FROM users WHERE unit != '' ORDER BY unit`).all().map(r => r.unit);
    res.json({ departments: depts, units });
  });

  // GET /api/leave/approvers — รายชื่อผู้อนุมัติแต่ละระดับ (2 ระดับ)
  router.get('/approvers', authenticate, (req, res) => {
    const level1 = db.prepare(`SELECT id, employee_id, name, department, division, unit FROM users WHERE role IN ('unit_head','department_head','division_manager','hr_admin') ORDER BY name`).all();
    const level2 = db.prepare(`SELECT id, employee_id, name, department, division, unit FROM users WHERE role IN ('department_head','division_manager','hr_admin') ORDER BY name`).all();
    res.json({ level1, level2 });
  });

  // GET /api/leave/balance
  router.get('/balance', authenticate, (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    // ดึงทุกประเภทลา LEFT JOIN balance เพื่อให้แสดงแม้ยังไม่มี record
    const rows = db.prepare(`
      SELECT lt.id as leave_type_id, lt.name as leave_type_name, lt.max_days_per_year as total_days,
             COALESCE(lb.used_days, 0) as used_days,
             COALESCE(lb.id, NULL) as id, lb.year
      FROM leave_types lt
      LEFT JOIN leave_balances lb ON lb.leave_type_id = lt.id
        AND lb.employee_id = ? AND lb.year = ?
      WHERE lt.max_days_per_year > 0
      ORDER BY lt.code, lt.name
    `).all(req.user.id, year);
    res.json(rows);
  });

  // POST /api/leave/request  (multipart/form-data — รองรับไฟล์แนบ)
  router.post('/request', authenticate, upload.array('attachments', 5), (req, res) => {
    const { leave_type_id, start_date, end_date, start_datetime, end_datetime, reason, allow_unpaid } = req.body;
    if (!leave_type_id || !start_date || !end_date) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    if (!reason || !reason.trim()) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ message: 'กรุณาระบุเหตุผลการลา' });
    }

    // ดึงข้อมูลประเภทลาก่อนเพื่อใช้ตรวจสอบกฎ
    const leaveTypeMeta = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(leave_type_id);
    const ltAdvanceDays  = leaveTypeMeta?.advance_days  ?? 0; // 0 = ไม่จำกัด
    const ltBackdateDays = leaveTypeMeta?.backdate_days ?? 0; // 0 = ไม่อนุญาต

    const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
    const startDateObj  = new Date(start_date + 'T00:00:00');
    const isBackdated   = startDateObj < todayMidnight;
    const daysAhead     = Math.round((startDateObj - todayMidnight) / 86400000);
    const daysBehind    = Math.round((todayMidnight - startDateObj) / 86400000);

    if (isBackdated) {
      if (ltBackdateDays === 0) {
        // ไม่อนุญาตย้อนหลัง
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ message: `"${leaveTypeMeta?.name}" ไม่สามารถยื่นย้อนหลังได้ กรุณาติดต่อ HR Admin` });
      }
      if (daysBehind > ltBackdateDays) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ message: `"${leaveTypeMeta?.name}" ย้อนหลังได้ไม่เกิน ${ltBackdateDays} วัน (ย้อนหลัง ${daysBehind} วัน)` });
      }
    } else {
      // ล่วงหน้า
      if (ltAdvanceDays > 0 && daysAhead > ltAdvanceDays) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ message: `"${leaveTypeMeta?.name}" ยื่นล่วงหน้าได้ไม่เกิน ${ltAdvanceDays} วัน (ล่วงหน้า ${daysAhead} วัน)` });
      }
    }

    // ตรวจสอบเงื่อนไข "ลาเกิน N วัน ต้องแนบเอกสาร"
    const overLimit = leaveTypeMeta?.requires_doc_over_days || 0;
    // (days จะถูกคำนวณด้านล่าง ณ จุดนี้ใช้ค่าคร่าวๆ จากวันที่)
    // ตรวจสอบหลังคำนวณ days จริง — ดำเนินการด้านล่างแทน

    // ดึงประเภทพนักงานสำหรับคำนวณชั่วโมงทำงาน
    const userInfo  = db.prepare('SELECT employee_type, probation_start_date FROM users WHERE id = ?').get(req.user.id);
    const empType   = userInfo?.employee_type || 'monthly';
    const probStart = userInfo?.probation_start_date || null;

    // Use full datetime if provided (supports partial-day leave); fallback to date-only (whole day)
    const startDt = start_datetime || `${start_date}T09:00`;
    const endDt   = end_datetime   || `${end_date}T17:00`;
    const { hours, days } = calcLeaveResult(start_date, end_date, startDt, endDt, empType, probStart);
    if (hours <= 0) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ message: 'วันที่/เวลาไม่ถูกต้อง หรือไม่มีวันทำงานในช่วงที่เลือก' });
    }

    // ตรวจสอบ requires_doc_over_days หลังคำนวณ days จริงแล้ว
    if (overLimit > 0 && days >= overLimit && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ message: `การลา ${leaveTypeMeta?.name || ''} เกิน ${overLimit} วัน กรุณาแนบเอกสารประกอบการลา` });
    }

    const year = new Date(start_date).getFullYear();
    const balance = db.prepare(`
      SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?
    `).get(req.user.id, leave_type_id, year);

    if (!balance) return res.status(400).json({ message: 'ไม่มีข้อมูลโควต้าการลา' });
    const remain = balance.total_days - balance.used_days;

    // ลาเกินโควต้า: ถ้ายังไม่ได้ยืนยัน → ตอบกลับให้ frontend แสดง confirm dialog
    let isUnpaidExcess = 0;
    let unpaidExcessDays = 0;
    if (remain < days) {
      if (!allow_unpaid || allow_unpaid === 'false' || allow_unpaid === false) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        const remainDisp = Number.isInteger(remain) ? remain : remain.toFixed(1);
        const excessDisp = Number.isInteger(days - remain) ? (days - remain) : (days - remain).toFixed(1);
        return res.status(200).json({
          over_quota: true,
          remain: remainDisp,
          excess: excessDisp,
          leave_type_name: leaveTypeMeta?.name || '',
          message: `โควต้าคงเหลือ ${remainDisp} วัน — ลาเกิน ${excessDisp} วัน จะถือเป็น "ลาไม่รับค่าจ้าง"`
        });
      }
      // ผู้ใช้ยืนยันแล้ว → บันทึก flag
      isUnpaidExcess = 1;
      unpaidExcessDays = Math.max(0, days - remain);
    }

    const { approver1_id, approver2_id } = req.body;
    if (!approver1_id || !approver2_id) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ message: 'กรุณาเลือกผู้อนุมัติทุกระดับ' });
    }

    const request_no = generateRequestNo();
    const result = db.prepare(`
      INSERT INTO leave_requests (request_no, employee_id, leave_type_id, start_date, end_date, start_datetime, end_datetime, days, hours, reason, is_backdated, is_unpaid_excess, unpaid_excess_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(request_no, req.user.id, leave_type_id, start_date, end_date, startDt, endDt, days, hours, reason, isBackdated ? 1 : 0, isUnpaidExcess, unpaidExcessDays);
    const leaveId = result.lastInsertRowid;

    const insApproval = db.prepare('INSERT INTO approvals (leave_request_id, level, approver_id) VALUES (?, ?, ?)');
    insApproval.run(leaveId, 1, parseInt(approver1_id));
    insApproval.run(leaveId, 2, parseInt(approver2_id));

    // บันทึกไฟล์แนบ
    const insFile = db.prepare(`
      INSERT INTO leave_attachments (leave_request_id, filename, original_name, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?)
    `);
    (req.files || []).forEach(f => insFile.run(leaveId, f.filename, f.originalname, f.mimetype, f.size));

    const successMsg = isUnpaidExcess
      ? `ยื่นคำขอลาสำเร็จ — ลาเกินโควต้า ${unpaidExcessDays} วัน ถือเป็นลาไม่รับค่าจ้าง`
      : 'ยื่นคำขอลาสำเร็จ';
    res.status(201).json({ message: successMsg, request_no, leave_request_id: leaveId, days, hours, attachments: (req.files||[]).length, is_unpaid_excess: isUnpaidExcess, unpaid_excess_days: unpaidExcessDays });

    // แจ้งเตือนผู้อนุมัติระดับ 1 (fire-and-forget)
    try {
      const approver1 = db.prepare('SELECT name, email FROM users WHERE id = ?').get(parseInt(approver1_id));
      if (approver1) {
        notifier.notifyApproverNewRequest({
          approverEmail: approver1.email,
          approverName:  approver1.name,
          employeeName:  req.user.name,
          leaveType:     leaveTypeMeta?.name || '',
          startDate: start_date, endDate: end_date, days, hours, reason,
          requestNo: request_no,
        }).catch(e => console.error('[NOTIFY submit]', e.message));
      }
    } catch(e) { console.error('[NOTIFY submit]', e.message); }
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
      SELECT lr.*, COALESCE(lt.name,'(ไม่พบประเภทลา)') as leave_type_name
      FROM leave_requests lr
      LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
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
    const lr = db.prepare(`SELECT lr.*, lt.name as leave_type_name FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.id=? AND lr.employee_id=?`).get(req.params.id, req.user.id);
    if (!lr) return res.status(404).json({ message: 'ไม่พบคำขอลา' });
    if (lr.status !== 'pending') return res.status(400).json({ message: 'ไม่สามารถยกเลิกได้' });
    db.prepare("UPDATE leave_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(lr.id);
    try {
      db.prepare(`INSERT INTO delete_logs (action, table_name, record_id, record_summary, deleted_by_user_id, deleted_by_name, deleted_by_email, deleted_by_role, ip_address)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('CANCEL_LEAVE_REQUEST', 'leave_requests', String(lr.id),
          `${lr.request_no} ${lr.leave_type_name} ${lr.start_date}–${lr.end_date} ${lr.days}วัน`,
          req.user.id, req.user.name || '', req.user.email || '', req.user.role || '', req.ip || '');
    } catch(_) {}
    res.json({ message: 'ยกเลิกคำขอลาสำเร็จ' });
  });

  // GET /api/leave/pending
  router.get('/pending', authenticate, authorizeOrPerm(db, 'can_view_all_requests', 'unit_head', 'department_head', 'division_manager', 'hr_admin'), (req, res) => {
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
        JOIN approvals a ON a.leave_request_id = lr.id AND a.level = 2
        WHERE lr.status = 'approved_l1' AND a.status = 'pending'
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
            (a.level = 2 AND lr.status = 'approved_l1')
          )
        ORDER BY lr.created_at ASC
      `).all(req.user.id);
    }

    res.json(rows);
  });

  // POST /api/leave/approve/:approvalId
  router.post('/approve/:approvalId', authenticate, authorizeOrPerm(db, 'can_view_all_requests', 'unit_head', 'department_head', 'division_manager', 'hr_admin'), (req, res) => {
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

    try {
      db.prepare(`
        UPDATE approvals SET status = ?, approver_id = ?, comment = ?, acted_at = datetime('now') WHERE id = ?
      `).run(action === 'approve' ? 'approved' : 'rejected', req.user.id, comment || null, approval.id);

      if (action === 'reject') {
        db.prepare("UPDATE leave_requests SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(lr.id);
        db.prepare(`UPDATE approvals SET status = 'rejected', acted_at = datetime('now') WHERE leave_request_id = ? AND status = 'pending' AND id != ?`)
          .run(lr.id, approval.id);
      } else {
        const priorPending = db.prepare(
          'SELECT * FROM approvals WHERE leave_request_id = ? AND level < ? AND status = ? AND approver_id = ?'
        ).all(lr.id, approval.level, 'pending', req.user.id);
        priorPending.forEach(pa => {
          db.prepare(`UPDATE approvals SET status = 'approved', approver_id = ?, comment = ?, acted_at = datetime('now') WHERE id = ?`)
            .run(req.user.id, comment || null, pa.id);
        });

        const laterSame = db.prepare(
          'SELECT * FROM approvals WHERE leave_request_id = ? AND level > ? AND status = ? AND approver_id = ?'
        ).all(lr.id, approval.level, 'pending', req.user.id);
        laterSame.forEach(la => {
          db.prepare(`UPDATE approvals SET status = 'approved', approver_id = ?, comment = ?, acted_at = datetime('now') WHERE id = ?`)
            .run(req.user.id, comment || null, la.id);
        });

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
          db.prepare(`UPDATE approvals SET status = 'approved', acted_at = COALESCE(acted_at, datetime('now')) WHERE leave_request_id = ? AND status = 'pending'`)
            .run(lr.id);
        } else if (maxApprovedLevel === 1) {
          newStatus = 'approved_l1';
        } else {
          newStatus = 'approved_l1';
        }
        db.prepare("UPDATE leave_requests SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, lr.id);
      }

      res.json({ message: action === 'approve' ? 'อนุมัติสำเร็จ' : 'ปฏิเสธสำเร็จ' });

      // แจ้งเตือน (fire-and-forget)
      try {
        const emp  = db.prepare('SELECT name, email FROM users WHERE id = ?').get(lr.employee_id);
        const lt2  = db.prepare('SELECT name FROM leave_types WHERE id = ?').get(lr.leave_type_id);
        const ltName = lt2?.name || '';
        if (action === 'reject') {
          // แจ้งพนักงานว่าถูกปฏิเสธ
          if (emp) notifier.notifyEmployeeApprovalResult({
            employeeEmail: emp.email, employeeName: emp.name,
            approverName: req.user.name, action: 'reject',
            leaveType: ltName, startDate: lr.start_date, endDate: lr.end_date,
            days: lr.days, hours: lr.hours, comment: comment || '',
            requestNo: lr.request_no,
          }).catch(e => console.error('[NOTIFY reject]', e.message));
        } else {
          // ดึงสถานะใหม่จาก DB
          const updatedLr = db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(lr.id);
          if (updatedLr?.status === 'approved') {
            // อนุมัติครบแล้ว → แจ้งพนักงาน
            if (emp) notifier.notifyEmployeeApprovalResult({
              employeeEmail: emp.email, employeeName: emp.name,
              approverName: req.user.name, action: 'approve',
              leaveType: ltName, startDate: lr.start_date, endDate: lr.end_date,
              days: lr.days, hours: lr.hours, comment: comment || '',
              requestNo: lr.request_no,
            }).catch(e => console.error('[NOTIFY approve]', e.message));
          } else if (updatedLr?.status === 'approved_l1') {
            // ผ่านระดับ 1 → แจ้งผู้อนุมัติระดับ 2
            const ap2 = db.prepare('SELECT u.name, u.email FROM approvals a JOIN users u ON u.id=a.approver_id WHERE a.leave_request_id=? AND a.level=2').get(lr.id);
            if (ap2) notifier.notifyApproverLevel2({
              approverEmail: ap2.email, approverName: ap2.name,
              employeeName: emp?.name || '', leaveType: ltName,
              startDate: lr.start_date, endDate: lr.end_date,
              days: lr.days, hours: lr.hours, reason: lr.reason,
              requestNo: lr.request_no,
            }).catch(e => console.error('[NOTIFY level2]', e.message));
          }
        }
      } catch(e) { console.error('[NOTIFY approve]', e.message); }
    } catch (e) {
      console.error('approve error:', e);
      res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + e.message });
    }
  });

  // GET /api/leave/history
  router.get('/history', authenticate, authorizeOrPerm(db, 'can_view_all_requests', 'unit_head', 'department_head', 'division_manager', 'hr_admin'), (req, res) => {
    const rows = db.prepare(`
      SELECT lr.request_no, lr.start_date, lr.end_date, lr.days, lr.reason, lr.status as lr_status,
        lt.name as leave_type_name,
        u.name as employee_name, u.employee_id as emp_code,
        a.id as approval_id, a.level as approval_level, a.status as approval_status,
        a.comment, a.acted_at
      FROM approvals a
      JOIN leave_requests lr ON lr.id = a.leave_request_id
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN users u ON u.id = lr.employee_id
      WHERE a.approver_id = ? AND a.status != 'pending'
      ORDER BY a.acted_at DESC
      LIMIT 200
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
  router.get('/report', authenticate, authorizeOrPerm(db, 'can_view_report', 'department_head', 'division_manager', 'hr_admin'), (req, res) => {
    const { department, year } = req.query;
    const y = year && !isNaN(parseInt(year)) ? String(parseInt(year)) : null;
    let sql = `
      SELECT lr.*, lt.name as leave_type_name, u.name as employee_name,
        u.employee_id as emp_code, u.department, u.division
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN users u ON u.id = lr.employee_id
      WHERE lr.status NOT IN ('cancelled')
    `;
    const params = [];
    if (y) { sql += ' AND strftime(\'%Y\', lr.start_date) = ?'; params.push(y); }
    if (department) { sql += ' AND u.department = ?'; params.push(department); }
    sql += ' ORDER BY lr.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  });

  // GET /api/leave/company-holidays?year=YYYY — วันหยุดประเพณีบริษัท (ทุกคนเข้าได้)
  router.get('/company-holidays', authenticate, (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    try {
      const rows = db.prepare('SELECT date, name FROM company_holidays WHERE date LIKE ? ORDER BY date').all(`${year}%`);
      res.json(rows);
    } catch(e) { res.json([]); }
  });

  // GET /api/leave/work-schedule?year=YYYY — ข้อมูลวันทำงาน/หยุดสำหรับปฏิทิน (ทุกคนเข้าได้)
  router.get('/work-schedule', authenticate, (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    try {
      const rows = db.prepare('SELECT date, type, note FROM work_schedule WHERE date LIKE ? ORDER BY date').all(`${year}%`);
      res.json(rows);
    } catch(e) { res.json([]); }
  });

  return router;
};
