const { Pool } = require("pg");
const config = require("../config");

const pool = new Pool({
  connectionString: config.dbcs,
});

class SubscriptionMonitor {
  constructor() {
    this.targetAccount = 'dlux-io'; // Our account to receive payments
    this.processingQueue = new Map(); // Prevent duplicate processing
  }

  // Initialize the subscription monitor by registering with hive monitor
  async initialize(hiveMonitor) {
    console.log('Initializing Subscription Monitor...');
    
    // Register handler for transfer operations
    hiveMonitor.registerOperationHandler('transfer', this.handleTransfer.bind(this));
    
    // Register handler for transfer_to_savings operations
    hiveMonitor.registerOperationHandler('transfer_to_savings', this.handleSavingsTransfer.bind(this));
    
    console.log('Subscription Monitor registered for transfer operations');
    
    // Process any pending payments that might have been missed
    await this.processPendingPayments();
    
    // Start renewal checker (runs every hour)
    setInterval(() => {
      this.checkRenewals().catch(console.error);
    }, 60 * 60 * 1000); // 1 hour
  }

  // Handle transfer operations from Hive blockchain
  async handleTransfer(opData, block, txId) {
    try {
      const { from, to, amount, memo } = opData;
      
      // Only process transfers to our account
      if (to !== this.targetAccount) {
        return;
      }

      // Prevent duplicate processing
      if (this.processingQueue.has(txId)) {
        console.log(`Transfer ${txId} already being processed, skipping`);
        return;
      }
      
      this.processingQueue.set(txId, Date.now());
      
      console.log(`Processing subscription payment: ${from} -> ${to} ${amount} (${txId})`);
      
      // Parse amount and currency
      const [amountStr, currency] = amount.split(' ');
      const amountValue = parseFloat(amountStr);
      
      if (!['HIVE', 'HBD'].includes(currency)) {
        console.log(`Unsupported currency: ${currency}, skipping`);
        this.processingQueue.delete(txId);
        return;
      }
      
      // Store payment record
      const paymentId = await this.storePayment({
        transaction_id: txId,
        block_num: opData.block_num,
        from_account: from,
        to_account: to,
        amount: amountValue,
        currency: currency,
        memo: memo || '',
        status: 'pending'
      });
      
      // Process the payment
      await this.processPayment(paymentId, {
        transaction_id: txId,
        from_account: from,
        amount: amountValue,
        currency: currency,
        memo: memo || ''
      });
      
      this.processingQueue.delete(txId);
      
    } catch (error) {
      console.error('Error handling transfer:', error);
      this.processingQueue.delete(txId);
    }
  }

  // Handle savings transfers (some users might pay from savings)
  async handleSavingsTransfer(opData, block, txId) {
    // Same logic as regular transfer
    await this.handleTransfer(opData, block, txId);
  }

  // Store payment in database
  async storePayment(paymentData) {
    const query = `
      INSERT INTO subscription_payments 
      (transaction_id, block_num, from_account, to_account, amount, currency, memo, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (transaction_id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = NOW()
      RETURNING id
    `;

    const result = await pool.query(query, [
      paymentData.transaction_id,
      paymentData.block_num,
      paymentData.from_account,
      paymentData.to_account,
      paymentData.amount,
      paymentData.currency,
      paymentData.memo,
      paymentData.status
    ]);

    return result.rows[0].id;
  }

  // Process a payment and determine if it's for a subscription
  async processPayment(paymentId, paymentData) {
    try {
      const { transaction_id, from_account, amount, currency, memo } = paymentData;
      
      console.log(`Processing payment ${transaction_id}: ${from_account} paid ${amount} ${currency}`);
      
      // Parse memo to determine subscription intent
      const memoData = this.parseMemo(memo);
      
      // Check if user has an existing subscription
      const existingSubscription = await this.getUserSubscription(from_account);
      
      let subscriptionMatch = null;
      let tierMatch = null;
      
      // Try to match payment to a subscription tier
      if (memoData.tierCode) {
        // Explicit tier code in memo
        tierMatch = await this.getSubscriptionTier(memoData.tierCode);
      } else if (memoData.renewal && existingSubscription) {
        // Renewal payment
        tierMatch = await this.getSubscriptionTierById(existingSubscription.tier_id);
      } else {
        // Try to match by amount
        tierMatch = await this.matchTierByAmount(amount, currency, memoData.isYearly);
      }
      
      if (!tierMatch) {
        // Couldn't match to any tier, mark as failed
        await this.updatePaymentStatus(paymentId, 'failed', 'Could not match payment to any subscription tier');
        console.log(`Payment ${transaction_id}: No matching tier found for ${amount} ${currency}`);
        return;
      }
      
      // Calculate expected amount
      const expectedAmount = memoData.isYearly ? 
        (currency === 'HIVE' ? tierMatch.yearly_price_hive : tierMatch.yearly_price_hbd) :
        (currency === 'HIVE' ? tierMatch.monthly_price_hive : tierMatch.monthly_price_hbd);
      
      // Apply promo code discount if provided
      let finalAmount = expectedAmount;
      let promoCode = null;
      
      if (memoData.promoCode) {
        const promoResult = await this.applyPromoCode(memoData.promoCode, tierMatch.id, from_account);
        if (promoResult.success) {
          finalAmount = promoResult.discountedAmount;
          promoCode = promoResult.promoCode;
        }
      }
      
      // Check if payment amount matches (with 1% tolerance for fees)
      const tolerance = finalAmount * 0.01;
      const amountMatches = Math.abs(amount - finalAmount) <= tolerance;
      
      if (!amountMatches) {
        await this.updatePaymentStatus(paymentId, 'failed', 
          `Amount mismatch: expected ${finalAmount} ${currency}, got ${amount} ${currency}`);
        console.log(`Payment ${transaction_id}: Amount mismatch`);
        return;
      }
      
      // Payment looks good, create or update subscription
      if (existingSubscription && memoData.renewal) {
        // Renewal
        await this.renewSubscription(existingSubscription.id, paymentId, memoData.isYearly);
        console.log(`Payment ${transaction_id}: Renewed subscription for ${from_account}`);
      } else {
        // New subscription
        const subscriptionId = await this.createSubscription({
          user_account: from_account,
          tier_id: tierMatch.id,
          subscription_type: memoData.isYearly ? 'yearly' : 'monthly',
          currency_used: currency,
          original_price: expectedAmount,
          effective_price: finalAmount,
          payment_transaction_id: transaction_id,
          promo_code: promoCode
        });
        
        console.log(`Payment ${transaction_id}: Created new subscription ${subscriptionId} for ${from_account}`);
      }
      
      // Mark payment as processed
      await this.updatePaymentStatus(paymentId, 'processed', null, tierMatch.id);
      
      // Log the successful payment
      console.log(`✅ Subscription payment processed: ${from_account} -> ${tierMatch.tier_name} (${amount} ${currency})`);
      
    } catch (error) {
      console.error(`Error processing payment ${paymentId}:`, error);
      await this.updatePaymentStatus(paymentId, 'failed', error.message);
    }
  }

  // Parse memo for subscription information
  parseMemo(memo) {
    const result = {
      tierCode: null,
      isYearly: false,
      renewal: false,
      promoCode: null
    };

    if (!memo) return result;

    const memoLower = memo.toLowerCase();
    
    // Check for tier codes
    if (memoLower.includes('basic')) result.tierCode = 'basic';
    if (memoLower.includes('premium')) result.tierCode = 'premium';
    if (memoLower.includes('pro')) result.tierCode = 'pro';
    
    // Check for yearly vs monthly
    if (memoLower.includes('year') || memoLower.includes('annual')) {
      result.isYearly = true;
    }
    
    // Check for renewal
    if (memoLower.includes('renew') || memoLower.includes('renewal')) {
      result.renewal = true;
    }
    
    // Look for promo codes (format: promo:CODE)
    const promoMatch = memo.match(/promo:([A-Za-z0-9]+)/i);
    if (promoMatch) {
      result.promoCode = promoMatch[1].toLowerCase();
    }
    
    return result;
  }

  // Get user's current subscription
  async getUserSubscription(userAccount) {
    const query = `
      SELECT * FROM user_subscriptions 
      WHERE user_account = $1 AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `;
    
    const result = await pool.query(query, [userAccount]);
    return result.rows[0] || null;
  }

  // Get subscription tier by code
  async getSubscriptionTier(tierCode) {
    const query = `
      SELECT * FROM subscription_tiers 
      WHERE tier_code = $1 AND is_active = true
    `;
    
    const result = await pool.query(query, [tierCode]);
    return result.rows[0] || null;
  }

  // Get subscription tier by ID
  async getSubscriptionTierById(tierId) {
    const query = `
      SELECT * FROM subscription_tiers 
      WHERE id = $1 AND is_active = true
    `;
    
    const result = await pool.query(query, [tierId]);
    return result.rows[0] || null;
  }

  // Match tier by amount and currency
  async matchTierByAmount(amount, currency, isYearly = false) {
    const priceColumn = isYearly ?
      (currency === 'HIVE' ? 'yearly_price_hive' : 'yearly_price_hbd') :
      (currency === 'HIVE' ? 'monthly_price_hive' : 'monthly_price_hbd');
    
    const query = `
      SELECT * FROM subscription_tiers 
      WHERE ${priceColumn} > 0 
        AND ABS(${priceColumn} - $1) <= ${priceColumn} * 0.01
        AND is_active = true
      ORDER BY ABS(${priceColumn} - $1) ASC
      LIMIT 1
    `;
    
    const result = await pool.query(query, [amount]);
    return result.rows[0] || null;
  }

  // Apply promo code
  async applyPromoCode(promoCode, tierId, userAccount) {
    try {
      // Get promo code details
      const promoQuery = `
        SELECT * FROM promo_codes 
        WHERE code = $1 AND is_active = true
          AND (valid_until IS NULL OR valid_until > NOW())
          AND (max_uses IS NULL OR total_uses < max_uses)
      `;
      
      const promoResult = await pool.query(promoQuery, [promoCode]);
      const promo = promoResult.rows[0];
      
      if (!promo) {
        return { success: false, error: 'Invalid or expired promo code' };
      }
      
      // Check if user already used this promo
      const usageQuery = `
        SELECT COUNT(*) as count FROM promo_code_usage 
        WHERE promo_code_id = $1 AND user_account = $2
      `;
      
      const usageResult = await pool.query(usageQuery, [promo.id, userAccount]);
      const usageCount = parseInt(usageResult.rows[0].count);
      
      if (usageCount >= promo.uses_per_user) {
        return { success: false, error: 'Promo code already used' };
      }
      
      // Check if promo applies to this tier
      if (promo.applicable_tiers.length > 0 && !promo.applicable_tiers.includes(tierId)) {
        return { success: false, error: 'Promo code not applicable to this tier' };
      }
      
      return { 
        success: true, 
        promoCode: promo,
        discountedAmount: this.calculateDiscount(100, promo) // Will be recalculated with actual amount
      };
      
    } catch (error) {
      console.error('Error applying promo code:', error);
      return { success: false, error: 'Error processing promo code' };
    }
  }

  // Calculate discount amount
  calculateDiscount(originalAmount, promoCode) {
    switch (promoCode.discount_type) {
      case 'percentage':
        return originalAmount * (1 - promoCode.discount_value / 100);
      case 'fixed_hive':
      case 'fixed_hbd':
        return Math.max(0, originalAmount - promoCode.discount_value);
      default:
        return originalAmount;
    }
  }

  // Create new subscription
  async createSubscription(subscriptionData) {
    const expiresAt = subscriptionData.subscription_type === 'yearly' ?
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : // 1 year
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);   // 1 month
    
    const nextPaymentDue = subscriptionData.subscription_type === 'yearly' ?
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : // 1 year
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);   // 1 month

    const query = `
      INSERT INTO user_subscriptions 
      (user_account, tier_id, subscription_type, status, original_price_hive, original_price_hbd,
       effective_price_hive, effective_price_hbd, currency_used, started_at, expires_at, 
       last_payment_at, next_payment_due, payment_transaction_id, promo_code_id)
      VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, NOW(), $9, NOW(), $10, $11, $12)
      ON CONFLICT (user_account) DO UPDATE SET
        tier_id = EXCLUDED.tier_id,
        subscription_type = EXCLUDED.subscription_type,
        status = 'active',
        effective_price_hive = EXCLUDED.effective_price_hive,
        effective_price_hbd = EXCLUDED.effective_price_hbd,
        currency_used = EXCLUDED.currency_used,
        expires_at = EXCLUDED.expires_at,
        last_payment_at = NOW(),
        next_payment_due = EXCLUDED.next_payment_due,
        payment_transaction_id = EXCLUDED.payment_transaction_id,
        updated_at = NOW()
      RETURNING id
    `;

    const originalPriceHive = subscriptionData.currency_used === 'HIVE' ? subscriptionData.original_price : null;
    const originalPriceHbd = subscriptionData.currency_used === 'HBD' ? subscriptionData.original_price : null;
    const effectivePriceHive = subscriptionData.currency_used === 'HIVE' ? subscriptionData.effective_price : null;
    const effectivePriceHbd = subscriptionData.currency_used === 'HBD' ? subscriptionData.effective_price : null;

    const result = await pool.query(query, [
      subscriptionData.user_account,
      subscriptionData.tier_id,
      subscriptionData.subscription_type,
      originalPriceHive,
      originalPriceHbd,
      effectivePriceHive,
      effectivePriceHbd,
      subscriptionData.currency_used,
      expiresAt,
      nextPaymentDue,
      subscriptionData.payment_transaction_id,
      subscriptionData.promo_code?.id || null
    ]);

    return result.rows[0].id;
  }

  // Renew existing subscription
  async renewSubscription(subscriptionId, paymentId, isYearly) {
    const extensionDays = isYearly ? 365 : 30;
    
    const query = `
      UPDATE user_subscriptions 
      SET expires_at = expires_at + INTERVAL '${extensionDays} days',
          next_payment_due = expires_at + INTERVAL '${extensionDays} days',
          last_payment_at = NOW(),
          status = 'active',
          renewal_failures = 0,
          updated_at = NOW()
      WHERE id = $1
    `;

    await pool.query(query, [subscriptionId]);
  }

  // Update payment status
  async updatePaymentStatus(paymentId, status, errorMessage = null, subscriptionId = null) {
    const query = `
      UPDATE subscription_payments 
      SET status = $1, 
          error_message = $2,
          subscription_id = $3,
          processed_at = CASE WHEN $1 = 'processed' THEN NOW() ELSE processed_at END,
          updated_at = NOW()
      WHERE id = $4
    `;

    await pool.query(query, [status, errorMessage, subscriptionId, paymentId]);
  }

  // Process any pending payments
  async processPendingPayments() {
    console.log('Processing pending subscription payments...');
    
    const query = `
      SELECT * FROM subscription_payments 
      WHERE status = 'pending' 
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at ASC
    `;

    const result = await pool.query(query);
    
    for (const payment of result.rows) {
      try {
        await this.processPayment(payment.id, {
          transaction_id: payment.transaction_id,
          from_account: payment.from_account,
          amount: payment.amount,
          currency: payment.currency,
          memo: payment.memo
        });
      } catch (error) {
        console.error(`Error processing pending payment ${payment.id}:`, error);
      }
    }
    
    console.log(`Processed ${result.rows.length} pending payments`);
  }

  // Check for renewals
  async checkRenewals() {
    console.log('Checking for subscription renewals...');
    
    // Find subscriptions expiring in the next 3 days
    const query = `
      SELECT s.*, t.tier_name FROM user_subscriptions s
      JOIN subscription_tiers t ON s.tier_id = t.id
      WHERE s.status = 'active' 
        AND s.expires_at <= NOW() + INTERVAL '3 days'
        AND s.auto_renew = true
      ORDER BY s.expires_at ASC
    `;

    const result = await pool.query(query);
    
    for (const subscription of result.rows) {
      console.log(`Subscription ${subscription.id} for ${subscription.user_account} expires soon`);
      // Here you could send notifications or mark for manual follow-up
    }
    
    // Mark expired subscriptions
    const expiredQuery = `
      UPDATE user_subscriptions 
      SET status = 'expired'
      WHERE status = 'active' AND expires_at < NOW()
    `;
    
    const expiredResult = await pool.query(expiredQuery);
    if (expiredResult.rowCount > 0) {
      console.log(`Marked ${expiredResult.rowCount} subscriptions as expired`);
    }
  }

  // Get subscription statistics
  async getStats() {
    const queries = [
      "SELECT COUNT(*) as active_subs FROM user_subscriptions WHERE status = 'active'",
      "SELECT COUNT(*) as pending_payments FROM subscription_payments WHERE status = 'pending'",
      "SELECT COUNT(*) as processed_today FROM subscription_payments WHERE status = 'processed' AND created_at > NOW() - INTERVAL '1 day'",
      "SELECT tier_code, COUNT(*) as count FROM user_subscriptions s JOIN subscription_tiers t ON s.tier_id = t.id WHERE s.status = 'active' GROUP BY tier_code"
    ];

    const results = await Promise.all(queries.map(q => pool.query(q)));
    
    return {
      active_subscriptions: parseInt(results[0].rows[0].active_subs),
      pending_payments: parseInt(results[1].rows[0].pending_payments),
      processed_today: parseInt(results[2].rows[0].processed_today),
      tier_distribution: results[3].rows,
      last_updated: new Date().toISOString()
    };
  }
}

module.exports = SubscriptionMonitor; 