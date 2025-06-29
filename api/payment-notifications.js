/******************************************************
 * DLUX Payment Notification System
 * Integrates with existing notification system for subscription payments
 ******************************************************/

const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.dbcs,
});

// Notification helper function (matches existing pattern)
const createNotification = async (username, type, title, message, data = null, priority = 'normal', expiresInHours = null) => {
  try {
    const client = await pool.connect();
    try {
      const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000) : null;

      await client.query(`
        INSERT INTO user_notifications 
        (username, type, title, message, data, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, 'unread', $6)
      `, [username, type, title, message, data ? JSON.stringify(data) : null, expiresAt]);

      console.log(`📧 Notification created for @${username}: ${type} - ${title}`);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating notification:', error);
  }
};

// Payment notification types
const NOTIFICATION_TYPES = {
  PAYMENT_DUE_SOON: 'payment_due_soon',
  PAYMENT_OVERDUE: 'payment_overdue', 
  SERVICE_SUSPENDED: 'service_suspended',
  FEATURE_LOCKED: 'feature_locked',
  SUBSCRIPTION_RENEWED: 'subscription_renewed',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',
  PAYMENT_FAILED: 'payment_failed',
  TIER_UPGRADED: 'tier_upgraded',
  TIER_DOWNGRADED: 'tier_downgraded'
};

class PaymentNotificationService {
  constructor() {
    this.gracePeriodDays = 3; // Days after expiry before suspension
    this.reminderDays = [7, 3, 1]; // Days before expiry to send reminders
  }

  // Check and send payment due notifications
  async checkPaymentDueNotifications() {
    try {
      const client = await pool.connect();
      
      try {
        // Find subscriptions expiring soon that need reminders
        for (const days of this.reminderDays) {
          const query = `
            SELECT us.*, st.tier_name, st.monthly_price_hive, st.yearly_price_hive,
                   st.monthly_price_hbd, st.yearly_price_hbd
            FROM user_subscriptions us
            JOIN subscription_tiers st ON us.tier_id = st.id
            WHERE us.status = 'active'
              AND us.expires_at BETWEEN NOW() AND NOW() + INTERVAL '${days} days'
              AND us.expires_at > NOW()
              AND NOT EXISTS (
                SELECT 1 FROM user_notifications un 
                WHERE un.username = us.user_account 
                  AND un.type = '${NOTIFICATION_TYPES.PAYMENT_DUE_SOON}'
                  AND un.created_at > NOW() - INTERVAL '${days + 1} days'
                  AND un.data->>'subscription_id' = us.id::text
              )
          `;
          
          const result = await client.query(query);
          
          for (const subscription of result.rows) {
            await this.sendPaymentDueNotification(subscription, days);
          }
        }
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error checking payment due notifications:', error);
    }
  }

  // Send payment due soon notification
  async sendPaymentDueNotification(subscription, daysRemaining) {
    const isYearly = subscription.subscription_type === 'yearly';
    const price = isYearly 
      ? `${subscription.yearly_price_hive} HIVE / ${subscription.yearly_price_hbd} HBD`
      : `${subscription.monthly_price_hive} HIVE / ${subscription.monthly_price_hbd} HBD`;

    const title = `Payment Due in ${daysRemaining} Day${daysRemaining > 1 ? 's' : ''}`;
    const message = `Your ${subscription.tier_name} subscription expires on ${subscription.expires_at.toDateString()}. Renew now to avoid service interruption.\n\nRenewal Price: ${price}`;

    await createNotification(
      subscription.user_account,
      NOTIFICATION_TYPES.PAYMENT_DUE_SOON,
      title,
      message,
      {
        subscription_id: subscription.id,
        tier_name: subscription.tier_name,
        expires_at: subscription.expires_at,
        days_remaining: daysRemaining,
        renewal_price: price,
        memo_codes: {
          monthly_hive: `${subscription.tier_name.toLowerCase()}-monthly`,
          yearly_hive: `${subscription.tier_name.toLowerCase()}-yearly`,
          monthly_hbd: `${subscription.tier_name.toLowerCase()}-monthly-hbd`,
          yearly_hbd: `${subscription.tier_name.toLowerCase()}-yearly-hbd`
        }
      },
      'high',
      24 * 7 // Expire in 1 week
    );
  }

  // Check and send overdue payment notifications
  async checkOverduePayments() {
    try {
      const client = await pool.connect();
      
      try {
        const query = `
          SELECT us.*, st.tier_name
          FROM user_subscriptions us
          JOIN subscription_tiers st ON us.tier_id = st.id
          WHERE us.status = 'active'
            AND us.expires_at < NOW()
            AND us.expires_at > NOW() - INTERVAL '${this.gracePeriodDays} days'
            AND NOT EXISTS (
              SELECT 1 FROM user_notifications un 
              WHERE un.username = us.user_account 
                AND un.type = '${NOTIFICATION_TYPES.PAYMENT_OVERDUE}'
                AND un.created_at > NOW() - INTERVAL '1 day'
                AND un.data->>'subscription_id' = us.id::text
            )
        `;
        
        const result = await client.query(query);
        
        for (const subscription of result.rows) {
          await this.sendOverduePaymentNotification(subscription);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error checking overdue payments:', error);
    }
  }

  // Send overdue payment notification
  async sendOverduePaymentNotification(subscription) {
    const daysOverdue = Math.floor((new Date() - subscription.expires_at) / (1000 * 60 * 60 * 24));
    const daysUntilSuspension = this.gracePeriodDays - daysOverdue;
    
    const title = `Payment Overdue - ${daysUntilSuspension} Days Until Suspension`;
    const message = `Your ${subscription.tier_name} subscription expired ${daysOverdue} day${daysOverdue > 1 ? 's' : ''} ago. ` +
      `Your service will be suspended in ${daysUntilSuspension} day${daysUntilSuspension > 1 ? 's' : ''} if payment is not received.`;

    await createNotification(
      subscription.user_account,
      NOTIFICATION_TYPES.PAYMENT_OVERDUE,
      title,
      message,
      {
        subscription_id: subscription.id,
        tier_name: subscription.tier_name,
        expires_at: subscription.expires_at,
        days_overdue: daysOverdue,
        days_until_suspension: daysUntilSuspension
      },
      'urgent',
      24 * 7 // Expire in 1 week
    );
  }

  // Check and suspend overdue subscriptions
  async checkServiceSuspensions() {
    try {
      const client = await pool.connect();
      
      try {
        // Find subscriptions that should be suspended
        const suspendQuery = `
          SELECT us.*, st.tier_name
          FROM user_subscriptions us
          JOIN subscription_tiers st ON us.tier_id = st.id
          WHERE us.status = 'active'
            AND us.expires_at < NOW() - INTERVAL '${this.gracePeriodDays} days'
        `;
        
        const suspendResult = await client.query(suspendQuery);
        
        for (const subscription of suspendResult.rows) {
          // Update subscription status to suspended
          await client.query(`
            UPDATE user_subscriptions 
            SET status = 'suspended', updated_at = NOW()
            WHERE id = $1
          `, [subscription.id]);
          
          await this.sendServiceSuspensionNotification(subscription);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error checking service suspensions:', error);
    }
  }

  // Send service suspension notification
  async sendServiceSuspensionNotification(subscription) {
    const title = `Service Suspended - Payment Required`;
    const message = `Your ${subscription.tier_name} subscription has been suspended due to non-payment. ` +
      `Premium features are now disabled. Renew your subscription to restore full access.`;

    await createNotification(
      subscription.user_account,
      NOTIFICATION_TYPES.SERVICE_SUSPENDED,
      title,
      message,
      {
        subscription_id: subscription.id,
        tier_name: subscription.tier_name,
        suspended_at: new Date(),
        restoration_info: 'Renew subscription to restore all features'
      },
      'critical',
      24 * 30 // Expire in 30 days
    );
  }

  // Send positive notifications for successful payments
  async sendSubscriptionRenewedNotification(subscription, paymentDetails) {
    const title = `Subscription Renewed - ${subscription.tier_name}`;
    const message = `Your ${subscription.tier_name} subscription has been successfully renewed. ` +
      `Your next payment is due on ${subscription.expires_at.toDateString()}.`;

    await createNotification(
      subscription.user_account,
      NOTIFICATION_TYPES.SUBSCRIPTION_RENEWED,
      title,
      message,
      {
        subscription_id: subscription.id,
        tier_name: subscription.tier_name,
        expires_at: subscription.expires_at,
        payment_amount: paymentDetails.amount,
        payment_currency: paymentDetails.currency,
        transaction_id: paymentDetails.transaction_id
      },
      'normal',
      24 * 7 // Expire in 1 week
    );
  }

  // Send tier change notifications
  async sendTierChangeNotification(username, oldTier, newTier, changeType) {
    const isUpgrade = changeType === 'upgrade';
    const title = isUpgrade ? `Subscription Upgraded to ${newTier}` : `Subscription Changed to ${newTier}`;
    const message = isUpgrade 
      ? `Congratulations! Your subscription has been upgraded from ${oldTier} to ${newTier}. You now have access to premium features.`
      : `Your subscription has been changed from ${oldTier} to ${newTier}. Your features have been updated accordingly.`;

    await createNotification(
      username,
      isUpgrade ? NOTIFICATION_TYPES.TIER_UPGRADED : NOTIFICATION_TYPES.TIER_DOWNGRADED,
      title,
      message,
      {
        old_tier: oldTier,
        new_tier: newTier,
        change_type: changeType,
        effective_date: new Date()
      },
      isUpgrade ? 'high' : 'normal',
      24 * 7 // Expire in 1 week
    );
  }

  // Send payment failed notification
  async sendPaymentFailedNotification(username, paymentDetails, reason) {
    const title = `Payment Failed - Action Required`;
    const message = `Your subscription payment of ${paymentDetails.amount} ${paymentDetails.currency} failed: ${reason}. ` +
      `Please retry your payment to avoid service interruption.`;

    await createNotification(
      username,
      NOTIFICATION_TYPES.PAYMENT_FAILED,
      title,
      message,
      {
        payment_amount: paymentDetails.amount,
        payment_currency: paymentDetails.currency,
        failure_reason: reason,
        retry_instructions: 'Send payment to dlux-io account with correct memo'
      },
      'urgent',
      24 * 7 // Expire in 1 week
    );
  }

  // Main notification check routine
  async runNotificationChecks() {
    console.log('🔔 Running payment notification checks...');
    
    try {
      await this.checkPaymentDueNotifications();
      await this.checkOverduePayments();
      await this.checkServiceSuspensions();
      
      console.log('✅ Payment notification checks completed');
    } catch (error) {
      console.error('❌ Error in payment notification checks:', error);
    }
  }

  // Start scheduled notification checks
  startScheduledChecks() {
    console.log('🔔 Starting payment notification scheduler...');
    
    // Run checks every 6 hours
    setInterval(() => {
      this.runNotificationChecks();
    }, 6 * 60 * 60 * 1000);
    
    // Run initial check after 30 seconds
    setTimeout(() => {
      this.runNotificationChecks();
    }, 30 * 1000);
  }

  // Get notification statistics for admin
  async getNotificationStats() {
    try {
      const client = await pool.connect();
      
      try {
        const statsQuery = `
          SELECT 
            type,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'unread') as unread,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7_days,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24_hours
          FROM user_notifications 
          WHERE type IN (
            '${NOTIFICATION_TYPES.PAYMENT_DUE_SOON}',
            '${NOTIFICATION_TYPES.PAYMENT_OVERDUE}',
            '${NOTIFICATION_TYPES.SERVICE_SUSPENDED}',
            '${NOTIFICATION_TYPES.SUBSCRIPTION_RENEWED}',
            '${NOTIFICATION_TYPES.PAYMENT_FAILED}'
          )
          GROUP BY type
          ORDER BY total DESC
        `;
        
        const result = await client.query(statsQuery);
        
        const totalQuery = `
          SELECT COUNT(*) as total_users_with_notifications
          FROM (
            SELECT DISTINCT username 
            FROM user_notifications 
            WHERE type IN (
              '${NOTIFICATION_TYPES.PAYMENT_DUE_SOON}',
              '${NOTIFICATION_TYPES.PAYMENT_OVERDUE}',
              '${NOTIFICATION_TYPES.SERVICE_SUSPENDED}',
              '${NOTIFICATION_TYPES.SUBSCRIPTION_RENEWED}',
              '${NOTIFICATION_TYPES.PAYMENT_FAILED}'
            )
            AND created_at > NOW() - INTERVAL '30 days'
          ) as unique_users
        `;
        
        const totalResult = await client.query(totalQuery);
        
        return {
          by_type: result.rows,
          total_users_with_notifications: parseInt(totalResult.rows[0].total_users_with_notifications),
          last_check: new Date()
        };
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error getting notification stats:', error);
      return { error: 'Failed to get notification stats' };
    }
  }
}

// Export the service instance and types
const paymentNotificationService = new PaymentNotificationService();

module.exports = {
  PaymentNotificationService,
  paymentNotificationService,
  NOTIFICATION_TYPES,
  createNotification // Export for use by other modules
}; 