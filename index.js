const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Test route
app.get('/api/ping', (req, res) => {
  res.send('Manager backend is alive');
});

// Store verification route
app.post('/api/verify-store', (req, res) => {
  const { storeId, fcode } = req.body;

  // 🔐 Temporary hardcoded valid store list
  const validStores = [
    { id: '2034', fcode: '1111', city: 'Los Angeles' },
    { id: '2035', fcode: '2222', city: 'Glendale' },
    { id: '2036', fcode: '3333', city: 'Anaheim' },
  ];

  const store = validStores.find(
    (s) => s.id === storeId && s.fcode === fcode
  );

  if (store) {
    res.json({ success: true, store: { id: store.id, city: store.city } });
  } else {
    res.status(401).json({ success: false, message: 'Invalid Store ID or FCODE PIN' });
  }
});

const PORT = process.env.PORT || 5003;
app.listen(PORT, () => {
  console.log('✅ Manager backend is up and running on port', PORT);
});
