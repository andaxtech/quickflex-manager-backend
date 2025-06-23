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

// ✅ Ping route
app.get('/api/ping', (req, res) => {
  res.send('Manager backend is alive');
});

// ✅ Store verification + link to manager
app.post('/api/verify-store', async (req, res) => {
  const { storeId, fcode, managerId } = req.body;

  if (!storeId || !fcode || !managerId) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    const checkQuery = `
      SELECT store_id AS id, city FROM locations
      WHERE store_id = $1 AND fcode = $2
    `;
    const checkResult = await pool.query(checkQuery, [storeId, fcode]);

    if (checkResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'FCODE PIN and Store ID don’t match.',
      });
    }

    const store = checkResult.rows[0];

    // Optional: check for existing link
    const existsQuery = `
      SELECT 1 FROM manager_store_links
      WHERE manager_id = $1 AND store_id = $2
    `;
    const exists = await pool.query(existsQuery, [managerId, store.id]);
    if (exists.rows.length > 0) {
      return res.json({
        success: true,
        store,
        message: 'Store already linked to manager',
      });
    }

    // Link manager to store
    const insertQuery = `
      INSERT INTO manager_store_links (manager_id, store_id, added_at)
      VALUES ($1, $2, NOW())
    `;
    await pool.query(insertQuery, [managerId, store.id]);

    res.json({
      success: true,
      store,
      message: 'Store successfully linked to manager',
    });

  } catch (err) {
    console.error('❌ Error in /api/verify-store:', err);
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
