const API = '/api';
let token = localStorage.getItem('token');
let user  = JSON.parse(localStorage.getItem('user') || 'null');
let currentApprovalId = null;
let _approveRowMap = {};

// ====== WORK HOURS CALCULATION (mirrors backend) ======
// Reference working Saturday for monthly employees (เสาร์เว้นเสาร์)
const WORKING_SAT_REF = new Date('2026-01-10T00:00:00');
// Cache: { 'YYYY-MM-DD': 'working_sat'|'holiday_sat' }
let workScheduleCache = {};
// Cache: { 'YYYY-MM-DD': 'ชื่อวันหยุด' }
let companyHolidaysCache = {};

async function loadWorkScheduleCache(year) {
  try {
    const rows = await api('GET', `/leave/work-schedule?year=${year}`);
    if (Array.isArray(rows)) rows.forEach(r => { workScheduleCache[r.date] = r.type; });
  } catch(e) {}
}

async function loadCompanyHolidaysCache(year) {
  try {
    const rows = await api('GET', `/leave/company-holidays?year=${year}`);
    if (Array.isArray(rows)) rows.forEach(r => { companyHolidaysCache[r.date] = r.name; });
  } catch(e) {}
}

function isCompanyHoliday(dateStr) { return !!companyHolidaysCache[dateStr]; }
function companyHolidayName(dateStr) { return companyHolidaysCache[dateStr] || 'วันหยุด'; }

function isWorkingSaturday(d) {
  const pad = n => String(n).padStart(2,'0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  if (workScheduleCache[dateStr]) return workScheduleCache[dateStr] === 'working_sat';
  const ref = new Date(WORKING_SAT_REF.getFullYear(), WORKING_SAT_REF.getMonth(), WORKING_SAT_REF.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((target - ref) / 86400000);
  return diff % 14 === 0;
}
function getWorkHoursForDayFE(dateStr) {
  const empType  = user?.employee_type || 'monthly';
  const probStart = user?.probation_start_date || null;
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  if (dow === 0) return 0;
  if (isCompanyHoliday(dateStr)) return 0; // วันหยุดประเพณีบริษัท
  if (empType === 'daily') {
    // จ-พฤ 9:00-18:00 หักพัก 1h = 8h, ศ-ส 8:00-17:00 หักพัก 1h = 8h
    return 8;
  }
  if (empType === 'housekeeping') {
    const passed = probStart ? (new Date(dateStr) - new Date(probStart)) / 86400000 >= 120 : false;
    // แม่บ้านประจำ: จ-ศ 9h, ส 3h | แม่บ้านทดลองงาน: จ-ส 8h
    if (passed) return dow <= 5 ? 9 : 3;
    return 8;
  }
  // monthly: จ-พฤ 8:00-18:00 หักพัก 1h = 9h, ศ 8:00-17:00 หักพัก 1h = 8h, ส 8:00-12:00 ไม่ทับพัก = 4h
  if (dow <= 4) return 9;
  if (dow === 5) return 8;
  return isWorkingSaturday(d) ? 4 : 0;
}

// Return { minTime, maxTime } string "HH:MM" for the given date and current user's employee type
function getWorkTimeRange(dateStr) {
  const empType  = user?.employee_type || 'monthly';
  const probStart = user?.probation_start_date || null;
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  if (dow === 0) return null; // Sunday — no work
  if (empType === 'daily') {
    if (dow <= 4) return { minTime: '09:00', maxTime: '18:00' }; // จ-พฤ
    return { minTime: '08:00', maxTime: '17:00' }; // ศ-ส
  }
  if (empType === 'housekeeping') {
    const passed = probStart ? (new Date(dateStr) - new Date(probStart)) / 86400000 >= 120 : false;
    if (passed) {
      if (dow === 6) return { minTime: '07:00', maxTime: '10:00' }; // ส 3h
      return { minTime: '07:00', maxTime: '17:00' }; // จ-ศ 9h
    }
    if (dow === 0) return null;
    return { minTime: '07:00', maxTime: '16:00' }; // ทดลองงาน จ-ส 8h
  }
  // monthly
  if (dow <= 4) return { minTime: '08:00', maxTime: '18:00' }; // จ-พฤ
  if (dow === 5) return { minTime: '08:00', maxTime: '17:00' }; // ศ
  if (isWorkingSaturday(d)) return { minTime: '08:00', maxTime: '12:00' }; // ส (working)
  return null; // เสาร์ที่ไม่ทำงาน
}

// Show/hide probation date field in employee form
function toggleProbationField() {
  const t = document.getElementById('em-emptype')?.value;
  const g = document.getElementById('em-probation-group');
  if (g) g.style.display = t === 'housekeeping' ? '' : 'none';
}

// Cache sick leave type id (set after loadLeaveTypes())
let sickLeaveTypeId = null;

// ====== INIT ======
window.addEventListener('DOMContentLoaded', () => {
  if (token && user) showApp();
});

function showApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').style.display       = 'block';
  document.getElementById('nav-name').textContent    = user.name;
  // แสดงชื่อบริษัทใต้ชื่อระบบถ้ามี
  if (user.company) {
    const nc = document.getElementById('nav-company');
    if (nc) nc.textContent = user.company;
  }

  // ดึง employee_type + menuPerms ล่าสุดจาก DB
  fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data) {
        user.employee_type        = data.employee_type || 'monthly';
        user.probation_start_date = data.probation_start_date || null;
        user.menuPerms            = data.menuPerms || {};
        localStorage.setItem('user', JSON.stringify(user));
        if (typeof calcReqDays === 'function') calcReqDays();
        applyUserMenuPerms();
      }
    }).catch(() => {});

  const isApprover = ['unit_head','department_head','division_manager','hr_admin'].includes(user.role);
  const isManager  = ['division_manager','hr_admin'].includes(user.role);
  const isHR       = user.role === 'hr_admin';
  const curYear    = new Date().getFullYear();

  if (isHR) {
    document.getElementById('home-employee').style.display = 'none';
    document.getElementById('home-hr').style.display = '';
    document.getElementById('tab-leave-mgmt').style.display = '';
    document.getElementById('tab-report').style.display = '';
    document.getElementById('tab-hr').style.display = '';
    document.getElementById('tab-calendar-all')?.style && (document.getElementById('tab-calendar-all').style.display = '');
    document.getElementById('bnav-report').style.display = '';
    document.getElementById('bnav-hr').style.display = '';
    const sel = document.getElementById('dash-year');
    for (let y = curYear; y >= curYear - 4; y--) sel.innerHTML += `<option value="${y}" ${y===curYear?'selected':''}>${y + 543}</option>`;
    loadLeaveRecords();
    loadApproveHistory();
    loadPending();
  } else {
    const _show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };
    _show('home-employee');
    _show('tab-request'); _show('tab-history'); _show('tab-calendar-my');
    _show('bnav-request'); _show('bnav-history');
    if (isApprover) { _show('tab-approve'); _show('tab-calendar-all'); _show('bnav-approve'); }
    if (isManager)  { _show('tab-report'); _show('bnav-report'); }
    // โหลดข้อมูลหน้าหลักทันที ไม่รอ switchTab
    loadBalance();
    loadCalMy();
    loadApprovers();
    if (isApprover) { loadPending(); loadApproveHistory(); loadCalAll(); }
  }

  const _rptYear = document.getElementById('rpt-year');
  const _lmYear  = document.getElementById('lm-year');
  if (_rptYear) _rptYear.value = curYear;
  if (_lmYear)  _lmYear.value  = curYear;
  loadLeaveTypes();
  loadHistory();
  loadWorkScheduleCache(curYear);
  loadCompanyHolidaysCache(curYear);

  // activate หน้าหลัก + re-render chart (HR) หลัง browser paint 1 เฟรม
  requestAnimationFrame(() => {
    // activate tab โดยไม่ call loadBalance/loadDashboard ซ้ำ
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const tabEl = document.getElementById('tab-home');
    if (tabEl) tabEl.classList.add('active');
    const pageEl = document.getElementById('page-home');
    if (pageEl) pageEl.classList.add('active');
    document.querySelectorAll('.bnav-item').forEach(b => b.classList.remove('active'));
    const bnavEl = document.getElementById('bnav-home');
    if (bnavEl) bnavEl.classList.add('active');
    // สำหรับ HR: render chart หลัง canvas มีขนาดแล้ว
    if (isHR) loadDashboard();
  });
}

// ====== USER MENU PERMISSIONS ======
function applyUserMenuPerms() {
  const isHR = user.role === 'hr_admin';
  if (isHR) return;
  const p = user.menuPerms || {};
  const _show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };
  const _hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

  // sub-tabs เหล่านี้เป็นสิทธิ์ hr_admin เท่านั้น — ซ่อนเสมอสำหรับ non-HR
  ['hrtab-emp','hrtab-import','hrtab-perm','hrtab-approver','hrtab-leavetype',
   'hrsec-emp','hrsec-import','hrsec-perm','hrsec-approver','hrsec-leavetype'].forEach(_hide);

  if (p.can_access_hr) {
    _show('tab-hr');
    if (!p.can_view_dashboard_hr) _hide('hrtab-dash');
    else {
      // populate dash-year dropdown (สำหรับ non-HR user ที่ได้รับสิทธิ์)
      const sel = document.getElementById('dash-year');
      if (sel && sel.options.length === 0) {
        const curYear = new Date().getFullYear();
        for (let y = curYear; y >= curYear - 4; y--)
          sel.innerHTML += `<option value="${y}" ${y===curYear?'selected':''}>${y + 543}</option>`;
      }
    }
    if (!p.can_view_hr_calendar)  _hide('hrtab-calendar');
    if (p.can_view_all_requests)  { _show('tab-leave-mgmt'); loadLeaveRecords(); }
  }
  if (p.can_view_report) _show('tab-report');
}

// ====== AUTH ======
async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const r = await api('POST', '/auth/login', { email, password });
  if (r.error) {
    return Swal.fire({
      icon: 'error',
      title: 'เข้าสู่ระบบไม่สำเร็จ',
      text: 'ชื่อหรือรหัสผ่านไม่ถูกต้อง',
      confirmButtonColor: '#e53e3e',
      confirmButtonText: 'ลองใหม่',
    });
  }
  token = r.token; user = r.user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  await Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: 2000,
    timerProgressBar: true,
    didOpen: toast => { toast.addEventListener('mouseenter', Swal.stopTimer); toast.addEventListener('mouseleave', Swal.resumeTimer); }
  }).fire({
    icon: 'success',
    title: 'ยินดีต้อนรับ',
    text: `${user.name || user.employee_id}`,
  });
  await new Promise(r => setTimeout(r, 300));
  showApp();
}

function doLogout() {
  // แจ้ง backend ก่อน (fire-and-forget) แล้วล้าง session ทันที
  fetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token }
  }).catch(() => {}).finally(() => {
    localStorage.clear();
    sessionStorage.clear();
    token = null;
    user  = null;
    // reset ตัวแปร global ที่แคชข้อมูลไว้
    historyCache = [];
    leaveTypesCache = [];
    sickLeaveTypeId = null;
    if (fpStart) { try { fpStart.destroy(); } catch(e){} fpStart = null; }
    if (fpEnd)   { try { fpEnd.destroy();   } catch(e){} fpEnd   = null; }
    location.replace(location.origin + location.pathname);
  });
}

function showRegister() {
  // reset validation state
  ['reg-empid','reg-email'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('field-error','field-ok'); }
  });
  ['reg-empid-err','reg-email-err'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('show');
  });
  document.getElementById('register-modal').classList.add('open');
}
function closeRegister() { document.getElementById('register-modal').classList.remove('open'); }

let _regCheckTimer = {};
function regFieldCheck(field, value) {
  clearTimeout(_regCheckTimer[field]);
  if (!value) return;
  _regCheckTimer[field] = setTimeout(async () => {
    const params = new URLSearchParams({ [field]: value });
    const r = await fetch(API + '/auth/check?' + params).then(res => res.json()).catch(() => ({}));
    const inputEl = document.getElementById(field === 'employee_id' ? 'reg-empid' : 'reg-email');
    const errEl   = document.getElementById(field === 'employee_id' ? 'reg-empid-err' : 'reg-email-err');
    const exists  = field === 'employee_id' ? r.employee_id_exists : r.email_exists;
    if (!inputEl) return;
    inputEl.classList.toggle('field-error', !!exists);
    inputEl.classList.toggle('field-ok', !exists);
    if (errEl) errEl.classList.toggle('show', !!exists);
    if (exists) {
      Swal.fire({
        icon: 'warning',
        title: 'ข้อมูลซ้ำในระบบ',
        text: field === 'employee_id' ? `รหัสพนักงาน "${value}" มีในระบบแล้ว` : `อีเมล "${value}" มีในระบบแล้ว`,
        confirmButtonColor: '#e53e3e',
        confirmButtonText: 'ตกลง',
        timer: 4000,
        timerProgressBar: true,
      });
    }
  }, 600);
}

// wire up real-time listeners after DOM ready
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('reg-empid')?.addEventListener('blur', e => regFieldCheck('employee_id', e.target.value.trim()));
  document.getElementById('reg-email')?.addEventListener('blur', e => regFieldCheck('email', e.target.value.trim()));
  document.getElementById('reg-empid')?.addEventListener('input', e => {
    // clear error state while typing
    e.target.classList.remove('field-error','field-ok');
    document.getElementById('reg-empid-err')?.classList.remove('show');
  });
  document.getElementById('reg-email')?.addEventListener('input', e => {
    e.target.classList.remove('field-error','field-ok');
    document.getElementById('reg-email-err')?.classList.remove('show');
  });
});

async function doRegister() {
  // ตรวจสอบ field-error ก่อน submit
  if (document.getElementById('reg-empid')?.classList.contains('field-error') ||
      document.getElementById('reg-email')?.classList.contains('field-error')) {
    return Swal.fire({ icon:'error', title:'ไม่สามารถลงทะเบียนได้', text:'กรุณาแก้ไขข้อมูลที่ซ้ำในระบบก่อน', confirmButtonColor:'#e53e3e' });
  }
  const body = {
    employee_id: document.getElementById('reg-empid').value.trim(),
    name:        document.getElementById('reg-name').value.trim(),
    email:       document.getElementById('reg-email').value.trim(),
    password:    document.getElementById('reg-pass').value,
    role:        document.getElementById('reg-role').value,
    unit:        document.getElementById('reg-unit').value.trim(),
    department:  document.getElementById('reg-dept').value.trim(),
    division:    document.getElementById('reg-div').value.trim(),
  };
  const r = await api('POST', '/auth/register', body);
  if (r.error) return swalError(r.error);
  swalSuccess('ลงทะเบียนสำเร็จ กรุณาเข้าสู่ระบบ', closeRegister);
}

// ====== TABS ======
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const tabEl = document.getElementById('tab-' + name);
  if (tabEl) tabEl.classList.add('active');
  document.getElementById('page-' + name).classList.add('active');
  // sync bottom nav
  document.querySelectorAll('.bnav-item').forEach(b => b.classList.remove('active'));
  const bnavEl = document.getElementById('bnav-' + name);
  if (bnavEl) bnavEl.classList.add('active');
  if (name === 'calendar-my')  loadCalMy();
  if (name === 'calendar-all') loadCalAll();
  if (name === 'home' && user.role === 'hr_admin') loadDashboard();
  if (name === 'home' && user.role !== 'hr_admin') loadBalance();
  if (name === 'hr' && user.role !== 'hr_admin') {
    // find first visible HR sub-tab for non-HR users
    const p = user.menuPerms || {};
    const firstTab = p.can_view_dashboard_hr ? 'dash' : p.can_view_hr_calendar ? 'calendar' : null;
    if (firstTab) hrTab(firstTab);
  }
  if (name === 'leave-mgmt')   { loadLeaveRecords(); loadDeleteLogs(); }
  if (name === 'request')      loadApprovers();
  if (name === 'approve')      { loadPending(); loadApproveHistory(); }
  if (name === 'report')       { loadReport(); }
}

// ====== HOME ======
// ====== EMPLOYEE DASHBOARD ======
let empLeaveData = [];
let empPage = 1;
let empBalanceCache = []; // cache โควต้าคงเหลือสำหรับตรวจสอบก่อน submit

async function loadBalance() {
  try {
  // populate greeting
  const greetEl = document.getElementById('home-greeting-name');
  const roleEl  = document.getElementById('home-greeting-role');
  if (greetEl && user) greetEl.textContent = user.name || '-';
  if (roleEl  && user) {
    const rmap = { employee:'พนักงาน', unit_head:'หัวหน้าหน่วยงาน', department_head:'หัวหน้าแผนก', division_manager:'ผู้จัดการ', hr_admin:'HR Admin' };
    const roleLabel = rmap[user.role] || user.role;
    const deptLabel = user.department ? ` &nbsp;|&nbsp; 🏢 ${user.department}` : '';
    roleEl.innerHTML = `<span style="background:rgba(255,255,255,.15);padding:3px 10px;border-radius:20px">👤 ${roleLabel}${deptLabel}</span>`;
  }
  const [balance, history] = await Promise.all([
    api('GET', '/leave/balance'),
    api('GET', '/leave/my-requests'),
  ]);
  if (history && history.error) { console.error('loadBalance my-requests error:', history.error); }
  empLeaveData = Array.isArray(history) ? history : [];
  empBalanceCache = Array.isArray(balance) ? balance : [];

  // stat cards
  const total    = empLeaveData.length;
  const totalDay = empLeaveData.reduce((s, r) => s + (r.days || 0), 0);
  const approved = empLeaveData.filter(r => r.status === 'approved').length;
  const pending  = empLeaveData.filter(r => ['pending','approved_l1'].includes(r.status)).length;
  document.getElementById('emp-stat-total').textContent    = total;
  document.getElementById('emp-stat-days').textContent     = totalDay;
  document.getElementById('emp-stat-approved').textContent = approved;
  document.getElementById('emp-stat-pending').textContent  = pending;

  // โควต้าคงเหลือ + ใช้ไป — progress bars
  const barColors = ['#e53e3e','#d69e2e','#38a169','#3182ce','#805ad5','#00b5d8'];
  const barsEl = document.getElementById('emp-balance-bars');
  if (Array.isArray(balance) && balance.length) {
    // แสดงปีงบประมาณในหัว section
    const fyVal = balance[0] && balance[0].fiscal_year;
    const fyLabelEl = document.getElementById('emp-balance-fy-label');
    if (fyLabelEl && fyVal) fyLabelEl.textContent = `ปีงบประมาณ ${fyVal} (พ.ย. ${fyVal} – ต.ค. ${fyVal+1})`;
    if (barsEl) {
      const usedBalance = balance.filter(b => (b.used_days || 0) > 0);
      if (usedBalance.length === 0) {
        barsEl.innerHTML = '<div class="empty" style="font-size:13px">ยังไม่มีการใช้วันลาในปีนี้</div>';
      } else {
        barsEl.innerHTML = usedBalance.map((b, i) => {
          const used   = b.used_days || 0;
          const total  = b.total_days || 1;
          const remain = Math.max(0, total - used);
          const pct    = Math.min(100, Math.round((used / total) * 100));
          const c      = barColors[i % barColors.length];
          return `<div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
              <span style="font-size:13px;font-weight:700;color:#2d3748">${b.leave_type_name}</span>
              <span style="font-size:12px;color:#718096"><span style="font-weight:700;color:${c}">${Number.isInteger(used)?used:used.toFixed(1)}</span>/${total} วัน</span>
            </div>
            <div style="background:#f0f4f8;border-radius:20px;height:8px;overflow:hidden">
              <div style="background:linear-gradient(90deg,${c},${c}cc);height:100%;width:${pct}%;border-radius:20deg;transition:width .6s ease"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:3px">
              <span style="font-size:11px;color:#a0aec0">ใช้ไป ${Number.isInteger(used)?used:used.toFixed(1)} วัน (${pct}%)</span>
              <span style="font-size:11px;color:#48bb78;font-weight:600">คงเหลือ ${Number.isInteger(remain)?remain:remain.toFixed(1)} วัน</span>
            </div>
          </div>`;
        }).join('');
      }
    }
  } else if (barsEl) {
    if (balance && balance.error) {
      barsEl.innerHTML = `<div class="empty" style="color:#c53030">ไม่สามารถโหลดข้อมูลโควต้าได้: ${balance.error}</div>`;
    } else {
      barsEl.innerHTML = '<div class="empty">ยังไม่มีข้อมูลโควต้าวันลา กรุณาติดต่อ HR Admin</div>';
    }
  }

  empPage = 1;
  renderEmpTable();
  } catch (err) {
    console.error('loadBalance error:', err);
    const barsEl2 = document.getElementById('emp-balance-bars');
    if (barsEl2) barsEl2.innerHTML = `<div class="empty" style="color:#c53030">เกิดข้อผิดพลาด: ${err.message}</div>`;
  }
}

function renderEmpTable() {
  const search   = (document.getElementById('emp-search')?.value || '').toLowerCase();
  const pageSize = parseInt(document.getElementById('emp-page-size')?.value || 20);

  const filtered = empLeaveData.filter(r =>
    !search ||
    (r.leave_type_name||'').toLowerCase().includes(search) ||
    (r.start_date||'').includes(search) ||
    (r.status||'').includes(search)
  );

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (empPage > pages) empPage = pages;
  const slice = filtered.slice((empPage-1)*pageSize, empPage*pageSize);

  const statusColors = {
    pending:'#b7791f', approved_l1:'#2b6cb0',
    approved:'#276749', rejected:'#c53030', cancelled:'#718096'
  };
  const statusLabel = {
    pending:'รอตรวจสอบ', approved_l1:'รอระดับอนุมัติ',
    approved:'อนุมัติแล้ว', rejected:'ไม่อนุมัติ', cancelled:'ยกเลิก'
  };

  const tbody = document.getElementById('emp-leave-tbody');
  if (!slice.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">ไม่มีข้อมูล</td></tr>'; }
  else {
    tbody.innerHTML = slice.map(r => {
      const approvals = r.approvals || [];
      const lvl1 = approvals.find(a => a.level === 1);
      const lvl2 = approvals.find(a => a.level === 2);
      const checker  = lvl1?.approver_name || '-';
      const approver = lvl2?.approver_name || '-';
      const fullyApproved = r.status === 'approved';
      const pastL1 = ['approved_l1','approved'].includes(r.status);
      const rejected = r.status === 'rejected';
      const checkerStatus  = fullyApproved ? 'approved'
        : pastL1 ? 'approved'
        : rejected && lvl1?.status === 'rejected' ? 'rejected'
        : (lvl1?.status || 'pending');
      const approverStatus = fullyApproved ? 'approved'
        : rejected && lvl2?.status === 'rejected' ? 'rejected'
        : (lvl2?.status || 'pending');
      const statusBg = { pending:'#fefcbf',approved:'#c6f6d5',rejected:'#fed7d7',approved_l1:'#bee3f8',cancelled:'#e2e8f0' };
      const statusTx = { pending:'#744210',approved:'#22543d',rejected:'#742a2a',approved_l1:'#2a4365',cancelled:'#4a5568' };
      const stBadge = (st) => `<span style="background:${statusBg[st]||'#e2e8f0'};color:${statusTx[st]||'#4a5568'};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap">${statusLabel[st]||st}</span>`;
      const personBadge = (name, st) => `<div style="font-size:13px;font-weight:600;margin-bottom:3px">${name}</div>${stBadge(st)}`;
      return `<tr>
        <td style="font-size:13px;white-space:nowrap">${fmtDate(r.start_date) || '-'}</td>
        <td><span style="background:#ebf8ff;color:#2c5282;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">${r.leave_type_name}</span></td>
        <td style="text-align:center">${fmtDuration(r.days, r.hours)}</td>
        <td>${stBadge(r.status)}</td>
        <td>${personBadge(checker, checkerStatus)}</td>
        <td>${personBadge(approver, approverStatus)}</td>
      </tr>`;
    }).join('');
  }

  document.getElementById('emp-table-info').textContent =
    total ? `แสดง ${(empPage-1)*pageSize+1}–${Math.min(empPage*pageSize,total)} จากทั้งหมด ${total} รายการ` : 'ไม่มีข้อมูล';

  // pagination
  const pag = document.getElementById('emp-pagination');
  const btnStyle = (active) => `style="padding:6px 13px;border:1.5px solid ${active?'#2b6cb0':'#e2e8f0'};border-radius:8px;cursor:pointer;font-size:13px;font-weight:${active?700:400};background:${active?'linear-gradient(135deg,#1e3a5f,#2b6cb0)':'#fff'};color:${active?'#fff':'#4a5568'};transition:.15s"`;
  let html = `<button ${btnStyle(false)} onclick="empGoPage(${empPage-1})" ${empPage===1?'disabled':''}>‹ ก่อนหน้า</button>`;
  for (let p = 1; p <= Math.min(pages,7); p++) html += `<button ${btnStyle(p===empPage)} onclick="empGoPage(${p})">${p}</button>`;
  html += `<button ${btnStyle(false)} onclick="empGoPage(${empPage+1})" ${empPage===pages?'disabled':''}>ถัดไป ›</button>`;
  pag.innerHTML = html;
}

function empGoPage(p) {
  const pageSize = parseInt(document.getElementById('emp-page-size')?.value || 20);
  const search = (document.getElementById('emp-search')?.value || '').toLowerCase();
  const filtered = empLeaveData.filter(r => !search || (r.leave_type_name||'').toLowerCase().includes(search) || (r.start_date||'').includes(search));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  empPage = Math.max(1, Math.min(p, pages));
  renderEmpTable();
}

// ====== REQUEST ======
async function loadLeaveTypes() {
  const data = await api('GET', '/leave/types');
  console.log('[loadLeaveTypes]', data);
  if (!Array.isArray(data)) {
    console.warn('[loadLeaveTypes] API error:', data);
    return;
  }
  if (!data.length) {
    console.warn('[loadLeaveTypes] ไม่มีประเภทการลาในฐานข้อมูล');
    return;
  }
  leaveTypesCache = data;
  const sel = document.getElementById('req-type');
  if (sel) {
    sel.innerHTML = data.map(t => `<option value="${t.id}">${t.code ? `[${t.code}] ` : ''}${t.name}</option>`).join('');
    sel.removeEventListener('change', updateLeaveDateMin);
    sel.addEventListener('change', updateLeaveDateMin);
  } else {
    console.warn('[loadLeaveTypes] ไม่พบ #req-type element');
  }
  const sick = data.find(t => t.name === 'ลาป่วย');
  sickLeaveTypeId = sick ? sick.id : null;
  const hSel = document.getElementById('hist-filter-type');
  if (hSel && hSel.options.length <= 1) data.forEach(t => { const o = new Option(t.name, t.name); hSel.add(o); });
  const rptTypeSel = document.getElementById('rpt-type');
  if (rptTypeSel && rptTypeSel.options.length <= 1) data.forEach(t => { rptTypeSel.add(new Option(t.name, t.id)); });
}

// ลาล่วงหน้าได้ไม่จำกัด; ย้อนหลัง: ลาป่วย 30 วัน, อื่นๆ ไม่อนุญาต
function updateLeaveDateMin() {
  if (!fpStart || !fpEnd) return;
  const selectedId = parseInt(document.getElementById('req-type')?.value);
  const isSick = sickLeaveTypeId && selectedId === sickLeaveTypeId;
  const today = new Date(); today.setHours(0,0,0,0);
  const minD = isSick ? new Date(today.getTime() - 30 * 86400000) : today;
  fpStart.set('minDate', minD);
  fpEnd.set('minDate', minD);
  if (!isSick) {
    const sv = fpStart.selectedDates[0];
    if (sv && sv < today) { fpStart.clear(); fpEnd.clear(); }
  }
}

// ---- Flatpickr instances ----
let fpStart, fpEnd;

// ===== Date-Time select helpers for leave request form =====
function getReqTimeStr(prefix) {
  const h = document.getElementById(prefix+'-hour')?.value || '08';
  const m = document.getElementById(prefix+'-min')?.value  || '00';
  return `${h}:${m}`;
}
function setReqTimeStr(prefix, timeStr) {
  const [h, m] = (timeStr || '08:00').split(':');
  const hEl = document.getElementById(prefix+'-hour');
  const mEl = document.getElementById(prefix+'-min');
  if (hEl) hEl.value = String(h).padStart(2,'0');
  if (mEl) mEl.value = String(m).padStart(2,'0');
}
function thaiDateLabel(d) {
  if (!d) return null;
  const DOW = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${DOW[d.getDay()]}  ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()+543}`;
}
function initReqTimeSelects() {
  ['req-start','req-end'].forEach(pfx => {
    const hSel = document.getElementById(pfx+'-hour');
    const mSel = document.getElementById(pfx+'-min');
    if (!hSel || hSel.options.length) return;
    for (let h = 0; h < 24; h++) { const v = String(h).padStart(2,'0'); hSel.appendChild(new Option(v,v)); }
    for (let m = 0; m < 60; m++) { const v = String(m).padStart(2,'0'); mSel.appendChild(new Option(v,v)); }
  });
  setReqTimeStr('req-start','08:00');
  setReqTimeStr('req-end','17:00');
}

function fpToISO(fp) {
  const d = fp.selectedDates[0];
  if (!d) return null;
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const prefix = (fp === fpStart) ? 'req-start' : 'req-end';
  return `${dateStr}T${getReqTimeStr(prefix)}`;
}

function initFlatpickr() {
  if (fpStart && fpEnd) return;

  function getMinDate() {
    const selectedId = parseInt(document.getElementById('req-type')?.value);
    const isSick = sickLeaveTypeId && selectedId === sickLeaveTypeId;
    const t = new Date(); t.setHours(0,0,0,0);
    return isSick ? new Date(t.getTime() - 30 * 86400000) : t;
  }

  function enforceMinDate(fp, sel) {
    const minD = getMinDate();
    if (sel[0] && sel[0] < minD) {
      fp.setDate(minD, true);
      const selectedId = parseInt(document.getElementById('req-type')?.value);
      const isSick = sickLeaveTypeId && selectedId === sickLeaveTypeId;
      Swal.fire({ icon:'warning', title:'ไม่สามารถเลือกวันดังกล่าวได้',
        text: isSick ? 'ลาป่วยย้อนหลังได้ไม่เกิน 30 วัน' : 'กรุณาเลือกวันที่ตั้งแต่วันนี้เป็นต้นไป',
        confirmButtonColor:'#1e3a5f' });
    }
  }

  function dateStrFromDate(d) {
    if (!d) return null;
    const pad = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  // เมื่อเลือกวัน → auto-set เวลา (select) ตามเงื่อนไข
  function applyTimeToSelects(dateStr, prefix, side) {
    const range = dateStr ? getWorkTimeRange(dateStr) : null;
    if (range && side) setReqTimeStr(prefix, side === 'max' ? range.maxTime : range.minTime);
  }

  // ตรวจสอบเวลาและแจ้งเตือนถ้าเกินขอบเขต
  let _timeAlertShowing = false;
  function enforceTimeSelects(dateStr, prefix) {
    if (_timeAlertShowing) return;
    const range = dateStr ? getWorkTimeRange(dateStr) : null;
    if (!range) return;
    const timeVal = getReqTimeStr(prefix);
    const [selH, selM] = timeVal.split(':').map(Number);
    const [maxH, maxM] = range.maxTime.split(':').map(Number);
    const [minH, minM] = range.minTime.split(':').map(Number);
    const overMax  = selH > maxH || (selH === maxH && selM > maxM);
    const underMin = selH < minH || (selH === minH && selM < minM);
    if (overMax || underMin) {
      _timeAlertShowing = true;
      const clamp = overMax ? range.maxTime : range.minTime;
      setReqTimeStr(prefix, clamp);
      const d = new Date(dateStr + 'T12:00:00');
      const dowLbl = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'][d.getDay()];
      Swal.fire({ icon:'warning', title:'เกินเวลาทำงาน',
        html: `วัน<b>${dowLbl}</b> เวลาทำงานคือ <b>${range.minTime} – ${range.maxTime} น.</b><br>ระบบปรับเวลาเป็น <b>${clamp} น.</b> ให้อัตโนมัติ`,
        confirmButtonColor:'#1e3a5f' }).then(() => { _timeAlertShowing = false; calcReqDays(); });
    }
  }

  const locale = { ...flatpickr.l10ns.th, firstDayOfWeek: 0,
    weekdays: { shorthand:['อา','จ','อ','พ','พฤ','ศ','ส'], longhand:['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'] } };
  const opts = { enableTime: false, dateFormat: 'd-m-Y', allowInput: false, locale };

  initReqTimeSelects();

  fpStart = flatpickr('#req-start-date', {
    ...opts,
    onChange: (sel) => {
      enforceMinDate(fpStart, sel);
      const ds = dateStrFromDate(sel[0]);
      const lbl = document.getElementById('req-start-date-label');
      if (lbl) { lbl.textContent = thaiDateLabel(sel[0]) || ''; lbl.classList.remove('placeholder'); }
      applyTimeToSelects(ds, 'req-start', 'min');
      enforceTimeSelects(ds, 'req-start');
      calcReqDays();
    },
  });
  fpEnd = flatpickr('#req-end-date', {
    ...opts,
    onChange: (sel) => {
      enforceMinDate(fpEnd, sel);
      const ds = dateStrFromDate(sel[0]);
      const lbl = document.getElementById('req-end-date-label');
      if (lbl) { lbl.textContent = thaiDateLabel(sel[0]) || ''; lbl.classList.remove('placeholder'); }
      applyTimeToSelects(ds, 'req-end', 'max');
      enforceTimeSelects(ds, 'req-end');
      calcReqDays();
      const sv = fpStart ? fpToISO(fpStart) : null;
      const ev = fpToISO(fpEnd);
      if (sv && ev && new Date(ev) <= new Date(sv)) {
        Swal.fire({ icon:'error', title:'วันที่/เวลาไม่ถูกต้อง',
          html:'<b>วันที่สิ้นสุดการลา</b> ต้องอยู่หลัง<br><b>วันที่เริ่มลา</b> กรุณาเลือกใหม่',
          confirmButtonText:'ตกลง', confirmButtonColor:'#1e3a5f' });
      }
    },
  });
}

// คำนวณวันลาโดยใช้ประเภทพนักงาน (mirrors backend calcLeaveResult)
function calcLeaveResultFE(startDateStr, endDateStr, startDtStr, endDtStr) {
  const start = new Date(startDateStr + 'T00:00:00');
  const end   = new Date(endDateStr   + 'T00:00:00');
  let totalHours = 0, totalDays = 0;
  const cur = new Date(start);
  const pad = n => String(n).padStart(2, '0');
  const empType = user?.employee_type || 'monthly';

  // เวลาเลิกงานแต่ละวัน (นาทีนับจาก 00:00)
  function workEndMin(dow) {
    if (empType === 'monthly') {
      if (dow <= 4) return 18 * 60; // จ-พฤ 18:00
      if (dow === 5) return 17 * 60; // ศ 17:00
      return 12 * 60;               // ส 12:00
    }
    return 18 * 60;
  }
  const WORK_START_MIN = 8 * 60; // 08:00

  // คำนวนชั่วโมงจริงในช่วง fromMin-toMin หักพัก 12:00-13:00 ถ้าผ่าน
  function calcRangeHours(fromMin, toMin, maxH) {
    let mins = Math.max(0, toMin - fromMin);
    const lS = 12 * 60, lE = 13 * 60;
    if (fromMin < lE && toMin > lS)
      mins -= Math.max(0, Math.min(toMin, lE) - Math.max(fromMin, lS));
    return Math.min(Math.max(0, mins / 60), maxH);
  }

  while (cur <= end) {
    const ds = `${cur.getFullYear()}-${pad(cur.getMonth()+1)}-${pad(cur.getDate())}`;
    const maxH = getWorkHoursForDayFE(ds);
    const dow  = cur.getDay();
    if (maxH > 0) {
      if (startDateStr === endDateStr) {
        // วันเดียว: หักพักเที่ยงด้วย calcRangeHours
        const st = new Date(startDtStr);
        const et = new Date(endDtStr);
        const h = calcRangeHours(st.getHours()*60 + st.getMinutes(), et.getHours()*60 + et.getMinutes(), maxH);
        totalHours += h;
        totalDays  += h > 0 ? Math.max(0.5, Math.round((h / maxH) * 2) / 2) : 0;
      } else {
        const isFirst = ds === startDateStr;
        const isLast  = ds === endDateStr;
        if (!isFirst && !isLast) {
          // วันกลาง: เต็มวัน
          totalHours += maxH;
          totalDays  += maxH < 5 ? 0.5 : 1;
        } else if (isFirst) {
          // วันแรก: จาก start_time ถึง work_end
          const st = new Date(startDtStr);
          const h  = calcRangeHours(st.getHours() * 60 + st.getMinutes(), workEndMin(dow), maxH);
          totalHours += h;
          totalDays  += h > 0 ? Math.max(0.5, Math.round((h / maxH) * 2) / 2) : 0;
        } else {
          // วันสุดท้าย: จาก 08:00 ถึง end_time
          const et = new Date(endDtStr);
          const h  = calcRangeHours(WORK_START_MIN, et.getHours() * 60 + et.getMinutes(), maxH);
          totalHours += h;
          totalDays  += h > 0 ? Math.max(0.5, Math.round((h / maxH) * 2) / 2) : 0;
        }
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return { hours: totalHours, days: Math.max(totalDays > 0 ? 0.5 : 0, totalDays) };
}

function calcReqDays() {
  const sv = fpStart ? fpToISO(fpStart) : null;
  const ev = fpEnd   ? fpToISO(fpEnd)   : null;
  const box = document.getElementById('req-duration-box');

  if (!sv || !ev) {
    if (box) box.style.display = 'none';
    document.getElementById('req-days').textContent = '';
    return;
  }

  const start = new Date(sv);
  const end   = new Date(ev);
  if (box) box.style.display = '';

  if (end <= start) {
    document.getElementById('req-days').textContent = '';
    document.getElementById('req-duration-text').textContent = '⚠️ กรุณาตรวจสอบวันที่และเวลา';
    document.getElementById('req-days-work').textContent  = '-';
    document.getElementById('req-hours-extra').textContent = '-';
    document.getElementById('req-mins-total').textContent  = '-';
    document.getElementById('req-duration-detail').textContent = 'วันที่สิ้นสุดต้องอยู่หลังวันที่เริ่มลา';
    return;
  }

  const startDateStr = sv.slice(0, 10);
  const endDateStr   = ev.slice(0, 10);
  const { hours: workHours, days: workDays } = calcLeaveResultFE(startDateStr, endDateStr, sv, ev);

  // ฐานการแสดงผล: 1 วัน = 8 ชม. เสมอ
  // จ-พฤ รายเดือน เต็มวัน: workHours=9 → 9÷8 = 1 วัน เหลือ 1 ชม.
  // ศ รายเดือน เต็มวัน:    workHours=8 → 8÷8 = 1 วัน เหลือ 0 ชม.
  const DISPLAY_H_PER_DAY = 8;
  const fullDays    = Math.floor(workHours / DISPLAY_H_PER_DAY);
  const remHoursRaw = workHours - fullDays * DISPLAY_H_PER_DAY;
  const extraH      = Math.max(0, Math.floor(remHoursRaw));
  const extraMin    = Math.max(0, Math.round((remHoursRaw - extraH) * 60));

  const isPartialDay = workHours < DISPLAY_H_PER_DAY;
  const summaryParts = [];
  if (fullDays > 0) summaryParts.push(`${fullDays} วัน`);
  if (extraH   > 0) summaryParts.push(`${extraH} ชั่วโมง`);
  if (extraMin > 0) summaryParts.push(`${extraMin} นาที`);
  const summaryText = summaryParts.join(' ') || `${workHours.toFixed(1)} ชั่วโมง`;

  document.getElementById('req-days').textContent = `รวม ${summaryText}`;
  document.getElementById('req-duration-text').textContent = `${fullDays} วัน / ${extraH} ชม. ${extraMin} นาที  (${workHours.toFixed(2)} ชม.)`;
  document.getElementById('req-days-work').textContent  = fullDays;
  document.getElementById('req-hours-extra').textContent = extraH;
  document.getElementById('req-mins-total').textContent  = extraMin;

  const fmt = dt => {
    const d = new Date(dt);
    return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} น.`;
  };
  document.getElementById('req-duration-detail').textContent = `${fmt(sv)} — ${fmt(ev)}`;

  // ===== Validation Alerts =====
  // ตรวจสอบหลังจาก user เลือกวันที่ครบแล้ว (ทั้ง start และ end)
  const warnings = [];

  // 1. ตรวจวันหยุด — วันเริ่มหรือสิ้นสุดตรงกับวันหยุด
  const checkD = new Date(startDateStr + 'T00:00:00');
  const endD   = new Date(endDateStr   + 'T00:00:00');
  const holidayNames = [];
  for (let d = new Date(checkD); d <= endD; d.setDate(d.getDate() + 1)) {
    const pad = n => String(n).padStart(2,'0');
    const ds = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const dow = d.getDay();
    // วันอาทิตย์ = 0
    if (dow === 0) { holidayNames.push(`${d.getDate()}/${d.getMonth()+1} (อาทิตย์)`); continue; }
    if (isCompanyHoliday(ds)) holidayNames.push(`${d.getDate()}/${d.getMonth()+1} — ${companyHolidayName(ds)}`);
  }
  if (holidayNames.length) {
    warnings.push({ icon: 'warning', title: '📅 วันที่เลือกมีวันหยุด', html:
      '<div style="text-align:left">ช่วงลาของคุณมีวันหยุดดังนี้:<br><ul style="margin:8px 0 0 16px">'
      + holidayNames.map(n => `<li>${n}</li>`).join('')
      + '</ul><br><span style="color:#718096;font-size:12px">วันหยุดจะไม่ถูกนับเป็นวันลา</span></div>'
    });
  }

  // 2. วันลาทั้งหมดเป็น 0 (เลือกแต่วันหยุด/เสาร์-อาทิตย์)
  if (workHours === 0 && !end <= start) {
    warnings.push({ icon: 'error', title: '❌ ไม่มีวันทำงานในช่วงที่เลือก',
      text: 'วันที่เลือกทั้งหมดเป็นวันหยุดหรือวันไม่มีการทำงาน กรุณาเลือกวันใหม่'
    });
  }

  // 3. ตรวจโควต้า
  const ltSel = document.getElementById('req-type');
  if (ltSel && ltSel.value && empBalanceCache.length && workDays > 0) {
    const ltId = parseInt(ltSel.value);
    const bal  = empBalanceCache.find(b => Number(b.leave_type_id) === ltId);
    if (bal) {
      const remain = Math.max(0, (bal.total_days || 0) - (bal.used_days || 0));
      if (workDays > remain) {
        warnings.push({ icon: 'warning', title: '⚠️ วันลาเกินโควต้า',
          html: `<div style="text-align:left;line-height:1.9">
            ประเภทการลา: <b>${bal.leave_type_name}</b><br>
            โควต้าคงเหลือ: <b style="color:#38a169">${remain} วัน</b><br>
            วันที่ขอลา: <b style="color:#c53030">${workDays} วัน</b><br>
            เกินโควต้า: <b style="color:#c53030">${(workDays - remain).toFixed(1)} วัน</b><br>
            <span style="font-size:12px;color:#718096">วันที่เกินจะถือเป็นลาไม่รับค่าจ้าง</span>
          </div>`
        });
      }
    }
  }

  // แสดง alert ทีละอัน (queue)
  if (warnings.length) {
    (async function showWarnings() {
      for (const w of warnings) {
        await Swal.fire({ confirmButtonColor: '#1e3a5f', confirmButtonText: 'รับทราบ', ...w });
      }
    })();
  }
}
const updateDays = calcReqDays;

function showSelectedFiles() {
  const files = document.getElementById('req-files').files;
  const el = document.getElementById('req-file-list');
  if (!files.length) { el.innerHTML = ''; return; }
  el.innerHTML = Array.from(files).map(f => `<span style="display:inline-block;margin:2px 6px 2px 0;padding:3px 10px;background:#ebf4ff;border-radius:20px">📎 ${f.name} (${(f.size/1024).toFixed(0)} KB)</span>`).join('');
}

async function loadDepartments() {
  const data = await api('GET', '/leave/departments');
  if (data.error) return;
  const sel = document.getElementById('req-dept');
  sel.innerHTML = '<option value="">-- เลือกหน่วยงาน --</option>';
  if (data.units?.length) {
    data.units.forEach(u => { const o = document.createElement('option'); o.value = u; o.textContent = u; sel.appendChild(o); });
  }
}

async function loadApprovers() {
  initFlatpickr();
  loadDepartments();
  const data = await api('GET', '/leave/approvers');
  if (data.error) return;
  const fill = (selId, items, placeholder) => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    sel.innerHTML = `<option value="">${placeholder}</option>` + items.map(u =>
      `<option value="${u.id}">${u.name} (${u.employee_id}) — ${u.department || u.unit || ''}</option>`
    ).join('');
  };
  fill('req-approver1', data.level1 || [], '-- เลือกผู้ตรวจสอบ (หัวหน้าหน่วย/แผนก) --');
  fill('req-approver3', data.level2 || [], '-- เลือกผู้อนุมัติ (ผู้จัดการ) --');
}

// ดึง location ครั้งเดียว cache ไว้ใช้ในรอบ submit เดียวกัน
async function getLocationOnce() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { timeout: 5000, maximumAge: 60000 }
    );
  });
}

async function addWatermarkToImage(file, locText) {
  if (!file.type.startsWith('image/')) return file; // ไม่ใช่รูป → ส่งต่อตามเดิม
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // timestamp
      const now = new Date();
      const ts = now.toLocaleString('th-TH', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });

      const fontSize = Math.max(20, Math.round(img.width * 0.025));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textBaseline = 'bottom';

      const lines = [ts];
      if (locText) lines.push(`📍 ${locText}`);
      lines.push('ระบบลาออนไลน์');

      const pad = fontSize * 0.5;
      const lineH = fontSize * 1.4;
      const boxH = lines.length * lineH + pad;
      const boxW = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2;

      // พื้นหลังโปร่งใส
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(pad, img.height - boxH - pad, boxW, boxH);

      ctx.fillStyle = '#ffffff';
      lines.forEach((line, i) => {
        ctx.fillText(line, pad * 1.5, img.height - pad - (lines.length - 1 - i) * lineH);
      });

      canvas.toBlob(blob => resolve(new File([blob], file.name, { type: 'image/jpeg' })), 'image/jpeg', 0.92);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function submitRequest() {
  clearAlert('req-alert');
  const leave_type_id = document.getElementById('req-type').value;
  const start_iso  = fpStart ? fpToISO(fpStart) : null;
  const end_iso    = fpEnd   ? fpToISO(fpEnd)   : null;
  const start_date = start_iso ? start_iso.slice(0, 10) : '';
  const end_date   = end_iso   ? end_iso.slice(0, 10)   : '';
  const reason        = document.getElementById('req-reason').value.trim();
  const approver1_id  = document.getElementById('req-approver1').value;
  const approver2_id  = document.getElementById('req-approver3').value;

  if (!start_date || !end_date) return swalError('กรุณาเลือกวันที่ลา');
  if (!reason) return swalError('กรุณาระบุเหตุผลการลา');
  if (start_iso && end_iso && new Date(end_iso) <= new Date(start_iso))
    return swalError('วันที่/เวลาสิ้นสุดต้องอยู่หลังวันที่เริ่มลา');
  if (!approver1_id || !approver2_id) return swalError('กรุณาเลือกผู้อนุมัติทุกส่วน');

  const selLeaveType = (leaveTypesCache || []).find(lt => String(lt.id) === String(leave_type_id));
  const overDaysLimit = selLeaveType?.requires_doc_over_days || 0;
  const currentDays = parseFloat(document.getElementById('req-days-all')?.textContent) || 0;
  const files = document.getElementById('req-files').files;
  if (overDaysLimit > 0 && currentDays >= overDaysLimit && files.length === 0) {
    return Swal.fire({
      icon: 'warning', title: 'ต้องแนบเอกสาร',
      html: `การลา <b>${selLeaveType?.name || ''}</b> เกิน <b>${overDaysLimit} วัน</b><br>กรุณาแนบเอกสารประกอบการลา`,
      confirmButtonColor: '#1e3a5f', confirmButtonText: 'ตกลง',
    });
  }

  // ขอ location ล่วงหน้า (ถ้ามีไฟล์รูป)
  const hasImages = Array.from(files).some(f => f.type.startsWith('image/'));
  let locText = null;
  if (hasImages) {
    const loc = await getLocationOnce();
    if (loc) locText = `${loc.lat}, ${loc.lng} (±${loc.acc}m)`;
  }

  async function doSubmitRequest(allowUnpaid) {
    // ประมวลผลลายน้ำสำหรับรูปภาพ
    const processedFiles = await Promise.all(
      Array.from(files).map(f => addWatermarkToImage(f, locText))
    );

    const fd = new FormData();
    fd.append('leave_type_id', leave_type_id);
    fd.append('start_date', start_date);
    fd.append('end_date', end_date);
    fd.append('start_datetime', start_iso || '');
    fd.append('end_datetime', end_iso || '');
    fd.append('reason', reason);
    fd.append('department', document.getElementById('req-dept').value);
    fd.append('approver1_id', approver1_id);
    fd.append('approver2_id', approver2_id);
    if (allowUnpaid) fd.append('allow_unpaid', 'true');
    for (const f of processedFiles) fd.append('attachments', f);

    const resp = await fetch('/api/leave/request', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd,
    });
    const r = await resp.json();

    // ลาเกินโควต้า → แสดง confirm dialog
    if (r.over_quota) {
      const result = await Swal.fire({
        icon: 'warning',
        title: '⚠️ ลาเกินโควต้า',
        html: `<div style="text-align:left;line-height:1.8">
          โควต้าคงเหลือ <b style="color:#c53030">${r.remain} วัน</b><br>
          ลาเกินโควต้า <b style="color:#c53030">${r.excess} วัน</b><br><br>
          วันลาที่เกิน <b>${r.excess} วัน</b> จะถือเป็น<br>
          <b style="color:#c53030;font-size:15px">❌ ลาไม่รับค่าจ้าง (Unpaid Leave)</b>
        </div>`,
        showCancelButton: true,
        confirmButtonColor: '#c53030',
        cancelButtonColor: '#718096',
        confirmButtonText: 'ยืนยัน — ยอมรับลาไม่รับค่าจ้าง',
        cancelButtonText: 'ยกเลิก',
      });
      if (result.isConfirmed) await doSubmitRequest(true);
      return;
    }

    if (!resp.ok) return swalError(r.message || 'เกิดข้อผิดพลาด');
    historyCache = [];
    const unpaidNote = r.is_unpaid_excess ? `\n⚠️ ลาเกินโควต้า ${r.unpaid_excess_days} วัน (ไม่รับค่าจ้าง)` : '';
    swalSuccess(`ยื่นคำขอลาสำเร็จ เลขที่ ${r.request_no}${unpaidNote}` + (r.attachments ? ` (ไฟล์แนบ ${r.attachments} ไฟล์)` : ''), () => { historyCache = []; loadBalance(); loadHistory(); switchTab('home'); });
  }
  await doSubmitRequest(false);
  historyCache = [];
  if (fpStart) { fpStart.clear(); } else document.getElementById('req-start-date')?.classList.add('placeholder');
  if (fpEnd)   { fpEnd.clear();   } else document.getElementById('req-end-date')?.classList.add('placeholder');
  ['req-start-date-label','req-end-date-label'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = 'ยังไม่ได้เลือกวัน'; el.classList.add('placeholder'); }
  });
  setReqTimeStr('req-start','08:00');
  setReqTimeStr('req-end','17:00');
  document.getElementById('req-reason').value = '';
  document.getElementById('req-days').textContent = '';
  const dbox = document.getElementById('req-duration-box'); if (dbox) dbox.style.display = 'none';
  document.getElementById('req-files').value = '';
  document.getElementById('req-file-list').innerHTML = '';
  loadBalance();
  loadHistory();
}

// ====== HISTORY ======
let historyCache = [];
let histCurrentPage = 1;
async function loadHistory(forceRefresh) {
  // refresh เสมอ — ล้าง cache เก่าทิ้ง
  const data = await api('GET', '/leave/my-requests');
  historyCache = Array.isArray(data) ? data : [];
  // populate leave type filter
  const types = [...new Set(historyCache.map(r => r.leave_type_name))].filter(Boolean);
  const sel = document.getElementById('hist-filter-type');
  if (sel) {
    sel.innerHTML = '<option value="">-- ทุกประเภท --</option>';
    types.forEach(t => { const o = new Option(t,t); sel.add(o); });
  }
  // default ปีปัจจุบัน
  const yearEl = document.getElementById('hist-filter-year');
  if (yearEl && !yearEl.value) yearEl.value = new Date().getFullYear();
  histCurrentPage = 1;
  renderHistoryTable();
}

function clearHistFilters() {
  const s = document.getElementById('hist-filter-status');
  const t = document.getElementById('hist-filter-type');
  const y = document.getElementById('hist-filter-year');
  if (s) s.value = '';
  if (t) t.value = '';
  if (y) y.value = '';
  histCurrentPage = 1;
  renderHistoryTable();
}

function histGoPage(p) { histCurrentPage = p; renderHistoryTable(); }

function renderHistoryTable() {
  const filterStatus = document.getElementById('hist-filter-status')?.value || '';
  const filterType   = document.getElementById('hist-filter-type')?.value || '';
  const filterYear   = document.getElementById('hist-filter-year')?.value || '';

  let data = historyCache;
  if (filterStatus) data = data.filter(r => r.status === filterStatus);
  if (filterType)   data = data.filter(r => r.leave_type_name === filterType);
  if (filterYear)   data = data.filter(r => (r.start_date||'').startsWith(filterYear));

  const tbody    = document.getElementById('history-tbody');
  const pageSize = parseInt(document.getElementById('hist-page-size')?.value || '20');
  const total    = data.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (histCurrentPage > totalPages) histCurrentPage = 1;
  const start = (histCurrentPage - 1) * pageSize;
  const pageData = data.slice(start, start + pageSize);

  // page info
  const infoEl = document.getElementById('hist-page-info');
  if (infoEl) infoEl.textContent = total ? `แสดง ${start+1}–${Math.min(start+pageSize,total)} จาก ${total} รายการ` : '';

  // pagination buttons
  const pagEl = document.getElementById('hist-pagination');
  if (pagEl) {
    const btnStyle = (active) => `border:1.5px solid ${active?'#1e3a5f':'#e2e8f0'};border-radius:8px;padding:5px 11px;font-size:13px;font-weight:${active?'700':'400'};background:${active?'#1e3a5f':'#fff'};color:${active?'#fff':'#2d3748'};cursor:pointer`;
    let html = '';
    if (histCurrentPage > 1) html += `<button style="${btnStyle(false)}" onclick="histGoPage(${histCurrentPage-1})">‹</button>`;
    const range = 2;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= histCurrentPage - range && i <= histCurrentPage + range)) {
        html += `<button style="${btnStyle(i===histCurrentPage)}" onclick="histGoPage(${i})">${i}</button>`;
      } else if (i === histCurrentPage - range - 1 || i === histCurrentPage + range + 1) {
        html += `<span style="padding:5px 4px;color:#a0aec0">…</span>`;
      }
    }
    if (histCurrentPage < totalPages) html += `<button style="${btnStyle(false)}" onclick="histGoPage(${histCurrentPage+1})">›</button>`;
    pagEl.innerHTML = html;
  }

  // update banner count
  const totalCountEl = document.getElementById('hist-total-count');
  const summaryBadge = document.getElementById('hist-summary-badge');
  if (totalCountEl) totalCountEl.textContent = total;
  if (summaryBadge) summaryBadge.style.display = total ? 'block' : 'none';

  if (!pageData.length) {
    document.getElementById('history-tbody').innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#a0aec0;font-size:14px">ไม่พบข้อมูลที่ตรงกัน</td></tr>';
    const cardsEl = document.getElementById('history-cards');
    if (cardsEl) cardsEl.innerHTML = '<div style="text-align:center;padding:40px;color:#a0aec0;font-size:14px">ไม่พบข้อมูลที่ตรงกัน</div>';
    return;
  }

  const isMobile = window.innerWidth < 640;
  const cardsEl = document.getElementById('history-cards');
  const tableWrap = document.querySelector('.hist-table-wrap');

  if (isMobile) {
    if (tableWrap) tableWrap.style.display = 'none';
    if (cardsEl)  { cardsEl.style.display = 'flex'; }
  } else {
    if (tableWrap) tableWrap.style.display = '';
    if (cardsEl)  cardsEl.style.display = 'none';
  }

  const approvalInfo = (r, level) => {
    const a = (r.approvals || []).find(x => x.level === level);
    if (!a) return { name: '-', cls: 'none' };
    return { name: a.approver_name || '-', cls: a.status === 'approved' ? 'done' : a.status === 'rejected' ? 'fail' : 'active' };
  };
  const approvalBadgeColor = { done:'#c6f6d5;color:#22543d', fail:'#fed7d7;color:#742a2a', active:'#bee3f8;color:#2a4365', none:'#e2e8f0;color:#718096' };
  const approvalBadgeLabel = { done:'✓ อนุมัติ', fail:'✕ ปฏิเสธ', active:'⏳ รอ', none:'-' };

  const attsHtml = (r) => (r.attachments || []).map(a =>
    `<span onclick="downloadFile('${a.filename}','${a.original_name.replace(/'/g,"\\'")}\")" style="font-size:11px;color:#4299e1;cursor:pointer;display:inline-flex;align-items:center;gap:3px;padding:2px 6px;background:#ebf8ff;border-radius:6px;margin:2px" title="${a.original_name}">📎 ${a.original_name.length>18?a.original_name.slice(0,15)+'…':a.original_name}</span>`
  ).join('');

  // ── desktop TABLE rows ──
  tbody.innerHTML = pageData.map((r,i) => {
    const a1 = approvalInfo(r,1), a2 = approvalInfo(r,2);
    const dateRange = r.start_date !== r.end_date
      ? `${fmtDate(r.start_date)} <span style="color:#a0aec0">–</span> ${fmtDate(r.end_date)}`
      : fmtDate(r.start_date);
    const rowBg = i % 2 === 0 ? '#fff' : '#fafcff';
    return `<tr style="background:${rowBg};transition:background .12s" onmouseover="this.style.background='#eef6ff'" onmouseout="this.style.background='${rowBg}'">
      <td style="padding:12px 14px;border-bottom:1px solid #edf2f7">
        <span style="font-family:monospace;font-size:11px;background:#f0f4f8;padding:4px 9px;border-radius:8px;color:#4a5568;letter-spacing:.3px">${r.request_no}</span>
        ${r.is_backdated ? '<div style="margin-top:4px"><span style="background:#fff3cd;color:#856404;font-size:10px;padding:1px 6px;border-radius:6px">ย้อนหลัง</span></div>' : ''}
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid #edf2f7">
        <span style="background:#ebf8ff;color:#2c5282;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;display:inline-block">${r.leave_type_name}</span>
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid #edf2f7;font-size:13px;color:#2d3748;white-space:nowrap">${dateRange}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #edf2f7;text-align:center">${fmtDuration(r.days, r.hours)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #edf2f7;text-align:center">${statusBadge(r.status)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #edf2f7">
        <div style="font-size:12px;font-weight:600;color:#2d3748">${a1.name}</div>
        <span style="font-size:10px;padding:2px 7px;border-radius:10px;background:${approvalBadgeColor[a1.cls]};display:inline-block;margin-top:3px">${approvalBadgeLabel[a1.cls]}</span>
        ${attsHtml(r) ? `<div style="margin-top:5px">${attsHtml(r)}</div>` : ''}
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid #edf2f7">
        <div style="font-size:12px;font-weight:600;color:#2d3748">${a2.name}</div>
        <span style="font-size:10px;padding:2px 7px;border-radius:10px;background:${approvalBadgeColor[a2.cls]};display:inline-block;margin-top:3px">${approvalBadgeLabel[a2.cls]}</span>
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid #edf2f7;text-align:center">
        ${r.status==='pending' ? `<button onclick="cancelRequest(${r.id})" style="background:#fff5f5;color:#c53030;border:1.5px solid #fed7d7;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer">✕ ยกเลิก</button>` : '<span style="color:#cbd5e0;font-size:13px">—</span>'}
      </td>
    </tr>`;
  }).join('');

  // ── mobile CARDS ──
  if (cardsEl) {
    cardsEl.innerHTML = pageData.map(r => {
      const a1 = approvalInfo(r,1), a2 = approvalInfo(r,2);
      const dateRange = r.start_date !== r.end_date ? `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}` : fmtDate(r.start_date);
      const statusColors = { pending:'#ebf8ff;color:#2b6cb0', approved_l1:'#fefcbf;color:#744210', approved:'#f0fff4;color:#22543d', rejected:'#fff5f5;color:#c53030', cancelled:'#f7fafc;color:#718096' };
      const sc = statusColors[r.status] || '#f7fafc;color:#718096';
      return `<div style="background:#fff;border-radius:14px;border:1.5px solid #e2e8f0;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.05)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;gap:8px">
          <div>
            <span style="font-family:monospace;font-size:11px;background:#f0f4f8;padding:3px 8px;border-radius:6px;color:#4a5568">${r.request_no}</span>
            ${r.is_backdated ? '<span style="background:#fff3cd;color:#856404;font-size:10px;padding:1px 6px;border-radius:6px;margin-left:4px">ย้อนหลัง</span>' : ''}
          </div>
          <span style="background:${sc};padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap">${{pending:'รอตรวจสอบ',approved_l1:'รอระดับ 2',approved:'อนุมัติแล้ว',rejected:'ไม่อนุมัติ',cancelled:'ยกเลิก'}[r.status]||r.status}</span>
        </div>
        <div style="margin-bottom:8px">
          <span style="background:#ebf8ff;color:#2c5282;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">${r.leave_type_name}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;margin-bottom:10px">
          <div style="background:#f7fafc;border-radius:10px;padding:8px 10px">
            <div style="font-size:10px;color:#a0aec0;margin-bottom:2px">📅 ช่วงวันที่</div>
            <div style="font-weight:600;color:#2d3748">${dateRange}</div>
          </div>
          <div style="background:#f7fafc;border-radius:10px;padding:8px 10px;text-align:center">
            <div style="font-size:10px;color:#a0aec0;margin-bottom:2px">⏱ จำนวน</div>
            <div>${fmtDuration(r.days, r.hours)}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;margin-bottom:${r.status==='pending'||attsHtml(r)?'10px':'0'}">
          <div style="background:#f7fafc;border-radius:10px;padding:8px 10px">
            <div style="font-size:10px;color:#a0aec0;margin-bottom:3px">👤 ผู้ตรวจสอบ</div>
            <div style="font-weight:600;color:#2d3748;font-size:12px">${a1.name}</div>
            <span style="font-size:10px;padding:1px 6px;border-radius:8px;background:${approvalBadgeColor[a1.cls]};display:inline-block;margin-top:2px">${approvalBadgeLabel[a1.cls]}</span>
          </div>
          <div style="background:#f7fafc;border-radius:10px;padding:8px 10px">
            <div style="font-size:10px;color:#a0aec0;margin-bottom:3px">✅ ผู้อนุมัติ</div>
            <div style="font-weight:600;color:#2d3748;font-size:12px">${a2.name}</div>
            <span style="font-size:10px;padding:1px 6px;border-radius:8px;background:${approvalBadgeColor[a2.cls]};display:inline-block;margin-top:2px">${approvalBadgeLabel[a2.cls]}</span>
          </div>
        </div>
        ${attsHtml(r) ? `<div style="margin-bottom:8px">${attsHtml(r)}</div>` : ''}
        ${r.status==='pending' ? `<button onclick="cancelRequest(${r.id})" style="width:100%;background:#fff5f5;color:#c53030;border:1.5px solid #fed7d7;border-radius:10px;padding:9px;font-size:13px;font-weight:700;cursor:pointer">✕ ยกเลิกคำขอ</button>` : ''}
      </div>`;
    }).join('');
  }
}

async function downloadFile(filename, originalName) {
  const resp = await fetch(`/api/leave/file/${filename}`, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!resp.ok) return swalError('ไม่สามารถดาวน์โหลดไฟล์ได้');
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = originalName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function cancelRequest(id) {
  swalConfirm('ยืนยันการยกเลิกคำขอลานี้?', async () => {
    const r = await api('DELETE', `/leave/request/${id}`);
    if (r.error) return swalError(r.error);
    historyCache = [];
    swalSuccess('ยกเลิกคำขอลาสำเร็จ', () => { loadHistory(); loadBalance(); });
  });
}

// ====== APPROVE ======
async function loadPending() {
  _approveRowMap = {};
  const data = await api('GET', '/leave/pending');
  const tbody = document.getElementById('approve-tbody');
  if (!Array.isArray(data) || !data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">ไม่มีรายการรออนุมัติ</td></tr>'; return;
  }
  data.forEach(r => { _approveRowMap[r.approval_id] = r; });
  tbody.innerHTML = data.map(r => `<tr>
    <td style="font-family:monospace;font-size:13px">${r.request_no}</td>
    <td>${r.employee_name}<br><span style="font-size:12px;color:#718096">${r.emp_code}</span></td>
    <td><span style="font-size:12px">${r.unit}<br>${r.department}</span></td>
    <td>${r.leave_type_name}</td>
    <td style="font-size:13px">${fmtDate(r.start_date)}${r.start_date !== r.end_date ? ' – ' + fmtDate(r.end_date) : ''}</td>
    <td style="text-align:center">${fmtDuration(r.days, r.hours)}</td>
    <td style="font-size:13px;max-width:150px">${r.reason}</td>
    <td><button class="btn btn-primary btn-sm" onclick="openApproveModal(${r.approval_id})">ดำเนินการ</button></td>
  </tr>`).join('');
}

async function loadApproveHistory() {
  const data = await api('GET', '/leave/history');
  const tbody = document.getElementById('ahist-tbody');
  if (!Array.isArray(data) || !data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">ยังไม่มีประวัติ</td></tr>'; return;
  }
  tbody.innerHTML = data.map(r => {
    const lvlLabel = r.approval_level === 1 ? 'ระดับตรวจสอบ' : 'ระดับอนุมัติ';
    const badge = r.approval_status === 'approved'
      ? `<span class="badge badge-approved">อนุมัติ</span>`
      : `<span class="badge badge-rejected">ปฏิเสธ</span>`;
    return `<tr>
    <td style="font-family:monospace;font-size:13px">${r.request_no}</td>
    <td>${r.employee_name}</td>
    <td>${r.leave_type_name}</td>
    <td style="font-size:13px">${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}<br>${fmtDuration(r.days, r.hours)}</td>
    <td>${badge} <span style="font-size:11px;color:#718096">${lvlLabel}</span></td>
    <td style="font-size:13px">${r.comment || '-'}</td>
    <td style="font-size:12px;color:#718096">${r.acted_at ? fmtDate(r.acted_at.slice(0,10)) + ' ' + r.acted_at.slice(11,16) : '-'}</td>
  </tr>`;
  }).join('');
}

function openApproveModal(approvalId) {
  const row = _approveRowMap[approvalId];
  if (!row) return;
  currentApprovalId = approvalId;
  document.getElementById('modal-comment').value = '';
  document.getElementById('modal-info').innerHTML = `
    <b>พนักงาน:</b> ${row.employee_name} (${row.emp_code})<br>
    <b>ประเภท:</b> ${row.leave_type_name}<br>
    <b>วันที่:</b> ${fmtDate(row.start_date)} – ${fmtDate(row.end_date)} (${row.days} วัน)<br>
    <b>เหตุผล:</b> ${row.reason}
  `;
  document.getElementById('approve-modal').classList.add('open');
}

function closeApproveModal() { document.getElementById('approve-modal').classList.remove('open'); }

async function submitApproval(action) {
  const comment = document.getElementById('modal-comment').value.trim();
  if (action === 'reject' && !comment) {
    return swalError('กรุณาระบุหมายเหตุสำหรับการปฏิเสธ');
  }
  const r = await api('POST', `/leave/approve/${currentApprovalId}`, { action, comment });
  closeApproveModal();
  if (r.error) return swalError(r.error);
  if (action === 'approve') {
    Swal.fire({ icon: 'success', title: 'อนุมัติแล้ว', confirmButtonColor: '#276749', confirmButtonText: 'ตกลง' })
      .then(() => { loadPending(); loadApproveHistory(); });
  } else {
    Swal.fire({ icon: 'error', title: 'ไม่อนุมัติ', confirmButtonColor: '#c53030', confirmButtonText: 'ตกลง' })
      .then(() => { loadPending(); loadApproveHistory(); });
  }
}

// ====== REPORT ======
let rptAllData = [];
let rptPage = 1;
const RPT_PAGE_SIZE = 30;

function isValidDateStr(d) { return d && /^\d{4}-\d{2}-\d{2}$/.test(d); }
function fmtDate(d) {
  if (!d) return '';
  if (!isValidDateStr(d)) return '⚠️ วันที่ผิดพลาด';
  const [y, m, day] = d.split('-');
  return `${day}-${m}-${y}`;
}
function fmtDuration(days, hours) {
  const d = Number(days) || 0;
  const h = Number(hours) || 0;
  let text, color;
  const parts = [];
  if (d > 0) parts.push(`${d} วัน`);
  if (h > 0) {
    const wholeH = Math.floor(h);
    const mins   = Math.round((h - wholeH) * 60);
    if (wholeH > 0) parts.push(`${wholeH} ชม.`);
    if (mins > 0)   parts.push(`${mins} นาที`);
  }
  if (parts.length === 0) { text = '0'; color = '#718096'; }
  else { text = parts.join(' '); color = d >= 1 ? '#1e3a5f' : '#2b6cb0'; }
  return `<div style="font-weight:700;font-size:13px;color:${color}">${text}</div>`;
}

async function loadReport() {
  const year   = (document.getElementById('rpt-year')?.value || '').trim();
  const dept   = (document.getElementById('rpt-dept')?.value || '').trim();
  const tbody  = document.getElementById('report-tbody');
  tbody.innerHTML = '<tr><td colspan="9" class="empty">กำลังโหลด...</td></tr>';
  let url = `/leave/report?`;
  if (year) url += `year=${year}&`;
  if (dept) url += `department=${encodeURIComponent(dept)}&`;
  const data = await api('GET', url);
  if (!Array.isArray(data)) {
    tbody.innerHTML = `<tr><td colspan="10" style="color:#e53e3e;padding:16px;text-align:center">⚠️ ${data?.error || 'โหลดไม่ได้'}</td></tr>`;
    return;
  }
  rptAllData = data;
  rptPage = 1;
  renderReport();
}

function renderReport() {
  const empQ   = (document.getElementById('rpt-emp')?.value    || '').toLowerCase();
  const typeQ  = (document.getElementById('rpt-type')?.value   || '');
  const statusQ= (document.getElementById('rpt-status')?.value || '');
  const filtered = rptAllData.filter(r => {
    if (empQ    && !r.employee_name.toLowerCase().includes(empQ) && !(r.emp_code||'').toLowerCase().includes(empQ)) return false;
    if (typeQ   && String(r.leave_type_id) !== typeQ) return false;
    if (statusQ && r.status !== statusQ) return false;
    return true;
  });
  const tbody = document.getElementById('report-tbody');
  const sumEl = document.getElementById('rpt-summary');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">ไม่มีข้อมูล</td></tr>';
    document.getElementById('rpt-pagination').innerHTML = '';
    sumEl.style.display = 'none';
    return;
  }
  const totalDays = filtered.reduce((s, r) => s + (r.days || 0), 0);
  sumEl.style.display = '';
  sumEl.innerHTML = `พบ <b>${filtered.length}</b> รายการ รวม <b>${totalDays}</b> วัน`;
  const totalPages = Math.ceil(filtered.length / RPT_PAGE_SIZE);
  if (rptPage > totalPages) rptPage = totalPages;
  const pageData = filtered.slice((rptPage - 1) * RPT_PAGE_SIZE, rptPage * RPT_PAGE_SIZE);
  tbody.innerHTML = pageData.map(r => `<tr>
    <td style="font-size:13px">${r.emp_code||''}</td>
    <td><b>${r.employee_name||''}</b></td>
    <td style="font-size:12px">${r.department||''}</td>
    <td style="font-size:12px">${r.division||''}</td>
    <td style="font-size:13px">${r.leave_type_name||''}</td>
    <td style="font-size:12px;white-space:nowrap">${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td>
    <td style="text-align:center">${fmtDuration(r.days, r.hours)}</td>
    <td style="font-size:12px;color:#4a5568;max-width:200px;word-break:break-word">${r.reason||'-'}</td>
    <td>${statusBadge(r.status)}</td>
    <td style="text-align:center"><button class="btn btn-sm" style="padding:3px 8px;font-size:11px;background:#f7fafc;border:1px solid #cbd5e0;color:#4a5568" onclick="exportEmpReport(${r.id},'${(r.employee_name||'').replace(/'/g,'\\x27')}')">📄</button></td>
  </tr>`).join('');
  // pagination
  const pg = document.getElementById('rpt-pagination');
  if (totalPages <= 1) { pg.innerHTML = ''; return; }
  const btnS = (active) => `style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:${active?'#3182ce':'#fff'};color:${active?'#fff':'#2d3748'};cursor:${active?'default':'pointer'};font-size:13px"`;
  let html = `<button onclick="rptGoPage(${rptPage-1})" ${rptPage===1?'disabled':''} style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:#fff;cursor:pointer;font-size:13px">‹</button>`;
  for (let p = 1; p <= totalPages; p++) html += `<button onclick="rptGoPage(${p})" ${btnS(p===rptPage)}>${p}</button>`;
  html += `<button onclick="rptGoPage(${rptPage+1})" ${rptPage===totalPages?'disabled':''} style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:#fff;cursor:pointer;font-size:13px">›</button>`;
  html += `<span style="font-size:12px;color:#718096">แสดง ${(rptPage-1)*RPT_PAGE_SIZE+1}–${Math.min(rptPage*RPT_PAGE_SIZE,filtered.length)} จาก ${filtered.length}</span>`;
  pg.innerHTML = html;
}

function rptGoPage(p) { rptPage = p; renderReport(); }

function exportReport(fmt) {
  const empQ    = (document.getElementById('rpt-emp')?.value    || '').toLowerCase();
  const deptQ   = (document.getElementById('rpt-dept')?.value   || '').toLowerCase();
  const typeQ   = (document.getElementById('rpt-type')?.value   || '');
  const statusQ = (document.getElementById('rpt-status')?.value || '');
  const filtered = rptAllData.filter(r => {
    if (empQ    && !r.employee_name.toLowerCase().includes(empQ) && !(r.emp_code||'').toLowerCase().includes(empQ)) return false;
    if (deptQ   && !(r.department||'').toLowerCase().includes(deptQ)) return false;
    if (typeQ   && String(r.leave_type_id) !== typeQ) return false;
    if (statusQ && r.status !== statusQ) return false;
    return true;
  });
  if (!filtered.length) return swalError('ไม่มีข้อมูลสำหรับ export');
  if (fmt === 'csv') {
    const header = ['รหัสพนักงาน','ชื่อ-นามสกุล','แผนก','ฝ่าย','ประเภทการลา','วันที่เริ่ม','วันที่สิ้นสุด','จำนวนวัน','เหตุผลการลา','สถานะ'];
    const rows = filtered.map(r => [r.emp_code, r.employee_name, r.department, r.division, r.leave_type_name, fmtDate(r.start_date), fmtDate(r.end_date), r.days, r.reason||'', r.status]);
    const csv = [header, ...rows].map(row => row.map(v => `"${(v||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿'+csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `leave_report_${document.getElementById('rpt-year')?.value||'all'}.csv`; a.click();
  } else if (fmt === 'print') {
    const STATUS_TH = { pending:'รอตรวจสอบ', approved_l1:'รอระดับอนุมัติ', approved:'อนุมัติแล้ว', rejected:'ปฏิเสธ', cancelled:'ยกเลิก' };
    const rows = filtered.map(r => `<tr><td>${r.emp_code}</td><td>${r.employee_name}</td><td>${r.department}</td><td>${r.division}</td><td>${r.leave_type_name}</td><td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td><td style="text-align:center">${r.days}</td><td>${STATUS_TH[r.status]||r.status}</td></tr>`).join('');
    const win = window.open('','_blank');
    win.document.write(`<html><head><title>รายงานการลา</title><style>@page{size:A4 landscape}body{font-family:sans-serif;font-size:12px;position:relative;margin-bottom:40px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px 8px}th{background:#e2e8f0}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:120px;color:rgba(0,0,0,0.08);font-weight:700;white-space:nowrap;pointer-events:none;z-index:9999;font-family:sans-serif}.print-footer{position:fixed;bottom:0;left:0;right:0;padding:6px 16px;font-size:11px;color:#555;border-top:1px solid #ddd;background:#fff;display:flex;justify-content:space-between}@media print{@page{size:A4 landscape}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:120px;color:rgba(0,0,0,0.08);font-weight:700;white-space:nowrap}.print-footer{position:fixed;bottom:0;left:0;right:0;padding:6px 16px;font-size:11px;color:#555;border-top:1px solid #ddd;display:flex;justify-content:space-between}}</style></head><body><div class="watermark">บริษัท ดูอิท จำกัด</div><div class="print-footer"><span>พิมพ์โดย: ${user?.name||''}</span><span id="pg-footer"></span></div><h2>รายงานการลา ปี ${document.getElementById('rpt-year')?.value||''}</h2><table><thead><tr><th>รหัส</th><th>ชื่อ</th><th>แผนก</th><th>ฝ่าย</th><th>ประเภท</th><th>ช่วงวันที่</th><th>วัน</th><th>สถานะ</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
    win.document.close(); win.print();
  }
}

function exportEmpReport(leaveId, empName) {
  const rows = rptAllData.filter(r => r.employee_name === empName);
  if (!rows.length) return;
  const STATUS_TH = { pending:'รอตรวจสอบ', approved_l1:'รอระดับอนุมัติ', approved:'อนุมัติแล้ว', rejected:'ปฏิเสธ', cancelled:'ยกเลิก' };
  const fmtDur = (days, hours) => {
    const d=Number(days)||0, h=Number(hours)||0;
    const wh=Math.floor(h), wm=Math.round((h-wh)*60);
    const p=[];
    if(d>0) p.push(`${d} วัน`);
    if(wh>0) p.push(`${wh} ชม.`);
    if(wm>0) p.push(`${wm} นาที`);
    return p.join(' ')||'0';
  };
  const trs = rows.map(r => `<tr><td>${r.leave_type_name}</td><td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td><td style="text-align:center;font-weight:600">${fmtDur(r.days,r.hours)}</td><td style="color:#555">${r.reason||'-'}</td><td>${STATUS_TH[r.status]||r.status}</td></tr>`).join('');
  const _sumDays = rows.reduce((s,r)=>s+Math.floor(Number(r.days)||0),0);
  const _sumRemH = rows.reduce((s,r)=>s+(Number(r.hours)||0),0);
  const _extraD  = Math.floor(_sumRemH/8);
  const _finalRH = _sumRemH - _extraD*8;
  const _tWH     = Math.floor(_finalRH);
  const _tM      = Math.round((_finalRH-_tWH)*60);
  const _tD      = _sumDays + _extraD;
  const totalStr = [_tD>0?`${_tD} วัน`:'',_tWH>0?`${_tWH} ชม.`:'',_tM>0?`${_tM} นาที`:''].filter(Boolean).join(' ')||'0';
  const win = window.open('','_blank');
  win.document.write(`<html><head><title>รายงานการลา</title><style>@page{size:A4 landscape}body{font-family:sans-serif;font-size:13px;padding:20px;padding-bottom:50px;position:relative}h2{margin-bottom:4px}p{margin:2px 0;color:#555}table{border-collapse:collapse;width:100%;margin-top:14px}th,td{border:1px solid #ccc;padding:6px 10px}th{background:#e2e8f0}.total{font-weight:600;color:#2d3748}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:120px;color:rgba(0,0,0,0.08);font-weight:700;white-space:nowrap;pointer-events:none;z-index:9999;font-family:sans-serif}.print-footer{position:fixed;bottom:0;left:0;right:0;padding:6px 16px;font-size:11px;color:#555;border-top:1px solid #ddd;background:#fff;display:flex;justify-content:space-between}@media print{@page{size:A4 landscape}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:120px;color:rgba(0,0,0,0.08);font-weight:700;white-space:nowrap}.print-footer{position:fixed;bottom:0;left:0;right:0;padding:6px 16px;font-size:11px;color:#555;border-top:1px solid #ddd;display:flex;justify-content:space-between}}</style></head><body><div class="watermark">บริษัท ดูอิท จำกัด</div><div class="print-footer"><span>พิมพ์โดย: ${user?.name||''}</span></div>
  <h2>รายงานการลา</h2>
  <p>พนักงาน: <b>${empName}</b> (${rows[0].emp_code})</p>
  <p>แผนก: ${rows[0].department} | ฝ่าย: ${rows[0].division}</p>
  <table><thead><tr><th>ประเภทการลา</th><th>ช่วงวันที่</th><th style="text-align:center">จำนวน</th><th>เหตุผลการลา</th><th>สถานะ</th></tr></thead><tbody>${trs}<tr><td colspan="2" style="text-align:right;font-weight:600">รวมทั้งหมด</td><td style="text-align:center;font-weight:700">${totalStr}</td><td colspan="2"></td></tr></tbody></table>
  </body></html>`);
  win.document.close(); win.print();
}

// ====== HELPERS ======
function statusBadge(status) {
  const map = {
    pending:    ['badge-pending',  'รอตรวจสอบ'],
    approved_l1:['badge-l1',      'รอระดับอนุมัติ'],
    approved:   ['badge-approved', 'อนุมัติแล้ว'],
    rejected:   ['badge-rejected', 'ปฏิเสธ'],
    cancelled:  ['badge-cancelled','ยกเลิก'],
  };
  const [cls, label] = map[status] || ['', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function setAlert(id, msg, type) {
  // legacy inline alerts (login/register forms ยังใช้)
  const el = document.getElementById(id);
  if (el) el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
}

function swalSuccess(msg, onConfirm) {
  return Swal.fire({ icon: 'success', title: 'สำเร็จ', text: msg, confirmButtonColor: '#1e3a5f', confirmButtonText: 'ตกลง' }).then(() => { if (onConfirm) onConfirm(); });
}

function swalError(msg) {
  return Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: msg, confirmButtonColor: '#e53e3e', confirmButtonText: 'ตกลง' });
}

function swalConfirm(msg, onConfirm) {
  Swal.fire({ icon: 'warning', title: 'ยืนยัน', text: msg, showCancelButton: true, confirmButtonColor: '#e53e3e', cancelButtonColor: '#718096', confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก' }).then(result => { if (result.isConfirmed) onConfirm(); });
}
function clearAlert(id) { document.getElementById(id).innerHTML = ''; }

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(API + path, opts);
    const json = await res.json();
    if (!res.ok) return { error: json.message || 'เกิดข้อผิดพลาด' };
    return json;
  } catch {
    return { error: 'ไม่สามารถเชื่อมต่อ server ได้' };
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-page').style.display !== 'none') doLogin();
});

// ====== DASHBOARD (HR) ======
const CHART_COLORS = ['#4299e1','#48bb78','#ed8936','#9f7aea','#f56565','#38b2ac','#667eea','#e53e3e'];
const MONTH_LABELS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
let charts = {};

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

async function loadDashboard() {
  const year = document.getElementById('dash-year')?.value || new Date().getFullYear();
  const d = await api('GET', `/hr/dashboard?year=${year}`);
  if (!d || d.error) return;

  // Summary cards
  const s = d.summary;
  document.getElementById('dash-stat-grid').innerHTML = `
    <div class="stat-card"><div class="val">${s.totalEmployees}</div><div class="lbl">พนักงานทั้งหมด</div></div>
    <div class="stat-card yellow"><div class="val">${s.pending}</div><div class="lbl">รออนุมัติ</div></div>
    <div class="stat-card green"><div class="val">${s.approvedCount}</div><div class="lbl">อนุมัติแล้ว</div></div>
    <div class="stat-card purple"><div class="val">${s.approvedDays}</div><div class="lbl">รวมวันลา (วัน)</div></div>
    <div class="stat-card red"><div class="val">${s.rejected}</div><div class="lbl">ปฏิเสธ</div></div>
  `;

  // Chart: Monthly
  destroyChart('monthly');
  charts['monthly'] = new Chart(document.getElementById('chart-monthly'), {
    type: 'bar',
    data: { labels: MONTH_LABELS, datasets: [
      { label: 'จำนวนวัน', data: d.monthly.map(m=>m.days), backgroundColor: '#4299e1', borderRadius: 6 },
      { label: 'จำนวนครั้ง', data: d.monthly.map(m=>m.count), backgroundColor: '#48bb78', borderRadius: 6, yAxisID: 'y2' },
    ]},
    options: { responsive: true, maintainAspectRatio: false, scales: {
      y: { beginAtZero: true, title: { display: true, text: 'วัน' } },
      y2: { position: 'right', beginAtZero: true, title: { display: true, text: 'ครั้ง' }, grid: { drawOnChartArea: false } }
    }}
  });

  // Chart: Type (Doughnut)
  destroyChart('type');
  charts['type'] = new Chart(document.getElementById('chart-type'), {
    type: 'doughnut',
    data: { labels: d.byType.map(t=>t.name), datasets: [{ data: d.byType.map(t=>t.days), backgroundColor: CHART_COLORS }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });

  // Chart: Dept (Horizontal Bar)
  const depts = [...new Set(d.byDept.map(r=>r.department))];
  const types = [...new Set(d.byDept.map(r=>r.leave_type))];
  destroyChart('dept');
  charts['dept'] = new Chart(document.getElementById('chart-dept'), {
    type: 'bar',
    data: { labels: depts, datasets: types.map((t,i) => ({
      label: t, data: depts.map(dep => { const row = d.byDept.find(r=>r.department===dep&&r.leave_type===t); return row?row.days:0; }),
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length], borderRadius: 4
    }))},
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', scales: { x: { stacked: true, beginAtZero: true }, y: { stacked: true } }, plugins: { legend: { position: 'bottom' } } }
  });

  // Chart: Yearly (Line)
  destroyChart('yearly');
  charts['yearly'] = new Chart(document.getElementById('chart-yearly'), {
    type: 'line',
    data: { labels: d.byYear.map(r=>r.yr), datasets: [
      { label: 'วันลา', data: d.byYear.map(r=>r.days), borderColor:'#4299e1', backgroundColor:'rgba(66,153,225,.15)', fill: true, tension: .3 },
      { label: 'ครั้ง', data: d.byYear.map(r=>r.count), borderColor:'#48bb78', backgroundColor:'rgba(72,187,120,.15)', fill: true, tension: .3, yAxisID: 'y2' }
    ]},
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true }, y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } } } }
  });

  // Chart: Balance (Bar Stacked)
  destroyChart('balance');
  charts['balance'] = new Chart(document.getElementById('chart-balance'), {
    type: 'bar',
    data: { labels: d.balance.map(b=>b.name), datasets: [
      { label: 'ใช้ไปแล้ว', data: d.balance.map(b=>b.used), backgroundColor: '#fc8181', borderRadius: 4 },
      { label: 'คงเหลือ',   data: d.balance.map(b=>b.remaining), backgroundColor: '#68d391', borderRadius: 4 },
    ]},
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }, plugins: { legend: { position: 'bottom' } } }
  });

  // Dept detail table
  const tbody = document.getElementById('dash-dept-tbody');
  tbody.innerHTML = d.byDept.length ? d.byDept.map(r=>`<tr><td>${r.department}</td><td style="font-size:12px">${r.leave_type}</td><td>${r.count}</td><td>${r.days}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">ยังไม่มีข้อมูล</td></tr>';

  // Chart: Trend (Stacked Bar by leave type per month)
  destroyChart('trend');
  const trendTypes = [...new Set((d.byMonthType||[]).map(r=>r.leave_type))];
  charts['trend'] = new Chart(document.getElementById('chart-trend'), {
    type: 'bar',
    data: {
      labels: MONTH_LABELS,
      datasets: trendTypes.map((t, i) => ({
        label: t,
        data: Array.from({length:12}, (_, mi) => {
          const m = String(mi+1).padStart(2,'0');
          const found = (d.byMonthType||[]).find(r => r.month === m && r.leave_type === t);
          return found ? found.days : 0;
        }),
        backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
        borderRadius: 3,
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: 'วัน' } } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

// ====== LEAVE MANAGEMENT (HR) ======
let currentEditLeaveId = null;
let lmPage = 1;

async function loadLeaveRecords(page) {
  if (page) lmPage = page;
  const params = new URLSearchParams();
  const search = document.getElementById('lm-search')?.value; if (search) params.set('search', search);
  const status = document.getElementById('lm-status')?.value; if (status) params.set('status', status);
  const dept   = document.getElementById('lm-dept')?.value;   if (dept)   params.set('department', dept);
  const year   = document.getElementById('lm-year')?.value;   if (year)   params.set('year', year);
  const month  = document.getElementById('lm-month')?.value;  if (month)  params.set('month', month);
  const type   = document.getElementById('lm-type')?.value;   if (type)   params.set('leave_type_id', type);
  const limit  = document.getElementById('lm-page-size')?.value || 20;
  params.set('page', lmPage);
  params.set('limit', limit);

  const data = await api('GET', `/hr/leave-records?${params}`);
  const tbody = document.getElementById('lm-tbody');
  const countEl = document.getElementById('lm-count');
  if (!data || !data.rows) { tbody.innerHTML = '<tr><td colspan="10" class="empty">เกิดข้อผิดพลาด</td></tr>'; return; }
  const { rows: dataRows, total, page: curPage } = data;
  const totalPages = Math.max(1, Math.ceil(total / Number(limit)));
  countEl.textContent = `พบ ${total} รายการ — หน้า ${curPage}/${totalPages}`;

  // populate type dropdown ครั้งแรก
  const typeSel = document.getElementById('lm-type');
  if (typeSel && typeSel.options.length <= 1) {
    const types = await api('GET', '/leave/types');
    if (Array.isArray(types)) types.forEach(t => { const o = document.createElement('option'); o.value=t.id; o.textContent=t.name; typeSel.appendChild(o); });
  }
  // populate el-type modal
  const elType = document.getElementById('el-type');
  if (elType && elType.options.length === 0) {
    const types = await api('GET', '/leave/types');
    if (Array.isArray(types)) types.forEach(t => { const o = document.createElement('option'); o.value=t.id; o.textContent=t.name; elType.appendChild(o); });
  }

  const lmApprovalCell = (approvals, level) => {
    const a = (approvals||[]).find(x => x.level === level);
    if (!a || !a.approver_name) return '<span style="color:#a0aec0;font-size:12px">-</span>';
    const cls = a.status==='approved'?'done':a.status==='rejected'?'fail':'active';
    const badgeColor = cls==='done'?'#c6f6d5;color:#22543d':cls==='fail'?'#fed7d7;color:#742a2a':'#bee3f8;color:#2a4365';
    const badgeLabel = {done:'อนุมัติ',fail:'ปฏิเสธ',active:'รอ'}[cls];
    return `<div style="font-size:12px;font-weight:600;color:#2d3748">${a.approver_name}</div><span style="font-size:11px;padding:1px 7px;border-radius:12px;background:${badgeColor}">${badgeLabel}</span>`;
  };
  tbody.innerHTML = dataRows.length ? dataRows.map(r => {
    return `<tr>
      <td style="font-family:monospace;font-size:12px">${r.request_no}</td>
      <td>${r.employee_name}<br><span style="font-size:11px;color:#718096">${r.emp_code}</span></td>
      <td style="font-size:12px">${r.department}</td>
      <td style="font-size:12px">${r.leave_type_name}</td>
      <td style="font-size:12px">${isValidDateStr(r.start_date) ? fmtDate(r.start_date) + (r.end_date!==r.start_date?'<br>'+fmtDate(r.end_date):'') : '<span style="color:#c53030;font-weight:700;font-size:11px">⚠️ วันที่ผิดพลาด<br>กรุณากดแก้ไข</span>'}</td>
      <td style="text-align:center">${fmtDuration(r.days, r.hours)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${lmApprovalCell(r.approvals,1)}</td>
      <td>${lmApprovalCell(r.approvals,2)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" style="background:#ebf4ff;color:#2b6cb0;margin-right:4px" onclick='openEditLeave(${JSON.stringify(JSON.stringify(r))})'>แก้ไข</button>
        <button class="btn btn-danger btn-sm" onclick="deleteLeaveRecord(${r.id},'${r.request_no}')">ลบ</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">ไม่พบข้อมูล</td></tr>';

  // Pagination
  const pgEl = document.getElementById('lm-pagination');
  if (pgEl) {
    if (totalPages <= 1) { pgEl.innerHTML = ''; return; }
    const maxBtn = 7;
    let pages = [];
    if (totalPages <= maxBtn) {
      pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    } else {
      pages = [1];
      if (lmPage > 3) pages.push('...');
      for (let i = Math.max(2, lmPage - 1); i <= Math.min(totalPages - 1, lmPage + 1); i++) pages.push(i);
      if (lmPage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    pgEl.innerHTML = `
      <button onclick="loadLeaveRecords(${lmPage - 1})" ${lmPage === 1 ? 'disabled' : ''}
        style="padding:7px 14px;border-radius:8px;border:1.5px solid #e2e8f0;background:#fff;color:#4a5568;cursor:pointer;font-family:inherit;font-size:13px;${lmPage===1?'opacity:.4;cursor:default':''}">‹ ก่อนหน้า</button>
      ${pages.map(p => p === '...'
        ? `<span style="padding:7px 6px;color:#a0aec0">…</span>`
        : `<button onclick="loadLeaveRecords(${p})"
            style="padding:7px 13px;border-radius:8px;border:1.5px solid ${p===lmPage?'#1565c0':'#e2e8f0'};
                   background:${p===lmPage?'#1565c0':'#fff'};color:${p===lmPage?'#fff':'#4a5568'};
                   font-weight:${p===lmPage?800:500};cursor:pointer;font-size:13px;font-family:inherit">${p}</button>`
      ).join('')}
      <button onclick="loadLeaveRecords(${lmPage + 1})" ${lmPage === totalPages ? 'disabled' : ''}
        style="padding:7px 14px;border-radius:8px;border:1.5px solid #e2e8f0;background:#fff;color:#4a5568;cursor:pointer;font-family:inherit;font-size:13px;${lmPage===totalPages?'opacity:.4;cursor:default':''}">ถัดไป ›</button>
    `;
  }
}

function openEditLeave(rJson) {
  const r = JSON.parse(rJson);
  currentEditLeaveId = r.id;
  document.getElementById('edit-leave-alert').innerHTML = '';
  document.getElementById('el-type').value   = r.leave_type_id;
  document.getElementById('el-status').value = r.status;
  document.getElementById('el-reason').value = r.reason;

  // init time selects
  elInitTimeSelects();

  // init flatpickr
  const fpLocale = { ...flatpickr.l10ns.th, firstDayOfWeek: 0, weekdays: { shorthand: ['อา','จ','อ','พ','พฤ','ศ','ส'], longhand: ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'] } };
  const fpOpts   = { enableTime: false, dateFormat: 'd-m-Y', allowInput: false, locale: fpLocale };
  if (fpElStart) fpElStart.destroy();
  if (fpElEnd)   fpElEnd.destroy();
  fpElStart = flatpickr('#el-start-date', { ...fpOpts });
  fpElEnd   = flatpickr('#el-end-date',   { ...fpOpts });

  // set date values
  const isValidDate = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const startVal = isValidDate(r.start_date) ? r.start_date : '';
  const endVal   = isValidDate(r.end_date)   ? r.end_date   : '';

  if (startVal) {
    const [y,mo,d2] = startVal.split('-');
    fpElStart.setDate(`${d2}-${mo}-${y}`, false, 'd-m-Y');
  } else fpElStart.clear();

  if (endVal) {
    const [y,mo,d2] = endVal.split('-');
    fpElEnd.setDate(`${d2}-${mo}-${y}`, false, 'd-m-Y');
  } else fpElEnd.clear();

  // set time from start_datetime / end_datetime if available, else default
  const startTime = r.start_datetime ? r.start_datetime.slice(11,16) : '08:00';
  const endTime   = r.end_datetime   ? r.end_datetime.slice(11,16)   : '17:00';
  elSetTimeSelects('el-start', startTime);
  elSetTimeSelects('el-end',   endTime);

  if (!startVal || !endVal) {
    document.getElementById('edit-leave-alert').innerHTML =
      '<div class="alert alert-error" style="font-size:13px">⚠️ วันที่มีข้อผิดพลาด กรุณาเลือกวันที่เริ่มลาและสิ้นสุดใหม่</div>';
  }

  const lvl1 = r.approvals ? r.approvals.find(a => a.level === 1) : null;
  const lvl2 = r.approvals ? r.approvals.find(a => a.level === 2) : null;
  loadApproverSelect('el-checker',  lvl1 ? lvl1.approver_id : null, 1);
  loadApproverSelect('el-approver', lvl2 ? lvl2.approver_id : null, 2);
  document.getElementById('edit-leave-modal').classList.add('open');
}
function closeEditLeaveModal() { document.getElementById('edit-leave-modal').classList.remove('open'); }

async function saveLeaveRecord() {
  const startISO = elGetISO('start');
  const endISO   = elGetISO('end');
  const reason   = document.getElementById('el-reason').value.trim();
  const checker  = document.getElementById('el-checker').value;
  const approver = document.getElementById('el-approver').value;
  if (!startISO || !endISO) return setAlert('edit-leave-alert', 'กรุณาเลือกวันที่เริ่มลาและสิ้นสุด', 'error');
  if (!reason)   return setAlert('edit-leave-alert', 'กรุณาระบุเหตุผลการลา', 'error');
  if (!checker)  return setAlert('edit-leave-alert', 'กรุณาเลือกผู้ตรวจสอบ (ระดับ 1)', 'error');
  if (!approver) return setAlert('edit-leave-alert', 'กรุณาเลือกผู้อนุมัติ (ระดับ 2)', 'error');

  // คำนวณ days/hours จากเวลาจริง (เหมือน alCalcDuration)
  const s = new Date(startISO), e = new Date(endISO);
  let calcDays = 0, calcHours = 0;
  if (e > s) {
    const startDate = startISO.slice(0,10), endDate = endISO.slice(0,10);
    if (startDate === endDate) {
      const sMin = s.getHours()*60+s.getMinutes(), eMin = e.getHours()*60+e.getMinutes();
      let diff = Math.max(0, eMin - sMin);
      const lS=12*60, lE=13*60;
      if (sMin < lE && eMin > lS) diff -= Math.max(0, Math.min(eMin,lE)-Math.max(sMin,lS));
      const workH = Math.max(0, diff/60);
      calcDays  = Math.floor(workH / 8);
      calcHours = parseFloat((workH - calcDays*8).toFixed(4));
    } else {
      const res = calcLeaveResultFE(startDate, endDate, startISO, endISO);
      calcDays  = Math.floor(res.hours / 8);
      calcHours = parseFloat((res.hours - calcDays*8).toFixed(4));
    }
  }

  const checkerId  = document.getElementById('el-checker').value;
  const approverId = document.getElementById('el-approver').value;
  const r = await api('PUT', `/hr/leave-records/${currentEditLeaveId}`, {
    leave_type_id:  parseInt(document.getElementById('el-type').value),
    status:         document.getElementById('el-status').value,
    start_date:     startISO.slice(0, 10),
    end_date:       endISO.slice(0, 10),
    start_datetime: startISO,
    end_datetime:   endISO,
    days:           calcDays,
    hours:          calcHours,
    reason:         document.getElementById('el-reason').value,
    checker_id:     checkerId  ? parseInt(checkerId)  : undefined,
    approver_id:    approverId ? parseInt(approverId) : undefined,
  });
  if (r.error) return setAlert('edit-leave-alert', r.error, 'error');
  setAlert('edit-leave-alert', r.message, 'success');
  setTimeout(() => { closeEditLeaveModal(); loadLeaveRecords(); }, 1000);
}

function deleteLeaveRecord(id, no) {
  // แสดง modal ยืนยันการลบพร้อมใส่ email+password
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:28px 26px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.25)">
      <div style="text-align:center;margin-bottom:18px">
        <div style="font-size:44px;margin-bottom:8px">🔐</div>
        <div style="font-size:17px;font-weight:800;color:#1e293b">ยืนยันการลบใบลา</div>
        <div style="font-size:13px;color:#e53e3e;font-weight:600;margin-top:4px;background:#fff5f5;padding:6px 12px;border-radius:8px;border:1px solid #fed7d7">
          ${no}
        </div>
        <div style="font-size:12px;color:#718096;margin-top:8px">กรุณาระบุ Email และ Password ของเจ้าหน้าที่<br><b style="color:#c53030">เฉพาะแผนกบุคคลหรือ HR Admin เท่านั้น</b></div>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:13px;font-weight:700;color:#374151;display:block;margin-bottom:4px">📧 Email ผู้ดำเนินการ</label>
        <input id="del-confirm-email" type="email" placeholder="กรอก Email ของท่าน"
          style="width:100%;padding:11px 14px;border:1.5px solid #d1d5db;border-radius:10px;font-size:15px;box-sizing:border-box;font-family:inherit">
      </div>
      <div style="margin-bottom:20px">
        <label style="font-size:13px;font-weight:700;color:#374151;display:block;margin-bottom:4px">🔑 Password</label>
        <div style="position:relative">
          <input id="del-confirm-pw" type="password" placeholder="กรอก Password ของท่าน"
            style="width:100%;padding:11px 44px 11px 14px;border:1.5px solid #d1d5db;border-radius:10px;font-size:15px;box-sizing:border-box;font-family:inherit">
          <button onclick="const i=document.getElementById('del-confirm-pw');i.type=i.type==='password'?'text':'password'"
            style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:18px;color:#718096">👁</button>
        </div>
      </div>
      <div id="del-confirm-err" style="display:none;color:#e53e3e;font-size:13px;font-weight:600;margin-bottom:12px;text-align:center;background:#fff5f5;padding:8px;border-radius:8px"></div>
      <div style="display:flex;gap:10px">
        <button id="del-cancel-btn" style="flex:1;padding:12px;border:1.5px solid #d1d5db;border-radius:10px;background:#f8fafc;color:#4a5568;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">ยกเลิก</button>
        <button id="del-confirm-btn" style="flex:1;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,#c53030,#e53e3e);color:#fff;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:0 4px 14px rgba(229,62,62,.35)">🗑️ ยืนยันลบ</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('del-confirm-email').focus();

  document.getElementById('del-cancel-btn').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  document.getElementById('del-confirm-btn').onclick = async () => {
    const email = (document.getElementById('del-confirm-email').value || '').trim();
    const pw    = (document.getElementById('del-confirm-pw').value || '').trim();
    const errEl = document.getElementById('del-confirm-err');
    if (!email || !pw) { errEl.textContent='กรุณากรอก Email และ Password ให้ครบ'; errEl.style.display='block'; return; }
    const btn = document.getElementById('del-confirm-btn');
    btn.disabled = true; btn.textContent = 'กำลังตรวจสอบ...';
    const r = await fetch(`/api/hr/leave-records/${id}`, {
      method:'DELETE',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
      body: JSON.stringify({ confirm_email: email, confirm_password: pw })
    }).then(res => res.json()).catch(e => ({ error: e.message }));
    if (r.error || r.message?.startsWith('ไม่') || r.message?.startsWith('รหัสผ่าน') || r.message?.startsWith('กรุณา')) {
      errEl.textContent = r.message || r.error || 'เกิดข้อผิดพลาด';
      errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = '🗑️ ยืนยันลบ';
      return;
    }
    overlay.remove();
    swalSuccess('ลบคำขอลาสำเร็จ', () => loadLeaveRecords());
  };
  // กด Enter ใน password field
  document.getElementById('del-confirm-pw').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('del-confirm-btn').click();
  });
}

// ====== DELETE LOGS ======
let deleteLogPage = 1;

async function loadDeleteLogs(page) {
  if (page) deleteLogPage = page;
  const search = (document.getElementById('dellog-search')?.value || '').trim();
  const limit  = Number(document.getElementById('dellog-limit')?.value || 20);
  const tbody  = document.getElementById('dellog-tbody');
  const countEl = document.getElementById('dellog-count');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="9" class="empty">กำลังโหลด...</td></tr>`;
  const qs = new URLSearchParams({ page: deleteLogPage, limit, search }).toString();
  const data = await api('GET', `/hr/leave-delete-logs?${qs}`);
  if (data.error) { tbody.innerHTML = `<tr><td colspan="9" class="empty">เกิดข้อผิดพลาด: ${data.error}</td></tr>`; return; }

  const { rows = [], total = 0 } = data;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (countEl) countEl.textContent = `พบ ${total} รายการ (หน้า ${deleteLogPage}/${totalPages})`;

  const STATUS_TH = { pending:'รอตรวจสอบ', approved_l1:'รอระดับอนุมัติ', approved:'อนุมัติแล้ว', rejected:'ปฏิเสธ', cancelled:'ยกเลิก' };
  const STATUS_COLOR = { pending:'#f6ad55', approved_l1:'#63b3ed', approved:'#68d391', rejected:'#fc8181', cancelled:'#cbd5e0' };

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">ยังไม่มีประวัติการลบ</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(r => {
      const stColor = STATUS_COLOR[r.status_before] || '#cbd5e0';
      const stTh    = STATUS_TH[r.status_before] || r.status_before;
      const dtStr   = r.deleted_at ? r.deleted_at.replace('T',' ').substring(0,16) : '-';
      return `<tr style="transition:background .15s" onmouseover="this.style.background='#fff5f5'" onmouseout="this.style.background=''">
        <td style="font-size:12px;font-weight:700;color:#c53030">${r.request_no}</td>
        <td><div style="font-weight:700;font-size:13px">${r.employee_name}</div><div style="font-size:11px;color:#718096">${r.employee_id_code}</div></td>
        <td style="font-size:13px">${r.leave_type}</td>
        <td style="font-size:12px">${r.start_date}<br>${r.end_date}</td>
        <td style="text-align:center">${fmtDuration(r.days, r.hours)}</td>
        <td style="text-align:center"><span style="background:${stColor};color:#1a202c;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700">${stTh}</span></td>
        <td><div style="font-weight:700;font-size:13px;color:#c53030">${r.deleted_by_name}</div></td>
        <td style="font-size:12px;color:#718096">${r.deleted_by_email}</td>
        <td style="font-size:12px;color:#718096;white-space:nowrap">${dtStr}</td>
      </tr>`;
    }).join('');
  }

  // Pagination
  const pgEl = document.getElementById('dellog-pagination');
  if (pgEl) {
    let btns = '';
    for (let i = 1; i <= totalPages; i++) {
      const active = i === deleteLogPage;
      btns += `<button onclick="loadDeleteLogs(${i})"
        style="padding:6px 13px;border-radius:8px;border:1.5px solid ${active?'#e53e3e':'#e2e8f0'};
               background:${active?'#e53e3e':'#fff'};color:${active?'#fff':'#4a5568'};
               font-weight:${active?800:500};cursor:pointer;font-size:13px;font-family:inherit">${i}</button>`;
    }
    pgEl.innerHTML = btns;
  }
}

// ====== EDIT LEAVE RECORD (HR) ======
let fpElStart, fpElEnd;

function elInitTimeSelects() {
  ['el-start', 'el-end'].forEach(pfx => {
    const hSel = document.getElementById(pfx + '-hour');
    const mSel = document.getElementById(pfx + '-min');
    if (!hSel || hSel.options.length) return;
    for (let h = 0; h < 24; h++) { const v = String(h).padStart(2,'0'); hSel.appendChild(new Option(v, v)); }
    for (let m = 0; m < 60; m++) { const v = String(m).padStart(2,'0'); mSel.appendChild(new Option(v, v)); }
  });
}
function elSetTimeSelects(prefix, timeStr) {
  const [h, m] = (timeStr || '08:00').split(':');
  const hEl = document.getElementById(prefix + '-hour');
  const mEl = document.getElementById(prefix + '-min');
  if (hEl) hEl.value = String(h).padStart(2, '0');
  if (mEl) mEl.value = String(m).padStart(2, '0');
}
function elGetISO(side) {
  const fp = side === 'start' ? fpElStart : fpElEnd;
  if (!fp || !fp.selectedDates[0]) return null;
  const d = fp.selectedDates[0];
  const p = n => String(n).padStart(2,'0');
  const dateStr = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  const prefix = side === 'start' ? 'el-start' : 'el-end';
  const h = document.getElementById(prefix + '-hour')?.value || (side === 'start' ? '08' : '17');
  const m = document.getElementById(prefix + '-min')?.value  || '00';
  return `${dateStr}T${h}:${m}`;
}

// ====== ADD LEAVE RECORD (HR) ======
let fpAlStart, fpAlEnd;

async function loadApproverSelect(selectId, currentId, level) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const first = sel.options[0];
  sel.innerHTML = '';
  sel.appendChild(first);
  // โหลดจาก /approver-candidates ซึ่ง UNION ทั้ง role-based + dept_approvers ที่ HR Admin กำหนด
  const url = level ? `/hr/approver-candidates?level=${level}` : '/hr/approver-candidates';
  const data = await api('GET', url);
  if (Array.isArray(data)) {
    data.forEach(u => sel.appendChild(new Option(`${u.name} (${u.employee_id}) — ${u.department}`, u.id)));
  }
  if (currentId != null) sel.value = String(currentId);
}

// ====== AL modal — time range helpers (module-scope so alLookupEmp can call them) ======
function alWithEmpType(fn) {
  const origType = user?.employee_type, origProb = user?.probation_start_date;
  if (user) { user.employee_type = _alEmployee?.employee_type || 'monthly'; user.probation_start_date = _alEmployee?.probation_start_date || null; }
  const result = fn();
  if (user) { user.employee_type = origType; user.probation_start_date = origProb; }
  return result;
}
function alDateStr(d) { if (!d) return null; const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
function alGetISO(side) {
  const fp = side === 'start' ? fpAlStart : fpAlEnd;
  if (!fp || !fp.selectedDates[0]) return null;
  const d = fp.selectedDates[0];
  const p = n => String(n).padStart(2,'0');
  const dateStr = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  const prefix = side === 'start' ? 'al-start' : 'al-end';
  const hEl = document.getElementById(prefix + '-hour');
  const mEl = document.getElementById(prefix + '-min');
  const h = hEl?.value || (side === 'start' ? '08' : '17');
  const m = mEl?.value || '00';
  return `${dateStr}T${h}:${m}`;
}
function alSetTimeSelects(prefix, timeStr) {
  const [h, m] = (timeStr || '08:00').split(':');
  const hEl = document.getElementById(prefix + '-hour');
  const mEl = document.getElementById(prefix + '-min');
  if (hEl) hEl.value = String(h).padStart(2, '0');
  if (mEl) mEl.value = String(m).padStart(2, '0');
}
function alGetTimeStr(prefix) {
  const h = document.getElementById(prefix + '-hour')?.value || '08';
  const m = document.getElementById(prefix + '-min')?.value  || '00';
  return `${h}:${m}`;
}
function alInitTimeSelects() {
  ['al-start', 'al-end'].forEach(pfx => {
    const hSel = document.getElementById(pfx + '-hour');
    const mSel = document.getElementById(pfx + '-min');
    if (!hSel || hSel.options.length) return;
    for (let h = 0; h < 24; h++) { const v = String(h).padStart(2,'0'); hSel.appendChild(new Option(v, v)); }
    for (let m = 0; m < 60; m++) { const v = String(m).padStart(2,'0'); mSel.appendChild(new Option(v, v)); }
  });
  alSetTimeSelects('al-start', '08:00');
  alSetTimeSelects('al-end',   '17:00');
}
function alApplyTimeToInput(dateStr, prefix, side) {
  const range = dateStr ? alWithEmpType(() => getWorkTimeRange(dateStr)) : null;
  if (range && side) alSetTimeSelects(prefix, side === 'max' ? range.maxTime : range.minTime);
}
let _alTimeAlert = false;
function alEnforceTimeInput(dateStr, prefix) {
  if (_alTimeAlert) return;
  const range = dateStr ? alWithEmpType(() => getWorkTimeRange(dateStr)) : null;
  if (!range) return;
  const cur = alGetTimeStr(prefix);
  const [selH, selM] = cur.split(':').map(Number);
  const [maxH, maxM] = range.maxTime.split(':').map(Number);
  const [minH, minM] = range.minTime.split(':').map(Number);
  const overMax  = selH > maxH || (selH === maxH && selM > maxM);
  const underMin = selH < minH || (selH === minH && selM < minM);
  if (overMax || underMin) {
    _alTimeAlert = true;
    const clamp = overMax ? range.maxTime : range.minTime;
    alSetTimeSelects(prefix, clamp);
    const d = new Date(dateStr + 'T12:00:00');
    const dowLbl = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'][d.getDay()];
    Swal.fire({ icon:'warning', title:'เกินเวลาทำงาน',
      html: `วัน<b>${dowLbl}</b> เวลาทำงานคือ <b>${range.minTime} – ${range.maxTime} น.</b><br>ระบบปรับเวลาเป็น <b>${clamp} น.</b> ให้อัตโนมัติ`,
      confirmButtonColor:'#1e3a5f' }).then(() => { _alTimeAlert = false; alCalcDuration(); });
  }
}

function openAddLeaveModal() {
  const modal = document.getElementById('add-leave-modal');
  modal.style.display = 'flex';
  document.getElementById('add-leave-alert').innerHTML = '';
  _alEmployee = null;
  document.getElementById('al-empid').value = '';
  document.getElementById('al-emp-name').innerHTML = '';
  document.getElementById('al-days').value = '';
  document.getElementById('al-hours').value = '';
  document.getElementById('al-reason').value = '';
  document.getElementById('al-status').value = 'approved';
  document.getElementById('al-files').value = '';
  document.getElementById('al-files-info').textContent = '';
  // init flatpickr date-only + native time inputs
  const fpLocale = { ...flatpickr.l10ns.th, firstDayOfWeek: 0, weekdays: { shorthand: ['อา','จ','อ','พ','พฤ','ศ','ส'], longhand: ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'] } };
  const fpOpts = { enableTime: false, dateFormat: 'd-m-Y', allowInput: false, locale: fpLocale };
  if (fpAlStart) fpAlStart.destroy();
  if (fpAlEnd)   fpAlEnd.destroy();
  alInitTimeSelects();
  fpAlStart = flatpickr('#al-start-date', { ...fpOpts,
    onChange: (sel) => {
      const ds = alDateStr(sel[0]);
      alApplyTimeToInput(ds, 'al-start', 'min');
      alEnforceTimeInput(ds, 'al-start');
      alCalcDuration();
    }
  });
  fpAlEnd = flatpickr('#al-end-date', { ...fpOpts,
    onChange: (sel) => {
      const ds = alDateStr(sel[0]);
      alApplyTimeToInput(ds, 'al-end', 'max');
      alEnforceTimeInput(ds, 'al-end');
      alCalcDuration();
      const sv = alGetISO('start'), ev = alGetISO('end');
      if (sv && ev && new Date(ev) <= new Date(sv)) {
        Swal.fire({ icon:'error', title:'วันที่/เวลาไม่ถูกต้อง',
          html:'<b>วันที่สิ้นสุดการลา</b> ต้องอยู่หลัง<br><b>วันที่เริ่มลา</b> กรุณาเลือกใหม่',
          confirmButtonText:'ตกลง', confirmButtonColor:'#1e3a5f' });
      }
    }
  });
  document.getElementById('al-calc-info').textContent = '';
  document.getElementById('al-days').readOnly = false;
  document.getElementById('al-hours').readOnly = false;
  // populate type dropdown
  const sel = document.getElementById('al-type');
  if (sel.options.length === 0 && leaveTypesCache.length) {
    leaveTypesCache.forEach(t => {
      const o = new Option(`${t.code ? '['+t.code+'] ' : ''}${t.name}`, t.id);
      sel.appendChild(o);
    });
  } else if (sel.options.length === 0) {
    api('GET', '/hr/leave-types').then(data => {
      if (Array.isArray(data)) data.forEach(t => {
        const o = new Option(`${t.code ? '['+t.code+'] ' : ''}${t.name}`, t.id);
        sel.appendChild(o);
      });
    });
  }
  // populate checker/approver dropdowns
  loadApproverSelect('al-checker', null, 1);
  loadApproverSelect('al-approver', null, 2);
  // show file names on change
  document.getElementById('al-files').onchange = function() {
    const names = Array.from(this.files).map(f => f.name).join(', ');
    document.getElementById('al-files-info').textContent = names ? `เลือก: ${names}` : '';
  };
}

function closeAddLeaveModal() {
  document.getElementById('add-leave-modal').style.display = 'none';
}

function alCalcDuration() {
  const startISO = alGetISO('start');
  const endISO   = alGetISO('end');
  const infoEl = document.getElementById('al-calc-info');
  if (!startISO || !endISO) return;
  const s = new Date(startISO), e = new Date(endISO);
  if (e <= s) {
    infoEl.style.color = '#c53030';
    infoEl.textContent = '⚠️ วันที่สิ้นสุดต้องหลังวันที่เริ่มลา';
    return;
  }

  const origType = user?.employee_type, origProb = user?.probation_start_date;
  if (user) {
    user.employee_type        = _alEmployee?.employee_type        || 'monthly';
    user.probation_start_date = _alEmployee?.probation_start_date || null;
  }

  const startDate = startISO.slice(0, 10);
  const endDate   = endISO.slice(0, 10);

  let workHours;
  if (startDate === endDate) {
    // วันเดียว: คำนวนจากเวลาจริง (ไม่บังคับ minimum 0.5)
    const sMin = s.getHours() * 60 + s.getMinutes();
    const eMin = e.getHours() * 60 + e.getMinutes();
    let diffMins = Math.max(0, eMin - sMin);
    // หักพักเที่ยง 12:00-13:00 ถ้าช่วงเวลาผ่าน
    const lS = 12 * 60, lE = 13 * 60;
    if (sMin < lE && eMin > lS)
      diffMins -= Math.max(0, Math.min(eMin, lE) - Math.max(sMin, lS));
    workHours = Math.max(0, diffMins / 60);
  } else {
    // หลายวัน: ใช้ calcLeaveResultFE ตามปกติ
    const result = calcLeaveResultFE(startDate, endDate, startISO, endISO);
    workHours = result.hours;
  }

  if (user) { user.employee_type = origType; user.probation_start_date = origProb; }

  // แปลงเป็น วัน / ชม. / นาที (1 วัน = 8 ชม.)
  const DISPLAY_H = 8;
  const fullDays    = Math.floor(workHours / DISPLAY_H);
  const remHoursRaw = workHours - fullDays * DISPLAY_H;
  const remWholeH   = Math.floor(remHoursRaw);
  const remMins     = Math.round((remHoursRaw - remWholeH) * 60);

  document.getElementById('al-days').value  = fullDays;
  document.getElementById('al-hours').value = (remWholeH > 0 || remMins > 0)
    ? parseFloat(remHoursRaw.toFixed(4)) : '';

  // ข้อความแสดงผล
  const parts = [];
  if (fullDays > 0)  parts.push(`${fullDays} วัน`);
  if (remWholeH > 0) parts.push(`${remWholeH} ชม.`);
  if (remMins > 0)   parts.push(`${remMins} นาที`);
  const dispText = parts.length ? parts.join(' ') : '0 นาที';

  const empTypeLbl = EMP_TYPE_LABEL[_alEmployee?.employee_type || 'monthly'] || '';
  infoEl.style.color = '#4a9580';
  infoEl.innerHTML = `✓ <b>${dispText}</b> (${parseFloat(workHours.toFixed(2))} ชม.) — <span style="color:#2b6cb0">${empTypeLbl}</span>`;
}

let _alEmpTimer = null;
let _alEmployee = null; // { employee_type, probation_start_date }

const EMP_TYPE_LABEL = {
  monthly:      'รายเดือน (จ-พฤ 9ชม / ศ 8ชม / ส 4ชม เว้นเสาร์)',
  daily:        'รายวัน (จ-ส 8ชม | หักพักเที่ยง)',
  housekeeping: 'แม่บ้าน (ตรวจสอบตามวันทดลองงาน)',
};

async function alLookupEmp() {
  clearTimeout(_alEmpTimer);
  _alEmpTimer = setTimeout(async () => {
    const empid = document.getElementById('al-empid').value.trim();
    const nameEl = document.getElementById('al-emp-name');
    if (!empid) { nameEl.innerHTML = ''; _alEmployee = null; return; }
    const data = await api('GET', `/hr/employees?search=${encodeURIComponent(empid)}`);
    if (Array.isArray(data) && data.length) {
      const exact = data.find(u => u.employee_id === empid) || data[0];
      _alEmployee = { employee_type: exact.employee_type || 'monthly', probation_start_date: exact.probation_start_date || null };
      const typeLabel = EMP_TYPE_LABEL[_alEmployee.employee_type] || _alEmployee.employee_type;
      nameEl.innerHTML = `<span style="color:#276749">✓ ${exact.name} (${exact.department})</span><br><span style="font-size:11px;background:#ebf4ff;color:#2b6cb0;padding:2px 8px;border-radius:10px;margin-top:2px;display:inline-block">🏷 ${typeLabel}</span>`;
      // อัปเดต label ชั่วโมง
      const hpdEl = document.getElementById('al-hpd-label');
      if (hpdEl) hpdEl.textContent = `(${typeLabel})`;
      // re-apply time ranges ถ้ามีวันที่เลือกแล้ว
      if (fpAlStart?.selectedDates[0]) alApplyTimeRange(fpAlStart, alDateStr(fpAlStart.selectedDates[0]), null);
      if (fpAlEnd?.selectedDates[0])   alApplyTimeRange(fpAlEnd,   alDateStr(fpAlEnd.selectedDates[0]),   null);
      alCalcDuration(); // คำนวนใหม่เมื่อรู้ประเภทพนักงาน
    } else {
      _alEmployee = null;
      nameEl.innerHTML = '<span style="color:#c53030">✗ ไม่พบพนักงาน</span>';
    }
  }, 400);
}

async function submitAddLeave() {
  const empid  = document.getElementById('al-empid').value.trim();
  const typeId = document.getElementById('al-type').value;
  const days   = document.getElementById('al-days').value;
  const hours  = document.getElementById('al-hours').value;
  const reason = document.getElementById('al-reason').value.trim();
  const status = document.getElementById('al-status').value;
  const alertEl = document.getElementById('add-leave-alert');

  // อ่านวันที่+เวลาจาก alGetISO (date flatpickr + time select)
  const startISOfull = alGetISO('start');  // "YYYY-MM-DDThh:mm"
  const endISOfull   = alGetISO('end');
  const start   = startISOfull ? startISOfull.slice(0, 10) : '';
  const end     = endISOfull   ? endISOfull.slice(0, 10)   : '';
  const startDT = startISOfull || '';
  const endDT   = endISOfull   || '';

  const checkerId  = document.getElementById('al-checker').value;
  const approverId = document.getElementById('al-approver').value;
  if (!empid)    { alertEl.innerHTML = '<div class="alert alert-error">กรุณากรอกรหัสพนักงาน</div>'; return; }
  if (!_alEmployee) { alertEl.innerHTML = '<div class="alert alert-error">ไม่พบพนักงาน กรุณาตรวจสอบรหัสพนักงาน</div>'; return; }
  if (!typeId)   { alertEl.innerHTML = '<div class="alert alert-error">กรุณาเลือกประเภทการลา</div>'; return; }
  if (!start)    { alertEl.innerHTML = '<div class="alert alert-error">กรุณาเลือกวันที่เริ่มลา</div>'; return; }
  if (!end)      { alertEl.innerHTML = '<div class="alert alert-error">กรุณาเลือกวันที่สิ้นสุด</div>'; return; }
  if (!days)     { alertEl.innerHTML = '<div class="alert alert-error">กรุณากรอกจำนวนวัน (กดเลือกวันที่เพื่อคำนวณอัตโนมัติ)</div>'; return; }
  if (!checkerId)  { alertEl.innerHTML = '<div class="alert alert-error">กรุณาเลือกผู้ตรวจสอบ (ระดับ 1)</div>'; return; }
  if (!approverId) { alertEl.innerHTML = '<div class="alert alert-error">กรุณาเลือกผู้อนุมัติ (ระดับ 2)</div>'; return; }
  if (!reason)   { alertEl.innerHTML = '<div class="alert alert-error">กรุณาระบุเหตุผลการลา</div>'; return; }
  const files = document.getElementById('al-files').files;
  const fd = new FormData();
  fd.append('employee_id', empid);
  fd.append('leave_type_id', typeId);
  fd.append('start_date', start);
  fd.append('end_date', end);
  fd.append('start_datetime', startDT);
  fd.append('end_datetime', endDT);
  fd.append('days', days);
  fd.append('hours', hours || '0');
  fd.append('reason', reason || '-');
  fd.append('status', status);
  if (checkerId)  fd.append('checker_id',  checkerId);
  if (approverId) fd.append('approver_id', approverId);
  for (const f of files) fd.append('attachments', f);
  const resp = await fetch('/api/hr/leave-records', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: fd,
  });
  const r = await resp.json();
  if (!resp.ok) { alertEl.innerHTML = `<div class="alert alert-error">${r.error||r.message}</div>`; return; }
  closeAddLeaveModal();
  const attMsg = r.attachments ? ` (ไฟล์แนบ ${r.attachments} ไฟล์)` : '';
  swalSuccess(`บันทึกการลาสำเร็จ — ${r.request_no}${attMsg}`, () => loadLeaveRecords());
}

// ====== HR MANAGEMENT ======
const ROLE_LABEL = { employee:'พนักงาน', unit_head:'หัวหน้าหน่วยงาน', department_head:'หัวหน้าแผนก', division_manager:'ผู้จัดการ', hr_admin:'HR Admin' };
let currentEmpId = null;
let leaveTypesCache = [];

function hrTab(name) {
  ['dash','calendar','emp','import','perm','approver','leavetype','workschedule','summary','deptsummary'].forEach(t => {
    const sec = document.getElementById(`hrsec-${t}`);
    if (sec) sec.style.display = 'none';
    const btn = document.getElementById(`hrtab-${t}`);
    if (btn) { btn.style.background = '#f0f4f8'; btn.style.color = '#4a5568'; btn.style.boxShadow = 'none'; }
  });
  document.getElementById(`hrsec-${name}`).style.display = '';
  document.getElementById(`hrtab-${name}`).style.background = 'linear-gradient(135deg,#1e3a5f,#2b6cb0)';
  document.getElementById(`hrtab-${name}`).style.color = '#fff';
  document.getElementById(`hrtab-${name}`).style.boxShadow = '0 2px 6px rgba(30,58,95,.3)';
  if (name === 'dash')          loadHrStats();
  if (name === 'calendar')      loadHrCalendar();
  if (name === 'emp')           loadEmployees();
  if (name === 'perm')          { loadUserPerms(); loadPermissions(); }
  if (name === 'approver')      loadDeptApprovers();
  if (name === 'leavetype')     loadLeaveTypesHr();
  if (name === 'workschedule')  { loadCompanyHolidaysHr(); loadWorkScheduleHr(); }
  if (name === 'summary')       loadLeaveSummary();
  if (name === 'deptsummary')   loadDeptSummary();
}

// ===== สรุปรายงานการลา =====
let leaveSummaryData = null;
let summaryCurrentPage = 1;

function initSummaryYearFilter() {
  const sel = document.getElementById('summary-year');
  if (!sel || sel.options.length) return;
  const cur = new Date().getFullYear();
  for (let y = cur; y >= cur - 5; y--) sel.appendChild(new Option(y, y));
  sel.value = cur;
}

async function loadLeaveSummary() {
  initSummaryYearFilter();
  summaryCurrentPage = 1;
  const year = document.getElementById('summary-year')?.value || new Date().getFullYear();
  document.getElementById('summary-loading').style.display = '';
  document.getElementById('summary-wrap').style.display = 'none';
  document.getElementById('summary-info-bar').style.display = 'none';
  document.getElementById('summary-pagination').style.display = 'none';
  document.getElementById('summary-alert').style.display = 'none';
  const data = await api('GET', `/hr/leave-summary?year=${year}`);
  document.getElementById('summary-loading').style.display = 'none';
  if (data.error || !data.leaveTypes) {
    const al = document.getElementById('summary-alert');
    al.style.display = '';
    al.innerHTML = `<div style="background:#fee2e2;color:#991b1b;border-radius:8px;padding:12px 16px;font-size:13px">เกิดข้อผิดพลาด: ${data.error || JSON.stringify(data)}</div>`;
    return;
  }
  // กรองเฉพาะประเภทการลาที่มีข้อมูลจริง
  const activeLeaveTypes = data.leaveTypes.filter(lt =>
    data.employees.some(e => Number(e.types[lt.id]?.count || 0) > 0)
  );
  leaveSummaryData = { ...data, leaveTypes: activeLeaveTypes };
  buildSummaryHeader(activeLeaveTypes);
  renderSummaryPage();
}

function buildSummaryHeader(leaveTypes) {
  const thStyle = 'padding:10px 12px;font-size:12px;font-weight:700;text-align:center;white-space:nowrap;border:1px solid #e2e8f0;background:linear-gradient(135deg,#1e3a5f,#2b6cb0);color:#fff';
  const thLeft  = 'padding:10px 12px;font-size:12px;font-weight:700;text-align:left;white-space:nowrap;border:1px solid #e2e8f0;background:linear-gradient(135deg,#1e3a5f,#2b6cb0);color:#fff';
  let headHtml = `<tr>
    <th style="${thLeft};position:sticky;left:0;z-index:2">#</th>
    <th style="${thLeft};position:sticky;left:32px;z-index:2;min-width:120px">รหัส</th>
    <th style="${thLeft};position:sticky;left:100px;z-index:2;min-width:160px">ชื่อ-นามสกุล</th>
    <th style="${thLeft}">แผนก</th>`;
  for (const lt of leaveTypes) {
    headHtml += `<th style="${thStyle};min-width:100px">${lt.name}</th>`;
  }
  headHtml += `<th style="${thStyle}">รวมทั้งหมด</th></tr>`;
  document.getElementById('summary-thead').innerHTML = headHtml;
}

function renderSummaryPage() {
  if (!leaveSummaryData) return;
  const { leaveTypes, employees } = leaveSummaryData;
  const kw = (document.getElementById('summary-search')?.value || '').trim().toLowerCase();
  const filtered = kw
    ? employees.filter(e =>
        (e.employee_id||'').toLowerCase().includes(kw) ||
        (e.name||'').toLowerCase().includes(kw) ||
        (e.department||'').toLowerCase().includes(kw))
    : employees;
  const pageSize = parseInt(document.getElementById('summary-page-size')?.value || '20');
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (summaryCurrentPage > totalPages) summaryCurrentPage = totalPages;
  const start = (summaryCurrentPage - 1) * pageSize;
  const pageData = filtered.slice(start, start + pageSize);

  // info bar
  document.getElementById('summary-info-bar').style.display = 'flex';
  document.getElementById('summary-info-text').innerHTML =
    `แสดง <b>${total ? start+1 : 0}–${Math.min(start+pageSize, total)}</b> จาก <b>${total}</b> รายการ` +
    (totalPages > 1 ? ` &nbsp;|&nbsp; หน้า <b>${summaryCurrentPage}</b> / <b>${totalPages}</b>` : '');

  const tdBase = 'padding:9px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:center;white-space:nowrap';
  const tdLeft = 'padding:9px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;white-space:nowrap';

  let bodyHtml = '';
  pageData.forEach((emp, i) => {
    const idx = start + i;
    let totalDays = 0, totalHours = 0;
    for (const lt of leaveTypes) {
      totalDays  += Number(emp.types[lt.id]?.days  || 0);
      totalHours += Number(emp.types[lt.id]?.hours || 0);
    }
    const bg = i % 2 === 0 ? '#fff' : '#f8fafc';
    bodyHtml += `<tr style="background:${bg}">
      <td style="${tdBase};position:sticky;left:0;background:${bg};color:#94a3b8;font-size:11px">${idx+1}</td>
      <td style="${tdLeft};position:sticky;left:32px;background:${bg};font-weight:700;color:#1e3a5f">${emp.employee_id||'-'}</td>
      <td style="${tdLeft};position:sticky;left:100px;background:${bg};font-weight:600">${emp.name||'-'}</td>
      <td style="${tdLeft};color:#4a5568">${emp.department||'-'}</td>`;
    for (const lt of leaveTypes) {
      const t = emp.types[lt.id];
      if (t && (Number(t.days) > 0 || Number(t.hours) > 0)) {
        const d=Number(t.days), h=Number(t.hours), wh=Math.floor(h), wm=Math.round((h-wh)*60);
        const parts=[];
        if(d>0) parts.push(`${d}วัน`);
        if(wh>0) parts.push(`${wh}ชม.`);
        if(wm>0) parts.push(`${wm}น.`);
        bodyHtml += `<td style="${tdBase};color:#1d4ed8;font-weight:700">${parts.join(' ')}<br><span style="font-size:10px;color:#94a3b8">(${t.count}ครั้ง)</span></td>`;
      } else {
        bodyHtml += `<td style="${tdBase};color:#e2e8f0;font-size:16px">·</td>`;
      }
    }
    const td=Number(totalDays), th2=Number(totalHours), wh2=Math.floor(th2), wm2=Math.round((th2-wh2)*60);
    const tp=[];
    if(td>0) tp.push(`${td}วัน`);
    if(wh2>0) tp.push(`${wh2}ชม.`);
    if(wm2>0) tp.push(`${wm2}น.`);
    bodyHtml += `<td style="${tdBase};font-weight:800;color:#1e3a5f;background:#eff6ff">${tp.join(' ')||'–'}</td></tr>`;
  });

  if (!filtered.length) {
    const msg = kw ? `ไม่พบข้อมูลที่ค้นหา "${kw}"` : 'ไม่มีข้อมูล';
    bodyHtml = `<tr><td colspan="${leaveTypes.length+5}" style="${tdBase};color:#94a3b8;padding:32px">${msg}</td></tr>`;
  }

  document.getElementById('summary-tbody').innerHTML = bodyHtml;
  document.getElementById('summary-wrap').style.display = '';

  // pagination buttons
  const pag = document.getElementById('summary-pagination');
  if (totalPages <= 1) { pag.style.display = 'none'; return; }
  pag.style.display = 'flex';

  const btnBase = 'border:none;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s';
  const btnActive = `${btnBase};background:linear-gradient(135deg,#1e3a5f,#2b6cb0);color:#fff;box-shadow:0 2px 8px rgba(30,58,95,.3)`;
  const btnNormal = `${btnBase};background:#f1f5f9;color:#475569`;
  const btnDisabled = `${btnBase};background:#f8fafc;color:#cbd5e0;cursor:default`;

  const maxVisible = 5;
  let startPage = Math.max(1, summaryCurrentPage - Math.floor(maxVisible/2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

  let html = '';
  // ก่อนหน้า
  html += `<button onclick="summaryGoPage(1)" style="${summaryCurrentPage===1?btnDisabled:btnNormal}" ${summaryCurrentPage===1?'disabled':''}>«</button>`;
  html += `<button onclick="summaryGoPage(${summaryCurrentPage-1})" style="${summaryCurrentPage===1?btnDisabled:btnNormal}" ${summaryCurrentPage===1?'disabled':''}>‹</button>`;
  if (startPage > 1) html += `<span style="padding:0 4px;color:#94a3b8;align-self:center">…</span>`;
  for (let p = startPage; p <= endPage; p++) {
    html += `<button onclick="summaryGoPage(${p})" style="${p===summaryCurrentPage?btnActive:btnNormal}">${p}</button>`;
  }
  if (endPage < totalPages) html += `<span style="padding:0 4px;color:#94a3b8;align-self:center">…</span>`;
  html += `<button onclick="summaryGoPage(${summaryCurrentPage+1})" style="${summaryCurrentPage===totalPages?btnDisabled:btnNormal}" ${summaryCurrentPage===totalPages?'disabled':''}>›</button>`;
  html += `<button onclick="summaryGoPage(${totalPages})" style="${summaryCurrentPage===totalPages?btnDisabled:btnNormal}" ${summaryCurrentPage===totalPages?'disabled':''}>»</button>`;
  pag.innerHTML = html;
}

function summaryGoPage(p) {
  if (!leaveSummaryData) return;
  const kw = (document.getElementById('summary-search')?.value || '').trim().toLowerCase();
  const total = kw
    ? leaveSummaryData.employees.filter(e =>
        (e.employee_id||'').toLowerCase().includes(kw) ||
        (e.name||'').toLowerCase().includes(kw) ||
        (e.department||'').toLowerCase().includes(kw)).length
    : leaveSummaryData.employees.length;
  const pageSize = parseInt(document.getElementById('summary-page-size')?.value || '20');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  summaryCurrentPage = Math.max(1, Math.min(p, totalPages));
  renderSummaryPage();
  document.getElementById('hrsec-summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function exportLeaveSummary() {
  const year = document.getElementById('summary-year')?.value || new Date().getFullYear();
  const data = leaveSummaryData;
  if (!data) return Swal.fire({ icon:'warning', title:'ยังไม่มีข้อมูล', text:'กรุณาโหลดข้อมูลก่อน Export', confirmButtonColor:'#1e3a5f' });
  const { leaveTypes, employees } = data;
  const kw = (document.getElementById('summary-search')?.value || '').trim().toLowerCase();
  const exportData = kw
    ? employees.filter(e =>
        (e.employee_id||'').toLowerCase().includes(kw) ||
        (e.name||'').toLowerCase().includes(kw) ||
        (e.department||'').toLowerCase().includes(kw))
    : employees;
  if (!exportData.length) return Swal.fire({ icon:'warning', title:'ไม่มีข้อมูล', text:'ไม่พบข้อมูลที่ตรงกับคำค้นหา', confirmButtonColor:'#1e3a5f' });
  const suffix = kw ? ` (ค้นหา: ${kw})` : '';
  const headers = ['#','รหัสพนักงาน','ชื่อ-นามสกุล','แผนก', ...leaveTypes.map(lt=>lt.name), 'รวมทั้งหมด'];
  const rows = exportData.map((emp, idx) => {
    let totalDays = 0, totalHours = 0;
    const cells = leaveTypes.map(lt => {
      const t = emp.types[lt.id];
      totalDays  += Number(t?.days||0);
      totalHours += Number(t?.hours||0);
      if (!t || (!t.days && !t.hours)) return '-';
      const d=Number(t.days),h=Number(t.hours),wh=Math.floor(h),wm=Math.round((h-wh)*60);
      const p=[];if(d>0)p.push(`${d}วัน`);if(wh>0)p.push(`${wh}ชม.`);if(wm>0)p.push(`${wm}น.`);
      return p.join(' ')||'-';
    });
    const td=Number(totalDays),th2=Number(totalHours),wh2=Math.floor(th2),wm2=Math.round((th2-wh2)*60);
    const tp=[];if(td>0)tp.push(`${td}วัน`);if(wh2>0)tp.push(`${wh2}ชม.`);if(wm2>0)tp.push(`${wm2}น.`);
    return [idx+1, emp.employee_id||'', emp.name||'', emp.department||'', ...cells, tp.join(' ')||'-'];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `สรุปการลา ${year}`);
  XLSX.writeFile(wb, `leave_summary_${year}${kw?'_'+kw:''}.xlsx`);
}

// ===== สรุปตามแผนก =====
let deptSummaryData = null;
let deptSummaryCurrentPage = 1;

function initDeptSummaryYearFilter() {
  const sel = document.getElementById('deptsummary-year');
  if (!sel || sel.options.length) return;
  const cur = new Date().getFullYear();
  for (let y = cur; y >= cur - 5; y--) sel.appendChild(new Option(y, y));
  sel.value = cur;
}

async function loadDeptSummary() {
  initDeptSummaryYearFilter();
  deptSummaryCurrentPage = 1;
  const year = document.getElementById('deptsummary-year')?.value || new Date().getFullYear();
  document.getElementById('deptsummary-loading').style.display = '';
  document.getElementById('deptsummary-wrap').style.display = 'none';
  document.getElementById('deptsummary-cards').style.display = 'none';
  document.getElementById('deptsummary-info-bar').style.display = 'none';
  document.getElementById('deptsummary-pagination').style.display = 'none';
  document.getElementById('deptsummary-alert').style.display = 'none';
  const data = await api('GET', `/hr/leave-summary?year=${year}`);
  document.getElementById('deptsummary-loading').style.display = 'none';
  if (data.error || !data.leaveTypes) {
    const al = document.getElementById('deptsummary-alert');
    al.style.display = '';
    al.innerHTML = `<div style="background:#fee2e2;color:#991b1b;border-radius:8px;padding:12px 16px;font-size:13px">เกิดข้อผิดพลาด: ${data.error || JSON.stringify(data)}</div>`;
    return;
  }
  // aggregate by department
  const deptMap = {};
  for (const emp of data.employees) {
    const dept = emp.department || 'ไม่ระบุแผนก';
    if (!deptMap[dept]) deptMap[dept] = { dept, empCount: 0, empSet: new Set(), types: {} };
    deptMap[dept].empSet.add(emp.user_id);
    for (const lt of data.leaveTypes) {
      if (!deptMap[dept].types[lt.id]) deptMap[dept].types[lt.id] = { days: 0, hours: 0, count: 0 };
      deptMap[dept].types[lt.id].days  += Number(emp.types[lt.id]?.days  || 0);
      deptMap[dept].types[lt.id].hours += Number(emp.types[lt.id]?.hours || 0);
      deptMap[dept].types[lt.id].count += Number(emp.types[lt.id]?.count || 0);
    }
  }
  const departments = Object.values(deptMap).map(d => ({ ...d, empCount: d.empSet.size }))
    .sort((a, b) => a.dept.localeCompare(b.dept, 'th'));
  // กรองเฉพาะประเภทการลาที่มีข้อมูลจริงในแผนกใดแผนกหนึ่ง
  const activeLeaveTypesDept = data.leaveTypes.filter(lt =>
    departments.some(d => Number(d.types[lt.id]?.count || 0) > 0)
  );
  deptSummaryData = { leaveTypes: activeLeaveTypesDept, departments, totalEmployees: data.employees.length };
  buildDeptSummaryHeader(activeLeaveTypesDept);
  renderDeptStatCards(departments, activeLeaveTypesDept);
  renderDeptSummaryPage();
}

function renderDeptStatCards(departments, leaveTypes) {
  const container = document.getElementById('deptsummary-cards');
  const totalDepts = departments.length;
  const totalEmps  = departments.reduce((s, d) => s + d.empCount, 0);
  let totalLeaves  = 0;
  for (const d of departments)
    for (const lt of leaveTypes)
      totalLeaves += Number(d.types[lt.id]?.count || 0);

  const card = (icon, label, val, grad, shadow) =>
    `<div style="background:${grad};border-radius:14px;padding:18px 22px;min-width:150px;flex:1;box-shadow:${shadow};color:#fff">
      <div style="font-size:26px;margin-bottom:6px">${icon}</div>
      <div style="font-size:22px;font-weight:800;line-height:1">${val}</div>
      <div style="font-size:12px;opacity:.85;margin-top:4px">${label}</div>
    </div>`;

  container.innerHTML =
    card('🏢','จำนวนแผนกทั้งหมด', totalDepts,
         'linear-gradient(135deg,#1e3a5f,#2b6cb0)','0 4px 14px rgba(30,58,95,.35)') +
    card('👥','พนักงานทั้งหมด', totalEmps,
         'linear-gradient(135deg,#0369a1,#38bdf8)','0 4px 14px rgba(3,105,161,.3)') +
    card('📋','ประเภทการลา', leaveTypes.length,
         'linear-gradient(135deg,#7c3aed,#a78bfa)','0 4px 14px rgba(124,58,237,.3)') +
    card('📅','ครั้งที่ลาทั้งหมด (approved)', totalLeaves,
         'linear-gradient(135deg,#059669,#34d399)','0 4px 14px rgba(5,150,105,.3)');
  container.style.display = 'flex';
}

function buildDeptSummaryHeader(leaveTypes) {
  const thS = 'padding:10px 12px;font-size:12px;font-weight:700;text-align:center;white-space:nowrap;border:1px solid #e2e8f0;background:linear-gradient(135deg,#1e3a5f,#2b6cb0);color:#fff';
  const thL = 'padding:10px 12px;font-size:12px;font-weight:700;text-align:left;white-space:nowrap;border:1px solid #e2e8f0;background:linear-gradient(135deg,#1e3a5f,#2b6cb0);color:#fff';
  let h = `<tr>
    <th style="${thL};position:sticky;left:0;z-index:2">#</th>
    <th style="${thL};position:sticky;left:32px;z-index:2;min-width:180px">🏢 แผนก</th>
    <th style="${thS};min-width:90px">👥 พนักงาน</th>`;
  for (const lt of leaveTypes) h += `<th style="${thS};min-width:110px">${lt.name}</th>`;
  h += `<th style="${thS}">📊 รวมทั้งหมด</th></tr>`;
  document.getElementById('deptsummary-thead').innerHTML = h;
}

function renderDeptSummaryPage() {
  if (!deptSummaryData) return;
  const { leaveTypes, departments } = deptSummaryData;
  const kw = (document.getElementById('deptsummary-search')?.value || '').trim().toLowerCase();
  const filtered = kw ? departments.filter(d => d.dept.toLowerCase().includes(kw)) : departments;
  const pageSize = parseInt(document.getElementById('deptsummary-page-size')?.value || '10');
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (deptSummaryCurrentPage > totalPages) deptSummaryCurrentPage = totalPages;
  const start = (deptSummaryCurrentPage - 1) * pageSize;
  const pageData = filtered.slice(start, start + pageSize);

  document.getElementById('deptsummary-info-bar').style.display = 'flex';
  document.getElementById('deptsummary-info-text').innerHTML =
    `แสดง <b>${total ? start+1 : 0}–${Math.min(start+pageSize, total)}</b> จาก <b>${total}</b> แผนก` +
    (totalPages > 1 ? ` &nbsp;|&nbsp; หน้า <b>${deptSummaryCurrentPage}</b> / <b>${totalPages}</b>` : '');

  const tdC = 'padding:10px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:center;white-space:nowrap';
  const tdL = 'padding:10px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;white-space:nowrap';

  const fmtT = (days, hours) => {
    const d=Number(days),h=Number(hours),wh=Math.floor(h),wm=Math.round((h-wh)*60);
    const p=[];if(d>0)p.push(`${d}วัน`);if(wh>0)p.push(`${wh}ชม.`);if(wm>0)p.push(`${wm}น.`);
    return p.join(' ')||'–';
  };

  let body = '';
  const deptColors = ['#eff6ff','#f0fdf4','#fdf4ff','#fff7ed','#f0f9ff','#fefce8'];

  pageData.forEach((dept, i) => {
    let totalDays = 0, totalHours = 0, totalCount = 0;
    for (const lt of leaveTypes) {
      totalDays  += Number(dept.types[lt.id]?.days  || 0);
      totalHours += Number(dept.types[lt.id]?.hours || 0);
      totalCount += Number(dept.types[lt.id]?.count || 0);
    }
    const bg = i % 2 === 0 ? '#fff' : '#f8fafc';
    const accentBg = deptColors[(start+i) % deptColors.length];
    body += `<tr style="background:${bg}">
      <td style="${tdC};position:sticky;left:0;background:${bg};color:#94a3b8;font-size:11px">${start+i+1}</td>
      <td style="${tdL};position:sticky;left:32px;background:${bg}">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:32px;height:32px;border-radius:8px;background:${accentBg};display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">🏢</div>
          <div>
            <div style="font-weight:700;color:#1e3a5f;font-size:13px">${dept.dept}</div>
            <div style="font-size:11px;color:#94a3b8">ลาทั้งหมด ${totalCount} ครั้ง</div>
          </div>
        </div>
      </td>
      <td style="${tdC};font-weight:700;color:#0369a1;font-size:14px">${dept.empCount}<br><span style="font-size:10px;font-weight:400;color:#94a3b8">คน</span></td>`;
    for (const lt of leaveTypes) {
      const t = dept.types[lt.id];
      const d = Number(t?.days||0), h = Number(t?.hours||0), cnt = Number(t?.count||0);
      if (d > 0 || h > 0) {
        body += `<td style="${tdC};color:#1d4ed8;font-weight:700">${fmtT(d,h)}<br><span style="font-size:10px;color:#94a3b8">(${cnt}ครั้ง)</span></td>`;
      } else {
        body += `<td style="${tdC};color:#e2e8f0;font-size:16px">·</td>`;
      }
    }
    body += `<td style="${tdC};font-weight:800;color:#1e3a5f;background:#eff6ff">${fmtT(totalDays,totalHours)}</td></tr>`;
  });

  if (!filtered.length) {
    const msg = kw ? `ไม่พบแผนก "${kw}"` : 'ไม่มีข้อมูล';
    body = `<tr><td colspan="${leaveTypes.length+4}" style="${tdC};color:#94a3b8;padding:32px">${msg}</td></tr>`;
  }

  document.getElementById('deptsummary-tbody').innerHTML = body;
  document.getElementById('deptsummary-wrap').style.display = '';

  // pagination
  const pag = document.getElementById('deptsummary-pagination');
  if (totalPages <= 1) { pag.style.display = 'none'; return; }
  pag.style.display = 'flex';
  const btnBase = 'border:none;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s';
  const btnActive   = `${btnBase};background:linear-gradient(135deg,#1e3a5f,#2b6cb0);color:#fff;box-shadow:0 2px 8px rgba(30,58,95,.3)`;
  const btnNormal   = `${btnBase};background:#f1f5f9;color:#475569`;
  const btnDisabled = `${btnBase};background:#f8fafc;color:#cbd5e0;cursor:default`;
  const maxVis = 5;
  let sp = Math.max(1, deptSummaryCurrentPage - Math.floor(maxVis/2));
  let ep = Math.min(totalPages, sp + maxVis - 1);
  if (ep - sp < maxVis - 1) sp = Math.max(1, ep - maxVis + 1);
  let html = '';
  html += `<button onclick="deptSummaryGoPage(1)" style="${deptSummaryCurrentPage===1?btnDisabled:btnNormal}" ${deptSummaryCurrentPage===1?'disabled':''}>«</button>`;
  html += `<button onclick="deptSummaryGoPage(${deptSummaryCurrentPage-1})" style="${deptSummaryCurrentPage===1?btnDisabled:btnNormal}" ${deptSummaryCurrentPage===1?'disabled':''}>‹</button>`;
  if (sp > 1) html += `<span style="padding:0 4px;color:#94a3b8;align-self:center">…</span>`;
  for (let p = sp; p <= ep; p++)
    html += `<button onclick="deptSummaryGoPage(${p})" style="${p===deptSummaryCurrentPage?btnActive:btnNormal}">${p}</button>`;
  if (ep < totalPages) html += `<span style="padding:0 4px;color:#94a3b8;align-self:center">…</span>`;
  html += `<button onclick="deptSummaryGoPage(${deptSummaryCurrentPage+1})" style="${deptSummaryCurrentPage===totalPages?btnDisabled:btnNormal}" ${deptSummaryCurrentPage===totalPages?'disabled':''}>›</button>`;
  html += `<button onclick="deptSummaryGoPage(${totalPages})" style="${deptSummaryCurrentPage===totalPages?btnDisabled:btnNormal}" ${deptSummaryCurrentPage===totalPages?'disabled':''}>»</button>`;
  pag.innerHTML = html;
}

function deptSummaryGoPage(p) {
  if (!deptSummaryData) return;
  const kw = (document.getElementById('deptsummary-search')?.value || '').trim().toLowerCase();
  const total = kw
    ? deptSummaryData.departments.filter(d => d.dept.toLowerCase().includes(kw)).length
    : deptSummaryData.departments.length;
  const pageSize = parseInt(document.getElementById('deptsummary-page-size')?.value || '10');
  deptSummaryCurrentPage = Math.max(1, Math.min(p, Math.ceil(total/pageSize)));
  renderDeptSummaryPage();
  document.getElementById('hrsec-deptsummary').scrollIntoView({ behavior:'smooth', block:'start' });
}

async function exportDeptSummary() {
  const year = document.getElementById('deptsummary-year')?.value || new Date().getFullYear();
  const data = deptSummaryData;
  if (!data) return Swal.fire({ icon:'warning', title:'ยังไม่มีข้อมูล', text:'กรุณาโหลดข้อมูลก่อน Export', confirmButtonColor:'#1e3a5f' });
  const { leaveTypes, departments } = data;
  const kw = (document.getElementById('deptsummary-search')?.value || '').trim().toLowerCase();
  const exportDepts = kw ? departments.filter(d => d.dept.toLowerCase().includes(kw)) : departments;
  if (!exportDepts.length) return Swal.fire({ icon:'warning', title:'ไม่มีข้อมูล', text:'ไม่พบแผนกที่ตรงกับคำค้นหา', confirmButtonColor:'#1e3a5f' });
  const headers = ['#','แผนก','จำนวนพนักงาน (คน)', ...leaveTypes.map(lt=>lt.name), 'รวมทั้งหมด'];
  const fmtT = (d,h) => {
    const wh=Math.floor(h),wm=Math.round((h-wh)*60);
    const p=[];if(d>0)p.push(`${d}วัน`);if(wh>0)p.push(`${wh}ชม.`);if(wm>0)p.push(`${wm}น.`);
    return p.join(' ')||'-';
  };
  const rows = exportDepts.map((dept, idx) => {
    let td=0, th2=0;
    const cells = leaveTypes.map(lt => {
      const t = dept.types[lt.id];
      td += Number(t?.days||0); th2 += Number(t?.hours||0);
      return (Number(t?.days||0)+Number(t?.hours||0)) > 0 ? fmtT(Number(t.days),Number(t.hours)) : '-';
    });
    return [idx+1, dept.dept, dept.empCount, ...cells, fmtT(td,th2)];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `สรุปตามแผนก ${year}`);
  XLSX.writeFile(wb, `dept_leave_summary_${year}${kw?'_'+kw:''}.xlsx`);
}

// ===== IMPORT EXCEL =====
async function downloadTemplate() {
  const resp = await fetch('/api/hr/employee-template', { headers: { 'Authorization': 'Bearer ' + token } });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: 'error ' + resp.status }));
    return Swal.fire({ icon:'error', title:'ดาวน์โหลดไม่ได้', text: err.message || ('HTTP ' + resp.status), confirmButtonColor:'#1e3a5f' });
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'employee_template.xlsx'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function previewImport() {
  const file = document.getElementById('import-file').files[0];
  if (!file) return;
  const preview = document.getElementById('import-preview');
  const tbody = document.getElementById('import-tbody');
  const countEl = document.getElementById('import-count');
  const btn = document.getElementById('btn-do-import');

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const dataRows = rows.slice(1).filter(r => r[0] && String(r[0]).trim() && !String(r[0]).startsWith('หมายเหตุ'));

    if (!dataRows.length) { preview.style.display = 'none'; btn.disabled = true; return; }

    const roleLabel = { employee:'พนักงาน', unit_head:'หัวหน้าหน่วยงาน', department_head:'หัวหน้าแผนก', division_manager:'ผู้จัดการ', hr_admin:'HR Admin' };
    tbody.innerHTML = dataRows.map((r, i) => `<tr>
      <td>${i+1}</td>
      <td>${r[0]||''}</td><td>${r[1]||''}</td><td>${r[2]||''}</td>
      <td>${roleLabel[r[4]] || r[4] || ''}</td>
      <td>${r[5]||''}</td><td>${r[6]||''}</td><td>${r[7]||''}</td>
    </tr>`).join('');
    countEl.textContent = dataRows.length;
    preview.style.display = '';
    btn.disabled = false;
    document.getElementById('import-result').innerHTML = '';
  } catch(e) {
    swalError('อ่านไฟล์ไม่ได้: ' + e.message);
  }
}

async function doImport() {
  const file = document.getElementById('import-file').files[0];
  if (!file) return;
  const btn = document.getElementById('btn-do-import');
  btn.disabled = true; btn.textContent = '⏳ กำลังนำเข้า...';
  const fd = new FormData(); fd.append('file', file);
  const resp = await fetch('/api/hr/import-employees', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd });
  const r = await resp.json();
  btn.textContent = '✅ นำเข้าข้อมูล'; btn.disabled = false;

  const errList = r.errors && r.errors.length ? '\n\nรายการที่ล้มเหลว:\n• ' + r.errors.join('\n• ') : '';
  if (r.failed === 0) {
    swalSuccess(r.message, () => loadEmployees());
  } else {
    Swal.fire({ icon: r.success > 0 ? 'warning' : 'error', title: r.success > 0 ? 'นำเข้าบางส่วนสำเร็จ' : 'นำเข้าไม่สำเร็จ', text: r.message + errList, confirmButtonColor: '#1e3a5f' }).then(() => { if (r.success > 0) loadEmployees(); });
  }
  document.getElementById('import-result').innerHTML = '';
}

async function loadHrStats() {
  const s = await api('GET', '/hr/stats');
  if (s.error) return;
  document.getElementById('hr-stat-grid').innerHTML = `
    <div class="stat-card"><div class="val">${s.totalEmployees}</div><div class="lbl">พนักงานทั้งหมด</div></div>
    <div class="stat-card yellow"><div class="val">${s.pending}</div><div class="lbl">รออนุมัติ</div></div>
    <div class="stat-card green"><div class="val">${s.approvedCount}</div><div class="lbl">อนุมัติแล้ว (ปีนี้)</div></div>
    <div class="stat-card purple"><div class="val">${s.approvedDays}</div><div class="lbl">รวมวันลาที่อนุมัติ</div></div>
    <div class="stat-card"><div class="val">${s.totalLeave}</div><div class="lbl">คำขอทั้งหมด (ปีนี้)</div></div>
  `;
  const tbody = document.getElementById('hr-dept-tbody');
  tbody.innerHTML = s.byDepartment.length ? s.byDepartment.map(r => `<tr><td>${r.department}</td><td>${r.total}</td><td>${r.days}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">ยังไม่มีข้อมูล</td></tr>';
}

// ===== HR CALENDAR =====
let hrCalYear = new Date().getFullYear();
let hrCalMonth = new Date().getMonth(); // 0-based
let hrCalData = [];
let hrCalTypeColors = {};

async function loadHrCalendar() {
  hrCalYear = hrCalYear || new Date().getFullYear();
  hrCalMonth = hrCalMonth !== undefined ? hrCalMonth : new Date().getMonth();

  // fetch leave data for this month (approved only)
  const y = hrCalYear, m = String(hrCalMonth + 1).padStart(2, '0');
  await Promise.all([loadWorkScheduleCache(hrCalYear), loadCompanyHolidaysCache(hrCalYear)]);
  const data = await api('GET', `/hr/leave-records?status=approved&year=${y}&month=${m}`);
  hrCalData = Array.isArray(data) ? data : [];

  // assign colors to leave types
  const types = [...new Set(hrCalData.map(r => r.leave_type_name))];
  types.forEach((t, i) => { if (!hrCalTypeColors[t]) hrCalTypeColors[t] = CHART_COLORS[i % CHART_COLORS.length]; });

  // render legend
  const legendEl = document.getElementById('hr-cal-legend');
  legendEl.innerHTML = types.map(t => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px"><span style="width:12px;height:12px;border-radius:3px;background:${hrCalTypeColors[t]};display:inline-block"></span>${t}</span>`).join('');

  // render calendar grid
  renderHrCalGrid();
}

function hrCalNav(dir) {
  hrCalMonth += dir;
  if (hrCalMonth > 11) { hrCalMonth = 0; hrCalYear++; }
  if (hrCalMonth < 0)  { hrCalMonth = 11; hrCalYear--; }
  loadHrCalendar();
}

function renderHrCalGrid() {
  const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  document.getElementById('hr-cal-title').textContent = `${THAI_MONTHS[hrCalMonth]} ${hrCalYear + 543}`;

  const firstDay = new Date(hrCalYear, hrCalMonth, 1).getDay();
  const daysInMonth = new Date(hrCalYear, hrCalMonth + 1, 0).getDate();
  const today = new Date();
  const pad = n => String(n).padStart(2,'0');

  const dayMap = {};
  hrCalData.forEach(r => {
    const start = new Date(r.start_date + 'T00:00:00');
    const end   = new Date(r.end_date   + 'T00:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getFullYear() === hrCalYear && d.getMonth() === hrCalMonth) {
        const key = d.getDate();
        if (!dayMap[key]) dayMap[key] = [];
        dayMap[key].push(r);
      }
    }
  });

  const DOW = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัส','ศุกร์','เสาร์'];

  // header row
  let html = `<div style="background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(15,39,68,.12);border:1px solid #e2e9f3">`;

  // day-of-week headers
  html += `<div style="display:grid;grid-template-columns:repeat(7,1fr)">`;
  const dowHdrStyle = [
    'background:linear-gradient(135deg,#fee2e2,#fecaca);color:#991b1b;',
    'background:linear-gradient(135deg,#eff6ff,#dbeafe);color:#1e3a8a;',
    'background:linear-gradient(135deg,#eff6ff,#dbeafe);color:#1e3a8a;',
    'background:linear-gradient(135deg,#eff6ff,#dbeafe);color:#1e3a8a;',
    'background:linear-gradient(135deg,#eff6ff,#dbeafe);color:#1e3a8a;',
    'background:linear-gradient(135deg,#eff6ff,#dbeafe);color:#1e3a8a;',
    'background:linear-gradient(135deg,#e0f2fe,#bae6fd);color:#075985;',
  ];
  DOW.forEach((d, i) => {
    html += `<div style="${dowHdrStyle[i]}padding:14px 6px;text-align:center;font-size:13px;font-weight:800;letter-spacing:.3px;border-bottom:2px solid rgba(0,0,0,.06)">${d}</div>`;
  });
  html += '</div>';

  // calendar body grid — fixed rows
  const totalRows = Math.ceil((firstDay + daysInMonth) / 7);
  html += `<div style="display:grid;grid-template-columns:repeat(7,1fr);grid-auto-rows:130px">`;

  let day = 1;
  const totalCells = totalRows * 7;
  for (let i = 0; i < totalCells; i++) {
    const col = i % 7;
    const cellDay = (i < firstDay) ? null : day <= daysInMonth ? day++ : null;
    const isToday = cellDay && hrCalYear === today.getFullYear() && hrCalMonth === today.getMonth() && cellDay === today.getDate();
    const isSun = col === 0, isSat = col === 6;
    const events = cellDay ? (dayMap[cellDay] || []) : [];
    const visible = events.slice(0, 3);
    const extra = events.length - visible.length;

    let bg = '', borderLeft = '', holBanner = '', dayLabel = '';

    if (!cellDay) {
      bg = 'background:linear-gradient(135deg,#f8fafd,#f1f5f9);';
    } else if (isToday) {
      bg = 'background:linear-gradient(160deg,#eff6ff,#dbeafe);'; borderLeft = 'border-left:3px solid #1565c0;';
    } else {
      const dStr = `${hrCalYear}-${pad(hrCalMonth+1)}-${pad(cellDay)}`;
      if (isCompanyHoliday(dStr)) {
        bg = 'background:linear-gradient(160deg,#fff1f2,#fecaca20);'; borderLeft = 'border-left:3px solid #ef4444;';
        holBanner = `<div style="font-size:9px;background:linear-gradient(90deg,#dc2626,#b91c1c);color:#fff;border-radius:5px;padding:2px 6px;margin-bottom:4px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 4px rgba(220,38,38,.3)">🎌 ${companyHolidayName(dStr)}</div>`;
      } else if (isSun) {
        bg = 'background:linear-gradient(160deg,#fdf4ff,#f3e8ff);'; borderLeft = 'border-left:3px solid #c084fc;';
      } else if (isSat) {
        const ws = workScheduleCache[dStr];
        const working = ws ? ws === 'working_sat' : isWorkingSaturday(new Date(hrCalYear, hrCalMonth, cellDay));
        if (working) {
          bg = 'background:linear-gradient(160deg,#f0fdf4,#dcfce7);'; borderLeft = 'border-left:3px solid #22c55e;';
          dayLabel = `<span style="font-size:9px;font-weight:700;color:#14532d;background:#bbf7d0;border-radius:5px;padding:1px 5px;margin-left:4px">✓ ทำงาน</span>`;
        } else {
          bg = 'background:linear-gradient(160deg,#fffbeb,#fef3c7);'; borderLeft = 'border-left:3px solid #f59e0b;';
          dayLabel = `<span style="font-size:9px;font-weight:700;color:#78350f;background:#fde68a;border-radius:5px;padding:1px 5px;margin-left:4px">หยุด</span>`;
        }
      } else {
        bg = 'background:#fff;';
      }
    }

    const numColor = !cellDay ? '' : isSun ? '#9333ea' : isSat ? '#0284c7' : '#1e293b';
    const borderRight = col < 6 ? 'border-right:1px solid #e2e9f3;' : '';
    const borderBottom = i < totalCells - 7 ? 'border-bottom:1px solid #e2e9f3;' : '';

    html += `<div style="position:relative;overflow:hidden;padding:8px 9px;${bg}${borderLeft}${borderRight}${borderBottom}box-sizing:border-box;">`;
    if (cellDay) {
      const numBubble = isToday
        ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#1565c0,#1976d2);color:#fff;font-size:13px;font-weight:800;box-shadow:0 3px 8px rgba(21,101,192,.4)">${cellDay}</span>`
        : `<span style="font-size:14px;font-weight:800;color:${numColor}">${cellDay}</span>`;
      html += `<div style="display:flex;align-items:center;margin-bottom:5px">${numBubble}${dayLabel}</div>`;
      html += holBanner;
      visible.forEach(ev => {
        const color = hrCalTypeColors[ev.leave_type_name] || '#64748b';
        const evJson = JSON.stringify(JSON.stringify(ev));
        html += `<div onmouseenter="showTooltip(event,${evJson},'${color}')" onmouseleave="hideTooltip()" style="font-size:10px;font-weight:700;background:${color};color:#fff;border-radius:6px;padding:3px 8px;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 4px rgba(0,0,0,.18);letter-spacing:.1px;cursor:pointer">${ev.employee_name}</div>`;
      });
      if (extra > 0) html += `<div style="font-size:10px;color:#64748b;font-weight:700;padding:2px 6px;background:#e2e9f3;border-radius:5px;display:inline-block">+${extra} เพิ่มเติม</div>`;
    }
    html += '</div>';
  }
  html += '</div></div>';

  // legend
  html += `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:16px;font-size:12px;align-items:center;padding:12px 16px;background:#fff;border-radius:12px;border:1px solid #e2e9f3;box-shadow:0 2px 8px rgba(0,0,0,.05)">
    <span style="font-weight:800;color:#334155">ความหมายสี:</span>
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#fee2e2;border:2px solid #ef4444;display:inline-block"></span><span style="color:#7f1d1d;font-weight:600">🎌 หยุดตามประเพณี</span></span>
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#fdf4ff;border:2px solid #c084fc;display:inline-block"></span><span style="color:#581c87;font-weight:600">วันอาทิตย์</span></span>
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#f0fdf4;border:2px solid #22c55e;display:inline-block"></span><span style="color:#14532d;font-weight:600">✓ เสาร์ทำงาน</span></span>
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#fffbeb;border:2px solid #f59e0b;display:inline-block"></span><span style="color:#78350f;font-weight:600">เสาร์หยุด</span></span>
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#1565c0,#1976d2);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff">วัน</span><span style="color:#1e3a8a;font-weight:600">วันนี้</span></span>
  </div>`;

  document.getElementById('hr-cal-grid').innerHTML = html;
}

let hrEmpData = [];
let hrEmpPage = 1;

async function loadEmployees() {
  const search = (document.getElementById('hr-emp-search')?.value || '').trim();
  const dept   = (document.getElementById('hr-emp-filter-dept')?.value || '').trim();
  const role   = (document.getElementById('hr-emp-filter-role')?.value || '').trim();
  let url = '/hr/employees?';
  if (search) url += `search=${encodeURIComponent(search)}&`;
  if (dept)   url += `department=${encodeURIComponent(dept)}&`;
  if (role)   url += `role=${role}`;
  const data = await api('GET', url);
  hrEmpData = Array.isArray(data) ? data : [];
  hrEmpPage = 1;
  renderHrEmpTable();
}

function renderHrEmpTable() {
  const pageSize = parseInt(document.getElementById('hr-emp-page-size')?.value || 25);
  const total  = hrEmpData.length;
  const pages  = Math.max(1, Math.ceil(total / pageSize));
  if (hrEmpPage > pages) hrEmpPage = pages;
  const slice  = hrEmpData.slice((hrEmpPage - 1) * pageSize, hrEmpPage * pageSize);

  const tbody = document.getElementById('emp-tbody');
  tbody.innerHTML = slice.length ? slice.map(u => `<tr>
    <td style="font-family:monospace">${u.employee_id}</td>
    <td>${u.name}</td>
    <td style="font-size:13px">${u.email}</td>
    <td style="font-size:13px">${u.unit||''}</td>
    <td>${u.department||''}</td>
    <td style="font-size:13px">${u.division||''}</td>
    <td><span class="badge ${u.role === 'hr_admin' ? 'badge-approved' : u.role === 'employee' ? 'badge-cancelled' : 'badge-l1'}">${ROLE_LABEL[u.role]||u.role}</span></td>
    <td style="white-space:nowrap">
      <button class="btn btn-sm" style="background:#ebf4ff;color:#2b6cb0;margin-right:4px" onclick="openEmpModal(${u.id})">แก้ไข</button>
      <button class="btn btn-sm btn-danger" onclick="deleteEmployee(${u.id},'${u.name}')">ลบ</button>
    </td>
  </tr>`).join('') : '<tr><td colspan="8" class="empty">ไม่พบข้อมูล</td></tr>';

  const infoEl = document.getElementById('hr-emp-table-info');
  if (infoEl) infoEl.textContent = total
    ? `แสดง ${(hrEmpPage-1)*pageSize+1}–${Math.min(hrEmpPage*pageSize,total)} จากทั้งหมด ${total} รายการ`
    : 'ไม่พบข้อมูล';

  const pag = document.getElementById('hr-emp-pagination');
  if (!pag) return;
  if (pages <= 1) { pag.innerHTML = ''; return; }

  const btnS = (active, disabled) =>
    `style="padding:6px 13px;border:1.5px solid ${active?'#2b6cb0':'#e2e8f0'};border-radius:8px;cursor:${disabled?'default':'pointer'};font-size:13px;font-weight:${active?700:400};background:${active?'linear-gradient(135deg,#1e3a5f,#2b6cb0)':'#fff'};color:${active?'#fff':disabled?'#a0aec0':'#4a5568'};transition:.15s;opacity:${disabled?.5:1}"`;

  let html = `<button ${btnS(false, hrEmpPage===1)} onclick="hrEmpGoPage(${hrEmpPage-1})" ${hrEmpPage===1?'disabled':''}>‹ ก่อนหน้า</button>`;

  // แสดงปุ่มหน้าแบบ smart: 1 ... x-1 x x+1 ... N
  const showPages = new Set([1, pages, hrEmpPage, hrEmpPage-1, hrEmpPage+1].filter(p => p >= 1 && p <= pages));
  const sorted = [...showPages].sort((a,b) => a-b);
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) html += `<span style="padding:0 4px;color:#a0aec0;font-size:15px;align-self:center">…</span>`;
    html += `<button ${btnS(p===hrEmpPage, false)} onclick="hrEmpGoPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button ${btnS(false, hrEmpPage===pages)} onclick="hrEmpGoPage(${hrEmpPage+1})" ${hrEmpPage===pages?'disabled':''}>ถัดไป ›</button>`;
  pag.innerHTML = html;
}

function hrEmpGoPage(p) {
  const pageSize = parseInt(document.getElementById('hr-emp-page-size')?.value || 25);
  const pages = Math.max(1, Math.ceil(hrEmpData.length / pageSize));
  hrEmpPage = Math.max(1, Math.min(p, pages));
  renderHrEmpTable();
}

async function openEmpModal(id = null) {
  currentEmpId = id;
  document.getElementById('emp-modal-alert').innerHTML = '';
  document.getElementById('emp-modal-title').textContent = id ? 'แก้ไขข้อมูลพนักงาน' : 'เพิ่มพนักงานใหม่';
  document.getElementById('em-pass-hint').textContent = id ? '(เว้นว่างถ้าไม่เปลี่ยน)' : '(ต้องระบุ)';

  leaveTypesCache = await api('GET', '/hr/leave-types');
  const quotaGrid = document.getElementById('em-quota-grid');
  quotaGrid.innerHTML = leaveTypesCache.map(lt => `
    <div class="form-group" style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;background:#f8fafc">
      <label style="font-weight:700;color:#1e3a5f;margin-bottom:6px;display:block">${lt.name}</label>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <input type="number" id="quota-${lt.id}" value="${lt.max_days_per_year}" min="0" style="width:80px;border:1.5px solid #e2e8f0;border-radius:8px;padding:5px 8px;font-size:14px;font-weight:700;color:#1e3a5f"> วัน/ปี
      </div>
      <div style="margin-top:7px;font-size:12px;display:flex;gap:10px;flex-wrap:wrap">
        <span>ใช้ไปแล้ว: <b id="used-${lt.id}" style="color:#c53030">-</b> วัน</span>
        <span>คงเหลือ: <b id="remain-${lt.id}" style="color:#276749">-</b> วัน</span>
      </div>
      <div style="margin-top:5px;height:6px;background:#e2e8f0;border-radius:99px;overflow:hidden">
        <div id="bar-${lt.id}" style="height:100%;width:0%;background:linear-gradient(90deg,#fc8181,#f56565);border-radius:99px;transition:width .4s"></div>
      </div>
    </div>
  `).join('');

  if (id) {
    const u = await api('GET', `/hr/employees/${id}`);
    document.getElementById('em-empid').value = u.employee_id || '';
    document.getElementById('em-name').value  = u.name || '';
    document.getElementById('em-email').value = u.email || '';
    document.getElementById('em-pass').value  = '';
    document.getElementById('em-role').value    = u.role || 'employee';
    document.getElementById('em-unit').value    = u.unit || '';
    document.getElementById('em-dept').value    = u.department || '';
    document.getElementById('em-div').value     = u.division || '';
    document.getElementById('em-emptype').value = u.employee_type || 'monthly';
    document.getElementById('em-probation').value = u.probation_start_date || '';
    toggleProbationField();
    if (u.balances) u.balances.forEach(b => {
      const quotaEl  = document.getElementById(`quota-${b.leave_type_id}`);
      const usedEl   = document.getElementById(`used-${b.leave_type_id}`);
      const remainEl = document.getElementById(`remain-${b.leave_type_id}`);
      const barEl    = document.getElementById(`bar-${b.leave_type_id}`);
      if (quotaEl)  quotaEl.value = b.total_days;
      const used    = b.used_days || 0;
      const total   = b.total_days || 0;
      const remain  = Math.max(0, total - used);
      const pct     = total > 0 ? Math.min(100, (used / total) * 100) : 0;
      if (usedEl)   usedEl.textContent   = used;
      if (remainEl) remainEl.textContent = remain;
      if (barEl) {
        barEl.style.width = pct + '%';
        barEl.style.background = pct >= 100 ? '#e53e3e' : pct >= 75 ? '#ed8936' : 'linear-gradient(90deg,#68d391,#38a169)';
      }
    });
  } else {
    ['em-empid','em-name','em-email','em-pass','em-unit','em-dept','em-div','em-probation'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('em-role').value    = 'employee';
    document.getElementById('em-emptype').value = 'monthly';
    toggleProbationField();
  }
  document.getElementById('emp-modal').classList.add('open');
}

function closeEmpModal() { document.getElementById('emp-modal').classList.remove('open'); }

async function saveEmployee() {
  const leave_quotas = {};
  leaveTypesCache.forEach(lt => { leave_quotas[lt.id] = parseInt(document.getElementById(`quota-${lt.id}`).value) || lt.max_days_per_year; });
  const body = {
    employee_id: document.getElementById('em-empid').value.trim(),
    name:        document.getElementById('em-name').value.trim(),
    email:       document.getElementById('em-email').value.trim(),
    password:    document.getElementById('em-pass').value,
    role:               document.getElementById('em-role').value,
    unit:               document.getElementById('em-unit').value.trim(),
    department:         document.getElementById('em-dept').value.trim(),
    division:           document.getElementById('em-div').value.trim(),
    employee_type:      document.getElementById('em-emptype').value,
    probation_start_date: document.getElementById('em-probation').value || null,
    leave_quotas,
  };
  let r;
  if (currentEmpId) {
    if (!body.password) delete body.password;
    r = await api('PUT', `/hr/employees/${currentEmpId}`, body);
  } else {
    r = await api('POST', '/hr/employees', body);
  }
  if (r.error) return swalError(r.error);
  swalSuccess(r.message, () => { closeEmpModal(); loadEmployees(); });
}

async function deleteEmployee(id, name) {
  swalConfirm(`ยืนยันการลบพนักงาน "${name}"? จะลบข้อมูลและโควต้าการลาทั้งหมด`, async () => {
    const r = await api('DELETE', `/hr/employees/${id}`);
    if (r.error) return swalError(r.error);
    swalSuccess(`ลบพนักงาน "${name}" สำเร็จ`, () => loadEmployees());
  });
}

// ====== PERMISSIONS ======
const PROTECTED_ROLES = ['employee','unit_head','department_head','division_manager','hr_admin'];

// ===== USER MENU PERMISSIONS (per-user) =====
let upAllData = [];
let upPage = 1;
const UP_PAGE_SIZE = 20;

// สิทธิ์ที่ HR Admin สามารถมอบให้พนักงานรายบุคคล
// (พนักงาน, นำเข้า Excel, สิทธิ์, ผู้อนุมัติ, ประเภทการลา — hr_admin เท่านั้น จึงไม่อยู่ในรายการนี้)
const UP_FIELDS = [
  { key:'can_access_hr',         label:'เข้าถึง HR Panel' },
  { key:'can_view_dashboard_hr', label:'Dashboard ภาพรวม' },
  { key:'can_view_hr_calendar',  label:'ปฏิทินการลา' },
  { key:'can_view_all_requests', label:'รายการลาทั้งหมด' },
  { key:'can_view_report',       label:'รายงาน' },
  { key:'can_export',            label:'Export' },
];

async function loadUserPerms() {
  const tbody = document.getElementById('up-tbody');
  tbody.innerHTML = '<tr><td colspan="9" class="empty">กำลังโหลด...</td></tr>';
  const data = await api('GET', '/hr/user-permissions');
  if (!Array.isArray(data)) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:#e53e3e;padding:16px;text-align:center">⚠️ โหลดข้อมูลไม่ได้: ${data?.error || 'ไม่ทราบสาเหตุ'}<br><button class="btn btn-sm btn-primary" onclick="loadUserPerms()" style="margin-top:8px">ลองใหม่</button></td></tr>`;
    return;
  }
  upAllData = data;
  filterUserPerms();
}

function filterUserPerms(resetPage) {
  if (resetPage) upPage = 1;
  const search = (document.getElementById('up-search')?.value || '').toLowerCase();
  const dept   = (document.getElementById('up-dept')?.value   || '').toLowerCase();
  const tbody  = document.getElementById('up-tbody');
  const filtered = upAllData.filter(u => {
    const matchS = !search || u.name.toLowerCase().includes(search) || (u.employee_id||'').toLowerCase().includes(search) || (u.department||'').toLowerCase().includes(search);
    const matchD = !dept || (u.department||'').toLowerCase().includes(dept);
    return matchS && matchD;
  });
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">ไม่พบข้อมูล</td></tr>';
    document.getElementById('up-pagination').innerHTML = '';
    return;
  }
  const totalPages = Math.ceil(filtered.length / UP_PAGE_SIZE);
  if (upPage > totalPages) upPage = totalPages;
  const pageData = filtered.slice((upPage - 1) * UP_PAGE_SIZE, upPage * UP_PAGE_SIZE);
  tbody.innerHTML = pageData.map((u, i) => {
    const tds = UP_FIELDS.map(f =>
      `<td style="text-align:center;padding:10px 8px"><label class="toggle"><input type="checkbox" ${u[f.key] ? 'checked' : ''}
        onchange="updateUserPerm(${u.id},'${f.key}',this.checked,this)"><span class="slider"></span></label></td>`
    ).join('');
    const roleLabel = ROLE_LABEL[u.role] || u.role;
    const roleColor = u.role==='hr_admin'?'#c6f6d5;color:#22543d':u.role==='employee'?'#e2e8f0;color:#4a5568':'#bee3f8;color:#2a4365';
    return `<tr style="transition:background .15s" onmouseover="this.style.background='#f0f7ff'" onmouseout="this.style.background=''">
      <td style="padding:10px 14px">
        <div style="font-weight:700;color:#1e3a5f;font-size:14px">${u.name}</div>
        <span style="font-size:11px;background:${roleColor};padding:2px 8px;border-radius:20px;font-weight:600">${roleLabel}</span>
      </td>
      <td style="font-family:monospace;font-size:13px;color:#4a5568;text-align:center;padding:10px 14px">${u.employee_id||''}</td>
      <td style="font-size:13px;color:#4a5568;padding:10px 14px">${u.department||''}</td>
      ${tds}
    </tr>`;
  }).join('');
  // pagination controls
  const pg = document.getElementById('up-pagination');
  if (totalPages <= 1) { pg.innerHTML = ''; return; }
  const btnStyle = (active) => `style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:${active?'#3182ce':'#fff'};color:${active?'#fff':'#2d3748'};cursor:${active?'default':'pointer'};font-size:13px"`;
  let html = `<button onclick="upGoPage(${upPage-1})" ${upPage===1?'disabled':''} style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:#fff;cursor:pointer;font-size:13px">‹</button>`;
  for (let p = 1; p <= totalPages; p++) {
    html += `<button onclick="upGoPage(${p})" ${btnStyle(p===upPage)}>${p}</button>`;
  }
  html += `<button onclick="upGoPage(${upPage+1})" ${upPage===totalPages?'disabled':''} style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:#fff;cursor:pointer;font-size:13px">›</button>`;
  html += `<span style="font-size:12px;color:#718096">แสดง ${(upPage-1)*UP_PAGE_SIZE+1}–${Math.min(upPage*UP_PAGE_SIZE,filtered.length)} จาก ${filtered.length} รายการ</span>`;
  pg.innerHTML = html;
}

function upGoPage(p) { upPage = p; filterUserPerms(); }

async function updateUserPerm(userId, field, value, checkbox) {
  const r = await api('PUT', `/hr/user-permissions/${userId}`, { [field]: value ? 1 : 0 });
  if (r.error) { swalError(r.error); checkbox.checked = !value; return; }
  // sync local data
  const row = upAllData.find(u => u.id === userId);
  if (row) row[field] = value ? 1 : 0;
  // if turning off can_access_hr, auto-turn off all sub-permissions in the data (UI still needs user to untoggle)
}

async function loadPermissions() {
  const data = await api('GET', '/hr/permissions');
  const tbody = document.getElementById('perm-tbody');
  if (!Array.isArray(data)) return;
  tbody.innerHTML = data.map(p => {
    const fields = ['can_view_all_requests','can_export','can_manage_employees','can_manage_leave_types','can_view_report'];
    const tds = fields.map(f => `<td style="text-align:center;padding:12px 10px">
      <label class="toggle"><input type="checkbox" ${p[f] ? 'checked' : ''} onchange="updatePerm('${p.role}','${f}',this.checked)"><span class="slider"></span></label>
    </td>`).join('');
    const isProtected = PROTECTED_ROLES.includes(p.role);
    const rlColor = p.role==='hr_admin'?'#c6f6d5;color:#22543d':p.role==='employee'?'#e2e8f0;color:#4a5568':'#bee3f8;color:#2a4365';
    const roleLabel = `<span style="background:${rlColor};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">${ROLE_LABEL[p.role]||p.role}</span>${isProtected ? ' <span style="font-size:10px;background:#e2e8f0;color:#718096;border-radius:4px;padding:1px 5px;margin-left:4px">ระบบ</span>' : ''}`;
    const editBtn = `<button class="btn btn-sm" style="background:#ebf4ff;color:#2b6cb0;margin-right:4px" onclick="editPermDesc('${p.role}','${(p.description||'').replace(/'/g,"\\'")}')">✏️</button>`;
    const delBtn = isProtected ? '' : `<button class="btn btn-danger btn-sm" onclick="deletePermRole('${p.role}')">🗑️</button>`;
    return `<tr style="transition:background .15s" onmouseover="this.style.background='#f0f7ff'" onmouseout="this.style.background=''">
      <td style="padding:12px 16px">${roleLabel}</td>
      ${tds}
      <td style="font-size:12px;color:#718096;max-width:180px;padding:12px 16px">${p.description||''}</td>
      <td style="white-space:nowrap;text-align:center;padding:12px 16px">${editBtn}${delBtn}</td>
    </tr>`;
  }).join('');
}

async function updatePerm(role, field, value) {
  const r = await api('PUT', `/hr/permissions/${role}`, { [field]: value ? 1 : 0 });
  if (r.error) swalError(r.error);
}

function editPermDesc(role, current) {
  Swal.fire({
    title: `แก้ไขบทบาท: ${ROLE_LABEL[role]||role}`,
    input: 'text',
    inputLabel: 'คำอธิบาย',
    inputValue: current,
    showCancelButton: true,
    confirmButtonText: 'บันทึก',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#1e3a5f',
  }).then(async result => {
    if (!result.isConfirmed) return;
    const r = await api('PUT', `/hr/permissions/${role}`, { description: result.value });
    if (r.error) return swalError(r.error);
    swalSuccess('บันทึกคำอธิบายสำเร็จ', () => loadPermissions());
  });
}

async function addPermRole() {
  const role = document.getElementById('perm-new-role').value.trim();
  const desc = document.getElementById('perm-new-desc').value.trim();
  if (!role) return swalError('กรุณาระบุชื่อบทบาท');
  const r = await api('POST', '/hr/permissions', { role, description: desc });
  if (r.error) return swalError(r.error);
  document.getElementById('perm-new-role').value = '';
  document.getElementById('perm-new-desc').value = '';
  swalSuccess(r.message, () => loadPermissions());
}

async function deletePermRole(role) {
  swalConfirm(`ยืนยันการลบบทบาท "${role}"?`, async () => {
    const r = await api('DELETE', `/hr/permissions/${role}`);
    if (r.error) return swalError(r.error);
    swalSuccess(r.message, () => loadPermissions());
  });
}

// ====== DEPT APPROVERS ======
async function loadApproverCandidates() {
  const level = document.getElementById('da-level').value || '2';
  const candidates = await api('GET', `/hr/approver-candidates?level=${level}`);
  const sel = document.getElementById('da-approver');
  sel.innerHTML = Array.isArray(candidates) ? candidates.map(c => `<option value="${c.id}">${c.name} (${ROLE_LABEL[c.role]||c.role}) — ${c.department}</option>`).join('') : '';
}

async function loadDeptApprovers() {
  const data = await api('GET', '/hr/dept-approvers');
  await loadApproverCandidates();

  // populate department dropdown
  const daDept = document.getElementById('da-dept');
  if (daDept) {
    const depts = data.departments || [];
    const curVal = daDept.value;
    daDept.innerHTML = '<option value="">— เลือกแผนก —</option>' + depts.map(d => `<option value="${d}"${d===curVal?' selected':''}>${d}</option>`).join('');
  }

  if (!data || data.error) return;
  const tbody = document.getElementById('da-tbody');
  const rows = data.approvers || [];

  // group by department + approver_user_id
  const grouped = {};
  rows.forEach(r => {
    const key = `${r.department}||${r.approver_user_id}`;
    if (!grouped[key]) grouped[key] = { ...r, levels: [] };
    grouped[key].levels.push({ level: r.level, id: r.id });
  });

  const levelBadge = (lv) => {
    const display = Math.min(lv, 2); // level 3+ ถือเป็นระดับ 2
    const bg = display === 1 ? '#3182ce' : '#e53e3e';
    return `<span style="display:inline-block;background:${bg};color:#fff;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600">ระดับ ${display}</span>`;
  };

  const entries = Object.values(grouped);
  tbody.innerHTML = entries.length ? entries.map(r => {
    const levelsSorted = r.levels.sort((a,b) => a.level - b.level);
    const badges = levelsSorted.map(l => levelBadge(l.level)).join(' ');
    const actionBtns = levelsSorted.map(l =>
      `<button class="btn btn-sm" style="background:#ebf4ff;color:#2b6cb0;margin-right:4px" onclick="editDeptApprover(${l.id},'${r.department}',${l.level},${r.approver_user_id})">✏️</button>` +
      `<button class="btn btn-danger btn-sm" onclick="deleteDeptApprover(${l.id})">🗑️</button>`
    ).join(' ');
    const roleColor = r.approver_role==='hr_admin'?'#c6f6d5;color:#22543d':r.approver_role==='employee'?'#e2e8f0;color:#4a5568':'#bee3f8;color:#2a4365';
    return `<tr style="transition:background .15s" onmouseover="this.style.background='#f0f7ff'" onmouseout="this.style.background=''">
      <td style="padding:12px 16px;font-weight:700;color:#1e3a5f">${r.department}</td>
      <td style="text-align:center;padding:12px 14px">${badges}</td>
      <td style="padding:12px 16px;font-weight:600">${r.approver_name}</td>
      <td style="font-family:monospace;font-size:13px;text-align:center;padding:12px 14px;color:#4a5568">${r.approver_emp_id}</td>
      <td style="padding:12px 14px"><span style="background:${roleColor};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">${ROLE_LABEL[r.approver_role]||r.approver_role}</span></td>
      <td style="white-space:nowrap;text-align:center;padding:12px 14px">${actionBtns}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">ยังไม่มีการกำหนดผู้อนุมัติ</td></tr>';
}

async function saveDeptApprover() {
  clearAlert('da-alert');
  const body = {
    department:       document.getElementById('da-dept').value.trim(),
    level:            parseInt(document.getElementById('da-level').value),
    approver_user_id: parseInt(document.getElementById('da-approver').value),
  };
  if (!body.department) return swalError('กรุณาระบุชื่อแผนก');
  const r = await api('PUT', '/hr/dept-approvers', body);
  if (r.error) return swalError(r.error);
  swalSuccess(r.message, () => loadDeptApprovers());
}

let _daEditId = null;

let _daEditCurrentUserId = null;

async function editDeptApprover(recordId, department, level, currentApproverUserId) {
  _daEditId = recordId;
  _daEditCurrentUserId = currentApproverUserId;

  // โหลด departments สำหรับ dropdown แผนก
  const data = await api('GET', '/hr/dept-approvers');
  const depts = data.departments || [];
  const deptSel = document.getElementById('da-edit-dept');
  deptSel.innerHTML = depts.map(d => `<option value="${d}" ${d === department ? 'selected' : ''}>${d}</option>`).join('');
  if (!depts.includes(department)) deptSel.innerHTML += `<option value="${department}" selected>${department}</option>`;

  document.getElementById('da-edit-level').value = level;
  await reloadDaEditCandidates(currentApproverUserId);
  document.getElementById('da-edit-modal').style.display = 'flex';
}

async function reloadDaEditCandidates(preselectUserId) {
  const level = document.getElementById('da-edit-level').value;
  const userId = preselectUserId ?? _daEditCurrentUserId;
  const candidates = await api('GET', `/hr/approver-candidates?level=${level}`);
  const sel = document.getElementById('da-edit-approver');
  sel.innerHTML = Array.isArray(candidates)
    ? candidates.map(c => `<option value="${c.id}" ${c.id === userId ? 'selected' : ''}>${c.name} (${ROLE_LABEL[c.role]||c.role}) — ${c.department}</option>`).join('')
    : '';
}

function closeDaEditModal() {
  document.getElementById('da-edit-modal').style.display = 'none';
  _daEditId = null;
  _daEditCurrentUserId = null;
}

async function updateDeptApprover() {
  if (!_daEditId) return;
  const approver_user_id = parseInt(document.getElementById('da-edit-approver').value);
  const level = parseInt(document.getElementById('da-edit-level').value);
  const department = document.getElementById('da-edit-dept').value;
  const r = await api('PUT', `/hr/dept-approvers/${_daEditId}`, { approver_user_id, level, department });
  if (r.error) return swalError(r.error);
  closeDaEditModal();
  swalSuccess(r.message || 'อัปเดตสำเร็จ', () => loadDeptApprovers());
}

async function deleteDeptApprover(id) {
  swalConfirm('ยืนยันการลบผู้อนุมัตินี้?', async () => {
    const r = await api('DELETE', `/hr/dept-approvers/${id}`);
    if (r.error) return swalError(r.error);
    swalSuccess('ลบผู้อนุมัติสำเร็จ', () => loadDeptApprovers());
  });
}

// ====== LEAVE TYPES HR ======
const INP_BASE = 'border:1.5px solid #e2e8f0;border-radius:8px;padding:6px 8px;font-size:13px;transition:.15s;text-align:center;';
const INP = function(style){ return INP_BASE + (style||''); };
function ltFocus(el){ el.style.borderColor='#4299e1'; }
function ltBlur(el) { el.style.borderColor='#e2e8f0'; }

async function loadLeaveTypesHr() {
  var data = await api('GET', '/hr/leave-types');
  var tbody = document.getElementById('lt-tbody');
  if (!Array.isArray(data)) return;
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var lt = data[i];
    var id = lt.id;
    var overDays = lt.requires_doc_over_days || 0;
    var advDays  = (lt.advance_days  != null) ? lt.advance_days  : 0;
    var backDays = (lt.backdate_days != null) ? lt.backdate_days : 0;
    var code = lt.code || '';
    var name = (lt.name || '').replace(/"/g, '&quot;');
    var stBase = INP_BASE;
    // col 1: รหัสลา
    var td1 = '<td style="text-align:center;padding:10px 14px">'
      + '<input type="text" id="ltcode-' + id + '" value="' + code + '" min="0"'
      + ' style="' + stBase + 'width:72px;color:#2b6cb0;font-weight:700"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)"></td>';
    // col 2: ชื่อประเภทการลา
    var td2 = '<td style="padding:10px 16px">'
      + '<input id="ltname-' + id + '" value="' + name + '"'
      + ' style="border:1.5px solid #e2e8f0;border-radius:8px;padding:7px 10px;width:200px;font-size:14px;transition:.15s"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)"></td>';
    // col 3: ล่วงหน้า/วัน
    var advLabel = advDays === 0 ? 'ไม่จำกัด' : 'วัน';
    var td3 = '<td style="text-align:center;padding:10px 14px">'
      + '<div style="display:flex;align-items:center;justify-content:center;gap:4px">'
      + '<input type="number" id="ltadv-' + id + '" value="' + advDays + '" min="0"'
      + ' style="' + stBase + 'width:58px;color:#d97706;font-weight:700"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)">'
      + '<span style="font-size:11px;color:#92400e">' + advLabel + '</span>'
      + '</div></td>';
    // col 4: โควต้าวันลา/ปี
    var td4 = '<td style="text-align:center;padding:10px 14px">'
      + '<input type="number" id="ltdays-' + id + '" value="' + lt.max_days_per_year + '" min="0"'
      + ' style="' + stBase + 'width:72px;color:#1e3a5f;font-weight:700"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)"></td>';
    // col 5: ย้อนหลัง/วัน
    var backLabel = backDays === 0 ? 'ไม่อนุญาต' : 'วัน';
    var td5 = '<td style="text-align:center;padding:10px 14px">'
      + '<div style="display:flex;align-items:center;justify-content:center;gap:4px">'
      + '<input type="number" id="ltback-' + id + '" value="' + backDays + '" min="0"'
      + ' style="' + stBase + 'width:58px;color:#7c3aed;font-weight:700"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)">'
      + '<span style="font-size:11px;color:#5b21b6">' + backLabel + '</span>'
      + '</div></td>';
    // col 6: ต้องแนบเอกสาร
    var td6 = '<td style="text-align:center;padding:10px 14px">'
      + '<label class="toggle"><input type="checkbox" id="ltdoc-' + id + '" ' + (lt.requires_document ? 'checked' : '') + '><span class="slider"></span></label>'
      + '</td>';
    // col 7: ลาเกิน (วัน) แนบเอกสาร
    var overOpacity = overDays === 0 ? 'opacity:.4;pointer-events:none' : '';
    var td7 = '<td style="text-align:center;padding:10px 14px">'
      + '<div style="display:flex;align-items:center;justify-content:center;gap:6px">'
      + '<label class="toggle"><input type="checkbox" id="ltover-toggle-' + id + '" ' + (overDays > 0 ? 'checked' : '') + ' onchange="toggleOverDays(' + id + ')"><span class="slider"></span></label>'
      + '<input type="number" id="ltover-' + id + '" value="' + (overDays > 0 ? overDays : 3) + '" min="1"'
      + ' style="' + stBase + 'width:58px;' + overOpacity + '"'
      + ' onfocus="ltFocus(this)" onblur="ltBlur(this)">'
      + '<span style="font-size:12px;color:#718096">วัน</span>'
      + '</div></td>';
    // col 8: จัดการ
    var safeName = (lt.name || '').replace(/'/g, "\\'");
    var td8 = '<td style="text-align:center;padding:10px 14px;white-space:nowrap">'
      + '<button class="btn btn-sm" style="background:linear-gradient(135deg,#276749,#38a169);color:#fff;margin-right:6px;box-shadow:0 2px 6px rgba(56,161,105,.3)" onclick="updateLeaveType(' + id + ')">💾 บันทึก</button>'
      + '<button class="btn btn-danger btn-sm" onclick="deleteLeaveType(' + id + ',\'' + safeName + '\')">🗑️</button>'
      + '</td>';

    rows.push('<tr style="transition:background .15s" onmouseover="this.style.background=\'#f0f7ff\'" onmouseout="this.style.background=\'\'">'
      + td1 + td2 + td3 + td4 + td5 + td6 + td7 + td8 + '</tr>');
  }
  tbody.innerHTML = rows.join('');
}

function toggleOverDays(id) {
  const checked = document.getElementById(`ltover-toggle-${id}`).checked;
  const inp = document.getElementById(`ltover-${id}`);
  inp.style.opacity = checked ? '1' : '.4';
  inp.style.pointerEvents = checked ? '' : 'none';
}

async function saveLeaveType() {
  clearAlert('lt-alert');
  const overVal = parseInt(document.getElementById('lt-over-days').value) || 0;
  const r = await api('POST', '/hr/leave-types', {
    code: document.getElementById('lt-code').value.trim(),
    name: document.getElementById('lt-name').value.trim(),
    max_days_per_year: parseInt(document.getElementById('lt-days').value),
    requires_document: parseInt(document.getElementById('lt-doc').value),
    requires_doc_over_days: overVal > 0 ? overVal : 0,
    advance_days:  parseInt(document.getElementById('lt-advance-days').value) || 0,
    backdate_days: parseInt(document.getElementById('lt-backdate-days').value) || 0,
  });
  if (r.error) return swalError(r.error);
  swalSuccess(r.message, () => loadLeaveTypesHr());
  document.getElementById('lt-code').value = '';
  document.getElementById('lt-advance-days').value = '';
  document.getElementById('lt-backdate-days').value = '';
  document.getElementById('lt-name').value = '';
  document.getElementById('lt-days').value = '';
  document.getElementById('lt-over-days').value = '';
  loadLeaveTypesHr();
}

async function updateLeaveType(id) {
  const overEnabled = document.getElementById(`ltover-toggle-${id}`)?.checked;
  const overVal  = parseInt(document.getElementById(`ltover-${id}`)?.value) || 3;
  const advDays  = parseInt(document.getElementById(`ltadv-${id}`)?.value)  || 0;
  const backDays = parseInt(document.getElementById(`ltback-${id}`)?.value) || 0;
  const r = await api('PUT', `/hr/leave-types/${id}`, {
    code: document.getElementById(`ltcode-${id}`)?.value.trim() || '',
    name: document.getElementById(`ltname-${id}`).value.trim(),
    max_days_per_year: parseInt(document.getElementById(`ltdays-${id}`).value),
    requires_document: document.getElementById(`ltdoc-${id}`).checked ? 1 : 0,
    requires_doc_over_days: overEnabled ? overVal : 0,
    advance_days:  advDays,
    backdate_days: backDays,
  });
  if (r.error) return swalError(r.error);
  swalSuccess(r.message, () => loadLeaveTypesHr());
}

async function deleteLeaveType(id, name) {
  swalConfirm(`ยืนยันการลบประเภทการลา "${name}"?`, async () => {
    const r = await api('DELETE', `/hr/leave-types/${id}`);
    if (r.error) return swalError(r.error);
    swalSuccess('ลบประเภทการลาสำเร็จ', () => loadLeaveTypesHr());
  });
}

// ====== COMPANY HOLIDAYS ======
// cache name lookup: date→name
let _chNameCache = {};
async function loadCompanyHolidaysHr() {
  const selYear = document.getElementById('ch-year');
  if (!selYear) return;
  if (!selYear.options.length) {
    const curY = new Date().getFullYear();
    for (let y = curY - 1; y <= curY + 2; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = `ปี ${y + 543}`;
      if (y === curY) opt.selected = true;
      selYear.appendChild(opt);
    }
  }
  const year = selYear.value || new Date().getFullYear();
  const rows = await api('GET', `/hr/company-holidays?year=${year}`);
  const tbody = document.getElementById('ch-tbody');
  _chNameCache = {};
  if (!Array.isArray(rows) || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">ยังไม่มีวันหยุดประเพณีในปีนี้</td></tr>';
    return;
  }
  rows.forEach(r => { _chNameCache[r.date] = r.name; });
  const THAI_MON_SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  tbody.innerHTML = rows.map(r => {
    const d = new Date(r.date + 'T12:00:00');
    const thaiDate = `${d.getDate()} ${THAI_MON_SHORT[d.getMonth()]} ${d.getFullYear()+543}`;
    return `<tr>
      <td><b>${thaiDate}</b></td>
      <td>${THAI_DOW[d.getDay()]}</td>
      <td><span style="background:#fed7d7;color:#742a2a;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700">🎌 ${r.name}</span></td>
      <td style="text-align:center"><button class="btn btn-sm btn-danger" onclick="deleteCompanyHoliday(${r.id},'${r.name}')">ลบ</button></td>
    </tr>`;
  }).join('');
}

async function addCompanyHoliday() {
  const date = document.getElementById('ch-date').value;
  const name = document.getElementById('ch-name').value.trim();
  if (!date) return swalError('กรุณาเลือกวันที่');
  if (!name) return swalError('กรุณาระบุชื่อวันหยุด');
  const r = await api('POST', '/hr/company-holidays', { date, name });
  if (r.error) return swalError(r.error);
  swalSuccess('บันทึกสำเร็จ', async () => {
    document.getElementById('ch-date').value = '';
    document.getElementById('ch-name').value = '';
    companyHolidaysCache = {};
    await loadCompanyHolidaysCache(new Date().getFullYear());
    loadCompanyHolidaysHr();
  });
}

async function deleteCompanyHoliday(id, name) {
  swalConfirm(`ยืนยันการลบวันหยุด "${name}"?`, async () => {
    const r = await api('DELETE', `/hr/company-holidays/${id}`);
    if (r.error) return swalError(r.error);
    swalSuccess('ลบสำเร็จ', async () => {
      companyHolidaysCache = {};
      await loadCompanyHolidaysCache(new Date().getFullYear());
      loadCompanyHolidaysHr();
    });
  });
}

async function downloadChTemplate() {
  const resp = await fetch('/api/hr/company-holidays/template', { headers: { 'Authorization': 'Bearer ' + token } });
  if (!resp.ok) return swalError('ดาวน์โหลดไม่สำเร็จ');
  const blob = await resp.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'holiday_template.xlsx'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function previewChImport() {
  const file = document.getElementById('ch-import-file').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const dataRows = rows.slice(1).filter(r => r[0] && r[1]);
      document.getElementById('ch-import-count').textContent = dataRows.length;
      document.getElementById('ch-import-tbody').innerHTML = dataRows.map((r, i) => {
        let dateVal = r[0] instanceof Date
          ? `${r[0].getFullYear()}-${String(r[0].getMonth()+1).padStart(2,'0')}-${String(r[0].getDate()).padStart(2,'0')}`
          : String(r[0]);
        return `<tr><td>${i+1}</td><td>${dateVal}</td><td>${r[1]}</td></tr>`;
      }).join('') || '<tr><td colspan="3" class="empty">ไม่พบข้อมูล</td></tr>';
      document.getElementById('ch-import-preview').style.display = dataRows.length ? '' : 'none';
    } catch(e) { swalError('อ่านไฟล์ไม่ได้: ' + e.message); }
  };
  reader.readAsArrayBuffer(file);
}

async function doChImport() {
  const file = document.getElementById('ch-import-file').files[0];
  if (!file) return;
  const btn = document.getElementById('btn-do-ch-import');
  btn.disabled = true; btn.textContent = '⏳ กำลังนำเข้า...';
  const fd = new FormData(); fd.append('file', file);
  const resp = await fetch('/api/hr/company-holidays/import', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd });
  const r = await resp.json();
  btn.textContent = '✅ นำเข้าข้อมูล'; btn.disabled = false;
  if (r.failed === 0) {
    swalSuccess(r.message, async () => { clearChImport(); companyHolidaysCache = {}; await loadCompanyHolidaysCache(new Date().getFullYear()); loadCompanyHolidaysHr(); });
  } else {
    const errText = r.errors && r.errors.length ? '\n• ' + r.errors.join('\n• ') : '';
    Swal.fire({ icon: r.success > 0 ? 'warning' : 'error', title: r.success > 0 ? 'นำเข้าบางส่วนสำเร็จ' : 'นำเข้าไม่สำเร็จ', text: r.message + errText, confirmButtonColor: '#1e3a5f' })
      .then(async () => { if (r.success > 0) { clearChImport(); companyHolidaysCache = {}; await loadCompanyHolidaysCache(new Date().getFullYear()); loadCompanyHolidaysHr(); }});
  }
}

function clearChImport() {
  const f = document.getElementById('ch-import-file');
  if (f) f.value = '';
  document.getElementById('ch-import-preview').style.display = 'none';
}

// ====== WORK SCHEDULE ======
const THAI_DOW = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];

async function loadWorkScheduleHr() {
  const selYear = document.getElementById('ws-year');
  if (!selYear) return;
  // ป้อนตัวเลือกปี ถ้ายังไม่มี
  if (!selYear.options.length) {
    const curY = new Date().getFullYear();
    for (let y = curY - 1; y <= curY + 2; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = `ปี ${y + 543}`;
      if (y === curY) opt.selected = true;
      selYear.appendChild(opt);
    }
  }
  const year = selYear.value || new Date().getFullYear();
  const rows = await api('GET', `/hr/work-schedule?year=${year}`);
  const tbody = document.getElementById('ws-tbody');
  if (!Array.isArray(rows) || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">ยังไม่มีรายการวันพิเศษในปีนี้</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const d = new Date(r.date + 'T12:00:00');
    const thaiDate = `${d.getDate()} ${['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'][d.getMonth()]} ${d.getFullYear()+543}`;
    const typeLabel = r.type === 'working_sat'
      ? '<span style="background:#c6f6d5;color:#22543d;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700">✅ เสาร์ทำงาน</span>'
      : '<span style="background:#fed7d7;color:#742a2a;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700">🔴 เสาร์หยุด</span>';
    return `<tr>
      <td><b>${thaiDate}</b></td>
      <td>${THAI_DOW[d.getDay()]}</td>
      <td>${typeLabel}</td>
      <td style="font-size:13px;color:#718096">${r.note || '—'}</td>
      <td style="text-align:center"><button class="btn btn-sm btn-danger" onclick="deleteWorkSchedule(${r.id},'${r.date}')">ลบ</button></td>
    </tr>`;
  }).join('');
}

async function addWorkSchedule() {
  const date = document.getElementById('ws-date').value;
  const type = document.getElementById('ws-type').value;
  const note = document.getElementById('ws-note').value.trim();
  if (!date) return swalError('กรุณาเลือกวันที่');
  const d = new Date(date + 'T12:00:00');
  if (d.getDay() !== 6) return swalError('กำหนดได้เฉพาะวันเสาร์เท่านั้น');
  const r = await api('POST', '/hr/work-schedule', { date, type, note });
  if (r.error) return swalError(r.error);
  swalSuccess('บันทึกสำเร็จ', async () => {
    document.getElementById('ws-date').value = '';
    document.getElementById('ws-note').value = '';
    await loadWorkScheduleHr();
    // reload cache
    workScheduleCache = {};
    await loadWorkScheduleCache(new Date().getFullYear());
  });
}

async function deleteWorkSchedule(id, date) {
  swalConfirm(`ยืนยันการลบวันพิเศษ ${date}?`, async () => {
    const r = await api('DELETE', `/hr/work-schedule/${id}`);
    if (r.error) return swalError(r.error);
    swalSuccess('ลบสำเร็จ', async () => {
      await loadWorkScheduleHr();
      workScheduleCache = {};
      await loadWorkScheduleCache(new Date().getFullYear());
    });
  });
}

// ====== EXPORT ======
function exportFile(type) {
  const year = document.getElementById('rpt-year').value || new Date().getFullYear();
  const dept = document.getElementById('rpt-dept').value.trim();
  let url = `/api/export/${type}?year=${year}`;
  if (dept) url += `&department=${encodeURIComponent(dept)}`;

  const headers = { 'Authorization': 'Bearer ' + token };
  if (type === 'pdf') {
    // เปิดหน้า PDF ใน tab ใหม่
    fetch(url, { headers }).then(r => r.text()).then(html => {
      const w = window.open('', '_blank');
      w.document.open(); w.document.write(html); w.document.close();
    });
  } else {
    // ดาวน์โหลด binary
    fetch(url, { headers }).then(r => {
      if (!r.ok) { r.json().then(j => swalError(j.message || 'Export ไม่สำเร็จ')); return; }
      const ext = type === 'xlsm' ? 'xlsm' : 'xlsx';
      const mime = type === 'xlsm'
        ? 'application/vnd.ms-excel.sheet.macroEnabled.12'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      return r.blob().then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([blob], { type: mime }));
        a.download = `leave-report-${year}.${ext}`;
        a.click();
      });
    });
  }
}

// ====== CALENDAR ======
const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const DAYS_SHORT  = ['อา','จ','อ','พ','พฤ','ศ','ส'];

let calMyCur = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
let calAllCur = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };

function calMyMove(d)  { calMyCur  = moveMonth(calMyCur, d);  loadCalMy(); }
function calAllMove(d) { calAllCur = moveMonth(calAllCur, d); loadCalAll(); }
function calMyGoToday()  { calMyCur  = { year: new Date().getFullYear(), month: new Date().getMonth()+1 }; loadCalMy(); }
function calAllGoToday() { calAllCur = { year: new Date().getFullYear(), month: new Date().getMonth()+1 }; loadCalAll(); }

function moveMonth({ year, month }, delta) {
  month += delta;
  if (month > 12) { month = 1; year++; }
  if (month < 1)  { month = 12; year--; }
  return { year, month };
}

async function loadCalMy() {
  const { year, month } = calMyCur;
  document.getElementById('cal-my-title').textContent = `${THAI_MONTHS[month-1]} ${year + 543}`;
  await Promise.all([loadWorkScheduleCache(year), loadCompanyHolidaysCache(year)]);
  const events = await api('GET', `/leave/calendar?year=${year}&month=${month}`);
  renderCalendar('cal-my-head', 'cal-my-body', year, month, Array.isArray(events) ? events : [], true);
}

async function loadCalAll() {
  const { year, month } = calAllCur;
  document.getElementById('cal-all-title').textContent = `${THAI_MONTHS[month-1]} ${year + 543}`;
  await Promise.all([loadWorkScheduleCache(year), loadCompanyHolidaysCache(year)]);
  const events = await api('GET', `/leave/calendar?year=${year}&month=${month}`);
  renderCalendar('cal-all-head', 'cal-all-body', year, month, Array.isArray(events) ? events : [], false);
}

function renderCalendar(headId, bodyId, year, month, events, myOnly) {
  // header
  const head = document.getElementById(headId);
  head.innerHTML = DAYS_SHORT.map(d => `<div class="cal-head">${d}</div>`).join('');

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const prevDays = new Date(year, month - 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // map events to dates
  const eventMap = {};
  events.forEach(ev => {
    const s = new Date(ev.start_date), e = new Date(ev.end_date);
    for (let d = new Date(s); d <= e; d.setDate(d.getDate()+1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!eventMap[key]) eventMap[key] = [];
      eventMap[key].push(ev);
    }
  });

  const body = document.getElementById(bodyId);
  let cells = '';
  // prev month
  for (let i = firstDay - 1; i >= 0; i--) {
    cells += `<div class="cal-day other-month"><div class="cal-day-num">${prevDays - i}</div></div>`;
  }
  // current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === todayStr;
    const dayEvents = eventMap[dateStr] || [];
    const dow = new Date(year, month-1, d).getDay();
    const isSunDay = dow === 0;
    const isSatDay = dow === 6;
    const isHoliday = isCompanyHoliday(dateStr);

    // กำหนด class และ badge ตามลำดับความสำคัญ: หยุดประเพณี > อาทิตย์ > เสาร์ทำงาน/หยุด
    let dayClass = '', dayBadge = '';
    if (isHoliday) {
      dayClass = ' company-holiday';
      // badge จะแสดงผ่าน holidayRow ด้านล่าง
    } else if (isSunDay) {
      dayClass = ' sun-day';
    } else if (isSatDay) {
      const ws = workScheduleCache[dateStr];
      if (ws === 'working_sat') {
        dayClass = ' sat-work';
        dayBadge = `<span style="font-size:9px;background:#276749;color:#fff;border-radius:4px;padding:1px 5px;margin-left:4px">✅ ทำงาน</span>`;
      } else if (ws === 'holiday_sat') {
        dayClass = ' sat-off';
        dayBadge = `<span style="font-size:9px;background:#c05621;color:#fff;border-radius:4px;padding:1px 5px;margin-left:4px">🟠 หยุด</span>`;
      } else {
        const dObj = new Date(year, month-1, d);
        if (isWorkingSaturday(dObj)) {
          dayClass = ' sat-work';
          dayBadge = `<span style="font-size:9px;background:#276749;color:#fff;border-radius:4px;padding:1px 5px;margin-left:4px">✅ ทำงาน</span>`;
        } else {
          dayClass = ' sat-off';
          dayBadge = `<span style="font-size:9px;background:#c05621;color:#fff;border-radius:4px;padding:1px 5px;margin-left:4px">🟠 หยุด</span>`;
        }
      }
    }

    const holidayRow = isHoliday
      ? `<div style="font-size:10px;background:#e53e3e;color:#fff;border-radius:4px;padding:2px 5px;margin-bottom:2px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🎌 ${companyHolidayName(dateStr)}</div>`
      : '';
    const evHtml = dayEvents.map(ev => {
      const isMine = ev.employee_id === (user && user.id) || String(ev.employee_id) === String(user && user.id);
      const isPending = ['pending','approved_l1'].includes(ev.status);
      const cls = isPending ? 'ev-pending' : isMine ? 'ev-mine' : 'ev-other';
      const label = myOnly ? ev.leave_type_name : ev.employee_name;
      const tipColor = isPending ? '#f59e0b' : isMine ? '#1565c0' : '#22c55e';
      return `<div class="cal-event ${cls}" onmouseenter="showTooltip(event,${JSON.stringify(JSON.stringify(ev))},'${tipColor}')" onmouseleave="hideTooltip()">${label}</div>`;
    }).join('');
    cells += `<div class="cal-day${isToday?' today':''}${dayClass}"><div class="cal-day-num">${d}${dayBadge}</div>${holidayRow}${evHtml}</div>`;
  }
  // next month fill
  const total = firstDay + daysInMonth;
  const remain = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let d = 1; d <= remain; d++) {
    cells += `<div class="cal-day other-month"><div class="cal-day-num">${d}</div></div>`;
  }
  body.innerHTML = cells;
}

function showTooltip(e, evJson, tipColor) {
  const ev = JSON.parse(evJson);
  const tip = document.getElementById('tooltip');
  const STATUS_MAP = {
    pending:     { label:'⏳ รอตรวจสอบ',    bg:'#fef9c3', color:'#78350f' },
    approved_l1: { label:'🔄 รอระดับอนุมัติ', bg:'#dbeafe', color:'#1e3a8a' },
    approved:    { label:'✅ อนุมัติแล้ว',    bg:'#dcfce7', color:'#14532d' },
    rejected:    { label:'❌ ปฏิเสธ',         bg:'#fee2e2', color:'#7f1d1d' },
    cancelled:   { label:'🚫 ยกเลิก',         bg:'#f1f5f9', color:'#475569' },
  };
  const st = STATUS_MAP[ev.status] || { label: ev.status, bg:'#f1f5f9', color:'#475569' };
  const color = tipColor || '#1565c0';
  const daysText = ev.days < 1 ? `${Math.round((ev.hours||ev.days*8)*10)/10} ชม.` : `${ev.days} วัน`;
  tip.style.setProperty('--tip-color', color);
  tip.innerHTML = `
    <div class="tip-name">${ev.employee_name || ev.leave_type_name}</div>
    <div class="tip-row">📋 <span><b>${ev.leave_type_name || ''}</b></span></div>
    <div class="tip-row">📅 <span>${fmtDate(ev.start_date)}${ev.start_date !== ev.end_date ? ' – ' + fmtDate(ev.end_date) : ''}</span></div>
    <div class="tip-row">⏱️ <span><b>${daysText}</b></span></div>
    ${ev.department ? `<div class="tip-row">🏢 <span>${ev.department}${ev.unit ? ' / ' + ev.unit : ''}</span></div>` : ''}
    ${ev.reason ? `<div class="tip-row">💬 <span style="white-space:normal">${ev.reason.length>60?ev.reason.slice(0,60)+'…':ev.reason}</span></div>` : ''}
    <div><span class="tip-status" style="background:${st.bg};color:${st.color}">${st.label}</span></div>
  `;
  tip.style.display = 'block';
  // smart position — keep inside viewport
  const x = e.clientX + 16, y = e.clientY + 16;
  tip.style.left = (x + 270 > window.innerWidth ? e.clientX - 274 : x) + 'px';
  tip.style.top  = (y + 220 > window.innerHeight ? e.clientY - 224 : y) + 'px';
}
function hideTooltip() { document.getElementById('tooltip').style.display = 'none'; }
// PWA: Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// PWA: Install prompt (Android Chrome)
let deferredPrompt;

function detectOS() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'other';
}

function isStandaloneMode() {
  return window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
}

// จับ event ก่อน install prompt จาก Chrome/Android
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallBtn();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  const btn = document.getElementById('btn-install-pwa');
  if (btn) btn.style.display = 'none';
});

function showInstallBtn() {
  if (isStandaloneMode()) return; // ติดตั้งแล้ว ซ่อนปุ่ม
  const os = detectOS();
  if (os === 'ios' || os === 'android') {
    const btn = document.getElementById('btn-install-pwa');
    if (btn) btn.style.display = 'flex';
  }
}

// แสดงปุ่มทันทีที่โหลดบนมือถือ
window.addEventListener('DOMContentLoaded', showInstallBtn);

async function installPWA() {
  const os = detectOS();

  // Android: มี deferredPrompt → แสดง native install dialog
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredPrompt = null;
      const btn = document.getElementById('btn-install-pwa');
      if (btn) btn.style.display = 'none';
    }
    return;
  }

  // iOS → คำแนะนำ Safari
  if (os === 'ios') {
    Swal.fire({
      icon: 'info',
      title: '📲 ติดตั้งบน iPhone/iPad',
      html: `<div style="text-align:left;line-height:2;font-size:14px">
        1. เปิดใน <b>Safari</b> (ไม่ใช่ Chrome)<br>
        2. กดปุ่ม <b>แชร์ ⬆️</b> ที่แถบล่าง<br>
        3. เลือก <b>"เพิ่มไปที่หน้าจอโฮม"</b><br>
        4. กด <b>"เพิ่ม"</b> มุมขวาบน<br>
        <span style="color:#718096;font-size:12px">⚠️ ต้องใช้ Safari เท่านั้น</span>
      </div>`,
      confirmButtonColor: '#1e3a5f',
      confirmButtonText: 'เข้าใจแล้ว'
    });
    return;
  }

  // Android: ยังไม่มี deferredPrompt → คำแนะนำ manual
  if (os === 'android') {
    Swal.fire({
      icon: 'info',
      title: '📲 ติดตั้งบน Android',
      html: `<div style="text-align:left;line-height:2;font-size:14px">
        1. เปิดใน <b>Chrome</b><br>
        2. กดเมนู <b>⋮</b> มุมขวาบน<br>
        3. กด <b>"เพิ่มลงหน้าจอหลัก"</b> หรือ <b>"ติดตั้งแอป"</b><br>
        4. กด <b>"ติดตั้ง"</b><br>
        <span style="color:#718096;font-size:12px">💡 หรือรอให้ Chrome แสดง popup ติดตั้งอัตโนมัติ</span>
      </div>`,
      confirmButtonColor: '#1e3a5f',
      confirmButtonText: 'เข้าใจแล้ว'
    });
  }
}
