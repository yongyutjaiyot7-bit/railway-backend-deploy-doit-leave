const express = require('express');
const path = require('path');
const { initDb } = require('./db/database');

async function main() {
  const db = await initDb();

  const app = express();
  app.use(express.json());
  // Service worker ต้องการ header Service-Worker-Allowed
  app.use('/sw.js', (req, res, next) => {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    next();
  });
  app.use(express.static(path.join(__dirname, '../public')));

  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api/leave', require('./routes/leave')(db));
  app.use('/api/export', require('./routes/export')(db));
  app.use('/api/hr', require('./routes/hr')(db));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
  });

  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => console.log(`Leave Request API running on ${HOST}:${PORT}`));
}

main().catch(err => { console.error(err); process.exit(1); });
