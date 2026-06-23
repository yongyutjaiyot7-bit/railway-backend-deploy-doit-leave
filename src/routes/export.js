const express = require('express');
const XLSX = require('xlsx');
const { authenticate, authorize } = require('../middleware/auth');

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                     'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

const STATUS_LABEL = {
  pending: 'รอตรวจสอบ', approved_l1: 'รอระดับอนุมัติ',
  approved: 'อนุมัติแล้ว', rejected: 'ปฏิเสธ', cancelled: 'ยกเลิก',
};

module.exports = function (db) {
  const router = express.Router();
  router.use(authenticate, authorize('division_manager', 'hr_admin'));

  function fetchData(year, department) {
    const y = String(parseInt(year) || new Date().getFullYear());
    let sql = `
      SELECT u.employee_id as รหัสพนักงาน, u.name as ชื่อ_นามสกุล,
             u.department as แผนก, u.division as ฝ่าย, u.unit as หน่วยงาน,
             lt.name as ประเภทการลา,
             lr.start_date as วันที่เริ่มลา, lr.end_date as วันที่สิ้นสุด,
             lr.days as จำนวนวัน, lr.reason as เหตุผล,
             lr.status as raw_status, lr.request_no as เลขที่คำขอ,
             lr.created_at as วันที่ยื่น
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN users u ON u.id = lr.employee_id
      WHERE strftime('%Y', lr.start_date) = ?
    `;
    const params = [y];
    if (department) { sql += ' AND u.department = ?'; params.push(department); }
    sql += ' ORDER BY lr.start_date ASC';
    const rows = db.prepare(sql).all(...params);
    return rows.map(r => ({ ...r, สถานะ: STATUS_LABEL[r.raw_status] || r.raw_status, raw_status: undefined }));
  }

  function buildSheet(data) {
    const headers = ['เลขที่คำขอ','รหัสพนักงาน','ชื่อ_นามสกุล','แผนก','ฝ่าย','หน่วยงาน',
                     'ประเภทการลา','วันที่เริ่มลา','วันที่สิ้นสุด','จำนวนวัน','เหตุผล','สถานะ','วันที่ยื่น'];
    const rows = data.map(r => headers.map(h => r[h] ?? ''));
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

    // column widths
    ws['!cols'] = [12,14,20,12,12,14,14,14,14,10,24,16,16].map(w => ({ wch: w }));

    // header style
    headers.forEach((_, i) => {
      const cell = XLSX.utils.encode_cell({ r: 0, c: i });
      if (!ws[cell]) return;
      ws[cell].s = {
        fill: { fgColor: { rgb: '1E3A5F' } },
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: { bottom: { style: 'thin', color: { rgb: 'CCCCCC' } } },
      };
    });

    // data row styles
    data.forEach((r, ri) => {
      const isEven = ri % 2 === 0;
      headers.forEach((_, ci) => {
        const cell = XLSX.utils.encode_cell({ r: ri + 1, c: ci });
        if (!ws[cell]) return;
        let fillColor = isEven ? 'F7FAFC' : 'FFFFFF';
        if (r.สถานะ === 'อนุมัติแล้ว') fillColor = isEven ? 'F0FFF4' : 'E6FFFA';
        if (r.สถานะ === 'ปฏิเสธ') fillColor = isEven ? 'FFF5F5' : 'FED7D7';
        ws[cell].s = {
          fill: { fgColor: { rgb: fillColor } },
          font: { sz: 10 },
          alignment: { horizontal: ci === 9 ? 'center' : 'left', vertical: 'center' },
          border: { bottom: { style: 'hair', color: { rgb: 'E2E8F0' } } },
        };
      });
    });

    // freeze header row
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    return ws;
  }

  // ====== EXCEL (.xlsx) ======
  router.get('/excel', (req, res) => {
    const { year, department } = req.query;
    const data = fetchData(year, department);
    const y = parseInt(year) || new Date().getFullYear();

    const wb = XLSX.utils.book_new();
    wb.Props = { Title: `รายงานการลา ${y}`, Author: 'ระบบลาออนไลน์' };

    // sheet 1: รายละเอียด
    const ws = buildSheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'รายละเอียดการลา');

    // sheet 2: สรุปรายบุคคล
    const summary = {};
    data.forEach(r => {
      const key = r['รหัสพนักงาน'];
      if (!summary[key]) summary[key] = { รหัสพนักงาน: key, ชื่อ: r['ชื่อ_นามสกุล'], แผนก: r['แผนก'], รวมวัน: 0, อนุมัติ: 0, รออนุมัติ: 0, ปฏิเสธ: 0 };
      summary[key].รวมวัน += Number(r['จำนวนวัน']) || 0;
      if (r.สถานะ === 'อนุมัติแล้ว') summary[key].อนุมัติ += Number(r['จำนวนวัน']) || 0;
      else if (r.สถานะ === 'ปฏิเสธ') summary[key].ปฏิเสธ += Number(r['จำนวนวัน']) || 0;
      else summary[key].รออนุมัติ += Number(r['จำนวนวัน']) || 0;
    });
    const sumHeaders = ['รหัสพนักงาน','ชื่อ','แผนก','รวมวัน','อนุมัติ','รออนุมัติ','ปฏิเสธ'];
    const sumRows = Object.values(summary).map(s => sumHeaders.map(h => s[h] ?? 0));
    const ws2 = XLSX.utils.aoa_to_sheet([sumHeaders, ...sumRows]);
    ws2['!cols'] = [12, 20, 14, 10, 10, 12, 10].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws2, 'สรุปรายบุคคล');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="leave-report-${y}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  // ====== EXCEL MACRO (.xlsm) ======
  router.get('/xlsm', (req, res) => {
    const { year, department } = req.query;
    const data = fetchData(year, department);
    const y = parseInt(year) || new Date().getFullYear();

    const wb = XLSX.utils.book_new();
    wb.Props = { Title: `รายงานการลา ${y} (Macro)`, Author: 'ระบบลาออนไลน์' };

    const ws = buildSheet(data);

    // AutoFilter range
    const lastRow = data.length + 1;
    const lastCol = XLSX.utils.encode_col(12);
    ws['!autofilter'] = { ref: `A1:${lastCol}${lastRow}` };

    XLSX.utils.book_append_sheet(wb, ws, 'รายละเอียดการลา');

    // sheet สรุปตามประเภทการลา
    const byType = {};
    data.forEach(r => {
      const t = r['ประเภทการลา'];
      if (!byType[t]) byType[t] = { ประเภทการลา: t, จำนวนครั้ง: 0, รวมวัน: 0 };
      byType[t].จำนวนครั้ง++;
      byType[t].รวมวัน += Number(r['จำนวนวัน']) || 0;
    });
    const typeHeaders = ['ประเภทการลา','จำนวนครั้ง','รวมวัน'];
    const ws3 = XLSX.utils.aoa_to_sheet([typeHeaders, ...Object.values(byType).map(r => typeHeaders.map(h => r[h]))]);
    ws3['!cols'] = [18, 12, 12].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws3, 'สรุปตามประเภท');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsm' });
    res.setHeader('Content-Disposition', `attachment; filename="leave-report-${y}.xlsm"`);
    res.setHeader('Content-Type', 'application/vnd.ms-excel.sheet.macroEnabled.12');
    res.send(buf);
  });

  // ====== PDF (printable HTML) ======
  router.get('/pdf', (req, res) => {
    const { year, department } = req.query;
    const data = fetchData(year, department);
    const y = parseInt(year) || new Date().getFullYear();
    const deptLabel = department ? ` — แผนก${department}` : '';
    const genDate = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });

    // สรุป
    const total = data.length;
    const approved = data.filter(r => r.สถานะ === 'อนุมัติแล้ว').length;
    const pending  = data.filter(r => ['รอหัวหน้าหน่วย','รอหัวหน้าแผนก','รอผู้จัดการฝ่าย'].includes(r.สถานะ)).length;
    const rejected = data.filter(r => r.สถานะ === 'ปฏิเสธ').length;
    const totalDays = data.filter(r => r.สถานะ === 'อนุมัติแล้ว').reduce((s, r) => s + (Number(r['จำนวนวัน']) || 0), 0);

    const rows = data.map((r, i) => {
      const bg = i % 2 === 0 ? '#f7fafc' : '#fff';
      const statusColor = r.สถานะ === 'อนุมัติแล้ว' ? '#276749' : r.สถานะ === 'ปฏิเสธ' ? '#c53030' : '#744210';
      return `<tr style="background:${bg}">
        <td>${i + 1}</td>
        <td>${r['เลขที่คำขอ']}</td>
        <td>${r['รหัสพนักงาน']}</td>
        <td>${r['ชื่อ_นามสกุล']}</td>
        <td>${r['แผนก']}</td>
        <td>${r['ประเภทการลา']}</td>
        <td>${r['วันที่เริ่มลา']}</td>
        <td>${r['วันที่สิ้นสุด']}</td>
        <td style="text-align:center">${r['จำนวนวัน']}</td>
        <td style="color:${statusColor};font-weight:600">${r.สถานะ}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<title>รายงานการลา ${y}${deptLabel}</title>
<style>
  @page { size: A4 landscape; margin: 15mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Sarabun','Tahoma','Arial',sans-serif; font-size: 11px; color: #1a202c; }
  .header { text-align: center; margin-bottom: 16px; }
  .header h1 { font-size: 18px; color: #1e3a5f; margin-bottom: 4px; }
  .header p { font-size: 12px; color: #718096; }
  .summary { display: flex; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .sum-box { flex: 1; min-width: 100px; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 10px; text-align: center; }
  .sum-box .val { font-size: 22px; font-weight: 700; }
  .sum-box .lbl { font-size: 11px; color: #718096; margin-top: 2px; }
  .sum-box.blue { border-color: #bee3f8; } .sum-box.blue .val { color: #2b6cb0; }
  .sum-box.green { border-color: #c6f6d5; } .sum-box.green .val { color: #276749; }
  .sum-box.yellow { border-color: #fefcbf; } .sum-box.yellow .val { color: #744210; }
  .sum-box.red { border-color: #fed7d7; } .sum-box.red .val { color: #c53030; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { background: #1e3a5f; color: #fff; padding: 7px 6px; text-align: left; white-space: nowrap; }
  td { padding: 6px; border-bottom: 1px solid #e2e8f0; vertical-align: middle; }
  .footer { margin-top: 16px; font-size: 10px; color: #718096; display: flex; justify-content: space-between; }
  .print-btn { position: fixed; bottom: 20px; right: 20px; background: #1e3a5f; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; cursor: pointer; font-family: inherit; box-shadow: 0 4px 12px rgba(0,0,0,.2); }
  @media print { .print-btn { display: none; } body { font-size: 10px; } }
</style>
</head>
<body>
<div class="header">
  <h1>รายงานการลาประจำปี ${y + 543}${deptLabel}</h1>
  <p>จัดทำวันที่ ${genDate} | ระบบลาออนไลน์</p>
</div>
<div class="summary">
  <div class="sum-box blue"><div class="val">${total}</div><div class="lbl">คำขอทั้งหมด</div></div>
  <div class="sum-box green"><div class="val">${approved}</div><div class="lbl">อนุมัติแล้ว</div></div>
  <div class="sum-box yellow"><div class="val">${pending}</div><div class="lbl">รออนุมัติ</div></div>
  <div class="sum-box red"><div class="val">${rejected}</div><div class="lbl">ปฏิเสธ</div></div>
  <div class="sum-box blue"><div class="val">${totalDays}</div><div class="lbl">วันลาที่อนุมัติ (วัน)</div></div>
</div>
<table>
  <thead>
    <tr>
      <th>#</th><th>เลขที่คำขอ</th><th>รหัส</th><th>ชื่อ-นามสกุล</th>
      <th>แผนก</th><th>ประเภทการลา</th><th>วันที่เริ่มลา</th>
      <th>วันที่สิ้นสุด</th><th>จำนวนวัน</th><th>สถานะ</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<div class="footer">
  <span>รวม ${total} รายการ | วันลาที่อนุมัติ ${totalDays} วัน</span>
  <span>พิมพ์โดย: ระบบลาออนไลน์ | ${genDate}</span>
</div>
<button class="print-btn" onclick="window.print()">🖨️ พิมพ์ / บันทึก PDF</button>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  return router;
};
