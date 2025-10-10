// controllers/couponsController.js

// Cache to prevent hitting the API too frequently
const couponCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Helper function to add delay between requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Dynamically import the ESM module
let Store;
(async () => {
  const dominosModule = await import('dominos');
  Store = dominosModule.Store;
})();

// Get coupons for a single store
exports.getStoreCoupons = async (req, res) => {
  try {
    // Make sure Store is loaded
    if (!Store) {
      const dominosModule = await import('dominos');
      Store = dominosModule.Store;
    }

    const { storeId } = req.params;
    
    // Check cache first
    const cached = couponCache.get(storeId);
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
      return res.json({
        storeId,
        coupons: cached.coupons,
        cached: true,
        fetchedAt: cached.timestamp
      });
    }

    // Fetch from Domino's API
    const store = await new Store(storeId);
    const coupons = store.menu?.coupons || {};
    
    // Transform coupons into a more usable format
    const formattedCoupons = Object.entries(coupons).map(([code, details]) => ({
      code,
      name: details.name || 'Unnamed Coupon',
      description: details.description || '',
      price: details.price || null,
      tags: details.tags || [],
      imageCode: details.imageCode || null
    }));

    // Cache the result
    couponCache.set(storeId, {
      coupons: formattedCoupons,
      timestamp: Date.now()
    });

    res.json({
      storeId,
      coupons: formattedCoupons,
      cached: false,
      fetchedAt: Date.now()
    });

  } catch (error) {
    console.error(`Error fetching coupons for store ${req.params.storeId}:`, error);
    res.status(500).json({ 
      error: 'Failed to fetch coupons',
      message: error.message,
      storeId: req.params.storeId
    });
  }
};

// Get coupons for multiple stores
exports.getMultipleStoreCoupons = async (req, res) => {
  try {
    // Make sure Store is loaded
    if (!Store) {
      const dominosModule = await import('dominos');
      Store = dominosModule.Store;
    }

    const { storeIds } = req.body; // Expecting array of store IDs
    
    if (!Array.isArray(storeIds) || storeIds.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of store IDs' });
    }

    const results = [];
    const errors = [];
    
    // Process stores in batches to respect rate limits
    const batchSize = 5;
    for (let i = 0; i < storeIds.length; i += batchSize) {
      const batch = storeIds.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (storeId) => {
        try {
          // Check cache first
          const cached = couponCache.get(storeId);
          if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
            return {
              storeId,
              coupons: cached.coupons,
              cached: true
            };
          }

          // Fetch from API
          const storeApi = await new Store(storeId);
          const coupons = storeApi.menu?.coupons || {};
          
          const formattedCoupons = Object.entries(coupons).map(([code, details]) => ({
            code,
            name: details.name || 'Unnamed Coupon',
            description: details.description || '',
            price: details.price || null,
            tags: details.tags || [],
            imageCode: details.imageCode || null
          }));

          // Cache the result
          couponCache.set(storeId, {
            coupons: formattedCoupons,
            timestamp: Date.now()
          });

          return {
            storeId,
            coupons: formattedCoupons,
            cached: false
          };
        } catch (error) {
          errors.push({
            storeId,
            error: error.message
          });
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
      
      // Add delay between batches to respect rate limits
      if (i + batchSize < storeIds.length) {
        await sleep(2000); // 2 second delay between batches
      }
    }

    res.json({
      success: true,
      totalRequested: storeIds.length,
      successfulFetches: results.length,
      failedFetches: errors.length,
      data: results,
      errors: errors.length > 0 ? errors : undefined,
      fetchedAt: Date.now()
    });

  } catch (error) {
    console.error('Error fetching multiple store coupons:', error);
    res.status(500).json({ 
      error: 'Failed to fetch coupons',
      message: error.message 
    });
  }
};

// Clear cache endpoint
exports.clearCache = (req, res) => {
  couponCache.clear();
  res.json({ message: 'Cache cleared successfully' });
};