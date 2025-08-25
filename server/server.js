const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || 'P@ssw0rd',
  server: process.env.DB_SERVER || 'DESKTOP-04QBI17\\LOKESH',
  database: process.env.DB_NAME || 'AttendanceDB',
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .input('username', sql.NVarChar(50), username.trim())
      .input('password', sql.NVarChar(255), password)
      .query('SELECT Id FROM dbo.Users WHERE Username = @username AND Password = @password');

    if (result.recordset.length > 0) {
      res.status(200).json({
        message: 'Login successful',
        userId: result.recordset[0].Id,
        timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
      });
    } else {
      res.status(401).json({ error: 'Invalid username or password' });
    }
  } catch (err) {
    console.error('Database operation error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) pool.close();
  }
});

app.post('/api/check-in', async (req, res) => await handleAttendance(req, res, 'CheckIn'));
app.post('/api/check-out', async (req, res) => await handleAttendance(req, res, 'CheckOut'));

async function handleAttendance(req, res, type) {
  const { userId, latitude, longitude, timestamp } = req.body;

  if (!userId || !latitude || !longitude || !timestamp) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const date = new Date(timestamp);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    
    const result = await pool
      .request()
      .input('userId', sql.Int, userId)
      .input('latitude', sql.Float, latitude)
      .input('longitude', sql.Float, longitude)
      .input('timestamp', sql.DateTime, date)
      .input('type', sql.NVarChar(10), type)
      .query('INSERT INTO dbo.Attendance (UserId, Latitude, Longitude, Timestamp, Type) OUTPUT INSERTED.* VALUES (@userId, @latitude, @longitude, @timestamp, @type)');

    // If check-in on weekend, add to Compoff table
    if (isWeekend && type === 'CheckIn') {
      await pool
        .request()
        .input('userId', sql.Int, userId)
        .input('date', sql.Date, date)
        .input('reason', sql.NVarChar(255), `Worked on ${date.getDay() === 0 ? 'Sunday' : 'Saturday'}`)
        .query('INSERT INTO dbo.Compoff (UserId, Date, Reason) VALUES (@userId, @date, @reason)');
    }

    res.status(201).json({
      message: `${type} successful`,
      data: result.recordset[0],
      timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
    });
  } catch (err) {
    console.error('Database operation error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) pool.close();
  }
}

app.get('/api/attendance-overview/:userId', async (req, res) => {
  const { userId } = req.params;
  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .input('userId', sql.Int, userId)
      .query(`
        SELECT 
          (SELECT COUNT(DISTINCT CAST(Timestamp AS DATE)) FROM dbo.Attendance WHERE UserId = @userId AND CAST(Timestamp AS DATE) = CAST(GETDATE() AS DATE)) AS day,
          (SELECT COUNT(DISTINCT CAST(Timestamp AS DATE)) FROM dbo.Attendance WHERE UserId = @userId AND Timestamp >= DATEADD(DAY, -7, GETDATE())) AS week,
          (SELECT COUNT(DISTINCT CAST(Timestamp AS DATE)) FROM dbo.Attendance WHERE UserId = @userId AND MONTH(Timestamp) = MONTH(GETDATE()) AND YEAR(Timestamp) = YEAR(GETDATE())) AS month,
          (SELECT COUNT(DISTINCT CAST(Timestamp AS DATE)) FROM dbo.Attendance WHERE UserId = @userId AND YEAR(Timestamp) = YEAR(GETDATE())) AS year
      `);
    res.status(200).json(result.recordset[0]);
  } catch (err) {
    console.error('Database operation error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) pool.close();
  }
});

app.get('/api/compoff/:userId', async (req, res) => {
  const { userId } = req.params;
  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .input('userId', sql.Int, userId)
      .query('SELECT Id, Date, Reason FROM dbo.Compoff WHERE UserId = @userId');
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Database operation error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) pool.close();
  }
});

app.get('/api/user-details/:userId', async (req, res) => {
  const { userId } = req.params;
  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .input('userId', sql.Int, userId)
      .query('SELECT Username, FirstName, LastName, Email FROM dbo.Users u LEFT JOIN dbo.UserDetails ud ON u.Id = ud.UserId WHERE u.Id = @userId');
    if (result.recordset.length > 0) {
      res.status(200).json(result.recordset[0]);
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    console.error('Database operation error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) pool.close();
  }
});

app.post('/api/change-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword) {
    return res.status(400).json({ error: 'User ID and new password required' });
  }
  let pool;
  try {
    pool = await sql.connect(dbConfig);
    await pool
      .request()
      .input('userId', sql.Int, userId)
      .input('newPassword', sql.NVarChar(255), newPassword)
      .query('UPDATE dbo.Users SET Password = @newPassword WHERE Id = @userId');
    res.status(200).json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Database operation error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) pool.close();
  }
});

app.get('/api/announcements', async (req, res) => {
  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .query('SELECT Id, Content, Date FROM dbo.Announcements WHERE CAST(Date AS DATE) = CAST(GETDATE() AS DATE)');
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Database operation error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) pool.close();
  }
});

app.get('/api/carousel-images', async (req, res) => {
  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .query('SELECT Id, ImageUrl FROM dbo.CarouselImages');
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Database operation error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) pool.close();
  }
});

app.get('/api/test', (req, res) => {
  res.status(200).json({ 
    message: 'Test endpoint working', 
    timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) 
  });
});

app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'Unexpected server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} at ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing server...');
  sql.close();
  process.exit(0);
});