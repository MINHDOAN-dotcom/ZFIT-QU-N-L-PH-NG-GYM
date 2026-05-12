const sql = require('mssql');
require('dotenv').config();

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: true, // Dùng cho Azure
        trustServerCertificate: true // Quan trọng khi chạy local
    }
};

const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log('Đã kết nối thành công với SQL Server!');
        return pool;
    })
    .catch(err => console.log('Kết nối thất bại: ', err));

module.exports = {
    sql, poolPromise
};