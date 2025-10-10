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
    
    // Deep dive into the menu structure
    let couponsLocation = 'not found';
    let couponsData = null;
    
    // Check all possible locations
    if (store.menu?.coupons) {
      couponsLocation = 'store.menu.coupons';
      couponsData = store.menu.coupons;
    } else if (store.menu?.menu?.Coupons) {
      couponsLocation = 'store.menu.menu.Coupons';
      couponsData = store.menu.menu.Coupons;
    } else if (store.menu?.menu?.coupons) {
      couponsLocation = 'store.menu.menu.coupons';
      couponsData = store.menu.menu.coupons;
    } else if (store.coupons) {
      couponsLocation = 'store.coupons';
      couponsData = store.coupons;
    }
    
    res.json({
      storeId,
      storeInfo: {
        address: store.info?.AddressDescription,
        phone: store.info?.Phone
      },
      menuStructure: {
        hasMenu: !!store.menu,
        menuKeys: store.menu ? Object.keys(store.menu) : [],
        menuMenuKeys: store.menu?.menu ? Object.keys(store.menu.menu).slice(0, 20) : [],
      },
      coupons: {
        location: couponsLocation,
        found: !!couponsData,
        count: couponsData ? Object.keys(couponsData).length : 0,
        sampleCodes: couponsData ? Object.keys(couponsData).slice(0, 5) : []
      },
      // Return raw menu.menu object keys to inspect
      rawMenuInspection: store.menu?.menu ? {
        type: typeof store.menu.menu,
        isArray: Array.isArray(store.menu.menu),
        keys: Object.keys(store.menu.menu).filter(k => 
          k.toLowerCase().includes('coupon') || 
          k.toLowerCase().includes('deal') || 
          k.toLowerCase().includes('offer') ||
          k.toLowerCase().includes('promo')
        )
      } : null
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      stack: error.stack
    });
  }
});

module.exports = router;