const express = require('express');
const { pool } = require('../index');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const { PaymentChannelMonitor } = require('./wsmonitor');

const router = express.Router();
// CORS middleware for onboarding endpoints
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
  
        // Payment addresses are now stored in environment/config
        // This allows shared addresses for cost optimization
  
        // Payment channels - tracks individual payment sessions
        await client.query(`
          CREATE TABLE IF NOT EXISTS payment_channels (
            id SERIAL PRIMARY KEY,
            channel_id VARCHAR(100) UNIQUE NOT NULL,
            username VARCHAR(50) NOT NULL,
            crypto_type VARCHAR(10) NOT NULL,
            payment_address VARCHAR(255) NOT NULL,
            amount_crypto DECIMAL(20,8) NOT NULL,
            amount_usd DECIMAL(10,6) NOT NULL,
            memo VARCHAR(255),
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TIMESTAMP,
            account_created_at TIMESTAMP,
            tx_hash VARCHAR(255),
            confirmations INTEGER DEFAULT 0,
            expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
            public_keys JSONB,
            recovery_data JSONB
          )
        `);
  
        // Payment confirmations and monitoring
        await client.query(`
          CREATE TABLE IF NOT EXISTS payment_confirmations (
            id SERIAL PRIMARY KEY,
            channel_id VARCHAR(100) REFERENCES payment_channels(channel_id),
            tx_hash VARCHAR(255) NOT NULL,
            block_height BIGINT,
            confirmations INTEGER DEFAULT 0,
            amount_received DECIMAL(20,8),
            detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP
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
          CREATE INDEX IF NOT EXISTS idx_channels_payment_address ON payment_channels(payment_address);
          CREATE INDEX IF NOT EXISTS idx_channels_channel_id ON payment_channels(channel_id);
          CREATE INDEX IF NOT EXISTS idx_channels_status ON payment_channels(status);
          CREATE INDEX IF NOT EXISTS idx_channels_crypto_type ON payment_channels(crypto_type);
          CREATE INDEX IF NOT EXISTS idx_channels_username ON payment_channels(username);
          CREATE INDEX IF NOT EXISTS idx_channels_created ON payment_channels(created_at);
          CREATE INDEX IF NOT EXISTS idx_channels_expires ON payment_channels(expires_at);
          CREATE INDEX IF NOT EXISTS idx_confirmations_channel ON payment_confirmations(channel_id);
          CREATE INDEX IF NOT EXISTS idx_confirmations_tx_hash ON payment_confirmations(tx_hash);
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
  
  // Shared payment addresses (reused across all payments)
  const PAYMENT_ADDRESSES = {
    SOL: process.env.SOL_PAYMENT_ADDRESS || '11111111111111111111111111111111', // Replace with real address
    ETH: process.env.ETH_PAYMENT_ADDRESS || '0x0000000000000000000000000000000000000000', // Replace with real address
    MATIC: process.env.MATIC_PAYMENT_ADDRESS || '0x0000000000000000000000000000000000000000', // Replace with real address
    BNB: process.env.BNB_PAYMENT_ADDRESS || '0x0000000000000000000000000000000000000000' // Replace with real address
  };
  
  // Crypto configuration with network details and payment channel support
  const CRYPTO_CONFIG = {
    SOL: {
      name: 'Solana',
      coingecko_id: 'solana',
      decimals: 9,
      avg_transfer_fee: 0.000005, // 5000 lamports typical
      fallback_price_usd: 100,
      payment_type: 'address', // Uses address-based payments
      confirmations_required: 1,
      block_time_seconds: 0.4,
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
      fallback_price_usd: 2500,
      payment_type: 'address', // Uses address-based payments
      confirmations_required: 2,
      block_time_seconds: 12,
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
      fallback_price_usd: 0.8,
      payment_type: 'address', // Uses address-based payments
      confirmations_required: 10,
      block_time_seconds: 2,
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
      fallback_price_usd: 300,
      payment_type: 'address', // Uses address-based payments
      confirmations_required: 3,
      block_time_seconds: 3,
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
          
          // For ETH, try to get current gas prices from free APIs
          if (symbol === 'ETH') {
            try {
              // Try a simpler gas API first
              let gasSuccess = false;
              
              try {
                const gasNowResponse = await fetch('https://www.gasnow.org/api/v3/gas/price');
                if (gasNowResponse.ok) {
                  const gasNowData = await gasNowResponse.json();
                  if (gasNowData.data && gasNowData.data.standard) {
                    const standardGwei = gasNowData.data.standard / 1e9; // Convert wei to gwei
                    avgFee = (21000 * standardGwei * 1e-9); // 21000 gas limit * price in ETH
                    gasSuccess = true;
                    
                    if (standardGwei > 100) congestion = 'high';
                    else if (standardGwei > 50) congestion = 'medium';
                    else congestion = 'low';
                  }
                }
              } catch (gasNowError) {
                console.log('GasNow API failed, trying alternative...');
              }
              
              // If GasNow failed, try gas station API
              if (!gasSuccess) {
                try {
                  const gasResponse = await fetch('https://ethgasstation.info/json/ethgasAPI.json');
                  if (gasResponse.ok) {
                    const gasData = await gasResponse.json();
                    if (gasData.standard) {
                      const standardGwei = gasData.standard / 10; // Gas station returns in deciseconds
                      avgFee = (21000 * standardGwei * 1e-9); // 21000 gas limit * price in ETH
                      gasSuccess = true;
                      
                      if (standardGwei > 100) congestion = 'high';
                      else if (standardGwei > 50) congestion = 'medium';
                      else congestion = 'low';
                    }
                  }
                } catch (gasStationError) {
                  console.log('Gas Station API failed, using default');
                }
              }
              
              // If all APIs failed, ensure we have a valid default
              if (!gasSuccess) {
                console.log('All ETH gas APIs failed, using fallback estimate');
                avgFee = config.avg_transfer_fee; // Use the default 0.002 ETH
                congestion = 'unknown';
              }
            } catch (gasError) {
              console.log('ETH gas estimation completely failed, using default:', gasError.message);
              avgFee = config.avg_transfer_fee; // Ensure we always have a valid fee
              congestion = 'unknown';
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
      // Formula: Base account creation cost = (3x HIVE price) * 1.5
      // Then each crypto adds 20% of its own network fee
      const basePrice = hivePrice * 3; // 3x HIVE price
      const accountCreationCost = basePrice * 1.5; // Add 50% markup - this is the base cost for all
      
      return {
        base_cost_usd: basePrice,
        account_creation_cost_usd: accountCreationCost, // Fixed base cost
        // Note: Individual crypto costs calculated per-crypto in the crypto rates section
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
          // Each crypto has: base account cost + (20% of its network fee)
          const cryptoRates = {};
          for (const [symbol, priceData] of Object.entries(cryptoPrices)) {
            const networkFeeSurcharge = transferCosts[symbol].avg_fee_usd * 0.2; // 20% of network fee
            const totalCostUsd = pricingData.account_creation_cost_usd + networkFeeSurcharge;
            const amountNeeded = totalCostUsd / priceData.price;
            
            cryptoRates[symbol] = {
              price_usd: priceData.price,
              amount_needed: amountNeeded,
              transfer_fee: transferCosts[symbol].avg_fee_crypto,
              total_amount: amountNeeded + transferCosts[symbol].avg_fee_crypto,
              network_fee_surcharge_usd: networkFeeSurcharge,
              final_cost_usd: totalCostUsd
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
              pricingData.account_creation_cost_usd, // This is the fixed base cost
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
          console.log(`Base account creation cost: $${pricingData.account_creation_cost_usd.toFixed(6)} USD`);
          console.log(`HIVE price: $${hiveData.price.toFixed(6)} USD`);
          
          // Log per-crypto pricing
          console.log('Per-crypto final costs:');
          Object.entries(cryptoRates).forEach(([symbol, data]) => {
            console.log(`  ${symbol}: $${data.final_cost_usd.toFixed(6)} USD (base + $${data.network_fee_surcharge_usd.toFixed(6)} network fee)`);
          });
          
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
  
  const generateChannelId = () => {
    return 'CH_' + crypto.randomBytes(16).toString('hex');
  };
  
  const generateMemo = (username, channelId) => {
    return `DLUX Account: ${username} | CH: ${channelId}`;
  };
  
  // Get shared payment address for a crypto type
  const getPaymentAddress = (cryptoType) => {
    const address = PAYMENT_ADDRESSES[cryptoType];
    if (!address || address.includes('0000000') || address.includes('1111111')) {
      throw new Error(`Payment address for ${cryptoType} not configured. Please set ${cryptoType}_PAYMENT_ADDRESS environment variable.`);
    }
    
    return {
      address,
      crypto_type: cryptoType,
      shared: true // Indicates this is a shared address
    };
  };
  
  // Create a new payment channel
  const createPaymentChannel = async (username, cryptoType, amountCrypto, amountUsd, paymentAddress, memo, publicKeys = null) => {
    const client = await pool.connect();
    try {
      const channelId = generateChannelId();
      
      const result = await client.query(`
        INSERT INTO payment_channels 
        (channel_id, username, crypto_type, payment_address, amount_crypto, amount_usd, memo, public_keys)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [channelId, username, cryptoType, paymentAddress.address, amountCrypto, amountUsd, memo, JSON.stringify(publicKeys)]);
      
      return {
        ...result.rows[0],
        address: paymentAddress.address,
        shared: paymentAddress.shared
      };
    } finally {
      client.release();
    }
  };
  
  // Get payment channels (for admin/monitoring)
  const getPaymentChannels = async (limit = 100, offset = 0, status = null, days = 7) => {
    const client = await pool.connect();
    try {
      let query = `
        SELECT 
          pc.*,
          pa.address,
          pa.public_key,
          pa.derivation_path,
          pc.created_at,
          pc.confirmed_at,
          pc.account_created_at,
          CASE 
            WHEN pc.status = 'completed' THEN pc.account_created_at - pc.created_at
            WHEN pc.status = 'confirmed' THEN pc.confirmed_at - pc.created_at
            ELSE NULL
          END as processing_time
        FROM payment_channels pc
        WHERE pc.created_at >= CURRENT_TIMESTAMP - INTERVAL '$1 days'
      `;
      
      const params = [days];
      
      if (status) {
        query += ` AND pc.status = $${params.length + 1}`;
        params.push(status);
      }
      
      query += ` ORDER BY pc.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
      
      const result = await client.query(query, params);
      
      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(*) as total
        FROM payment_channels pc
        WHERE pc.created_at >= CURRENT_TIMESTAMP - INTERVAL '$1 days'
      `;
      
      const countParams = [days];
      if (status) {
        countQuery += ` AND pc.status = $2`;
        countParams.push(status);
      }
      
      const countResult = await client.query(countQuery, countParams);
      
      return {
        channels: result.rows,
        total: parseInt(countResult.rows[0].total),
        pagination: {
          limit,
          offset,
          has_more: (offset + result.rows.length) < parseInt(countResult.rows[0].total)
        }
      };
    } finally {
      client.release();
    }
  };
  
  // Simple authentication middleware (replace with proper auth in production)
  const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const validToken = process.env.ADMIN_TOKEN || 'admin123'; // Set in production!
    
    if (!authHeader || authHeader !== `Bearer ${validToken}`) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - valid Bearer token required'
      });
    }
    
    next();
  };
  
  // API Routes
  
  // 1. Get real-time crypto pricing (updated endpoint)
  router.get('/api/onboarding/pricing', async (req, res) => {
    try {
      const pricing = await pricingService.getLatestPricing();
      
      // Parse JSON fields and ensure valid data
      let cryptoRates = {};
      let transferCosts = {};
      
      try {
        // Parse stored JSON data
        if (typeof pricing.crypto_rates === 'string') {
          cryptoRates = JSON.parse(pricing.crypto_rates);
        } else if (pricing.crypto_rates && typeof pricing.crypto_rates === 'object') {
          cryptoRates = pricing.crypto_rates;
        }
        
        if (typeof pricing.transfer_costs === 'string') {
          transferCosts = JSON.parse(pricing.transfer_costs);
        } else if (pricing.transfer_costs && typeof pricing.transfer_costs === 'object') {
          transferCosts = pricing.transfer_costs;
        }
        
        // Debug logging
        console.log('Parsed pricing data:', {
          hivePrice: pricing.hive_price_usd,
          baseCost: pricing.base_cost_usd,
          finalCost: pricing.final_cost_usd,
          cryptoRatesType: typeof cryptoRates,
          cryptoRatesKeys: Object.keys(cryptoRates),
          transferCostsType: typeof transferCosts,
          transferCostsKeys: Object.keys(transferCosts)
        });
        
      } catch (parseError) {
        console.error('Error parsing pricing JSON data:', parseError);
      }
      
      // Ensure we have valid pricing values
      const hivePrice = pricing.hive_price_usd ? parseFloat(pricing.hive_price_usd) : 0.30;
      const baseCost = pricing.base_cost_usd ? parseFloat(pricing.base_cost_usd) : 0.90;
      // The final_cost_usd field stores the account creation cost (base cost * 1.5)
      const accountCreationCost = pricing.final_cost_usd ? parseFloat(pricing.final_cost_usd) : (baseCost * 1.5);
      
      // Ensure all crypto currencies have complete data
      Object.keys(CRYPTO_CONFIG).forEach(symbol => {
        const config = CRYPTO_CONFIG[symbol];
        
        // Fix transfer costs first if missing or invalid
        if (!transferCosts[symbol] || transferCosts[symbol].avg_fee_usd == null) {
          const priceUsd = cryptoRates[symbol]?.price_usd || config.fallback_price_usd || 100;
          const avgFeeCrypto = config.avg_transfer_fee;
          
          transferCosts[symbol] = {
            avg_fee_crypto: avgFeeCrypto,
            avg_fee_usd: avgFeeCrypto * priceUsd,
            network_congestion: 'normal'
          };
        }
        
        // Just calculate everything fresh - no point in checking stored values
        const priceUsd = cryptoRates[symbol]?.price_usd || config.fallback_price_usd || 100;
        const networkFeeSurcharge = transferCosts[symbol].avg_fee_usd * 0.2; // 20% of network fee
        const totalCostUsd = accountCreationCost + networkFeeSurcharge;
        const amountNeeded = totalCostUsd / priceUsd;
        const transferFee = transferCosts[symbol].avg_fee_crypto;
        
        // Always recalculate to ensure all fields are correct
        cryptoRates[symbol] = {
          price_usd: priceUsd,
          amount_needed: amountNeeded,
          transfer_fee: transferFee,
          total_amount: amountNeeded + transferFee,
          network_fee_surcharge_usd: networkFeeSurcharge,
          final_cost_usd: totalCostUsd
        };
      });
      
      // Force recalculation of account_creation_cost_usd to ensure it's never null
      const finalAccountCreationCost = accountCreationCost || (baseCost * 1.5) || 1.0776; // Ultimate fallback
      
      // Debug logging before response
      console.log('Final response data:', {
        account_creation_cost_usd: finalAccountCreationCost,
        cryptoRatesSample: Object.keys(cryptoRates).slice(0, 2).reduce((acc, key) => {
          acc[key] = cryptoRates[key];
          return acc;
        }, {})
      });
      
      res.json({
        success: true,
        pricing: {
          timestamp: pricing.updated_at,
          hive_price_usd: hivePrice,
          account_creation_cost_usd: finalAccountCreationCost, // Fixed base cost for all
          base_cost_usd: baseCost,
          crypto_rates: cryptoRates, // Each crypto now has its own final_cost_usd
          transfer_costs: transferCosts,
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
            SOL: { price_usd: 100, amount_needed: 0.03, total_amount: 0.030005, transfer_fee: 0.000005 },
            ETH: { price_usd: 2500, amount_needed: 0.0012, total_amount: 0.0032, transfer_fee: 0.002 },
            MATIC: { price_usd: 0.8, amount_needed: 3.75, total_amount: 3.76, transfer_fee: 0.01 },
            BNB: { price_usd: 300, amount_needed: 0.01, total_amount: 0.0105, transfer_fee: 0.0005 }
          },
          transfer_costs: {
            SOL: { avg_fee_crypto: 0.000005, avg_fee_usd: 0.0005, network_congestion: 'normal' },
            ETH: { avg_fee_crypto: 0.002, avg_fee_usd: 5.0, network_congestion: 'normal' },
            MATIC: { avg_fee_crypto: 0.01, avg_fee_usd: 0.008, network_congestion: 'normal' },
            BNB: { avg_fee_crypto: 0.0005, avg_fee_usd: 0.15, network_congestion: 'normal' }
          },
          supported_currencies: Object.keys(CRYPTO_CONFIG)
        }
      });
    }
  });
  
  // 2. Initiate cryptocurrency payment (updated to require all public keys)
  router.post('/api/onboarding/payment/initiate', async (req, res) => {
    try {
      const { username, cryptoType, publicKeys } = req.body;
  
      // Validate input
      if (!username || !cryptoType || !publicKeys) {
        return res.status(400).json({
          success: false,
          error: 'Username, crypto type, and public keys are required'
        });
      }
  
      if (!CRYPTO_CONFIG[cryptoType]) {
        return res.status(400).json({
          success: false,
          error: 'Unsupported cryptocurrency'
        });
      }
  
      // Validate all required public keys are provided
      const requiredKeys = ['owner', 'active', 'posting', 'memo'];
      const missingKeys = requiredKeys.filter(key => !publicKeys[key] || !publicKeys[key].trim());
      
      if (missingKeys.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Missing required public keys: ${missingKeys.join(', ')}`,
          requiredKeys: {
            owner: 'Owner public key (highest authority)',
            active: 'Active public key (financial operations)', 
            posting: 'Posting public key (social operations)',
            memo: 'Memo public key (encrypted messages)'
          }
        });
      }
  
      // Validate public key format (basic HIVE key validation)
      const validatePublicKey = (key, keyType) => {
        if (!key || typeof key !== 'string') {
          throw new Error(`${keyType} key must be a string`);
        }
        
        const trimmed = key.trim();
        if (!trimmed.startsWith('STM') && !trimmed.startsWith('TST')) {
          throw new Error(`${keyType} key must start with STM or TST`);
        }
        
        if (trimmed.length < 50 || trimmed.length > 60) {
          throw new Error(`${keyType} key has invalid length`);
        }
        
        return trimmed;
      };
  
      try {
        const validatedKeys = {
          owner: validatePublicKey(publicKeys.owner, 'Owner'),
          active: validatePublicKey(publicKeys.active, 'Active'),
          posting: validatePublicKey(publicKeys.posting, 'Posting'),
          memo: validatePublicKey(publicKeys.memo, 'Memo')
        };
        
        // Store the validated keys for later use
        publicKeys.validated = validatedKeys;
        
      } catch (keyError) {
        return res.status(400).json({
          success: false,
          error: `Invalid public key: ${keyError.message}`,
          help: 'Public keys should be in HIVE format (STMxxx... or TSTxxx...) and 50-60 characters long'
        });
      }
  
      // Check if username is already being processed or completed
      const client = await pool.connect();
      try {
        const existingChannel = await client.query(
          'SELECT channel_id, status FROM payment_channels WHERE username = $1 AND status IN ($2, $3, $4)',
          [username, 'pending', 'confirmed', 'completed']
        );
        
        if (existingChannel.rows.length > 0) {
          const existing = existingChannel.rows[0];
          return res.status(409).json({
            success: false,
            error: `Account "${username}" is already being processed`,
            existingChannel: {
              channelId: existing.channel_id,
              status: existing.status
            },
            suggestion: 'Choose a different username or check the status of your existing request'
          });
        }
      } finally {
        client.release();
      }
  
      // Get current pricing
      const pricing = await pricingService.getLatestPricing();
      
      // Parse crypto rates if they're stored as JSON string
      let cryptoRates = {};
      try {
        if (typeof pricing.crypto_rates === 'string') {
          cryptoRates = JSON.parse(pricing.crypto_rates);
        } else if (pricing.crypto_rates && typeof pricing.crypto_rates === 'object') {
          cryptoRates = pricing.crypto_rates;
        }
      } catch (parseError) {
        console.error('Error parsing crypto rates:', parseError);
      }
      
      const cryptoRate = cryptoRates[cryptoType];
      
      if (!cryptoRate || !cryptoRate.total_amount) {
        return res.status(500).json({
          success: false,
          error: 'Pricing data not available for this cryptocurrency'
        });
      }
  
      // Generate payment details
      const paymentAddress = getPaymentAddress(cryptoType);
      const memo = generateMemo(username, generateChannelId());
  
      // Create payment channel with provided public keys
      const channel = await createPaymentChannel(
        username,
        cryptoType,
        cryptoRate.total_amount,
        cryptoRate.final_cost_usd, // Use the per-crypto price
        paymentAddress,
        memo,
        publicKeys.validated // Store the validated public keys
      );
  
      res.json({
        success: true,
        payment: {
          channelId: channel.channel_id,
          username,
          cryptoType,
          amount: parseFloat(cryptoRate.total_amount),
          amountFormatted: `${parseFloat(cryptoRate.total_amount).toFixed(CRYPTO_CONFIG[cryptoType].decimals === 18 ? 6 : CRYPTO_CONFIG[cryptoType].decimals)} ${cryptoType}`,
          amountUSD: parseFloat(cryptoRate.final_cost_usd),
          address: paymentAddress.address,
          memo,
          expiresAt: channel.expires_at,
          network: CRYPTO_CONFIG[cryptoType].name,
          confirmationsRequired: CRYPTO_CONFIG[cryptoType].confirmations_required,
          estimatedConfirmationTime: `${Math.ceil(CRYPTO_CONFIG[cryptoType].block_time_seconds * CRYPTO_CONFIG[cryptoType].confirmations_required / 60)} minutes`,
          publicKeysStored: {
            owner: publicKeys.validated.owner,
            active: publicKeys.validated.active, 
            posting: publicKeys.validated.posting,
            memo: publicKeys.validated.memo
          },
          instructions: [
            `Send exactly ${parseFloat(cryptoRate.total_amount).toFixed(CRYPTO_CONFIG[cryptoType].decimals === 18 ? 6 : CRYPTO_CONFIG[cryptoType].decimals)} ${cryptoType} to the address above`,
            `Include the memo: ${memo}`,
            `Payment expires in 24 hours`,
            `Account will be created automatically after ${CRYPTO_CONFIG[cryptoType].confirmations_required} confirmation(s)`,
            `HIVE account @${username} will be created with your provided public keys`
          ]
        }
      });
    } catch (error) {
      console.error('Error initiating payment:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to initiate payment'
      });
    }
  });
  
  // 3. Admin endpoint - Get payment channels (last 7 days)
  router.get('/api/onboarding/admin/channels', authMiddleware, async (req, res) => {
    try {
      const { 
        limit = 50, 
        offset = 0, 
        status = null, 
        days = 7,
        crypto_type = null 
      } = req.query;
  
      const client = await pool.connect();
      try {
        let query = `
          SELECT 
            pc.*,
            CASE 
              WHEN pc.status = 'completed' THEN EXTRACT(EPOCH FROM (pc.account_created_at - pc.created_at))
              WHEN pc.status = 'confirmed' THEN EXTRACT(EPOCH FROM (pc.confirmed_at - pc.created_at))
              ELSE NULL
            END as processing_time_seconds,
            COUNT(*) OVER() as total_count
          FROM payment_channels pc
          WHERE pc.created_at >= CURRENT_TIMESTAMP - INTERVAL '${parseInt(days)} days'
        `;
        
        const params = [];
        
        if (status) {
          query += ` AND pc.status = $${params.length + 1}`;
          params.push(status);
        }
        
        if (crypto_type) {
          query += ` AND pc.crypto_type = $${params.length + 1}`;
          params.push(crypto_type.toUpperCase());
        }
        
        query += ` ORDER BY pc.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit), parseInt(offset));
        
        const result = await client.query(query, params);
        
        // Get status summary
        const summaryQuery = `
          SELECT 
            status, 
            COUNT(*) as count,
            SUM(amount_usd) as total_usd
          FROM payment_channels 
          WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '${parseInt(days)} days'
          ${crypto_type ? `AND crypto_type = '${crypto_type.toUpperCase()}'` : ''}
          GROUP BY status
        `;
        
        const summaryResult = await client.query(summaryQuery);
        
        const channels = result.rows.map(row => ({
          channelId: row.channel_id,
          username: row.username,
          cryptoType: row.crypto_type,
          amountCrypto: parseFloat(row.amount_crypto),
          amountUsd: parseFloat(row.amount_usd),
          address: row.payment_address, // Now stored directly in the channel
          memo: row.memo,
          status: row.status,
          confirmations: row.confirmations,
          txHash: row.tx_hash,
          createdAt: row.created_at,
          confirmedAt: row.confirmed_at,
          accountCreatedAt: row.account_created_at,
          expiresAt: row.expires_at,
          processingTimeSeconds: row.processing_time_seconds,
          publicKeys: row.public_keys,
          shared: true // All addresses are now shared
        }));
        
        const summary = summaryResult.rows.reduce((acc, row) => {
          acc[row.status] = {
            count: parseInt(row.count),
            totalUsd: parseFloat(row.total_usd || 0)
          };
          return acc;
        }, {});
        
        const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
        
        res.json({
          success: true,
          channels,
          summary,
          pagination: {
            limit: parseInt(limit),
            offset: parseInt(offset),
            total: totalCount,
            hasMore: (parseInt(offset) + result.rows.length) < totalCount
          },
          filters: {
            days: parseInt(days),
            status,
            cryptoType: crypto_type
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error fetching payment channels:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch payment channels'
      });
    }
  });
  
  // 4. Check payment channel status
  router.get('/api/onboarding/channel/:channelId/status', async (req, res) => {
    try {
      const { channelId } = req.params;
      
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT pc.*
          FROM payment_channels pc
          WHERE pc.channel_id = $1
        `, [channelId]);
        
        if (result.rows.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Payment channel not found'
          });
        }
        
        const channel = result.rows[0];
        
        res.json({
          success: true,
          channel: {
            channelId: channel.channel_id,
            username: channel.username,
            status: channel.status,
            cryptoType: channel.crypto_type,
            amountCrypto: parseFloat(channel.amount_crypto),
            amountUsd: parseFloat(channel.amount_usd),
            address: channel.payment_address,
            memo: channel.memo,
            confirmations: channel.confirmations,
            confirmationsRequired: CRYPTO_CONFIG[channel.crypto_type].confirmations_required,
            createdAt: channel.created_at,
            confirmedAt: channel.confirmed_at,
            accountCreatedAt: channel.account_created_at,
            expiresAt: channel.expires_at,
            txHash: channel.tx_hash,
            publicKeys: channel.public_keys,
            isExpired: new Date() > new Date(channel.expires_at),
            timeLeft: Math.max(0, Math.floor((new Date(channel.expires_at) - new Date()) / (1000 * 60))), // minutes left
            shared: true // All addresses are shared
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error checking channel status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to check channel status'
      });
    }
  });
  
  // 5. Check payment status (legacy endpoint for backward compatibility)
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
        
        // Clean up expired payment channels
        const channelsResult = await client.query(
          'DELETE FROM payment_channels WHERE expires_at < NOW() AND status = $1',
          ['pending']
        );
        
        res.json({
          success: true,
          cleaned: {
            expiredPayments: paymentsResult.rowCount,
            expiredRequests: requestsResult.rowCount,
            expiredChannels: channelsResult.rowCount
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
  
  // Initialize WebSocket monitor (to be called from main server)
  const initializeWebSocketMonitor = (server) => {
    if (!global.paymentMonitor) {
      global.paymentMonitor = new PaymentChannelMonitor();
      global.paymentMonitor.initialize(server);
      console.log('✓ Payment channel WebSocket monitor initialized');
    }
    return global.paymentMonitor;
  };
  
  // Export the router and initialization function
  module.exports = { 
    router, 
    initializeOnboardingService,
    initializeWebSocketMonitor,
    setupDatabase,
    PaymentChannelMonitor
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