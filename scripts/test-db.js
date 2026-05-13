/**
 * Kiểm tra kết nối giống server.js.
 * Chạy: node scripts/test-db.js   hoặc   npm run test-db
 */
require('dotenv').config();
const { poolPromise, dbConnectionInfo } = require('../db');

const target = dbConnectionInfo();
console.log('Đang thử kết nối:', JSON.stringify(target, null, 2));

poolPromise
    .then((pool) =>
        pool.request().query(`
            SELECT DB_NAME() AS currentDb, COUNT(*) AS traineeCount FROM Trainees
        `)
    )
    .then((result) => {
        console.log('OK — SQL Server trả lời:', result.recordset[0]);
        process.exit(0);
    })
    .catch((err) => {
        console.error('Lỗi:', err.message);
        process.exit(1);
    });
