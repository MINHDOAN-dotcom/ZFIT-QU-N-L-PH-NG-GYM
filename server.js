const express = require('express');
const cors = require('cors');
const path = require('path');
const { sql, poolPromise, dbConnectionInfo } = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/ping', (req, res) => {
    res.json({ status: 'ok' });
});

/** Kiểm tra kết nối ZFitDB (dùng sau khi sửa .env / cài SQL Express) */
app.get('/api/db-health', async (req, res) => {
    const target = dbConnectionInfo();
    try {
        const pool = await poolPromise;
        const r = await pool.request().query(`
            SELECT DB_NAME() AS currentDb, SCHEMA_NAME() AS currentSchema
        `);
        const row = r.recordset[0] || {};
        res.json({
            ok: true,
            target,
            currentDb: row.currentDb,
            message: 'Kết nối database thành công.'
        });
    } catch (err) {
        res.status(503).json({
            ok: false,
            target,
            error: err.message,
            message: 'Không kết nối được SQL Server — xem lại .env và service SQL Browser / TCP.'
        });
    }
});

// STATS — map sang ZFitDB (Trainees, WorkoutPlans, WorkoutSessions, PTBookings)
app.get('/api/stats', async (req, res) => {
    try {
        const pool = await poolPromise;
        const totalMembers = await pool.request().query('SELECT COUNT(*) AS count FROM Trainees');
        const activeMembers = await pool.request().query(`
            SELECT COUNT(DISTINCT t.TraineeID) AS count
            FROM Trainees t
            WHERE EXISTS (
                SELECT 1 FROM WorkoutSessions ws
                WHERE ws.TraineeID = t.TraineeID
                  AND ws.SessionDate >= DATEADD(DAY, -90, GETDATE())
            )
            OR EXISTS (
                SELECT 1 FROM PTBookings pb
                WHERE pb.TraineeID = t.TraineeID AND pb.Status IN ('Pending', 'Active')
            )
        `);
        const revenue = await pool.request().query(`
            SELECT ISNULL(SUM(wp.Price), 0) AS total
            FROM WorkoutSessions ws
            INNER JOIN WorkoutPlans wp ON ws.PlanID = wp.PlanID
            WHERE MONTH(ws.SessionDate) = MONTH(GETDATE())
              AND YEAR(ws.SessionDate) = YEAR(GETDATE())
        `);
        const totalPackages = await pool.request().query('SELECT COUNT(*) AS count FROM WorkoutPlans');

        res.json({
            totalMembers: totalMembers.recordset[0]?.count || 0,
            activeMembers: activeMembers.recordset[0]?.count || 0,
            revenue: revenue.recordset[0]?.total || 0,
            totalPackages: totalPackages.recordset[0]?.count || 0
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// MEMBERS — hiển thị Trainees + Users; gói tập = WorkoutPlans từ buổi gần nhất
app.get('/api/members', async (req, res) => {
    try {
        const search = `%${req.query.search || ''}%`;
        const pool = await poolPromise;
        const result = await pool.request()
            .input('search', sql.NVarChar, search)
            .query(`
                SELECT
                    t.TraineeID AS id,
                    u.FullName AS full_name,
                    u.Phone AS phone,
                    u.Email AS email,
                    wp.PlanID AS package_id,
                    wp.PlanName AS package_name,
                    CONVERT(VARCHAR(10), u.CreatedAt, 23) AS register_date,
                    CONVERT(VARCHAR(10), DATEADD(WEEK, ISNULL(wp.DurationWeeks, 4), u.CreatedAt), 23) AS expiry_date,
                    CASE
                        WHEN EXISTS (
                            SELECT 1 FROM WorkoutSessions ws
                            WHERE ws.TraineeID = t.TraineeID
                              AND ws.SessionDate >= DATEADD(DAY, -90, GETDATE())
                        )
                        OR EXISTS (
                            SELECT 1 FROM PTBookings pb
                            WHERE pb.TraineeID = t.TraineeID AND pb.Status IN ('Pending', 'Active')
                        )
                        THEN 'Active'
                        ELSE 'Inactive'
                    END AS status
                FROM Trainees t
                INNER JOIN Users u ON t.UserID = u.UserID
                OUTER APPLY (
                    SELECT TOP 1 PlanID
                    FROM WorkoutSessions ws
                    WHERE ws.TraineeID = t.TraineeID
                    ORDER BY ws.SessionDate DESC
                ) lastp
                LEFT JOIN WorkoutPlans wp ON wp.PlanID = lastp.PlanID
                WHERE u.FullName LIKE @search OR u.Phone LIKE @search
                ORDER BY t.TraineeID DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/members', async (req, res) => {
    try {
        const { full_name, phone, email, package_id, register_date } = req.body;
        const pool = await poolPromise;
        const planCheck = await pool.request()
            .input('package_id', sql.Int, package_id)
            .query('SELECT PlanID FROM WorkoutPlans WHERE PlanID = @package_id');

        if (!planCheck.recordset.length) {
            return res.status(400).json({ error: 'Package not found' });
        }

        const tx = new sql.Transaction(pool);
        await tx.begin();
        try {
            const rq1 = new sql.Request(tx);
            const uidR = await rq1
                .input('full_name', sql.NVarChar, full_name)
                .input('phone', sql.VarChar, phone)
                .input('email', sql.VarChar, email || `trainee_${Date.now()}@zfit.local`)
                .input('register_date', sql.Date, register_date)
                .query(`
                    INSERT INTO Users (FullName, Email, PasswordHash, Role, Phone, CreatedAt)
                    OUTPUT INSERTED.UserID AS UserID
                    VALUES (@full_name, @email, N'webapp', N'Trainee', @phone, @register_date)
                `);
            const userId = uidR.recordset[0].UserID;

            const rq2 = new sql.Request(tx);
            const tidR = await rq2
                .input('userId', sql.Int, userId)
                .query(`
                    INSERT INTO Trainees (UserID, Height, Weight, Goal, ExperienceLevel)
                    OUTPUT INSERTED.TraineeID AS TraineeID
                    VALUES (@userId, 170, 70, N'', N'Beginner')
                `);
            const traineeId = tidR.recordset[0].TraineeID;

            await new sql.Request(tx)
                .input('traineeId', sql.Int, traineeId)
                .input('package_id', sql.Int, package_id)
                .input('register_date', sql.Date, register_date)
                .query(`
                    INSERT INTO WorkoutSessions (TraineeID, PlanID, SessionDate, Duration, Notes)
                    VALUES (@traineeId, @package_id, @register_date, 0, N'Đăng ký gói')
                `);

            await tx.commit();
            res.status(201).json({ message: 'Member created' });
        } catch (e) {
            await tx.rollback();
            throw e;
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/members/:id', async (req, res) => {
    try {
        const traineeId = parseInt(req.params.id, 10);
        const { full_name, phone, email, package_id, register_date } = req.body;
        const pool = await poolPromise;

        const tq = await pool.request()
            .input('id', sql.Int, traineeId)
            .query(`
                SELECT t.UserID
                FROM Trainees t
                WHERE t.TraineeID = @id
            `);
        if (!tq.recordset.length) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const userId = tq.recordset[0].UserID;

        const rq = pool.request();
        rq.input('userId', sql.Int, userId);
        const sets = [];
        if (full_name !== undefined) {
            sets.push('FullName = @full_name');
            rq.input('full_name', sql.NVarChar, full_name);
        }
        if (phone !== undefined) {
            sets.push('Phone = @phone');
            rq.input('phone', sql.VarChar, phone);
        }
        if (email !== undefined) {
            sets.push('Email = @email');
            rq.input('email', sql.VarChar, email);
        }
        if (register_date !== undefined) {
            sets.push('CreatedAt = @register_date');
            rq.input('register_date', sql.Date, register_date);
        }
        if (sets.length) {
            await rq.query(`UPDATE Users SET ${sets.join(', ')} WHERE UserID = @userId`);
        }

        if (package_id != null) {
            const uws = await pool.request()
                .input('id', sql.Int, traineeId)
                .query(`
                    SELECT TOP 1 SessionID FROM WorkoutSessions
                    WHERE TraineeID = @id
                    ORDER BY SessionDate DESC
                `);
            if (uws.recordset.length) {
                await pool.request()
                    .input('sid', sql.Int, uws.recordset[0].SessionID)
                    .input('package_id', sql.Int, package_id)
                    .query('UPDATE WorkoutSessions SET PlanID = @package_id WHERE SessionID = @sid');
            } else {
                await pool.request()
                    .input('id', sql.Int, traineeId)
                    .input('package_id', sql.Int, package_id)
                    .input('register_date', sql.Date, register_date || new Date())
                    .query(`
                        INSERT INTO WorkoutSessions (TraineeID, PlanID, SessionDate, Duration, Notes)
                        VALUES (@id, @package_id, @register_date, 0, N'Cập nhật gói')
                    `);
            }
        }

        res.json({ message: 'Member updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/members/:id', async (req, res) => {
    try {
        const traineeId = parseInt(req.params.id, 10);
        const pool = await poolPromise;

        const uq = await pool.request()
            .input('id', sql.Int, traineeId)
            .query(`
                SELECT t.UserID FROM Trainees t WHERE t.TraineeID = @id
            `);
        if (!uq.recordset.length) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const userId = uq.recordset[0].UserID;

        const tx = new sql.Transaction(pool);
        await tx.begin();
        try {
            await new sql.Request(tx).input('id', sql.Int, traineeId).query(`
                DELETE sd FROM SessionDetails sd
                INNER JOIN WorkoutSessions ws ON sd.SessionID = ws.SessionID
                WHERE ws.TraineeID = @id
            `);
            await new sql.Request(tx).input('id', sql.Int, traineeId).query('DELETE FROM WorkoutSessions WHERE TraineeID = @id');
            await new sql.Request(tx).input('id', sql.Int, traineeId).query('DELETE FROM PTBookings WHERE TraineeID = @id');
            await new sql.Request(tx).input('id', sql.Int, traineeId).query('DELETE FROM ProgressTracking WHERE TraineeID = @id');
            await new sql.Request(tx).input('id', sql.Int, traineeId).query('DELETE FROM Trainees WHERE TraineeID = @id');
            await new sql.Request(tx).input('uid', sql.Int, userId).query(`
                DELETE FROM CommunityPosts WHERE UserID = @uid
            `);
            await new sql.Request(tx).input('uid', sql.Int, userId).query('DELETE FROM Users WHERE UserID = @uid');
            await tx.commit();
            res.json({ message: 'Member deleted' });
        } catch (e) {
            await tx.rollback();
            throw e;
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// WORKOUT HISTORY — WorkoutSessions + WorkoutPlans + Users
app.get('/api/workouts/:memberId', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('memberId', sql.Int, req.params.memberId)
            .query(`
                SELECT
                    ws.SessionID AS id,
                    CONVERT(VARCHAR(10), ws.SessionDate, 23) AS workout_date,
                    wp.PlanName AS workout_type,
                    ws.Duration AS duration,
                    NULL AS calories_burned,
                    ws.Notes AS notes,
                    ws.SessionDate AS created_at
                FROM WorkoutSessions ws
                INNER JOIN WorkoutPlans wp ON ws.PlanID = wp.PlanID
                WHERE ws.TraineeID = @memberId
                ORDER BY ws.SessionDate DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/workouts', async (req, res) => {
    try {
        const { member_id, workout_date, plan_id, duration, notes } = req.body;
        const pool = await poolPromise;
        const d = duration != null ? parseInt(duration, 10) : null;
        const dur = d && d > 0 ? d : 1;
        await pool.request()
            .input('member_id', sql.Int, member_id)
            .input('plan_id', sql.Int, plan_id)
            .input('workout_date', sql.DateTime, new Date(workout_date + 'T12:00:00'))
            .input('duration', sql.Int, dur)
            .input('notes', sql.NVarChar, notes || null)
            .query(`
                INSERT INTO WorkoutSessions (TraineeID, PlanID, SessionDate, Duration, Notes)
                VALUES (@member_id, @plan_id, @workout_date, @duration, @notes)
            `);
        res.status(201).json({ message: 'Workout logged' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/workouts/date/:date', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('date', sql.Date, req.params.date)
            .query(`
                SELECT
                    ws.SessionID AS id,
                    u.FullName AS full_name,
                    u.Phone AS phone,
                    wp.PlanName AS workout_type,
                    ws.Duration AS duration,
                    NULL AS calories_burned,
                    ws.Notes AS notes,
                    ws.SessionDate AS created_at
                FROM WorkoutSessions ws
                INNER JOIN Trainees t ON ws.TraineeID = t.TraineeID
                INNER JOIN Users u ON t.UserID = u.UserID
                INNER JOIN WorkoutPlans wp ON ws.PlanID = wp.PlanID
                WHERE CAST(ws.SessionDate AS DATE) = @date
                ORDER BY ws.SessionDate DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// PACKAGES — WorkoutPlans (cần PTID; lấy PT đầu tiên nếu không gửi)
app.get('/api/packages', async (req, res) => {
    try {
        const search = `%${req.query.search || ''}%`;
        const pool = await poolPromise;
        const result = await pool.request()
            .input('search', sql.NVarChar, search)
            .query(`
                SELECT
                    PlanID AS id,
                    PlanName AS name,
                    Price AS price,
                    DurationWeeks AS duration,
                    Description AS description
                FROM WorkoutPlans
                WHERE PlanName LIKE @search
                ORDER BY PlanID
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/packages', async (req, res) => {
    try {
        const { name, price, duration, description } = req.body;
        const pool = await poolPromise;
        const pt = await pool.request().query('SELECT TOP 1 PTID AS id FROM PersonalTrainers ORDER BY PTID');
        const ptId = pt.recordset[0]?.id;
        if (!ptId) {
            return res.status(400).json({ error: 'Chưa có PT trong database — chạy DataMau.sql trước.' });
        }
        await pool.request()
            .input('ptid', sql.Int, ptId)
            .input('name', sql.NVarChar, name)
            .input('price', sql.Decimal(10, 2), price)
            .input('duration', sql.Int, duration)
            .input('description', sql.NVarChar, description || null)
            .query(`
                INSERT INTO WorkoutPlans (PTID, PlanName, Description, Price, DurationWeeks)
                VALUES (@ptid, @name, @description, @price, @duration)
            `);
        res.status(201).json({ message: 'Package created' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/packages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, duration, description } = req.body;
        const pool = await poolPromise;
        await pool.request()
            .input('id', sql.Int, id)
            .input('name', sql.NVarChar, name)
            .input('price', sql.Decimal(10, 2), price)
            .input('duration', sql.Int, duration)
            .input('description', sql.NVarChar, description || null)
            .query(`
                UPDATE WorkoutPlans
                SET PlanName = @name, Price = @price, DurationWeeks = @duration, Description = @description
                WHERE PlanID = @id
            `);
        res.json({ message: 'Package updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/packages/:id', async (req, res) => {
    try {
        const pool = await poolPromise;
        const id = parseInt(req.params.id, 10);
        await pool.request().input('id', sql.Int, id).query(`
            DELETE sd FROM SessionDetails sd
            INNER JOIN WorkoutSessions ws ON sd.SessionID = ws.SessionID
            WHERE ws.PlanID = @id
        `);
        await pool.request().input('id', sql.Int, id).query('DELETE FROM WorkoutSessions WHERE PlanID = @id');
        await pool.request().input('id', sql.Int, id).query('DELETE FROM WorkoutPlans WHERE PlanID = @id');
        res.json({ message: 'Package deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Đồ án: đọc VIEW / gọi PROCEDURE (có thể gọi từ Postman hoặc mở rộng UI sau)
app.get('/api/views/workout-history', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT * FROM View_UserWorkoutHistory');
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/views/pt-bookings', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT * FROM View_PTBookingDetails');
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/views/progress', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT * FROM View_ProgressReport');
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proc/book-pt', async (req, res) => {
    try {
        const { trainee_id, pt_id } = req.body;
        const pool = await poolPromise;
        await pool.request()
            .input('TraineeID', sql.Int, trainee_id)
            .input('PTID', sql.Int, pt_id)
            .execute('BookPT');
        res.status(201).json({ message: 'BookPT executed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proc/community-post', async (req, res) => {
    try {
        const { user_id, content, image_url } = req.body;
        const pool = await poolPromise;
        await pool.request()
            .input('UserID', sql.Int, user_id)
            .input('Content', sql.NVarChar, content)
            .input('ImageURL', sql.VarChar, image_url || null)
            .execute('CreateCommunityPost');
        res.status(201).json({ message: 'CreateCommunityPost executed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

poolPromise
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('Không thể kết nối database khi khởi động server:', err);
        process.exit(1);
    });
