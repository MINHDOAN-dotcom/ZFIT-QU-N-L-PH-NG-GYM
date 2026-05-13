require('dotenv').config();

const useWindowsAuth =
    process.env.DB_USE_WINDOWS_AUTH === 'true' ||
    process.env.DB_USE_WINDOWS_AUTH === '1';

const sql = useWindowsAuth
    ? require('mssql/msnodesqlv8')
    : require('mssql');

// server: "localhost" + DB_INSTANCE, hoặc "localhost\\SQLEXPRESS" (không set instance trùng)
const rawServer = (process.env.DB_SERVER || 'localhost').trim();
const instanceFromEnv = (process.env.DB_INSTANCE || '').trim();
const server = rawServer;
const instanceName = rawServer.includes('\\') ? '' : instanceFromEnv;
const database = (process.env.DB_DATABASE || '').trim();
const dbPort = (process.env.DB_PORT || '').trim();
const port = dbPort ? parseInt(dbPort, 10) : undefined;
const hasPort = Number.isFinite(port) && port > 0;

// Có cổng TCP tĩnh → không gửi instanceName (tedious sẽ bỏ port nếu còn instanceName → hay timeout)
const effectiveInstanceName = hasPort ? '' : instanceName;

// mssql map: tedious connectTimeout = config.connectionTimeout (CẤP NGOÀI options, đơn vị ms)
const connectionTimeout = parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '60000', 10);
const requestTimeout = parseInt(process.env.DB_REQUEST_TIMEOUT_MS || '60000', 10);

if (!database) {
    console.error('Thiếu DB_DATABASE trong file .env (ví dụ: ZFitDB).');
}

const commonOptions = {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: true,
    enableArithAbort: true,
    ...(effectiveInstanceName ? { instanceName: effectiveInstanceName } : {}),
    ...(hasPort ? { port } : {})
};

const poolConfigBase = {
    server,
    database: database || undefined,
    connectionTimeout: Number.isFinite(connectionTimeout) ? connectionTimeout : 60000,
    requestTimeout: Number.isFinite(requestTimeout) ? requestTimeout : 60000,
    options: commonOptions,
    ...(useWindowsAuth ? { driver: 'msnodesqlv8' } : {})
};

const serverTarget = effectiveInstanceName ? `${server}\\${effectiveInstanceName}` : server;
const connectionString = `Driver={ODBC Driver 17 for SQL Server};Server=${serverTarget}${hasPort ? `,${port}` : ''};Database=${database};Trusted_Connection=Yes;Encrypt=${process.env.DB_ENCRYPT === 'true' ? 'Yes' : 'No'};TrustServerCertificate=Yes;`;

/** @type {import('mssql').config} */
const config = useWindowsAuth
    ? {
          connectionString,
          connectionTimeout: Number.isFinite(connectionTimeout) ? connectionTimeout : 60000,
          requestTimeout: Number.isFinite(requestTimeout) ? requestTimeout : 60000,
          driver: 'msnodesqlv8'
      }
    : {
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          ...poolConfigBase,
          options: {
              encrypt: false,
              trustServerCertificate: true,
              enableArithAbort: true,
              ...(effectiveInstanceName ? { instanceName: effectiveInstanceName } : {}),
              ...(hasPort ? { port } : {})
          }
      };

const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then((pool) => {
        const inst = effectiveInstanceName ? `\\${effectiveInstanceName}` : '';
        const portInfo = hasPort ? `:${port}` : '';
        const auth = useWindowsAuth ? 'Windows' : 'SQL';
        console.log(
            `Đã kết nối SQL Server: database=${database || '(chưa set)'} | server=${server}${inst}${portInfo} | ${auth}`
        );
        return pool;
    })
    .catch((err) => {
        console.log('Kết nối thất bại: ', err);
        if (String(err.message || '').includes('ETIMEOUT') || String(err.message || '').includes('15000')) {
            console.log(
                'Gợi ý: (1) Bật SQL Server Browser; (2) Hoặc trong SQL Server Configuration Manager → TCP/IP → IPAll lấy TCP Dynamic Ports / TCP Port, ghi vào .env: DB_PORT=... và comment DB_INSTANCE=...'
            );
        }
        throw err;
    });

module.exports = {
    sql,
    poolPromise,
    dbConnectionInfo: () => ({
        server: rawServer.includes('\\')
            ? rawServer
            : effectiveInstanceName
              ? `${rawServer}\\${effectiveInstanceName}`
              : hasPort
                ? `${rawServer}:${port}`
                : rawServer,
        serverHost: server,
        instanceName: effectiveInstanceName || null,
        port: hasPort ? port : null,
        database: database || null,
        useWindowsAuth
    })
};
