// lt-patch.js — leave types table fix + calendar visual date marking

// ======================================================
// LEAVE TYPES TABLE (8-column fix + search + pagination)
// ======================================================

var _ltAllData  = [];   // ข้อมูลทั้งหมดจาก API
var _ltPage     = 1;
var _ltPageSize = 10;

async function loadLeaveTypesHr() {
  var data = await api('GET', '/hr/leave-types');
  var tbody = document.getElementById('lt-tbody');
  if (!tbody) return;
  if (!Array.isArray(data)) { tbody.innerHTML = '<tr><td colspan="8" class="empty">ไม่สามารถโหลดข้อมูลได้</td></tr>'; return; }
  _ltAllData = data;
  _ltPage    = 1;
  _ltRender();
}

function ltSearchChanged() {
  _ltPage = 1;
  _ltRender();
}

function _ltRender() {
  var tbody   = document.getElementById('lt-tbody');
  var pgEl    = document.getElementById('lt-pagination');
  var countEl = document.getElementById('lt-count');
  if (!tbody) return;

  var q = (document.getElementById('lt-search') || {}).value || '';
  q = q.trim().toLowerCase();

  var filtered = _ltAllData.filter(function(lt) {
    if (!q) return true;
    return (lt.code || '').toLowerCase().indexOf(q) >= 0
        || (lt.name || '').toLowerCase().indexOf(q) >= 0;
  });

  var total      = filtered.length;
  var totalPages = Math.max(1, Math.ceil(total / _ltPageSize));
  if (_ltPage > totalPages) _ltPage = totalPages;

  if (countEl) countEl.textContent = 'พบ ' + total + ' รายการ';

  if (total === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">ไม่พบข้อมูล</td></tr>';
    if (pgEl) pgEl.innerHTML = '';
    return;
  }

  var start = (_ltPage - 1) * _ltPageSize;
  var pageData = filtered.slice(start, start + _ltPageSize);

  var rows = [];
  for (var i = 0; i < pageData.length; i++) {
    var lt = pageData[i];
    var id       = lt.id;
    var overDays = lt.requires_doc_over_days || 0;
    var advDays  = (lt.advance_days  != null) ? Number(lt.advance_days)  : 0;
    var backDays = (lt.backdate_days != null) ? Number(lt.backdate_days) : 0;
    var code     = (lt.code  || '').replace(/"/g, '&quot;');
    var name     = (lt.name  || '').replace(/"/g, '&quot;');
    var safeName = (lt.name  || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    var td1 = '<td style="text-align:center;padding:10px 14px">'
      + '<input type="text" id="ltcode-' + id + '" value="' + code + '"'
      + ' style="' + INP_BASE + 'width:72px;color:#2b6cb0;font-weight:700"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)"></td>';

    var td2 = '<td style="padding:10px 16px">'
      + '<input type="text" id="ltname-' + id + '" value="' + name + '"'
      + ' style="border:1.5px solid #e2e8f0;border-radius:8px;padding:7px 10px;width:200px;font-size:14px;transition:.15s"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)"></td>';

    var advLabel = advDays === 0 ? 'ไม่จำกัด' : 'วัน';
    var td3 = '<td style="text-align:center;padding:10px 14px">'
      + '<div style="display:flex;align-items:center;justify-content:center;gap:4px">'
      + '<input type="number" id="ltadv-' + id + '" value="' + advDays + '" min="0"'
      + ' style="' + INP_BASE + 'width:58px;color:#d97706;font-weight:700"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)">'
      + '<span style="font-size:11px;color:#92400e">' + advLabel + '</span>'
      + '</div></td>';

    var td4 = '<td style="text-align:center;padding:10px 14px">'
      + '<input type="number" id="ltdays-' + id + '" value="' + (lt.max_days_per_year || 0) + '" min="0"'
      + ' style="' + INP_BASE + 'width:72px;color:#1e3a5f;font-weight:700"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)"></td>';

    var backLabel = backDays === 0 ? 'ไม่อนุญาต' : 'วัน';
    var td5 = '<td style="text-align:center;padding:10px 14px">'
      + '<div style="display:flex;align-items:center;justify-content:center;gap:4px">'
      + '<input type="number" id="ltback-' + id + '" value="' + backDays + '" min="0"'
      + ' style="' + INP_BASE + 'width:58px;color:#7c3aed;font-weight:700"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)">'
      + '<span style="font-size:11px;color:#5b21b6">' + backLabel + '</span>'
      + '</div></td>';

    var td6 = '<td style="text-align:center;padding:10px 14px">'
      + '<label class="toggle"><input type="checkbox" id="ltdoc-' + id + '" ' + (lt.requires_document ? 'checked' : '') + '>'
      + '<span class="slider"></span></label></td>';

    var overStyle = overDays === 0
      ? INP_BASE + 'width:58px;opacity:.4;pointer-events:none'
      : INP_BASE + 'width:58px';
    var td7 = '<td style="text-align:center;padding:10px 14px">'
      + '<div style="display:flex;align-items:center;justify-content:center;gap:6px">'
      + '<label class="toggle"><input type="checkbox" id="ltover-toggle-' + id + '" ' + (overDays > 0 ? 'checked' : '')
      + ' onchange="toggleOverDays(' + id + ')"><span class="slider"></span></label>'
      + '<input type="number" id="ltover-' + id + '" value="' + (overDays > 0 ? overDays : 3) + '" min="1"'
      + ' style="' + overStyle + '" onfocus="ltFocus(this)" onblur="ltBlur(this)">'
      + '<span style="font-size:12px;color:#718096">วัน</span></div></td>';

    var td8 = '<td style="text-align:center;padding:10px 14px;white-space:nowrap">'
      + '<button class="btn btn-sm" style="background:linear-gradient(135deg,#276749,#38a169);color:#fff;margin-right:6px;box-shadow:0 2px 6px rgba(56,161,105,.3)"'
      + ' onclick="updateLeaveType(' + id + ')">💾 บันทึก</button>'
      + '<button class="btn btn-danger btn-sm" onclick="deleteLeaveType(' + id + ',\'' + safeName + '\')">🗑️</button></td>';

    rows.push('<tr style="transition:background .15s" onmouseover="this.style.background=\'#f0f7ff\'" onmouseout="this.style.background=\'\'">'
      + td1 + td2 + td3 + td4 + td5 + td6 + td7 + td8 + '</tr>');
  }
  tbody.innerHTML = rows.join('');

  // Pagination
  if (pgEl) {
    if (totalPages <= 1) { pgEl.innerHTML = ''; return; }
    var btnStyle = 'padding:6px 13px;border-radius:8px;border:1.5px solid #e2e8f0;background:#fff;color:#4a5568;cursor:pointer;font-size:13px;font-family:inherit';
    var activeBtnStyle = 'padding:6px 13px;border-radius:8px;border:1.5px solid #1565c0;background:#1565c0;color:#fff;cursor:pointer;font-size:13px;font-family:inherit;font-weight:700';
    var html = '<button style="' + btnStyle + ((_ltPage===1)?';opacity:.4;cursor:default':'') + '"'
      + (_ltPage===1?' disabled':'') + ' onclick="_ltGoPage(' + (_ltPage-1) + ')">‹ ก่อนหน้า</button>';
    var maxBtn = 7, pages = [];
    if (totalPages <= maxBtn) {
      for (var p = 1; p <= totalPages; p++) pages.push(p);
    } else {
      pages.push(1);
      if (_ltPage > 3) pages.push('...');
      for (var p = Math.max(2,_ltPage-1); p <= Math.min(totalPages-1,_ltPage+1); p++) pages.push(p);
      if (_ltPage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    pages.forEach(function(p) {
      if (p === '...') { html += '<span style="padding:6px 4px;color:#a0aec0">…</span>'; return; }
      html += '<button style="' + (p===_ltPage ? activeBtnStyle : btnStyle) + '" onclick="_ltGoPage(' + p + ')">' + p + '</button>';
    });
    html += '<button style="' + btnStyle + ((_ltPage===totalPages)?';opacity:.4;cursor:default':'') + '"'
      + (_ltPage===totalPages?' disabled':'') + ' onclick="_ltGoPage(' + (_ltPage+1) + ')">ถัดไป ›</button>';
    pgEl.innerHTML = html;
  }
}

function _ltGoPage(p) {
  _ltPage = p;
  _ltRender();
}

function toggleOverDays(id) {
  var checked = document.getElementById('ltover-toggle-' + id).checked;
  var el = document.getElementById('ltover-' + id);
  el.style.opacity = checked ? '1' : '.4';
  el.style.pointerEvents = checked ? '' : 'none';
}

async function updateLeaveType(id) {
  var overEnabled = document.getElementById('ltover-toggle-' + id) && document.getElementById('ltover-toggle-' + id).checked;
  var overVal  = parseInt((document.getElementById('ltover-'  + id) || {}).value) || 3;
  var advDays  = parseInt((document.getElementById('ltadv-'   + id) || {}).value) || 0;
  var backDays = parseInt((document.getElementById('ltback-'  + id) || {}).value) || 0;
  var r = await api('PUT', '/hr/leave-types/' + id, {
    code:                  ((document.getElementById('ltcode-' + id) || {}).value || '').trim(),
    name:                  (document.getElementById('ltname-'  + id).value || '').trim(),
    max_days_per_year:     parseInt(document.getElementById('ltdays-' + id).value) || 0,
    requires_document:     document.getElementById('ltdoc-'    + id).checked ? 1 : 0,
    requires_doc_over_days: overEnabled ? overVal : 0,
    advance_days:  advDays,
    backdate_days: backDays,
  });
  if (r.error) return swalError(r.error);
  swalSuccess(r.message, function() { loadLeaveTypesHr(); });
}

// ======================================================
// CALENDAR — แสดงสีบนปฏิทินตาม advance/backdate จาก DB
// ======================================================

// inject CSS สีวันในปฏิทิน (ครั้งเดียว)
(function injectCalendarStyles() {
  if (document.getElementById('lt-patch-css')) return;
  var s = document.createElement('style');
  s.id = 'lt-patch-css';
  s.textContent = [
    /* วันย้อนหลังที่อนุญาต */
    '.fp-day-back { background:linear-gradient(135deg,#ede9fe,#ddd6fe) !important;',
    '  border-radius:50% !important; position:relative; }',
    '.fp-day-back:hover { background:linear-gradient(135deg,#c4b5fd,#a78bfa) !important; }',
    '.fp-day-back::after { content:"↩"; position:absolute; bottom:-1px; right:1px;',
    '  font-size:7px; color:#7c3aed; line-height:1; }',

    /* วันล่วงหน้าที่อนุญาต */
    '.fp-day-adv { background:linear-gradient(135deg,#fef3c7,#fde68a) !important;',
    '  border-radius:50% !important; position:relative; }',
    '.fp-day-adv:hover { background:linear-gradient(135deg,#fcd34d,#f59e0b) !important; }',
    '.fp-day-adv::after { content:"↪"; position:absolute; bottom:-1px; right:1px;',
    '  font-size:7px; color:#b45309; line-height:1; }',

    /* วันนี้ที่อยู่ในช่วงที่อนุญาต */
    '.fp-day-today-ok { background:linear-gradient(135deg,#d1fae5,#a7f3d0) !important;',
    '  border-radius:50% !important; font-weight:800 !important; color:#065f46 !important; }',

    /* legend ใต้ปฏิทิน */
    '.fp-legend { display:flex; gap:10px; justify-content:center; flex-wrap:wrap;',
    '  padding:6px 8px 4px; font-size:11px; border-top:1px solid #e2e8f0; margin-top:4px; }',
    '.fp-legend-item { display:flex; align-items:center; gap:4px; color:#4a5568; }',
    '.fp-legend-dot { width:12px; height:12px; border-radius:50%; flex-shrink:0; }',
    '.fp-legend-dot-back { background:linear-gradient(135deg,#ede9fe,#ddd6fe);',
    '  border:1px solid #a78bfa; }',
    '.fp-legend-dot-adv  { background:linear-gradient(135deg,#fef3c7,#fde68a);',
    '  border:1px solid #f59e0b; }',
    '.fp-legend-dot-today{ background:linear-gradient(135deg,#d1fae5,#a7f3d0);',
    '  border:1px solid #34d399; }',
  ].join('\n');
  document.head.appendChild(s);
})();

function getSelectedLeaveTypeMeta() {
  var sel = document.getElementById('req-type');
  if (!sel) return null;
  // leaveTypesCache ถูก declare ด้วย "let" ใน app.js — ไม่ขึ้น window
  // แต่เข้าถึงได้จาก lt-patch.js (same global scope, non-module script)
  var cache;
  try { cache = leaveTypesCache; } catch(e) { return null; }
  if (!Array.isArray(cache) || cache.length === 0) return null;
  var id = parseInt(sel.value);
  for (var i = 0; i < cache.length; i++) {
    if (Number(cache[i].id) === id) return cache[i];
  }
  return null;
}

function getLeaveDateLimits() {
  var meta    = getSelectedLeaveTypeMeta();
  var today   = new Date(); today.setHours(0, 0, 0, 0);
  var back    = meta ? (Number(meta.backdate_days) || 0) : 0;
  var adv     = meta ? (Number(meta.advance_days)  || 0) : 0;
  var minDate = back > 0 ? new Date(today.getTime() - back * 86400000) : today;
  var maxDate = adv  > 0 ? new Date(today.getTime() + adv  * 86400000) : null;
  return { minDate: minDate, maxDate: maxDate, back: back, adv: adv, today: today };
}

// onDayCreate callback — ระบายสีแต่ละวัน
function fpDayCreate(dObj, dStr, fp, dayElem) {
  var d = new Date(dObj); d.setHours(0, 0, 0, 0);
  var limits = getLeaveDateLimits();
  var today  = limits.today;

  // ลบ class เก่าออกก่อน
  dayElem.classList.remove('fp-day-back', 'fp-day-adv', 'fp-day-today-ok');

  var isDisabled = dayElem.classList.contains('flatpickr-disabled');
  if (isDisabled) return; // วัน disabled ไม่ต้องทำอะไร

  if (d.getTime() === today.getTime()) {
    dayElem.classList.add('fp-day-today-ok');
  } else if (d < today && limits.back > 0) {
    dayElem.classList.add('fp-day-back');
    dayElem.title = 'ย้อนหลังได้ (ลาย้อนหลังสูงสุด ' + limits.back + ' วัน)';
  } else if (d > today) {
    dayElem.classList.add('fp-day-adv');
    if (limits.adv > 0) {
      dayElem.title = 'ล่วงหน้าได้ (ลาล่วงหน้าสูงสุด ' + limits.adv + ' วัน)';
    } else {
      dayElem.title = 'ล่วงหน้าได้ (ไม่จำกัด)';
    }
  }
}

// inject/update legend ใต้ calendar
function injectLegend(fpInstance) {
  var cal = fpInstance.calendarContainer;
  if (!cal) return;
  var old = cal.querySelector('.fp-legend');
  if (old) old.remove();

  var meta  = getSelectedLeaveTypeMeta();
  var back  = meta ? (Number(meta.backdate_days) || 0) : 0;
  var adv   = meta ? (Number(meta.advance_days)  || 0) : 0;

  var legend = document.createElement('div');
  legend.className = 'fp-legend';

  var todayHtml = '<div class="fp-legend-item">'
    + '<div class="fp-legend-dot fp-legend-dot-today"></div>วันนี้</div>';

  var backHtml = back > 0
    ? '<div class="fp-legend-item"><div class="fp-legend-dot fp-legend-dot-back"></div>ย้อนหลังได้ (' + back + ' วัน)</div>'
    : '<div class="fp-legend-item" style="color:#c53030">⛔ ไม่อนุญาตย้อนหลัง</div>';

  var advHtml = adv > 0
    ? '<div class="fp-legend-item"><div class="fp-legend-dot fp-legend-dot-adv"></div>ล่วงหน้าได้ (' + adv + ' วัน)</div>'
    : '<div class="fp-legend-item"><div class="fp-legend-dot fp-legend-dot-adv"></div>ล่วงหน้าได้ (ไม่จำกัด)</div>';

  legend.innerHTML = todayHtml + backHtml + advHtml;
  cal.appendChild(legend);
}

function getFpInstances() {
  var elS = document.getElementById('req-start-date');
  var elE = document.getElementById('req-end-date');
  return {
    fpS: elS && elS._flatpickr ? elS._flatpickr : null,
    fpE: elE && elE._flatpickr ? elE._flatpickr : null,
  };
}

function applyLeaveLimitsToFp(fpInstance) {
  if (!fpInstance) return;
  var limits = getLeaveDateLimits();
  // ต้องตั้ง minDate ก่อน maxDate — flatpickr set() จะ redraw อัตโนมัติแต่ละครั้ง
  fpInstance.set('minDate', limits.minDate);
  // maxDate: ถ้าไม่จำกัด (null) ส่ง '' เพื่อ clear maxDate ใน flatpickr (null ทำให้ parse ผิด)
  fpInstance.set('maxDate', limits.maxDate ? limits.maxDate : '');
  // หลัง set() flatpickr redraw ไปแล้ว ใส่ legend เพิ่มเติม
  setTimeout(function() { injectLegend(fpInstance); }, 0);
}

function updateLeaveDateMin() {
  var fp = getFpInstances();
  if (!fp.fpS && !fp.fpE) return;

  applyLeaveLimitsToFp(fp.fpS);
  applyLeaveLimitsToFp(fp.fpE);

  // ล้างวันที่เลือกไว้ถ้าออกนอกช่วงใหม่
  var limits = getLeaveDateLimits();
  var meta   = getSelectedLeaveTypeMeta();
  function outOfRange(d) {
    if (!d) return false;
    if (d < limits.minDate) return true;
    if (limits.maxDate && d > limits.maxDate) return true;
    return false;
  }
  var sv = fp.fpS && fp.fpS.selectedDates[0];
  var ev = fp.fpE && fp.fpE.selectedDates[0];
  if (outOfRange(sv) || outOfRange(ev)) {
    if (fp.fpS) fp.fpS.clear();
    if (fp.fpE) fp.fpE.clear();
    var adv  = meta ? Number(meta.advance_days)  || 0 : 0;
    var back = meta ? Number(meta.backdate_days)  || 0 : 0;
    var msg;
    if (adv > 0 && back > 0) msg = 'ลาล่วงหน้าได้ไม่เกิน ' + adv + ' วัน และย้อนหลังได้ไม่เกิน ' + back + ' วัน';
    else if (adv  > 0) msg = 'ลาล่วงหน้าได้ไม่เกิน ' + adv  + ' วัน';
    else if (back > 0) msg = 'ย้อนหลังได้ไม่เกิน '   + back + ' วัน';
    else               msg = 'ประเภทการลานี้ไม่อนุญาตให้เลือกวันย้อนหลัง';
    Swal.fire({ icon: 'warning', title: 'วันที่ไม่ถูกต้อง', text: msg, confirmButtonColor: '#1e3a5f' });
  }
}

// ผูก onDayCreate กับ flatpickr instance
function hookFpDayCreate(fpInstance) {
  if (!fpInstance) return;
  // ลบ handler เก่าที่เราใส่ไว้ก่อน (ป้องกัน duplicate)
  var existing = fpInstance.config.onDayCreate;
  var already = false;
  if (Array.isArray(existing)) {
    for (var i = 0; i < existing.length; i++) {
      if (existing[i]._ltpatch) { already = true; break; }
    }
  }
  if (!already) {
    var handler = function(dObj, dStr, fp, dayElem) { fpDayCreate(dObj, dStr, fp, dayElem); };
    handler._ltpatch = true;
    fpInstance.config.onDayCreate.push(handler);
  }
  // hook onOpen เพื่อ update limits + legend ทุกครั้งที่เปิด
  var onOpenExist = fpInstance.config.onOpen;
  var openAlready = false;
  if (Array.isArray(onOpenExist)) {
    for (var j = 0; j < onOpenExist.length; j++) {
      if (onOpenExist[j]._ltpatchOpen) { openAlready = true; break; }
    }
  }
  if (!openAlready) {
    var openHandler = function() {
      // re-apply limits เผื่อ type เปลี่ยนแต่ไม่ได้ trigger updateLeaveDateMin
      var limits = getLeaveDateLimits();
      fpInstance.set('minDate', limits.minDate);
      fpInstance.set('maxDate', limits.maxDate ? limits.maxDate : '');
      setTimeout(function() { injectLegend(fpInstance); }, 0);
    };
    openHandler._ltpatchOpen = true;
    fpInstance.config.onOpen.push(openHandler);
  }
}

// main patch — รอจนกว่า flatpickr จะถูกสร้าง
(function patchLeaveCalendar() {
  // override initFlatpickr เพื่อดักจับหลังสร้าง
  var _origInit = window.initFlatpickr;
  window.initFlatpickr = function() {
    if (typeof _origInit === 'function') _origInit();
    setTimeout(function() {
      var fp = getFpInstances();
      hookFpDayCreate(fp.fpS);
      hookFpDayCreate(fp.fpE);
      var sel = document.getElementById('req-type');
      if (sel) {
        sel.removeEventListener('change', updateLeaveDateMin);
        sel.addEventListener('change', updateLeaveDateMin);
      }
      updateLeaveDateMin();
    }, 150);
  };

  // กรณี flatpickr สร้างไปแล้วก่อน lt-patch.js โหลด
  function bindIfReady() {
    var fp  = getFpInstances();
    var sel = document.getElementById('req-type');
    if (fp.fpS && sel) {
      hookFpDayCreate(fp.fpS);
      hookFpDayCreate(fp.fpE);
      sel.removeEventListener('change', updateLeaveDateMin);
      sel.addEventListener('change', updateLeaveDateMin);
      updateLeaveDateMin();
    } else {
      setTimeout(bindIfReady, 600);
    }
  }
  bindIfReady();
})();
