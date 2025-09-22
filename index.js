const express = require('express');



const { Storage } = require('@google-cloud/storage');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

// Initialize GCS with credentials from environment
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
const tempPhotosBucketName = process.env.GCS_TEMP_PHOTOS_BUCKET_NAME || process.env.GCS_BUCKET_NAME;

const WeatherService = require('./weatherService');
const StoreIntelligenceService = require('./storeIntelligenceService');

const app = express();
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Helper function to upload file to GCS
const uploadToGCS = async (file, folder = 'temperature-photos') => {
  if (!bucketName) {
    throw new Error('GCS_BUCKET_NAME not configured');
  }
  
  return new Promise((resolve, reject) => {
    const fileName = `${folder}/${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`;
    const bucket = storage.bucket(tempPhotosBucketName);
    const blob = bucket.file(fileName);
    
    const blobStream = blob.createWriteStream({
      resumable: false,
      metadata: {
        contentType: file.mimetype,
      },
    });
    
    blobStream.on('error', (err) => {
      console.error('GCS upload error:', err);
      reject(err);
    });
    
    blobStream.on('finish', async () => {
      try {
        // Make the file public
        await blob.makePublic();
        const publicUrl = `https://storage.googleapis.com/${folder === 'temperature-photos' ? tempPhotosBucketName : bucketName}/${fileName}`;
        resolve(publicUrl);
      } catch (err) {
        // If making public fails, try to get a signed URL
        const [signedUrl] = await blob.getSignedUrl({
          action: 'read',
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
        });
        resolve(signedUrl);
      }
    });
    
    blobStream.end(file.buffer);
  });
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// After creating pool, import and use workflows router
const workflowRoutes = require('./routes/workflows')(pool);
app.use('/api', workflowRoutes);



// Validate required API keys
const requiredKeys = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  TICKETMASTER_API_KEY: process.env.TICKETMASTER_API_KEY,
  OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY,
  SEATGEEK_CLIENT_ID: process.env.SEATGEEK_CLIENT_ID,
  EVENTBRITE_TOKEN: process.env.EVENTBRITE_TOKEN
};

console.log('🔑 API Key Status:');
Object.entries(requiredKeys).forEach(([key, value]) => {
  console.log(`  ${key}: ${value ? '✅ Configured' : '❌ Missing'}`);
});

// Log if we're missing critical keys
const missingKeys = Object.entries(requiredKeys)
  .filter(([_, value]) => !value)
  .map(([key]) => key);

if (missingKeys.length > 0) {
  console.warn('⚠️  Missing API keys will limit intelligence features:', missingKeys.join(', '));
}




// Initialize weather service with OpenAI
const weatherService = new WeatherService(
  process.env.OPENWEATHER_API_KEY,
  process.env.OPENAI_API_KEY
);

// Initialize intelligence service
const intelligenceService = new StoreIntelligenceService(
  process.env.OPENAI_API_KEY,
  process.env.GOOGLE_MAPS_API_KEY,
  weatherService,
  pool // Pass the database pool
);

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


// Helper function to get shift stats
const getStoreShiftStats = async (locationId) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const shiftQuery = `
      SELECT 
        COUNT(DISTINCT b.block_id) as total_blocks,
        COUNT(DISTINCT CASE WHEN bc.block_id IS NOT NULL THEN b.block_id END) as booked_blocks
      FROM blocks b
      LEFT JOIN block_claims bc ON b.block_id = bc.block_id
      WHERE b.location_id = $1 
        AND b.date >= $2::date
        AND b.status = 'available'
    `;
    const shiftResult = await pool.query(shiftQuery, [locationId, today]);
    
    const total = parseInt(shiftResult.rows[0].total_blocks) || 0;
    const booked = parseInt(shiftResult.rows[0].booked_blocks) || 0;
    
    return {
      open: total - booked,
      booked: booked
    };
  } catch (err) {
    console.error('Error getting shift stats:', err);
    return { open: 0, booked: 0 };
  }
};








// Update the my-stores endpoint
app.get('/api/my-stores', async (req, res) => {
  const { managerId, basic } = req.query;

  if (!managerId) {
    return res.status(400).json({ success: false, message: 'Missing managerId' });
  }

  try {
    const query = `
  SELECT 
    l.store_id AS id, 
    l.city, 
    l.region as state, 
    l.location_id AS "locationId",
    l.time_zone_code as "timeZoneCode",
    l.time_zone_minutes,
    l.delivery_fee,
    l.minimum_delivery_order_amount,
    l.estimated_wait_minutes,
    l.store_name,
    l.is_online_now,
    l.is_force_offline,
    l.is_spanish,
    l.future_order_delay_hours,
    l.service_hours,
    l.cash_limit,
    l.driver_prep_secs,
    l.driver_finish_secs,
    l.driver_at_the_door_secs,
    l.store_latitude,
    l.store_longitude,
    l.geofence_radius_meters,
    l.driver_tracking_supported,
    l.enhanced_dynamic_delivery_fee,
    l.contactless_delivery,
    l.contactless_carryout,
    l.delivery_wait_time_reason,
    l.carryout_wait_time_reason
  FROM manager_store_links msl
  JOIN locations l ON msl.store_id = l.store_id
  WHERE msl.manager_id = $1
`;
    const result = await pool.query(query, [managerId]);

    // Fetch weather data for all stores - fix the property name mismatch
const storesWithCorrectId = result.rows.map(store => ({
  ...store,
  store_id: store.id,
  state: store.state, // Ensure state is passed
  timeZoneCode: store.timeZoneCode,
  latitude: store.store_latitude,
  longitude: store.store_longitude
}));
const weatherMap = await weatherService.getWeatherForStores(storesWithCorrectId);

    

// Get shift stats for all stores
const shiftPromises = result.rows.map(store => 
  getStoreShiftStats(store.locationId)
);
const shiftResults = await Promise.all(shiftPromises);

// Return basic data immediately without intelligence
const enrichedStores = result.rows.map((store, index) => ({
  ...store,
  weather: weatherMap[store.id] || null,
  shifts: shiftResults[index] || { open: 0, booked: 0 },
  isLoadingIntelligence: true,
  intelligence: null,
  events: [],
  traffic: null,
  deliveryCapacity: null,
  boostWeek: null,
  slowPeriod: null,
  upcomingHoliday: null
}));

// If basic flag is set, return minimal data immediately
if (basic === 'true') {
  const basicStores = result.rows.map(store => ({
    id: store.id,
    city: store.city,
    state: store.state,
    locationId: store.locationId,
    shifts: { open: 0, booked: 0 } // Placeholder
  }));
  return res.json({ success: true, stores: basicStores });
}

// Send response immediately
res.json({ success: true, stores: enrichedStores });
} catch (err) {
  console.error('❌ Error fetching manager stores:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
}
});



// Get intelligence for a single store
app.get('/api/stores/:storeId/intelligence-data', async (req, res) => {
  const { storeId } = req.params;
  const { managerId } = req.query;

  if (!storeId || !managerId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing storeId or managerId' 
    });
  }

  try {
    // Verify access
    const query = `
      SELECT 
        l.store_id AS id, 
        l.city, 
        l.region as state, 
        l.location_id AS "locationId",
        l.time_zone_code as "timeZoneCode",
        l.store_latitude,
        l.store_longitude
      FROM manager_store_links msl
      JOIN locations l ON msl.store_id = l.store_id
      WHERE msl.manager_id = $1 AND l.store_id = $2
    `;
    const result = await pool.query(query, [managerId, storeId]);

    if (result.rows.length === 0) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied to this store' 
      });
    }

    const store = result.rows[0];
    
    // Get shift stats
    const shifts = await getStoreShiftStats(store.locationId);
    store.shifts = shifts;

    // Generate intelligence
    let intelligenceData = null;
    try {
      intelligenceData = await intelligenceService.generateStoreInsight(store);
    } catch (error) {
      console.error(`Failed to get intelligence for store ${store.id}:`, error);
    }

    const externalData = intelligenceData?._externalData || {};

    res.json({
      success: true,
      storeId: storeId,
      intelligence: intelligenceData ? {
        insight: intelligenceData.insight,
        severity: intelligenceData.severity,
        metrics: intelligenceData.metrics,
        action: intelligenceData.action,
        todayActions: intelligenceData.todayActions,
        weekOutlook: intelligenceData.weekOutlook,
        carryoutPromotion: intelligenceData.carryoutPromotion,
        preOrderCampaign: intelligenceData.preOrderCampaign,
        promotionSuggestion: intelligenceData.promotionSuggestion,
        laborAdjustment: intelligenceData.laborAdjustment
      } : null,
      events: (externalData.events || []).map(event => ({
        ...event,
        date: event.date instanceof Date ? event.date.toISOString() : event.date,
        isToday: event.isToday || false,
        daysUntilEvent: event.daysUntilEvent || 0
      })),
      traffic: externalData.traffic || null,
      deliveryCapacity: externalData.deliveryCapacity || null,
      boostWeek: externalData.boostWeek || null,
      slowPeriod: externalData.slowPeriod || null,
      upcomingHoliday: externalData.upcomingHoliday || null
    });
  } catch (error) {
    console.error('Error generating intelligence:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate intelligence' 
    });
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


// Get detailed store data (weather + intelligence)
app.get('/api/store-details/:storeId', async (req, res) => {
  const { storeId } = req.params;
  const { managerId } = req.query;

  if (!storeId || !managerId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing storeId or managerId' 
    });
  }

  try {
    // Verify access and get store data
    const query = `
      SELECT 
        l.store_id AS id, 
        l.city, 
        l.region as state, 
        l.location_id AS "locationId",
        l.time_zone_code as "timeZoneCode",
        l.store_latitude,
        l.store_longitude
      FROM manager_store_links msl
      JOIN locations l ON msl.store_id = l.store_id
      WHERE msl.manager_id = $1 AND l.store_id = $2
    `;
    const result = await pool.query(query, [managerId, storeId]);

    if (result.rows.length === 0) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied to this store' 
      });
    }

    const store = result.rows[0];

    // Get weather
    const weatherData = await weatherService.getWeatherForStores([{
      store_id: store.id,
      state: store.state,
      timeZoneCode: store.timeZoneCode,
      latitude: store.store_latitude,
      longitude: store.store_longitude
    }]);

    // Get shift stats
    const shifts = await getStoreShiftStats(store.locationId);
    store.shifts = shifts;

    // Get intelligence
    let intelligenceData = null;
    try {
      intelligenceData = await intelligenceService.generateStoreInsight(store);
    } catch (error) {
      console.error(`Failed to get intelligence for store ${store.id}:`, error);
    }

    const externalData = intelligenceData?._externalData || {};

    res.json({
      success: true,
      store: {
        ...store,
        weather: externalData.weather || weatherData[store.id] || null,
        shifts: shifts,
        intelligence: intelligenceData ? {
          insight: intelligenceData.insight,
          severity: intelligenceData.severity,
          metrics: intelligenceData.metrics,
          action: intelligenceData.action,
          todayActions: intelligenceData.todayActions,
          weekOutlook: intelligenceData.weekOutlook,
          carryoutPromotion: intelligenceData.carryoutPromotion,
          preOrderCampaign: intelligenceData.preOrderCampaign,
          promotionSuggestion: intelligenceData.promotionSuggestion,
          laborAdjustment: intelligenceData.laborAdjustment
        } : null,
        events: externalData.events || [],
        traffic: externalData.traffic || null,
        deliveryCapacity: externalData.deliveryCapacity || null,
        boostWeek: externalData.boostWeek || null,
        slowPeriod: externalData.slowPeriod || null,
        upcomingHoliday: externalData.upcomingHoliday || null
      }
    });
  } catch (error) {
    console.error('Error fetching store details:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch store details' 
    });
  }
});


// Store Intelligence API
app.get('/api/stores/:storeId/intelligence', async (req, res) => {
  const { storeId } = req.params;
  const { managerId } = req.query;

  if (!storeId || !managerId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing storeId or managerId' 
    });
  }

  try {
    // Verify manager has access to this store and get all store details
    const accessQuery = `
      SELECT 
        l.*,
        msl.manager_id
      FROM locations l
      JOIN manager_store_links msl ON l.store_id = msl.store_id
      WHERE l.store_id = $1 AND msl.manager_id = $2
    `;
    const accessResult = await pool.query(accessQuery, [storeId, managerId]);

    if (accessResult.rows.length === 0) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied to this store' 
      });
    }

    const store = accessResult.rows[0];

    // Get current shift stats
    const shiftStats = await getStoreShiftStats(store.location_id);
    store.shifts = shiftStats;

    // Generate intelligence
    const intelligence = await intelligenceService.generateStoreInsight(store);

    res.json({
      success: true,
      storeId: storeId,
      intelligence: intelligence
    });
  } catch (error) {
    console.error('Error generating store intelligence:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate intelligence' 
    });
  }
});


// Test intelligence endpoint
app.get('/api/test-intelligence/:storeId', async (req, res) => {
  const { storeId } = req.params;
  
  try {
    const query = `
      SELECT 
        store_id,
        city,
        region,
        store_latitude,
        store_longitude,
        estimated_wait_minutes,
        minimum_delivery_order_amount,
        cash_limit,
        driver_prep_secs,
        driver_finish_secs,
        driver_at_the_door_secs,
        is_online_now,
        is_force_offline,
        is_spanish,
        time_zone_code,
        time_zone_minutes
      FROM locations 
      WHERE store_id = $1
    `;
    
    const store = await pool.query(query, [storeId]);
    
    if (store.rows.length === 0) {
      return res.status(404).json({ error: 'Store not found' });
    }
    
    const intelligence = await intelligenceService.generateStoreInsight(store.rows[0]);
    
    res.json({
      success: true,
      storeData: store.rows[0],
      intelligence
    });
  } catch (error) {
    console.error('Test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CHECKLIST ROUTES ====================

// Get all checklist templates
app.get('/api/checklists/templates', async (req, res) => {
  try {
    const templates = await pool.query(`
      SELECT 
        t.*,
        COUNT(i.item_id) as item_count
      FROM checklist_templates t
      LEFT JOIN checklist_items i ON t.template_id = i.template_id
      WHERE t.is_active = true
      GROUP BY t.template_id
      ORDER BY t.category, t.name
    `);
    
    res.json({ success: true, templates: templates.rows });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch templates' });
  }
});

// Get checklist items for a template
app.get('/api/checklists/templates/:templateId/items', async (req, res) => {
  const { templateId } = req.params;
  
  try {
    const items = await pool.query(`
      SELECT * FROM checklist_items
      WHERE template_id = $1 AND is_active = true
      ORDER BY sort_order, item_id
    `, [templateId]);
    
    res.json({ success: true, items: items.rows });
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch items' });
  }
});

// Get workflows for a store and date
app.get('/api/stores/:storeId/workflows', async (req, res) => {
  const { storeId } = req.params;
  const { date, managerId } = req.query;
  
  if (!managerId) {
    return res.status(400).json({ success: false, message: 'Missing managerId' });
  }
  
  try {
    // Verify manager has access to this store
    const accessCheck = await pool.query(`
      SELECT 1 FROM manager_store_links
      WHERE manager_id = $1 AND store_id = $2
    `, [managerId, storeId]);
    
    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const workflows = await pool.query(`
      SELECT 
        w.*,
        t.name as template_name,
        t.category,
        t.frequency,
        COUNT(DISTINCT c.completion_id) as completed_items,
        COUNT(DISTINCT i.item_id) as total_items,
        m.first_name || ' ' || m.last_name as assigned_to_name
      FROM store_workflows w
      JOIN checklist_templates t ON w.template_id = t.template_id
      LEFT JOIN checklist_items i ON t.template_id = i.template_id AND i.is_active = true
      LEFT JOIN workflow_completions c ON w.workflow_id = c.workflow_id AND c.item_id = i.item_id
      LEFT JOIN managers m ON w.assigned_to = m.manager_id
      WHERE w.store_id = $1 AND w.date = $2::date
      GROUP BY w.workflow_id, t.template_id, m.manager_id
      ORDER BY w.start_time
    `, [storeId, date]);
    
    res.json({ success: true, workflows: workflows.rows });
  } catch (error) {
    console.error('Error fetching workflows:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch workflows' });
  }
});





// Generate workflows for a manager claiming a store
app.post('/api/stores/:storeId/workflows/generate', async (req, res) => {
  const { storeId } = req.params;
  const { managerId, date } = req.body;
  
  if (!managerId) {
    return res.status(400).json({ success: false, message: 'Manager ID required' });
  }
  
  try {
    // First check if workflows already exist
    const existingCheck = await pool.query(
      'SELECT COUNT(*) as count FROM store_workflows WHERE store_id = $1 AND date = $2::date',
      [storeId, date || 'CURRENT_DATE']
    );
    
    if (existingCheck.rows[0].count > 0) {
      // Workflows already exist, just return them
      const workflows = await pool.query(`
        SELECT 
          w.*,
          t.name as template_name,
          t.category,
          t.frequency,
          COUNT(DISTINCT i.item_id) as total_items
        FROM store_workflows w
        JOIN checklist_templates t ON w.template_id = t.template_id
        LEFT JOIN checklist_items i ON t.template_id = i.template_id AND i.is_active = true
        WHERE w.store_id = $1 
          AND w.date = $2::date
        GROUP BY w.workflow_id, t.template_id
        ORDER BY 
          CASE t.frequency 
            WHEN 'daily' THEN 1
            WHEN 'weekly' THEN 2
            WHEN 'monthly' THEN 3
          END
      `, [storeId, date || 'CURRENT_DATE']);
      
      return res.json({ 
        success: true, 
        created: 0,
        workflows: workflows.rows,
        message: 'Workflows already exist'
      });
    }
    
 // No workflows exist, generate them inline
 let createdCount = 0;
    
 try {
   // Get location_id for this store
   const locationResult = await pool.query(
     'SELECT location_id FROM locations WHERE store_id = $1',
     [storeId]
   );
   
   if (locationResult.rows.length === 0) {
     throw new Error('Store not found');
   }
   
   const locationId = locationResult.rows[0].location_id;
   const workflowDate = date || new Date().toISOString().split('T')[0];
   
   // Insert morning checklist workflow
   const insertResult = await pool.query(`
     INSERT INTO store_workflows (
       store_id,
       location_id,
       template_id,
       date,
       shift_type,
       status,
       created_by,
       assigned_to,
       total_points,
       created_at,
       start_time,
       end_time
     ) VALUES (
       $1, $2, 13, $3::date, 'opening', 'pending', $4, $5, 15, NOW(),
       $3::date + TIME '06:00:00',
       $3::date + TIME '11:00:00'
     ) RETURNING workflow_id`,
     [storeId, locationId, workflowDate, managerId, managerId]
   );
   
   if (insertResult.rows.length > 0) {
     createdCount = 1;
   }
 } catch (insertError) {
   console.error('Error creating workflow:', insertError);
   throw insertError;
 }
    
    // Get the generated workflows
    const workflows = await pool.query(`
      SELECT 
        w.*,
        t.name as template_name,
        t.category,
        t.frequency,
        COUNT(DISTINCT i.item_id) as total_items
      FROM store_workflows w
      JOIN checklist_templates t ON w.template_id = t.template_id
      LEFT JOIN checklist_items i ON t.template_id = i.template_id AND i.is_active = true
      WHERE w.store_id = $1 
        AND w.date = $2::date
        AND w.assigned_to = $3
      GROUP BY w.workflow_id, t.template_id
      ORDER BY 
        CASE t.frequency 
          WHEN 'daily' THEN 1
          WHEN 'weekly' THEN 2
          WHEN 'monthly' THEN 3
        END
    `, [storeId, date || 'CURRENT_DATE', managerId]);
    
    res.json({ 
      success: true, 
      created: createdCount,
      workflows: workflows.rows 
    });
  } catch (error) {
    console.error('Error generating workflows:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get workflow details with items and completions
app.get('/api/workflows/:workflowId', async (req, res) => {
  const { workflowId } = req.params;
  
  try {
    // Get workflow details
    const workflowResult = await pool.query(`
      SELECT 
        w.*,
        t.name as template_name,
        t.category,
        t.frequency,
        l.city,
        l.store_name,
        w.store_id,
        w.location_id
      FROM store_workflows w
      JOIN checklist_templates t ON w.template_id = t.template_id
      JOIN locations l ON w.store_id = l.store_id
      WHERE w.workflow_id = $1
    `, [workflowId]);
    
    if (workflowResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Workflow not found' });
    }
    
    const workflow = workflowResult.rows[0];
    
    // Get items with completion status AND action columns
const itemsResult = await pool.query(`
  SELECT 
    i.item_id,
    i.item_text,
    i.item_type,
    i.category,
    i.instructions,
    i.point_value,
    i.time_limit,
    i.critical_violation,
    i.action_if_yes,
    i.action_if_no,
    i.action_trigger,
    i.action_buttons,
    i.log_waste,
    i.take_photo,
    i.sort_order,
    i.min_value,
    i.max_value,
    c.completion_id,
    c.completed_at,
    c.completed_by,
    c.value,
    c.notes,
    null as photo_url,
    c.is_compliant,
    m.first_name || ' ' || m.last_name as completed_by_name,
    CASE 
      WHEN c.completion_id IS NOT NULL THEN true 
      ELSE false 
    END as completed
  FROM checklist_items i
  LEFT JOIN workflow_completions c ON i.item_id = c.item_id AND c.workflow_id = $1
  LEFT JOIN managers m ON c.completed_by = m.manager_id
  WHERE i.template_id = $2 AND i.is_active = true
  ORDER BY i.sort_order, i.item_id
`, [workflowId, workflow.template_id]);
    
    // Transform items to match frontend expectations
const items = itemsResult.rows.map(item => ({
  item_id: item.item_id,
  item_text: item.item_text,
  item_type: item.item_type,
  category: item.category,
  instructions: item.instructions,
  point_value: item.point_value,
  time_limit: item.time_limit,
  critical_violation: item.critical_violation,
  action_if_yes: item.action_if_yes,
  action_if_no: item.action_if_no,
  action_trigger: item.action_trigger,
  action_buttons: item.action_buttons,
  log_waste: item.log_waste,
  take_photo: item.take_photo,
  sort_order: item.sort_order,
  min_value: item.min_value,
  max_value: item.max_value,
  completion_id: item.completion_id,  // ADD THIS LINE
  completed: item.completed,
  value: item.value,
  is_compliant: item.is_compliant,
  notes: item.notes,
  photo_url: null,
  completed_at: item.completed_at,
  completed_by: item.completed_by,
  completed_by_name: item.completed_by_name
}));
    
    res.json({ 
      success: true, 
      workflow,
      items 
    });
  } catch (error) {
    console.error('Error fetching workflow details:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch workflow details' });
  }
});

// Add new endpoint for logging issues
app.post('/api/issue-logs', async (req, res) => {
  const { workflow_id, item_id, issue_type, description, logged_by } = req.body;

try {
  const result = await pool.query(
    `INSERT INTO issue_logs 
    (workflow_id, item_id, issue_type, description, logged_by, logged_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING *`,
    [workflow_id, item_id, issue_type, description, logged_by]
  );
    
    res.json({ success: true, issue_log: result.rows[0] });
  } catch (error) {
    console.error('Error logging issue:', error);
    res.status(500).json({ success: false, message: 'Failed to log issue' });
  }
});

// Update the complete workflow endpoint to handle multiple completions at once
app.post('/api/workflows/:workflowId/complete', async (req, res) => {
  const { workflowId } = req.params;
  const { completions, completed_by } = req.body;
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Insert all completions
    for (const completion of completions) {
      // Check if already completed
      const existingCheck = await client.query(
        'SELECT completion_id FROM workflow_completions WHERE workflow_id = $1 AND item_id = $2',
        [workflowId, completion.item_id]
      );
      
      if (existingCheck.rows.length > 0) {
        // Update existing
        await client.query(`
          UPDATE workflow_completions
          SET value = $1, is_compliant = $2, notes = $3,
              completed_by = $4, completed_at = NOW()
                WHERE workflow_id = $5 AND item_id = $6
                `, [
                  completion.value, 
                  completion.is_compliant, 
                  completion.notes, 
                  completed_by, 
                  workflowId, 
                  completion.item_id
                ]);
      } else {
        // Insert new
        await client.query(`
          INSERT INTO workflow_completions (
  workflow_id, item_id, completed_by, value, is_compliant, notes
) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          workflowId, 
          completion.item_id, 
          completed_by, 
          completion.value, 
          completion.is_compliant, 
          completion.notes, 
        ]);
      }
    }
    
    // Calculate compliance and update workflow
    const complianceResult = await client.query(`
      SELECT 
        COUNT(DISTINCT ci.item_id) as total_items,
        COUNT(DISTINCT wc.item_id) as completed_items,
        COUNT(DISTINCT CASE WHEN wc.is_compliant = true THEN wc.item_id END) as compliant_items,
        SUM(CASE WHEN wc.is_compliant = true THEN ci.point_value ELSE 0 END) as earned_points,
        SUM(ci.point_value) as total_points
      FROM checklist_items ci
      LEFT JOIN workflow_completions wc ON ci.item_id = wc.item_id AND wc.workflow_id = $1
      WHERE ci.template_id = (SELECT template_id FROM store_workflows WHERE workflow_id = $1)
        AND ci.is_active = true
    `, [workflowId]);
    
    const stats = complianceResult.rows[0];
    const completionPercentage = (parseInt(stats.completed_items) / parseInt(stats.total_items)) * 100;
    const compliancePercentage = parseInt(stats.total_items) > 0 
      ? (parseInt(stats.compliant_items) / parseInt(stats.total_items)) * 100 
      : 0;
    
    // Update workflow status
    const status = completionPercentage === 100 ? 'completed' : 'in_progress';
    
    await client.query(`
      UPDATE store_workflows
      SET status = $1,
          compliance_percentage = $2,
          earned_points = $3,
          total_points = $4,
          completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE NULL END
      WHERE workflow_id = $5
    `, [status, compliancePercentage, stats.earned_points || 0, stats.total_points || 0, workflowId]);
    
    await client.query('COMMIT');
    
    res.json({ 
      success: true,
      workflow_id: workflowId,
      status: status,
      compliance_percentage: compliancePercentage,
      earned_points: stats.earned_points || 0,
      total_points: stats.total_points || 0
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error completing workflow:', error);
    res.status(500).json({ success: false, message: 'Failed to complete workflow' });
  } finally {
    client.release();
  }
});

// Complete a checklist item
app.post('/api/workflows/:workflowId/items/:itemId/complete', async (req, res) => {
  const { workflowId, itemId } = req.params;
  const { managerId, value, notes } = req.body;
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get item details for validation
    const itemResult = await client.query(`
      SELECT * FROM checklist_items WHERE item_id = $1
    `, [itemId]);
    
    if (itemResult.rows.length === 0) {
      throw new Error('Item not found');
    }
    
    const item = itemResult.rows[0];
    
    // Validate value based on item type
let isCompliant = true;
if (item.item_type === 'temperature') {
  const numValue = parseFloat(value);
  const minValue = parseFloat(item.min_value);
  const maxValue = parseFloat(item.max_value);
  
  if (!isNaN(minValue) && numValue < minValue) isCompliant = false;
  if (!isNaN(maxValue) && numValue > maxValue) isCompliant = false;
  
  console.log('Temperature validation:', {
    value: numValue,
    min: minValue,
    max: maxValue,
    isCompliant: isCompliant
  });
}
    // Check if already completed
    const existingCompletion = await client.query(`
      SELECT completion_id FROM workflow_completions
      WHERE workflow_id = $1 AND item_id = $2
    `, [workflowId, itemId]);
    
    if (existingCompletion.rows.length > 0) {
      // Update existing completion
      await client.query(`
        UPDATE workflow_completions
        SET value = $1, is_compliant = $2, notes = $3,
    completed_by = $4, completed_at = NOW()
WHERE workflow_id = $5 AND item_id = $6
`, [value, isCompliant, notes, managerId, workflowId, itemId]);
    } else {
      // Insert new completion
      await client.query(`
        INSERT INTO workflow_completions (
  workflow_id, item_id, completed_by, value, is_compliant, notes
) VALUES ($1, $2, $3, $4, $5, $6)
`, [workflowId, itemId, managerId, value, isCompliant, notes]);
    }
    
    // Check if ALL items are completed
    const completionCheck = await client.query(`
      SELECT 
        COUNT(DISTINCT i.item_id) as total_items,
        COUNT(DISTINCT c.item_id) as completed_items
      FROM checklist_items i
      LEFT JOIN workflow_completions c ON i.item_id = c.item_id AND c.workflow_id = $1
      WHERE i.template_id = (SELECT template_id FROM store_workflows WHERE workflow_id = $1)
        AND i.is_active = true
    `, [workflowId]);

    const { total_items, completed_items } = completionCheck.rows[0];

    // Update workflow status based on completion
    if (parseInt(total_items) === parseInt(completed_items) && parseInt(total_items) > 0) {
      // Calculate total points earned ONLY for compliant items
      const pointsResult = await client.query(`
        SELECT SUM(ci.point_value) as total_earned
        FROM workflow_completions wc
        JOIN checklist_items ci ON wc.item_id = ci.item_id
        WHERE wc.workflow_id = $1 AND wc.is_compliant = true
      `, [workflowId]);
      
      const earnedPoints = pointsResult.rows[0].total_earned || 0;
      
      await client.query(`
        UPDATE store_workflows
        SET status = 'completed', 
            completed_at = NOW(),
            compliance_percentage = 100,
            earned_points = $2
        WHERE workflow_id = $1
      `, [workflowId, earnedPoints]);
    } else {
      // Still in progress - update percentage and partial points
      const percentage = parseInt(total_items) > 0 
        ? Math.round((parseInt(completed_items) / parseInt(total_items)) * 100)
        : 0;
      
      // Calculate partial points earned so far
      const partialPointsResult = await client.query(`
        SELECT SUM(ci.point_value) as partial_earned
        FROM workflow_completions wc
        JOIN checklist_items ci ON wc.item_id = ci.item_id
        WHERE wc.workflow_id = $1 AND wc.is_compliant = true
      `, [workflowId]);
      
      const partialPoints = partialPointsResult.rows[0].partial_earned || 0;
      
      await client.query(`
        UPDATE store_workflows
        SET status = 'in_progress',
            compliance_percentage = $2,
            earned_points = $3
        WHERE workflow_id = $1
      `, [workflowId, percentage, partialPoints]);
    }
    
    // Log temperature if applicable
if (item.item_type === 'temperature') {
  const workflowInfo = await client.query(`
    SELECT store_id, location_id FROM store_workflows WHERE workflow_id = $1
  `, [workflowId]);
  
  const { store_id, location_id } = workflowInfo.rows[0];
  
  // Extract equipment type from item text (e.g., "walk-in cooler" from "Is walk-in cooler between 33°F-38°F?")
  const equipment_type = item.item_text.toLowerCase().includes('walk-in') ? 'walk_in_cooler' :
                        item.item_text.toLowerCase().includes('makeline') ? 'makeline_cooler' :
                        item.item_text.toLowerCase().includes('beverage') ? 'beverage_cooler' :
                        item.category;
  
  const tempLogResult = await client.query(`
    INSERT INTO temperature_logs (
      store_id, location_id, workflow_id, item_id, equipment_type, 
      temperature, unit, is_compliant, logged_by, notes, photo_urls
    ) VALUES ($1, $2, $3, $4, $5, $6, 'F', $7, $8, $9, '[]'::jsonb)
    ON CONFLICT (workflow_id, item_id) 
    DO UPDATE SET 
      temperature = EXCLUDED.temperature,
      is_compliant = EXCLUDED.is_compliant,
      notes = EXCLUDED.notes,
      logged_at = CURRENT_TIMESTAMP
    RETURNING log_id
  `, [store_id, location_id, workflowId, itemId, equipment_type, 
      parseFloat(value), isCompliant, managerId, notes]);
  
  // Link to workflow completion
  const temp_log_id = tempLogResult.rows[0].log_id;
  await client.query(
    'UPDATE workflow_completions SET temperature_log_id = $1 WHERE workflow_id = $2 AND item_id = $3',
    [temp_log_id, workflowId, itemId]
  );
}
    
    // Check for critical violations
    // Log temperature issues to manager_store_issue_logs
if (item.item_type === 'temperature' && !isCompliant) {
  const issueType = temp < minValue ? 'temperature_low' : 'temperature_high';
  const actionTaken = item.action_if_no || 'Temperature out of range - action required';
  
  await client.query(`
    INSERT INTO manager_store_issue_logs (
      workflow_id,
      item_id,
      issue_type,
      issue_value,
      action_taken,
      logged_by,
      logged_at,
      resolved
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), false)
  `, [
    workflowId,
    itemId,
    issueType,
    value,
    actionTaken,
    managerId
  ]);
}

// Still log critical violations if needed
if (item.critical_violation && !isCompliant) {
  const workflowInfo = await client.query(`
    SELECT store_id, location_id FROM store_workflows WHERE workflow_id = $1
  `, [workflowId]);
  
  const { store_id, location_id } = workflowInfo.rows[0];
  
  await client.query(`
    INSERT INTO critical_violations (
      store_id, location_id, violation_type, description,
      severity, points_deducted, discovered_by, workflow_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    store_id, 
    location_id, 
    item.category, 
    `${item.item_text} - Value: ${value}`,
    'high',
    10,
    managerId,
    workflowId
  ]);
}
    
    await client.query('COMMIT');
    
    // Return updated workflow status with point information
    const updatedWorkflow = await client.query(`
      SELECT 
        w.*,
        COUNT(DISTINCT c.completion_id) as completed_items,
        COUNT(DISTINCT i.item_id) as total_items,
        w.earned_points,
        w.total_points
      FROM store_workflows w
      JOIN checklist_items i ON w.template_id = i.template_id AND i.is_active = true
      LEFT JOIN workflow_completions c ON w.workflow_id = c.workflow_id AND c.item_id = i.item_id
      WHERE w.workflow_id = $1
      GROUP BY w.workflow_id
    `, [workflowId]);

    res.json({ 
      success: true, 
      isCompliant,
      workflow: updatedWorkflow.rows[0],
      pointsEarned: item.point_value * (isCompliant ? 1 : 0)
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error completing item:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});


// Get issue logs for a workflow or store
app.get('/api/manager-store-issue-logs', async (req, res) => {
  const { workflow_id, store_id, resolved } = req.query;
  
  try {
    let query = `
      SELECT 
        il.*,
        ci.item_text,
        ci.category,
        m.first_name || ' ' || m.last_name as logged_by_name
      FROM manager_store_issue_logs il
      JOIN checklist_items ci ON il.item_id = ci.item_id
      LEFT JOIN managers m ON il.logged_by = m.manager_id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (workflow_id) {
      query += ` AND il.workflow_id = $${paramIndex}`;
      params.push(workflow_id);
      paramIndex++;
    }
    
    if (store_id) {
      query += ` AND il.workflow_id IN (SELECT workflow_id FROM store_workflows WHERE store_id = $${paramIndex})`;
      params.push(store_id);
      paramIndex++;
    }
    
    if (resolved !== undefined) {
      query += ` AND il.resolved = $${paramIndex}`;
      params.push(resolved === 'true');
    }
    
    query += ' ORDER BY il.logged_at DESC';
    
    const result = await pool.query(query, params);
    
    res.json({ success: true, issues: result.rows });
  } catch (error) {
    console.error('Error fetching issue logs:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch issue logs' });
  }
});

// Mark issue as resolved
app.put('/api/manager-store-issue-logs/:logId/resolve', async (req, res) => {
  const { logId } = req.params;
  const { resolved_by, resolution_notes } = req.body;
  
  try {
    const result = await pool.query(`
      UPDATE manager_store_issue_logs
      SET 
        resolved = true,
        resolved_at = NOW(),
        action_taken = action_taken || E'\n\nResolution: ' || $2
      WHERE log_id = $1
      RETURNING *
    `, [logId, resolution_notes || 'Resolved']);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Issue log not found' });
    }
    
    res.json({ success: true, issue: result.rows[0] });
  } catch (error) {
    console.error('Error resolving issue:', error);
    res.status(500).json({ success: false, message: 'Failed to resolve issue' });
  }
});




// Debug endpoint - REMOVE AFTER TESTING
app.get('/api/debug/workflow/:workflowId', async (req, res) => {
  const { workflowId } = req.params;
  
  try {
    const itemsResult = await pool.query(`
      SELECT 
        item_id,
        item_text,
        action_if_yes,
        action_if_no,
        action_trigger,
        action_buttons
      FROM checklist_items i
      WHERE i.template_id = (
        SELECT template_id FROM store_workflows WHERE workflow_id = $1
      )
      AND i.item_id = 31
      LIMIT 1
    `, [workflowId]);
    
    res.json({ 
      success: true, 
      item: itemsResult.rows[0],
      hasActionFields: {
        action_if_yes: itemsResult.rows[0]?.action_if_yes !== null,
        action_if_no: itemsResult.rows[0]?.action_if_no !== null,
        action_trigger: itemsResult.rows[0]?.action_trigger !== null,
        action_buttons: itemsResult.rows[0]?.action_buttons !== null
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get temperature logs for a store
app.get('/api/stores/:storeId/temperatures', async (req, res) => {
  const { storeId } = req.params;
  const { date, equipment } = req.query;
  
  try {
    let query = `
      SELECT 
        t.*,
        m.first_name || ' ' || m.last_name as logged_by_name
      FROM temperature_logs t
      LEFT JOIN managers m ON t.logged_by = m.manager_id
      WHERE t.store_id = $1
    `;
    
    const params = [storeId];
    let paramIndex = 2;
    
    if (date) {
      query += ` AND DATE(t.logged_at) = $${paramIndex}::date`;
      params.push(date);
      paramIndex++;
    }
    
    if (equipment) {
      query += ` AND t.equipment_type = $${paramIndex}`;
      params.push(equipment);
    }
    
    query += ' ORDER BY t.logged_at DESC LIMIT 100';
    
    const result = await pool.query(query, params);
    
    res.json({ success: true, temperatures: result.rows });
  } catch (error) {
    console.error('Error fetching temperatures:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch temperatures' });
  }
});

// Get store compliance summary
app.get('/api/stores/:storeId/compliance', async (req, res) => {
  const { storeId } = req.params;
  const { startDate, endDate } = req.query;
  
  try {
    // Overall compliance percentage
    const complianceResult = await pool.query(`
      SELECT 
        AVG(compliance_percentage) as average_compliance,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_checklists,
        COUNT(CASE WHEN status = 'missed' THEN 1 END) as missed_checklists,
        COUNT(*) as total_checklists
      FROM store_workflows
      WHERE store_id = $1 
        AND date >= COALESCE($2::date, CURRENT_DATE - INTERVAL '30 days')
        AND date <= COALESCE($3::date, CURRENT_DATE)
    `, [storeId, startDate || null, endDate || null]);
    
    // Recent violations
    const violationsResult = await pool.query(`
      SELECT 
        v.*,
        m.first_name || ' ' || m.last_name as discovered_by_name
      FROM critical_violations v
      LEFT JOIN managers m ON v.discovered_by = m.manager_id
      WHERE v.store_id = $1 
        AND v.discovered_at >= NOW() - INTERVAL '30 days'
        AND v.resolved_at IS NULL
      ORDER BY v.discovered_at DESC
      LIMIT 10
    `, [storeId]);
    
    // Compliance by category
    const categoryResult = await pool.query(`
      SELECT 
        i.category,
        COUNT(DISTINCT c.completion_id) as completed_items,
        COUNT(DISTINCT i.item_id) as total_items,
        COUNT(DISTINCT CASE WHEN c.is_compliant = false THEN c.completion_id END) as non_compliant_items
      FROM store_workflows w
      JOIN checklist_items i ON i.template_id = w.template_id
      LEFT JOIN workflow_completions c ON c.workflow_id = w.workflow_id AND c.item_id = i.item_id
      WHERE w.store_id = $1 
        AND w.date >= COALESCE($2::date, CURRENT_DATE - INTERVAL '7 days')
        AND i.is_active = true
      GROUP BY i.category
    `, [storeId, startDate || null]);
    
    res.json({
      success: true,
      compliance: complianceResult.rows[0],
      violations: violationsResult.rows,
      categoryBreakdown: categoryResult.rows
    });
  } catch (error) {
    console.error('Error fetching compliance:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch compliance data' });
  }
});

// Get manager's point summary
app.get('/api/managers/:managerId/points', async (req, res) => {
  const { managerId } = req.params;
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();
  
  try {
    const pointsResult = await pool.query(`
      SELECT 
        SUM(w.earned_points) as points_earned,
        SUM(w.total_points) as points_possible,
        COUNT(DISTINCT w.workflow_id) as workflows_completed,
        COUNT(DISTINCT w.store_id) as stores_managed
      FROM store_workflows w
      WHERE w.assigned_to = $1
        AND w.status = 'completed'
        AND EXTRACT(MONTH FROM w.date) = $2
        AND EXTRACT(YEAR FROM w.date) = $3
    `, [managerId, targetMonth, targetYear]);
    
    // Get breakdown by frequency
    const breakdownResult = await pool.query(`
      SELECT 
        t.frequency,
        SUM(w.earned_points) as points_earned,
        SUM(w.total_points) as points_possible,
        COUNT(w.workflow_id) as count
      FROM store_workflows w
      JOIN checklist_templates t ON w.template_id = t.template_id
      WHERE w.assigned_to = $1
        AND EXTRACT(MONTH FROM w.date) = $2
        AND EXTRACT(YEAR FROM w.date) = $3
      GROUP BY t.frequency
    `, [managerId, targetMonth, targetYear]);
    
    res.json({
      success: true,
      summary: pointsResult.rows[0],
      breakdown: breakdownResult.rows
    });
  } catch (error) {
    console.error('Error fetching points:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch points' });
  }
});


// Get available points for today
app.get('/api/stores/:storeId/points/today', async (req, res) => {
  const { storeId } = req.params;
  const { managerId } = req.query;
  
  try {
    const result = await pool.query(`
      SELECT 
        SUM(w.total_points) as total_available,
        SUM(w.earned_points) as total_earned,
        COUNT(CASE WHEN w.status = 'completed' THEN 1 END) as completed_count,
        COUNT(*) as total_count
      FROM store_workflows w
      WHERE w.store_id = $1 
        AND w.date = CURRENT_DATE
        AND ($2::int IS NULL OR w.assigned_to = $2)
    `, [storeId, managerId || null]);
    
    res.json({ success: true, points: result.rows[0] });
  } catch (error) {
    console.error('Error fetching today\'s points:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch points' });
  }
});

const cron = require('node-cron');


// Log waste items
app.post('/api/waste-logs', async (req, res) => {
  const { workflow_id, item_id, manager_id, item_name, amount, amount_unit, reason, image_url } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO waste_logs 
      (workflow_id, item_id, manager_id, item_name, amount, amount_unit, reason, image_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [workflow_id, item_id, manager_id, item_name, amount, amount_unit, reason, image_url]
    );
    
    res.json({ success: true, waste_log: result.rows[0] });
  } catch (error) {
    console.error('Error logging waste:', error);
    res.status(500).json({ success: false, message: 'Failed to log waste' });
  }
});



// POST /api/temperature-logs
app.post('/api/temperature-logs', upload.single('photo'), async (req, res) => {
  console.log('Temperature log endpoint hit');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  console.log('File:', req.file);
  
  const { 
    workflow_id,
    item_id,
    store_id,
    location_id,
    equipment_type, 
    temperature, 
    logged_by 
  } = req.body;
  
  // Add validation
  if (!workflow_id || !item_id || !store_id || !location_id || !temperature || !logged_by) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields',
      received: { workflow_id, item_id, store_id, location_id, equipment_type, temperature, logged_by }
    });
  }
  
  try {
    // Check if temperature is compliant
    const itemResult = await pool.query(
      'SELECT min_value, max_value FROM checklist_items WHERE item_id = $1',
      [item_id]
    );
    
    const item = itemResult.rows[0];
    const temp = parseFloat(temperature);
    const is_compliant = temp >= item.min_value && temp <= item.max_value;
    
    // Create or update temperature log
    const logResult = await pool.query(`
      INSERT INTO temperature_logs 
      (store_id, location_id, workflow_id, item_id, equipment_type, temperature, unit, is_compliant, logged_by, photo_urls)
      VALUES ($1, $2, $3, $4, $5, $6, 'F', $7, $8, '[]'::jsonb)
      ON CONFLICT (workflow_id, item_id) 
      DO UPDATE SET 
        temperature = EXCLUDED.temperature,
        is_compliant = EXCLUDED.is_compliant,
        logged_at = CURRENT_TIMESTAMP,
        photo_urls = temperature_logs.photo_urls
      RETURNING log_id, photo_urls
    `, [store_id, location_id, workflow_id, item_id, equipment_type, temperature, is_compliant, logged_by]);
    
    const log_id = logResult.rows[0].log_id;
    let photo_urls = logResult.rows[0].photo_urls || [];
    
    // If photo was uploaded, upload to GCS and add to array
if (req.file) {
  try {
    const photoUrl = await uploadToGCS(req.file);
    photo_urls.push({
      url: photoUrl,
      uploaded_at: new Date().toISOString(),
      uploaded_by: parseInt(logged_by)
    });
  } catch (uploadError) {
    console.error('Error uploading to GCS:', uploadError);
    throw new Error('Failed to upload photo to cloud storage');
  }
}
    
    // Update the workflow completion with temperature_log_id
    await pool.query(`
      UPDATE workflow_completions 
      SET temperature_log_id = $1 
      WHERE workflow_id = $2 AND item_id = $3
    `, [log_id, workflow_id, item_id]);
    
    res.json({
      success: true,
      log_id,
      is_compliant,
      photo_urls
    });
  } catch (error) {
    console.error('Error logging temperature:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to log temperature',
      error: error.message 
    });
  }
});

// POST /api/temperature-logs/:logId/photos - Add additional photos to existing log
app.post('/api/temperature-logs/:logId/photos', upload.single('photo'), async (req, res) => {
  const { logId } = req.params;
  const { uploaded_by } = req.body;
  
  try {
    // Get current photos
    const result = await pool.query(
      'SELECT photo_urls FROM temperature_logs WHERE log_id = $1',
      [logId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Temperature log not found' });
    }
    
    let photo_urls = result.rows[0].photo_urls || [];
    
    // Upload and add new photo
    if (req.file) {
      const photoUrl = req.file.location || req.file.path;
      photo_urls.push({
        url: photoUrl,
        uploaded_at: new Date().toISOString(),
        uploaded_by: parseInt(uploaded_by)
      });
      
      // Update the array
      await pool.query(
        'UPDATE temperature_logs SET photo_urls = $1::jsonb WHERE log_id = $2',
        [JSON.stringify(photo_urls), logId]
      );
      
      res.json({
        success: true,
        photo_urls
      });
    } else {
      res.status(400).json({ success: false, message: 'No photo provided' });
    }
  } catch (error) {
    console.error('Error adding photo:', error);
    res.status(500).json({ success: false, message: 'Failed to add photo' });
  }
});






// Generate workflows at 4 AM daily
cron.schedule('0 4 * * *', async () => {
  console.log('Generating daily workflows...');
  try {
    // Call your workflow generation logic directly
    const storesQuery = `SELECT DISTINCT l.store_id, l.location_id, msl.manager_id
                     FROM locations l
                     JOIN manager_store_links msl ON l.store_id = msl.store_id
                     WHERE l.is_online_now = true`;
    const stores = await pool.query(storesQuery);
    
// Generate workflows for each store
for (const store of stores.rows) {
  try {
    // Check if workflow already exists for today
    const existingCheck = await pool.query(
      'SELECT COUNT(*) as count FROM store_workflows WHERE store_id = $1 AND date = CURRENT_DATE AND template_id = 13',
      [store.store_id]
    );
    
    if (existingCheck.rows[0].count === 0) {
      // Create morning checklist workflow
      await pool.query(`
        INSERT INTO store_workflows (
          store_id, location_id, template_id, date, shift_type,
          status, created_by, assigned_to, total_points, created_at,
          start_time, end_time
        ) VALUES (
          $1, $2, 13, CURRENT_DATE, 'opening', 'pending', $3, $3, 15, NOW(),
          CURRENT_DATE + TIME '06:00:00',
          CURRENT_DATE + TIME '11:00:00'
        )`,
        [store.store_id, store.location_id, store.manager_id]
      );
      console.log(`✅ Generated morning checklist for store ${store.store_id}`);
    }
  } catch (err) {
    console.error(`Failed to generate workflow for store ${store.store_id}:`, err.message);
  }
}
console.log('Daily workflow generation completed');
  } catch (error) {
    console.error('Cron job error:', error);
  }
});

const PORT = process.env.PORT || 5003;
app.listen(PORT, () => {
  console.log('✅ Manager backend is up and running on port', PORT);
});






