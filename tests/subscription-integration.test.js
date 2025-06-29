/******************************************************
 * DLUX Subscription System Integration Tests
 * Tests payment processing, notifications, feature access, and APIs
 ******************************************************/

const request = require('supertest');
const { Pool } = require('pg');
const config = require('../config');
const SubscriptionMonitor = require('../subscription-monitor');
const { paymentNotificationService, NOTIFICATION_TYPES } = require('../api/payment-notifications');

// Test configuration
const TEST_CONFIG = {
  baseURL: process.env.TEST_BASE_URL || 'http://localhost:3003',
  testUsername: 'test-user-' + Date.now(),
  adminAccount: 'dlux-io'
};

// Database pool for tests
const pool = new Pool({
  connectionString: config.dbcs,
});

describe('DLUX Subscription System Integration Tests', () => {
  let subscriptionMonitor;
  let testTierId;
  let testSubscriptionId;
  let mockHiveMonitor;

  beforeAll(async () => {
    // Set up test database state
    await setupTestDatabase();
    
    // Create mock hive monitor
    mockHiveMonitor = {
      registerOperationHandler: jest.fn(),
      pendingReadTransactions: new Map(),
      readTransactionResolvers: new Map()
    };
    
    // Initialize subscription monitor for tests
    subscriptionMonitor = new SubscriptionMonitor();
    await subscriptionMonitor.initialize(mockHiveMonitor);
  });

  afterAll(async () => {
    // Clean up test data
    await cleanupTestDatabase();
    await pool.end();
  });

  describe('Database Schema and Initialization', () => {
    test('should have all required subscription tables', async () => {
      const tables = [
        'subscription_tiers',
        'user_subscriptions', 
        'promo_codes',
        'promo_code_usage',
        'subscription_payments'
      ];

      for (const table of tables) {
        const result = await pool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = $1
          )
        `, [table]);
        
        expect(result.rows[0].exists).toBe(true);
      }
    });

    test('should have default subscription tiers', async () => {
      const result = await pool.query('SELECT * FROM subscription_tiers ORDER BY id');
      expect(result.rows.length).toBeGreaterThanOrEqual(4);
      
      const tierNames = result.rows.map(row => row.tier_name);
      expect(tierNames).toContain('Free');
      expect(tierNames).toContain('Basic');
      expect(tierNames).toContain('Premium');
      expect(tierNames).toContain('Pro');
      
      testTierId = result.rows.find(row => row.tier_name === 'Basic').id;
    });
  });

  describe('Subscription API Endpoints', () => {
    test('GET /api/subscriptions/tiers should return subscription tiers', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .get('/api/subscriptions/tiers');
      
      expect(response.status).toBe(200);
      expect(response.body.tiers).toBeDefined();
      expect(response.body.tiers.length).toBeGreaterThan(0);
      
      const basicTier = response.body.tiers.find(t => t.tier_name === 'Basic');
      expect(basicTier).toBeDefined();
      expect(basicTier.monthly_price_hive).toBeGreaterThan(0);
    });

    test('GET /api/subscriptions/user/:userAccount should return user subscription', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .get(`/api/subscriptions/user/${TEST_CONFIG.testUsername}`);
      
      expect(response.status).toBe(200);
      expect(response.body.has_subscription).toBe(false);
      expect(response.body.tier_name).toBe('Free');
    });

    test('POST /api/subscriptions/calculate-price should calculate subscription price', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .post('/api/subscriptions/calculate-price')
        .send({
          tier_code: 'basic',
          is_yearly: false,
          promo_code: null
        });
      
      expect(response.status).toBe(200);
      expect(response.body.tier_name).toBe('Basic');
      expect(response.body.price_info.monthly_hive).toBeGreaterThan(0);
      expect(response.body.price_info.monthly_hbd).toBeGreaterThan(0);
    });
  });

  describe('Payment Processing', () => {
    test('should process valid subscription payment', async () => {
      const paymentData = {
        transaction_id: 'test-tx-' + Date.now(),
        from_account: TEST_CONFIG.testUsername,
        amount: 5.0,
        currency: 'HIVE',
        memo: 'basic-monthly'
      };

      // Store the payment
      const paymentId = await subscriptionMonitor.storePayment({
        ...paymentData,
        block_num: 12345,
        to_account: TEST_CONFIG.adminAccount,
        status: 'pending'
      });

      // Process the payment
      await subscriptionMonitor.processPayment(paymentId, paymentData);

      // Check if subscription was created
      const subscription = await subscriptionMonitor.getUserSubscription(TEST_CONFIG.testUsername);
      expect(subscription).toBeDefined();
      expect(subscription.status).toBe('active');
      testSubscriptionId = subscription.id;

      // Check payment status
      const paymentResult = await pool.query('SELECT * FROM subscription_payments WHERE id = $1', [paymentId]);
      expect(paymentResult.rows[0].status).toBe('processed');
    });

    test('should reject payment with invalid amount', async () => {
      const paymentData = {
        transaction_id: 'test-tx-invalid-' + Date.now(),
        from_account: TEST_CONFIG.testUsername,
        amount: 1.0, // Too low for basic tier
        currency: 'HIVE',
        memo: 'basic-monthly'
      };

      const paymentId = await subscriptionMonitor.storePayment({
        ...paymentData,
        block_num: 12346,
        to_account: TEST_CONFIG.adminAccount,
        status: 'pending'
      });

      await subscriptionMonitor.processPayment(paymentId, paymentData);

      // Check payment was marked as failed
      const paymentResult = await pool.query('SELECT * FROM subscription_payments WHERE id = $1', [paymentId]);
      expect(paymentResult.rows[0].status).toBe('failed');
      expect(paymentResult.rows[0].error_message).toContain('Amount mismatch');
    });

    test('should process subscription renewal', async () => {
      const renewalData = {
        transaction_id: 'test-renewal-' + Date.now(),
        from_account: TEST_CONFIG.testUsername,
        amount: 5.0,
        currency: 'HIVE',
        memo: 'basic-renewal'
      };

      const paymentId = await subscriptionMonitor.storePayment({
        ...renewalData,
        block_num: 12347,
        to_account: TEST_CONFIG.adminAccount,
        status: 'pending'
      });

      const originalExpiry = (await subscriptionMonitor.getUserSubscription(TEST_CONFIG.testUsername)).expires_at;
      await subscriptionMonitor.processPayment(paymentId, renewalData);

      // Check if subscription was extended
      const updatedSubscription = await subscriptionMonitor.getUserSubscription(TEST_CONFIG.testUsername);
      expect(new Date(updatedSubscription.expires_at)).toBeGreaterThan(new Date(originalExpiry));
    });
  });

  describe('Promo Code System', () => {
    let testPromoId;

    test('should create promo code', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .post('/api/admin/subscriptions/promo-codes')
        .send({
          code: 'TEST50',
          discount_type: 'percentage',
          discount_value: 50,
          max_uses: 10,
          uses_per_user: 1,
          applicable_tiers: [testTierId],
          valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
        });

      expect(response.status).toBe(201);
      expect(response.body.promo_code.code).toBe('TEST50');
      testPromoId = response.body.promo_code.id;
    });

    test('should apply promo code discount', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .post('/api/subscriptions/calculate-price')
        .send({
          tier_code: 'basic',
          is_yearly: false,
          promo_code: 'TEST50'
        });

      expect(response.status).toBe(200);
      expect(response.body.promo_applied).toBe(true);
      expect(response.body.final_price.monthly_hive).toBeLessThan(response.body.price_info.monthly_hive);
    });

    test('should process payment with promo code', async () => {
      const discountedAmount = 2.5; // 50% off 5 HIVE
      const paymentData = {
        transaction_id: 'test-promo-' + Date.now(),
        from_account: 'test-promo-user',
        amount: discountedAmount,
        currency: 'HIVE',
        memo: 'basic-monthly promo:TEST50'
      };

      const paymentId = await subscriptionMonitor.storePayment({
        ...paymentData,
        block_num: 12348,
        to_account: TEST_CONFIG.adminAccount,
        status: 'pending'
      });

      await subscriptionMonitor.processPayment(paymentId, paymentData);

      // Check payment was processed
      const paymentResult = await pool.query('SELECT * FROM subscription_payments WHERE id = $1', [paymentId]);
      expect(paymentResult.rows[0].status).toBe('processed');

      // Check promo code usage was recorded
      const usageResult = await pool.query('SELECT * FROM promo_code_usage WHERE promo_code_id = $1', [testPromoId]);
      expect(usageResult.rows.length).toBe(1);
    });
  });

  describe('Feature Access Control', () => {
    test('should check feature access for subscribed user', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .get(`/api/subscriptions/user/${TEST_CONFIG.testUsername}/access`)
        .query({ feature: 'advanced_vr' });

      expect(response.status).toBe(200);
      expect(response.body.has_access).toBe(true);
      expect(response.body.subscription_tier).toBe('Basic');
    });

    test('should deny feature access for free user', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .get('/api/subscriptions/user/free-user/access')
        .query({ feature: 'advanced_vr' });

      expect(response.status).toBe(200);
      expect(response.body.has_access).toBe(false);
      expect(response.body.subscription_tier).toBe('Free');
    });

    test('should respect storage limits', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .get(`/api/subscriptions/user/${TEST_CONFIG.testUsername}/access`)
        .query({ 
          feature: 'storage',
          usage: 500 * 1024 * 1024 // 500MB
        });

      expect(response.status).toBe(200);
      expect(response.body.has_access).toBe(true); // Basic tier has 1GB
      expect(response.body.limit_info.storage_limit_gb).toBe(1);
    });
  });

  describe('Payment Notifications', () => {
    test('should send payment due notification', async () => {
      // Create a subscription expiring in 3 days
      await pool.query(`
        UPDATE user_subscriptions 
        SET expires_at = NOW() + INTERVAL '3 days'
        WHERE id = $1
      `, [testSubscriptionId]);

      // Run notification checks
      await paymentNotificationService.checkPaymentDueNotifications();

      // Check if notification was created
      const notificationResult = await pool.query(`
        SELECT * FROM user_notifications 
        WHERE username = $1 AND type = $2
        ORDER BY created_at DESC LIMIT 1
      `, [TEST_CONFIG.testUsername, NOTIFICATION_TYPES.PAYMENT_DUE_SOON]);

      expect(notificationResult.rows.length).toBe(1);
      expect(notificationResult.rows[0].title).toContain('Payment Due in');
    });

    test('should send overdue payment notification', async () => {
      // Set subscription as expired
      await pool.query(`
        UPDATE user_subscriptions 
        SET expires_at = NOW() - INTERVAL '1 day'
        WHERE id = $1
      `, [testSubscriptionId]);

      await paymentNotificationService.checkOverduePayments();

      // Check if overdue notification was created
      const notificationResult = await pool.query(`
        SELECT * FROM user_notifications 
        WHERE username = $1 AND type = $2
        ORDER BY created_at DESC LIMIT 1
      `, [TEST_CONFIG.testUsername, NOTIFICATION_TYPES.PAYMENT_OVERDUE]);

      expect(notificationResult.rows.length).toBe(1);
      expect(notificationResult.rows[0].title).toContain('Payment Overdue');
    });

    test('should suspend overdue subscriptions', async () => {
      // Set subscription as expired beyond grace period
      await pool.query(`
        UPDATE user_subscriptions 
        SET expires_at = NOW() - INTERVAL '5 days'
        WHERE id = $1
      `, [testSubscriptionId]);

      await paymentNotificationService.checkServiceSuspensions();

      // Check if subscription was suspended
      const subscriptionResult = await pool.query('SELECT * FROM user_subscriptions WHERE id = $1', [testSubscriptionId]);
      expect(subscriptionResult.rows[0].status).toBe('suspended');

      // Check if suspension notification was sent
      const notificationResult = await pool.query(`
        SELECT * FROM user_notifications 
        WHERE username = $1 AND type = $2
        ORDER BY created_at DESC LIMIT 1
      `, [TEST_CONFIG.testUsername, NOTIFICATION_TYPES.SERVICE_SUSPENDED]);

      expect(notificationResult.rows.length).toBe(1);
    });

    test('should get notification statistics', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .get('/api/admin/subscriptions/notifications/stats');

      expect(response.status).toBe(200);
      expect(response.body.by_type).toBeDefined();
      expect(response.body.total_users_with_notifications).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Admin Statistics and Monitoring', () => {
    test('should get subscription statistics', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .get('/api/admin/subscriptions/stats');

      expect(response.status).toBe(200);
      expect(response.body.total_subscriptions).toBeGreaterThanOrEqual(1);
      expect(response.body.active_subscriptions).toBeGreaterThanOrEqual(0);
      expect(response.body.tier_distribution).toBeDefined();
      expect(response.body.revenue_metrics).toBeDefined();
    });

    test('should get subscription monitor stats', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .get('/api/subscriptions/monitor/stats');

      expect(response.status).toBe(200);
      expect(response.body.target_account).toBe('dlux-io');
      expect(response.body.active_subscriptions).toBeGreaterThanOrEqual(0);
      expect(response.body.last_updated).toBeDefined();
    });

    test('should run notification checks manually', async () => {
      const response = await request(TEST_CONFIG.baseURL)
        .post('/api/admin/subscriptions/notifications/run-checks');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('completed');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle duplicate payment processing', async () => {
      const paymentData = {
        transaction_id: 'test-duplicate-tx',
        from_account: TEST_CONFIG.testUsername,
        amount: 5.0,
        currency: 'HIVE',
        memo: 'basic-monthly'
      };

      // Process same payment twice
      const paymentId1 = await subscriptionMonitor.storePayment({
        ...paymentData,
        block_num: 12349,
        to_account: TEST_CONFIG.adminAccount,
        status: 'pending'
      });

      const paymentId2 = await subscriptionMonitor.storePayment({
        ...paymentData,
        block_num: 12349,
        to_account: TEST_CONFIG.adminAccount,
        status: 'pending'
      });

      // Should be same payment ID due to conflict resolution
      expect(paymentId1).toBe(paymentId2);
    });

    test('should handle invalid currency', async () => {
      const paymentData = {
        transaction_id: 'test-invalid-currency-' + Date.now(),
        from_account: TEST_CONFIG.testUsername,
        amount: 5.0,
        currency: 'BTC', // Unsupported
        memo: 'basic-monthly'
      };

      // Simulate the transfer handler
      await subscriptionMonitor.handleTransfer({
        from: paymentData.from_account,
        to: TEST_CONFIG.adminAccount,
        amount: `${paymentData.amount} ${paymentData.currency}`,
        memo: paymentData.memo,
        block_num: 12350
      }, null, paymentData.transaction_id);

      // Should not create a payment record for unsupported currency
      const paymentResult = await pool.query('SELECT * FROM subscription_payments WHERE transaction_id = $1', [paymentData.transaction_id]);
      expect(paymentResult.rows.length).toBe(0);
    });

    test('should handle expired promo codes', async () => {
      // Create expired promo code
      const expiredPromoResult = await pool.query(`
        INSERT INTO promo_codes (code, discount_type, discount_value, valid_until, is_active)
        VALUES ('EXPIRED50', 'percentage', 50, NOW() - INTERVAL '1 day', true)
        RETURNING id
      `);

      const response = await request(TEST_CONFIG.baseURL)
        .post('/api/subscriptions/calculate-price')
        .send({
          tier_code: 'basic',
          is_yearly: false,
          promo_code: 'EXPIRED50'
        });

      expect(response.status).toBe(200);
      expect(response.body.promo_applied).toBe(false);
      expect(response.body.promo_error).toContain('expired');
    });
  });
});

// Helper functions
async function setupTestDatabase() {
  await cleanupTestDatabase();
  console.log('Setting up test database...');
}

async function cleanupTestDatabase() {
  try {
    await pool.query(`DELETE FROM promo_code_usage WHERE user_account LIKE 'test-%'`);
    await pool.query(`DELETE FROM user_notifications WHERE username LIKE 'test-%'`);
    await pool.query(`DELETE FROM subscription_payments WHERE from_account LIKE 'test-%'`);
    await pool.query(`DELETE FROM user_subscriptions WHERE user_account LIKE 'test-%'`);
    await pool.query(`DELETE FROM promo_codes WHERE code LIKE 'TEST%'`);
    
    console.log('Test database cleaned up');
  } catch (error) {
    console.error('Error cleaning up test database:', error);
  }
}

module.exports = {
  TEST_CONFIG,
  setupTestDatabase,
  cleanupTestDatabase
}; 