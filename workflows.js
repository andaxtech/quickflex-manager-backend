// In your routes file (e.g., /routes/workflows.js)
const express = require('express');
const router = express.Router();

// Generate daily workflows for all stores
router.post('/workflows/generate-daily', async (req, res) => {
  try {
    const { date = new Date() } = req.body;
    
    // Get all active stores with managers
    const storesQuery = `
      SELECT DISTINCT 
        s.store_id,
        s.location_id,
        sm.manager_id,
        sm.user_id
      FROM stores s
      JOIN store_managers sm ON s.store_id = sm.store_id
      WHERE s.is_active = true 
        AND sm.is_active = true
    `;
    
    const stores = await db.query(storesQuery);
    
    // Check which stores already have workflows for this date
    const existingQuery = `
      SELECT store_id 
      FROM store_workflows 
      WHERE date = $1 
        AND template_id = 13  -- Daily Opening Checklist
    `;
    
    const existing = await db.query(existingQuery, [date]);
    const existingStoreIds = existing.rows.map(row => row.store_id);
    
    // Filter stores that need workflows
    const storesToCreate = stores.rows.filter(
      store => !existingStoreIds.includes(store.store_id)
    );
    
    const created = [];
    
    // Create workflows for each store
    for (const store of storesToCreate) {
      const createQuery = `
        INSERT INTO store_workflows (
          store_id,
          location_id,
          template_id,
          date,
          shift_type,
          status,
          assigned_to,
          created_by,
          created_at,
          total_points
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
        RETURNING workflow_id
      `;
      
      const values = [
        store.store_id,
        store.location_id,
        13,  // Daily Opening Checklist template_id
        date,
        'morning',
        'pending',
        store.manager_id,
        store.manager_id,
        15  // Total points for morning checklist
      ];
      
      const result = await db.query(createQuery, values);
      
      created.push({
        workflow_id: result.rows[0].workflow_id,
        store_id: store.store_id,
        manager_id: store.manager_id
      });
    }
    
    res.json({
      success: true,
      message: `Created ${created.length} workflows`,
      workflows: created
    });
    
  } catch (error) {
    console.error('Error generating workflows:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get workflows for a specific manager
router.get('/workflows/manager/:managerId', async (req, res) => {
  try {
    const { managerId } = req.params;
    const { date = new Date() } = req.query;
    
    const query = `
      SELECT 
        sw.workflow_id,
        sw.store_id,
        sw.date,
        sw.status,
        sw.total_points,
        sw.earned_points,
        ct.name as checklist_name,
        s.store_name,
        COUNT(DISTINCT ci.item_id) as total_items,
        COUNT(DISTINCT wc.item_id) as completed_items
      FROM store_workflows sw
      JOIN checklist_templates ct ON sw.template_id = ct.template_id
      JOIN stores s ON sw.store_id = s.store_id
      LEFT JOIN checklist_items ci ON ci.template_id = ct.template_id
      LEFT JOIN workflow_completions wc ON wc.workflow_id = sw.workflow_id
      WHERE sw.assigned_to = $1
        AND sw.date = $2::date
      GROUP BY sw.workflow_id, ct.name, s.store_name
      ORDER BY sw.created_at
    `;
    
    const result = await db.query(query, [managerId, date]);
    
    res.json({
      success: true,
      workflows: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching workflows:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get specific workflow with all items
router.get('/workflows/:workflowId', async (req, res) => {
  try {
    const { workflowId } = req.params;
    
    // Get workflow details
    const workflowQuery = `
      SELECT 
        sw.*,
        ct.name as template_name,
        s.store_name
      FROM store_workflows sw
      JOIN checklist_templates ct ON sw.template_id = ct.template_id
      JOIN stores s ON sw.store_id = s.store_id
      WHERE sw.workflow_id = $1
    `;
    
    const workflowResult = await db.query(workflowQuery, [workflowId]);
    
    if (workflowResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Workflow not found' 
      });
    }
    
    // Get all checklist items with completion status
    const itemsQuery = `
      SELECT 
        ci.*,
        wc.completion_id,
        wc.completed_at,
        wc.value,
        wc.notes,
        wc.completed_by
      FROM checklist_items ci
      LEFT JOIN workflow_completions wc 
        ON wc.workflow_id = $1 
        AND wc.item_id = ci.item_id
      WHERE ci.template_id = $2
      ORDER BY ci.sort_order
    `;
    
    const itemsResult = await db.query(itemsQuery, [
      workflowId, 
      workflowResult.rows[0].template_id
    ]);
    
    res.json({
      success: true,
      workflow: workflowResult.rows[0],
      items: itemsResult.rows
    });
    
  } catch (error) {
    console.error('Error fetching workflow details:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Complete/update a checklist item
router.post('/workflows/:workflowId/items/:itemId/complete', async (req, res) => {
  try {
    const { workflowId, itemId } = req.params;
    const { managerId, value, notes } = req.body;
    
    // Check if already completed
    const checkQuery = `
      SELECT completion_id 
      FROM workflow_completions 
      WHERE workflow_id = $1 AND item_id = $2
    `;
    
    const existing = await db.query(checkQuery, [workflowId, itemId]);
    
    let query, values;
    
    if (existing.rows.length > 0) {
      // Update existing completion
      query = `
        UPDATE workflow_completions 
        SET value = $1, notes = $2, completed_at = NOW()
        WHERE workflow_id = $3 AND item_id = $4
        RETURNING completion_id
      `;
      values = [value, notes, workflowId, itemId];
    } else {
      // Create new completion
      query = `
        INSERT INTO workflow_completions 
        (workflow_id, item_id, completed_by, value, notes, completed_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING completion_id
      `;
      values = [workflowId, itemId, managerId, value, notes];
    }
    
    const result = await db.query(query, values);
    
    // Update workflow points and status
    await updateWorkflowStatus(workflowId);
    
    res.json({
      success: true,
      completion: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error completing item:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Helper function to update workflow status
async function updateWorkflowStatus(workflowId) {
  // Calculate completion percentage
  const statusQuery = `
    WITH counts AS (
      SELECT 
        COUNT(DISTINCT ci.item_id) as total_items,
        COUNT(DISTINCT wc.item_id) as completed_items,
        SUM(CASE WHEN wc.item_id IS NOT NULL THEN ci.point_value ELSE 0 END) as earned_points
      FROM store_workflows sw
      JOIN checklist_items ci ON ci.template_id = sw.template_id
      LEFT JOIN workflow_completions wc ON wc.workflow_id = sw.workflow_id AND wc.item_id = ci.item_id
      WHERE sw.workflow_id = $1
    )
    UPDATE store_workflows 
    SET 
      status = CASE 
        WHEN (SELECT completed_items FROM counts) = (SELECT total_items FROM counts) THEN 'completed'
        WHEN (SELECT completed_items FROM counts) > 0 THEN 'in_progress'
        ELSE 'pending'
      END,
      earned_points = (SELECT earned_points FROM counts),
      compliance_percentage = 
        CASE 
          WHEN (SELECT total_items FROM counts) > 0 
          THEN ((SELECT completed_items FROM counts)::numeric / (SELECT total_items FROM counts)::numeric * 100)
          ELSE 0 
        END,
      completed_at = CASE 
        WHEN (SELECT completed_items FROM counts) = (SELECT total_items FROM counts) THEN NOW()
        ELSE NULL
      END
    WHERE workflow_id = $1
  `;
  
  await db.query(statusQuery, [workflowId]);
}

module.exports = router;