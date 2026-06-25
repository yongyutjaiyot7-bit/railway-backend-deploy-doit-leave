/**
 * ระบบแจ้งเตือน — LINE Notify + Email (Nodemailer)
 *
 * ตั้งค่าผ่าน Environment Variables:
 *   LINE_NOTIFY_TOKEN   — token จาก https://notify-bot.line.me/th/
 *   EMAIL_HOST          — SMTP host (smtp.gmail.com)
 *   EMAIL_PORT          — SMTP port (587)
 *   EMAIL_USER          — อีเมลผู้ส่ง
 *   EMAIL_PASS          — App Password (Gmail) หรือ SMTP password
 *   EMAIL_FROM_NAME     — ชื่อผู้ส่ง (default: ระบบลาออนไลน์)
 */

const https      = require('https');
const nodemailer = require('nodemailer');

// ── ตรวจสอบ config จาก env ──────────────────────────────────────────────────

function lineEnabled() { return !!process.env.LINE_NOTIFY_TOKEN; }

function emailEnabled() {
  return !!(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

// ── LINE Notify ──────────────────────────────────────────────────────────────

/**
 * ส่งข้อความ LINE Notify
 * @param {string} message  ข้อความ (รองรับ newline \n)
 */
function sendLine(message) {
  if (!lineEnabled()) return Promise.resolve({ skipped: true });

  return new Promise((resolve, reject) => {
    const body = `message=${encodeURIComponent(message)}`;
    const options = {
      hostname: 'notify-api.line.me',
      path:     '/api/notify',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bearer ${process.env.LINE_NOTIFY_TOKEN}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('[LINE] ส่งแจ้งเตือนสำเร็จ');
          resolve({ ok: true });
        } else {
          console.warn(`[LINE] Error ${res.statusCode}: ${data}`);
          resolve({ ok: false, status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[LINE] Request error:', e.message);
      resolve({ ok: false, error: e.message });
    });

    req.write(body);
    req.end();
  });
}

// ── Email (Nodemailer) ───────────────────────────────────────────────────────

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.EMAIL_PORT || '587'),
    secure: parseInt(process.env.EMAIL_PORT || '587') === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

/**
 * ส่ง Email แจ้งเตือน
 * @param {string}   to       อีเมลผู้รับ (คั่นด้วยลูกน้ำถ้าหลายคน)
 * @param {string}   subject  หัวข้อ
 * @param {string}   html     เนื้อหา HTML
 */
async function sendEmail(to, subject, html) {
  if (!emailEnabled()) return { skipped: true };
  try {
    const transporter = createTransporter();
    const fromName = process.env.EMAIL_FROM_NAME || 'ระบบลาออนไลน์';
    const info = await transporter.sendMail({
      from:    `"${fromName}" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`[EMAIL] ส่งสำเร็จ → ${to} (${info.messageId})`);
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error('[EMAIL] ส่งไม่สำเร็จ:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Helper: format วันที่ภาษาไทย ────────────────────────────────────────────

function thaiDate(dateStr) {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr.length === 10 ? dateStr + 'T00:00:00' : dateStr);
    return d.toLocaleDateString('th-TH', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: dateStr.length > 10 ? '2-digit' : undefined,
      minute: dateStr.length > 10 ? '2-digit' : undefined,
    });
  } catch { return dateStr; }
}

function daysLabel(days, hours) {
  if (days < 1 && hours > 0) return `${Math.round(hours * 10) / 10} ชั่วโมง`;
  return `${days} วัน`;
}

// ── Email Templates ──────────────────────────────────────────────────────────

function emailLayout(title, badgeColor, badgeText, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="th">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Sarabun',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:30px 10px">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.1);overflow:hidden;max-width:100%">
      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#1e3a5f,#2b6cb0);padding:28px 32px">
        <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:.5px">🏢 ระบบลาออนไลน์</div>
        <div style="font-size:14px;color:rgba(255,255,255,.8);margin-top:4px">${title}</div>
      </td></tr>
      <!-- Badge -->
      <tr><td style="padding:24px 32px 0">
        <span style="display:inline-block;background:${badgeColor};color:#fff;padding:5px 16px;border-radius:20px;font-size:13px;font-weight:700">${badgeText}</span>
      </td></tr>
      <!-- Body -->
      <tr><td style="padding:20px 32px 28px">${bodyHtml}</td></tr>
      <!-- Footer -->
      <tr><td style="background:#f7fafc;padding:16px 32px;border-top:1px solid #e2e8f0">
        <p style="margin:0;font-size:12px;color:#a0aec0">อีเมลนี้ส่งโดยอัตโนมัติจากระบบลาออนไลน์ — กรุณาอย่าตอบกลับ</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function infoRow(label, value) {
  return `<tr>
    <td style="padding:8px 12px;background:#f7fafc;font-size:13px;color:#718096;font-weight:600;white-space:nowrap;border-bottom:1px solid #edf2f7">${label}</td>
    <td style="padding:8px 12px;font-size:14px;color:#1a202c;border-bottom:1px solid #edf2f7">${value}</td>
  </tr>`;
}

// ── Notification Composers ───────────────────────────────────────────────────

/**
 * แจ้งเตือนผู้อนุมัติ: มีคำขอลาใหม่รอตรวจสอบ
 */
async function notifyApproverNewRequest({ approverEmail, approverName, employeeName, leaveType, startDate, endDate, days, hours, reason, requestNo }) {
  const daysTxt = daysLabel(days, hours);
  const startTxt = thaiDate(startDate);
  const endTxt   = thaiDate(endDate);

  // LINE
  const lineMsg = [
    '🔔 มีคำขอลาใหม่รอการพิจารณา',
    `──────────────────`,
    `👤 พนักงาน: ${employeeName}`,
    `🏷️ ประเภท: ${leaveType}`,
    `📅 วันที่: ${startTxt}${startDate !== endDate ? ` ถึง ${endTxt}` : ''}`,
    `⏱ จำนวน: ${daysTxt}`,
    `💬 เหตุผล: ${reason}`,
    `📄 เลขที่: ${requestNo}`,
    `──────────────────`,
    `กรุณาเข้าระบบเพื่อพิจารณาคำขอ`,
  ].join('\n');

  // Email
  const bodyHtml = `
    <p style="font-size:15px;color:#2d3748;margin:0 0 16px">เรียน <strong>${approverName}</strong></p>
    <p style="font-size:14px;color:#4a5568;margin:0 0 18px">
      มีคำขอลาใหม่รอการพิจารณาจากท่าน กรุณาเข้าระบบเพื่อดำเนินการ
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
      ${infoRow('เลขที่คำขอ', `<b>${requestNo}</b>`)}
      ${infoRow('ชื่อพนักงาน', employeeName)}
      ${infoRow('ประเภทการลา', `<span style="background:#ebf8ff;color:#2c5282;padding:2px 10px;border-radius:20px;font-size:13px">${leaveType}</span>`)}
      ${infoRow('วันที่ลา', startDate === endDate ? startTxt : `${startTxt} — ${endTxt}`)}
      ${infoRow('จำนวน', `<b style="color:#1e3a5f;font-size:16px">${daysTxt}</b>`)}
      ${infoRow('เหตุผล', reason)}
    </table>`;

  const html = emailLayout(
    'แจ้งเตือน: มีคำขอลาใหม่รอพิจารณา',
    '#2b6cb0', '🔔 คำขอใหม่',
    bodyHtml
  );

  return Promise.all([
    sendLine(lineMsg),
    approverEmail ? sendEmail(approverEmail, `[ระบบลา] คำขอลาใหม่ — ${employeeName} (${leaveType})`, html) : Promise.resolve({ skipped: true }),
  ]);
}

/**
 * แจ้งเตือนพนักงาน: คำขอได้รับการอนุมัติ/ปฏิเสธ
 */
async function notifyEmployeeApprovalResult({ employeeEmail, employeeName, approverName, action, leaveType, startDate, endDate, days, hours, comment, requestNo }) {
  const isApproved = action === 'approved';
  const daysTxt    = daysLabel(days, hours);
  const startTxt   = thaiDate(startDate);
  const endTxt     = thaiDate(endDate);

  const icon    = isApproved ? '✅' : '❌';
  const statusTh = isApproved ? 'อนุมัติแล้ว' : 'ปฏิเสธ';
  const badgeColor = isApproved ? '#276749' : '#c53030';

  // LINE
  const lineMsg = [
    `${icon} คำขอลาของคุณได้รับการ${statusTh}`,
    `──────────────────`,
    `📄 เลขที่: ${requestNo}`,
    `🏷️ ประเภท: ${leaveType}`,
    `📅 วันที่: ${startTxt}${startDate !== endDate ? ` ถึง ${endTxt}` : ''}`,
    `⏱ จำนวน: ${daysTxt}`,
    `👤 ผู้ดำเนินการ: ${approverName}`,
    comment ? `💬 หมายเหตุ: ${comment}` : null,
    `──────────────────`,
    `ดูรายละเอียดได้ที่ระบบลาออนไลน์`,
  ].filter(Boolean).join('\n');

  // Email
  const bodyHtml = `
    <p style="font-size:15px;color:#2d3748;margin:0 0 16px">เรียน <strong>${employeeName}</strong></p>
    <p style="font-size:14px;color:#4a5568;margin:0 0 18px">
      คำขอลาของท่านได้รับการ<strong style="color:${badgeColor}">${statusTh}</strong>แล้ว
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
      ${infoRow('เลขที่คำขอ', `<b>${requestNo}</b>`)}
      ${infoRow('ประเภทการลา', `<span style="background:#ebf8ff;color:#2c5282;padding:2px 10px;border-radius:20px;font-size:13px">${leaveType}</span>`)}
      ${infoRow('วันที่ลา', startDate === endDate ? startTxt : `${startTxt} — ${endTxt}`)}
      ${infoRow('จำนวน', `<b style="color:#1e3a5f;font-size:16px">${daysTxt}</b>`)}
      ${infoRow('ผู้ดำเนินการ', approverName)}
      ${infoRow('สถานะ', `<b style="color:${badgeColor}">${icon} ${statusTh}</b>`)}
      ${comment ? infoRow('หมายเหตุ', comment) : ''}
    </table>`;

  const html = emailLayout(
    `แจ้งผลการพิจารณาคำขอลา`,
    badgeColor, `${icon} ${statusTh}`,
    bodyHtml
  );

  const subject = `[ระบบลา] คำขอลา${statusTh} — ${leaveType} (${requestNo})`;

  return Promise.all([
    sendLine(lineMsg),
    employeeEmail ? sendEmail(employeeEmail, subject, html) : Promise.resolve({ skipped: true }),
  ]);
}

/**
 * แจ้งผู้อนุมัติระดับ 2: คำขอผ่าน Level 1 แล้ว รอ Level 2
 */
async function notifyApproverLevel2({ approverEmail, approverName, employeeName, leaveType, startDate, endDate, days, hours, reason, requestNo }) {
  const daysTxt  = daysLabel(days, hours);
  const startTxt = thaiDate(startDate);
  const endTxt   = thaiDate(endDate);

  const lineMsg = [
    '🔔 คำขอลาผ่านการตรวจสอบ รอการอนุมัติจากท่าน',
    `──────────────────`,
    `👤 พนักงาน: ${employeeName}`,
    `🏷️ ประเภท: ${leaveType}`,
    `📅 วันที่: ${startTxt}${startDate !== endDate ? ` ถึง ${endTxt}` : ''}`,
    `⏱ จำนวน: ${daysTxt}`,
    `💬 เหตุผล: ${reason}`,
    `📄 เลขที่: ${requestNo}`,
    `──────────────────`,
    `กรุณาเข้าระบบเพื่ออนุมัติขั้นสุดท้าย`,
  ].join('\n');

  const bodyHtml = `
    <p style="font-size:15px;color:#2d3748;margin:0 0 16px">เรียน <strong>${approverName}</strong></p>
    <p style="font-size:14px;color:#4a5568;margin:0 0 18px">
      คำขอลาต่อไปนี้ <strong>ผ่านการตรวจสอบระดับแรกแล้ว</strong> และรอการอนุมัติจากท่าน
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
      ${infoRow('เลขที่คำขอ', `<b>${requestNo}</b>`)}
      ${infoRow('ชื่อพนักงาน', employeeName)}
      ${infoRow('ประเภทการลา', `<span style="background:#ebf8ff;color:#2c5282;padding:2px 10px;border-radius:20px;font-size:13px">${leaveType}</span>`)}
      ${infoRow('วันที่ลา', startDate === endDate ? startTxt : `${startTxt} — ${endTxt}`)}
      ${infoRow('จำนวน', `<b style="color:#1e3a5f;font-size:16px">${daysTxt}</b>`)}
      ${infoRow('เหตุผล', reason)}
    </table>`;

  const html = emailLayout(
    'แจ้งเตือน: คำขอลารอการอนุมัติขั้นสุดท้าย',
    '#d69e2e', '⏳ รอการอนุมัติ',
    bodyHtml
  );

  return Promise.all([
    sendLine(lineMsg),
    approverEmail ? sendEmail(approverEmail, `[ระบบลา] รออนุมัติขั้นสุดท้าย — ${employeeName} (${leaveType})`, html) : Promise.resolve({ skipped: true }),
  ]);
}

module.exports = {
  sendLine,
  sendEmail,
  notifyApproverNewRequest,
  notifyEmployeeApprovalResult,
  notifyApproverLevel2,
  lineEnabled,
  emailEnabled,
};
