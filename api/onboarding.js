const express = require('express');
const { pool } = require('../index');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const { PaymentChannelMonitor } = require('./wsmonitor');
const blockchainMonitor = require('./blockchain-monitor');
const hiveTx = require('hive-tx');
const config = require('../config');

const router = express.Router();
// CORS middleware for onboarding endpoints
router.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [
        'http://localhost:8080',
        'http://localhost:3000',
        'https://dlux.io',
        'https://www.dlux.io',
        'https://vue.dlux.io'
    ],
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
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            account_created_tx VARCHAR(255)
          )
        `);

            // User notifications system
            await client.query(`
          CREATE TABLE IF NOT EXISTS user_notifications (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) NOT NULL,
            notification_type VARCHAR(50) NOT NULL, -- 'account_request', 'payment_confirmed', 'account_created', etc.
            title VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            data JSONB, -- Additional data like request_id, channel_id, etc.
            status VARCHAR(20) DEFAULT 'unread', -- 'unread', 'read', 'dismissed'
            priority VARCHAR(10) DEFAULT 'normal', -- 'low', 'normal', 'high', 'urgent'
            expires_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            read_at TIMESTAMP,
            dismissed_at TIMESTAMP
          )
        `);

            // Admin users management
            await client.query(`
          CREATE TABLE IF NOT EXISTS admin_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            permissions JSONB DEFAULT '{"admin": true}', -- permissions object
            added_by VARCHAR(50),
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login TIMESTAMP,
            active BOOLEAN DEFAULT true
          )
        `);

            // Initialize default admin if none exist
            const adminCheck = await client.query('SELECT COUNT(*) as count FROM admin_users WHERE active = true');
            if (parseInt(adminCheck.rows[0].count) === 0) {
                await client.query(`
            INSERT INTO admin_users (username, permissions, added_by)
            VALUES ($1, $2, 'system')
          `, [config.username, JSON.stringify({ admin: true, super: true })]);
                console.log(`✓ Default admin user created: @${config.username}`);
            }

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

            // Account Creation Token (ACT) management
            await client.query(`
          CREATE TABLE IF NOT EXISTS act_balance (
            id SERIAL PRIMARY KEY,
            creator_account VARCHAR(50) NOT NULL,
            act_balance INTEGER DEFAULT 0,
            resource_credits BIGINT DEFAULT 0,
            last_claim_time TIMESTAMP,
            last_rc_check TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(creator_account)
          )
        `);

            // Track HIVE account creation attempts and results  
            await client.query(`
          CREATE TABLE IF NOT EXISTS hive_account_creations (
            id SERIAL PRIMARY KEY,
            channel_id VARCHAR(100) REFERENCES payment_channels(channel_id),
            username VARCHAR(50) NOT NULL,
            creation_method VARCHAR(20) NOT NULL, -- 'ACT' or 'DELEGATION'
            act_used INTEGER DEFAULT 0,
            hive_tx_id VARCHAR(255),
            hive_block_num BIGINT,
            creation_fee DECIMAL(20,8),
            attempt_count INTEGER DEFAULT 1,
            status VARCHAR(20) DEFAULT 'attempting', -- 'attempting', 'success', 'failed'
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP
          )
        `);

            // RC costs tracking for real-time HIVE operation costs
            await client.query(`
          CREATE TABLE IF NOT EXISTS rc_costs (
            id SERIAL PRIMARY KEY,
            operation_type VARCHAR(50) NOT NULL,
            rc_needed BIGINT NOT NULL,
            hp_needed DECIMAL(20,8) NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            api_timestamp TIMESTAMP NOT NULL,
            UNIQUE(operation_type, api_timestamp)
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
          CREATE INDEX IF NOT EXISTS idx_act_balance_creator ON act_balance(creator_account);
          CREATE INDEX IF NOT EXISTS idx_hive_creations_channel ON hive_account_creations(channel_id);
          CREATE INDEX IF NOT EXISTS idx_hive_creations_username ON hive_account_creations(username);
          CREATE INDEX IF NOT EXISTS idx_hive_creations_status ON hive_account_creations(status);
          CREATE INDEX IF NOT EXISTS idx_hive_creations_method ON hive_account_creations(creation_method);
          CREATE INDEX IF NOT EXISTS idx_rc_costs_operation ON rc_costs(operation_type);
          CREATE INDEX IF NOT EXISTS idx_rc_costs_timestamp ON rc_costs(api_timestamp);
          CREATE INDEX IF NOT EXISTS idx_notifications_username ON user_notifications(username);
          CREATE INDEX IF NOT EXISTS idx_notifications_status ON user_notifications(status);
          CREATE INDEX IF NOT EXISTS idx_notifications_type ON user_notifications(notification_type);
          CREATE INDEX IF NOT EXISTS idx_notifications_created ON user_notifications(created_at);
          CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);
          CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(active);
        `);

            // Add missing columns to existing tables (for upgrades)
            try {
                await client.query(`
                    ALTER TABLE onboarding_requests 
                    ADD COLUMN IF NOT EXISTS account_created_tx VARCHAR(255)
                `);
                console.log('✓ Database schema updated - added missing columns');
            } catch (alterError) {
                // This might fail on some PostgreSQL versions that don't support IF NOT EXISTS
                // Try without it
                try {
                    await client.query(`
                        ALTER TABLE onboarding_requests 
                        ADD COLUMN account_created_tx VARCHAR(255)
                    `);
                    console.log('✓ Database schema updated - added account_created_tx column');
                } catch (secondError) {
                    // Column probably already exists, which is fine
                    console.log('Database schema already up to date');
                }
            }

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
    BTC: process.env.BTC_PAYMENT_ADDRESS || '', // Example BTC address for development
    SOL: process.env.SOL_PAYMENT_ADDRESS || '', // Example SOL address for development
    ETH: process.env.ETH_PAYMENT_ADDRESS || '', // Example ETH address for development
    MATIC: process.env.MATIC_PAYMENT_ADDRESS || '', // Example MATIC address for development
    BNB: process.env.BNB_PAYMENT_ADDRESS || '' // Example BNB address for development
};

// Crypto configuration with network details and payment channel support
const CRYPTO_CONFIG = {
    BTC: {
        name: 'Bitcoin',
        coingecko_id: 'bitcoin',
        decimals: 8,
        avg_transfer_fee: 0.0001, // Variable based on network congestion
        fallback_price_usd: 50000,
        payment_type: 'address', // Uses address-based payments
        confirmations_required: 2,
        block_time_seconds: 10 * 60, // 10 minutes
        rpc_endpoints: [
            'https://blockstream.info/api',
            'https://api.blockcypher.com/v1/btc/main'
        ]
    },
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
                BTC: { price: 50000, market_cap: null, volume_24h: null, change_24h: null },
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

// HIVE Resource Credit Monitoring Service
class RCMonitoringService {
    constructor() {
        this.lastUpdate = null;
        this.updateInterval = 3 * 60 * 60 * 1000; // 3 hours in milliseconds
        this.isUpdating = false;
        this.currentCosts = {};
        this.rcApiUrl = 'https://beacon.peakd.com/api/rc/costs';
    }

    async fetchRCCosts() {
        try {
            console.log('Fetching latest RC costs from HIVE API...');
            const response = await fetch(this.rcApiUrl);

            if (!response.ok) {
                throw new Error(`RC API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            if (!data.timestamp || !data.costs || !Array.isArray(data.costs)) {
                throw new Error('Invalid RC costs data format');
            }

            const apiTimestamp = new Date(data.timestamp);
            const costs = {};

            // Parse the costs array into a more usable format
            data.costs.forEach(cost => {
                costs[cost.operation] = {
                    rc_needed: parseInt(cost.rc_needed),
                    hp_needed: parseFloat(cost.hp_needed)
                };
            });

            console.log(`✓ Fetched RC costs for ${data.costs.length} operations (timestamp: ${apiTimestamp.toISOString()})`);

            return {
                timestamp: apiTimestamp,
                costs
            };

        } catch (error) {
            console.error('Error fetching RC costs:', error);
            throw error;
        }
    }

    async updateRCCosts() {
        if (this.isUpdating) {
            console.log('RC costs update already in progress, skipping...');
            return;
        }

        this.isUpdating = true;
        console.log('Starting RC costs update...');

        try {
            const rcData = await this.fetchRCCosts();

            const client = await pool.connect();
            try {
                // Store each operation's RC cost
                for (const [operation, cost] of Object.entries(rcData.costs)) {
                    await client.query(`
              INSERT INTO rc_costs (operation_type, rc_needed, hp_needed, api_timestamp)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (operation_type, api_timestamp) 
              DO UPDATE SET 
                rc_needed = EXCLUDED.rc_needed,
                hp_needed = EXCLUDED.hp_needed,
                timestamp = CURRENT_TIMESTAMP
            `, [operation, cost.rc_needed, cost.hp_needed, rcData.timestamp]);
                }

                // Clean up old RC cost data (keep only last 30 days)
                const cleanupDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
                const cleanupResult = await client.query(
                    'DELETE FROM rc_costs WHERE api_timestamp < $1',
                    [cleanupDate]
                );

                if (cleanupResult.rowCount > 0) {
                    console.log(`Cleaned up ${cleanupResult.rowCount} old RC cost records`);
                }

                // Update current costs cache
                this.currentCosts = rcData.costs;
                this.lastUpdate = new Date();

                console.log(`✓ RC costs updated successfully at ${this.lastUpdate.toISOString()}`);

                // Log key operation costs
                const keyOps = ['claim_account_operation', 'create_claimed_account_operation', 'account_create_operation'];
                console.log('Key operation costs:');
                keyOps.forEach(op => {
                    if (this.currentCosts[op]) {
                        const cost = this.currentCosts[op];
                        console.log(`  ${op}: ${(cost.rc_needed / 1e9).toFixed(2)}B RC (${cost.hp_needed.toFixed(2)} HP)`);
                    }
                });

            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error updating RC costs:', error);
        } finally {
            this.isUpdating = false;
        }
    }

    async getLatestRCCosts() {
        try {
            const client = await pool.connect();
            try {
                // Get the most recent RC costs for all operations
                const result = await client.query(`
            SELECT DISTINCT ON (operation_type) 
              operation_type, rc_needed, hp_needed, api_timestamp
            FROM rc_costs 
            ORDER BY operation_type, api_timestamp DESC
          `);

                const costs = {};
                result.rows.forEach(row => {
                    costs[row.operation_type] = {
                        rc_needed: parseInt(row.rc_needed),
                        hp_needed: parseFloat(row.hp_needed),
                        timestamp: row.api_timestamp
                    };
                });

                // If no data in database, try to fetch fresh data
                if (Object.keys(costs).length === 0) {
                    console.log('No RC costs in database, fetching fresh data...');
                    await this.updateRCCosts();
                    return this.currentCosts;
                }

                // Check if data is stale (older than 6 hours)
                const latestTimestamp = Math.max(...result.rows.map(row => new Date(row.api_timestamp).getTime()));
                const dataAge = Date.now() - latestTimestamp;
                const maxAge = 6 * 60 * 60 * 1000; // 6 hours

                if (dataAge > maxAge) {
                    console.log('RC costs data is stale, triggering background update...');
                    setImmediate(() => this.updateRCCosts());
                }

                return costs;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error getting latest RC costs:', error);
            return this.currentCosts; // Fallback to cached data
        }
    }

    getRCCostForOperation(operation) {
        return this.currentCosts[operation] || null;
    }

    startScheduledUpdates() {
        // Initial update
        this.updateRCCosts();

        // Schedule updates every 3 hours
        setInterval(() => {
            this.updateRCCosts();
        }, this.updateInterval);

        console.log('✓ RC monitoring service started (updates every 3 hours)');
    }
}

// Create RC monitoring service instance
const rcMonitoringService = new RCMonitoringService();

// HIVE Account Creation Service
class HiveAccountService {
    constructor() {
        this.creatorUsername = config.username;
        this.creatorKey = config.key;
        this.lastACTCheck = null;
        this.lastRCCheck = null;
        this.actBalance = 0;
        this.resourceCredits = 0;

        if (!this.creatorKey) {
            console.warn('⚠️  HIVE creator key not configured. Set KEY environment variable.');
            console.warn('⚠️  Account creation will be disabled until key is provided.');
        }
    }

    async getHiveAccount(username) {
        try {
            const response = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'condenser_api.get_accounts',
                    params: [[username]],
                    id: 1
                })
            });

            const result = await response.json();
            if (result.result && result.result.length > 0) {
                return result.result[0];
            }
            return null;
        } catch (error) {
            console.error(`Error checking HIVE account ${username}:`, error);
            return null;
        }
    }

    async checkResourceCredits() {
        try {
            const response = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'rc_api.find_rc_accounts',
                    params: { accounts: [this.creatorUsername] },
                    id: 1
                })
            });

            const result = await response.json();
            if (result.result && result.result.rc_accounts && result.result.rc_accounts.length > 0) {
                const rcAccount = result.result.rc_accounts[0];
                this.resourceCredits = parseInt(rcAccount.rc_manabar.current_mana);

                // Update database
                const client = await pool.connect();
                try {
                    await client.query(`
              INSERT INTO act_balance (creator_account, resource_credits, last_rc_check)
              VALUES ($1, $2, CURRENT_TIMESTAMP)
              ON CONFLICT (creator_account)
              DO UPDATE SET 
                resource_credits = EXCLUDED.resource_credits,
                last_rc_check = EXCLUDED.last_rc_check,
                updated_at = CURRENT_TIMESTAMP
            `, [this.creatorUsername, this.resourceCredits]);
                } finally {
                    client.release();
                }

                return this.resourceCredits;
            }
        } catch (error) {
            console.error('Error checking resource credits:', error);
        }
        return 0;
    }

    async claimAccountCreationTokens() {
        try {
            if (!this.creatorKey) {
                console.log('No creator key available for claiming ACTs');
                return false;
            }

            // Get real-time RC costs for claim_account operation
            const rcCosts = await rcMonitoringService.getLatestRCCosts();
            const claimAccountCost = rcCosts['claim_account_operation'];

            if (!claimAccountCost) {
                console.log('RC cost data not available for claim_account_operation, using fallback');
                // Fallback to a conservative estimate based on current data
                const rcNeeded = 13686780357957; // From the API data
                await this.checkResourceCredits();

                if (this.resourceCredits < rcNeeded) {
                    console.log(`Insufficient RCs for claiming ACT. Have: ${this.resourceCredits.toLocaleString()}, Need: ${rcNeeded.toLocaleString()}`);
                    return false;
                }
            } else {
                const rcNeeded = claimAccountCost.rc_needed;
                await this.checkResourceCredits();

                if (this.resourceCredits < rcNeeded) {
                    console.log(`Insufficient RCs for claiming ACT. Have: ${this.resourceCredits.toLocaleString()}, Need: ${rcNeeded.toLocaleString()} (${claimAccountCost.hp_needed.toFixed(2)} HP equivalent)`);
                    return false;
                }

                console.log(`RC check passed. Using ${rcNeeded.toLocaleString()} RC (${claimAccountCost.hp_needed.toFixed(2)} HP equivalent) to claim ACT`);
            }

            console.log('Attempting to claim Account Creation Token...');

            // Create claim_account operation
            const claimAccountOp = [
                'claim_account',
                {
                    creator: this.creatorUsername,
                    fee: '0.000 HIVE', // Free with RCs
                    extensions: []
                }
            ];

            // Get dynamic global properties for transaction
            const dgpResponse = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'condenser_api.get_dynamic_global_properties',
                    params: [],
                    id: 1
                })
            });

            const dgpResult = await dgpResponse.json();
            const dgp = dgpResult.result;

            // Build transaction
            const tx = {
                ref_block_num: dgp.head_block_number & 0xffff,
                ref_block_prefix: Buffer.from(dgp.head_block_id, 'hex').readUInt32LE(4),
                expiration: new Date(Date.now() + 60000).toISOString().slice(0, -5),
                operations: [claimAccountOp],
                extensions: []
            };

            // Sign and broadcast transaction
            const signedTx = hiveTx.sign(tx, this.creatorKey);

            const broadcastResponse = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'condenser_api.broadcast_transaction',
                    params: [signedTx],
                    id: 1
                })
            });

            const broadcastResult = await broadcastResponse.json();

            if (broadcastResult.error) {
                throw new Error(`Broadcast error: ${broadcastResult.error.message}`);
            }

            console.log('✓ Account Creation Token claimed successfully');

            // Update ACT balance in database
            this.actBalance += 1;
            const client = await pool.connect();
            try {
                await client.query(`
            INSERT INTO act_balance (creator_account, act_balance, last_claim_time)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (creator_account)
            DO UPDATE SET 
              act_balance = EXCLUDED.act_balance,
              last_claim_time = EXCLUDED.last_claim_time,
              updated_at = CURRENT_TIMESTAMP
          `, [this.creatorUsername, this.actBalance]);
            } finally {
                client.release();
            }

            return true;

        } catch (error) {
            console.error('Error claiming Account Creation Token:', error);
            return false;
        }
    }

    async createHiveAccount(username, publicKeys, channelId) {
        try {
            if (!this.creatorKey) {
                throw new Error('Creator key not configured');
            }

            console.log(`Creating HIVE account: @${username}`);

            // Check if account already exists
            const existingAccount = await this.getHiveAccount(username);
            if (existingAccount) {
                throw new Error(`Account @${username} already exists on HIVE blockchain`);
            }

            // Check ACT balance and try to claim if needed
            await this.updateACTBalance();

            let useACT = this.actBalance > 0;
            let actUsed = 0;
            let creationMethod = 'DELEGATION';
            let creationFee = 3.0; // 3 HIVE delegation

            if (useACT) {
                creationMethod = 'ACT';
                actUsed = 1;
                creationFee = 0;
            } else {
                // Try to claim an ACT if we have enough RCs
                const claimed = await this.claimAccountCreationTokens();
                if (claimed) {
                    useACT = true;
                    creationMethod = 'ACT';
                    actUsed = 1;
                    creationFee = 0;
                }
            }

            // Record the attempt in database
            let creationAttemptId;
            const client = await pool.connect();
            try {
                const result = await client.query(`
            INSERT INTO hive_account_creations 
            (channel_id, username, creation_method, act_used, creation_fee, status)
            VALUES ($1, $2, $3, $4, $5, 'attempting')
            RETURNING id
          `, [channelId, username, creationMethod, actUsed, creationFee]);

                creationAttemptId = result.rows[0].id;
            } finally {
                client.release();
            }

            // Build account creation operation
            let createAccountOp;

            if (useACT) {
                // Use Account Creation Token
                createAccountOp = [
                    'create_claimed_account',
                    {
                        creator: this.creatorUsername,
                        new_account_name: username,
                        owner: {
                            weight_threshold: 1,
                            account_auths: [],
                            key_auths: [[publicKeys.owner, 1]]
                        },
                        active: {
                            weight_threshold: 1,
                            account_auths: [],
                            key_auths: [[publicKeys.active, 1]]
                        },
                        posting: {
                            weight_threshold: 1,
                            account_auths: [],
                            key_auths: [[publicKeys.posting, 1]]
                        },
                        memo_key: publicKeys.memo,
                        json_metadata: JSON.stringify({
                            created_by: 'dlux.io',
                            creation_method: 'crypto_payment'
                        }),
                        extensions: []
                    }
                ];
            } else {
                // Use HIVE delegation (fallback)
                createAccountOp = [
                    'create_account',
                    {
                        fee: '3.000 HIVE',
                        creator: this.creatorUsername,
                        new_account_name: username,
                        owner: {
                            weight_threshold: 1,
                            account_auths: [],
                            key_auths: [[publicKeys.owner, 1]]
                        },
                        active: {
                            weight_threshold: 1,
                            account_auths: [],
                            key_auths: [[publicKeys.active, 1]]
                        },
                        posting: {
                            weight_threshold: 1,
                            account_auths: [],
                            key_auths: [[publicKeys.posting, 1]]
                        },
                        memo_key: publicKeys.memo,
                        json_metadata: ""
                    }
                ];
            }

            // Get dynamic global properties for transaction
            const dgpResponse = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'condenser_api.get_dynamic_global_properties',
                    params: [],
                    id: 1
                })
            });

            const dgpResult = await dgpResponse.json();
            const dgp = dgpResult.result;

            // Build transaction
            const tx = {
                ref_block_num: dgp.head_block_number & 0xffff,
                ref_block_prefix: Buffer.from(dgp.head_block_id, 'hex').readUInt32LE(4),
                expiration: new Date(Date.now() + 60000).toISOString().slice(0, -5),
                operations: [createAccountOp],
                extensions: []
            };

            // Sign and broadcast transaction
            const signedTx = hiveTx.sign(tx, this.creatorKey);

            const broadcastResponse = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'condenser_api.broadcast_transaction',
                    params: [signedTx],
                    id: 1
                })
            });

            const broadcastResult = await broadcastResponse.json();

            if (broadcastResult.error) {
                throw new Error(`Broadcast error: ${broadcastResult.error.message}`);
            }

            const txId = broadcastResult.result.id;
            const blockNum = broadcastResult.result.block_num;

            console.log(`✓ HIVE account @${username} created successfully! TX: ${txId}`);

            // Update ACT balance if we used one
            if (useACT) {
                this.actBalance -= 1;
                const updateClient = await pool.connect();
                try {
                    await updateClient.query(`
              UPDATE act_balance 
              SET act_balance = $1, updated_at = CURRENT_TIMESTAMP
              WHERE creator_account = $2
            `, [this.actBalance, this.creatorUsername]);
                } finally {
                    updateClient.release();
                }
            }

            // Update creation record
            const finalClient = await pool.connect();
            try {
                await finalClient.query(`
            UPDATE hive_account_creations 
            SET status = 'success', hive_tx_id = $1, hive_block_num = $2, completed_at = CURRENT_TIMESTAMP
            WHERE id = $3
          `, [txId, blockNum, creationAttemptId]);
            } finally {
                finalClient.release();
            }

            return {
                success: true,
                username,
                txId,
                blockNum,
                creationMethod,
                actUsed: actUsed > 0
            };

        } catch (error) {
            console.error(`Error creating HIVE account @${username}:`, error);

            // Update creation record with error
            if (creationAttemptId) {
                const errorClient = await pool.connect();
                try {
                    await errorClient.query(`
              UPDATE hive_account_creations 
              SET status = 'failed', error_message = $1, completed_at = CURRENT_TIMESTAMP
              WHERE id = $2
            `, [error.message, creationAttemptId]);
                } finally {
                    errorClient.release();
                }
            }

            throw error;
        }
    }

    async updateACTBalance() {
        try {
            // Get current ACT balance from HIVE blockchain
            const response = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'condenser_api.get_accounts',
                    params: [[this.creatorUsername]],
                    id: 1
                })
            });

            const result = await response.json();
            if (result.result && result.result.length > 0) {
                const account = result.result[0];
                this.actBalance = account.pending_claimed_accounts || 0;

                // Update database
                const client = await pool.connect();
                try {
                    await client.query(`
              INSERT INTO act_balance (creator_account, act_balance)
              VALUES ($1, $2)
              ON CONFLICT (creator_account)
              DO UPDATE SET 
                act_balance = EXCLUDED.act_balance,
                updated_at = CURRENT_TIMESTAMP
            `, [this.creatorUsername, this.actBalance]);
                } finally {
                    client.release();
                }

                console.log(`Current ACT balance: ${this.actBalance}`);
                return this.actBalance;
            }
        } catch (error) {
            console.error('Error updating ACT balance:', error);
        }
        return 0;
    }

    async monitorPendingCreations() {
        try {
            const client = await pool.connect();
            try {
                // Check for channels that are confirmed but not yet completed
                const result = await client.query(`
            SELECT pc.channel_id, pc.username, pc.public_keys, pc.status
            FROM payment_channels pc
            LEFT JOIN hive_account_creations hac ON pc.channel_id = hac.channel_id
            WHERE pc.status = 'confirmed' 
            AND hac.id IS NULL
            ORDER BY pc.confirmed_at ASC
            LIMIT 10
          `);

                for (const channel of result.rows) {
                    try {
                        console.log(`Processing confirmed payment for @${channel.username}...`);

                        const publicKeys = typeof channel.public_keys === 'string'
                            ? JSON.parse(channel.public_keys)
                            : channel.public_keys;

                        // Create the HIVE account
                        const creationResult = await this.createHiveAccount(
                            channel.username,
                            publicKeys,
                            channel.channel_id
                        );

                        if (creationResult.success) {
                            // Update channel status to completed
                            await client.query(`
                  UPDATE payment_channels 
                  SET status = 'completed', account_created_at = CURRENT_TIMESTAMP
                  WHERE channel_id = $1
                `, [channel.channel_id]);

                            console.log(`✓ Account @${channel.username} created and channel marked as completed`);
                        }

                    } catch (error) {
                        console.error(`Failed to create account for @${channel.username}:`, error);

                        // Mark channel as failed
                        await client.query(`
                UPDATE payment_channels 
                SET status = 'failed'
                WHERE channel_id = $1
              `, [channel.channel_id]);
                    }
                }

                // Also check for accounts that might have been created externally
                await this.checkExternallyCreatedAccounts();

            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error monitoring pending creations:', error);
        }
    }

    async checkExternallyCreatedAccounts() {
        try {
            const client = await pool.connect();
            try {
                // Check pending channels to see if accounts already exist
                const result = await client.query(`
            SELECT channel_id, username
            FROM payment_channels
            WHERE status IN ('confirmed', 'pending')
            AND username IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 50
          `);

                for (const channel of result.rows) {
                    const account = await this.getHiveAccount(channel.username);
                    if (account) {
                        console.log(`Account @${channel.username} found on blockchain - updating status`);

                        await client.query(`
                UPDATE payment_channels 
                SET status = 'completed', account_created_at = CURRENT_TIMESTAMP
                WHERE channel_id = $1
              `, [channel.channel_id]);
                    }
                }
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error checking externally created accounts:', error);
        }
    }

    startMonitoring() {
        // Check ACT balance every 10 minutes
        setInterval(() => {
            this.updateACTBalance();
            this.checkResourceCredits();
        }, 10 * 60 * 1000);

        // Process pending account creations every 30 seconds
        setInterval(() => {
            this.monitorPendingCreations();
        }, 30 * 1000);

        // Try to claim ACTs every hour if we have sufficient RCs and low ACT balance
        setInterval(async () => {
            if (this.actBalance < 3) { // Keep a minimum of 3 ACTs
                // Check if we have enough RCs based on real-time costs
                const rcCosts = await rcMonitoringService.getLatestRCCosts();
                const claimCost = rcCosts['claim_account_operation'];

                if (claimCost && this.resourceCredits >= claimCost.rc_needed) {
                    console.log(`Auto-claiming ACT: Balance low (${this.actBalance}), sufficient RCs (${(this.resourceCredits / 1e9).toFixed(1)}B available, ${(claimCost.rc_needed / 1e9).toFixed(1)}B needed)`);
                    await this.claimAccountCreationTokens();
                } else if (claimCost) {
                    console.log(`Cannot auto-claim ACT: Insufficient RCs. Have ${(this.resourceCredits / 1e9).toFixed(1)}B, need ${(claimCost.rc_needed / 1e9).toFixed(1)}B`);
                }
            }
        }, 60 * 60 * 1000);

        console.log('✓ HIVE Account Service monitoring started');
    }
}

// Create HIVE account service instance
const hiveAccountService = new HiveAccountService();

// Notification helper functions
const createNotification = async (username, type, title, message, data = null, priority = 'normal', expiresInHours = null) => {
    try {
        const client = await pool.connect();
        try {
            const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000) : null;

            await client.query(`
          INSERT INTO user_notifications 
          (username, notification_type, title, message, data, priority, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [username, type, title, message, data ? JSON.stringify(data) : null, priority, expiresAt]);

            console.log(`✓ Notification created for @${username}: ${title}`);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error creating notification:', error);
    }
};

// Utility functions
const generatePaymentId = () => {
    return 'dlux_' + crypto.randomBytes(16).toString('hex');
};

const generateChannelId = () => {
    return 'CH_' + crypto.randomBytes(16).toString('hex');
};

const generateMemo = (username, channelId) => {
    return channelId;
};

// Get shared payment address for a crypto type
const getPaymentAddress = (cryptoType) => {
    const address = PAYMENT_ADDRESSES[cryptoType];
    if (!address) {
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

// HIVE-based authentication middleware
class HiveAuth {
    static async verifySignature(challenge, signature, publicKey) {
        try {
            // Use hive-tx to verify the signature
            const isValid = hiveTx.verify(challenge, signature, publicKey);
            return isValid;
        } catch (error) {
            console.error('Signature verification error:', error);
            return false;
        }
    }

    static async getAccountKeys(username) {
        try {
            const response = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'condenser_api.get_accounts',
                    params: [[username]],
                    id: 1
                })
            });

            const result = await response.json();
            if (result.result && result.result.length > 0) {
                const account = result.result[0];
                return {
                    owner: account.owner.key_auths.map(auth => auth[0]),
                    active: account.active.key_auths.map(auth => auth[0]),
                    posting: account.posting.key_auths.map(auth => auth[0]),
                    memo: account.memo_key
                };
            }
            return null;
        } catch (error) {
            console.error(`Error fetching keys for @${username}:`, error);
            return null;
        }
    }

    static async isAdmin(username) {
        try {
            const client = await pool.connect();
            try {
                const result = await client.query(
                    'SELECT permissions FROM admin_users WHERE username = $1 AND active = true',
                    [username]
                );

                if (result.rows.length > 0) {
                    const permissions = result.rows[0].permissions;
                    return permissions && (permissions.admin === true || permissions.super === true);
                }
                return false;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error checking admin status:', error);
            return false;
        }
    }

    static async updateLastLogin(username) {
        try {
            const client = await pool.connect();
            try {
                await client.query(
                    'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE username = $1',
                    [username]
                );
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error updating last login:', error);
        }
    }
}

// Authentication middleware factory
const createAuthMiddleware = (requireAdmin = false, requireActiveKey = false) => {
    return async (req, res, next) => {
        try {
            const account = req.headers['x-account'];
            const challenge = req.headers['x-challenge'];
            const pubKey = req.headers['x-pubkey'];
            const signature = req.headers['x-signature'];

            // Check required headers
            if (!account || !challenge || !pubKey || !signature) {
                return res.status(401).json({
                    success: false,
                    error: 'Missing authentication headers. Required: x-account, x-challenge, x-pubkey, x-signature',
                    headers: {
                        'x-account': 'HIVE username',
                        'x-challenge': 'Timestamp (Unix seconds)',
                        'x-pubkey': 'Public key used for signing',
                        'x-signature': 'Signature of the challenge'
                    }
                });
            }

            // Validate challenge timestamp (must be within 24 hours)
            const challengeTime = parseInt(challenge);
            const now = Math.floor(Date.now() / 1000);
            const maxAge = 24 * 60 * 60; // 24 hours in seconds

            if (isNaN(challengeTime) || (now - challengeTime) > maxAge || challengeTime > (now + 300)) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid challenge timestamp. Must be within 24 hours and not from future.',
                    currentTime: now,
                    challengeTime: challengeTime,
                    ageSeconds: now - challengeTime
                });
            }

            // Get account keys from HIVE blockchain
            const accountKeys = await HiveAuth.getAccountKeys(account);
            if (!accountKeys) {
                return res.status(401).json({
                    success: false,
                    error: `Account @${account} not found on HIVE blockchain`
                });
            }

            // Check if the provided public key belongs to the account
            const allKeys = [
                ...accountKeys.owner,
                ...accountKeys.active,
                ...accountKeys.posting,
                accountKeys.memo
            ].filter(Boolean);

            if (!allKeys.includes(pubKey)) {
                return res.status(401).json({
                    success: false,
                    error: 'Public key does not belong to the specified account'
                });
            }

            // For admin endpoints, check if user is admin
            if (requireAdmin) {
                const isAdmin = await HiveAuth.isAdmin(account);
                if (!isAdmin) {
                    return res.status(403).json({
                        success: false,
                        error: 'Admin privileges required'
                    });
                }
            }

            // For admin endpoints, require active key
            if (requireActiveKey) {
                if (!accountKeys.active.includes(pubKey)) {
                    return res.status(403).json({
                        success: false,
                        error: 'Active key required for this operation'
                    });
                }
            }

            // Verify the signature
            const challengeString = challenge.toString();
            const isValidSignature = await HiveAuth.verifySignature(challengeString, signature, pubKey);

            if (!isValidSignature) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid signature'
                });
            }

            // If admin, update last login
            if (requireAdmin) {
                await HiveAuth.updateLastLogin(account);
            }

            // Add authentication info to request
            req.auth = {
                account,
                pubKey,
                isAdmin: requireAdmin,
                keyType: accountKeys.owner.includes(pubKey) ? 'owner' :
                    accountKeys.active.includes(pubKey) ? 'active' :
                        accountKeys.posting.includes(pubKey) ? 'posting' : 'memo'
            };

            next();
        } catch (error) {
            console.error('Authentication error:', error);
            res.status(500).json({
                success: false,
                error: 'Authentication service error'
            });
        }
    };
};

// Specific middleware instances
const authMiddleware = createAuthMiddleware(false, false); // Any valid HIVE user
const adminAuthMiddleware = createAuthMiddleware(true, false); // Admin with any key
const adminActiveKeyMiddleware = createAuthMiddleware(true, true); // Admin with active key

// API Routes

// Auth utility endpoints
router.get('/api/onboarding/auth/challenge', (req, res) => {
    const timestamp = Math.floor(Date.now() / 1000);
    res.json({
        success: true,
        challenge: timestamp,
        expires: timestamp + (24 * 60 * 60),
        message: 'Sign this timestamp with your HIVE key',
        instructions: 'Use this timestamp as the challenge in your authentication headers'
    });
});

router.get('/api/onboarding/auth/whoami', authMiddleware, (req, res) => {
    res.json({
        success: true,
        account: req.auth.account,
        keyType: req.auth.keyType,
        isAdmin: req.auth.isAdmin
    });
});

router.get('/api/onboarding/auth/help', (req, res) => {
    res.json({
        success: true,
        authentication: {
            description: 'HIVE blockchain-based authentication using digital signatures',
            required_headers: {
                'x-account': 'Your HIVE username',
                'x-challenge': 'Unix timestamp (get from /auth/challenge)',
                'x-pubkey': 'Public key used for signing',
                'x-signature': 'Signature of the challenge timestamp'
            },
            steps: [
                '1. GET /api/onboarding/auth/challenge to get a timestamp',
                '2. Sign the timestamp with your HIVE private key',
                '3. Include all headers in your request',
                '4. Admin operations require active key, others can use any key'
            ],
            example_js: `
// Get challenge
const challengeResponse = await fetch('/api/onboarding/auth/challenge');
const { challenge } = await challengeResponse.json();

// Sign with hive-tx library (client-side)
const signature = hiveTx.sign(challenge.toString(), privateKey);
const publicKey = hiveTx.PrivateKey.fromString(privateKey).createPublic().toString();

// Make authenticated request
const response = await fetch('/api/onboarding/notifications/123/read', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-account': 'your-username',
    'x-challenge': challenge.toString(),
    'x-pubkey': publicKey,
    'x-signature': signature
  }
});`,
            admin_requirements: {
                view_operations: 'Admin status + any key',
                write_operations: 'Admin status + active key',
                user_management: 'Admin status + active key'
            }
        }
    });
});

// Admin management endpoints
router.get('/api/onboarding/admin/users', adminAuthMiddleware, async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(`
          SELECT 
            username,
            permissions,
            added_by,
            added_at,
            last_login,
            active
          FROM admin_users 
          ORDER BY added_at DESC
        `);

            res.json({
                success: true,
                admins: result.rows,
                requestedBy: req.auth.account
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching admin users:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch admin users'
        });
    }
});

router.post('/api/onboarding/admin/users/add', adminActiveKeyMiddleware, async (req, res) => {
    try {
        const { username, permissions = { admin: true } } = req.body;

        if (!username || !/^[a-z0-9\-\.]{3,16}$/.test(username)) {
            return res.status(400).json({
                success: false,
                error: 'Valid HIVE username required'
            });
        }

        // Check if user exists on HIVE
        const accountExists = await hiveAccountService.getHiveAccount(username);
        if (!accountExists) {
            return res.status(400).json({
                success: false,
                error: `Account @${username} does not exist on HIVE blockchain`
            });
        }

        const client = await pool.connect();
        try {
            // Check if already admin
            const existingResult = await client.query(
                'SELECT username FROM admin_users WHERE username = $1',
                [username]
            );

            if (existingResult.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    error: `@${username} is already an admin`
                });
            }

            // Add new admin
            await client.query(`
          INSERT INTO admin_users (username, permissions, added_by)
          VALUES ($1, $2, $3)
        `, [username, JSON.stringify(permissions), req.auth.account]);

            res.json({
                success: true,
                message: `@${username} added as admin`,
                addedBy: req.auth.account
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error adding admin:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add admin'
        });
    }
});

router.post('/api/onboarding/admin/users/:username/remove', adminActiveKeyMiddleware, async (req, res) => {
    try {
        const { username } = req.params;

        if (username === req.auth.account) {
            return res.status(400).json({
                success: false,
                error: 'Cannot remove yourself as admin'
            });
        }

        const client = await pool.connect();
        try {
            const result = await client.query(
                'UPDATE admin_users SET active = false WHERE username = $1 AND active = true RETURNING username',
                [username]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: `@${username} is not an active admin`
                });
            }

            res.json({
                success: true,
                message: `@${username} removed from admin list`,
                removedBy: req.auth.account
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error removing admin:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to remove admin'
        });
    }
});

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
                    BTC: { price_usd: 50000, amount_needed: 0.00006, total_amount: 0.00016, transfer_fee: 0.0001 },
                    SOL: { price_usd: 100, amount_needed: 0.03, total_amount: 0.030005, transfer_fee: 0.000005 },
                    ETH: { price_usd: 2500, amount_needed: 0.0012, total_amount: 0.0032, transfer_fee: 0.002 },
                    MATIC: { price_usd: 0.8, amount_needed: 3.75, total_amount: 3.76, transfer_fee: 0.01 },
                    BNB: { price_usd: 300, amount_needed: 0.01, total_amount: 0.0105, transfer_fee: 0.0005 }
                },
                transfer_costs: {
                    BTC: { avg_fee_crypto: 0.0001, avg_fee_usd: 5.0, network_congestion: 'normal' },
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

// 3. Admin endpoint - ACT status and management
router.get('/api/onboarding/admin/act-status', adminAuthMiddleware, async (req, res) => {
    try {
        // Update current status
        await hiveAccountService.updateACTBalance();
        await hiveAccountService.checkResourceCredits();

        const client = await pool.connect();
        try {
            // Get ACT balance history
            const actResult = await client.query(`
          SELECT * FROM act_balance 
          WHERE creator_account = $1
          ORDER BY updated_at DESC
          LIMIT 1
        `, [config.username]);

            // Get recent account creations
            const creationsResult = await client.query(`
          SELECT * FROM hive_account_creations
          ORDER BY created_at DESC
          LIMIT 20
        `);

            // Get creation stats
            const statsResult = await client.query(`
          SELECT 
            creation_method,
            status,
            COUNT(*) as count,
            SUM(act_used) as total_acts_used,
            AVG(creation_fee) as avg_fee
          FROM hive_account_creations
          WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
          GROUP BY creation_method, status
          ORDER BY creation_method, status
        `);

            const actData = actResult.rows[0] || {
                creator_account: config.username,
                act_balance: hiveAccountService.actBalance,
                resource_credits: hiveAccountService.resourceCredits
            };

            res.json({
                success: true,
                actStatus: {
                    creatorAccount: config.username,
                    currentACTBalance: hiveAccountService.actBalance,
                    currentResourceCredits: hiveAccountService.resourceCredits,
                    lastACTCheck: actData.updated_at,
                    lastRCCheck: actData.last_rc_check,
                    lastClaimTime: actData.last_claim_time,
                    canClaimACT: hiveAccountService.resourceCredits >= 20000000,
                    recommendClaimACT: hiveAccountService.actBalance < 3 && hiveAccountService.resourceCredits >= 20000000
                },
                recentCreations: creationsResult.rows,
                creationStats: statsResult.rows.reduce((acc, row) => {
                    const key = `${row.creation_method}_${row.status}`;
                    acc[key] = {
                        method: row.creation_method,
                        status: row.status,
                        count: parseInt(row.count),
                        totalACTsUsed: parseInt(row.total_acts_used || 0),
                        averageFee: parseFloat(row.avg_fee || 0)
                    };
                    return acc;
                }, {})
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching ACT status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch ACT status'
        });
    }
});

// 3b. Admin endpoint - Manually claim ACT
router.post('/api/onboarding/admin/claim-act', adminActiveKeyMiddleware, async (req, res) => {
    try {
        const result = await hiveAccountService.claimAccountCreationTokens();

        if (result) {
            res.json({
                success: true,
                message: 'Account Creation Token claimed successfully',
                newBalance: hiveAccountService.actBalance
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'Failed to claim ACT - check RC balance and configuration'
            });
        }
    } catch (error) {
        console.error('Error manually claiming ACT:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to claim Account Creation Token',
            details: error.message
        });
    }
});

// 3c. Admin endpoint - Manually trigger account creation processing
router.post('/api/onboarding/admin/process-pending', adminAuthMiddleware, async (req, res) => {
    try {
        await hiveAccountService.monitorPendingCreations();

        res.json({
            success: true,
            message: 'Pending account creation processing triggered'
        });
    } catch (error) {
        console.error('Error processing pending creations:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process pending creations',
            details: error.message
        });
    }
});

// 3d. Admin endpoint - View current RC costs
router.get('/api/onboarding/admin/rc-costs', adminAuthMiddleware, async (req, res) => {
    try {
        const costs = await rcMonitoringService.getLatestRCCosts();

        // Get historical data for trending
        const client = await pool.connect();
        try {
            const historicalResult = await client.query(`
          SELECT 
            operation_type,
            rc_needed,
            hp_needed,
            api_timestamp
          FROM rc_costs 
          WHERE operation_type IN ('claim_account_operation', 'create_claimed_account_operation', 'account_create_operation')
          AND api_timestamp >= CURRENT_TIMESTAMP - INTERVAL '7 days'
          ORDER BY operation_type, api_timestamp DESC
        `);

            // Group by operation for trending analysis
            const historical = {};
            historicalResult.rows.forEach(row => {
                if (!historical[row.operation_type]) {
                    historical[row.operation_type] = [];
                }
                historical[row.operation_type].push({
                    rc_needed: parseInt(row.rc_needed),
                    hp_needed: parseFloat(row.hp_needed),
                    timestamp: row.api_timestamp
                });
            });

            // Calculate trends
            const trends = {};
            Object.keys(historical).forEach(op => {
                const data = historical[op];
                if (data.length >= 2) {
                    const current = data[0];
                    const previous = data[data.length - 1];
                    const change = ((current.rc_needed - previous.rc_needed) / previous.rc_needed) * 100;
                    trends[op] = {
                        change_percent: change,
                        change_direction: change > 0 ? 'up' : change < 0 ? 'down' : 'stable'
                    };
                }
            });

            res.json({
                success: true,
                rcCosts: {
                    lastUpdate: rcMonitoringService.lastUpdate,
                    currentCosts: costs,
                    keyOperations: {
                        claim_account: costs['claim_account_operation'],
                        create_claimed_account: costs['create_claimed_account_operation'],
                        create_account: costs['account_create_operation']
                    },
                    historical,
                    trends,
                    summary: {
                        totalOperations: Object.keys(costs).length,
                        claimAccountCostInBillionRC: costs['claim_account_operation'] ?
                            (costs['claim_account_operation'].rc_needed / 1e9).toFixed(2) : 'N/A',
                        createAccountCostInMillionRC: costs['create_claimed_account_operation'] ?
                            (costs['create_claimed_account_operation'].rc_needed / 1e6).toFixed(2) : 'N/A',
                        efficiencyRatio: costs['claim_account_operation'] && costs['create_claimed_account_operation'] ?
                            (costs['claim_account_operation'].rc_needed / costs['create_claimed_account_operation'].rc_needed).toFixed(1) : 'N/A'
                    }
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching RC costs:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch RC costs'
        });
    }
});

// 3e. Admin endpoint - Blockchain monitoring status
router.get('/api/onboarding/admin/blockchain-status', adminAuthMiddleware, async (req, res) => {
    try {
        const status = blockchainMonitor.getStatus();
        
        // Get recent payment confirmations
        const client = await pool.connect();
        try {
            const recentConfirmations = await client.query(`
                SELECT 
                    pc.channel_id,
                    pc.crypto_type,
                    pc.amount_crypto,
                    pc.status,
                    pf.tx_hash,
                    pf.confirmations,
                    pf.amount_received,
                    pf.detected_at
                FROM payment_channels pc
                LEFT JOIN payment_confirmations pf ON pc.channel_id = pf.channel_id
                WHERE pc.created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
                AND pf.detected_at IS NOT NULL
                ORDER BY pf.detected_at DESC
                LIMIT 20
            `);

            // Get monitoring statistics
            const stats = await client.query(`
                SELECT 
                    crypto_type,
                    status,
                    COUNT(*) as count,
                    AVG(amount_crypto) as avg_amount,
                    SUM(amount_usd) as total_usd
                FROM payment_channels 
                WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
                GROUP BY crypto_type, status
                ORDER BY crypto_type, status
            `);

            res.json({
                success: true,
                blockchainMonitoring: {
                    status: status,
                    supportedNetworks: Object.keys(CRYPTO_CONFIG),
                    paymentAddresses: PAYMENT_ADDRESSES,
                    recentDetections: recentConfirmations.rows,
                    weeklyStats: stats.rows.map(row => ({
                        cryptoType: row.crypto_type,
                        status: row.status,
                        count: parseInt(row.count),
                        avgAmount: parseFloat(row.avg_amount || 0),
                        totalUsd: parseFloat(row.total_usd || 0)
                    }))
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching blockchain monitoring status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch blockchain monitoring status'
        });
    }
});

// 4. Admin endpoint - Get payment channels (last 7 days)
router.get('/api/onboarding/admin/channels', adminAuthMiddleware, async (req, res) => {
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

// 4. Check payment channel status (for URL restoration)
router.get('/api/onboarding/payment/status/:channelId', async (req, res) => {
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

            // Determine status message and details
            const now = new Date();
            const isExpired = now > new Date(channel.expires_at);
            let statusMessage = 'Unknown';
            let statusDetails = '';
            let progress = 0;

            if (isExpired && channel.status === 'pending') {
                statusMessage = '⏰ Payment expired';
                statusDetails = 'Payment window has closed. Please start a new payment.';
                progress = 0;
            } else {
                switch (channel.status) {
                    case 'pending':
                        if (!channel.tx_hash) {
                            statusMessage = '💳 Waiting for payment';
                            statusDetails = `Send ${channel.amount_crypto} ${channel.crypto_type} to the address with the specified memo.`;
                            progress = 20;
                        } else {
                            statusMessage = '🔍 Payment detected, waiting for confirmations';
                            statusDetails = `Transaction found: ${channel.tx_hash.substring(0, 10)}...`;
                            progress = 40;
                        }
                        break;
                    case 'confirming':
                        const confirmations = channel.confirmations || 0;
                        const required = CRYPTO_CONFIG[channel.crypto_type]?.confirmations_required || 1;
                        statusMessage = `⏳ Confirming transaction (${confirmations}/${required})`;
                        statusDetails = 'Waiting for network confirmations. This may take a few minutes.';
                        progress = 40 + (confirmations / required) * 30;
                        break;
                    case 'confirmed':
                        statusMessage = '⚙️ Creating HIVE account';
                        statusDetails = 'Payment confirmed! Generating your HIVE account...';
                        progress = 80;
                        break;
                    case 'completed':
                        statusMessage = '🎉 Account created successfully!';
                        statusDetails = `Welcome to HIVE, @${channel.username}!`;
                        progress = 100;
                        break;
                    case 'failed':
                        statusMessage = '❌ Account creation failed';
                        statusDetails = 'Something went wrong. Please contact support.';
                        progress = 0;
                        break;
                }
            }

            res.json({
                success: true,
                channel: {
                    channelId: channel.channel_id,
                    username: channel.username,
                    status: channel.status,
                    statusMessage,
                    statusDetails,
                    progress,
                    cryptoType: channel.crypto_type,
                    amountFormatted: `${parseFloat(channel.amount_crypto).toFixed(CRYPTO_CONFIG[channel.crypto_type]?.decimals === 18 ? 6 : CRYPTO_CONFIG[channel.crypto_type]?.decimals || 6)} ${channel.crypto_type}`,
                    address: channel.payment_address,
                    memo: channel.memo,
                    confirmations: channel.confirmations,
                    confirmationsRequired: CRYPTO_CONFIG[channel.crypto_type]?.confirmations_required || 1,
                    createdAt: channel.created_at,
                    confirmedAt: channel.confirmed_at,
                    accountCreatedAt: channel.account_created_at,
                    expiresAt: channel.expires_at,
                    txHash: channel.tx_hash,
                    publicKeys: channel.public_keys,
                    isExpired: isExpired,
                    timeLeft: Math.max(0, Math.floor((new Date(channel.expires_at) - new Date()) / (1000 * 60))), // minutes left
                    instructions: channel.status === 'pending' ? [
                        `Send exactly ${parseFloat(channel.amount_crypto).toFixed(CRYPTO_CONFIG[channel.crypto_type]?.decimals === 18 ? 6 : CRYPTO_CONFIG[channel.crypto_type]?.decimals || 6)} ${channel.crypto_type} to the address above`,
                        `Include the memo: ${channel.memo}`,
                        `Payment expires in ${Math.max(0, Math.floor((new Date(channel.expires_at) - new Date()) / (1000 * 60 * 60)))} hours`,
                        `Account will be created automatically after ${CRYPTO_CONFIG[channel.crypto_type]?.confirmations_required || 1} confirmation(s)`
                    ] : []
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

// 4b. Check payment channel status (alternative endpoint)
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

// 4. Validate account request before sending (pre-flight check)
router.post('/api/onboarding/request/validate', async (req, res) => {
    try {
        const { requesterUsername, requestedFrom, publicKeys } = req.body;

        const errors = [];
        const warnings = [];

        // Validate required fields
        if (!requesterUsername) errors.push('Requester username is required');
        if (!requestedFrom) errors.push('Target username is required');
        if (!publicKeys) errors.push('Public keys are required');

        // Validate username formats
        if (requesterUsername && !/^[a-z0-9\-\.]{3,16}$/.test(requesterUsername)) {
            errors.push('Requester username must be 3-16 characters, lowercase letters, numbers, hyphens, and dots only');
        }

        if (requestedFrom && !/^[a-z0-9\-\.]{3,16}$/.test(requestedFrom)) {
            errors.push('Target username must be 3-16 characters, lowercase letters, numbers, hyphens, and dots only');
        }

        // Validate public keys if provided
        if (publicKeys) {
            const requiredKeys = ['owner', 'active', 'posting', 'memo'];
            const missingKeys = requiredKeys.filter(key => !publicKeys[key] || !publicKeys[key].trim());

            if (missingKeys.length > 0) {
                errors.push(`Missing public keys: ${missingKeys.join(', ')}`);
            }

            // Basic key format validation
            requiredKeys.forEach(keyType => {
                if (publicKeys[keyType]) {
                    const key = publicKeys[keyType].trim();
                    if (!key.startsWith('STM') && !key.startsWith('TST')) {
                        errors.push(`${keyType} key must start with STM or TST`);
                    }
                    if (key.length < 50 || key.length > 60) {
                        errors.push(`${keyType} key has invalid length (should be 50-60 characters)`);
                    }
                }
            });
        }

        // Check for existing requests if no critical errors
        if (errors.length === 0 && requesterUsername) {
            const client = await pool.connect();
            try {
                // Check if account already exists on HIVE
                const existingAccount = await hiveAccountService.getHiveAccount(requesterUsername);
                if (existingAccount) {
                    errors.push(`Account @${requesterUsername} already exists on HIVE blockchain`);
                }

                // Check for pending requests
                const existingResult = await client.query(
                    'SELECT request_id, status FROM onboarding_requests WHERE username = $1 AND status = $2',
                    [requesterUsername, 'pending']
                );

                if (existingResult.rows.length > 0) {
                    errors.push('You already have a pending account creation request');
                }

                // Check if target user exists (this is just a warning)
                if (requestedFrom) {
                    const targetAccount = await hiveAccountService.getHiveAccount(requestedFrom);
                    if (!targetAccount) {
                        warnings.push(`Target user @${requestedFrom} not found on HIVE blockchain. They may not be able to create accounts.`);
                    }
                }

            } finally {
                client.release();
            }
        }

        res.json({
            success: errors.length === 0,
            valid: errors.length === 0,
            errors,
            warnings,
            suggestions: errors.length > 0 ? [
                'Make sure all usernames are valid HIVE format (3-16 chars, lowercase only)',
                'Ensure all 4 public keys are provided and in correct format',
                'Check that the username is not already taken on HIVE'
            ] : []
        });

    } catch (error) {
        console.error('Error validating account request:', error);
        res.status(500).json({
            success: false,
            valid: false,
            errors: ['Validation service temporarily unavailable'],
            warnings: [],
            suggestions: ['Please try again in a moment']
        });
    }
});

// 5. Send friend account request
router.post('/api/onboarding/request/send', async (req, res) => {
    try {
        const { requesterUsername, requestedFrom, message, publicKeys } = req.body

        // Validate input
        if (!requestedFrom || !publicKeys) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: requestedFrom, publicKeys'
            });
        }

        if (!/^[a-z0-9\-\.]{3,16}$/.test(requestedFrom)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid target username format.'
            });
        }

        // Check if user already has pending request
        const client = await pool.connect();
        try {
            const existingResult = await client.query(
                'SELECT id FROM onboarding_requests WHERE username = $1 AND status = $2',
                [requesterUsername, 'pending']
            );

            if (existingResult.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    error: 'You already have a pending account creation request'
                });
            }

            // Create new request
            const requestId = 'req_' + crypto.randomBytes(16).toString('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

            const result = await client.query(
                `INSERT INTO onboarding_requests 
           (request_id, username, requested_by, message, public_keys, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [requestId, requesterUsername, requestedFrom, message || '', JSON.stringify(publicKeys), expiresAt]
            );

            // Create notification for the person being asked to create the account
            await createNotification(
                requestedFrom,
                'account_request',
                'New Account Creation Request',
                `@${requesterUsername} has asked you to help create their HIVE account.${message ? ` Message: "${message}"` : ''}`,
                {
                    request_id: requestId,
                    requester_username: requesterUsername,
                    message: message || 'May I have an account?'
                },
                'normal',
                7 * 24 // Expires in 7 days
            );

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

// 5. Get user notifications and pending items
router.get('/api/onboarding/notifications/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { status = 'all', limit = 50, offset = 0 } = req.query;

        if (!/^[a-z0-9\-\.]{3,16}$/.test(username)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid username format'
            });
        }

        const client = await pool.connect();
        try {
            // Build status filter
            let statusFilter = '';
            let statusParam = [];
            if (status !== 'all') {
                statusFilter = 'AND status = ANY($2)';
                statusParam = [status.split(',')];
            }

            // Get notifications
            const notificationQuery = `
          SELECT 
            id,
            notification_type,
            title,
            message,
            data,
            status,
            priority,
            created_at,
            read_at,
            dismissed_at,
            expires_at
          FROM user_notifications 
          WHERE username = $1 
            AND (expires_at IS NULL OR expires_at > NOW())
            ${statusFilter}
          ORDER BY 
            CASE priority 
              WHEN 'urgent' THEN 1 
              WHEN 'high' THEN 2 
              WHEN 'normal' THEN 3 
              WHEN 'low' THEN 4 
            END,
            created_at DESC
          LIMIT $${statusParam.length + 2} OFFSET $${statusParam.length + 3}
        `;

            const notificationParams = [username, ...statusParam, parseInt(limit), parseInt(offset)];
            const notificationResult = await client.query(notificationQuery, notificationParams);

            // Get pending account requests (both sent by user and sent to user)
            const requestsQuery = `
          SELECT 
            request_id,
            username as requester_username,
            requested_by,
            message,
            status,
            created_at,
            expires_at,
            CASE 
              WHEN requested_by = $1 THEN 'received'
              WHEN username = $1 THEN 'sent'
            END as direction
          FROM onboarding_requests 
          WHERE (requested_by = $1 OR username = $1)
            AND status = 'pending' 
            AND expires_at > NOW()
          ORDER BY created_at DESC
        `;

            const requestsResult = await client.query(requestsQuery, [username]);

            // Get payment channels for this user
            const paymentsQuery = `
          SELECT 
            channel_id,
            username,
            crypto_type,
            amount_crypto,
            amount_usd,
            status,
            created_at,
            confirmed_at,
            account_created_at,
            expires_at
          FROM payment_channels
          WHERE username = $1
            AND status IN ('pending', 'confirmed', 'completed')
          ORDER BY created_at DESC
          LIMIT 10
        `;

            const paymentsResult = await client.query(paymentsQuery, [username]);

            // Count unread notifications
            const unreadCountResult = await client.query(
                `SELECT COUNT(*) as count FROM user_notifications 
           WHERE username = $1 AND status = 'unread' 
           AND (expires_at IS NULL OR expires_at > NOW())`,
                [username]
            );

            const notifications = notificationResult.rows.map(row => ({
                id: row.id,
                type: row.notification_type,
                title: row.title,
                message: row.message,
                data: row.data ? JSON.parse(row.data) : null,
                status: row.status,
                priority: row.priority,
                createdAt: row.created_at,
                readAt: row.read_at,
                dismissedAt: row.dismissed_at,
                expiresAt: row.expires_at
            }));

            res.json({
                success: true,
                username,
                summary: {
                    unreadNotifications: parseInt(unreadCountResult.rows[0].count),
                    pendingAccountRequests: requestsResult.rows.filter(r => r.direction === 'received').length,
                    sentAccountRequests: requestsResult.rows.filter(r => r.direction === 'sent').length,
                    activePayments: paymentsResult.rows.filter(p => p.status !== 'completed').length
                },
                notifications,
                accountRequests: requestsResult.rows,
                payments: paymentsResult.rows,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    hasMore: notificationResult.rows.length === parseInt(limit)
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch notifications'
        });
    }
});

// 6. Get pending requests for a user (legacy endpoint)
// router.get('/api/onboarding/requests/:username', async (req, res) => {
//   try {
//     const { username } = req.params;

//     const client = await pool.connect();
//     try {
//       const result = await client.query(
//         `SELECT id, requester_username, message, public_keys, created_at, expires_at
//          FROM onboarding_requests 
//          WHERE requested_from = $1 AND status = $2 AND expires_at > NOW()
//          ORDER BY created_at DESC`,
//         [username, 'pending']
//       );

//       const requests = result.rows.map(row => ({
//         id: row.id,
//         requesterUsername: row.requester_username,
//         message: row.message,
//         publicKeys: row.public_keys,
//         createdAt: row.created_at,
//         expiresAt: row.expires_at,
//         timeLeft: Math.max(0, Math.floor((new Date(row.expires_at) - new Date()) / (1000 * 60 * 60 * 24))) // days left
//       }));

//       res.json({
//         success: true,
//         requests,
//         count: requests.length
//       });
//     } finally {
//       client.release();
//     }
//   } catch (error) {
//     console.error('Error fetching requests:', error);
//     res.status(500).json({
//       success: false,
//       error: 'Failed to fetch account creation requests'
//     });
//   }
// });

// 6. Mark notification as read
router.post('/api/onboarding/notifications/read/:notificationId', authMiddleware, async (req, res) => {
    try {
        const { notificationId } = req.params;
        const username = req.auth.account; // Use authenticated account

        const client = await pool.connect();
        try {
            const result = await client.query(
                `UPDATE user_notifications 
           SET status = 'read', read_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND username = $2 AND status = 'unread'
           RETURNING id`,
                [notificationId, username]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Notification not found or already read'
                });
            }

            res.json({
                success: true,
                message: 'Notification marked as read'
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to mark notification as read'
        });
    }
});

// 7.1 PiggyBack on HIVE notifications to dismiss notifications
router.post('/api/onboarding/notifications/dismiss/:notificationId', async (req, res) => {
    try {
        const { notificationId } = req.params;

        const transaction = await fetch(config.clientURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'condenser_api.get_transaction',
                params: [notificationId]
            })
        });

        const transactionResult = await transaction.json();
        const tx = transactionResult.result;

        let username
        try {
            username = tx.operations[0][1].required_posting_auths[0]
        } catch (error) {
            return res.status(404).json({
                success: false,
                error: 'Notification not found'
            });
        }

        const client = await pool.connect();
        try {
            const result = await client.query(
                `UPDATE user_notifications 
           SET status = 'dismissed', dismissed_at = CURRENT_TIMESTAMP
           WHERE status != 'dismissed' AND username = $1 AND notification_type != 'account_request'
           RETURNING id, notification_type, data`,
                [username]
            );

            const notifications = result.rows

            // If this was an account request notification, mark the request as ignored
            for (const notification of notifications) {
                if (notification.notification_type === 'account_request' && notification.data) {
                    try {
                        const data = JSON.parse(notification.data);
                        if (data.request_id) {
                            await client.query(
                                `UPDATE onboarding_requests 
                 SET status = 'ignored', updated_at = CURRENT_TIMESTAMP
                 WHERE request_id = $1`,
                                [data.request_id]
                            );

                            // Notify the requester that their request was ignored
                            await createNotification(
                                data.requester_username,
                                'request_status',
                                'Account Request Update',
                                `@${username} has declined your account creation request.`,
                                { request_id: data.request_id, status: 'ignored' },
                                'normal',
                                24
                            );
                        }
                    } catch (parseError) {
                        console.error('Error parsing notification data:', parseError);
                    }
                }
            }

            res.json({
                success: true,
                message: 'Notifications dismissed'
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error dismissing notification:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to dismiss notification'
        });
    }
});

// 7.2 Ignore Account Request
router.post('/api/onboarding/notifications/ignore/:notificationId', authMiddleware, async (req, res) => {
    try {
        const { notificationId } = req.params;

        
        const username = req.headers['x-username']
        

        const client = await pool.connect();
        try {
            const result = await client.query(
                `UPDATE user_notifications 
           SET status = 'dismissed', dismissed_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND username = $2
           RETURNING id, notification_type, data`,
                [notificationId, username]
            );

            const notification = result.rows

            if (notification.notification_type === 'account_request' && notification.data) {
                try {
                    const data = JSON.parse(notification.data);
                    if (data.request_id) {
                        await client.query(
                            `UPDATE onboarding_requests 
                SET status = 'ignored', updated_at = CURRENT_TIMESTAMP
                WHERE request_id = $1`,
                            [data.request_id]
                        );

                        // Notify the requester that their request was ignored
                        await createNotification(
                            data.requester_username,
                            'request_status',
                            'Account Request Update',
                            `@${username} has declined your account creation request.`,
                            { request_id: data.request_id, status: 'ignored' },
                            'normal',
                            24
                        );
                    }
                } catch (parseError) {
                    console.error('Error parsing notification data:', parseError);
                }
            }

            res.json({
                success: true,
                message: 'Notifications dismissed'
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error dismissing notification:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to dismiss notification'
        });
    }
});

// 8. Accept friend request (mark as completed)
router.post('/api/onboarding/request/accept/:requestId', async (req, res) => {
    try {
        const { requestId } = req.params;

        const transaction = await fetch(config.clientURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'condenser_api.get_transaction',
                params: [requestId]
            })
        });

        const transactionResult = await transaction.json();
        
        if (!transactionResult.result) {
            return res.status(404).json({
                success: false,
                error: 'Transaction not found'
            });
        }

        const tx = transactionResult.result;

        let username;
        try {
            username = tx.operations[0][1].new_account_name;
            console.log('Transaction operations:', JSON.stringify(tx.operations, null, 2));
            console.log('Extracted username:', username, 'Type:', typeof username);
        } catch (error) {
            console.log('Error extracting username from transaction:', error);
            console.log('Transaction structure:', JSON.stringify(tx, null, 2));
            return res.status(404).json({
                success: false,
                error: 'Invalid transaction format - not an account creation transaction'
            });
        }
        
        console.log('Account Created:', username);

        const client = await pool.connect();
        try {
            // Debug: Let's see what requests exist for this username
            const debugQuery = await client.query(
                `SELECT request_id, username, status, created_at FROM onboarding_requests 
                 WHERE username = $1
                 ORDER BY created_at DESC`,
                [username]
            );
            
            console.log(`Found ${debugQuery.rows.length} requests for username "${username}":`, debugQuery.rows);

            // Also check for any pending requests regardless of username
            const allPendingQuery = await client.query(
                `SELECT request_id, username, status, created_at FROM onboarding_requests 
                 WHERE status = 'pending'
                 ORDER BY created_at DESC LIMIT 5`
            );
            
            console.log(`All pending requests:`, allPendingQuery.rows);

            // First, find the request by username and verify it exists and is pending
            const requestQuery = await client.query(
                `SELECT request_id, username, status FROM onboarding_requests 
                 WHERE username = $1 AND status = 'pending'
                 ORDER BY created_at DESC LIMIT 1`,
                [username]
            );

            if (requestQuery.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: `No pending account request found for @${username}`,
                    debug: {
                        allRequestsForUsername: debugQuery.rows,
                        allPendingRequests: allPendingQuery.rows
                    }
                });
            }

            const request = requestQuery.rows[0];
            console.log('Found request:', request.request_id);

            // Now update the request
            const result = await client.query(
                `UPDATE onboarding_requests 
                 SET status = $1, account_created_tx = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE request_id = $3
                 RETURNING username, request_id`,
                ['completed', requestId, request.request_id]
            );

            if (result.rows.length === 0) {
                return res.status(500).json({
                    success: false,
                    error: 'Failed to update request'
                });
            }

            // Notify the requester that their account has been created
            await createNotification(
                username,
                'account_created',
                'HIVE Account Created!',
                `Your HIVE account @${username} has been successfully created! Transaction: ${requestId}`,
                {
                    request_id: request.request_id,
                    tx_id: requestId,
                    username: username
                },
                'high',
                168 // 7 days
            );

            res.json({
                success: true,
                message: `Account creation completed for @${result.rows[0].username}`,
                txHash: requestId,
                requestId: result.rows[0].request_id,
                username: result.rows[0].username
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error accepting request:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to accept request',
            details: error.message
        });
    }
});

// 6b. Manual transaction verification endpoint
router.post('/api/onboarding/payment/verify-transaction', async (req, res) => {
    try {
        const { channelId, txHash } = req.body;

        if (!channelId || !txHash) {
            return res.status(400).json({
                success: false,
                error: 'Channel ID and transaction hash are required'
            });
        }

        // Verify the transaction using blockchain monitoring service
        const verificationResult = await blockchainMonitor.manualVerifyTransaction(channelId, txHash);

        if (verificationResult.success) {
            res.json({
                success: true,
                message: 'Transaction verified and payment processed',
                transaction: verificationResult.transaction,
                channelId: verificationResult.channel
            });
        } else {
            res.status(400).json({
                success: false,
                error: verificationResult.error,
                details: 'Transaction could not be verified against payment requirements'
            });
        }
    } catch (error) {
        console.error('Error verifying transaction:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to verify transaction'
        });
    }
});

// 7. Payment monitoring webhook (for external payment processors)
router.post('/api/onboarding/webhook/payment', async (req, res) => {
    try {
        // This endpoint would be called by payment processors like Coinbase Commerce
        const { paymentId, txHash, status, amount, channelId } = req.body;

        // Verify webhook signature here in production

        const client = await pool.connect();
        try {
            if (status === 'confirmed' || status === 'completed') {

                // First try to update payment_channels (new system)
                if (channelId) {
                    const channelResult = await client.query(
                        `UPDATE payment_channels 
               SET status = 'confirmed', tx_hash = $1, confirmed_at = CURRENT_TIMESTAMP
               WHERE channel_id = $2 AND status = 'pending'
               RETURNING username, public_keys, channel_id`,
                        [txHash, channelId]
                    );

                    if (channelResult.rows.length > 0) {
                        const channel = channelResult.rows[0];
                        console.log(`Payment confirmed for channel ${channelId}, @${channel.username}`);

                        // The monitorPendingCreations() will pick this up automatically
                        // But we can also try to process it immediately
                        try {
                            if (hiveAccountService && channel.public_keys) {
                                const publicKeys = typeof channel.public_keys === 'string'
                                    ? JSON.parse(channel.public_keys)
                                    : channel.public_keys;

                                // Trigger account creation in background
                                setImmediate(async () => {
                                    try {
                                        await hiveAccountService.createHiveAccount(
                                            channel.username,
                                            publicKeys,
                                            channel.channel_id
                                        );

                                        // Update channel to completed
                                        const updateClient = await pool.connect();
                                        try {
                                            await updateClient.query(`
                          UPDATE payment_channels 
                          SET status = 'completed', account_created_at = CURRENT_TIMESTAMP
                          WHERE channel_id = $1
                        `, [channel.channel_id]);
                                        } finally {
                                            updateClient.release();
                                        }

                                        console.log(`✓ Account @${channel.username} created via webhook`);
                                    } catch (error) {
                                        console.error(`Failed to create account for @${channel.username} via webhook:`, error);

                                        // Mark as failed
                                        const errorClient = await pool.connect();
                                        try {
                                            await errorClient.query(`
                          UPDATE payment_channels 
                          SET status = 'failed'
                          WHERE channel_id = $1
                        `, [channel.channel_id]);
                                        } finally {
                                            errorClient.release();
                                        }
                                    }
                                });
                            }
                        } catch (bgError) {
                            console.error('Error triggering background account creation:', bgError);
                        }
                    }
                }

                // Also handle legacy payment system
                if (paymentId) {
                    const legacyResult = await client.query(
                        `UPDATE onboarding_payments 
               SET status = $1, tx_hash = $2, updated_at = CURRENT_TIMESTAMP
               WHERE payment_id = $3 AND status = $4
               RETURNING username, public_keys`,
                        ['completed', txHash, paymentId, 'pending']
                    );

                    if (legacyResult.rows.length > 0) {
                        const payment = legacyResult.rows[0];
                        console.log(`Legacy payment confirmed for ${payment.username}`);

                        // Handle legacy payment creation if needed
                        // This would require adapting the old system to the new account creation logic
                    }
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

        // Start RC monitoring service
        rcMonitoringService.startScheduledUpdates();
        console.log('✓ RC monitoring service started with 3-hour updates');

        // Initialize and start HIVE account service
        await hiveAccountService.updateACTBalance();
        await hiveAccountService.checkResourceCredits();
        hiveAccountService.startMonitoring();
        console.log('✓ HIVE Account Service initialized and monitoring started');

        // Start blockchain monitoring service
        await blockchainMonitor.startMonitoring();
        console.log('✓ Blockchain monitoring service started');

        console.log('DLUX Onboarding Service initialized successfully!');
        console.log(`Supported cryptocurrencies: ${Object.keys(CRYPTO_CONFIG).join(', ')}`);
        console.log(`HIVE creator account: @${config.username}`);
        console.log(`Current ACT balance: ${hiveAccountService.actBalance}`);
        console.log(`Current RC balance: ${hiveAccountService.resourceCredits.toLocaleString()}`);

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

// 9. Check if HIVE account exists (public endpoint)
router.get('/api/onboarding/check-account/:username', async (req, res) => {
    try {
        const { username } = req.params;

        if (!username || !/^[a-z0-9\-\.]{3,16}$/.test(username)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid username format'
            });
        }

        const account = await hiveAccountService.getHiveAccount(username);

        res.json({
            success: true,
            username,
            exists: !!account,
            account: account ? {
                name: account.name,
                created: account.created,
                reputation: account.reputation,
                post_count: account.post_count
            } : null
        });
    } catch (error) {
        console.error('Error checking HIVE account:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check HIVE account'
        });
    }
});

// 10. Mirror RC costs API (exact format from beacon.peakd.com)
router.get('/api/rc/costs', async (req, res) => {
    try {
        // Get fresh data from the beacon API
        const response = await fetch('https://beacon.peakd.com/api/rc/costs');

        if (!response.ok) {
            throw new Error(`Beacon API error: ${response.status}`);
        }

        const data = await response.json();

        // Return the exact same format
        res.json(data);
    } catch (error) {
        console.error('Error mirroring RC costs:', error);

        // Fallback to our stored data if beacon API is down
        try {
            const costs = await rcMonitoringService.getLatestRCCosts();
            const costsArray = Object.entries(costs).map(([operation, cost]) => ({
                operation,
                rc_needed: cost.rc_needed.toString(),
                hp_needed: cost.hp_needed
            }));

            res.json({
                timestamp: new Date().toISOString(),
                costs: costsArray
            });
        } catch (fallbackError) {
            res.status(500).json({
                error: 'RC costs service unavailable'
            });
        }
    }
});

// 11. Public endpoint - View current RC costs (for transparency)
router.get('/api/onboarding/rc-costs', async (req, res) => {
    try {
        const costs = await rcMonitoringService.getLatestRCCosts();

        // Only return key operations for public API
        const keyOperations = {
            claim_account_operation: costs['claim_account_operation'],
            create_claimed_account_operation: costs['create_claimed_account_operation'],
            account_create_operation: costs['account_create_operation'],
            transfer_operation: costs['transfer_operation'],
            custom_json_operation: costs['custom_json_operation'],
            vote_operation: costs['vote_operation'],
            comment_operation: costs['comment_operation']
        };

        res.json({
            success: true,
            timestamp: rcMonitoringService.lastUpdate,
            source: 'https://beacon.peakd.com/api/rc/costs',
            updateInterval: '3 hours',
            keyOperations,
            accountCreationCosts: {
                claimACT: {
                    operation: 'claim_account_operation',
                    rc_cost: keyOperations.claim_account_operation?.rc_needed || 'N/A',
                    hp_equivalent: keyOperations.claim_account_operation?.hp_needed || 'N/A',
                    description: 'Cost to claim a free Account Creation Token using RCs'
                },
                useACT: {
                    operation: 'create_claimed_account_operation',
                    rc_cost: keyOperations.create_claimed_account_operation?.rc_needed || 'N/A',
                    hp_equivalent: keyOperations.create_claimed_account_operation?.hp_needed || 'N/A',
                    description: 'Cost to create an account using a claimed ACT'
                },
                delegation: {
                    operation: 'account_create_operation',
                    rc_cost: keyOperations.account_create_operation?.rc_needed || 'N/A',
                    hp_equivalent: keyOperations.account_create_operation?.hp_needed || 'N/A',
                    hive_fee: '3.000 HIVE',
                    description: 'Cost to create an account with HIVE delegation'
                }
            },
            efficiency: {
                claimVsUse: keyOperations.claim_account_operation && keyOperations.create_claimed_account_operation ?
                    `Claiming 1 ACT costs ${(keyOperations.claim_account_operation.rc_needed / 1e12).toFixed(1)}T RC, using it costs ${(keyOperations.create_claimed_account_operation.rc_needed / 1e9).toFixed(1)}B RC` : 'N/A',
                actVsDelegation: keyOperations.create_claimed_account_operation && keyOperations.account_create_operation ?
                    `ACT creation: ${(keyOperations.create_claimed_account_operation.rc_needed / 1e9).toFixed(1)}B RC vs HIVE delegation: ${(keyOperations.account_create_operation.rc_needed / 1e9).toFixed(1)}B RC + 3 HIVE` : 'N/A'
            }
        });
    } catch (error) {
        console.error('Error fetching public RC costs:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch RC costs'
        });
    }
});

// 11. Fetch and merge HIVE Bridge notifications with local notifications
router.get('/api/onboarding/notifications/:username/merged', async (req, res) => {
    try {
        const { username } = req.params;
        const { limit = 100, offset = 0, last_id = null } = req.query;

        const client = await pool.connect();

        try {
            // 1. Get local notifications (account requests, payment confirmations, etc.)
            const localNotificationsQuery = `
          SELECT 
            id,
            notification_type,
            title,
            message,
            data,
            status,
            priority,
            created_at,
            read_at,
            dismissed_at,
            expires_at
          FROM user_notifications 
          WHERE username = $1 
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY created_at DESC
        `;

            const localNotificationsResult = await client.query(localNotificationsQuery, [username]);

            // 2. Get pending account requests (high priority - always at top)
            const requestsQuery = `
          SELECT 
            request_id,
            username as requester_username,
            requested_by,
            message,
            status,
            created_at,
            expires_at,
            public_keys,
            CASE 
              WHEN requested_by = $1 THEN 'received'
              WHEN username = $1 THEN 'sent'
            END as direction
          FROM onboarding_requests 
          WHERE (requested_by = $1 OR username = $1)
            AND status = 'pending' 
            AND expires_at > NOW()
          ORDER BY created_at DESC
        `;

            const requestsResult = await client.query(requestsQuery, [username]);
            //{"id":221,"jsonrpc":"2.0","method":"bridge.unread_notifications","params":{"account":"disregardfiat"}}

            // 2.1 Get unread notifications
            let lastread = 0
            let unRead = 0
            try {
                const unreadHiveNotificationsResponse = await fetch(config.clientURL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'bridge.unread_notifications',
                        params: {
                            account: username
                        },
                        id: 1
                    })
                });
                const unreadHiveNotificationsResult = await unreadHiveNotificationsResponse.json();
                lastread = unreadHiveNotificationsResult.result.lastread
                unRead = unreadHiveNotificationsResult.result.unread
            } catch (error) {
                console.error('Error fetching unread HIVE notifications:', error);
            }

            // 3. Fetch HIVE Bridge notifications
            let hiveNotifications = [];
            try {
                const hiveResponse = await fetch(config.clientURL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'bridge.account_notifications',
                        params: {
                            account: username,
                            limit,
                            last_id
                        },
                        id: 1
                    })
                });

                const hiveResult = await hiveResponse.json();

                if (hiveResult.result && Array.isArray(hiveResult.result)) {
                    hiveNotifications = hiveResult.result.map((notification, index) => ({
                        id: `hive_${notification.id}`,
                        type: 'hive_notification',
                        subtype: notification.type,
                        title: getHiveNotificationTitle(notification),
                        message: getHiveNotificationMessage(notification),
                        data: {
                            hive_notification: notification,
                            url: notification.url,
                            score: notification.score,
                            community: notification.community,
                            community_title: notification.community_title
                        },
                        status: index < unRead ? 'unread' : 'read', // HIVE notifications don't have unread status via API
                        priority: getHiveNotificationPriority(notification),
                        createdAt: new Date(notification.date),
                        readAt: index >= unRead ? lastread : null,
                        dismissedAt: null,
                        expiresAt: null,
                        source: 'hive_bridge'
                    }));
                } else {
                    console.error('Error fetching HIVE notifications:', hiveResult);
                }
            } catch (hiveError) {
                console.error('Error fetching HIVE notifications:', hiveError);
                // Continue without HIVE notifications if the API fails
            }

            // 4. Process local notifications
            const localNotifications = localNotificationsResult.rows.map(row => ({
                id: `local_${row.id}`,
                type: row.notification_type,
                title: row.title,
                message: row.message,
                data: row.data, // ? JSON.parse(row.data) : null,
                status: row.status,
                priority: row.priority,
                createdAt: new Date(row.created_at),
                readAt: row.read_at ? new Date(row.read_at) : null,
                dismissedAt: row.dismissed_at ? new Date(row.dismissed_at) : null,
                expiresAt: row.expires_at ? new Date(row.expires_at) : null,
                source: 'local'
            }));

            // 5. Process account creation requests (always at top)
            const accountRequests = requestsResult.rows.map(row => ({
                id: `request_${row.request_id}`,
                type: 'account_request',
                subtype: row.direction,
                title: row.direction === 'received'
                    ? `Account Creation Request from @${row.requester_username}`
                    : `Account Creation Request sent to @${row.requested_by}`,
                message: row.direction === 'received'
                    ? `@${row.requester_username} is asking you to create their HIVE account.${row.message ? ` Message: "${row.message}"` : ''}`
                    : `Waiting for @${row.requested_by} to create your account.${row.message ? ` Message: "${row.message}"` : ''}`,
                data: {
                    request_id: row.request_id,
                    requester_username: row.requester_username,
                    requested_by: row.requested_by,
                    message: row.message,
                    direction: row.direction,
                    public_keys: row.public_keys,
                    expires_at: row.expires_at
                },
                status: 'unread',
                priority: 'urgent',
                createdAt: new Date(row.created_at),
                readAt: null,
                dismissedAt: null,
                expiresAt: new Date(row.expires_at),
                source: 'account_request'
            }));

            // 6. Merge and sort all notifications
            let allNotifications = [
                ...accountRequests,  // Account requests always at top
                ...localNotifications,
                ...hiveNotifications
            ];

            // Sort by priority first, then by timestamp
            allNotifications.sort((a, b) => {
                const priorityOrder = { urgent: 1, high: 2, normal: 3, low: 4 };
                const aPriority = priorityOrder[a.priority] || 3;
                const bPriority = priorityOrder[b.priority] || 3;

                if (aPriority !== bPriority) {
                    return aPriority - bPriority;
                }

                return new Date(b.createdAt) - new Date(a.createdAt);
            });

            // Apply pagination
            const startIndex = parseInt(offset);
            const endIndex = startIndex + parseInt(limit);
            const paginatedNotifications = allNotifications.slice(startIndex, endIndex);

            // Get counts
            const unreadCount = localNotifications.filter(n => n.status === 'unread').length +
                unRead
            const accountRequestsCount = accountRequests.filter(r => r.data.direction === 'received').length;

            res.json({
                success: true,
                username,
                summary: {
                    total: allNotifications.length,
                    unreadNotifications: unreadCount,
                    pendingAccountRequests: accountRequestsCount,
                    hiveNotifications: hiveNotifications.length,
                    localNotifications: localNotifications.length
                },
                notifications: paginatedNotifications,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    hasMore: endIndex < allNotifications.length,
                    total: allNotifications.length
                }
            });

        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching merged notifications:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch notifications'
        });
    }
});

// Helper functions for HIVE notifications
const getHiveNotificationTitle = (notification) => {
    const titles = {
        vote: '👍 Vote Received',
        mention: '@️ Mentioned',
        follow: '👥 New Follower',
        reblog: '🔄 Content Reblogged',
        reply: '💬 Reply to Your Post',
        transfer: '💰 Transfer Received',
        delegate: '⚡ Delegation Received',
        undelegate: '⚡ Delegation Removed',
        power_up: '🔋 Power Up',
        power_down: '🔋 Power Down',
        witness_vote: '🗳️ Witness Vote',
        proposal_vote: '📋 Proposal Vote',
        receive_reward: '🎁 Rewards Received',
        comment_benefactor_reward: '🎁 Benefactor Reward',
        comment_author_reward: '✍️ Author Reward',
        comment_curator_reward: '🔍 Curator Reward',
        inactive: '😴 Account Inactive Warning'
    };
    return titles[notification.type] || '📢 HIVE Notification';
};

const getHiveNotificationMessage = (notification) => {
    const { type, msg, score } = notification;

    switch (type) {
        case 'vote':
            return `${notification.msg.split(' voted on')[0]} voted on your ${notification.url.includes('/comments/') ? 'comment' : 'post'}${score ? ` (+${score})` : ''}`;
        case 'mention':
            return `${notification.msg.split(' mentioned you')[0]} mentioned you in a ${notification.url.includes('/comments/') ? 'comment' : 'post'}`;
        case 'follow':
            return `${notification.msg.split(' ')[0]} started following you`;
        case 'reblog':
            return `${notification.msg.split(' reblogged')[0]} reblogged your post`;
        case 'reply':
            return `${notification.msg.split(' replied')[0]} replied to your ${notification.url.includes('/comments/') ? 'comment' : 'post'}`;
        case 'transfer':
            return notification.msg;
        case 'delegate':
            return notification.msg;
        case 'undelegate':
            return notification.msg;
        case 'receive_reward':
            return notification.msg;
        default:
            return notification.msg || 'HIVE blockchain activity';
    }
};

const getHiveNotificationPriority = (notification) => {
    const highPriorityTypes = ['transfer', 'delegate', 'mention'];
    const normalPriorityTypes = ['vote', 'follow', 'reblog', 'reply'];

    if (highPriorityTypes.includes(notification.type)) {
        return 'high';
    } else if (normalPriorityTypes.includes(notification.type)) {
        return 'normal';
    } else {
        return 'low';
    }
};

// 12. Create HIVE account for a friend (accept account request)
router.post('/api/onboarding/request/:requestId/create-account', authMiddleware, async (req, res) => {
    try {
        const { requestId } = req.params;
        const { useACT = true } = req.body; // Default to using ACT if available
        const creatorUsername = req.auth.account;

        const client = await pool.connect();
        try {
            // Get the request details
            const requestResult = await client.query(
                `SELECT * FROM onboarding_requests 
           WHERE request_id = $1 AND requested_by = $2 AND status = 'pending'`,
                [requestId, creatorUsername]
            );

            if (requestResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Request not found or you are not authorized to fulfill this request'
                });
            }

            const request = requestResult.rows[0];
            const publicKeys = typeof request.public_keys === 'string'
                ? JSON.parse(request.public_keys)
                : request.public_keys;

            // Check if account already exists
            const existingAccount = await hiveAccountService.getHiveAccount(request.username);
            if (existingAccount) {
                // Mark request as completed
                await client.query(
                    `UPDATE onboarding_requests 
             SET status = 'completed', updated_at = CURRENT_TIMESTAMP
             WHERE request_id = $1`,
                    [requestId]
                );

                return res.status(409).json({
                    success: false,
                    error: `Account @${request.username} already exists on HIVE blockchain`,
                    accountExists: true,
                });
            }

            // Update ACT balance and check resources
            await hiveAccountService.updateACTBalance();
            await hiveAccountService.checkResourceCredits();

            let creationMethod = 'DELEGATION';
            let canUseACT = useACT && hiveAccountService.actBalance > 0;

            // If user wants to use ACT but doesn't have any, try to claim one
            if (useACT && hiveAccountService.actBalance === 0) {
                const rcCosts = await rcMonitoringService.getLatestRCCosts();
                const claimCost = rcCosts['claim_account_operation'];

                if (claimCost && hiveAccountService.resourceCredits >= claimCost.rc_needed) {
                    console.log(`Attempting to claim ACT for friend request...`);
                    const claimed = await hiveAccountService.claimAccountCreationTokens();
                    if (claimed) {
                        canUseACT = true;
                        console.log(`✓ ACT claimed successfully for friend request`);
                    }
                }
            }

            if (canUseACT) {
                creationMethod = 'ACT';
            }

            // Create a temporary payment channel for tracking
            const channelId = generateChannelId();
            await client.query(`
          INSERT INTO payment_channels 
          (channel_id, username, crypto_type, payment_address, amount_crypto, amount_usd, memo, status, public_keys)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
                channelId,
                request.username,
                'HIVE',
                'friend_request',
                creationMethod === 'ACT' ? 0 : 3,
                0,
                `Friend request from @${creatorUsername}`,
                'confirmed',
                JSON.stringify(publicKeys)
            ]);

            // Attempt to create the account
            const creationResult = await hiveAccountService.createHiveAccount(
                request.username,
                publicKeys,
                channelId
            );

            if (creationResult.success) {
                // Mark request as completed
                await client.query(
                    `UPDATE onboarding_requests 
             SET status = 'completed', updated_at = CURRENT_TIMESTAMP
             WHERE request_id = $1`,
                    [requestId]
                );

                // Update payment channel to completed
                await client.query(`
            UPDATE payment_channels 
            SET status = 'completed', account_created_at = CURRENT_TIMESTAMP
            WHERE channel_id = $1
          `, [channelId]);

                // Notify the requester
                await createNotification(
                    request.username,
                    'account_created',
                    'HIVE Account Created!',
                    `Your HIVE account @${request.username} has been created by @${creatorUsername}!`,
                    {
                        request_id: requestId,
                        creator: creatorUsername,
                        tx_id: creationResult.txId,
                        creation_method: creationMethod
                    },
                    'high',
                    168 // 7 days
                );

                res.json({
                    success: true,
                    message: `Account @${request.username} created successfully!`,
                    account: {
                        username: request.username,
                        creator: creatorUsername,
                        txId: creationResult.txId,
                        blockNum: creationResult.blockNum,
                        creationMethod,
                        actUsed: creationResult.actUsed
                    }
                });
            } else {
                throw new Error('Account creation failed');
            }

        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error creating account for friend:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create account',
            details: error.message
        });
    }
});

// Export the router and initialization function
module.exports = {
    router,
    initializeOnboardingService,
    initializeWebSocketMonitor,
    setupDatabase,
    PaymentChannelMonitor,
    hiveAccountService,
    rcMonitoringService
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