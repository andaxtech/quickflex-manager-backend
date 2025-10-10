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

// Debug endpoint to inspect store structure
router.get('/debug/:storeId', async (req, res) => {
    try {
      const dominosModule = await import('dominos');
      const Store = dominosModule.Store;
      
      const { storeId } = req.params;
      const store = await new Store(storeId);
      
      // Get the actual coupons
      let actualCoupons = {};
      const couponCategories = store.menu?.menu?.coupons || {};
      
      // Extract coupons from products
      if (couponCategories.products) {
        actualCoupons = { ...actualCoupons, ...couponCategories.products };
      }
      
      // Get first 3 coupons with details
      const sampleCoupons = Object.entries(actualCoupons).slice(0, 3).map(([code, data]) => ({
        code,
        name: data.name || data.Name,
        description: data.description || data.Description,
        price: data.price || data.Price
      }));
      
      res.json({
        storeId,
        couponsFound: Object.keys(actualCoupons).length,
        couponCategories: Object.keys(couponCategories),
        sampleCoupons,
        // Also check shortCouponDescriptions for readable names
        shortDescriptions: couponCategories.shortCouponDescriptions ? 
          Object.entries(couponCategories.shortCouponDescriptions).slice(0, 5) : null
      });
    } catch (error) {
      res.status(500).json({ 
        error: error.message,
        stack: error.stack
      });
    }
  });

module.exports = router;