const express = require('express');
const { pool } = require('../index');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');

const router = express.Router();



router.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:8080', 'https://dlux.io', 'https://vue.dlux.io', 'https://www.dlux.io'],
    credentials: true
  }));
  
  // Middleware for JSON parsing
  router.use(express.json());
  
  // Database setup with pricing tables
  const setupDatabase = async () => {
    try {
      const client = await pool.connect();
      
      try {
        // Existing tables
        await client.query(`
          CREATE TABLE IF NOT EXISTS onboarding_payments (
            id SERIAL PRIMARY KEY,
            payment_id VARCHAR(255) UNIQUE NOT NULL,
            username VARCHAR(50) NOT NULL,
            crypto_type VARCHAR(10) NOT NULL,
            amount_crypto DECIMAL(20, 8) NOT NULL,
            amount_usd DECIMAL(10, 2) NOT NULL,
            payment_address VARCHAR(255) NOT NULL,
            memo VARCHAR(255),
            status VARCHAR(20) DEFAULT 'pending',
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
  
        await client.query(`
          CREATE TABLE IF NOT EXISTS onboarding_requests (
            id SERIAL PRIMARY KEY,
            request_id VARCHAR(255) UNIQUE NOT NULL,
            username VARCHAR(50) NOT NULL,
            requested_by VARCHAR(50) NOT NULL,
            public_keys JSONB NOT NULL,
            message TEXT,
            status VARCHAR(20) DEFAULT 'pending',
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
  
        await client.query(`
          CREATE TABLE IF NOT EXISTS payment_addresses (
            id SERIAL PRIMARY KEY,
            crypto_type VARCHAR(10) NOT NULL,
            address VARCHAR(255) NOT NULL,
            is_used BOOLEAN DEFAULT FALSE,
            used_at TIMESTAMP NULL,
            payment_id VARCHAR(255) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
  
        // New pricing tables
        await client.query(`
          CREATE TABLE IF NOT EXISTS crypto_prices (
            id SERIAL PRIMARY KEY,
            symbol VARCHAR(10) NOT NULL,
            price_usd DECIMAL(20, 8) NOT NULL,
            market_cap DECIMAL(20, 2),
            volume_24h DECIMAL(20, 2),
            price_change_24h DECIMAL(10, 4),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(symbol, updated_at)
          )
        `);
  
        await client.query(`
          CREATE TABLE IF NOT EXISTS transfer_costs (
            id SERIAL PRIMARY KEY,
            crypto_type VARCHAR(10) NOT NULL,
            avg_fee_crypto DECIMAL(20, 8) NOT NULL,
            avg_fee_usd DECIMAL(10, 6) NOT NULL,
            network_congestion VARCHAR(20) DEFAULT 'normal',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(crypto_type, updated_at)
          )
        `);
  
        await client.query(`
          CREATE TABLE IF NOT EXISTS account_creation_pricing (
            id SERIAL PRIMARY KEY,
            hive_price_usd DECIMAL(10, 6) NOT NULL,
            base_cost_usd DECIMAL(10, 6) NOT NULL,
            final_cost_usd DECIMAL(10, 6) NOT NULL,
            crypto_rates JSONB NOT NULL,
            transfer_costs JSONB NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
  
        // Indexes for performance
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON onboarding_payments(payment_id);
          CREATE INDEX IF NOT EXISTS idx_payments_status ON onboarding_payments(status);
          CREATE INDEX IF NOT EXISTS idx_payments_expires ON onboarding_payments(expires_at);
          CREATE INDEX IF NOT EXISTS idx_requests_request_id ON onboarding_requests(request_id);
          CREATE INDEX IF NOT EXISTS idx_requests_username ON onboarding_requests(username);
          CREATE INDEX IF NOT EXISTS idx_addresses_crypto_type ON payment_addresses(crypto_type);
          CREATE INDEX IF NOT EXISTS idx_addresses_is_used ON payment_addresses(is_used);
          CREATE INDEX IF NOT EXISTS idx_crypto_prices_symbol ON crypto_prices(symbol);
          CREATE INDEX IF NOT EXISTS idx_crypto_prices_updated ON crypto_prices(updated_at);
          CREATE INDEX IF NOT EXISTS idx_transfer_costs_crypto ON transfer_costs(crypto_type);
          CREATE INDEX IF NOT EXISTS idx_transfer_costs_updated ON transfer_costs(updated_at);
          CREATE INDEX IF NOT EXISTS idx_pricing_updated ON account_creation_pricing(updated_at);
        `);
  
        console.log('Database tables created successfully');
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error setting up database:', error);
      throw error;
    }
  };
  
  // Crypto configuration with network details
  const CRYPTO_CONFIG = {
    SOL: {
      name: 'Solana',
      coingecko_id: 'solana',
      decimals: 9,
      avg_transfer_fee: 0.000005, // 5000 lamports typical
      rpc_endpoints: [
        'https://api.mainnet-beta.solana.com',
        'https://solana-api.projectserum.com'
      ]
    },
    ETH: {
      name: 'Ethereum',
      coingecko_id: 'ethereum',
      decimals: 18,
      avg_transfer_fee: 0.002, // Estimated 21000 gas * 100 gwei
      rpc_endpoints: [
        'https://mainnet.infura.io/v3/YOUR_KEY',
        'https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY'
      ]
    },
    MATIC: {
      name: 'Polygon',
      coingecko_id: 'matic-network',
      decimals: 18,
      avg_transfer_fee: 0.01, // Usually much lower, but being conservative
      rpc_endpoints: [
        'https://polygon-rpc.com',
        'https://rpc-mainnet.maticvigil.com'
      ]
    },
    BNB: {
      name: 'BNB',
      coingecko_id: 'binancecoin',
      decimals: 18,
      avg_transfer_fee: 0.0005, // BSC transfer fee
      rpc_endpoints: [
        'https://bsc-dataseed.binance.org',
        'https://bsc-dataseed1.defibit.io'
      ]
    }
  };
  
  // Pricing service class
  class PricingService {
    constructor() {
      this.lastUpdate = null;
      this.updateInterval = 60 * 60 * 1000; // 1 hour in milliseconds
      this.isUpdating = false;
    }
  
    async fetchHivePrice() {
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true');
        if (!response.ok) {
          throw new Error(`CoinGecko API error: ${response.status}`);
        }
        const data = await response.json();
        return {
          price: data.hive.usd,
          market_cap: data.hive.usd_market_cap,
          volume_24h: data.hive.usd_24h_vol,
          change_24h: data.hive.usd_24h_change
        };
      } catch (error) {
        console.error('Error fetching HIVE price:', error);
        // Fallback to Hive API
        try {
          const response = await fetch('https://api.hive.blog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'condenser_api.get_current_median_history_price',
              id: 1
            })
          });
          const data = await response.json();
          const hivePrice = parseFloat(data.result.base.split(' ')[0]) / parseFloat(data.result.quote.split(' ')[0]);
          return { price: hivePrice, market_cap: null, volume_24h: null, change_24h: null };
        } catch (fallbackError) {
          console.error('Error with HIVE fallback API:', fallbackError);
          throw new Error('Unable to fetch HIVE price from any source');
        }
      }
    }
  
    async fetchCryptoPrices() {
      try {
        const cryptoIds = Object.values(CRYPTO_CONFIG).map(config => config.coingecko_id).join(',');
        const response = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${cryptoIds}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true`
        );
        
        if (!response.ok) {
          throw new Error(`CoinGecko API error: ${response.status}`);
        }
        
        const data = await response.json();
        const prices = {};
        
        for (const [symbol, config] of Object.entries(CRYPTO_CONFIG)) {
          const geckoData = data[config.coingecko_id];
          if (geckoData) {
            prices[symbol] = {
              price: geckoData.usd,
              market_cap: geckoData.usd_market_cap,
              volume_24h: geckoData.usd_24h_vol,
              change_24h: geckoData.usd_24h_change
            };
          }
        }
        
        return prices;
      } catch (error) {
        console.error('Error fetching crypto prices:', error);
        
        // Fallback pricing
        return {
          SOL: { price: 100, market_cap: null, volume_24h: null, change_24h: null },
          ETH: { price: 2500, market_cap: null, volume_24h: null, change_24h: null },
          MATIC: { price: 0.8, market_cap: null, volume_24h: null, change_24h: null },
          BNB: { price: 300, market_cap: null, volume_24h: null, change_24h: null }
        };
      }
    }
  
    async estimateTransferCosts(cryptoPrices) {
      const transferCosts = {};
      
      for (const [symbol, config] of Object.entries(CRYPTO_CONFIG)) {
        try {
          let avgFee = config.avg_transfer_fee; // Default estimate
          let congestion = 'normal';
          
          // For ETH, try to get current gas prices
          if (symbol === 'ETH') {
            try {
              const gasResponse = await fetch('https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=YourApiKeyToken');
              if (gasResponse.ok) {
                const gasData = await gasResponse.json();
                if (gasData.status === '1') {
                  const standardGwei = parseFloat(gasData.result.StandardGasPrice);
                  avgFee = (21000 * standardGwei * 1e-9); // 21000 gas limit * price in ETH
                  
                  if (standardGwei > 100) congestion = 'high';
                  else if (standardGwei > 50) congestion = 'medium';
                  else congestion = 'low';
                }
              }
            } catch (gasError) {
              console.log('Could not fetch ETH gas prices, using default');
            }
          }
          
          const feeUsd = avgFee * (cryptoPrices[symbol]?.price || 0);
          
          transferCosts[symbol] = {
            avg_fee_crypto: avgFee,
            avg_fee_usd: feeUsd,
            network_congestion: congestion
          };
        } catch (error) {
          console.error(`Error estimating transfer cost for ${symbol}:`, error);
          transferCosts[symbol] = {
            avg_fee_crypto: config.avg_transfer_fee,
            avg_fee_usd: config.avg_transfer_fee * (cryptoPrices[symbol]?.price || 0),
            network_congestion: 'unknown'
          };
        }
      }
      
      return transferCosts;
    }
  
    calculateAccountCreationPrice(hivePrice, transferCosts) {
      // Formula: 3x HIVE price + 50% + 20% of average transfer cost
      const basePrice = hivePrice * 3; // 3x HIVE price
      const withMarkup = basePrice * 1.5; // Add 50%
      
      // Calculate average transfer cost across all supported cryptos
      const avgTransferCostUsd = Object.values(transferCosts).reduce((sum, cost) => sum + cost.avg_fee_usd, 0) / Object.keys(transferCosts).length;
      
      const finalPrice = withMarkup + (avgTransferCostUsd * 0.2); // Add 20% of avg transfer cost
      
      return {
        base_cost_usd: basePrice,
        final_cost_usd: finalPrice,
        avg_transfer_cost_usd: avgTransferCostUsd
      };
    }
  
    async updatePricing() {
      if (this.isUpdating) {
        console.log('Pricing update already in progress, skipping...');
        return;
      }
  
      this.isUpdating = true;
      console.log('Starting hourly pricing update...');
  
      try {
        const client = await pool.connect();
        
        try {
          // Fetch all pricing data
          console.log('Fetching HIVE price...');
          const hiveData = await this.fetchHivePrice();
          
          console.log('Fetching crypto prices...');
          const cryptoPrices = await this.fetchCryptoPrices();
          
          console.log('Estimating transfer costs...');
          const transferCosts = await this.estimateTransferCosts(cryptoPrices);
          
          console.log('Calculating account creation pricing...');
          const pricingData = this.calculateAccountCreationPrice(hiveData.price, transferCosts);
          
          // Store HIVE price
          await client.query(
            `INSERT INTO crypto_prices (symbol, price_usd, market_cap, volume_24h, price_change_24h) 
             VALUES ($1, $2, $3, $4, $5)`,
            ['HIVE', hiveData.price, hiveData.market_cap, hiveData.volume_24h, hiveData.change_24h]
          );
          
          // Store crypto prices
          for (const [symbol, data] of Object.entries(cryptoPrices)) {
            await client.query(
              `INSERT INTO crypto_prices (symbol, price_usd, market_cap, volume_24h, price_change_24h) 
               VALUES ($1, $2, $3, $4, $5)`,
              [symbol, data.price, data.market_cap, data.volume_24h, data.change_24h]
            );
          }
          
          // Store transfer costs
          for (const [crypto, data] of Object.entries(transferCosts)) {
            await client.query(
              `INSERT INTO transfer_costs (crypto_type, avg_fee_crypto, avg_fee_usd, network_congestion) 
               VALUES ($1, $2, $3, $4)`,
              [crypto, data.avg_fee_crypto, data.avg_fee_usd, data.network_congestion]
            );
          }
          
          // Calculate crypto rates for account creation
          const cryptoRates = {};
          for (const [symbol, priceData] of Object.entries(cryptoPrices)) {
            cryptoRates[symbol] = {
              price_usd: priceData.price,
              amount_needed: pricingData.final_cost_usd / priceData.price,
              transfer_fee: transferCosts[symbol].avg_fee_crypto,
              total_amount: (pricingData.final_cost_usd / priceData.price) + transferCosts[symbol].avg_fee_crypto
            };
          }
          
          // Store final pricing data
          await client.query(
            `INSERT INTO account_creation_pricing 
             (hive_price_usd, base_cost_usd, final_cost_usd, crypto_rates, transfer_costs) 
             VALUES ($1, $2, $3, $4, $5)`,
            [
              hiveData.price,
              pricingData.base_cost_usd,
              pricingData.final_cost_usd,
              JSON.stringify(cryptoRates),
              JSON.stringify(transferCosts)
            ]
          );
          
          // Clean up old pricing data (keep only last 7 days)
          const cleanupDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          await client.query('DELETE FROM crypto_prices WHERE updated_at < $1', [cleanupDate]);
          await client.query('DELETE FROM transfer_costs WHERE updated_at < $1', [cleanupDate]);
          await client.query('DELETE FROM account_creation_pricing WHERE updated_at < $1', [cleanupDate]);
          
          this.lastUpdate = new Date();
          console.log(`Pricing update completed successfully at ${this.lastUpdate.toISOString()}`);
          console.log(`Final account creation cost: $${pricingData.final_cost_usd.toFixed(6)} USD`);
          console.log(`HIVE price: $${hiveData.price.toFixed(6)} USD`);
          
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error updating pricing:', error);
      } finally {
        this.isUpdating = false;
      }
    }
  
    async getLatestPricing() {
      try {
        const client = await pool.connect();
        try {
          const result = await client.query(
            'SELECT * FROM account_creation_pricing ORDER BY updated_at DESC LIMIT 1'
          );
          
          if (result.rows.length === 0) {
            // No pricing data available, trigger an update
            console.log('No pricing data found, triggering update...');
            await this.updatePricing();
            
            // Try again
            const retryResult = await client.query(
              'SELECT * FROM account_creation_pricing ORDER BY updated_at DESC LIMIT 1'
            );
            
            if (retryResult.rows.length === 0) {
              throw new Error('Unable to generate pricing data');
            }
            
            return retryResult.rows[0];
          }
          
          const pricing = result.rows[0];
          
          // Check if data is stale (older than 2 hours)
          const dataAge = Date.now() - new Date(pricing.updated_at).getTime();
          const maxAge = 2 * 60 * 60 * 1000; // 2 hours
          
          if (dataAge > maxAge) {
            console.log('Pricing data is stale, triggering background update...');
            // Trigger update in background, but return current data
            setImmediate(() => this.updatePricing());
          }
          
          return pricing;
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error getting latest pricing:', error);
        throw error;
      }
    }
  
    startScheduledUpdates() {
      // Initial update
      this.updatePricing();
      
      // Schedule hourly updates
      setInterval(() => {
        this.updatePricing();
      }, this.updateInterval);
      
      console.log('Scheduled pricing updates started (every hour)');
    }
  }
  
  // Create pricing service instance
  const pricingService = new PricingService();
  
  // Utility functions
  const generatePaymentId = () => {
    return 'dlux_' + crypto.randomBytes(16).toString('hex');
  };
  
  const generateMemo = (username, paymentId) => {
    return `DLUX Account: ${username} | ID: ${paymentId}`;
  };
  
  // Get an unused payment address for a crypto type
  const getPaymentAddress = async (cryptoType) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM payment_addresses WHERE crypto_type = $1 AND is_used = FALSE LIMIT 1',
        [cryptoType]
      );
      
      if (result.rows.length === 0) {
        throw new Error(`No available ${cryptoType} addresses`);
      }
      
      return result.rows[0];
    } finally {
      client.release();
    }
  };
  
  // Mark address as used
  const markAddressUsed = async (addressId, paymentId) => {
    const client = await pool.connect();
    try {
      await client.query(
        'UPDATE payment_addresses SET is_used = TRUE, used_by = $1 WHERE id = $2',
        [paymentId, addressId]
      );
    } finally {
      client.release();
    }
  };
  
  // API Routes
  
  // 1. Get real-time crypto pricing (updated endpoint)
  router.get('/api/onboarding/pricing', async (req, res) => {
    try {
      const pricing = await pricingService.getLatestPricing();
      
      res.json({
        success: true,
        pricing: {
          timestamp: pricing.updated_at,
          hive_price_usd: parseFloat(pricing.hive_price_usd),
          account_creation_cost_usd: parseFloat(pricing.final_cost_usd),
          base_cost_usd: parseFloat(pricing.base_cost_usd),
          crypto_rates: pricing.crypto_rates,
          transfer_costs: pricing.transfer_costs,
          supported_currencies: Object.keys(CRYPTO_CONFIG)
        }
      });
    } catch (error) {
      console.error('Error fetching pricing:', error);
      res.status(500).json({
        success: false,
        error: 'Unable to fetch current pricing',
        fallback: {
          hive_price_usd: 0.30,
          account_creation_cost_usd: 3.00,
          crypto_rates: {
            SOL: { price_usd: 100, amount_needed: 0.03, total_amount: 0.030005 },
            ETH: { price_usd: 2500, amount_needed: 0.0012, total_amount: 0.0032 },
            MATIC: { price_usd: 0.8, amount_needed: 3.75, total_amount: 3.76 },
            BNB: { price_usd: 300, amount_needed: 0.01, total_amount: 0.0105 }
          }
        }
      });
    }
  });
  
  // 2. Initiate cryptocurrency payment (updated to use new pricing)
  router.post('/api/onboarding/payment/initiate', async (req, res) => {
    try {
      const { username, cryptoType } = req.body;
  
      // Validate input
      if (!username || !cryptoType) {
        return res.status(400).json({
          success: false,
          error: 'Username and crypto type are required'
        });
      }
  
      if (!CRYPTO_CONFIG[cryptoType]) {
        return res.status(400).json({
          success: false,
          error: 'Unsupported cryptocurrency'
        });
      }
  
      // Get current pricing
      const pricing = await pricingService.getLatestPricing();
      const cryptoRate = pricing.crypto_rates[cryptoType];
      
      if (!cryptoRate) {
        return res.status(500).json({
          success: false,
          error: 'Pricing data not available for this cryptocurrency'
        });
      }
  
      const client = await pool.connect();
      try {
        // Generate payment details
        const paymentId = generatePaymentId();
        const paymentAddress = await getPaymentAddress(cryptoType);
        const memo = generateMemo(username, paymentId);
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
  
        // Store payment record
        await client.query(
          `INSERT INTO onboarding_payments 
           (payment_id, username, crypto_type, amount_crypto, amount_usd, payment_address, memo, expires_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            paymentId,
            username,
            cryptoType,
            cryptoRate.total_amount,
            pricing.final_cost_usd,
            paymentAddress.address,
            memo,
            expiresAt
          ]
        );
  
        // Mark address as used
        await markAddressUsed(paymentAddress.id, paymentId);
  
        res.json({
          success: true,
          payment: {
            id: paymentId,
            username,
            cryptoType,
            amount: parseFloat(cryptoRate.total_amount),
            amountFormatted: `${parseFloat(cryptoRate.total_amount).toFixed(CRYPTO_CONFIG[cryptoType].decimals === 18 ? 6 : CRYPTO_CONFIG[cryptoType].decimals)} ${cryptoType}`,
            amountUSD: parseFloat(pricing.final_cost_usd),
            address: paymentAddress.address,
            memo,
            expiresAt: expiresAt.toISOString(),
            network: CRYPTO_CONFIG[cryptoType].name,
            instructions: [
              `Send exactly ${parseFloat(cryptoRate.total_amount).toFixed(CRYPTO_CONFIG[cryptoType].decimals === 18 ? 6 : CRYPTO_CONFIG[cryptoType].decimals)} ${cryptoType} to the address above`,
              `Include the memo: ${memo}`,
              `Payment expires in 30 minutes`,
              `Account will be created automatically after payment confirmation`
            ]
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error initiating payment:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to initiate payment'
      });
    }
  });
  
  // 3. Check payment status
  router.get('/api/onboarding/payment/:paymentId/status', async (req, res) => {
    try {
      const { paymentId } = req.params;
      
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT * FROM onboarding_payments WHERE payment_id = $1',
          [paymentId]
        );
        
        if (result.rows.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Payment not found'
          });
        }
        
        const payment = result.rows[0];
        
        res.json({
          success: true,
          payment: {
            id: payment.payment_id,
            username: payment.username,
            status: payment.status,
            cryptoType: payment.crypto_type,
            amount: payment.amount,
            address: payment.address,
            memo: payment.memo,
            createdAt: payment.created_at,
            expiresAt: payment.expires_at,
            txHash: payment.tx_hash,
            accountCreated: payment.status === 'completed'
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error checking payment status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to check payment status'
      });
    }
  });
  
  // 4. Send friend account request
  router.post('/api/onboarding/request/send', async (req, res) => {
    try {
      const { requesterUsername, requestedFrom, message, publicKeys } = req.body;
      
      // Validate input
      if (!requesterUsername || !requestedFrom || !publicKeys) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: requesterUsername, requestedFrom, publicKeys'
        });
      }
      
      // Check if user already has pending request
      const client = await pool.connect();
      try {
        const existingResult = await client.query(
          'SELECT id FROM onboarding_requests WHERE requester_username = $1 AND status = $2',
          [requesterUsername, 'pending']
        );
        
        if (existingResult.rows.length > 0) {
          return res.status(409).json({
            success: false,
            error: 'You already have a pending account creation request'
          });
        }
        
        // Create new request
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        
        const result = await client.query(
          `INSERT INTO onboarding_requests 
           (requester_username, requested_from, message, public_keys, expires_at)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [requesterUsername, requestedFrom, message || '', JSON.stringify(publicKeys), expiresAt]
        );
        
        const requestId = result.rows[0].id;
        
        res.json({
          success: true,
          requestId,
          message: `Account creation request sent to @${requestedFrom}`,
          expiresAt: expiresAt.toISOString()
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error sending friend request:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send account creation request'
      });
    }
  });
  
  // 5. Get pending requests for a user
  router.get('/api/onboarding/requests/:username', async (req, res) => {
    try {
      const { username } = req.params;
      
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT id, requester_username, message, public_keys, created_at, expires_at
           FROM onboarding_requests 
           WHERE requested_from = $1 AND status = $2 AND expires_at > NOW()
           ORDER BY created_at DESC`,
          [username, 'pending']
        );
        
        const requests = result.rows.map(row => ({
          id: row.id,
          requesterUsername: row.requester_username,
          message: row.message,
          publicKeys: row.public_keys,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          timeLeft: Math.max(0, Math.floor((new Date(row.expires_at) - new Date()) / (1000 * 60 * 60 * 24))) // days left
        }));
        
        res.json({
          success: true,
          requests,
          count: requests.length
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error fetching requests:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch account creation requests'
      });
    }
  });
  
  // 6. Accept friend request (mark as completed)
  router.post('/api/onboarding/request/:requestId/accept', async (req, res) => {
    try {
      const { requestId } = req.params;
      const { txHash } = req.body;
      
      if (!txHash) {
        return res.status(400).json({
          success: false,
          error: 'Transaction hash is required'
        });
      }
      
      const client = await pool.connect();
      try {
        const result = await client.query(
          `UPDATE onboarding_requests 
           SET status = $1, account_created_tx = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $3 AND status = $4
           RETURNING requester_username`,
          ['completed', txHash, requestId, 'pending']
        );
        
        if (result.rows.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Request not found or already processed'
          });
        }
        
        res.json({
          success: true,
          message: `Account creation completed for @${result.rows[0].requester_username}`,
          txHash
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error accepting request:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to accept request'
      });
    }
  });
  
  // 7. Payment monitoring webhook (for external payment processors)
  router.post('/api/onboarding/webhook/payment', async (req, res) => {
    try {
      // This endpoint would be called by payment processors like Coinbase Commerce
      const { paymentId, txHash, status, amount } = req.body;
      
      // Verify webhook signature here in production
      
      const client = await pool.connect();
      try {
        if (status === 'confirmed' || status === 'completed') {
          // Update payment status
          const result = await client.query(
            `UPDATE onboarding_payments 
             SET status = $1, tx_hash = $2, updated_at = CURRENT_TIMESTAMP
             WHERE payment_id = $3 AND status = $4
             RETURNING username, public_keys`,
            ['completed', txHash, paymentId, 'pending']
          );
          
          if (result.rows.length > 0) {
            const payment = result.rows[0];
            
            // Here you would integrate with HIVE account creation
            // For now, we'll just log it
            console.log(`Payment confirmed for ${payment.username}, creating HIVE account...`);
            
            // TODO: Implement HIVE account creation logic
            // - Use the stored public_keys
            // - Call HIVE account creation API
            // - Handle any errors
          }
        }
        
        res.json({ success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ success: false });
    }
  });
  
  // 8. Cleanup expired records (run this periodically)
  router.post('/api/onboarding/cleanup', async (req, res) => {
    try {
      const client = await pool.connect();
      try {
        // Clean up expired payments
        const paymentsResult = await client.query(
          'DELETE FROM onboarding_payments WHERE expires_at < NOW() AND status = $1',
          ['pending']
        );
        
        // Clean up expired requests
        const requestsResult = await client.query(
          'DELETE FROM onboarding_requests WHERE expires_at < NOW() AND status = $1',
          ['pending']
        );
        
        // Release unused addresses
        await client.query(`
          UPDATE payment_addresses 
          SET is_used = FALSE, used_by = NULL 
          WHERE used_by IN (
            SELECT payment_id FROM onboarding_payments 
            WHERE status = 'expired' OR expires_at < NOW()
          )
        `);
        
        res.json({
          success: true,
          cleaned: {
            expiredPayments: paymentsResult.rowCount,
            expiredRequests: requestsResult.rowCount
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error cleaning up expired records:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to cleanup expired records'
      });
    }
  });
  
  // Initialize the module
  const initializeOnboardingService = async () => {
    try {
      console.log('Initializing DLUX Onboarding Service...');
      
      // Set up database
      await setupDatabase();
      console.log('✓ Database tables created/verified');
      
      // Start pricing service
      pricingService.startScheduledUpdates();
      console.log('✓ Pricing service started with hourly updates');
      
      console.log('DLUX Onboarding Service initialized successfully!');
      console.log(`Supported cryptocurrencies: ${Object.keys(CRYPTO_CONFIG).join(', ')}`);
      
    } catch (error) {
      console.error('Failed to initialize Onboarding Service:', error);
      process.exit(1);
    }
  };
  
  // Export the router and initialization function
  module.exports = { 
    router, 
    initializeOnboardingService,
    setupDatabase 
  };
  
  // Auto-initialize if this file is run directly
  if (require.main === module) {
    initializeOnboardingService().then(() => {
      console.log('Onboarding service is running...');
      
      // Keep the process alive for testing
      setInterval(() => {
        console.log(`[${new Date().toISOString()}] Service running - Last pricing update: ${pricingService.lastUpdate || 'Never'}`);
      }, 10 * 60 * 1000); // Every 10 minutes
    });
  } 