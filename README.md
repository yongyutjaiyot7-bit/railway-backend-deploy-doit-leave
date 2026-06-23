# ระบบลาออนไลน์ — Leave Request API

REST API สำหรับระบบลาออนไลน์ที่มีการอนุมัติ **3 ระดับ**

## การอนุมัติ 3 ระดับ

| ระดับ | บทบาท | ขอบเขต |
|-------|-------|--------|
| 1 | `unit_head` — หัวหน้าหน่วยงาน | อนุมัติพนักงานในหน่วยเดียวกัน |
| 2 | `department_head` — หัวหน้าแผนก / ผู้จัดการแผนก | อนุมัติเมื่อ level 1 ผ่านแล้ว |
| 3 | `division_manager` — ผู้จัดการฝ่ายขึ้นไป | อนุมัติขั้นสุดท้าย + หักวันลา |

`hr_admin` สามารถเห็นและอนุมัติทุกรายการในทุกหน่วยงาน

## สถานะคำขอลา

```
pending → approved_l1 → approved_l2 → approved
                     ↘ rejected (ได้จากทุกระดับ)
pending → cancelled  (พนักงานยกเลิกเอง)
```

## ติดตั้งและรัน

```bash
npm install
node src/db/seed.js   # สร้างข้อมูลตัวอย่าง
npm start             # port 3000
```

## API Endpoints

### Auth
| Method | Path | คำอธิบาย |
|--------|------|----------|
| POST | `/api/auth/register` | ลงทะเบียนผู้ใช้ |
| POST | `/api/auth/login` | เข้าสู่ระบบ (รับ JWT token) |

### Leave (ต้องแนบ `Authorization: Bearer <token>`)
| Method | Path | สิทธิ์ | คำอธิบาย |
|--------|------|--------|----------|
| GET | `/api/leave/types` | ทุกคน | ดูประเภทการลา |
| GET | `/api/leave/balance` | ทุกคน | ดูโควต้าวันลาของตนเอง |
| POST | `/api/leave/request` | ทุกคน | ยื่นคำขอลา |
| GET | `/api/leave/my-requests` | ทุกคน | ดูประวัติคำขอของตนเอง |
| DELETE | `/api/leave/request/:id` | ทุกคน | ยกเลิกคำขอลา (เฉพาะสถานะ pending) |
| GET | `/api/leave/pending` | ผู้อนุมัติ | ดูรายการรออนุมัติ |
| POST | `/api/leave/approve/:approvalId` | ผู้อนุมัติ | อนุมัติ/ปฏิเสธ |
| GET | `/api/leave/history` | ผู้อนุมัติ | ประวัติการอนุมัติของตนเอง |
| GET | `/api/leave/report` | division_manager, hr_admin | รายงาน |

## Body Examples

### POST /api/auth/register
```json
{
  "employee_id": "EMP001",
  "name": "สมชาย ใจดี",
  "email": "emp@company.com",
  "password": "password123",
  "role": "employee",
  "department": "บัญชี",
  "division": "การเงิน",
  "unit": "หน่วยบัญชี1"
}
```
Roles: `employee`, `unit_head`, `department_head`, `division_manager`, `hr_admin`

### POST /api/leave/request
```json
{
  "leave_type_id": 1,
  "start_date": "2026-07-01",
  "end_date": "2026-07-02",
  "reason": "ไม่สบาย"
}
```

### POST /api/leave/approve/:approvalId
```json
{
  "action": "approve",
  "comment": "อนุมัติ"
}
```
หรือ `"action": "reject"`

## ประเภทการลา (default)
1. ลาป่วย — 30 วัน/ปี
2. ลากิจ — 10 วัน/ปี
3. ลาพักร้อน — 10 วัน/ปี
4. ลาคลอด — 98 วัน/ปี
5. ลาบวช — 15 วัน/ปี
