const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ✅ Health check
app.get('/api/ping', (req, res) => {
  res.send('Manager backend is alive');
});

// ✅ Verify store and link to manager
app.post('/api/verify-store', async (req, res) => {
  const { storeId, fcode, managerId } = req.body;

  if (!storeId || !fcode || !managerId) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // 🛡️ Validate storeId: must be exactly 4 digits
  if (!/^\d{4}$/.test(storeId)) {
    return res.status(400).json({
      success: false,
      message: 'Store ID must be a 4-digit number',
    });
  }

  try {
    // 🔍 Check if store exists with matching FCODE (case-insensitive)
    const checkQuery = `
      SELECT store_id, city FROM locations
      WHERE store_id = $1 AND LOWER(fcode) = LOWER($2)
    `;
    const checkResult = await pool.query(checkQuery, [storeId, fcode]);

    if (checkResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'FCODE PIN and Store ID don’t match.',
      });
    }

    const store = checkResult.rows[0];

    // 🔁 Check if already linked
    const existsQuery = `
      SELECT 1 FROM manager_store_links
      WHERE manager_id = $1 AND store_id = $2
    `;
    const exists = await pool.query(existsQuery, [managerId, store.store_id]);

    if (exists.rows.length > 0) {
      return res.json({
        success: true,
        store: {
          id: store.store_id,
          city: store.city,
        },
        message: 'Store already linked to manager',
      });
    }

    // ➕ Insert into manager_store_links
    const insertQuery = `
      INSERT INTO manager_store_links (manager_id, store_id, added_at)
      VALUES ($1, $2, NOW())
    `;
    await pool.query(insertQuery, [managerId, store.store_id]);

    res.json({
      success: true,
      store: {
        id: store.store_id,
        city: store.city,
      },
      message: 'Store successfully linked to manager',
    });
  } catch (err) {
    console.error('❌ Error in /api/verify-store:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ✅ Get blocks for a specific store
app.get('/api/store/:storeId/blocks', async (req, res) => {
  const { storeId } = req.params;

  if (!storeId) {
    return res.status(400).json({ success: false, message: 'Missing storeId' });
  }

  try {
    const query = `
      SELECT 
        b.block_id,
        b.day,
        b.start_time,
        b.end_time,
        b.amount,
        b.status,
        bc.claim_time,
        d.driver_id,
        d.first_name,
        d.last_name,
        d.phone_number,
        d.email,
        d.license_number,
        d.license_expiration,
        d.registration_date,
        i.start_date AS insurance_start,
        i.end_date AS insurance_end
      FROM blocks AS b
      LEFT JOIN block_claims AS bc ON b.block_id = bc.block_id
      LEFT JOIN drivers AS d ON bc.driver_id = d.driver_id
      LEFT JOIN insurance_details AS i ON i.driver_id = d.driver_id
      WHERE b.location_id = $1
    `;

    const result = await pool.query(query, [storeId]);

    const blocks = result.rows.map((row) => ({
      blockId: row.block_id,
      day: row.day,
      startTime: row.start_time,
      endTime: row.end_time,
      amount: row.amount,
      status: row.status,
      claimTime: row.claim_time,
      driver: row.driver_id
        ? {
            fullName: `${row.first_name} ${row.last_name}`,
            phone: row.phone_number,
            email: row.email,
            licenseNumber: row.license_number,
            licenseValid: new Date(row.license_expiration) > new Date(),
            registrationValid: new Date(row.registration_date) > new Date(),
            insuranceValid: new Date(row.insurance_end) > new Date(),
          }
        : undefined,
    }));

    res.json({ success: true, blocks });
  } catch (err) {
    console.error('❌ Error fetching store blocks:', err);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});



// ✅ Get stores linked to manager
app.get('/api/my-stores', async (req, res) => {
  const { managerId } = req.query;

  if (!managerId) {
    return res.status(400).json({ success: false, message: 'Missing managerId' });
  }

  try {
    const query = `
      SELECT l.store_id AS id, l.city
      FROM manager_store_links msl
      JOIN locations l ON msl.store_id = l.store_id
      WHERE msl.manager_id = $1
    `;
    const result = await pool.query(query, [managerId]);

    res.json({ success: true, stores: result.rows });
  } catch (err) {
    console.error('❌ Error fetching manager stores:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 5003;
app.listen(PORT, () => {
  console.log('✅ Manager backend is up and running on port', PORT);
});
