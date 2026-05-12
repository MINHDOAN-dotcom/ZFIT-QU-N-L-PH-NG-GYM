const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// SQL Server Configuration
const dbConfig = {
    user: 'your_sql_username',
    password: 'your_sql_password', 
    server: 'localhost',
    database: 'GymManagement'
};
    


// Connect to SQL Server
async function connectDB() {
    try {
        await sql.connect(dbConfig);
        console.log('Connected to SQL Server');
        await createTables();
    } catch (err) {
        console.error('Database connection failed:', err);
    }
}

// Create tables if not exist
async function createTables() {
    try {
        // Packages table
        await sql.query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Packages' AND xtype='U')
            CREATE TABLE Packages (
                id INT IDENTITY(1,1) PRIMARY KEY,
                name NVARCHAR(100) NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                duration INT NOT NULL,
                description NVARCHAR(255)
            )
        `);

        // Members table
        await sql.query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Members' AND xtype='U')
            CREATE TABLE Members (
                id INT IDENTITY(1,1) PRIMARY KEY,
                full_name NVARCHAR(100) NOT NULL,
                phone NVARCHAR(20) NOT NULL,
                email NVARCHAR(100),
                package_id INT FOREIGN KEY REFERENCES Packages(id),
                register_date DATE NOT NULL,
                expiry_date DATE NOT NULL,
                status NVARCHAR(20) DEFAULT 'Active',
                created_at DATETIME DEFAULT GETDATE()
            )
        `);

        // Workout history table
        await sql.query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='WorkoutHistory' AND xtype='U')
            CREATE TABLE WorkoutHistory (
                id INT IDENTITY(1,1) PRIMARY KEY,
                member_id INT FOREIGN KEY REFERENCES Members(id),
                workout_date DATE NOT NULL,
                workout_type NVARCHAR(100) NOT NULL,
                duration INT,
                calories_burned INT,
                notes NVARCHAR(255),
                created_at DATETIME DEFAULT GETDATE()
            )
        `);

        // Insert sample packages if empty
        const packageCheck = await sql.query`SELECT COUNT(*) as count FROM Packages`;
        if (packageCheck.recordset[0].count === 0) {
            await sql.query`
                INSERT INTO Packages (name, price, duration, description) VALUES
                ('Basic', 500000, 1, 'Gói cơ bản 1 tháng'),
                ('Standard', 1200000, 3, 'Gói tiêu chuẩn 3 tháng'),
                ('Premium', 2000000, 6, 'Gói cao cấp 6 tháng'),
                ('VIP', 3500000, 12, 'Gói VIP 12 tháng'
            `;
        }

        // Insert sample members if empty
        const memberCheck = await sql.query`SELECT COUNT(*) as count FROM Members`;
        if (memberCheck.recordset[0].count === 0) {
            await sql.query`
                INSERT INTO Members (full_name, phone, email, package_id, register_date, expiry_date) VALUES
                ('Nguyễn Văn A', '0901234567', 'nguyenvana@email.com', 1, '2024-01-15', '2024-02-15'),
                ('Trần Thị B', '0901234568', 'tranthib@email.com', 2, '2024-01-20', '2024-04-20'),
                ('Lê Văn C', '0901234569', 'levanc@email.com', 3, '2024-02-01', '2024-08-01')
            `;
        }

        console.log('Tables ready');
    } catch (err) {
        console.error('Error creating tables:', err);
    }
}

// ==================== API Endpoints ====================

// STATS
app.get('/api/stats', async (req, res) => {
    try {
        const totalMembers = await sql.query`SELECT COUNT(*) as count FROM Members`;
        const activeMembers = await sql.query`SELECT COUNT(*) as count FROM Members WHERE status = 'Active'`;
        const revenue = await sql.query`
            SELECT SUM(p.price) as total 
            FROM Members m 
            JOIN Packages p ON m.package_id = p.id 
            WHERE MONTH(m.register_date) = MONTH(GETDATE())
        `;
        const totalPackages = await sql.query`SELECT COUNT(*) as count FROM Packages`;
        
        res.json({
            totalMembers: totalMembers.recordset[0].count,
            activeMembers: activeMembers.recordset[0].count,
            revenue: revenue.recordset[0].total || 0,
            totalPackages: totalPackages.recordset[0].count
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// MEMBERS
app.get('/api/members', async (req, res) => {
    try {
        const search = req.query.search || '';
        const query = `
            SELECT m.*, p.name as package_name 
            FROM Members m
            LEFT JOIN Packages p ON m.package_id = p.id
            WHERE m.full_name LIKE '%${search}%' OR m.phone LIKE '%${search}%'
            ORDER BY m.id DESC
        `;
        const result = await sql.query(query);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/members', async (req, res) => {
    try {
        const { full_name, phone, email, package_id, register_date } = req.body;
        const packageResult = await sql.query`SELECT duration FROM Packages WHERE id = ${package_id}`;
        const duration = packageResult.recordset[0].duration;
        
        const expiry_date = new Date(register_date);
        expiry_date.setMonth(expiry_date.getMonth() + duration);
        
        await sql.query`
            INSERT INTO Members (full_name, phone, email, package_id, register_date, expiry_date)
            VALUES (${full_name}, ${phone}, ${email}, ${package_id}, ${register_date}, ${expiry_date.toISOString().split('T')[0]})
        `;
        res.status(201).json({ message: 'Member created' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/members/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        let query = 'UPDATE Members SET ';
        const keys = Object.keys(updates);
        const values = Object.values(updates);
        
        for (let i = 0; i < keys.length; i++) {
            query += `${keys[i]} = '${values[i]}'`;
            if (i < keys.length - 1) query += ', ';
        }
        query += ` WHERE id = ${id}`;
        
        await sql.query(query);
        res.json({ message: 'Member updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/members/:id', async (req, res) => {
    try {
        await sql.query`DELETE FROM Members WHERE id = ${req.params.id}`;
        res.json({ message: 'Member deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// WORKOUT HISTORY
app.get('/api/workouts/:memberId', async (req, res) => {
    try {
        const result = await sql.query`
            SELECT * FROM WorkoutHistory 
            WHERE member_id = ${req.params.memberId}
            ORDER BY workout_date DESC
        `;
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/workouts', async (req, res) => {
    try {
        const { member_id, workout_date, workout_type, duration, calories_burned, notes } = req.body;
        await sql.query`
            INSERT INTO WorkoutHistory (member_id, workout_date, workout_type, duration, calories_burned, notes)
            VALUES (${member_id}, ${workout_date}, ${workout_type}, ${duration}, ${calories_burned}, ${notes})
        `;
        res.status(201).json({ message: 'Workout logged' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/workouts/date/:date', async (req, res) => {
    try {
        const result = await sql.query`
            SELECT wh.*, m.full_name, m.phone 
            FROM WorkoutHistory wh
            JOIN Members m ON wh.member_id = m.id
            WHERE wh.workout_date = ${req.params.date}
            ORDER BY wh.created_at DESC
        `;
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PACKAGES
app.get('/api/packages', async (req, res) => {
    try {
        const result = await sql.query`SELECT * FROM Packages ORDER BY id`;
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/packages', async (req, res) => {
    try {
        const { name, price, duration, description } = req.body;
        await sql.query`
            INSERT INTO Packages (name, price, duration, description)
            VALUES (${name}, ${price}, ${duration}, ${description})
        `;
        res.status(201).json({ message: 'Package created' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/packages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, duration, description } = req.body;
        await sql.query`
            UPDATE Packages 
            SET name = ${name}, price = ${price}, duration = ${duration}, description = ${description}
            WHERE id = ${id}
        `;
        res.json({ message: 'Package updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/packages/:id', async (req, res) => {
    try {
        await sql.query`DELETE FROM Packages WHERE id = ${req.params.id}`;
        res.json({ message: 'Package deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server
connectDB();
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});