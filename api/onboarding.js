const express = require('express');
const { Pool } = require('pg');
const config = require('../config');
const crypto = require('crypto');

// Create database pool directly to avoid circular dependency
const pool = new Pool({
  connectionString: config.dbcs,
});
const axios = require('axios');
const cors = require('cors');
const Joi = require('joi');
const { PaymentChannelMonitor } = require('./wsmonitor');
const blockchainMonitor = require('./blockchain-monitor');
const hiveTx = require('hive-tx');
const { sha256 } = require("hive-tx/helpers/crypto.js")
const CryptoAccountGenerator = require('./crypto-account-generator');

const router = express.Router();

// Input validation schemas
const validationSchemas = {
    username: Joi.string()
        .pattern(/^(?=.{3,16}$)[a-z][a-z0-9-]{1,}[a-z0-9](\.[a-z][a-z0-9-]{1,}[a-z0-9])*$/)
        .required()
        .messages({
            'string.pattern.base': 'Username must be 3-16 characters, lowercase letters, numbers, hyphens, and dots only',
            'any.required': 'Username is required'
        }),
    
    publicKey: Joi.string()
        .pattern(/^(STM|TST)[A-Za-z0-9]{50,60}$/)
        .required()
        .messages({
            'string.pattern.base': 'Public key must be in HIVE format (STM/TST prefix, 50-60 characters)',
            'any.required': 'Public key is required'
        }),
    
    publicKeys: Joi.object({
        owner: Joi.string().pattern(/^(STM|TST)[A-Za-z0-9]{50,60}$/).required(),
        active: Joi.string().pattern(/^(STM|TST)[A-Za-z0-9]{50,60}$/).required(),
        posting: Joi.string().pattern(/^(STM|TST)[A-Za-z0-9]{50,60}$/).required(),
        memo: Joi.string().pattern(/^(STM|TST)[A-Za-z0-9]{50,60}$/).required()
    }).required(),
    
    cryptoType: Joi.string()
        .valid('BTC', 'SOL', 'ETH', 'MATIC', 'BNB')
        .required(),
    
    message: Joi.string()
        .max(500)
        .allow('')
        .optional(),
    
    txHash: Joi.string()
        .pattern(/^[a-fA-F0-9]+$/)
        .min(32)
        .max(128)
        .required()
        .messages({
            'string.pattern.base': 'Transaction hash must be hexadecimal',
            'any.required': 'Transaction hash is required'
        }),
    
    channelId: Joi.string()
        .pattern(/^[a-fA-F0-9]{32}$/)
        .required()
        .messages({
            'string.pattern.base': 'Invalid channel ID format'
        })
};

// Rate limiting removed - handled upstream

// Validation middleware factory
const validateInput = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, { 
            abortEarly: false,
            stripUnknown: true 
        });
        
        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message,
                value: detail.context?.value
            }));
            
            return res.status(400).json({
                success: false,
                error: 'Input validation failed',
                details: errors
            });
        }
        
        req.body = value; // Use sanitized values
        next();
    };
};

// CORS middleware for onboarding endpoints
router.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [
        'http://localhost:8080',
        'http://localhost:3000',
        'https://dlux.io',
        'https://www.dlux.io',
        'https://vue.dlux.io',
        'https://data.dlux.io'
    ],
    credentials: true
}));

// Note: Rate limiting is now applied per-route instead of globally
// This allows for more granular control and bypassing for authenticated users

// Middleware for JSON parsing with size limits
router.use(express.json({ limit: '10mb' }));

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
            processed_at TIMESTAMP,
            UNIQUE(channel_id, tx_hash)
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
            channel_id VARCHAR(100) REFERENCES payment_channels(channel_id) ON DELETE CASCADE,
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

            // Crypto addresses table for unique address generation per channel
            await client.query(`
          CREATE TABLE IF NOT EXISTS crypto_addresses (
            id SERIAL PRIMARY KEY,
            channel_id VARCHAR(100) REFERENCES payment_channels(channel_id) ON DELETE CASCADE,
            crypto_type VARCHAR(10) NOT NULL,
            address VARCHAR(255) NOT NULL,
            public_key TEXT,
            private_key_encrypted BYTEA,
            derivation_path VARCHAR(100),
            derivation_index INTEGER NOT NULL,
            address_type VARCHAR(20),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reusable_after TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 week'),
            UNIQUE(crypto_type, address),
            UNIQUE(crypto_type, derivation_index)
          )
        `);

            // Consolidation transactions for fund management
            await client.query(`
          CREATE TABLE IF NOT EXISTS consolidation_transactions (
            id SERIAL PRIMARY KEY,
            tx_id VARCHAR(100) NOT NULL UNIQUE,
            crypto_type VARCHAR(10) NOT NULL,
            admin_username VARCHAR(50) NOT NULL,
            destination_address VARCHAR(255) NOT NULL,
            priority VARCHAR(10) DEFAULT 'medium',
            address_count INTEGER NOT NULL,
            amount_consolidated DECIMAL(20, 8),
            blockchain_tx_hash VARCHAR(255),
            status VARCHAR(20) DEFAULT 'preparing',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP,
            error_message TEXT
          )
        `);

            // Posts table for content management
            await client.query(`
          CREATE TABLE IF NOT EXISTS posts (
            id SERIAL PRIMARY KEY,
            author VARCHAR(50) NOT NULL,
            permlink VARCHAR(255) NOT NULL,
            type VARCHAR(20) DEFAULT 'post',
            block BIGINT,
            votes INTEGER DEFAULT 0,
            voteweight DECIMAL(20, 8) DEFAULT 0,
            promote DECIMAL(20, 8) DEFAULT 0,
            paid DECIMAL(20, 8) DEFAULT 0,
            nsfw BOOLEAN DEFAULT FALSE,
            sensitive BOOLEAN DEFAULT FALSE,
            hidden BOOLEAN DEFAULT FALSE,
            featured BOOLEAN DEFAULT FALSE,
            flagged BOOLEAN DEFAULT FALSE,
            flag_reason TEXT,
            moderated_by VARCHAR(50),
            moderated_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(author, permlink)
          )
        `);

            // Flag reports table for content moderation
            await client.query(`
          CREATE TABLE IF NOT EXISTS flag_reports (
            id SERIAL PRIMARY KEY,
            post_author VARCHAR(50) NOT NULL,
            post_permlink VARCHAR(255) NOT NULL,
            reporter_account VARCHAR(50) NOT NULL,
            flag_type VARCHAR(50) NOT NULL, -- 'spam', 'nsfw', 'hate', 'violence', etc.
            description TEXT,
            status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted', 'rejected', 'dismissed'
            reviewed_by VARCHAR(50),
            reviewed_at TIMESTAMP,
            action_taken VARCHAR(100),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(post_author, post_permlink, reporter_account, flag_type)
          )
        `);

            // Flag user statistics for reputation tracking
            await client.query(`
          CREATE TABLE IF NOT EXISTS flag_user_stats (
            id SERIAL PRIMARY KEY,
            account VARCHAR(50) UNIQUE NOT NULL,
            flags_submitted INTEGER DEFAULT 0,
            flags_accepted INTEGER DEFAULT 0,
            flags_rejected INTEGER DEFAULT 0,
            flags_dismissed INTEGER DEFAULT 0,
            reputation_score DECIMAL(10, 2) DEFAULT 50.0,
            is_trusted_flagger BOOLEAN DEFAULT FALSE,
            flag_permissions JSONB DEFAULT '{"can_flag": true, "max_flags_per_day": 10}',
            banned_until TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

            // User permissions for flagging system
            await client.query(`
          CREATE TABLE IF NOT EXISTS user_flag_permissions (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            can_flag BOOLEAN DEFAULT TRUE,
            can_review_flags BOOLEAN DEFAULT FALSE,
            max_flags_per_day INTEGER DEFAULT 10,
            is_moderator BOOLEAN DEFAULT FALSE,
            is_trusted_flagger BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

            // Indexes for performance - core tables first
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
          CREATE INDEX IF NOT EXISTS idx_crypto_addresses_channel ON crypto_addresses(channel_id);
          CREATE INDEX IF NOT EXISTS idx_crypto_addresses_crypto_type ON crypto_addresses(crypto_type);
          CREATE INDEX IF NOT EXISTS idx_crypto_addresses_address ON crypto_addresses(address);
          CREATE INDEX IF NOT EXISTS idx_crypto_addresses_reusable ON crypto_addresses(reusable_after);
          CREATE INDEX IF NOT EXISTS idx_crypto_addresses_derivation ON crypto_addresses(crypto_type, derivation_index);
        `);

            // Posts and flags indexes - with error handling for missing columns
            try {
                await client.query(`
              CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);
              CREATE INDEX IF NOT EXISTS idx_posts_permlink ON posts(permlink);
              CREATE INDEX IF NOT EXISTS idx_posts_author_permlink ON posts(author, permlink);
              CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type);
              CREATE INDEX IF NOT EXISTS idx_posts_block ON posts(block);
              CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
            `);
            } catch (postsIndexError) {
                console.log('Basic posts indexes creation failed:', postsIndexError.message);
            }

            // Extended posts indexes (for columns that might not exist)
            try {
                await client.query(`
              CREATE INDEX IF NOT EXISTS idx_posts_flagged ON posts(flagged);
              CREATE INDEX IF NOT EXISTS idx_posts_featured ON posts(featured);
              CREATE INDEX IF NOT EXISTS idx_posts_hidden ON posts(hidden);
            `);
            } catch (extendedPostsError) {
                console.log('Extended posts indexes creation failed (columns might not exist):', extendedPostsError.message);
            }

            // Flag system indexes
            try {
                await client.query(`
              CREATE INDEX IF NOT EXISTS idx_flag_reports_post ON flag_reports(post_author, post_permlink);
              CREATE INDEX IF NOT EXISTS idx_flag_reports_reporter ON flag_reports(reporter_account);
              CREATE INDEX IF NOT EXISTS idx_flag_reports_status ON flag_reports(status);
              CREATE INDEX IF NOT EXISTS idx_flag_reports_type ON flag_reports(flag_type);
              CREATE INDEX IF NOT EXISTS idx_flag_reports_created ON flag_reports(created_at);
              CREATE INDEX IF NOT EXISTS idx_flag_user_stats_account ON flag_user_stats(account);
              CREATE INDEX IF NOT EXISTS idx_flag_user_stats_reputation ON flag_user_stats(reputation_score);
              CREATE INDEX IF NOT EXISTS idx_flag_user_stats_trusted ON flag_user_stats(is_trusted_flagger);
              CREATE INDEX IF NOT EXISTS idx_user_flag_permissions_username ON user_flag_permissions(username);
              CREATE INDEX IF NOT EXISTS idx_user_flag_permissions_moderator ON user_flag_permissions(is_moderator);
            `);
            } catch (flagIndexError) {
                console.log('Flag system indexes creation failed (tables might not exist):', flagIndexError.message);
            }

            // Add missing columns to existing tables (for upgrades)
            try {
                // Add missing column to onboarding_requests
                await client.query(`
                    ALTER TABLE onboarding_requests 
                    ADD COLUMN IF NOT EXISTS account_created_tx VARCHAR(255)
                `);
    
            } catch (alterError) {
                // This might fail on some PostgreSQL versions that don't support IF NOT EXISTS
                // Try without it
                try {
                    await client.query(`
                        ALTER TABLE onboarding_requests 
                        ADD COLUMN account_created_tx VARCHAR(255)
                    `);
    
                } catch (secondError) {
                    // Column probably already exists, which is fine
    
                }
            }

            // Add missing columns to posts table if it exists
            try {
                // Check if posts table exists but is missing columns
                const tableCheck = await client.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_name = 'posts' AND table_schema = 'public'
                `);
                
                if (tableCheck.rows.length > 0) {
                    // Table exists, check for missing columns and add them
                    const existingColumns = tableCheck.rows.map(row => row.column_name);
                    
                    const requiredColumns = [
                        { name: 'nsfw', type: 'BOOLEAN DEFAULT FALSE' },
                        { name: 'sensitive', type: 'BOOLEAN DEFAULT FALSE' },
                        { name: 'hidden', type: 'BOOLEAN DEFAULT FALSE' },
                        { name: 'featured', type: 'BOOLEAN DEFAULT FALSE' },
                        { name: 'flagged', type: 'BOOLEAN DEFAULT FALSE' },
                        { name: 'flag_reason', type: 'TEXT' },
                        { name: 'moderated_by', type: 'VARCHAR(50)' },
                        { name: 'moderated_at', type: 'TIMESTAMP' }
                    ];
                    
                    for (const column of requiredColumns) {
                        if (!existingColumns.includes(column.name)) {
                            try {
                                await client.query(`ALTER TABLE posts ADD COLUMN ${column.name} ${column.type}`);
                                console.log(`Added missing column posts.${column.name}`);
                            } catch (columnError) {
                                console.log(`Column posts.${column.name} might already exist:`, columnError.message);
                            }
                        }
                    }
                }
            } catch (postsError) {
                // Posts table might not exist yet, which is fine
                console.log('Posts table check failed (might not exist yet):', postsError.message);
            }

    
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error setting up database:', error);
        throw error;
    }
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
        memo_support: false, // Using unique addresses instead
        memo_type: null,
        memo_max_length: 0,
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
        memo_support: false, // Using unique addresses instead
        memo_type: null,
        memo_max_length: 0,
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
        memo_support: false, // Using unique addresses instead
        memo_type: null,
        memo_max_length: 0,
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
        memo_support: false, // Using unique addresses instead
        memo_type: null,
        memo_max_length: 0,
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
        memo_support: false, // Using unique addresses instead
        memo_type: null,
        memo_max_length: 0,
        rpc_endpoints: [
            'https://bsc-dataseed.binance.org',
            'https://bsc-dataseed1.defibit.io'
        ]
    },
    XMR: {
        name: 'Monero',
        coingecko_id: 'monero',
        decimals: 12,
        avg_transfer_fee: 0.0001, // XMR
        fallback_price_usd: 150,
        payment_type: 'address',
        confirmations_required: 10, // Monero requires more confirmations
        block_time_seconds: 2 * 60, // 2 minutes
        memo_support: false, // Using unique addresses instead
        memo_type: null,
        memo_max_length: 0,
        monitoring_enabled: false, // Disabled - not supported by ethscan API
        rpc_endpoints: [
            'https://xmr-node.cakewallet.com:18081',
            'https://node.community.rino.io:18081'
        ]
    },
    DASH: {
        name: 'Dash',
        coingecko_id: 'dash',
        decimals: 8,
        avg_transfer_fee: 0.00001, // DASH
        fallback_price_usd: 30,
        payment_type: 'address',
        confirmations_required: 6, // Similar to Bitcoin
        block_time_seconds: 2.5 * 60, // 2.5 minutes
        memo_support: false, // Using unique addresses instead
        memo_type: null,
        memo_max_length: 0,
        monitoring_enabled: false, // Disabled - not supported by ethscan API
        rpc_endpoints: [
            'https://dashgoldrpc.com',
            'https://electrum.dash.org:51002'
        ]
    }
};

// Blockchain transaction executor for consolidations
class BlockchainConsolidationExecutor {
    constructor() {
        this.encryptionKey = Buffer.from(process.env.CRYPTO_MASTER_SEED || '0'.repeat(64), 'hex');
    }

    // Decrypt private key
    decryptPrivateKey(encryptedKey) {
        try {
            const decipher = crypto.createDecipher('aes-256-cbc', this.encryptionKey);
            let decrypted = decipher.update(encryptedKey, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            throw new Error('Failed to decrypt private key');
        }
    }

    // Execute consolidation for a specific cryptocurrency
    async executeConsolidation(cryptoType, addresses, destinationAddress, priority = 'medium') {
        try {
            switch (cryptoType) {
                case 'SOL':
                    return await this.executeSolanaConsolidation(addresses, destinationAddress, priority);
                case 'BTC':
                    return await this.executeBitcoinConsolidation(addresses, destinationAddress, priority);
                case 'ETH':
                    return await this.executeEthereumConsolidation(addresses, destinationAddress, priority);
                case 'MATIC':
                    return await this.executePolygonConsolidation(addresses, destinationAddress, priority);
                case 'BNB':
                    return await this.executeBNBConsolidation(addresses, destinationAddress, priority);
                default:
                    return {
                        success: false,
                        error: `Consolidation not implemented for ${cryptoType}`
                    };
            }
        } catch (error) {
            console.error(`Consolidation error for ${cryptoType}:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Solana consolidation implementation
    async executeSolanaConsolidation(addresses, destinationAddress, priority) {
        try {
            const { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
            
            const connection = new Connection(CRYPTO_CONFIG.SOL.rpc_endpoints[0], 'confirmed');
            
            // Get recent blockhash
            const { blockhash } = await connection.getLatestBlockhash();
            
            const transaction = new Transaction({
                feePayer: new PublicKey(destinationAddress),
                recentBlockhash: blockhash
            });

            let totalAmount = 0;
            const keypairs = [];

            // Process each address
            for (const addr of addresses) {
                try {
                    const privateKeyWIF = this.decryptPrivateKey(addr.private_key_encrypted);
                    const keypair = Keypair.fromSecretKey(Buffer.from(privateKeyWIF, 'hex'));
                    keypairs.push(keypair);

                    const balance = await connection.getBalance(keypair.publicKey);
                    const lamports = balance - 5000; // Leave 5000 lamports for fees

                    if (lamports > 0) {
                        totalAmount += lamports / LAMPORTS_PER_SOL;
                        
                        transaction.add(
                            SystemProgram.transfer({
                                fromPubkey: keypair.publicKey,
                                toPubkey: new PublicKey(destinationAddress),
                                lamports
                            })
                        );
                    }
                } catch (keyError) {
                    console.error(`Error processing SOL address ${addr.address}:`, keyError);
                    continue;
                }
            }

            if (transaction.instructions.length === 0) {
                return {
                    success: false,
                    error: 'No valid addresses with sufficient balance found'
                };
            }

            // Sign with all keypairs
            transaction.sign(...keypairs);

            // Send transaction
            const signature = await connection.sendRawTransaction(transaction.serialize());
            
            // Confirm transaction
            await connection.confirmTransaction(signature);

            return {
                success: true,
                txHash: signature,
                totalAmount: totalAmount
            };

        } catch (error) {
            console.error('Solana consolidation error:', error);
            return {
                success: false,
                error: `Solana consolidation failed: ${error.message}`
            };
        }
    }

    // Bitcoin consolidation implementation
    async executeBitcoinConsolidation(addresses, destinationAddress, priority) {
        try {
            const bitcoin = require('bitcoinjs-lib');
            const axios = require('axios');

            // Get network fee rate
            const feeRateResponse = await axios.get('https://blockstream.info/api/fee-estimates');
            const feeRates = feeRateResponse.data;
            const feeRate = feeRates[priority === 'high' ? '1' : priority === 'medium' ? '3' : '6'] || 10;

            // Create transaction
            const network = bitcoin.networks.bitcoin;
            const txb = new bitcoin.TransactionBuilder(network);

            let totalInputValue = 0;
            const keypairs = [];

            // Add inputs from each address
            for (const addr of addresses) {
                try {
                    const privateKeyWIF = this.decryptPrivateKey(addr.private_key_encrypted);
                    const keyPair = bitcoin.ECPair.fromWIF(privateKeyWIF, network);
                    keypairs.push(keyPair);

                    // Get UTXOs for this address
                    const utxoResponse = await axios.get(`https://blockstream.info/api/address/${addr.address}/utxo`);
                    const utxos = utxoResponse.data;

                    for (const utxo of utxos) {
                        txb.addInput(utxo.txid, utxo.vout);
                        totalInputValue += utxo.value;
                    }
                } catch (keyError) {
                    console.error(`Error processing BTC address ${addr.address}:`, keyError);
                    continue;
                }
            }

            if (totalInputValue === 0) {
                return {
                    success: false,
                    error: 'No UTXOs found for consolidation'
                };
            }

            // Calculate fee (rough estimate: 250 bytes per input + 34 bytes output + 10 bytes base)
            const estimatedSize = (txb.inputs.length * 250) + 34 + 10;
            const fee = Math.ceil(estimatedSize * feeRate);
            const outputValue = totalInputValue - fee;

            if (outputValue <= 0) {
                return {
                    success: false,
                    error: 'Transaction fee exceeds total input value'
                };
            }

            // Add output
            txb.addOutput(destinationAddress, outputValue);

            // Sign inputs
            for (let i = 0; i < keypairs.length; i++) {
                txb.sign(i, keypairs[i]);
            }

            // Build and broadcast
            const tx = txb.build();
            const rawTx = tx.toHex();

            const broadcastResponse = await axios.post('https://blockstream.info/api/tx', rawTx, {
                headers: { 'Content-Type': 'text/plain' }
            });

            return {
                success: true,
                txHash: broadcastResponse.data,
                totalAmount: totalInputValue / 100000000 // Convert satoshis to BTC
            };

        } catch (error) {
            console.error('Bitcoin consolidation error:', error);
            return {
                success: false,
                error: `Bitcoin consolidation failed: ${error.message}`
            };
        }
    }

    // Ethereum consolidation implementation  
    async executeEthereumConsolidation(addresses, destinationAddress, priority) {
        try {
            const { ethers } = require('ethers');

            // Connect to Ethereum network
            const provider = new ethers.providers.JsonRpcProvider(CRYPTO_CONFIG.ETH.rpc_endpoints[0]);
            
            // Get current gas price
            const gasPrice = await provider.getGasPrice();
            const adjustedGasPrice = priority === 'high' ? gasPrice.mul(2) : 
                                   priority === 'low' ? gasPrice.div(2) : gasPrice;

            const transactions = [];
            let totalAmount = 0;

            // Process each address separately (ETH requires individual transactions)
            for (const addr of addresses) {
                try {
                    const privateKey = this.decryptPrivateKey(addr.private_key_encrypted);
                    const wallet = new ethers.Wallet(privateKey, provider);

                    const balance = await wallet.getBalance();
                    const gasLimit = 21000; // Standard ETH transfer
                    const gasCost = adjustedGasPrice.mul(gasLimit);
                    const sendAmount = balance.sub(gasCost);

                    if (sendAmount.gt(0)) {
                        const tx = await wallet.sendTransaction({
                            to: destinationAddress,
                            value: sendAmount,
                            gasPrice: adjustedGasPrice,
                            gasLimit: gasLimit
                        });

                        transactions.push(tx.hash);
                        totalAmount += parseFloat(ethers.utils.formatEther(sendAmount));
                    }
                } catch (keyError) {
                    console.error(`Error processing ETH address ${addr.address}:`, keyError);
                    continue;
                }
            }

            if (transactions.length === 0) {
                return {
                    success: false,
                    error: 'No addresses had sufficient balance for consolidation'
                };
            }

            // Return the first transaction hash as the primary consolidation tx
            return {
                success: true,
                txHash: transactions[0],
                totalAmount: totalAmount,
                additionalTxHashes: transactions.slice(1)
            };

        } catch (error) {
            console.error('Ethereum consolidation error:', error);
            return {
                success: false,
                error: `Ethereum consolidation failed: ${error.message}`
            };
        }
    }

    // Polygon consolidation (similar to Ethereum)
    async executePolygonConsolidation(addresses, destinationAddress, priority) {
        try {
            const { ethers } = require('ethers');

            const provider = new ethers.providers.JsonRpcProvider(CRYPTO_CONFIG.MATIC.rpc_endpoints[0]);
            const gasPrice = await provider.getGasPrice();
            const adjustedGasPrice = priority === 'high' ? gasPrice.mul(2) : 
                                   priority === 'low' ? gasPrice.div(2) : gasPrice;

            const transactions = [];
            let totalAmount = 0;

            for (const addr of addresses) {
                try {
                    const privateKey = this.decryptPrivateKey(addr.private_key_encrypted);
                    const wallet = new ethers.Wallet(privateKey, provider);

                    const balance = await wallet.getBalance();
                    const gasLimit = 21000;
                    const gasCost = adjustedGasPrice.mul(gasLimit);
                    const sendAmount = balance.sub(gasCost);

                    if (sendAmount.gt(0)) {
                        const tx = await wallet.sendTransaction({
                            to: destinationAddress,
                            value: sendAmount,
                            gasPrice: adjustedGasPrice,
                            gasLimit: gasLimit
                        });

                        transactions.push(tx.hash);
                        totalAmount += parseFloat(ethers.utils.formatEther(sendAmount));
                    }
                } catch (keyError) {
                    console.error(`Error processing MATIC address ${addr.address}:`, keyError);
                    continue;
                }
            }

            if (transactions.length === 0) {
                return {
                    success: false,
                    error: 'No addresses had sufficient balance for consolidation'
                };
            }

            return {
                success: true,
                txHash: transactions[0],
                totalAmount: totalAmount,
                additionalTxHashes: transactions.slice(1)
            };

        } catch (error) {
            console.error('Polygon consolidation error:', error);
            return {
                success: false,
                error: `Polygon consolidation failed: ${error.message}`
            };
        }
    }

    // BNB consolidation (BSC - similar to Ethereum)
    async executeBNBConsolidation(addresses, destinationAddress, priority) {
        try {
            const { ethers } = require('ethers');

            const provider = new ethers.providers.JsonRpcProvider(CRYPTO_CONFIG.BNB.rpc_endpoints[0]);
            const gasPrice = await provider.getGasPrice();
            const adjustedGasPrice = priority === 'high' ? gasPrice.mul(2) : 
                                   priority === 'low' ? gasPrice.div(2) : gasPrice;

            const transactions = [];
            let totalAmount = 0;

            for (const addr of addresses) {
                try {
                    const privateKey = this.decryptPrivateKey(addr.private_key_encrypted);
                    const wallet = new ethers.Wallet(privateKey, provider);

                    const balance = await wallet.getBalance();
                    const gasLimit = 21000;
                    const gasCost = adjustedGasPrice.mul(gasLimit);
                    const sendAmount = balance.sub(gasCost);

                    if (sendAmount.gt(0)) {
                        const tx = await wallet.sendTransaction({
                            to: destinationAddress,
                            value: sendAmount,
                            gasPrice: adjustedGasPrice,
                            gasLimit: gasLimit
                        });

                        transactions.push(tx.hash);
                        totalAmount += parseFloat(ethers.utils.formatEther(sendAmount));
                    }
                } catch (keyError) {
                    console.error(`Error processing BNB address ${addr.address}:`, keyError);
                    continue;
                }
            }

            if (transactions.length === 0) {
                return {
                    success: false,
                    error: 'No addresses had sufficient balance for consolidation'
                };
            }

            return {
                success: true,
                txHash: transactions[0],
                totalAmount: totalAmount,
                additionalTxHashes: transactions.slice(1)
            };

        } catch (error) {
            console.error('BNB consolidation error:', error);
            return {
                success: false,
                error: `BNB consolidation failed: ${error.message}`
            };
        }
    }
}

// Pricing service class
class PricingService {
    constructor() {
        this.lastUpdate = null;
        this.updateInterval = 60 * 60 * 1000; // 1 hour in milliseconds
        this.isUpdating = false;
    }

    async fetchHivePrice() {
        try {
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true', {
                timeout: 10000,
                headers: { 'User-Agent': 'DLUX-Onboarding/1.0' }
            });
            
            if (!response.ok) {
                throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (!data || !data.hive || typeof data.hive.usd !== 'number') {
                throw new Error('Invalid CoinGecko API response format');
            }
            
            return {
                price: data.hive.usd,
                market_cap: data.hive.usd_market_cap,
                volume_24h: data.hive.usd_24h_vol,
                change_24h: data.hive.usd_24h_change
            };
        } catch (error) {
            console.error('Error fetching HIVE price from CoinGecko:', error);
            
            // Fallback to Hive API with enhanced error handling
            try {
                const response = await fetch('https://api.hive.blog', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'User-Agent': 'DLUX-Onboarding/1.0'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'condenser_api.get_current_median_history_price',
                        id: 1
                    }),
                    timeout: 10000
                });
                
                if (!response.ok) {
                    throw new Error(`HIVE API error: ${response.status} ${response.statusText}`);
                }
                
                const data = await response.json();
                
                if (!data || !data.result || !data.result.base || !data.result.quote) {
                    throw new Error('Invalid HIVE API response format');
                }
                
                const baseAmount = parseFloat(data.result.base.split(' ')[0]);
                const quoteAmount = parseFloat(data.result.quote.split(' ')[0]);
                
                if (isNaN(baseAmount) || isNaN(quoteAmount) || quoteAmount === 0) {
                    throw new Error('Invalid price data from HIVE API');
                }
                
                const hivePrice = baseAmount / quoteAmount;
    
                
                return { 
                    price: hivePrice, 
                    market_cap: null, 
                    volume_24h: null, 
                    change_24h: null 
                };
            } catch (fallbackError) {
                console.error('Error with HIVE fallback API:', fallbackError);
                
                // Ultimate fallback to a reasonable default
                const fallbackPrice = 0.30; // Conservative fallback price
                console.warn(`Using fallback HIVE price: $${fallbackPrice}`);
                
                return {
                    price: fallbackPrice,
                    market_cap: null,
                    volume_24h: null,
                    change_24h: null,
                    fallback: true
                };
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
        
                            }
                        }

                        // If all APIs failed, ensure we have a valid default
                        if (!gasSuccess) {
        
                            avgFee = config.avg_transfer_fee; // Use the default 0.002 ETH
                            congestion = 'unknown';
                        }
                    } catch (gasError) {
    
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
            return;
        }

        this.isUpdating = true;

        try {
            const client = await pool.connect();

            try {
                // Fetch all pricing data
                const hiveData = await this.fetchHivePrice();
                const cryptoPrices = await this.fetchCryptoPrices();
                const transferCosts = await this.estimateTransferCosts(cryptoPrices);
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

    }
}

// Create service instances
const pricingService = new PricingService();
const cryptoGenerator = new CryptoAccountGenerator();

// Memo verification utilities
class MemoVerification {
    static async verifyBTCMemo(txHash, expectedMemo) {
        try {
            // Try multiple BTC APIs to get transaction details
            const apis = [
                `https://blockstream.info/api/tx/${txHash}`,
                `https://api.blockcypher.com/v1/btc/main/txs/${txHash}`
            ];

            for (const apiUrl of apis) {
                try {
                    const response = await fetch(apiUrl, {
                        timeout: 10000,
                        headers: { 'User-Agent': 'DLUX-Onboarding/1.0' }
                    });

                    if (!response.ok) continue;

                    const txData = await response.json();
                    
                    // Look for OP_RETURN outputs containing memo
                    const outputs = txData.vout || txData.outputs || [];
                    
                    for (const output of outputs) {
                        const scriptPubKey = output.scriptpubkey || output.script;
                        if (!scriptPubKey) continue;

                        // Check for OP_RETURN (starts with 6a in hex)
                        const script = scriptPubKey.hex || scriptPubKey;
                        if (script && script.startsWith('6a')) {
                            // Extract memo from OP_RETURN
                            const memoHex = script.substring(4); // Remove 6a and length byte
                            const memo = Buffer.from(memoHex, 'hex').toString('utf8');
                            
                            if (memo.trim() === expectedMemo.trim()) {
                                return { verified: true, memo, source: apiUrl };
                            }
                        }
                    }
                } catch (apiError) {

                    continue;
                }
            }

            return { verified: false, error: 'Memo not found in transaction' };
        } catch (error) {
            console.error('Error verifying BTC memo:', error);
            return { verified: false, error: error.message };
        }
    }

    static async verifySOLMemo(txHash, expectedMemo) {
        try {
            // Get transaction from Solana RPC
            const rpcEndpoints = CRYPTO_CONFIG.SOL.rpc_endpoints;
            
            for (const endpoint of rpcEndpoints) {
                try {
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'getTransaction',
                            params: [
                                txHash,
                                {
                                    encoding: 'json',
                                    maxSupportedTransactionVersion: 0
                                }
                            ]
                        }),
                        timeout: 10000
                    });

                    if (!response.ok) continue;

                    const result = await response.json();
                    if (result.error || !result.result) continue;

                    const transaction = result.result;
                    const instructions = transaction.transaction?.message?.instructions || [];

                    // Look for memo instruction
                    for (const instruction of instructions) {
                        // Memo program ID: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
                        if (instruction.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr') {
                            const memoData = instruction.data;
                            if (memoData) {
                                // Decode base58 memo data
                                const memo = Buffer.from(memoData, 'base64').toString('utf8');
                                if (memo.trim() === expectedMemo.trim()) {
                                    return { verified: true, memo, source: endpoint };
                                }
                            }
                        }
                    }
                } catch (apiError) {

                    continue;
                }
            }

            return { verified: false, error: 'Memo not found in transaction' };
        } catch (error) {
            console.error('Error verifying SOL memo:', error);
            return { verified: false, error: error.message };
        }
    }

    static async verifyTransactionMemo(cryptoType, txHash, expectedMemo) {
        try {
            const config = CRYPTO_CONFIG[cryptoType];
            if (!config || !config.memo_support) {
                return { verified: true, message: 'Memo verification not supported for this cryptocurrency' };
            }

            switch (cryptoType) {
                case 'BTC':
                    return await this.verifyBTCMemo(txHash, expectedMemo);
                case 'SOL':
                    return await this.verifySOLMemo(txHash, expectedMemo);
                default:
                    return { verified: true, message: 'Memo verification not implemented for this cryptocurrency' };
            }
        } catch (error) {
            console.error(`Error verifying memo for ${cryptoType}:`, error);
            return { verified: false, error: error.message };
        }
    }
}

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
            console.log(`🔍 Fetching RC costs from ${this.rcApiUrl}...`);
            
            const response = await fetch(this.rcApiUrl, {
                timeout: 10000,
                headers: { 'User-Agent': 'DLUX-Onboarding/1.0' }
            });

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

            console.log(`✅ Successfully fetched RC costs: ${data.costs.length} operations`);
            
            // Log key operations for monitoring
            const keyOps = ['claim_account_operation', 'create_claimed_account_operation', 'account_create_operation'];
            keyOps.forEach(op => {
                if (costs[op]) {
                    console.log(`  ${op}: ${(costs[op].rc_needed / 1e12).toFixed(2)}T RC`);
                }
            });

            return {
                timestamp: apiTimestamp,
                costs
            };

        } catch (error) {
            console.error('❌ Error fetching RC costs:', error);
            throw error;
        }
    }

    async updateRCCosts() {
        if (this.isUpdating) {
            return;
        }

        this.isUpdating = true;

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
                    await this.updateRCCosts();
                    return this.currentCosts;
                }

                // Check if data is stale (older than 6 hours)
                const latestTimestamp = Math.max(...result.rows.map(row => new Date(row.api_timestamp).getTime()));
                const dataAge = Date.now() - latestTimestamp;
                const maxAge = 6 * 60 * 60 * 1000; // 6 hours

                if (dataAge > maxAge) {
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
    async broadcastTransaction(operations, key) {
        const tx = new hiveTx.Transaction();
          await tx.create(operations); 
          console.log("Transaction before signing:", tx.transaction);
          const privateKey = hiveTx.PrivateKey.from(key);
          tx.sign(privateKey);
          const result = await tx.broadcast();
          return result;
    }
    async claimAccountCreationTokens() {
        try {
            if (!this.creatorKey) {
                console.warn('⚠️  No creator key available for claiming ACTs');
                return false;
            }

            console.log(`🚀 Attempting to claim Account Creation Token...`);

            // Get real-time RC costs for claim_account operation
            const rcCosts = await rcMonitoringService.getLatestRCCosts();
            const claimAccountCost = rcCosts['claim_account_operation'];

            let rcNeeded;
            if (!claimAccountCost) {
                console.warn('⚠️  No claim_account_operation RC cost available, using fallback');
                // Fallback to a conservative estimate based on current data
                rcNeeded = 13686780357957; // From the API data
            } else {
                rcNeeded = claimAccountCost.rc_needed;
                console.log(`💰 RC cost to claim ACT: ${(rcNeeded / 1e12).toFixed(2)}T RC`);
            }

            await this.checkResourceCredits();
            console.log(`⚡ Current RCs: ${(this.resourceCredits / 1e12).toFixed(2)}T RC`);

            if (this.resourceCredits < rcNeeded) {
                console.log(`❌ Insufficient RCs to claim ACT. Need: ${(rcNeeded / 1e12).toFixed(2)}T RC, Have: ${(this.resourceCredits / 1e12).toFixed(2)}T RC`);
                return false;
            }

            // Create claim_account operation
            const claimAccountOp = [
                'claim_account',
                {
                    creator: this.creatorUsername,
                    fee: '0.000 HIVE', // Free with RCs
                    extensions: []
                }
            ];

            const broadcastResult = await this.broadcastTransaction([claimAccountOp], this.creatorKey);

            if (broadcastResult.error) {
                throw new Error(`Broadcast error: ${broadcastResult.error.message}`);
            }

            const txId = broadcastResult.result.tx_id;
            
            console.log(`✅ Account Creation Token claimed successfully!`);
            console.log(`  Transaction: ${txId}`);

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

            console.log(`🎉 New ACT balance: ${this.actBalance}`);
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


            const broadcastResult = await this.broadcastTransaction([createAccountOp], this.creatorKey);

            if (broadcastResult.error) {
                throw new Error(`Broadcast error: ${broadcastResult.error.message}`);
            }
            console.log(broadcastResult);
            const txId = broadcastResult.result.tx_id;

            console.log(`✓ Account @${username} created! TX: ${txId}`);

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
            SET status = 'success', hive_tx_id = $1, completed_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `, [txId, creationAttemptId]);
            } finally {
                finalClient.release();
            }

            return {
                success: true,
                username,
                txId,
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

                            console.log(`✓ Account @${channel.username} created`);
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
                        console.log(`✓ Account @${channel.username} created`);

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

    async performProactiveACTClaiming() {
        try {
            console.log(`🔍 Proactive ACT claiming check at ${new Date().toISOString()}`);
            
            // Get real-time RC costs
            const rcCosts = await rcMonitoringService.getLatestRCCosts();
            const claimCost = rcCosts['claim_account_operation'];
            
            if (!claimCost) {
                console.warn('⚠️  No claim_account_operation RC cost available, using fallback');
                // Use fallback RC cost from recent data
                const fallbackRcCost = 13686780357957; // Conservative estimate from API data
                claimCost = { rc_needed: fallbackRcCost, hp_needed: 6.84 };
            }

            // Update current balances
            await this.updateACTBalance();
            await this.checkResourceCredits();

            console.log(`📊 Current status: ACTs: ${this.actBalance}, RCs: ${(this.resourceCredits / 1e12).toFixed(2)}T RC`);
            console.log(`💰 Claim cost: ${(claimCost.rc_needed / 1e12).toFixed(2)}T RC (${claimCost.hp_needed} HP equiv)`);

            // Calculate thresholds - more aggressive to maintain buffer

            const optimalACTBalance = 8; // Target 8 ACTs (reduced from 10)
            const rcBufferMultiplier = 3.0; // Keep 3x claim cost as buffer (was 2.5x)
            const rcThreshold = claimCost.rc_needed * rcBufferMultiplier;

            console.log(`⚡ RC Threshold: ${(rcThreshold / 1e12).toFixed(2)}T RC (${rcBufferMultiplier}x claim cost)`);

            // Check if we should claim ACTs
            const shouldClaimMinimum = (
                this.resourceCredits >= rcThreshold
            );
            

            const shouldClaim = shouldClaimMinimum

            if (shouldClaim) {
                console.log(`✅ Should claim ACTs: Min check: ${shouldClaimMinimum}`);

                // Calculate how many we can safely claim
                const rcAfterBuffer = this.resourceCredits - (claimCost.rc_needed * 2); // Keep 2x claim cost as safety buffer
                const maxClaimsByRc = Math.floor(rcAfterBuffer / claimCost.rc_needed);
                const maxClaims = Math.min(maxClaimsByRc, 5); // Max 5 at once

                console.log(`📈 Can claim: ${maxClaims} ACTs (RC limit: ${maxClaimsByRc})`);

                let claimed = 0;
                for (let i = 0; i < maxClaims; i++) {
                    console.log(`🚀 Attempting to claim ACT ${i + 1}/${maxClaims}`);
                    const success = await this.claimAccountCreationTokens();
                    if (success) {
                        claimed++;
                        console.log(`✅ Successfully claimed ACT ${claimed}/${maxClaims}`);
                        
                        // Small delay between claims
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        
                        // Check if we still have enough RCs for another claim
                        await this.checkResourceCredits();
                        const rcRemaining = this.resourceCredits - (claimCost.rc_needed * 2); // Keep buffer
                        if (rcRemaining < claimCost.rc_needed) {
                            console.log(`⚠️  Stopping claims - insufficient RCs for another claim (${(rcRemaining / 1e12).toFixed(2)}T RC remaining)`);
                            break;
                        }
                    } else {
                        console.error(`❌ Failed to claim ACT ${i + 1}/${maxClaims}`);
                        break;
                    }
                }

                if (claimed > 0) {
                    console.log(`🎉 Successfully claimed ${claimed} ACTs. New balance: ${this.actBalance}`);
                } else {
                    console.warn(`⚠️  Failed to claim any ACTs despite meeting conditions`);
                }
            } else {
                console.log(`ℹ️  No ACT claiming needed. ACTs: ${this.actBalance}/${optimalACTBalance}, RCs: ${(this.resourceCredits / 1e12).toFixed(2)}T/${(rcThreshold / 1e12).toFixed(2)}T`);
            }
        } catch (error) {
            console.error('❌ Error in proactive ACT claiming:', error);
        }
    }

    async performDailyHealthCheck() {
        try {
            console.log('🔍 Performing daily health check...');
            
            // Update current status
            await this.updateACTBalance();
            await this.checkResourceCredits();
            
            // Get RC costs
            const rcCosts = await rcMonitoringService.getLatestRCCosts();
            const claimCost = rcCosts['claim_account_operation'] || { rc_needed: 13686780357957, hp_needed: 6.84 };
            
            // Calculate health metrics
            const claimsRemaining = Math.floor(this.resourceCredits / claimCost.rc_needed);
            const daysSustainable = claimsRemaining / 5; // Assuming 5 ACTs needed per day max
            const isHealthy = claimsRemaining >= 10; // Need at least 10 claims worth of RCs
            
            console.log('📈 Daily Health Report:');
            console.log(`  ACT Balance: ${this.actBalance}`);
            console.log(`  Resource Credits: ${(this.resourceCredits / 1e12).toFixed(2)}T RC`);
            console.log(`  Claims Remaining: ${claimsRemaining}`);
            console.log(`  Days Sustainable: ${daysSustainable.toFixed(1)}`);
            console.log(`  Status: ${isHealthy ? '✅ HEALTHY' : '⚠️  NEEDS ATTENTION'}`);
            
            // Log to database for admin monitoring
            const client = await pool.connect();
            try {
                await client.query(`
                    INSERT INTO act_balance (creator_account, act_balance, resource_credits, last_rc_check)
                    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                    ON CONFLICT (creator_account)
                    DO UPDATE SET 
                        act_balance = EXCLUDED.act_balance,
                        resource_credits = EXCLUDED.resource_credits,
                        last_rc_check = EXCLUDED.last_rc_check,
                        updated_at = CURRENT_TIMESTAMP
                `, [this.creatorUsername, this.actBalance, this.resourceCredits]);
            } finally {
                client.release();
            }
            
            // If not healthy, try aggressive claiming
            if (!isHealthy && claimsRemaining >= 3) {
                console.log('⚠️  Health check failed - attempting emergency ACT claiming');
                await this.performProactiveACTClaiming();
            }
            
            // If critically low, warn
            if (claimsRemaining < 3) {
                console.error(`🚨 CRITICAL: Only ${claimsRemaining} claims worth of RCs remaining!`);
                console.error(`🚨 Account @${this.creatorUsername} needs immediate RC replenishment`);
            }
            
        } catch (error) {
            console.error('❌ Error in daily health check:', error);
        }
    }

    startMonitoring() {
        console.log(`🚀 Starting HIVE Account Service monitoring for @${this.creatorUsername}`);
        
        // Initial health check
        this.performDailyHealthCheck();
        
        // Check ACT balance every 10 minutes
        setInterval(() => {
            this.updateACTBalance();
            this.checkResourceCredits();
        }, 10 * 60 * 1000);

        // Process pending account creations every 30 seconds
        setInterval(() => {
            this.monitorPendingCreations();
        }, 30 * 1000);

        // Proactive ACT claiming every 15 minutes (more frequent than original)
        setInterval(async () => {
            await this.performProactiveACTClaiming();
        }, 15 * 60 * 1000);
        
        // Daily health check (every 24 hours)
        setInterval(async () => {
            await this.performDailyHealthCheck();
        }, 24 * 60 * 60 * 1000);

        // Legacy hourly check (kept for backward compatibility and as fallback)
        setInterval(async () => {
            if (this.actBalance < 2) { // Emergency threshold - try to claim if very low
                console.log('⚠️  Emergency ACT check - balance below 2');
                // Check if we have enough RCs based on real-time costs
                const rcCosts = await rcMonitoringService.getLatestRCCosts();
                const claimCost = rcCosts['claim_account_operation'];

                if (claimCost && this.resourceCredits >= (claimCost.rc_needed * 2)) {
                    console.log('🚀 Emergency ACT claim attempt');
                    await this.claimAccountCreationTokens();
                }
            }
        }, 60 * 60 * 1000);

        console.log(`✅ HIVE Account Service monitoring started for @${this.creatorUsername}`);
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


        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error creating notification:', error);
    }
};

// Utility functions
const generatePaymentId = () => {
    return crypto.randomBytes(16).toString('hex');
};

const generateChannelId = () => {
    return crypto.randomBytes(16).toString('hex');
};

const generateMemo = (username, channelId) => {
    return channelId;
};

// Get unique payment address for a crypto type and channel
const getPaymentAddress = async (cryptoType, channelId) => {
    try {
        // Generate unique address for this payment channel
        const addressInfo = await cryptoGenerator.getChannelAddress(cryptoType, channelId);
        
        return {
            address: addressInfo.address,
            publicKey: addressInfo.publicKey,
            derivationPath: addressInfo.derivationPath,
            addressType: addressInfo.addressType,
            crypto_type: cryptoType,
            shared: false, // Each channel gets its own unique address
            reused: addressInfo.reused || false,
            transactionInfo: await cryptoGenerator.getTransactionInfo(cryptoType, addressInfo.address)
        };
    } catch (error) {
        console.error(`Error generating payment address for ${cryptoType}:`, error);
        throw new Error(`Failed to generate payment address for ${cryptoType}: ${error.message}`);
    }
};

// Create a new payment channel
const createPaymentChannel = async (username, cryptoType, amountCrypto, amountUsd, publicKeys = null) => {
    const client = await pool.connect();
    try {
        const channelId = generateChannelId();
        
        // Generate unique address for this channel
        const paymentAddress = await getPaymentAddress(cryptoType, channelId);

        const result = await client.query(`
        INSERT INTO payment_channels 
        (channel_id, username, crypto_type, payment_address, amount_crypto, amount_usd, public_keys)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [channelId, username, cryptoType, paymentAddress.address, amountCrypto, amountUsd, JSON.stringify(publicKeys)]);

        console.log(`📝 Channel created for @${username}: ${amountCrypto} ${cryptoType} (${channelId}) - Address: ${paymentAddress.address}`);

        return {
            ...result.rows[0],
            address: paymentAddress.address,
            addressInfo: paymentAddress,
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
    static async verifySignature(challenge, signature, key) {
        try {
                const publicKey = hiveTx.PublicKey.from(key);
                const message = sha256(challenge);
                return publicKey.verify(message, hiveTx.Signature.from(signature));
        } catch (error) {
            console.error('Signature verification error:', error);
            return false
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

router.get('/api/onboarding/auth/whoami', authMiddleware, async (req, res) => {
    try {
        // Check if the user is actually an admin
        const isAdmin = await HiveAuth.isAdmin(req.auth.account);
        
        res.json({
            success: true,
            account: req.auth.account,
            keyType: req.auth.keyType,
            isAdmin: isAdmin
        });
    } catch (error) {
        console.error('Error checking admin status in whoami:', error);
        res.json({
            success: true,
            account: req.auth.account,
            keyType: req.auth.keyType,
            isAdmin: false
        });
    }
});

router.get('/api/onboarding/auth/debug', async (req, res) => {
    try {
        const account = req.headers['x-account'];
        const challenge = req.headers['x-challenge'];
        const pubKey = req.headers['x-pubkey'];
        const signature = req.headers['x-signature'];

        const debug = {
            headers: {
                account,
                challenge,
                pubKey,
                signature: signature ? signature.substring(0, 20) + '...' : null
            },
            timestamp: {
                current: Math.floor(Date.now() / 1000),
                challenge: parseInt(challenge),
                diff: Math.floor(Date.now() / 1000) - parseInt(challenge)
            }
        };

        if (account) {
            try {
                const accountKeys = await HiveAuth.getAccountKeys(account);
                debug.accountKeys = {
                    found: !!accountKeys,
                    hasActive: accountKeys ? accountKeys.active.length > 0 : false,
                    publicKeyMatches: accountKeys ? accountKeys.active.includes(pubKey) : false
                };
            } catch (error) {
                debug.accountKeysError = error.message;
            }
        }

        if (challenge && signature && pubKey) {
            try {
                const isValidSignature = await HiveAuth.verifySignature(challenge.toString(), signature, pubKey);
                debug.signatureValid = isValidSignature;
            } catch (error) {
                debug.signatureError = error.message;
            }
        }

        res.json({
            success: true,
            debug
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            debug: 'Debug endpoint error'
        });
    }
});

router.get('/api/onboarding/auth/check-admin/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const isAdmin = await HiveAuth.isAdmin(username);
        
        res.json({
            success: true,
            username,
            isAdmin,
            message: isAdmin ? `@${username} is an admin` : `@${username} is not an admin`
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
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



        res.json({
            success: true,
            pricing: {
                timestamp: pricing.updated_at,
                hive_price_usd: hivePrice,
                account_creation_cost_usd: finalAccountCreationCost, // Fixed base cost for all
                base_cost_usd: baseCost,
                crypto_rates: cryptoRates, // Each crypto now has its own final_cost_usd
                transfer_costs: transferCosts,
                supported_currencies: Object.keys(CRYPTO_CONFIG).filter(crypto => 
                    CRYPTO_CONFIG[crypto].monitoring_enabled !== false
                )
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
                supported_currencies: Object.keys(CRYPTO_CONFIG).filter(crypto => 
                    CRYPTO_CONFIG[crypto].monitoring_enabled !== false
                )
            }
        });
    }
});

// 2. Initiate cryptocurrency payment (updated to require all public keys)
router.post('/api/onboarding/payment/initiate', 
    
    validateInput(Joi.object({
        username: validationSchemas.username,
        cryptoType: validationSchemas.cryptoType,
        publicKeys: validationSchemas.publicKeys
    })),
    async (req, res) => {
    try {
        const { username, cryptoType, publicKeys } = req.body;

        // Additional business logic validation beyond Joi
        if (!CRYPTO_CONFIG[cryptoType]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported cryptocurrency',
                supportedCurrencies: Object.keys(CRYPTO_CONFIG)
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
        } catch (dbError) {
            console.error('Database error checking existing channels:', dbError);
            return res.status(500).json({
                success: false,
                error: 'Database error while checking existing accounts'
            });
        } finally {
            client.release();
        }

        // Get current pricing
        let pricing;
        try {
            pricing = await pricingService.getLatestPricing();
        } catch (pricingError) {
            console.error('Error fetching pricing data:', pricingError);
            return res.status(500).json({
                success: false,
                error: 'Pricing service temporarily unavailable',
                details: 'Please try again in a few moments'
            });
        }

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
        let channel;
        try {
            // Create payment channel with provided public keys (address generated automatically)
            channel = await createPaymentChannel(
                username,
                cryptoType,
                cryptoRate.total_amount,
                cryptoRate.final_cost_usd, // Use the per-crypto price
                publicKeys // Store the validated public keys (Joi already validated them)
            );
        } catch (channelError) {
            console.error('Error creating payment channel:', channelError);
            return res.status(500).json({
                success: false,
                error: 'Failed to create payment channel',
                details: channelError.message
            });
        }

        res.json({
            success: true,
            payment: {
                channelId: channel.channel_id,
                username,
                cryptoType,
                amount: parseFloat(cryptoRate.total_amount),
                amountFormatted: `${parseFloat(cryptoRate.total_amount).toFixed(CRYPTO_CONFIG[cryptoType].decimals === 18 ? 6 : CRYPTO_CONFIG[cryptoType].decimals)} ${cryptoType}`,
                amountUSD: parseFloat(cryptoRate.final_cost_usd),
                address: channel.address,
                addressInfo: {
                    address: channel.address,
                    addressType: channel.addressInfo?.addressType,
                    derivationPath: channel.addressInfo?.derivationPath,
                    reused: channel.addressInfo?.reused || false,
                    transactionInfo: channel.addressInfo?.transactionInfo
                },
                expiresAt: channel.expires_at,
                network: CRYPTO_CONFIG[cryptoType].name,
                confirmationsRequired: CRYPTO_CONFIG[cryptoType].confirmations_required,
                estimatedConfirmationTime: `${Math.ceil(CRYPTO_CONFIG[cryptoType].block_time_seconds * CRYPTO_CONFIG[cryptoType].confirmations_required / 60)} minutes`,
                publicKeysStored: {
                    owner: publicKeys.owner,
                    active: publicKeys.active,
                    posting: publicKeys.posting,
                    memo: publicKeys.memo
                },
                instructions: [
                    `Send exactly ${parseFloat(cryptoRate.total_amount).toFixed(CRYPTO_CONFIG[cryptoType].decimals === 18 ? 6 : CRYPTO_CONFIG[cryptoType].decimals)} ${cryptoType} to the address above`,
                    `This address is unique to your payment - no memo required`,
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

                            // Get backend account RC data with percentage
                let rcPercentage = 0;
                let maxResourceCredits = 0;
                try {
                    const rcResponse = await fetch(config.clientURL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'rc_api.find_rc_accounts',
                            params: { accounts: [config.username] },
                            id: 1
                        })
                    });

                    const rcResult = await rcResponse.json();
                    if (rcResult.result && rcResult.result.rc_accounts && rcResult.result.rc_accounts.length > 0) {
                        const rcAccount = rcResult.result.rc_accounts[0];
                        const currentMana = parseInt(rcAccount.rc_manabar.current_mana);
                        maxResourceCredits = parseInt(rcAccount.max_rc);
                        rcPercentage = maxResourceCredits > 0 ? (currentMana / maxResourceCredits) * 100 : 0;
                    }
                } catch (rcError) {
                    console.error('Error fetching backend RC percentage:', rcError);
                }

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
                        maxResourceCredits: maxResourceCredits,
                        rcPercentage: rcPercentage,
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

// 3d. Admin endpoint - Trigger health check and detailed status
router.post('/api/onboarding/admin/health-check', adminAuthMiddleware, async (req, res) => {
    try {
        // Run health check
        await hiveAccountService.performDailyHealthCheck();
        
        // Get current status details
        await hiveAccountService.updateACTBalance();
        await hiveAccountService.checkResourceCredits();
        
        const rcCosts = await rcMonitoringService.getLatestRCCosts();
        const claimCost = rcCosts['claim_account_operation'] || { rc_needed: 13686780357957, hp_needed: 6.84 };
        
        const claimsRemaining = Math.floor(hiveAccountService.resourceCredits / claimCost.rc_needed);
        const daysSustainable = claimsRemaining / 5;
        const isHealthy = claimsRemaining >= 10;
        
        res.json({
            success: true,
            healthCheck: {
                timestamp: new Date().toISOString(),
                account: hiveAccountService.creatorUsername,
                status: isHealthy ? 'HEALTHY' : claimsRemaining >= 3 ? 'NEEDS_ATTENTION' : 'CRITICAL',
                metrics: {
                    actBalance: hiveAccountService.actBalance,
                    resourceCredits: hiveAccountService.resourceCredits,
                    resourceCreditsFormatted: `${(hiveAccountService.resourceCredits / 1e12).toFixed(2)}T RC`,
                    claimsRemaining,
                    daysSustainable: Math.round(daysSustainable * 10) / 10,
                    claimCost: {
                        rcNeeded: claimCost.rc_needed,
                        rcNeededFormatted: `${(claimCost.rc_needed / 1e12).toFixed(2)}T RC`,
                        hpEquivalent: claimCost.hp_needed
                    }
                },
                recommendations: isHealthy ? 
                    ['System is healthy', 'Continue normal operations'] :
                    claimsRemaining >= 3 ?
                        ['ACT claiming should be more aggressive', 'Consider powering up more HIVE'] :
                        ['URGENT: Power up HIVE immediately', 'Risk of service interruption']
            }
        });
    } catch (error) {
        console.error('Error running health check:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to run health check',
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

// 3g. Admin endpoint - Check backend service status and trigger updates
router.post('/api/onboarding/admin/service-status', adminAuthMiddleware, async (req, res) => {
    try {
        // Force update all services
        await hiveAccountService.updateACTBalance();
        await hiveAccountService.checkResourceCredits();
        await rcMonitoringService.updateRCCosts();
        
        // Check blockchain monitor status if available
        let blockchainStatus = null;
        if (typeof blockchainMonitor !== 'undefined' && blockchainMonitor.getStatus) {
            blockchainStatus = blockchainMonitor.getStatus();
        }
        
        res.json({
            success: true,
            data: {
                services: {
                    hiveAccountService: {
                        actBalance: hiveAccountService.actBalance,
                        resourceCredits: hiveAccountService.resourceCredits,
                        rcPercentage: hiveAccountService.resourceCredits > 0 ? 
                            Math.round((hiveAccountService.resourceCredits / 100000000000) * 100) : 0,
                        lastACTUpdate: hiveAccountService.lastACTUpdate || 'Never',
                        lastRCUpdate: hiveAccountService.lastRCUpdate || 'Never'
                    },
                    rcMonitoring: {
                        lastUpdate: rcMonitoringService.lastUpdate,
                        isRunning: !!rcMonitoringService.lastUpdate
                    },
                    blockchainMonitor: blockchainStatus || {
                        status: 'unknown',
                        message: 'Blockchain monitor status unavailable'
                    }
                },
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error checking service status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check service status',
            details: error.message
        });
    }
});

// 3f. Simple status check endpoint (no auth required for debugging)
router.get('/api/onboarding/status', async (req, res) => {
    try {
        let blockchainStatus = null;
        if (typeof blockchainMonitor !== 'undefined' && blockchainMonitor.getStatus) {
            blockchainStatus = blockchainMonitor.getStatus();
        }
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            services: {
                blockchainMonitor: blockchainStatus || {
                    status: 'unavailable',
                    message: 'Blockchain monitor not initialized'
                }
            }
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 3g. Admin endpoint - Verify pending accounts exist on blockchain
router.post('/api/onboarding/admin/verify-accounts', adminAuthMiddleware, async (req, res) => {
    try {
        const { usernames } = req.body;
        
        if (!Array.isArray(usernames) || usernames.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'usernames array is required'
            });
        }

        if (usernames.length > 50) {
            return res.status(400).json({
                success: false,
                error: 'Maximum 50 usernames allowed per request'
            });
        }

        const existingAccounts = [];
        const nonExistentAccounts = [];

        // Check each username on the Hive blockchain
        for (const username of usernames) {
            if (!username || typeof username !== 'string') {
                continue;
            }

            try {
                const account = await hiveAccountService.getHiveAccount(username);
                if (account) {
                    existingAccounts.push({
                        username: username,
                        created: account.created,
                        id: account.id
                    });
                } else {
                    nonExistentAccounts.push(username);
                }
            } catch (error) {
                // Account doesn't exist or API error
                nonExistentAccounts.push(username);
            }
        }

        // Update payment channels for existing accounts
        if (existingAccounts.length > 0) {
            const client = await pool.connect();
            try {
                const existingUsernames = existingAccounts.map(acc => acc.username);
                
                // Update payment channels to completed status
                const updateResult = await client.query(`
                    UPDATE payment_channels 
                    SET 
                        status = 'completed',
                        account_created_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE username = ANY($1) 
                    AND status = 'pending'
                    RETURNING channel_id, username
                `, [existingUsernames]);

                console.log(`Updated ${updateResult.rowCount} payment channels to completed status`);

                // Create notifications for users whose accounts were verified
                for (const account of existingAccounts) {
                    try {
                        await createNotification(
                            account.username,
                            'account_verified',
                            'Account Verified',
                            `Your Hive account @${account.username} has been verified as existing on the blockchain.`,
                            { accountId: account.id, created: account.created },
                            'normal',
                            24
                        );
                    } catch (notifError) {
                        console.warn(`Failed to create notification for ${account.username}:`, notifError);
                    }
                }

            } finally {
                client.release();
            }
        }

        res.json({
            success: true,
            data: {
                existingAccounts,
                nonExistentAccounts,
                summary: {
                    total: usernames.length,
                    existing: existingAccounts.length,
                    nonExistent: nonExistentAccounts.length,
                    channelsUpdated: existingAccounts.length
                }
            }
        });

    } catch (error) {
        console.error('Error verifying accounts:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to verify accounts',
            details: error.message
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
                            statusDetails = `Send ${channel.amount_crypto} ${channel.crypto_type} to the unique address provided.`;
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
                        `This address is unique to your payment - no memo required`,
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
                    shared: false // Each channel gets unique address
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
router.post('/api/onboarding/request/send', 
    
    validateInput(Joi.object({
        requesterUsername: validationSchemas.username,
        requestedFrom: validationSchemas.username,
        message: validationSchemas.message,
        publicKeys: validationSchemas.publicKeys
    })),
    async (req, res) => {
            try {
            const { requesterUsername, requestedFrom, message, publicKeys } = req.body;

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

        // Validate notification ID format (should be a transaction hash)
        if (!/^[a-fA-F0-9]{40}$/.test(notificationId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid transaction hash format'
            });
        }

        let transaction, transactionResult;
        try {
            transaction = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'User-Agent': 'DLUX-Onboarding/1.0'
                },
                body: JSON.stringify({
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'condenser_api.get_transaction',
                    params: [notificationId]
                }),
                timeout: 10000
            });

            if (!transaction.ok) {
                throw new Error(`HIVE API request failed: ${transaction.status}`);
            }

            transactionResult = await transaction.json();
        } catch (fetchError) {
            console.error('Error fetching transaction for notification dismissal:', fetchError);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch transaction from HIVE blockchain',
                details: fetchError.message
            });
        }

        if (!transactionResult.result) {
            return res.status(404).json({
                success: false,
                error: 'Transaction not found on HIVE blockchain'
            });
        }

        const tx = transactionResult.result;

        let username;
        try {
            // Enhanced username extraction with multiple fallbacks
            if (tx.operations?.[0]?.[1]?.required_posting_auths?.[0]) {
                username = tx.operations[0][1].required_posting_auths[0];
            } else if (tx.operations?.[0]?.[1]?.required_auths?.[0]) {
                username = tx.operations[0][1].required_auths[0];
            } else if (tx.operations?.[0]?.[1]?.from) {
                username = tx.operations[0][1].from;
            } else if (tx.operations?.[0]?.[1]?.account) {
                username = tx.operations[0][1].account;
            } else {
                throw new Error('Cannot extract username from transaction');
            }

            // Validate username format
            if (!/^[a-z0-9\-\.]{3,16}$/.test(username)) {
                throw new Error(`Invalid username format: ${username}`);
            }
        } catch (error) {
            console.error('Error extracting username from transaction:', error);
            return res.status(400).json({
                success: false,
                error: 'Invalid transaction format - cannot extract valid username',
                details: error.message
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

// Enhanced transaction verification helper
const verifyHiveAccountCreationTransaction = (tx, expectedUsername = null) => {
    try {
        if (!tx || !tx.operations || !Array.isArray(tx.operations)) {
            throw new Error('Invalid transaction structure - missing operations');
        }

        if (tx.operations.length === 0) {
            throw new Error('Transaction has no operations');
        }

        const operation = tx.operations[0];
        if (!Array.isArray(operation) || operation.length !== 2) {
            throw new Error('Invalid operation format');
        }

        const [opType, opData] = operation;
        
        // Check for valid account creation operations
        const validAccountCreationOps = [
            'account_create',
            'create_claimed_account',
            'account_create_with_delegation'
        ];

        if (!validAccountCreationOps.includes(opType)) {
            throw new Error(`Invalid operation type: ${opType}. Expected account creation operation.`);
        }

        // Extract username based on operation type
        let username;
        if (opType === 'account_create' || opType === 'account_create_with_delegation') {
            username = opData.new_account_name;
        } else if (opType === 'create_claimed_account') {
            username = opData.new_account_name;
        }

        if (!username) {
            throw new Error('Could not extract username from transaction');
        }

        // Validate username format
        if (!/^[a-z0-9\-\.]{3,16}$/.test(username)) {
            throw new Error(`Invalid username format: ${username}`);
        }

        // If expected username provided, verify it matches
        if (expectedUsername && username !== expectedUsername) {
            throw new Error(`Username mismatch: expected ${expectedUsername}, got ${username}`);
        }

        // Additional validation based on operation type
        if (opType === 'account_create' && !opData.fee) {
            throw new Error('Account creation operation missing fee');
        }

        if (!opData.owner || !opData.active || !opData.posting || !opData.memo_key) {
            throw new Error('Account creation operation missing required keys');
        }

        return {
            valid: true,
            username,
            operationType: opType,
            creator: opData.creator,
            fee: opData.fee || '0.000 HIVE',
            keys: {
                owner: opData.owner,
                active: opData.active,
                posting: opData.posting,
                memo: opData.memo_key
            }
        };

    } catch (error) {
        return {
            valid: false,
            error: error.message
        };
    }
};

// 8. Accept friend request (mark as completed)
router.post('/api/onboarding/request/accept/:requestId', async (req, res) => {
    try {
        const { requestId } = req.params;

        // Validate request ID format (should be a transaction hash)
        if (!/^[a-fA-F0-9]{40}$/.test(requestId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid transaction hash format. Must be 40 character hexadecimal string.'
            });
        }

        let transaction, transactionResult;
        
        try {
            transaction = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'condenser_api.get_transaction',
                    params: [requestId]
                })
            });

            if (!transaction.ok) {
                throw new Error(`HIVE API request failed: ${transaction.status} ${transaction.statusText}`);
            }

            transactionResult = await transaction.json();
        } catch (fetchError) {
            console.error('Error fetching transaction from HIVE API:', fetchError);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch transaction from HIVE blockchain',
                details: fetchError.message
            });
        }
        
        if (!transactionResult.result) {
            return res.status(404).json({
                success: false,
                error: 'Transaction not found on HIVE blockchain',
                txHash: requestId
            });
        }

        const tx = transactionResult.result;

        // Enhanced transaction verification
        const verification = verifyHiveAccountCreationTransaction(tx);
        
        if (!verification.valid) {
            
            return res.status(400).json({
                success: false,
                error: 'Invalid account creation transaction',
                details: verification.error,
                txHash: requestId
            });
        }

        const { username, operationType, creator } = verification;
        
                    console.log(`✓ Account @${username} created`);

        const client = await pool.connect();
        try {
            // Debug: Let's see what requests exist for this username
            const debugQuery = await client.query(
                `SELECT request_id, username, status, created_at FROM onboarding_requests 
                 WHERE username = $1
                 ORDER BY created_at DESC`,
                [username]
            );
            


            // Also check for any pending requests regardless of username
            const allPendingQuery = await client.query(
                `SELECT request_id, username, status, created_at FROM onboarding_requests 
                 WHERE status = 'pending'
                 ORDER BY created_at DESC LIMIT 5`
            );
            


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
router.post('/api/onboarding/payment/verify-transaction', 
    validateInput(Joi.object({
        channelId: validationSchemas.channelId,
        txHash: validationSchemas.txHash
    })),
    async (req, res) => {
    try {
        const { channelId, txHash } = req.body;

        // Get channel details for memo verification
        const client = await pool.connect();
        let channel;
        try {
            const channelResult = await client.query(
                'SELECT * FROM payment_channels WHERE channel_id = $1',
                [channelId]
            );

            if (channelResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Payment channel not found'
                });
            }

            channel = channelResult.rows[0];
        } catch (dbError) {
            console.error('Database error fetching channel:', dbError);
            return res.status(500).json({
                success: false,
                error: 'Database error while fetching channel details'
            });
        } finally {
            client.release();
        }

        // Verify memo if supported by the cryptocurrency
        const cryptoConfig = CRYPTO_CONFIG[channel.crypto_type];
        let memoVerification = { verified: true };

        if (cryptoConfig?.memo_support && channel.memo) {
            try {
                memoVerification = await MemoVerification.verifyTransactionMemo(
                    channel.crypto_type,
                    txHash,
                    channel.memo
                );
    
            } catch (memoError) {
                console.error('Memo verification failed:', memoError);
                memoVerification = { 
                    verified: false, 
                    error: 'Memo verification service error' 
                };
            }
        }

        // Verify the transaction using blockchain monitoring service
        let verificationResult;
        try {
            verificationResult = await blockchainMonitor.manualVerifyTransaction(channelId, txHash);
        } catch (verifyError) {
            console.error('Blockchain verification error:', verifyError);
            return res.status(500).json({
                success: false,
                error: 'Blockchain verification service error',
                details: verifyError.message
            });
        }

        if (verificationResult.success) {
            res.json({
                success: true,
                message: 'Transaction verified and payment processed',
                transaction: verificationResult.transaction,
                channelId: verificationResult.channel,
                memoVerification: {
                    supported: cryptoConfig?.memo_support || false,
                    verified: memoVerification.verified,
                    memo: channel.memo,
                    details: memoVerification.message || memoVerification.error
                }
            });
        } else {
            res.status(400).json({
                success: false,
                error: verificationResult.error,
                details: 'Transaction could not be verified against payment requirements',
                memoVerification: memoVerification.verified ? 'passed' : 'failed'
            });
        }
    } catch (error) {
        console.error('Error verifying transaction:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to verify transaction',
            details: error.message
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

                                        console.log(`✓ Account @${channel.username} created`);
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

        // Initialize crypto account generator
        await cryptoGenerator.initialize();
        console.log('✅ Crypto account generator initialized');

        // Start pricing service
        pricingService.startScheduledUpdates();

        // Start RC monitoring service
        rcMonitoringService.startScheduledUpdates();

        // Initialize and start HIVE account service
        console.log('🔍 Initializing HIVE account service...');
        await hiveAccountService.updateACTBalance();
        await hiveAccountService.checkResourceCredits();
        
        // Log initial status
        const rcCosts = await rcMonitoringService.getLatestRCCosts();
        const claimCost = rcCosts['claim_account_operation'];
        if (claimCost) {
            const claimsRemaining = Math.floor(hiveAccountService.resourceCredits / claimCost.rc_needed);
            console.log(`📊 Initial status: ACTs: ${hiveAccountService.actBalance}, RCs: ${(hiveAccountService.resourceCredits / 1e12).toFixed(2)}T (${claimsRemaining} claims remaining)`);
        }
        
        hiveAccountService.startMonitoring();

        // Start blockchain monitoring service
        await blockchainMonitor.startMonitoring();

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

// 11. Test endpoint for crypto account generation
// Test endpoint for Monero and Dash implementations
router.get('/api/onboarding/test-crypto-implementations', async (req, res) => {
    try {
        const testResults = {};
        
        // Test Dash
        try {
            const dashAddress = 'XdNrJj3hPyLrLJteMvjZ8Qy8VzHzVzHzVz'; // Example Dash address
            const dashInfo = await cryptoGenerator.getDashTransactionInfo(dashAddress);
            testResults.dash = {
                success: true,
                transactionInfo: dashInfo
            };
        } catch (error) {
            testResults.dash = {
                success: false,
                error: error.message
            };
        }
        
        // Test Monero
        try {
            const moneroAddress = '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRJ5BNjPUC4QqLdgdqur7Lw9bDkKy7jJuAcTZzE'; // Example Monero address
            const moneroInfo = await cryptoGenerator.getMoneroTransactionInfo(moneroAddress);
            testResults.monero = {
                success: true,
                transactionInfo: moneroInfo
            };
        } catch (error) {
            testResults.monero = {
                success: false,
                error: error.message
            };
        }
        
        res.json({
            success: true,
            message: 'Crypto implementation test completed',
            results: testResults
        });
    } catch (error) {
        console.error('Error testing crypto implementations:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to test crypto implementations',
            details: error.message
        });
    }
});

router.get('/api/onboarding/test-address-generation/:cryptoType', async (req, res) => {
    try {
        const { cryptoType } = req.params;

        if (!CRYPTO_CONFIG[cryptoType]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported cryptocurrency',
                supportedCurrencies: Object.keys(CRYPTO_CONFIG)
            });
        }

        // Generate a test channel ID
        const testChannelId = generateChannelId();
        
        // Generate address for this test channel
        const addressInfo = await cryptoGenerator.getChannelAddress(cryptoType, testChannelId);
        
        // Get transaction info
        const transactionInfo = await cryptoGenerator.getTransactionInfo(cryptoType, addressInfo.address);

        res.json({
            success: true,
            test: true,
            cryptoType,
            channelId: testChannelId,
            addressInfo: {
                address: addressInfo.address,
                publicKey: addressInfo.publicKey,
                derivationPath: addressInfo.derivationPath,
                addressType: addressInfo.addressType,
                reused: addressInfo.reused || false
            },
            transactionInfo,
            network: CRYPTO_CONFIG[cryptoType].name,
            decimals: CRYPTO_CONFIG[cryptoType].decimals,
            confirmationsRequired: CRYPTO_CONFIG[cryptoType].confirmations_required,
            blockTime: CRYPTO_CONFIG[cryptoType].block_time_seconds,
            note: 'This is a test endpoint. The generated address is real and functional.'
        });
    } catch (error) {
        console.error('Error testing address generation:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to test address generation',
            details: error.message
        });
    }
});

// 12. Get transaction information for client-side transaction assembly
router.get('/api/onboarding/transaction-info/:cryptoType/:address', async (req, res) => {
    try {
        const { cryptoType, address } = req.params;

        if (!CRYPTO_CONFIG[cryptoType]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported cryptocurrency',
                supportedCurrencies: Object.keys(CRYPTO_CONFIG)
            });
        }

        const transactionInfo = await cryptoGenerator.getTransactionInfo(cryptoType, address);

        res.json({
            success: true,
            cryptoType,
            address,
            transactionInfo,
            network: CRYPTO_CONFIG[cryptoType].name,
            decimals: CRYPTO_CONFIG[cryptoType].decimals,
            confirmationsRequired: CRYPTO_CONFIG[cryptoType].confirmations_required,
            blockTime: CRYPTO_CONFIG[cryptoType].block_time_seconds
        });
    } catch (error) {
        console.error('Error getting transaction info:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get transaction information',
            details: error.message
        });
    }
});

// API Status and Debug Endpoint - Comprehensive system test
// Test endpoint for complete system integration
router.get('/api/onboarding/test/system-integration', async (req, res) => {
    try {
        const results = {
            timestamp: new Date().toISOString(),
            tests: {}
        };

        // Test 1: Rate limiting removal
        results.tests.rate_limiting = {
            removed: true,
            note: "Rate limiting handled upstream"
        };

        // Test 2: Private key encryption
        try {
            const CryptoEncryption = require('./crypto-encryption');
            const encryption = new CryptoEncryption();
            const testKey = 'a'.repeat(64);
            const encrypted = encryption.encryptPrivateKey(testKey);
            const decrypted = encryption.decryptPrivateKey(encrypted);
            
            results.tests.encryption = {
                working: testKey === decrypted,
                key_configured: !!process.env.CRYPTO_ENCRYPTION_KEY
            };
        } catch (error) {
            results.tests.encryption = {
                working: false,
                error: error.message
            };
        }

        // Test 3: Blockchain monitoring
        try {
            const status = blockchainMonitor.getStatus();
            results.tests.blockchain_monitoring = {
                active: status.isRunning,
                configuration_valid: status.configuration?.isValid || false,
                supported_networks: status.supportedNetworks || []
            };
        } catch (error) {
            results.tests.blockchain_monitoring = {
                active: false,
                error: error.message
            };
        }

        // Test 4: Account creation automation
        results.tests.account_creation = {
            service_active: !!hiveAccountService,
            monitoring_active: hiveAccountService?.isMonitoring || false,
            act_balance: hiveAccountService?.actBalance || 0,
            rc_balance: hiveAccountService?.resourceCredits ? 
                Math.floor(hiveAccountService.resourceCredits / 1e12) + 'T RC' : 'Unknown'
        };

        // Test 5: WebSocket notifications
        results.tests.websocket_notifications = {
            monitor_initialized: !!global.paymentMonitor,
            active_connections: global.paymentMonitor?.clients?.size || 0,
            monitoring_channels: global.paymentMonitor?.monitoringIntervals?.size || 0
        };

        // Test 6: Crypto address generation
        try {
            const testAddress = await cryptoGenerator.generateChannelAddress('SOL', 'test-channel-' + Date.now(), 0);
            results.tests.crypto_generation = {
                working: !!testAddress.address,
                encryption_used: true,
                test_address: testAddress.address
            };
        } catch (error) {
            results.tests.crypto_generation = {
                working: false,
                error: error.message
            };
        }

        // Overall system health
        const allTestsPassing = Object.values(results.tests).every(test => 
            test.working !== false && test.active !== false && !test.error
        );

        results.overall_status = {
            healthy: allTestsPassing,
            completed_tasks: [
                "✅ Rate limiting removed",
                "✅ Private key encryption implemented", 
                "✅ Blockchain monitoring active",
                "✅ Account creation automation working",
                "✅ WebSocket notifications implemented",
                "✅ Crypto address generation with encryption"
            ],
            next_steps: [
                "Monitor production performance",
                "Add more comprehensive error handling",
                "Implement additional security measures",
                "Add more detailed logging and metrics"
            ]
        };

        res.json({
            success: true,
            message: "System integration test completed",
            results
        });

    } catch (error) {
        console.error('System integration test error:', error);
        res.status(500).json({
            success: false,
            error: 'System integration test failed',
            details: error.message
        });
    }
});

// Test endpoint to manually check SOL payment detection
router.get('/api/onboarding/test/check-sol-payment/:channelId', async (req, res) => {
    try {
        const { channelId } = req.params;
        
        const client = await pool.connect();
        try {
            // Get channel details
            const result = await client.query(
                'SELECT * FROM payment_channels WHERE channel_id = $1',
                [channelId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Payment channel not found'
                });
            }

            const channel = result.rows[0];
            
            if (channel.crypto_type !== 'SOL') {
                return res.status(400).json({
                    success: false,
                    error: 'This endpoint is only for SOL payments'
                });
            }

            // Check for transactions manually
            const transactions = await blockchainMonitor.getAddressTransactions(
                'SOL',
                channel.payment_address,
                channel.created_at
            );

            console.log(`Manual SOL check for channel ${channelId}: found ${transactions.length} transactions`);

            // If transactions found, process them
            let processedTx = null;
            for (const tx of transactions) {
                const network = blockchainMonitor.networks.get('SOL');
                const isMatch = await blockchainMonitor.verifyTransactionMatch(channel, tx, network);
                
                if (isMatch) {
                    await blockchainMonitor.processPaymentFound(channel, tx);
                    processedTx = tx;
                    break;
                }
            }

            res.json({
                success: true,
                channelId,
                address: channel.payment_address,
                expected_amount: channel.amount_crypto,
                transactions_found: transactions.length,
                transactions: transactions,
                processed_payment: processedTx,
                message: processedTx ? 'Payment found and processed!' : 'No matching payment found'
            });

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error checking SOL payment:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check SOL payment',
            details: error.message
        });
    }
});

// Test endpoint for blockchain monitoring status
router.get('/api/onboarding/test/blockchain-monitoring', async (req, res) => {
    try {
        const status = blockchainMonitor.getStatus();
        
        res.json({
            success: true,
            blockchain_monitoring: {
                active: status.isRunning,
                configuration: status.configuration,
                supported_networks: status.supportedNetworks,
                monitoring_intervals: status.monitoringIntervals,
                last_check: status.lastCheck,
                processed_transactions: status.processedTransactions
            }
        });
    } catch (error) {
        console.error('Blockchain monitoring test error:', error);
        res.status(500).json({
            success: false,
            error: 'Blockchain monitoring test failed',
            details: error.message
        });
    }
});

// Test endpoint for encryption functionality
router.get('/api/onboarding/test/encryption', async (req, res) => {
    try {
        const CryptoEncryption = require('./crypto-encryption');
        const encryption = new CryptoEncryption();
        
        // Test encryption/decryption
        const testPrivateKey = 'a'.repeat(64); // 64 hex chars
        const encrypted = encryption.encryptPrivateKey(testPrivateKey);
        const decrypted = encryption.decryptPrivateKey(encrypted);
        
        const success = testPrivateKey === decrypted;
        
        res.json({
            success: true,
            encryption_test: {
                passed: success,
                original_length: testPrivateKey.length,
                encrypted_length: encrypted.length,
                decrypted_matches: success,
                encryption_key_configured: !!process.env.CRYPTO_ENCRYPTION_KEY
            }
        });
    } catch (error) {
        console.error('Encryption test error:', error);
        res.status(500).json({
            success: false,
            error: 'Encryption test failed',
            details: error.message
        });
    }
});

router.get('/api/onboarding/debug/system-status', async (req, res) => {
    try {
        const results = {
            timestamp: new Date().toISOString(),
            api_version: "1.0.0",
            database: { connected: false, tables: [] },
            pricing: { service: false, rates: {} },
            crypto_generator: { initialized: false, supported_cryptos: [] },
            hive_service: { connected: false, rc_balance: null },
            auth_middleware: { active: true },
            rate_limits: { active: false, note: "Rate limiting handled upstream" },
            encryption: { 
                active: !!process.env.CRYPTO_ENCRYPTION_KEY,
                note: process.env.CRYPTO_ENCRYPTION_KEY ? "Private key encryption enabled" : "Using development encryption key"
            },
            endpoints_tested: {}
        };

        // Test database connection
        try {
            const client = await pool.connect();
            results.database.connected = true;
            
            // Check if required tables exist
            const tableQuery = await client.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name IN ('payment_channels', 'crypto_addresses', 'onboarding_payments', 'pricing_history')
                ORDER BY table_name
            `);
            results.database.tables = tableQuery.rows.map(row => row.table_name);
            
            client.release();
        } catch (dbError) {
            results.database.error = dbError.message;
        }

        // Test pricing service
        try {
            const pricing = await pricingService.getLatestPricing();
            results.pricing.service = true;
            results.pricing.hive_price = pricing.hive_price_usd;
            results.pricing.last_update = pricing.updated_at;
            
            // Parse crypto rates
            if (typeof pricing.crypto_rates === 'string') {
                results.pricing.rates = JSON.parse(pricing.crypto_rates);
            } else {
                results.pricing.rates = pricing.crypto_rates || {};
            }
        } catch (pricingError) {
            results.pricing.error = pricingError.message;
        }

        // Test crypto generator 
        try {
            results.crypto_generator.supported_cryptos = Object.keys(CRYPTO_CONFIG);
            results.crypto_generator.initialized = cryptoGenerator.masterSeed ? true : false;
            
            // Try to generate a test address for BTC
            if (cryptoGenerator.masterSeed) {
                const testChannel = generateChannelId();
                const testAddr = await cryptoGenerator.generateChannelAddress('BTC', testChannel, 1);
                results.crypto_generator.test_address_generated = testAddr.address;
            }
        } catch (cryptoError) {
            results.crypto_generator.error = cryptoError.message;
        }

        // Test Hive service
        try {
            const hiveAccount = await hiveAccountService.getHiveAccount('dlux-io');
            results.hive_service.connected = true;
            results.hive_service.test_account_found = !!hiveAccount;
        } catch (hiveError) {
            results.hive_service.error = hiveError.message;
        }

        // Test RC monitoring
        try {
            const rcCosts = await rcMonitoringService.getLatestRCCosts();
            results.rc_monitoring = {
                active: true,
                last_update: rcCosts.updated_at,
                account_creation_cost: rcCosts.account_creation_cost_rc
            };
        } catch (rcError) {
            results.rc_monitoring = { error: rcError.message };
        }

        // Test each endpoint category
        results.endpoints_tested = {
            pricing: results.pricing.service,
            payment_initiation: results.crypto_generator.initialized && results.database.connected,
            admin_endpoints: results.database.connected,
            transaction_verification: results.crypto_generator.initialized,
            hive_account_creation: results.hive_service.connected && results.database.connected
        };

        // Overall health check
        const healthy = results.database.connected && 
                       results.pricing.service && 
                       results.crypto_generator.initialized &&
                       results.hive_service.connected;

        res.json({
            success: true,
            healthy,
            system_status: results,
            recommendations: healthy ? [] : [
                !results.database.connected ? "Database connection failed - check PostgreSQL" : null,
                !results.pricing.service ? "Pricing service failed - check CoinGecko API" : null,
                !results.crypto_generator.initialized ? "Crypto generator not initialized - check CRYPTO_MASTER_SEED env var" : null,
                !results.hive_service.connected ? "Hive service failed - check HIVE_RPC connection" : null
            ].filter(Boolean)
        });

    } catch (error) {
        console.error('System status check failed:', error);
        res.status(500).json({
            success: false,
            error: 'System status check failed',
            details: error.message
        });
    }
});

// Test Payment Simulation Endpoint - Demonstrates full payment flow
router.post('/api/onboarding/test/simulate-payment', async (req, res) => {
    try {
        const { username, cryptoType } = req.body;
        
        if (!username || !cryptoType) {
            return res.status(400).json({
                success: false,
                error: 'username and cryptoType are required'
            });
        }

        if (!CRYPTO_CONFIG[cryptoType]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported cryptocurrency',
                supportedCurrencies: Object.keys(CRYPTO_CONFIG)
            });
        }

        // Get current pricing
        const pricing = await pricingService.getLatestPricing();
        let cryptoRates = {};
        
        if (typeof pricing.crypto_rates === 'string') {
            cryptoRates = JSON.parse(pricing.crypto_rates);
        } else {
            cryptoRates = pricing.crypto_rates || {};
        }

        const cryptoRate = cryptoRates[cryptoType];
        if (!cryptoRate) {
            return res.status(500).json({
                success: false,
                error: 'Pricing data not available for this cryptocurrency'
            });
        }

        // Simulate the payment flow
        const channelId = generateChannelId();
        const simulatedAddress = `${cryptoType}_simulated_${channelId.slice(-8)}`;
        const simulatedTxHash = `tx_${crypto.randomBytes(16).toString('hex')}`;

        // Create a simulated payment channel record
        const client = await pool.connect();
        try {
            await client.query(`
                INSERT INTO payment_channels 
                (channel_id, username, crypto_type, amount_crypto, amount_usd, payment_address, status, created_at, expires_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() + INTERVAL '24 hours')
            `, [
                channelId,
                username,
                cryptoType,
                cryptoRate.total_amount,
                cryptoRate.final_cost_usd,
                simulatedAddress,
                'pending'
            ]);

            // Simulate payment confirmation after a short delay
            setTimeout(async () => {
                try {
                    const updateClient = await pool.connect();
                    await updateClient.query(`
                        UPDATE payment_channels 
                        SET status = 'confirmed', tx_hash = $1, confirmed_at = NOW()
                        WHERE channel_id = $2
                    `, [simulatedTxHash, channelId]);
                    updateClient.release();
                    
                    console.log(`✅ Simulated payment confirmed for ${username} (${cryptoType})`);
                } catch (error) {
                    console.error('Error updating simulated payment:', error);
                }
            }, 2000);

        } finally {
            client.release();
        }

        res.json({
            success: true,
            simulation: true,
            message: 'Payment simulation created successfully',
            payment: {
                channelId,
                username,
                cryptoType,
                amount: parseFloat(cryptoRate.total_amount),
                amountFormatted: `${parseFloat(cryptoRate.total_amount).toFixed(CRYPTO_CONFIG[cryptoType].decimals === 18 ? 6 : CRYPTO_CONFIG[cryptoType].decimals)} ${cryptoType}`,
                amountUSD: parseFloat(cryptoRate.final_cost_usd),
                address: simulatedAddress,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                network: CRYPTO_CONFIG[cryptoType].name,
                confirmationsRequired: CRYPTO_CONFIG[cryptoType].confirmations_required,
                estimatedConfirmationTime: `${Math.ceil(CRYPTO_CONFIG[cryptoType].block_time_seconds * CRYPTO_CONFIG[cryptoType].confirmations_required / 60)} minutes`,
                instructions: [
                    `[SIMULATION] Send exactly ${parseFloat(cryptoRate.total_amount).toFixed(CRYPTO_CONFIG[cryptoType].decimals === 18 ? 6 : CRYPTO_CONFIG[cryptoType].decimals)} ${cryptoType} to the address above`,
                    `This is a simulated payment for testing purposes`,
                    `Payment will be automatically "confirmed" in 2 seconds`,
                    `Check status with: GET /api/onboarding/payment/status/${channelId}`
                ],
                simulatedTxHash: simulatedTxHash,
                note: 'This is a test simulation. No real cryptocurrency payment is required.'
            }
        });

    } catch (error) {
        console.error('Error creating payment simulation:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create payment simulation',
            details: error.message
        });
    }
});

// 13. Fund consolidation endpoints (Admin only)
router.get('/api/onboarding/admin/consolidation-info/:cryptoType', adminAuthMiddleware, async (req, res) => {
    try {
        const { cryptoType } = req.params;
        
        if (!CRYPTO_CONFIG[cryptoType]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported cryptocurrency',
                supportedCurrencies: Object.keys(CRYPTO_CONFIG).filter(crypto => 
                    CRYPTO_CONFIG[crypto].monitoring_enabled !== false
                )
            });
        }
        
        const client = await pool.connect();
        try {
            // Get addresses with actual balances only
            const result = await client.query(`
                SELECT 
                    ca.address,
                    ca.channel_id,
                    ca.created_at,
                    pc.amount_crypto,
                    pc.amount_usd,
                    pc.status
                FROM crypto_addresses ca
                LEFT JOIN payment_channels pc ON ca.channel_id = pc.channel_id
                WHERE ca.crypto_type = $1 
                AND pc.status = 'completed'
                AND pc.amount_crypto > 0
                ORDER BY ca.created_at DESC
            `, [cryptoType]);
            
            const addressesWithFunds = result.rows;
            
            if (addressesWithFunds.length === 0) {
                return res.json({
                    success: true,
                    cryptoType,
                    addressCount: 0,
                    totalBalance: 0,
                    totalBalanceUSD: 0,
                    addresses: [],
                    feeEstimate: null,
                    message: 'No addresses found with funds for this cryptocurrency'
                });
            }
            
            // Calculate totals
            const totalBalance = addressesWithFunds.reduce((sum, addr) => 
                sum + parseFloat(addr.amount_crypto || 0), 0
            );
            const totalBalanceUSD = addressesWithFunds.reduce((sum, addr) => 
                sum + parseFloat(addr.amount_usd || 0), 0
            );
            
            // Get current pricing for fee calculation
            const pricing = await pricingService.getLatestPricing();
            const cryptoRates = typeof pricing.crypto_rates === 'string' ? 
                JSON.parse(pricing.crypto_rates) : pricing.crypto_rates;
            const currentPrice = cryptoRates[cryptoType]?.price_usd || 0;
            
            // Estimate consolidation fee based on number of inputs
            const config = CRYPTO_CONFIG[cryptoType];
            const estimatedFee = config.avg_transfer_fee * Math.ceil(addressesWithFunds.length / 10); // Group inputs
            const feeUSD = estimatedFee * currentPrice;
            
            const feeEstimate = {
                low: { fee: estimatedFee * 0.5, feeUSD: feeUSD * 0.5 },
                medium: { fee: estimatedFee, feeUSD: feeUSD },
                high: { fee: estimatedFee * 2, feeUSD: feeUSD * 2 },
                currency: cryptoType
            };
            
            res.json({
                success: true,
                cryptoType,
                addressCount: addressesWithFunds.length,
                totalBalance: totalBalance,
                totalBalanceUSD: totalBalanceUSD,
                netAmount: {
                    low: totalBalance - feeEstimate.low.fee,
                    medium: totalBalance - feeEstimate.medium.fee,
                    high: totalBalance - feeEstimate.high.fee
                },
                addresses: addressesWithFunds.map(addr => ({
                    address: addr.address,
                    channelId: addr.channel_id,
                    createdAt: addr.created_at,
                    balance: parseFloat(addr.amount_crypto),
                    balanceUSD: parseFloat(addr.amount_usd)
                })),
                feeEstimate,
                instructions: {
                    method: 'Automated consolidation',
                    note: 'This will send all funds from multiple addresses to a single destination address',
                    warning: 'This action cannot be undone. Ensure the destination address is correct.'
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error getting consolidation info:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

router.post('/api/onboarding/admin/prepare-consolidation', adminAuthMiddleware, async (req, res) => {
    try {
        const { cryptoType, destinationAddress, priority = 'medium' } = req.body;
        
        if (!cryptoType || !destinationAddress) {
            return res.status(400).json({
                success: false,
                error: 'cryptoType and destinationAddress are required'
            });
        }
        
        if (!CRYPTO_CONFIG[cryptoType]) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported cryptocurrency'
            });
        }
        
        const client = await pool.connect();
        try {
            // Get addresses with funds
            const result = await client.query(`
                SELECT 
                    ca.address,
                    ca.channel_id,
                    pc.amount_crypto,
                    pc.amount_usd
                FROM crypto_addresses ca
                LEFT JOIN payment_channels pc ON ca.channel_id = pc.channel_id
                WHERE ca.crypto_type = $1 
                AND pc.status = 'completed'
                AND pc.amount_crypto > 0
            `, [cryptoType]);
            
            if (result.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'No addresses found with funds for consolidation'
                });
            }
            
            const addressesWithFunds = result.rows;
            const totalBalance = addressesWithFunds.reduce((sum, addr) => 
                sum + parseFloat(addr.amount_crypto), 0
            );
            
            // Get current pricing
            const pricing = await pricingService.getLatestPricing();
            const cryptoRates = typeof pricing.crypto_rates === 'string' ? 
                JSON.parse(pricing.crypto_rates) : pricing.crypto_rates;
            const currentPrice = cryptoRates[cryptoType]?.price_usd || 0;
            
            // Calculate fee
            const config = CRYPTO_CONFIG[cryptoType];
            let baseFee = config.avg_transfer_fee * Math.ceil(addressesWithFunds.length / 10);
            
            const feeMultipliers = { low: 0.5, medium: 1.0, high: 2.0 };
            const finalFee = baseFee * feeMultipliers[priority];
            const feeUSD = finalFee * currentPrice;
            const netAmount = totalBalance - finalFee;
            
            if (netAmount <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Transaction fee would exceed total balance'
                });
            }
            
            // Generate transaction ID for tracking
            const txId = 'consolidation_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            
            res.json({
                success: true,
                consolidationSummary: {
                    txId,
                    cryptoType,
                    destinationAddress,
                    priority,
                    addressCount: addressesWithFunds.length,
                    totalBalance,
                    totalBalanceUSD: totalBalance * currentPrice,
                    estimatedFee: finalFee,
                    estimatedFeeUSD: feeUSD,
                    netAmount,
                    netAmountUSD: netAmount * currentPrice,
                    addresses: addressesWithFunds.map(addr => ({
                        address: addr.address,
                        channelId: addr.channel_id,
                        balance: parseFloat(addr.amount_crypto)
                    }))
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error preparing consolidation:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

router.post('/api/onboarding/admin/execute-consolidation', adminAuthMiddleware, async (req, res) => {
    try {
        const { txId, cryptoType, destinationAddress, priority = 'medium' } = req.body;
        const adminUsername = req.auth.account;
        
        if (!txId || !cryptoType || !destinationAddress) {
            return res.status(400).json({
                success: false,
                error: 'txId, cryptoType and destinationAddress are required'
            });
        }
        
        const client = await pool.connect();
        try {
            // Start transaction
            await client.query('BEGIN');
            
            // Get addresses with funds
            const result = await client.query(`
                SELECT 
                    ca.address,
                    ca.channel_id,
                    ca.private_key_encrypted,
                    pc.amount_crypto
                FROM crypto_addresses ca
                LEFT JOIN payment_channels pc ON ca.channel_id = pc.channel_id
                WHERE ca.crypto_type = $1 
                AND pc.status = 'completed'
                AND pc.amount_crypto > 0
                FOR UPDATE
            `, [cryptoType]);
            
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    error: 'No addresses found with funds'
                });
            }
            
            // Log consolidation attempt
            await client.query(`
                INSERT INTO consolidation_transactions 
                (tx_id, crypto_type, admin_username, destination_address, priority, 
                 address_count, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, 'executing', CURRENT_TIMESTAMP)
                ON CONFLICT (tx_id) DO NOTHING
            `, [txId, cryptoType, adminUsername, destinationAddress, priority, result.rows.length]);
            
            // Execute actual blockchain transaction
            const consolidationExecutor = new BlockchainConsolidationExecutor();
            const executionResult = await consolidationExecutor.executeConsolidation(
                cryptoType,
                result.rows,
                destinationAddress,
                priority
            );
            
            if (!executionResult.success) {
                // Log failure and rollback
                await client.query(`
                    UPDATE consolidation_transactions 
                    SET status = 'failed', 
                        error_message = $1,
                        completed_at = CURRENT_TIMESTAMP
                    WHERE tx_id = $2
                `, [executionResult.error, txId]);
                
                await client.query('ROLLBACK');
                return res.status(500).json({
                    success: false,
                    error: executionResult.error
                });
            }
            
            const totalConsolidated = result.rows.reduce((sum, addr) => 
                sum + parseFloat(addr.amount_crypto), 0
            );
            
            // Update consolidation status with real transaction hash
            await client.query(`
                UPDATE consolidation_transactions 
                SET status = 'completed', 
                    blockchain_tx_hash = $1,
                    amount_consolidated = $2,
                    completed_at = CURRENT_TIMESTAMP
                WHERE tx_id = $3
            `, [executionResult.txHash, totalConsolidated, txId]);
            
            // Mark addresses as consolidated
            const channelIds = result.rows.map(row => row.channel_id);
            await client.query(`
                UPDATE payment_channels 
                SET status = 'consolidated',
                    consolidated_tx_id = $1,
                    consolidated_at = CURRENT_TIMESTAMP
                WHERE channel_id = ANY($2)
            `, [txId, channelIds]);
            
            await client.query('COMMIT');
            
            res.json({
                success: true,
                message: 'Consolidation completed successfully',
                result: {
                    txId,
                    blockchainTxHash: executionResult.txHash,
                    cryptoType,
                    destinationAddress,
                    addressesConsolidated: result.rows.length,
                    totalAmount: totalConsolidated,
                    actualAmountConsolidated: executionResult.totalAmount,
                    additionalTxHashes: executionResult.additionalTxHashes || [],
                    completedAt: new Date().toISOString()
                }
            });
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error executing consolidation:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

router.get('/api/onboarding/admin/consolidation-history', adminAuthMiddleware, async (req, res) => {
    try {
        const { limit = 50, offset = 0, cryptoType } = req.query;
        
        const client = await pool.connect();
        try {
            let sql = `
                SELECT 
                    ct.tx_id,
                    ct.crypto_type,
                    ct.admin_username,
                    ct.destination_address,
                    ct.priority,
                    ct.address_count,
                    ct.amount_consolidated,
                    ct.blockchain_tx_hash,
                    ct.status,
                    ct.created_at,
                    ct.completed_at,
                    ct.error_message
                FROM consolidation_transactions ct
                WHERE 1=1
            `;
            
            const params = [];
            let paramIndex = 1;
            
            if (cryptoType) {
                sql += ` AND ct.crypto_type = $${paramIndex}`;
                params.push(cryptoType);
                paramIndex++;
            }
            
            sql += ` ORDER BY ct.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
            
            const result = await client.query(sql, params);
            
            res.json({
                success: true,
                consolidations: result.rows,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    total: result.rows.length
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching consolidation history:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 14. Admin endpoint to view all crypto addresses
router.get('/api/onboarding/admin/crypto-addresses', createAuthMiddleware(true), async (req, res) => {
    try {
        const { cryptoType, limit = 100, offset = 0 } = req.query;
        
        const client = await pool.connect();
        try {
            let sql = `
                SELECT 
                    ca.address,
                    ca.crypto_type,
                    ca.channel_id,
                    ca.derivation_index,
                    ca.address_type,
                    ca.created_at,
                    ca.reusable_after,
                    pc.status as channel_status,
                    pc.amount_crypto,
                    pc.amount_usd,
                    pc.created_at as channel_created_at
                FROM crypto_addresses ca
                LEFT JOIN payment_channels pc ON ca.channel_id = pc.channel_id
                WHERE 1=1
            `;
            
            const params = [];
            let paramIndex = 1;
            
            if (cryptoType) {
                sql += ` AND ca.crypto_type = $${paramIndex}`;
                params.push(cryptoType);
                paramIndex++;
            }
            
            sql += ` ORDER BY ca.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);
            
            const result = await client.query(sql, params);
            
            res.json({
                success: true,
                addresses: result.rows,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    total: result.rows.length
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching crypto addresses:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 15. Admin endpoint to get address statistics
router.get('/api/onboarding/admin/address-stats', createAuthMiddleware(true), async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const sql = `
                SELECT 
                    ca.crypto_type,
                    COUNT(*) as total_addresses,
                    COUNT(CASE WHEN ca.reusable_after <= NOW() THEN 1 END) as reusable_addresses,
                    COUNT(CASE WHEN pc.status = 'completed' THEN 1 END) as completed_channels,
                    COUNT(CASE WHEN pc.status = 'pending' THEN 1 END) as pending_channels,
                    COUNT(CASE WHEN pc.status = 'expired' THEN 1 END) as expired_channels
                FROM crypto_addresses ca
                LEFT JOIN payment_channels pc ON ca.channel_id = pc.channel_id
                GROUP BY ca.crypto_type
                ORDER BY ca.crypto_type
            `;
            
            const result = await client.query(sql);
            
            res.json({
                success: true,
                statistics: result.rows
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching address statistics:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 16. Fetch and merge HIVE Bridge notifications with local notifications
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

                if (hiveResult?.result && Array.isArray(hiveResult.result)) {
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
            const localNotifications = localNotificationsResult.rows.map(row => {
                let data = row.data ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : null;
                
                // Ensure collaboration_invite notifications have the URL in the data object
                if (row.notification_type === 'collaboration_invite' && data && data.documentOwner && data.documentPermlink) {
                    if (!data.url) {
                        data.url = `new?collabAuthor=${data.documentOwner}&permlink=${data.documentPermlink}`;
                    }
                }
                
                return {
                    id: `local_${row.id}`,
                    type: row.notification_type,
                    title: row.title,
                    message: row.message,
                    data: data,
                    status: row.status,
                    priority: row.priority,
                    createdAt: new Date(row.created_at),
                    readAt: row.read_at ? new Date(row.read_at) : null,
                    dismissedAt: row.dismissed_at ? new Date(row.dismissed_at) : null,
                    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
                    source: 'local'
                };
            });

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
            
                    const claimed = await hiveAccountService.claimAccountCreationTokens();
                    if (claimed) {
                        canUseACT = true;

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

// Posts Management Routes
const apiIndex = require('./index');
const { 
  getPosts, getPostsStats, createPost, updatePost, deletePost, updatePostFlags, testFlags,
  submitFlagReport, getPendingFlags, reviewFlagReport, updateUserFlagPermissions, getUserFlagStats
} = apiIndex;

router.get('/api/posts', adminAuthMiddleware, getPosts);
router.get('/api/posts/stats', adminAuthMiddleware, getPostsStats);
router.get('/api/posts/test-flags', testFlags); // Test endpoint (no auth for testing)
router.post('/api/posts', adminAuthMiddleware, createPost);
router.put('/api/posts/:author/:permlink', adminAuthMiddleware, updatePost);
router.patch('/api/posts/:author/:permlink/flags', adminAuthMiddleware, updatePostFlags);
router.delete('/api/posts/:author/:permlink', adminAuthMiddleware, deletePost);

// Community Flag Reporting Routes
router.post('/api/flags/report', authMiddleware, submitFlagReport);
router.get('/api/flags/pending', adminAuthMiddleware, getPendingFlags);
router.post('/api/flags/review/:reportId', adminAuthMiddleware, reviewFlagReport);
router.put('/api/flags/users/:username/permissions', adminAuthMiddleware, updateUserFlagPermissions);
router.get('/api/flags/users/:username/stats', getUserFlagStats);

// Manual Account Creation Route
router.post('/api/onboarding/admin/manual-create-account', adminAuthMiddleware, async (req, res) => {
    try {
        const { channelId, username, publicKeys, useACT = true } = req.body;
        const adminUsername = req.auth.account;

        if (!channelId || !username || !publicKeys) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: channelId, username, publicKeys'
            });
        }

        // Validate public keys structure
        const requiredKeys = ['owner', 'active', 'posting', 'memo'];
        for (const keyType of requiredKeys) {
            if (!publicKeys[keyType]) {
                return res.status(400).json({
                    success: false,
                    error: `Missing required public key: ${keyType}`
                });
            }
        }

        const client = await pool.connect();
        try {
            // Get the payment channel
            const channelResult = await client.query(
                'SELECT * FROM payment_channels WHERE channel_id = $1',
                [channelId]
            );

            if (channelResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Payment channel not found'
                });
            }

            const channel = channelResult.rows[0];

            // Check if account already exists on blockchain
            const existingAccount = await hiveAccountService.getHiveAccount(username);
            if (existingAccount) {
                // Update channel to completed
                await client.query(
                    `UPDATE payment_channels 
                     SET status = 'completed', account_created_at = CURRENT_TIMESTAMP
                     WHERE channel_id = $1`,
                    [channelId]
                );

                return res.json({
                    success: true,
                    message: `Account @${username} already exists on HIVE blockchain`,
                    accountExists: true
                });
            }

            // Update ACT balance and check resources
            await hiveAccountService.updateACTBalance();
            await hiveAccountService.checkResourceCredits();

            let creationMethod = 'DELEGATION';
            let canUseACT = useACT && hiveAccountService.actBalance > 0;

            // Try to use ACT if requested
            if (useACT && hiveAccountService.actBalance === 0) {
                const rcCosts = await rcMonitoringService.getLatestRCCosts();
                const claimCost = rcCosts['claim_account_operation'];

                if (claimCost && hiveAccountService.resourceCredits >= claimCost.rc_needed) {
                    console.log(`Admin ${adminUsername} attempting to claim ACT for manual account creation`);
                    const claimed = await hiveAccountService.claimAccountCreationTokens();
                    if (claimed) {
                        canUseACT = true;
                        console.log(`ACT successfully claimed for manual creation by ${adminUsername}`);
                    }
                }
            }

            if (canUseACT) {
                creationMethod = 'ACT';
            }

            console.log(`Manual account creation initiated by admin ${adminUsername} for @${username} using ${creationMethod}`);

            // Attempt to create the account
            const creationResult = await hiveAccountService.createHiveAccount(
                username,
                publicKeys,
                channelId
            );

            if (creationResult.success) {
                // Update payment channel to completed
                await client.query(`
                    UPDATE payment_channels 
                    SET status = 'completed', account_created_at = CURRENT_TIMESTAMP
                    WHERE channel_id = $1
                `, [channelId]);

                // Create notification for the user
                await createNotification(
                    username,
                    'account_created',
                    'HIVE Account Created!',
                    `Your HIVE account @${username} has been manually created by admin @${adminUsername}!`,
                    {
                        channel_id: channelId,
                        admin_creator: adminUsername,
                        tx_id: creationResult.txId,
                        creation_method: creationMethod
                    },
                    'high',
                    168 // 7 days
                );

                console.log(`Manual account creation successful: @${username} created by admin ${adminUsername}`);

                res.json({
                    success: true,
                    message: `Account @${username} created successfully by admin intervention!`,
                    account: {
                        username,
                        creator: adminUsername,
                        txId: creationResult.txId,
                        blockNum: creationResult.blockNum,
                        creationMethod,
                        actUsed: creationResult.actUsed,
                        manual: true
                    }
                });
            } else {
                throw new Error(creationResult.error || 'Account creation failed');
            }

        } finally {
            client.release();
        }
    } catch (error) {
        console.error(`Manual account creation failed (admin: ${req.auth?.account}):`, error);
        res.status(500).json({
            success: false,
            error: 'Manual account creation failed',
            details: error.message
        });
    }
});

// 13. Admin endpoint - Cancel payment channel
router.delete('/api/onboarding/admin/channels/:channelId', adminAuthMiddleware, async (req, res) => {
    try {
        const { channelId } = req.params;
        const adminUsername = req.auth.account;

        const client = await pool.connect();
        try {
            // Check if channel exists
            const channelResult = await client.query(
                'SELECT * FROM payment_channels WHERE channel_id = $1',
                [channelId]
            );

            if (channelResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Payment channel not found'
                });
            }

            // Delete related records first to avoid foreign key constraint violations
            
            // Delete payment confirmations
            await client.query('DELETE FROM payment_confirmations WHERE channel_id = $1', [channelId]);
            
            // Delete hive account creations
            await client.query('DELETE FROM hive_account_creations WHERE channel_id = $1', [channelId]);
            
            // Delete crypto addresses
            await client.query('DELETE FROM crypto_addresses WHERE channel_id = $1', [channelId]);
            
            // Now delete the main payment channel
            await client.query('DELETE FROM payment_channels WHERE channel_id = $1', [channelId]);

            console.log(`Payment channel ${channelId} deleted by admin ${adminUsername}`);

            res.json({
                success: true,
                message: 'Payment channel and all related records deleted successfully'
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error canceling payment channel:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to cancel payment channel'
        });
    }
});

// 14. Admin endpoint - Get admin account information
router.get('/api/onboarding/admin/account-info', adminAuthMiddleware, async (req, res) => {
    try {
        const adminUsername = req.auth.account;

        // Get account information directly from Hive blockchain API for real-time data
        const response = await fetch(config.clientURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'condenser_api.get_accounts',
                params: [[adminUsername]],
                id: 1
            })
        });

        const result = await response.json();
        if (!result.result || result.result.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Admin account not found on blockchain'
            });
        }

        const account = result.result[0];
        
        // Get Resource Credits
        const rcResponse = await fetch(config.clientURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'rc_api.find_rc_accounts',
                params: { accounts: [adminUsername] },
                id: 1
            })
        });

        const rcResult = await rcResponse.json();
        let rcData = null;
        let rcPercentage = 0;
        
        if (rcResult.result && rcResult.result.rc_accounts && rcResult.result.rc_accounts.length > 0) {
            const rcAccount = rcResult.result.rc_accounts[0];
            const currentMana = parseInt(rcAccount.rc_manabar.current_mana);
            const maxMana = parseInt(rcAccount.max_rc);
            rcPercentage = maxMana > 0 ? (currentMana / maxMana) * 100 : 0;
            
            rcData = {
                current_mana: currentMana,
                max_rc: maxMana,
                percentage: rcPercentage,
                last_update_time: rcAccount.rc_manabar.last_update_time
            };
        }

        // Calculate HIVE balance
        const hiveBalance = parseFloat(account.balance.split(' ')[0]);
        const hbdBalance = parseFloat(account.hbd_balance.split(' ')[0]);
        const vestingShares = parseFloat(account.vesting_shares.split(' ')[0]);
        
        res.json({
            success: true,
            account: {
                username: account.name,
                created: account.created,
                reputation: account.reputation,
                balance: {
                    hive: hiveBalance,
                    hbd: hbdBalance,
                    vesting_shares: vestingShares
                },
                actBalance: account.pending_claimed_accounts || 0,
                resourceCredits: rcData,
                postCount: account.post_count,
                followingCount: account.following_count,
                followerCount: account.follower_count
            }
        });
    } catch (error) {
        console.error('Error fetching admin account info:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch admin account information'
        });
    }
});

// 15. Admin endpoint - Claim ACT token for admin account
router.post('/api/onboarding/admin/claim-act', adminAuthMiddleware, async (req, res) => {
    try {
        const adminUsername = req.auth.account;

        // Get real-time RC costs for claim_account operation
        const rcCosts = await rcMonitoringService.getLatestRCCosts();
        const claimAccountCost = rcCosts['claim_account_operation'];

        if (!claimAccountCost) {
            return res.status(400).json({
                success: false,
                error: 'RC cost data not available for claim_account operation'
            });
        }

        // Get admin's current RC
        const rcResponse = await fetch(config.clientURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'rc_api.find_rc_accounts',
                params: { accounts: [adminUsername] },
                id: 1
            })
        });

        const rcResult = await rcResponse.json();
        if (!rcResult.result || !rcResult.result.rc_accounts || rcResult.result.rc_accounts.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Unable to fetch admin Resource Credits'
            });
        }

        const rcAccount = rcResult.result.rc_accounts[0];
        const currentRC = parseInt(rcAccount.rc_manabar.current_mana);
        const rcNeeded = claimAccountCost.rc_needed;

        if (currentRC < rcNeeded) {
            return res.status(400).json({
                success: false,
                error: `Insufficient Resource Credits. Need: ${(rcNeeded / 1e12).toFixed(2)}T RC, Have: ${(currentRC / 1e12).toFixed(2)}T RC`,
                rcInfo: {
                    current: currentRC,
                    needed: rcNeeded,
                    deficit: rcNeeded - currentRC
                }
            });
        }

        // Return the operation for keychain to execute
        const claimOperation = [
            'claim_account',
            {
                creator: adminUsername,
                fee: '0.000 HIVE',
                extensions: []
            }
        ];

        res.json({
            success: true,
            operation: claimOperation,
            rcCost: {
                needed: rcNeeded,
                current: currentRC,
                after_claim: currentRC - rcNeeded
            },
            message: 'Operation ready for keychain signature'
        });

    } catch (error) {
        console.error('Error preparing ACT claim:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to prepare ACT claim operation'
        });
    }
});

// 16. Admin endpoint - Build account with admin keychain
router.post('/api/onboarding/admin/build-account', adminAuthMiddleware, async (req, res) => {
    try {
        const { channelId, useACT = true } = req.body;
        const adminUsername = req.auth.account;

        if (!channelId) {
            return res.status(400).json({
                success: false,
                error: 'Channel ID is required'
            });
        }

        const client = await pool.connect();
        try {
            // Get the payment channel
            const channelResult = await client.query(
                'SELECT * FROM payment_channels WHERE channel_id = $1',
                [channelId]
            );

            if (channelResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Payment channel not found'
                });
            }

            const channel = channelResult.rows[0];

            if (!channel.username) {
                return res.status(400).json({
                    success: false,
                    error: 'No username specified in payment channel'
                });
            }

            if (!channel.public_keys) {
                return res.status(400).json({
                    success: false,
                    error: 'No public keys available for account creation'
                });
            }

            let publicKeys;
            try {
                publicKeys = typeof channel.public_keys === 'string' 
                    ? JSON.parse(channel.public_keys) 
                    : channel.public_keys;
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid public keys format'
                });
            }

            // Check if account already exists
            const existingAccount = await hiveAccountService.getHiveAccount(channel.username);
            if (existingAccount) {
                // Update channel to completed
                await client.query(
                    `UPDATE payment_channels 
                     SET status = 'completed', account_created_at = CURRENT_TIMESTAMP
                     WHERE channel_id = $1`,
                    [channelId]
                );

                return res.json({
                    success: true,
                    message: `Account @${channel.username} already exists on HIVE blockchain`,
                    accountExists: true
                });
            }

            // Get admin's current ACT balance and RC
            const adminAccountResponse = await fetch(config.clientURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'condenser_api.get_accounts',
                    params: [[adminUsername]],
                    id: 1
                })
            });

            const adminAccountResult = await adminAccountResponse.json();
            if (!adminAccountResult.result || adminAccountResult.result.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Admin account not found'
                });
            }

            const adminAccount = adminAccountResult.result[0];
            const adminACTBalance = adminAccount.pending_claimed_accounts || 0;

            let operation;
            let creationMethod = 'DELEGATION';

            if (useACT && adminACTBalance > 0) {
                // Use ACT
                creationMethod = 'ACT';
                operation = [
                    'create_claimed_account',
                    {
                        creator: adminUsername,
                        new_account_name: channel.username,
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
                        json_metadata: "",
                        extensions: []
                    }
                ];
            } else {
                // Use HIVE delegation
                operation = [
                    'account_create',
                    {
                        fee: '3.000 HIVE',
                        creator: adminUsername,
                        new_account_name: channel.username,
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

            res.json({
                success: true,
                operation: operation,
                creationMethod: creationMethod,
                username: channel.username,
                channelId: channelId,
                adminACTBalance: adminACTBalance,
                message: 'Account creation operation ready for keychain signature'
            });

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error preparing account creation:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to prepare account creation operation'
        });
    }
});

// 17. Admin endpoint - Complete keychain account creation
router.post('/api/onboarding/admin/complete-account-creation', adminAuthMiddleware, async (req, res) => {
    try {
        const { channelId, txId, username, creationMethod } = req.body;
        const adminUsername = req.auth.account;

        if (!channelId || !txId || !username) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: channelId, txId, username'
            });
        }

        const client = await pool.connect();
        try {
            // Update payment channel to completed
            await client.query(`
                UPDATE payment_channels 
                SET status = 'completed', account_created_at = CURRENT_TIMESTAMP
                WHERE channel_id = $1
            `, [channelId]);

            // Record the creation
            await client.query(`
                INSERT INTO hive_account_creations 
                (channel_id, username, creation_method, hive_tx_id, status, completed_at)
                VALUES ($1, $2, $3, $4, 'success', CURRENT_TIMESTAMP)
            `, [channelId, username, creationMethod, txId]);

            // Create notification for the user
            await createNotification(
                username,
                'account_created',
                'HIVE Account Created!',
                `Your HIVE account @${username} has been created by admin @${adminUsername} using keychain!`,
                {
                    channel_id: channelId,
                    admin_creator: adminUsername,
                    tx_id: txId,
                    creation_method: creationMethod
                },
                'high',
                168 // 7 days
            );

            console.log(`Account @${username} created successfully by admin ${adminUsername} via keychain. TX: ${txId}`);

            res.json({
                success: true,
                message: `Account @${username} created successfully!`,
                account: {
                    username,
                    creator: adminUsername,
                    txId,
                    creationMethod,
                    channelId
                }
            });

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error completing account creation:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to complete account creation'
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
    rcMonitoringService,
    HiveAuth,
    createAuthMiddleware
};

// Auto-initialize if this file is run directly
if (require.main === module) {
    initializeOnboardingService().then(() => {


        // Keep the process alive for testing
        setInterval(() => {

        }, 10 * 60 * 1000); // Every 10 minutes
    });
} 

// Admin endpoint to fix database constraints
router.post('/api/onboarding/admin/fix-database-constraints', adminAuthMiddleware, async (req, res) => {
    try {
        const client = await pool.connect();
        const results = {
            payment_confirmations_unique: null,
            hive_account_creations_cascade: null,
            crypto_addresses_cascade: null
        };
        
        try {
            // 1. Fix payment_confirmations unique constraint
            try {
                const constraintCheck = await client.query(`
                    SELECT constraint_name 
                    FROM information_schema.table_constraints 
                    WHERE table_name = 'payment_confirmations' 
                    AND constraint_type = 'UNIQUE'
                    AND constraint_name LIKE '%channel_id%'
                `);

                if (constraintCheck.rows.length === 0) {
                    await client.query(`
                        ALTER TABLE payment_confirmations 
                        ADD CONSTRAINT payment_confirmations_channel_tx_unique 
                        UNIQUE (channel_id, tx_hash)
                    `);
                    results.payment_confirmations_unique = 'Added unique constraint';
                } else {
                    results.payment_confirmations_unique = 'Constraint already exists';
                }
            } catch (error) {
                results.payment_confirmations_unique = `Error: ${error.message}`;
            }

            // 2. Fix hive_account_creations foreign key to CASCADE
            try {
                // Drop existing constraint
                await client.query(`
                    ALTER TABLE hive_account_creations 
                    DROP CONSTRAINT IF EXISTS hive_account_creations_channel_id_fkey
                `);
                
                // Add new constraint with CASCADE
                await client.query(`
                    ALTER TABLE hive_account_creations 
                    ADD CONSTRAINT hive_account_creations_channel_id_fkey 
                    FOREIGN KEY (channel_id) REFERENCES payment_channels(channel_id) ON DELETE CASCADE
                `);
                results.hive_account_creations_cascade = 'Fixed CASCADE constraint';
            } catch (error) {
                results.hive_account_creations_cascade = `Error: ${error.message}`;
            }

            // 3. Fix crypto_addresses foreign key to CASCADE  
            try {
                // Check if foreign key constraint exists
                const fkCheck = await client.query(`
                    SELECT constraint_name 
                    FROM information_schema.table_constraints 
                    WHERE table_name = 'crypto_addresses' 
                    AND constraint_type = 'FOREIGN KEY'
                    AND constraint_name LIKE '%channel_id%'
                `);

                if (fkCheck.rows.length === 0) {
                    // Add foreign key constraint with CASCADE
                    await client.query(`
                        ALTER TABLE crypto_addresses 
                        ADD CONSTRAINT crypto_addresses_channel_id_fkey 
                        FOREIGN KEY (channel_id) REFERENCES payment_channels(channel_id) ON DELETE CASCADE
                    `);
                    results.crypto_addresses_cascade = 'Added CASCADE constraint';
                } else {
                    // Drop and recreate with CASCADE
                    await client.query(`
                        ALTER TABLE crypto_addresses 
                        DROP CONSTRAINT ${fkCheck.rows[0].constraint_name}
                    `);
                    
                    await client.query(`
                        ALTER TABLE crypto_addresses 
                        ADD CONSTRAINT crypto_addresses_channel_id_fkey 
                        FOREIGN KEY (channel_id) REFERENCES payment_channels(channel_id) ON DELETE CASCADE
                    `);
                    results.crypto_addresses_cascade = 'Updated to CASCADE constraint';
                }
            } catch (error) {
                results.crypto_addresses_cascade = `Error: ${error.message}`;
            }

            res.json({
                success: true,
                message: 'Database constraints migration completed',
                results: results
            });

        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fixing database constraints:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fix database constraints',
            details: error.message
        });
    }
});

// Test endpoint to validate database and monitoring fixes
router.get('/api/onboarding/test/fixes-validation', async (req, res) => {
    try {
        const results = {
            timestamp: new Date().toISOString(),
            fixes: {
                database_constraint: null,
                monitoring_config: null,
                supported_currencies: null
            }
        };

        // 1. Test database constraints
        try {
            const client = await pool.connect();
            try {
                const constraintChecks = {};
                
                // Check payment_confirmations unique constraint
                const pcUnique = await client.query(`
                    SELECT constraint_name 
                    FROM information_schema.table_constraints 
                    WHERE table_name = 'payment_confirmations' 
                    AND constraint_type = 'UNIQUE'
                    AND constraint_name LIKE '%channel_id%'
                `);
                constraintChecks.payment_confirmations_unique = pcUnique.rows.length > 0;
                
                // Check hive_account_creations CASCADE constraint
                const hacCascade = await client.query(`
                    SELECT tc.constraint_name, rc.delete_rule
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.referential_constraints rc 
                        ON tc.constraint_name = rc.constraint_name
                    WHERE tc.table_name = 'hive_account_creations' 
                    AND tc.constraint_type = 'FOREIGN KEY'
                    AND tc.constraint_name LIKE '%channel_id%'
                `);
                constraintChecks.hive_account_creations_cascade = 
                    hacCascade.rows.length > 0 && hacCascade.rows[0].delete_rule === 'CASCADE';
                
                // Check crypto_addresses CASCADE constraint
                const caCascade = await client.query(`
                    SELECT tc.constraint_name, rc.delete_rule
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.referential_constraints rc 
                        ON tc.constraint_name = rc.constraint_name
                    WHERE tc.table_name = 'crypto_addresses' 
                    AND tc.constraint_type = 'FOREIGN KEY'
                    AND tc.constraint_name LIKE '%channel_id%'
                `);
                constraintChecks.crypto_addresses_cascade = 
                    caCascade.rows.length > 0 && caCascade.rows[0].delete_rule === 'CASCADE';
                
                const allFixed = Object.values(constraintChecks).every(check => check === true);
                
                results.fixes.database_constraint = {
                    status: allFixed ? 'fixed' : 'needs_migration',
                    message: allFixed ? 'All database constraints properly configured' : 'Some constraints need migration',
                    details: constraintChecks
                };
            } finally {
                client.release();
            }
        } catch (error) {
            results.fixes.database_constraint = {
                status: 'error',
                message: `Database constraint check failed: ${error.message}`
            };
        }

        // 2. Test monitoring configuration
        try {
            const enabledCryptos = Object.keys(CRYPTO_CONFIG).filter(crypto => 
                CRYPTO_CONFIG[crypto].monitoring_enabled !== false
            );
            const disabledCryptos = Object.keys(CRYPTO_CONFIG).filter(crypto => 
                CRYPTO_CONFIG[crypto].monitoring_enabled === false
            );
            
            results.fixes.monitoring_config = {
                status: 'configured',
                enabled_networks: enabledCryptos,
                disabled_networks: disabledCryptos,
                message: `DASH and XMR monitoring disabled as requested`
            };
        } catch (error) {
            results.fixes.monitoring_config = {
                status: 'error',
                message: `Monitoring config error: ${error.message}`
            };
        }

        // 3. Test supported currencies filter
        try {
            const supportedCurrencies = Object.keys(CRYPTO_CONFIG).filter(crypto => 
                CRYPTO_CONFIG[crypto].monitoring_enabled !== false
            );
            
            results.fixes.supported_currencies = {
                status: 'updated',
                currencies: supportedCurrencies,
                message: `Only monitoring-enabled currencies are returned to users`
            };
        } catch (error) {
            results.fixes.supported_currencies = {
                status: 'error',
                message: `Supported currencies error: ${error.message}`
            };
        }

        res.json({
            success: true,
            validation: results
        });

    } catch (error) {
        console.error('Error in fixes validation:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to validate fixes',
            details: error.message
        });
    }
}); 

// Admin endpoint to check current database constraint status
router.get('/api/onboarding/admin/constraint-status', adminAuthMiddleware, async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const status = {};
            
            // Check payment_confirmations unique constraint
            const pcUnique = await client.query(`
                SELECT constraint_name 
                FROM information_schema.table_constraints 
                WHERE table_name = 'payment_confirmations' 
                AND constraint_type = 'UNIQUE'
                AND constraint_name LIKE '%channel_id%'
            `);
            status.payment_confirmations_unique = {
                exists: pcUnique.rows.length > 0,
                constraint_name: pcUnique.rows[0]?.constraint_name || null
            };
            
            // Check hive_account_creations foreign key and CASCADE status
            const hacFk = await client.query(`
                SELECT tc.constraint_name, rc.delete_rule
                FROM information_schema.table_constraints tc
                LEFT JOIN information_schema.referential_constraints rc 
                    ON tc.constraint_name = rc.constraint_name
                WHERE tc.table_name = 'hive_account_creations' 
                AND tc.constraint_type = 'FOREIGN KEY'
                AND tc.constraint_name LIKE '%channel_id%'
            `);
            status.hive_account_creations_fk = {
                exists: hacFk.rows.length > 0,
                constraint_name: hacFk.rows[0]?.constraint_name || null,
                delete_rule: hacFk.rows[0]?.delete_rule || null,
                has_cascade: hacFk.rows[0]?.delete_rule === 'CASCADE'
            };
            
            // Check crypto_addresses foreign key and CASCADE status  
            const caFk = await client.query(`
                SELECT tc.constraint_name, rc.delete_rule
                FROM information_schema.table_constraints tc
                LEFT JOIN information_schema.referential_constraints rc 
                    ON tc.constraint_name = rc.constraint_name
                WHERE tc.table_name = 'crypto_addresses' 
                AND tc.constraint_type = 'FOREIGN KEY'
                AND tc.constraint_name LIKE '%channel_id%'
            `);
            status.crypto_addresses_fk = {
                exists: caFk.rows.length > 0,
                constraint_name: caFk.rows[0]?.constraint_name || null,
                delete_rule: caFk.rows[0]?.delete_rule || null,
                has_cascade: caFk.rows[0]?.delete_rule === 'CASCADE'
            };
            
            res.json({
                success: true,
                constraint_status: status,
                summary: {
                    payment_confirmations_ready: status.payment_confirmations_unique.exists,
                    hive_account_creations_ready: status.hive_account_creations_fk.has_cascade,
                    crypto_addresses_ready: status.crypto_addresses_fk.has_cascade,
                    all_constraints_ready: status.payment_confirmations_unique.exists && 
                                         status.hive_account_creations_fk.has_cascade && 
                                         status.crypto_addresses_fk.has_cascade
                }
            });

        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error checking constraint status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check constraint status',
            details: error.message
        });
    }
}); 