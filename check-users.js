const bcrypt = require('bcryptjs');
const fs = require('fs');
const initSql = require('./node_modules/sql.js');

initSql().then(async SQL => {
  const buf = fs.readFileSync('./leave.db');
  const db = new SQL.Database(buf);

  const res = db.exec('SELECT id, employee_id, name, email, role FROM users');
  const users = res[0]?.values || [];
  users.forEach(r => console.log(
    'id:', r[0], '| emp:', r[1], '| name:', r[2], '| email:', r[3], '| role:', r[4]
  ));
});