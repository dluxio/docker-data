const { Pool } = require("pg");
const config = require("../config");

const pool = new Pool({
  connectionString: config.dbcs,
});

// ==================================================================
// SUBSCRIPTION MANAGEMENT API
// ==================================================================

// Get all subscription tiers
exports.getSubscriptionTiers = async (req, res) => {
  try {
    const query = `
      SELECT * FROM subscription_tiers 
      WHERE is_active = true 
      ORDER BY sort_order ASC, monthly_price_hive ASC
    `;
    
    const result = await pool.query(query);
    
    res.json({
      tiers: result.rows,
      node: config.username
    });
  } catch (error) {
    console.error('Error getting subscription tiers:', error);
    res.status(500).json({ error: 'Failed to get subscription tiers' });
  }
};

// Get user's subscription status
exports.getUserSubscription = async (req, res) => {
  try {
    const { userAccount } = req.params;
    
    const query = `
      SELECT s.*, t.tier_name, t.tier_code, t.features, t.max_presence_sessions,
             t.max_collaboration_docs, t.max_event_attendees, t.storage_limit_gb,
             t.bandwidth_limit_gb, t.priority_support, t.custom_branding,
             t.api_access, t.analytics_access
      FROM user_subscriptions s
      JOIN subscription_tiers t ON s.tier_id = t.id
      WHERE s.user_account = $1 AND s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 1
    `;
    
    const result = await pool.query(query);
    const subscription = result.rows[0];
    
    if (!subscription) {
      // Return free tier info
      const freeTierQuery = `
        SELECT * FROM subscription_tiers WHERE tier_code = 'free' AND is_active = true
      `;
      const freeTierResult = await pool.query(freeTierQuery);
      
      return res.json({
        subscription: null,
        current_tier: freeTierResult.rows[0] || null,
        has_active_subscription: false,
        node: config.username
      });
    }
    
    // Calculate days until expiry
    const now = new Date();
    const expiresAt = new Date(subscription.expires_at);
    const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
    
    res.json({
      subscription: {
        ...subscription,
        days_until_expiry: daysUntilExpiry,
        is_expiring_soon: daysUntilExpiry <= 7
      },
      current_tier: subscription,
      has_active_subscription: true,
      node: config.username
    });
  } catch (error) {
    console.error('Error getting user subscription:', error);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
};

// Check subscription access for features
exports.checkSubscriptionAccess = async (req, res) => {
  try {
    const { userAccount } = req.params;
    const { feature, resource_count = 1 } = req.query;
    
    // Get user's subscription
    const subscription = await getUserActiveSubscription(userAccount);
    
    if (!subscription) {
      // Free tier access
      const freeTier = await getFreeTier();
      const hasAccess = checkFeatureAccess(freeTier, feature, resource_count);
      
      return res.json({
        has_access: hasAccess,
        current_tier: 'free',
        limits: freeTier,
        upgrade_required: !hasAccess,
        node: config.username
      });
    }
    
    const hasAccess = checkFeatureAccess(subscription, feature, resource_count);
    
    res.json({
      has_access: hasAccess,
      current_tier: subscription.tier_code,
      limits: {
        max_presence_sessions: subscription.max_presence_sessions,
        max_collaboration_docs: subscription.max_collaboration_docs,
        max_event_attendees: subscription.max_event_attendees,
        storage_limit_gb: subscription.storage_limit_gb,
        bandwidth_limit_gb: subscription.bandwidth_limit_gb,
        features: subscription.features
      },
      upgrade_required: !hasAccess,
      node: config.username
    });
  } catch (error) {
    console.error('Error checking subscription access:', error);
    res.status(500).json({ error: 'Failed to check access' });
  }
};

// Get subscription payment history
exports.getPaymentHistory = async (req, res) => {
  try {
    const { userAccount } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    
    const query = `
      SELECT p.*, s.tier_id, t.tier_name 
      FROM subscription_payments p
      LEFT JOIN user_subscriptions s ON p.subscription_id = s.id
      LEFT JOIN subscription_tiers t ON s.tier_id = t.id
      WHERE p.from_account = $1
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    
    const result = await pool.query(query, [userAccount, limit, offset]);
    
    res.json({
      payments: result.rows,
      has_more: result.rows.length === parseInt(limit),
      node: config.username
    });
  } catch (error) {
    console.error('Error getting payment history:', error);
    res.status(500).json({ error: 'Failed to get payment history' });
  }
};

// Calculate subscription price with promo code
exports.calculateSubscriptionPrice = async (req, res) => {
  try {
    const { tierCode, subscriptionType = 'monthly', promoCode = null } = req.body;
    const userAccount = req.user?.account;
    
    // Get tier pricing
    const tier = await getSubscriptionTierByCode(tierCode);
    if (!tier) {
      return res.status(404).json({ error: 'Subscription tier not found' });
    }
    
    const isYearly = subscriptionType === 'yearly';
    let priceHive = isYearly ? tier.yearly_price_hive : tier.monthly_price_hive;
    let priceHbd = isYearly ? tier.yearly_price_hbd : tier.monthly_price_hbd;
    
    let finalPriceHive = priceHive;
    let finalPriceHbd = priceHbd;
    let discount = null;
    let promoValid = false;
    
    // Apply promo code if provided
    if (promoCode && userAccount) {
      const promoResult = await validatePromoCode(promoCode, tier.id, userAccount);
      if (promoResult.valid) {
        promoValid = true;
        discount = promoResult.promo;
        
        switch (discount.discount_type) {
          case 'percentage':
            finalPriceHive = priceHive * (1 - discount.discount_value / 100);
            finalPriceHbd = priceHbd * (1 - discount.discount_value / 100);
            break;
          case 'fixed_hive':
            finalPriceHive = Math.max(0, priceHive - discount.discount_value);
            break;
          case 'fixed_hbd':
            finalPriceHbd = Math.max(0, priceHbd - discount.discount_value);
            break;
        }
      }
    }
    
    res.json({
      tier: {
        code: tier.tier_code,
        name: tier.tier_name,
        features: tier.features
      },
      pricing: {
        original: {
          hive: priceHive,
          hbd: priceHbd
        },
        final: {
          hive: finalPriceHive,
          hbd: finalPriceHbd
        },
        discount_applied: priceHive > finalPriceHive || priceHbd > finalPriceHbd,
        savings_hive: priceHive - finalPriceHive,
        savings_hbd: priceHbd - finalPriceHbd
      },
      promo_code: promoValid ? {
        code: discount.code,
        description: discount.description,
        discount_type: discount.discount_type,
        discount_value: discount.discount_value
      } : null,
      payment_instructions: {
        target_account: 'dlux-io',
        memo_templates: {
          hive: `${tierCode}${isYearly ? ' yearly' : ' monthly'}${promoCode ? ` promo:${promoCode}` : ''}`,
          hbd: `${tierCode}${isYearly ? ' yearly' : ' monthly'}${promoCode ? ` promo:${promoCode}` : ''}`
        }
      },
      node: config.username
    });
  } catch (error) {
    console.error('Error calculating subscription price:', error);
    res.status(500).json({ error: 'Failed to calculate price' });
  }
};

// ==================================================================
// ADMIN ENDPOINTS
// ==================================================================

// Get subscription statistics (admin only)
exports.getSubscriptionStats = async (req, res) => {
  try {
    // This should have admin authentication in production
    const queries = {
      active_subscriptions: "SELECT COUNT(*) as count FROM user_subscriptions WHERE status = 'active'",
      revenue_this_month: `
        SELECT 
          SUM(CASE WHEN currency = 'HIVE' THEN amount * 0.5 ELSE amount END) as hbd_equivalent
        FROM subscription_payments 
        WHERE status = 'processed' 
          AND created_at >= date_trunc('month', CURRENT_DATE)
      `,
      tier_distribution: `
        SELECT t.tier_name, t.tier_code, COUNT(s.id) as subscribers
        FROM subscription_tiers t
        LEFT JOIN user_subscriptions s ON t.id = s.tier_id AND s.status = 'active'
        GROUP BY t.id, t.tier_name, t.tier_code
        ORDER BY t.sort_order
      `,
      recent_payments: `
        SELECT p.*, s.user_account, t.tier_name
        FROM subscription_payments p
        LEFT JOIN user_subscriptions s ON p.subscription_id = s.id
        LEFT JOIN subscription_tiers t ON s.tier_id = t.id
        WHERE p.status = 'processed'
        ORDER BY p.created_at DESC
        LIMIT 10
      `,
      expiring_soon: `
        SELECT s.user_account, s.expires_at, t.tier_name
        FROM user_subscriptions s
        JOIN subscription_tiers t ON s.tier_id = t.id
        WHERE s.status = 'active' 
          AND s.expires_at <= NOW() + INTERVAL '7 days'
        ORDER BY s.expires_at ASC
      `,
      failed_payments: `
        SELECT COUNT(*) as count
        FROM subscription_payments
        WHERE status = 'failed'
          AND created_at >= NOW() - INTERVAL '7 days'
      `
    };
    
    const results = {};
    for (const [key, query] of Object.entries(queries)) {
      try {
        const result = await pool.query(query);
        results[key] = result.rows;
      } catch (error) {
        console.error(`Error executing query ${key}:`, error);
        results[key] = [];
      }
    }
    
    res.json({
      stats: {
        active_subscriptions: parseInt(results.active_subscriptions[0]?.count || 0),
        revenue_this_month: parseFloat(results.revenue_this_month[0]?.hbd_equivalent || 0),
        tier_distribution: results.tier_distribution,
        recent_payments: results.recent_payments,
        expiring_soon: results.expiring_soon,
        failed_payments_week: parseInt(results.failed_payments[0]?.count || 0)
      },
      generated_at: new Date().toISOString(),
      node: config.username
    });
  } catch (error) {
    console.error('Error getting subscription stats:', error);
    res.status(500).json({ error: 'Failed to get subscription statistics' });
  }
};

// Create promo code (admin only)
exports.createPromoCode = async (req, res) => {
  try {
    const {
      code,
      description,
      discount_type,
      discount_value,
      applicable_tiers = [],
      min_subscription_months = 1,
      max_uses = null,
      uses_per_user = 1,
      valid_until = null
    } = req.body;
    
    const createdBy = req.user?.account || 'admin';
    
    if (!code || !discount_type || !discount_value) {
      return res.status(400).json({ error: 'Code, discount_type, and discount_value are required' });
    }
    
    const query = `
      INSERT INTO promo_codes 
      (code, description, discount_type, discount_value, applicable_tiers, 
       min_subscription_months, max_uses, uses_per_user, valid_until, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    
    const result = await pool.query(query, [
      code.toLowerCase(),
      description,
      discount_type,
      discount_value,
      applicable_tiers,
      min_subscription_months,
      max_uses,
      uses_per_user,
      valid_until,
      createdBy
    ]);
    
    res.json({
      promo_code: result.rows[0],
      success: true,
      node: config.username
    });
  } catch (error) {
    if (error.code === '23505') { // Unique constraint violation
      return res.status(409).json({ error: 'Promo code already exists' });
    }
    console.error('Error creating promo code:', error);
    res.status(500).json({ error: 'Failed to create promo code' });
  }
};

// Get all promo codes (admin only)
exports.getPromoCodes = async (req, res) => {
  try {
    const { active_only = 'true', limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT p.*, 
             (SELECT COUNT(*) FROM promo_code_usage WHERE promo_code_id = p.id) as total_used
      FROM promo_codes p
    `;
    
    const params = [];
    const conditions = [];
    
    if (active_only === 'true') {
      conditions.push('p.is_active = true');
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY p.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    res.json({
      promo_codes: result.rows,
      has_more: result.rows.length === parseInt(limit),
      node: config.username
    });
  } catch (error) {
    console.error('Error getting promo codes:', error);
    res.status(500).json({ error: 'Failed to get promo codes' });
  }
};

// Validate promo code endpoint
exports.validatePromoCode = async (req, res) => {
  try {
    const { code, tierCode } = req.body;
    const userAccount = req.user?.account;
    
    if (!code || !tierCode) {
      return res.status(400).json({ error: 'Code and tierCode are required' });
    }
    
    const tier = await getSubscriptionTierByCode(tierCode);
    if (!tier) {
      return res.status(404).json({ error: 'Tier not found' });
    }
    
    const result = await validatePromoCode(code, tier.id, userAccount);
    
    if (result.valid) {
      res.json({
        valid: true,
        promo_code: {
          code: result.promo.code,
          description: result.promo.description,
          discount_type: result.promo.discount_type,
          discount_value: result.promo.discount_value
        },
        node: config.username
      });
    } else {
      res.status(400).json({
        valid: false,
        error: result.error,
        node: config.username
      });
    }
  } catch (error) {
    console.error('Error validating promo code:', error);
    res.status(500).json({ error: 'Failed to validate promo code' });
  }
};

// ==================================================================
// UTILITY FUNCTIONS
// ==================================================================

async function getUserActiveSubscription(userAccount) {
  const query = `
    SELECT s.*, t.tier_code, t.tier_name, t.features, t.max_presence_sessions,
           t.max_collaboration_docs, t.max_event_attendees, t.storage_limit_gb,
           t.bandwidth_limit_gb, t.priority_support, t.custom_branding,
           t.api_access, t.analytics_access
    FROM user_subscriptions s
    JOIN subscription_tiers t ON s.tier_id = t.id
    WHERE s.user_account = $1 AND s.status = 'active'
    ORDER BY s.created_at DESC
    LIMIT 1
  `;
  
  const result = await pool.query(query, [userAccount]);
  return result.rows[0] || null;
}

async function getFreeTier() {
  const query = `
    SELECT * FROM subscription_tiers 
    WHERE tier_code = 'free' AND is_active = true
  `;
  
  const result = await pool.query(query);
  return result.rows[0] || null;
}

async function getSubscriptionTierByCode(tierCode) {
  const query = `
    SELECT * FROM subscription_tiers 
    WHERE tier_code = $1 AND is_active = true
  `;
  
  const result = await pool.query(query, [tierCode]);
  return result.rows[0] || null;
}

function checkFeatureAccess(subscription, feature, resourceCount = 1) {
  if (!subscription) return false;
  
  // Check numeric limits
  switch (feature) {
    case 'presence_sessions':
      return resourceCount <= subscription.max_presence_sessions;
    case 'collaboration_docs':
      return resourceCount <= subscription.max_collaboration_docs;
    case 'event_attendees':
      return resourceCount <= subscription.max_event_attendees;
    case 'storage_gb':
      return resourceCount <= subscription.storage_limit_gb;
    case 'bandwidth_gb':
      return resourceCount <= subscription.bandwidth_limit_gb;
  }
  
  // Check boolean features
  const features = subscription.features || {};
  switch (feature) {
    case 'vr_spaces':
      return features.vr_spaces === true;
    case 'file_sharing':
      return features.file_sharing === true;
    case 'screen_sharing':
      return features.screen_sharing === true;
    case 'recording':
      return features.recording === true;
    case 'custom_avatars':
      return features.custom_avatars === true;
    case 'custom_environments':
      return features.custom_environments === true;
    case 'live_streaming':
      return features.live_streaming === true;
    case 'api_integration':
      return features.api_integration === true || subscription.api_access === true;
    case 'priority_support':
      return subscription.priority_support === true;
    case 'custom_branding':
      return subscription.custom_branding === true;
    case 'analytics':
      return subscription.analytics_access === true;
    default:
      return false;
  }
}

async function validatePromoCode(promoCode, tierId, userAccount) {
  try {
    // Get promo code
    const promoQuery = `
      SELECT * FROM promo_codes 
      WHERE code = $1 AND is_active = true
        AND (valid_until IS NULL OR valid_until > NOW())
        AND (max_uses IS NULL OR total_uses < max_uses)
    `;
    
    const promoResult = await pool.query(promoQuery, [promoCode.toLowerCase()]);
    const promo = promoResult.rows[0];
    
    if (!promo) {
      return { valid: false, error: 'Invalid or expired promo code' };
    }
    
    // Check user usage
    if (userAccount) {
      const usageQuery = `
        SELECT COUNT(*) as count FROM promo_code_usage 
        WHERE promo_code_id = $1 AND user_account = $2
      `;
      
      const usageResult = await pool.query(usageQuery, [promo.id, userAccount]);
      const usageCount = parseInt(usageResult.rows[0].count);
      
      if (usageCount >= promo.uses_per_user) {
        return { valid: false, error: 'Promo code already used maximum times' };
      }
    }
    
    // Check tier restrictions
    if (promo.applicable_tiers.length > 0 && !promo.applicable_tiers.includes(tierId)) {
      return { valid: false, error: 'Promo code not applicable to this subscription tier' };
    }
    
    return { valid: true, promo };
  } catch (error) {
    console.error('Error validating promo code:', error);
    return { valid: false, error: 'Error validating promo code' };
  }
}

// Export utility functions for use by other modules
exports.getUserActiveSubscription = getUserActiveSubscription;
exports.checkFeatureAccess = checkFeatureAccess;

// Payment notification API functions
const { paymentNotificationService } = require('./payment-notifications');

exports.getNotificationStats = async (req, res) => {
  try {
    const stats = await paymentNotificationService.getNotificationStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting notification stats:', error);
    res.status(500).json({ error: 'Failed to get notification stats' });
  }
};

exports.runNotificationChecks = async (req, res) => {
  try {
    await paymentNotificationService.runNotificationChecks();
    res.json({ 
      success: true, 
      message: 'Notification checks completed',
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error running notification checks:', error);
    res.status(500).json({ error: 'Failed to run notification checks' });
  }
}; 