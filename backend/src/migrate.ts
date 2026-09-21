import { connectDb, migrate } from './db.js';
const db = await connectDb();
try { await migrate(db); console.log('Database schema ready.'); } finally { await db.close(); }
