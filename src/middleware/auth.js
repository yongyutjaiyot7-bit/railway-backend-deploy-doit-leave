const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'leave-system-secret-2024';

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'ไม่มี token การยืนยันตัวตน' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Token ไม่ถูกต้องหรือหมดอายุ' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'ไม่มีสิทธิ์ดำเนินการนี้' });
    }
    next();
  };
}

// authorizeOrPerm — อนุญาตถ้า role ตรง หรือ มี permField ใน user_menu_permissions
function authorizeOrPerm(db, permField, ...roles) {
  return (req, res, next) => {
    if (roles.includes(req.user.role)) return next();
    try {
      const perm = db.prepare('SELECT * FROM user_menu_permissions WHERE user_id=?').get(req.user.id);
      if (perm && perm[permField]) return next();
    } catch(e) {}
    return res.status(403).json({ message: 'ไม่มีสิทธิ์ดำเนินการนี้' });
  };
}

module.exports = { authenticate, authorize, authorizeOrPerm, JWT_SECRET };
