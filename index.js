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




// ✅ New API for Store Schedule View- specific date and location (for calendar view)
app.get('/api/location/blocks', async (req, res) => {
  const { location_id, date } = req.query;
  const locationIdInt = parseInt(location_id);

  if (!location_id || !date || isNaN(locationIdInt)) {
    return res.status(400).json({ success: false, message: 'Missing or invalid location_id or date' });
  }

  try {
    const query = `
      WITH latest_claims AS (
        SELECT *
        FROM (
          SELECT claim_id, block_id, driver_id, claim_time,
                 ROW_NUMBER() OVER (PARTITION BY block_id ORDER BY claim_time DESC) AS rn
          FROM block_claims
        ) sub
        WHERE rn = 1
      )
      SELECT
        b.block_id,
        b.date,
        b.start_time,
        b.end_time,
        b.amount,
        b.status,
        lc.claim_time,
        lc.claim_id,
        d.driver_id,
        d.first_name,
        d.last_name,
        d.phone_number,
        d.email,
        d.license_number,
        d.license_expiration,
        d.registration_expiration_date,
        i.start_date AS insurance_start,
        i.end_date AS insurance_end
      FROM blocks AS b
      LEFT JOIN latest_claims lc ON b.block_id = lc.block_id
      LEFT JOIN drivers d ON lc.driver_id = d.driver_id
      LEFT JOIN insurance_details i ON d.driver_id = i.driver_id
      WHERE b.location_id = $1 AND b.date = $2::date
      ORDER BY b.start_time
    `;

    const result = await pool.query(query, [locationIdInt, date]);

    const blocks = result.rows.map((row) => ({
      blockId: row.block_id,
      date: row.date?.toISOString().split('T')[0] || null,
      startTime: row.start_time?.toISOString() || null,
      endTime: row.end_time?.toISOString() || null,
      amount: row.amount,
      status: row.status,
      claimTime: row.claim_time,
      claimId: row.claim_id,
      driver: row.driver_id
        ? {
            fullName: `${row.first_name} ${row.last_name}`,
            phone: row.phone_number,
            email: row.email,
            licenseNumber: row.license_number,
            licenseValid: row.license_expiration > new Date(),
            registrationValid: row.registration_expiration_date > new Date(),
            insuranceValid: row.insurance_end > new Date(),
          }
        : undefined,
    }));

    res.json({ success: true, blocks });
  } catch (err) {
    console.error('❌ Error fetching blocks by date and location:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});





// ✅ Get store details by locationId- new version- Modal.tsx
app.get('/api/location/:locationId/store', async (req, res) => {
  const { locationId } = req.params;

  if (!locationId) {
    return res.status(400).json({ success: false, message: 'Missing locationId' });
  }

  try {
    const result = await pool.query(
      `SELECT store_id, phone, street_name, city, region, postal_code, time_zone_code 
       FROM locations 
       WHERE location_id = $1 
       LIMIT 1`,
      [locationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Store not found for given locationId' });
    }

    const row = result.rows[0];

    res.json({
      success: true,
      storeId: row.store_id,
      store: {
        storeId: row.store_id,
        phone: row.phone,
        street: row.street_name,
        city: row.city,
        region: row.region,
        postalCode: row.postal_code,
        TimeZoneCode: row.time_zone_code,
      },
    });
  } catch (err) {
    console.error('❌ Error fetching store details:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});





// ✅ Get specific block detail + driver info
app.get('/api/location/:locationId/blocks/:blockId', async (req, res) => {
  const { locationId, blockId } = req.params;

  if (!locationId || !blockId) {
    return res.status(400).json({ success: false, message: 'Missing locationId or blockId' });
  }

  try {
    const query = `
      SELECT 
        b.block_id,
        b.date,
        b.start_time,
        b.end_time,
        b.amount,
        b.status,
        bc.claim_time,
        bc.claim_id,
        d.first_name,
        d.last_name,
        d.phone_number,
        d.email,
        d.license_number,
        d.license_expiration,
        d.registration_expiration_date,
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
      licenseValid: row.license_expiration > new Date(),
      registrationValid: row.registration_expiration_date > new Date(),
      insuranceValid: row.insurance_end > new Date(),
    } : null;

    const block = {
      blockId: row.block_id,
      date: row.formatted_date,
      startTime: row.start_time,
      endTime: row.end_time,
      amount: row.amount,
      status: row.status,
      claimTime: row.claim_time,
      claimId: row.claim_id,
      driver,
    };

    res.json({ success: true, block });
  } catch (err) {
    console.error('❌ Error fetching block by location:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});



//used in modal.tsx- new version- modal.tsx
// ✅ Create a new block 
app.post('/api/blocks', async (req, res) => {
  const { 
    location_id, 
    start_time, 
    end_time, 
    amount, 
    status, 
    date, 
    device_local_time, 
    device_timezone_offset,
    device_time_zone_name  // Added this field
  } = req.body;

  if (!location_id || !start_time || !end_time || !date || !amount) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    // Validate that start_time and end_time are valid ISO strings
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid datetime format' });
    }

    // Ensure end time is after start time
    if (endDate <= startDate) {
      return res.status(400).json({ success: false, message: 'End time must be after start time' });
    }

    const insertQuery = `
      INSERT INTO blocks (
        location_id, 
        start_time, 
        end_time, 
        amount, 
        status, 
        date, 
        device_local_time, 
        device_timezone_offset,
        device_time_zone_name,
        created_at
      )
      VALUES (
        $1,
        $2::timestamptz,  -- Use timestamptz to preserve timezone info
        $3::timestamptz,  -- Use timestamptz to preserve timezone info
        $4,
        $5,
        $6::date,
        $7,
        $8,
        $9,
        NOW()
      )
      RETURNING block_id, start_time, end_time
    `;

    const result = await pool.query(insertQuery, [
      location_id,
      start_time,
      end_time,
      amount,
      status || 'available',
      date,
      device_local_time || null,
      device_timezone_offset || null,
      device_time_zone_name || null
    ]);

    const createdBlock = result.rows[0];

    res.status(201).json({
      success: true,
      message: 'Block created successfully',
      blockId: createdBlock.block_id,
      block: {
        block_id: createdBlock.block_id,
        start_time: createdBlock.start_time.toISOString(),
        end_time: createdBlock.end_time.toISOString(),
        amount,
        status: status || 'available',
        date
      }
    });
  } catch (err) {
    console.error('❌ Error inserting block:', err);
    
    // Provide more specific error messages
    if (err.code === '23505') { // Unique constraint violation
      return res.status(409).json({ 
        success: false, 
        message: 'Block already exists for this time slot' 
      });
    }
    
    res.status(500).json({ success: false, message: 'Database insert error' });
  }
});




//used in modal.tsx- new version-modal.tsx
// ✅ Get blocks for a specific date and location
app.get('/api/blocks', async (req, res) => {
  const { location_id, date } = req.query;

  const locationIdInt = parseInt(location_id);
  if (!location_id || !date || isNaN(locationIdInt)) {
    return res.status(400).json({ success: false, message: 'Missing or invalid location_id or date' });
  }

  try {
    const query = `
      SELECT 
        block_id,
        start_time AT TIME ZONE 'UTC' as start_time,
        end_time AT TIME ZONE 'UTC' as end_time,
        amount,
        status,
        date,
        device_local_time,
        device_timezone_offset,
        device_time_zone_name,
        created_at
      FROM blocks
      WHERE location_id = $1 AND date = $2::date
      ORDER BY start_time
    `;

    const result = await pool.query(query, [locationIdInt, date]);
    
    // Ensure timestamps are returned as ISO strings
    const blocks = result.rows.map(block => ({
      ...block,
      start_time: block.start_time instanceof Date ? block.start_time.toISOString() : block.start_time,
      end_time: block.end_time instanceof Date ? block.end_time.toISOString() : block.end_time
    }));

    res.json({ success: true, blocks });
  } catch (err) {
    console.error('❌ Error fetching blocks by date:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ✅ Delete block if unclaimed
app.delete('/api/blocks/:blockId', async (req, res) => {
  const { blockId } = req.params;

  if (!blockId) {
    return res.status(400).json({ success: false, message: 'Missing blockId' });
  }

  try {
    console.log('🧪 Deleting blockId:', blockId);

    const claimCheckQuery = `
      SELECT claim_id FROM block_claims
      WHERE block_id = $1
      ORDER BY claim_time DESC
      LIMIT 1
    `;
    const { rows: claimRows } = await pool.query(claimCheckQuery, [blockId]);

    if (claimRows.length > 0) {
      console.log('⚠️ Block is claimed, claim_id:', claimRows[0].claim_id);
      return res.status(403).json({
        success: false,
        message: 'Cannot delete block — it is already claimed',
        claimId: claimRows[0].claim_id,
      });
    }

    const deleteQuery = `DELETE FROM blocks WHERE block_id = $1`;
    const result = await pool.query(deleteQuery, [blockId]);

    if (result.rowCount === 0) {
      console.warn('❌ No block found to delete for blockId:', blockId);
      return res.status(404).json({ success: false, message: 'Block not found' });
    }

    console.log('✅ Block deleted:', blockId);
    res.json({ success: true, message: 'Block deleted successfully' });
  } catch (err) {
    console.error('❌ Error deleting block:', err.stack || err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});


// ✅ Get stores linked to a manager
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
app.listen(PORT, () => {
  console.log('✅ Manager backend is up and running on port', PORT);
});
