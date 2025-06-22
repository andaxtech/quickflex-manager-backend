const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/ping', (req, res) => {
  res.send('Manager backend is alive');
});

const PORT = process.env.PORT || 5003;
app.listen(PORT, () => {
  console.log('✅ Manager backend is up and running on port', PORT);
});

