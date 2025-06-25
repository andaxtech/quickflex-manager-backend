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

  if (!/^\d{4}$/.test(storeId)) {
    return res.status(400).json({
      success: false,
      message: 'Store ID must be a 4-digit number',
    });
  }

  try {
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

// ✅ Get blocks for a specific location
app.get('/api/location/:locationId/blocks', async (req, res) => {
  const { locationId } = req.params;

  if (!locationId) {
    return res.status(400).json({ success: false, message: 'Missing locationId' });
  }

  try {
    const query = `
      SELECT 
        b.block_id,
        TO_CHAR(b.start_time, 'YYYY-MM-DD') AS start_date,
        TO_CHAR(b.start_time, 'HH12:MI AM') AS start_time_formatted,
        TO_CHAR(b.end_time, 'HH12:MI AM') AS end_time_formatted,
        b.amount,
        b.status,
        bc.claim_time,
        d.driver_id AS driver_id,
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
      AND b.end_time > NOW()
    `;

    const result = await pool.query(query, [locationId]);

    const blocks = result.rows.map((row) => ({
      blockId: row.block_id,
      day: row.start_date,
      startTime: row.start_time_formatted,
      endTime: row.end_time_formatted,
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
    console.error('❌ Error fetching blocks by location:', err);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ✅ Get storeId by locationId
app.get('/api/location/:locationId/store', async (req, res) => {
  const { locationId } = req.params;

  if (!locationId) {
    return res.status(400).json({ success: false, message: 'Missing locationId' });
  }

  try {
    const result = await pool.query(
      'SELECT store_id FROM locations WHERE location_id = $1 LIMIT 1',
      [locationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Store not found for given locationId' });
    }

    res.json({ success: true, storeId: result.rows[0].store_id });
  } catch (err) {
    console.error('❌ Error fetching store ID:', err);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ✅ Get driver details for a specific block
app.get('/api/block/:blockId/details', async (req, res) => {
  const { blockId } = req.params;

  if (!blockId) {
    return res.status(400).json({ success: false, message: 'Missing blockId' });
  }

  try {
    const query = `
      SELECT 
        d.driver_id,
        d.first_name,
        d.last_name,
        d.phone_number,
        d.email,
        d.license_number,
        d.license_expiration,
        d.registration_date,
        i.end_date AS insurance_end
      FROM block_claims AS bc
      JOIN drivers AS d ON bc.driver_id = d.driver_id
      LEFT JOIN insurance_details AS i ON d.driver_id = i.driver_id
      WHERE bc.block_id = $1
      LIMIT 1
    `;

    const result = await pool.query(query, [blockId]);

    if (result.rows.length === 0) {
      return res.json({ success: true, driver: null });
    }

    const row = result.rows[0];

    const driver = {
      fullName: `${row.first_name} ${row.last_name}`,
      phone: row.phone_number,
      email: row.email,
      licenseNumber: row.license_number,
      licenseValid: new Date(row.license_expiration) > new Date(),
      registrationValid: new Date(row.registration_date) > new Date(),
      insuranceValid: new Date(row.insurance_end) > new Date(),
    };

    res.json({ success: true, driver });
  } catch (err) {
    console.error('❌ Error in /api/block/:blockId/details:', err);
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
      SELECT l.store_id AS id, l.city, l.location_id AS "locationId"
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

// ✅ Get specific block detail + driver info for a location
app.get('/api/location/:locationId/blocks/:blockId', async (req, res) => {
  const { locationId, blockId } = req.params;

  if (!locationId || !blockId) {
    return res.status(400).json({ success: false, message: 'Missing locationId or blockId' });
  }

  try {
    const query = `
      SELECT 
        b.block_id,
        TO_CHAR(b.start_time, 'YYYY-MM-DD') AS day,
        TO_CHAR(b.start_time, 'HH12:MI AM') AS start_time,
        TO_CHAR(b.end_time, 'HH12:MI AM') AS end_time,
        b.amount,
        b.status,
        bc.claim_time,
        d.first_name,
        d.last_name,
        d.phone_number,
        d.email,
        d.license_number,
        d.license_expiration,
        d.registration_date,
        i.end_date AS insurance_end
      FROM blocks b
      LEFT JOIN block_claims bc ON b.block_id = bc.block_id
      LEFT JOIN drivers d ON bc.driver_id = d.driver_id
      LEFT JOIN insurance_details i ON d.driver_id = i.driver_id
      WHERE b.block_id = $1 AND b.location_id = $2
      LIMIT 1
    `;

    const result = await pool.query(query, [blockId, locationId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Block not found' });
    }

    const row = result.rows[0];
    const driver = row.first_name ? {
      fullName: `${row.first_name} ${row.last_name}`,
      phone: row.phone_number,
      email: row.email,
      licenseNumber: row.license_number,
      licenseValid: new Date(row.license_expiration) > new Date(),
      registrationValid: new Date(row.registration_date) > new Date(),
      insuranceValid: new Date(row.insurance_end) > new Date(),
    } : null;

    const block = {
      blockId: row.block_id,
      day: row.day,
      startTime: row.start_time,
      endTime: row.end_time,
      amount: row.amount,
      status: row.status,
      claimTime: row.claim_time,
      driver,
    };

    res.json({ success: true, block });
  } catch (err) {
    console.error('❌ Error fetching block by location:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Add blocks to the table
app.post('/api/blocks', async (req, res) => {
  const { location_id, start_time, end_time, day, amount, status } = req.body;

  if (!location_id || !start_time || !end_time || !day || !amount) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    const insertQuery = `
      INSERT INTO blocks (location_id, start_time, end_time, day, amount, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING block_id
    `;

    const result = await pool.query(insertQuery, [
      location_id,
      start_time,
      end_time,
      day,
      amount,
      status || 'available',
    ]);

    res.status(201).json({
      success: true,
      message: 'Block created successfully',
      blockId: result.rows[0].block_id,
    });
  } catch (err) {
    console.error('❌ Error inserting block:', err);
    res.status(500).json({ success: false, message: 'Database insert error' });
  }
});

app.listen(PORT, () => {
  console.log('✅ Manager backend is up and running on port', PORT);
});
