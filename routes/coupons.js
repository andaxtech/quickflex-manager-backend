// routes/coupons.js
const express = require('express');
const router = express.Router();
const couponsController = require('../controllers/couponsController');

// Get coupons for a single store
router.get('/:storeId', couponsController.getStoreCoupons);

// Get coupons for multiple stores
router.post('/batch', couponsController.getMultipleStoreCoupons);

// Clear cache
router.post('/clear-cache', couponsController.clearCache);

module.exports = router;