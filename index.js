const express = require('express');


const { Storage } = require('@google-cloud/storage');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const WeatherService = require('./weatherService');
// Initialize weather service
const weatherService = new WeatherService(process.env.OPENWEATHER_API_KEY);

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
        message: 'FCODE PIN and Store ID do not match.'
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
// Also update GET /api/location/blocks to include manager info
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
          SELECT 
            bc.claim_id, 
            bc.block_id, 
            bc.driver_id, 
            bc.claim_time,
            bc.service_status,
            bc.check_in_time,
            bc.check_out_time,
            bc.cancellation_type,
bc.cancelled_by,
            ROW_NUMBER() OVER (PARTITION BY bc.block_id ORDER BY bc.claim_time DESC) AS rn
          FROM block_claims bc
        ) sub
        WHERE rn = 1
      )
      SELECT
        b.block_id,
        b.date,
        b.start_time,
        b.end_time,
        b.amount,
        b.status as block_status,
        b.manager_id,
        lc.claim_time,
        lc.claim_id,
        lc.service_status,
        lc.check_in_time,
        lc.check_out_time,
        d.driver_id,
        d.first_name,
        d.last_name,
        d.phone_number,
        d.email,
        d.driver_license_number,
        d.driver_license_expiration,
        cd.vehicle_registration_expiration,
        i.policy_start_date AS insurance_start,
        i.policy_end_date AS insurance_end,
        m.first_name as manager_first_name,
        m.last_name as manager_last_name,
        -- Determine display status based on your business logic
        CASE 
          WHEN lc.service_status = 'complete' THEN 'completed'
          WHEN lc.service_status = 'in_progress' THEN 'in_progress'
          WHEN b.status = 'accepted' THEN 'accepted'
          WHEN b.status = 'expired' THEN 'expired'
          WHEN b.status = 'available' THEN 'available'
          ELSE b.status
        END AS display_status
      FROM blocks AS b
      LEFT JOIN latest_claims lc ON b.block_id = lc.block_id
      LEFT JOIN drivers d ON lc.driver_id = d.driver_id
      LEFT JOIN car_details cd ON d.driver_id = cd.driver_id
      LEFT JOIN insurance_details i ON d.driver_id = i.driver_id
      LEFT JOIN managers m ON b.manager_id = m.manager_id
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
      status: row.display_status,  // Use the calculated display_status
      blockStatus: row.block_status,  // Original block status if needed
      serviceStatus: row.service_status,  // Service status from claims if needed
      claimTime: row.claim_time,
      claimId: row.claim_id,
      cancellationType: row.cancellation_type,
cancelledBy: row.cancelled_by,
      managerId: row.manager_id,
      createdBy: row.manager_id ? {
        id: row.manager_id,
        name: `${row.manager_first_name || ''} ${row.manager_last_name || ''}`.trim()
      } : null,
      driver: row.driver_id
        ? {
            fullName: `${row.first_name} ${row.last_name}`,
            phone: row.phone_number,
            email: row.email,
            licenseNumber: row.driver_license_number,
            licenseValid: row.driver_license_expiration > new Date(),
            registrationValid: row.vehicle_registration_expiration > new Date(),
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
        timeZoneCode: row.time_zone_code,
      },
    });
  } catch (err) {
    console.error('❌ Error fetching store details:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ✅ Get specific block detail + driver info (UPDATED FOR EXTENDED DETAILS)
app.get('/api/location/:locationId/blocks/:blockId/details', async (req, res) => {
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
        b.manager_id,
        bc.claim_time,
        bc.claim_id,
        bc.service_status,
        bc.check_in_time,
        bc.check_out_time,
        d.driver_id,
        d.first_name,
        d.last_name,
        d.phone_number,
        d.email,
        d.driver_license_number,
        d.driver_license_expiration,
        d.profile_photo_gcs_path,
        cd.vehicle_registration_expiration,
        cd.car_make,
        cd.car_model,
        cd.car_color,
        cd.license_plate,
        i.policy_start_date AS insurance_start,
        i.policy_end_date AS insurance_end,
        l.time_zone_code
      FROM blocks b
      LEFT JOIN locations l ON b.location_id = l.location_id
      LEFT JOIN block_claims bc ON b.block_id = bc.block_id
      LEFT JOIN drivers d ON bc.driver_id = d.driver_id
      LEFT JOIN car_details cd ON d.driver_id = cd.driver_id
      LEFT JOIN insurance_details i ON d.driver_id = i.driver_id
      WHERE b.block_id = $1 AND b.location_id = $2
      ORDER BY bc.claim_time DESC
      LIMIT 1
    `;

    const result = await pool.query(query, [blockId, locationId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Block not found' });
    }

    const row = result.rows[0];
    
    const block = {
      blockId: row.block_id,
      date: row.date?.toISOString().split('T')[0] || null,
      startTime: row.start_time,
      endTime: row.end_time,
      amount: row.amount,
      status: row.status,
      manager_id: row.manager_id,
      claimTime: row.claim_time,
      claimId: row.claim_id,
      timeZoneCode: row.time_zone_code || 'GMT-08:00', // Default to PST if missing
      driver: row.first_name ? {
        driverId: row.driver_id,
        fullName: `${row.first_name} ${row.last_name}`,
        firstName: row.first_name,
        lastName: row.last_name,
        phone: row.phone_number,
        email: row.email,
        licenseNumber: row.driver_license_number,
        driverLicenseNumber: row.driver_license_number,
        driverLicenseExpiration: row.driver_license_expiration,
        profilePhotoPath: row.profile_photo_gcs_path,
        licenseValid: row.driver_license_expiration > new Date(),
        registrationValid: row.vehicle_registration_expiration > new Date(),
        insuranceValid: row.insurance_end > new Date(),
      } : null,
      carDetails: row.car_make ? {
        carMake: row.car_make,
        carModel: row.car_model,
        carColor: row.car_color,
        licensePlate: row.license_plate
      } : null,
      blockClaim: row.claim_id ? {
        checkInTime: row.check_in_time,
        checkOutTime: row.check_out_time,
        serviceStatus: row.service_status
      } : null
    };

    res.json({ success: true, block });
  } catch (err) {
    console.error('❌ Error fetching block details:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Keep the original endpoint for backward compatibility
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
        d.driver_license_number,
        d.driver_license_expiration,
        cd.vehicle_registration_expiration,
        i.policy_start_date AS insurance_start,
        i.policy_end_date AS insurance_end
      FROM blocks b
      LEFT JOIN block_claims bc ON b.block_id = bc.block_id
      LEFT JOIN drivers d ON bc.driver_id = d.driver_id
      LEFT JOIN car_details cd ON d.driver_id = cd.driver_id
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
      licenseNumber: row.driver_license_number,
      licenseValid: row.driver_license_expiration > new Date(),
      registrationValid: row.vehicle_registration_expiration > new Date(),
      insuranceValid: row.insurance_end > new Date(),
    } : null;

    const block = {
      blockId: row.block_id,
      date: row.date?.toISOString().split('T')[0] || null,
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

// ✅ Get driver location for a claimed block
app.get('/api/drivers/:claimId/location', async (req, res) => {
  const { claimId } = req.params;

  if (!claimId) {
    return res.status(400).json({ success: false, message: 'Missing claimId' });
  }

  try {
    // First, verify the claim exists and get driver info
    const claimQuery = `
      SELECT 
        bc.driver_id,
        bc.block_id,
        bc.service_status,
        d.first_name,
        d.last_name
      FROM block_claims bc
      JOIN drivers d ON bc.driver_id = d.driver_id
      WHERE bc.claim_id = $1
    `;

    const claimResult = await pool.query(claimQuery, [claimId]);

    if (claimResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Claim not found' });
    }

    const claim = claimResult.rows[0];

    // For now, return mock data since you don't have a driver_locations table
    // In production, you would query the actual location from your tracking system
    res.json({
      success: true,
      location: null, // No location data available yet
      message: 'Driver location tracking not yet implemented'
    });

  } catch (err) {
    console.error('❌ Error fetching driver location:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Fixed create block API in manager backend
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
    device_time_zone_name,
    manager_id  // ADD: New required field
  } = req.body;

  // Updated validation to include manager_id
  if (!location_id || !start_time || !end_time || !date || !amount || !manager_id) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields. Required: location_id, start_time, end_time, date, amount, manager_id' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Validate that start_time and end_time are valid ISO strings
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new Error('Invalid datetime format');
    }

    // Ensure end time is after start time
    if (endDate <= startDate) {
      throw new Error('End time must be after start time');
    }

    // Verify manager exists and has access to this location
    const managerCheckQuery = `
      SELECT 
        m.manager_id, 
        m.first_name, 
        m.last_name,
        m.status,
        msl.store_id,
        l.location_id
      FROM managers m
      INNER JOIN manager_store_links msl ON m.manager_id = msl.manager_id
      INNER JOIN locations l ON msl.store_id = l.store_id
      WHERE m.manager_id = $1 AND l.location_id = $2
    `;

    const managerResult = await client.query(managerCheckQuery, [manager_id, location_id]);

    if (managerResult.rowCount === 0) {
      throw new Error('Manager does not have permission to create blocks for this location');
    }

    const manager = managerResult.rows[0];

    // Check if manager is active
    if (manager.status !== 'active') {
      throw new Error('Manager account is not active');
    }

    // Insert the block with manager_id
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
        manager_id,
        created_at
      )
      VALUES (
        $1,
        $2::timestamptz,
        $3::timestamptz,
        $4,
        $5,
        $6::date,
        $7,
        $8,
        $9,
        $10,
        NOW()
      )
      RETURNING block_id, start_time, end_time, manager_id
    `;

    const result = await client.query(insertQuery, [
      location_id,
      start_time,
      end_time,
      amount,
      status || 'available',
      date,
      device_local_time || null,
      device_timezone_offset || null,
      device_time_zone_name || null,
      manager_id
    ]);

    const createdBlock = result.rows[0];

    await client.query('COMMIT');

    console.log(`✅ Block ${createdBlock.block_id} created by manager ${manager_id} (${manager.first_name} ${manager.last_name})`);

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
        date,
        manager_id: createdBlock.manager_id,
        created_by: {
          id: manager.manager_id,
          name: `${manager.first_name} ${manager.last_name}`
        }
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error inserting block:', err);
    
    // Provide more specific error messages
    if (err.code === '23505') { // Unique constraint violation
      return res.status(409).json({ 
        success: false, 
        message: 'Block already exists for this time slot' 
      });
    }
    
    if (err.message) {
      return res.status(400).json({ 
        success: false, 
        message: err.message 
      });
    }
    
    res.status(500).json({ success: false, message: 'Database insert error' });
  } finally {
    client.release();
  }
});

// Also update the GET /api/blocks to include manager info
app.get('/api/blocks', async (req, res) => {
  const { location_id, date } = req.query;

  const locationIdInt = parseInt(location_id);
  if (!location_id || !date || isNaN(locationIdInt)) {
    return res.status(400).json({ success: false, message: 'Missing or invalid location_id or date' });
  }

  try {
    const query = `
      SELECT 
        b.block_id,
        b.start_time AT TIME ZONE 'UTC' as start_time,
        b.end_time AT TIME ZONE 'UTC' as end_time,
        b.amount,
        b.status,
        b.date,
        b.device_local_time,
        b.device_timezone_offset,
        b.device_time_zone_name,
        b.manager_id,  -- ADD: Include manager_id
        b.created_at,
        m.first_name as manager_first_name,
        m.last_name as manager_last_name
      FROM blocks b
      LEFT JOIN managers m ON b.manager_id = m.manager_id  -- ADD: Join with managers
      WHERE b.location_id = $1 AND b.date = $2::date
      ORDER BY b.start_time
    `;

    const result = await pool.query(query, [locationIdInt, date]);
    
    // Ensure timestamps are returned as ISO strings and include manager info
    const blocks = result.rows.map(block => ({
      ...block,
      start_time: block.start_time instanceof Date ? block.start_time.toISOString() : block.start_time,
      end_time: block.end_time instanceof Date ? block.end_time.toISOString() : block.end_time,
      created_by: block.manager_id ? {
        id: block.manager_id,
        name: `${block.manager_first_name || ''} ${block.manager_last_name || ''}`.trim()
      } : null
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

// Initialize GCS
let storage;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: credentials
    });
    console.log('✅ GCS initialized with credentials');
  } catch (error) {
    console.error('❌ Failed to parse GCS credentials:', error);
    storage = new Storage();
  }
} else {
  storage = new Storage();
}

const bucketName = process.env.GCS_BUCKET_NAME;

// Serve driver photos from GCS
app.get(/^\/api\/drivers\/photo\/(.*)/, async (req, res) => {
  const gcsPath = req.params[0];
  
  try {
    if (!bucketName) {
      console.error('GCS_BUCKET_NAME not configured');
      return res.status(500).json({ error: 'Storage configuration missing' });
    }

    const file = storage.bucket(bucketName).file(gcsPath);
    
    const [exists] = await file.exists();
    if (!exists) {
      console.log(`Photo not found in GCS: ${gcsPath}`);
      return res.status(404).json({ error: 'Photo not found' });
    }
    
    // Get file metadata to set correct content type
    const [metadata] = await file.getMetadata();
    
    res.setHeader('Content-Type', metadata.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // Stream the file
    file.createReadStream()
      .on('error', (err) => {
        console.error('Error streaming GCS file:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to load photo' });
        }
      })
      .pipe(res);
      
  } catch (error) {
    console.error('Error serving GCS photo:', error);
    res.status(500).json({ error: 'Failed to load photo' });
  }
});


// Update the my-stores endpoint
app.get('/api/my-stores', async (req, res) => {
  const { managerId } = req.query;

  if (!managerId) {
    return res.status(400).json({ success: false, message: 'Missing managerId' });
  }

  try {
    const query = `
      SELECT l.store_id AS id, l.city, l.region as state, l.location_id AS "locationId"
      FROM manager_store_links msl
      JOIN locations l ON msl.store_id = l.store_id
      WHERE msl.manager_id = $1
    `;
    const result = await pool.query(query, [managerId]);

    // Fetch weather data for all stores - fix the property name mismatch
const storesWithCorrectId = result.rows.map(store => ({
  ...store,
  store_id: store.id // Add store_id property that weatherService expects
}));
const weatherMap = await weatherService.getWeatherForStores(storesWithCorrectId);

    // Enrich stores with weather data
    const enrichedStores = result.rows.map((store) => ({
      ...store,
      weather: weatherMap[store.id] || {
        temperature: 0,
        condition: 'Unknown',
        high: 0,
        low: 0,
        alert: undefined
      },
      // You can keep the mock shift data for now
      shifts: {
        open: Math.floor(Math.random() * 20 + 10),
        booked: Math.floor(Math.random() * 10)
      }
    }));

    res.json({ success: true, stores: enrichedStores });
  } catch (err) {
    console.error('❌ Error fetching manager stores:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});



// ✅ Remove store from manager (delete link)
app.delete('/api/my-stores/:storeId', async (req, res) => {
  const { storeId } = req.params;
  const { managerId } = req.query;

  if (!storeId || !managerId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing storeId or managerId' 
    });
  }

  try {
    // First check if the link exists
    const checkQuery = `
      SELECT msl.*, l.city 
      FROM manager_store_links msl
      JOIN locations l ON msl.store_id = l.store_id
      WHERE msl.manager_id = $1 AND msl.store_id = $2
    `;
    const checkResult = await pool.query(checkQuery, [managerId, storeId]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Store not found for this manager' 
      });
    }

    const storeInfo = checkResult.rows[0];

    // Delete the link
    const deleteQuery = `
      DELETE FROM manager_store_links 
      WHERE manager_id = $1 AND store_id = $2
    `;
    await pool.query(deleteQuery, [managerId, storeId]);

    console.log(`✅ Store ${storeId} unlinked from manager ${managerId}`);

    res.json({ 
      success: true, 
      message: `Store ${storeId} - ${storeInfo.city} removed successfully`,
      removedStore: {
        id: storeId,
        city: storeInfo.city
      }
    });
  } catch (err) {
    console.error('❌ Error removing store link:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// Manager login with Clerk
app.post('/api/managers/clerk-login', async (req, res) => {
  const { clerkUserId } = req.body;

  if (!clerkUserId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing Clerk user ID' 
    });
  }

  try {
    // First check users table
    const userQuery = `
      SELECT u.user_id, u.email, u.role, u.status
      FROM users u
      WHERE u.clerk_user_id = $1
    `;
    const userResult = await pool.query(userQuery, [clerkUserId]);

    if (userResult.rows.length === 0) {
      // Check if this Clerk user exists at all (they might have verified but not completed signup)
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        needsSignup: true,
        isVerifiedButIncomplete: true
      });
    }

    const user = userResult.rows[0];

    // Then get manager details
    const managerQuery = `
      SELECT m.manager_id, m.first_name, m.last_name, m.phone_number, m.status
      FROM managers m
      WHERE m.user_id = $1
    `;
    const managerResult = await pool.query(managerQuery, [user.user_id]);

    if (managerResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Manager profile not found',
        needsManagerProfile: true,
        userId: user.user_id
      });
    }

    const manager = managerResult.rows[0];

    if (manager.status !== 'active') {
      return res.status(403).json({ 
        success: false, 
        message: 'Manager account is not active' 
      });
    }

    res.json({
      success: true,
      managerId: manager.manager_id,
      manager: {
        id: manager.manager_id,
        firstName: manager.first_name,
        lastName: manager.last_name,
        email: user.email,
        phone: manager.phone_number
      }
    });
  } catch (error) {
    console.error('Manager Clerk login error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Login failed' 
    });
  }
});

// Add to your existing backend
app.post('/api/managers/signup', async (req, res) => {
  const { 
    clerk_user_id, 
    first_name, 
    last_name, 
    email, 
    phone_number,
    role  // ADD THIS LINE
  } = req.body;

  if (!clerk_user_id || !first_name || !last_name || !phone_number) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // First, create or get user record
    let userId;
    const userCheck = await client.query(
      'SELECT user_id FROM users WHERE clerk_user_id = $1',
      [clerk_user_id]
    );

    if (userCheck.rows.length > 0) {
      userId = userCheck.rows[0].user_id;
    } else {
      // Create user first
      const userResult = await client.query(
        `INSERT INTO users (
          clerk_user_id,
          email,
          username,
          role,
          status,
          is_verified,
          created_at
        ) VALUES ($1, $2, $3, 'manager', 'active', true, NOW())
        RETURNING user_id`,
        [
          clerk_user_id, 
          email || `${phone_number}@quickflex.com`,
          email ? email.split('@')[0] : `user_${phone_number.slice(-4)}` // Generate username
        ]
      );
      userId = userResult.rows[0].user_id;
    }

    // Check if manager already exists for this user
    const managerCheck = await client.query(
      'SELECT manager_id FROM managers WHERE user_id = $1',
      [userId]
    );

    if (managerCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false, 
        message: 'Manager already exists' 
      });
    }

    // Insert new manager
    const insertQuery = `
  INSERT INTO managers (
    user_id,
    first_name,
    last_name,
    phone_number,
    fleet,
    status,
    created_at,
    updated_at
  ) VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
  RETURNING manager_id
`;

const result = await client.query(insertQuery, [
  userId,
  first_name,
  last_name,
  phone_number,
  req.body.role || null  // Use req.body.role instead of just role
]);;

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      manager_id: result.rows[0].manager_id,
      message: 'Manager account created successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Manager signup error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create manager account' 
    });
  } finally {
    client.release();
  }
});

// Get manager by Clerk ID
app.get('/api/managers/clerk/:clerkUserId', async (req, res) => {
  const { clerkUserId } = req.params;

  try {
    const query = `
      SELECT 
        m.manager_id,
        m.first_name,
        m.last_name,
        u.email,
        m.phone_number,
        m.status
      FROM managers m
      JOIN users u ON m.user_id = u.user_id
      WHERE u.clerk_user_id = $1
    `;

    const result = await pool.query(query, [clerkUserId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Manager not found' 
      });
    }

    res.json({
      success: true,
      ...result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching manager:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch manager' 
    });
  }
});

// Update manager profile
app.put('/api/managers/:managerId', async (req, res) => {
  const { managerId } = req.params;
  const { 
    first_name, 
    last_name, 
    phone_number, 
    fleet,
    default_store_id,
    manager_profile_url
  } = req.body;

  if (!managerId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing managerId' 
    });
  }

  try {
    const updateQuery = `
      UPDATE managers 
      SET 
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        phone_number = COALESCE($4, phone_number),
        fleet = COALESCE($5, fleet),
        default_store_id = COALESCE($6, default_store_id),
        manager_profile_url = COALESCE($7, manager_profile_url),
        updated_at = NOW()
      WHERE manager_id = $1
      RETURNING manager_id, first_name, last_name, phone_number, fleet, default_store_id
    `;

    const result = await pool.query(updateQuery, [
      managerId,
      first_name,
      last_name,
      phone_number,
      fleet,
      default_store_id,
      manager_profile_url
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Manager not found' 
      });
    }

    res.json({
      success: true,
      manager: result.rows[0],
      message: 'Profile updated successfully'
    });
  } catch (error) {
    console.error('Update manager error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update manager profile' 
    });
  }
});

// Get manager statistics
app.get('/api/managers/:managerId/stats', async (req, res) => {
  const { managerId } = req.params;
  const { startDate, endDate } = req.query;

  if (!managerId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing managerId' 
    });
  }

  try {
    // Get store count
    const storeCountQuery = `
      SELECT COUNT(DISTINCT store_id) as store_count 
      FROM manager_store_links 
      WHERE manager_id = $1
    `;
    const storeCountResult = await pool.query(storeCountQuery, [managerId]);

    // Build block statistics query with optional date filters
    let blockStatsQuery = `
      SELECT 
        COUNT(*) as total_blocks,
        COUNT(CASE WHEN b.status = 'accepted' THEN 1 END) as accepted_blocks,
        COUNT(CASE WHEN b.status = 'available' THEN 1 END) as available_blocks,
        COUNT(CASE WHEN b.status = 'expired' THEN 1 END) as expired_blocks,
        COUNT(CASE WHEN bc.service_status = 'complete' THEN 1 END) as completed_blocks,
        COUNT(CASE WHEN bc.service_status = 'in_progress' THEN 1 END) as in_progress_blocks,
        COALESCE(SUM(b.amount), 0) as total_amount
      FROM blocks b
      LEFT JOIN block_claims bc ON b.block_id = bc.block_id
      WHERE b.manager_id = $1
    `;

    const params = [managerId];
    let paramIndex = 2;

    if (startDate) {
      blockStatsQuery += ` AND b.date >= $${paramIndex}::date`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      blockStatsQuery += ` AND b.date <= $${paramIndex}::date`;
      params.push(endDate);
    }

    const blockStatsResult = await pool.query(blockStatsQuery, params);

    // Get blocks by date for the last 7 days
    const recentBlocksQuery = `
      SELECT 
        b.date,
        COUNT(*) as block_count,
        COALESCE(SUM(b.amount), 0) as daily_amount
      FROM blocks b
      WHERE b.manager_id = $1 
        AND b.date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY b.date
      ORDER BY b.date DESC
    `;
    const recentBlocksResult = await pool.query(recentBlocksQuery, [managerId]);

    res.json({
      success: true,
      stats: {
        storeCount: parseInt(storeCountResult.rows[0].store_count),
        blocks: {
          total: parseInt(blockStatsResult.rows[0].total_blocks),
          accepted: parseInt(blockStatsResult.rows[0].accepted_blocks),
          available: parseInt(blockStatsResult.rows[0].available_blocks),
          expired: parseInt(blockStatsResult.rows[0].expired_blocks),
          completed: parseInt(blockStatsResult.rows[0].completed_blocks),
          inProgress: parseInt(blockStatsResult.rows[0].in_progress_blocks)
        },
        totalAmount: parseFloat(blockStatsResult.rows[0].total_amount),
        recentActivity: recentBlocksResult.rows
      }
    });
  } catch (error) {
    console.error('Error fetching manager stats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch statistics' 
    });
  }
});

// Manager phone signup (simplified for phone auth)
app.post('/api/managers/phone-signup', async (req, res) => {
  const { 
    clerk_user_id,
    phone_number,
    first_name,
    last_name,
    email
  } = req.body;

  if (!clerk_user_id || !phone_number) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields' 
    });
  }

  // Forward to the main signup endpoint with modified data
  const modifiedReq = {
    body: {
      clerk_user_id,
      phone_number,
      first_name: first_name || 'Manager',
      last_name: last_name || 'User',
      email: email || `${phone_number}@quickflex.com`
    }
  };

  // Call the existing signup logic
  return app._router.stack
    .find(layer => layer.route?.path === '/api/managers/signup')
    ?.route.stack[0].handle(modifiedReq, res);
});

const PORT = process.env.PORT || 5003;
app.listen(PORT, () => {
  console.log('✅ Manager backend is up and running on port', PORT);
});






