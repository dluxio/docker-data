const fetch = require('node-fetch');
const { Pool } = require('pg');
const config = require('../config');

// Create database pool directly to avoid circular dependency
const pool = new Pool({
  connectionString: config.dbcs,
});

// Enhanced error classes for better error handling
class BlockchainMonitorError extends Error {
    constructor(message, code, network = null) {
        super(message);
        this.name = 'BlockchainMonitorError';
        this.code = code;
        this.network = network;
    }
}

class APIError extends BlockchainMonitorError {
    constructor(message, network, statusCode = null) {
        super(message, 'API_ERROR', network);
        this.statusCode = statusCode;
    }
}

class TransactionNotFoundError extends BlockchainMonitorError {
    constructor(txHash, network) {
        super(`Transaction ${txHash} not found on ${network} network`, 'TX_NOT_FOUND', network);
        this.txHash = txHash;
    }
}

class InvalidConfigurationError extends BlockchainMonitorError {
    constructor(message, network = null) {
        super(message, 'INVALID_CONFIG', network);
    }
}

// Simple logger implementation (can be replaced with Winston in production)
class Logger {
    static log(level, message, metadata = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            ...metadata
        };
        
        // In production, this should use a proper logging framework
        console[level] ? console[level](JSON.stringify(logEntry)) : console.log(JSON.stringify(logEntry));
    }
    
    static info(message, metadata = {}) {
        this.log('info', message, metadata);
    }
    
    static warn(message, metadata = {}) {
        this.log('warn', message, metadata);
    }
    
    static error(message, metadata = {}) {
        this.log('error', message, metadata);
    }
    
    static debug(message, metadata = {}) {
        if (process.env.NODE_ENV === 'development') {
            this.log('debug', message, metadata);
        }
    }
}

// Blockchain monitoring service for crypto payments
class BlockchainMonitoringService {
    constructor() {
        this.monitoringIntervals = new Map();
        this.isRunning = false;
        this.networks = new Map();
        this.lastBlockChecked = new Map();
        this.processedTransactions = new Set(); // Track processed transactions to prevent duplicates
        this.configurationStatus = null; // Will be set by validateConfiguration
        
        this.validateConfiguration();
        this.initializeNetworks();
    }

    // Validate required API keys and configuration
    validateConfiguration() {
        const requiredEnvVars = {
            'ETHERSCAN_API_KEY': 'Etherscan V2 API (supports multiple chains)'
        };

        const missingKeys = [];
        for (const [key, description] of Object.entries(requiredEnvVars)) {
            if (!process.env[key] || process.env[key] === 'YourApiKeyToken') {
                missingKeys.push(`${key} (${description})`);
            }
        }

        // Store configuration status instead of throwing
        this.configurationStatus = {
            isValid: missingKeys.length === 0,
            missingKeys: missingKeys,
            message: missingKeys.length > 0 ? 
                `Missing required API keys: ${missingKeys.join(', ')}. Please set these environment variables.` :
                'Configuration is valid'
        };

        if (missingKeys.length > 0) {
            Logger.warn('Blockchain monitoring configuration incomplete', {
                missingKeys: missingKeys
            });
        }
    }

    initializeNetworks() {
        // Network configurations for blockchain monitoring
        this.networks.set('BTC', {
            name: 'Bitcoin',
            type: 'utxo',
            apis: [
                'https://blockstream.info/api',
                'https://api.blockcypher.com/v1/btc/main'
            ],
            confirmations_required: 2,
            block_time: 10 * 60, // 10 minutes in seconds
            decimals: 8,
            min_amount: 0.00001, // Minimum amount to consider (in BTC)
            supports_memo: true, // OP_RETURN support
            max_memo_bytes: 80
        });

        this.networks.set('ETH', {
            name: 'Ethereum',
            type: 'account',
            chainId: 1,
            apis: [
                'https://api.etherscan.io/v2/api',
                'https://eth-mainnet.alchemyapi.io/v2/' + (process.env.ALCHEMY_API_KEY || '')
            ],
            confirmations_required: 2,
            block_time: 12,
            decimals: 18,
            min_amount: 0.0001, // Minimum amount to consider (in ETH)
            supports_memo: false,
            supports_tokens: true
        });

        this.networks.set('BNB', {
            name: 'BNB Smart Chain',
            type: 'account',
            chainId: 56,
            apis: [
                'https://api.etherscan.io/v2/api',
                'https://bsc-dataseed.binance.org'
            ],
            confirmations_required: 3,
            block_time: 3,
            decimals: 18,
            min_amount: 0.001, // Minimum amount to consider (in BNB)
            supports_memo: false,
            supports_tokens: true
        });

        this.networks.set('MATIC', {
            name: 'Polygon',
            type: 'account',
            chainId: 137,
            apis: [
                'https://api.etherscan.io/v2/api',
                'https://polygon-rpc.com'
            ],
            confirmations_required: 10,
            block_time: 2,
            decimals: 18,
            min_amount: 0.01, // Minimum amount to consider (in MATIC)
            supports_memo: false,
            supports_tokens: true
        });

        this.networks.set('SOL', {
            name: 'Solana',
            type: 'account',
            apis: [
                'https://api.mainnet-beta.solana.com',
                'https://solana-api.projectserum.com'
            ],
            confirmations_required: 1,
            block_time: 0.4,
            decimals: 9,
            min_amount: 0.001, // Minimum amount to consider (in SOL)
            supports_memo: true,
            finality_type: 'finalized' // Solana uses finalized vs confirmed
        });

        this.networks.set('DASH', {
            name: 'Dash',
            type: 'utxo',
            apis: [
                // Placeholder - would need actual Dash APIs
                'https://dashgoldrpc.com',
                'https://electrum.dash.org:51002'
            ],
            confirmations_required: 6,
            block_time: 2.5 * 60, // 2.5 minutes
            decimals: 8,
            min_amount: 0.00001, // Minimum amount to consider (in DASH)
            supports_memo: false, // Using unique addresses instead
            monitoring_enabled: false // Disabled - not supported by ethscan API
        });

        this.networks.set('XMR', {
            name: 'Monero',
            type: 'account',
            apis: [
                // Placeholder - would need actual Monero APIs
                'https://xmr-node.cakewallet.com:18081',
                'https://node.community.rino.io:18081'
            ],
            confirmations_required: 10,
            block_time: 2 * 60, // 2 minutes
            decimals: 12,
            min_amount: 0.0001, // Minimum amount to consider (in XMR)
            supports_memo: false, // Using unique addresses instead
            monitoring_enabled: false // Disabled - not supported by ethscan API
        });

        // Network configurations initialized
    }

    // Start monitoring all active payment channels
    async startMonitoring() {
        if (this.isRunning) {
            Logger.info('Blockchain monitoring is already running');
            return;
        }

        // Check configuration before starting
        if (!this.configurationStatus.isValid) {
            Logger.warn('Cannot start blockchain monitoring due to configuration issues', {
                issues: this.configurationStatus.missingKeys
            });
            this.isRunning = false;
            return; // Don't throw, just don't start
        }

        this.isRunning = true;
        this.startTime = Date.now(); // Track start time for uptime calculation
        
        // Filter enabled networks only
        const enabledNetworks = Array.from(this.networks.entries())
            .filter(([symbol, network]) => network.monitoring_enabled !== false)
            .map(([symbol, network]) => symbol);
            
        Logger.info('Starting blockchain monitoring service', {
            networks: enabledNetworks,
            disabled_networks: Array.from(this.networks.keys()).filter(s => !enabledNetworks.includes(s))
        });

        try {
            // Start staggered monitoring to avoid rate limits
            // Check each network every 25 seconds (5 networks * 5 seconds = 25 seconds total cycle)
            await this.startStaggeredNetworkMonitoring();

            // Global monitoring loop for payment channels (reduced frequency)
            this.globalMonitoringInterval = setInterval(async () => {
                try {
                    await this.monitorActiveChannels();
                } catch (error) {
                    Logger.error('Error in global monitoring loop', { error: error.message });
                }
            }, 60000); // Check every 60 seconds (reduced from 30)

            Logger.info('Blockchain monitoring service started successfully', {
                activeNetworks: this.monitoringIntervals.size
            });
        } catch (error) {
            this.isRunning = false;
            Logger.error('Failed to start blockchain monitoring service', { error: error.message });
            throw error;
        }
    }

    // Stop all monitoring
    stopMonitoring() {
        this.isRunning = false;
        
        // Clear all network monitoring intervals
        for (const [network, interval] of this.monitoringIntervals) {
            clearInterval(interval);
        }
        this.monitoringIntervals.clear();

        if (this.globalMonitoringInterval) {
            clearInterval(this.globalMonitoringInterval);
        }

        if (this.staggeredMonitoringInterval) {
            clearInterval(this.staggeredMonitoringInterval);
        }

        Logger.info('Blockchain monitoring service stopped');
    }

    // Start staggered monitoring to avoid rate limits
    async startStaggeredNetworkMonitoring() {
        // Only include enabled networks
        const networks = Array.from(this.networks.entries())
            .filter(([symbol, network]) => network.monitoring_enabled !== false);
        let currentIndex = 0;

        if (networks.length === 0) {
            Logger.warn('No enabled networks for monitoring');
            return;
        }

        // Initialize last checked blocks for enabled networks only
        for (const [symbol, network] of networks) {
            try {
                const currentBlock = await this.getCurrentBlockHeight(symbol);
                if (currentBlock) {
                    this.lastBlockChecked.set(symbol, currentBlock);
                }
            } catch (error) {
                Logger.error('Failed to get initial block height', { 
                    network: symbol, 
                    error: error.message 
                });
            }
        }

        // Staggered monitoring - check one network every 5 seconds
        this.staggeredMonitoringInterval = setInterval(async () => {
            if (networks.length === 0) return;
            
            const [symbol, network] = networks[currentIndex];
            try {
                await this.checkNetworkForPayments(symbol, network);
            } catch (error) {
                Logger.error('Error in staggered network monitoring', { 
                    network: symbol, 
                    error: error.message 
                });
            }
            
            // Move to next network
            currentIndex = (currentIndex + 1) % networks.length;
        }, 5000); // Check every 5 seconds, cycling through networks

        this.monitoringIntervals.set('staggered', this.staggeredMonitoringInterval);
        
        Logger.info('Started staggered network monitoring', {
            networks: networks.map(([symbol]) => symbol),
            checkInterval: '5 seconds per network',
            fullCycleTime: `${networks.length * 5} seconds`
        });
    }

    // Start monitoring for a specific network
    async startNetworkMonitoring(symbol, network) {
        try {
            // Initialize last checked block
            const currentBlock = await this.getCurrentBlockHeight(symbol);
            if (currentBlock) {
                this.lastBlockChecked.set(symbol, currentBlock);
            }

            // Use slower intervals to avoid rate limiting
            const checkInterval = Math.max(network.block_time * 1000, 60000); // At least 60 seconds
            const interval = setInterval(async () => {
                try {
                    await this.checkNetworkForPayments(symbol, network);
                } catch (error) {
                    Logger.error('Error in network monitoring', { 
                        network: symbol, 
                        error: error.message 
                    });
                }
            }, checkInterval);

            this.monitoringIntervals.set(symbol, interval);
        } catch (error) {
            Logger.error('Failed to start network monitoring', { 
                network: symbol, 
                error: error.message 
            });
            throw new BlockchainMonitorError(
                `Failed to start monitoring for ${symbol}: ${error.message}`,
                'MONITORING_START_FAILED',
                symbol
            );
        }
    }

    // Enhanced network checking with actual block scanning
    async checkNetworkForPayments(symbol, network) {
        try {
            const currentBlock = await this.getCurrentBlockHeight(symbol);
            if (!currentBlock) {
                return;
            }

            const lastChecked = this.lastBlockChecked.get(symbol) || currentBlock - 1;
            
            // Only scan if there are new blocks
            if (currentBlock > lastChecked) {

                // Get monitored addresses for this network
                const monitoredAddresses = await this.getMonitoredAddresses(symbol);
                
                if (monitoredAddresses.length > 0) {
                    // Scan new blocks for transactions to monitored addresses
                    await this.scanBlocksForTransactions(
                        symbol, 
                        network, 
                        lastChecked + 1, 
                        currentBlock, 
                        monitoredAddresses
                    );
                }

                this.lastBlockChecked.set(symbol, currentBlock);
            }
        } catch (error) {
            Logger.error('Error checking network for payments', { 
                network: symbol, 
                error: error.message 
            });
            throw new BlockchainMonitorError(
                `Network check failed for ${symbol}: ${error.message}`,
                'NETWORK_CHECK_FAILED',
                symbol
            );
        }
    }

    // Get addresses that need monitoring for a specific network
    async getMonitoredAddresses(cryptoType) {
        try {
            const client = await pool.connect();
            try {
                const result = await client.query(`
                    SELECT DISTINCT payment_address 
                    FROM payment_channels 
                    WHERE crypto_type = $1 
                    AND status IN ('pending', 'confirming') 
                    AND expires_at > NOW()
                `, [cryptoType]);

                return result.rows.map(row => row.payment_address);
            } finally {
                client.release();
            }
        } catch (error) {
            Logger.error('Error getting monitored addresses', { 
                cryptoType, 
                error: error.message 
            });
            return [];
        }
    }

    // Scan blocks for transactions to monitored addresses
    async scanBlocksForTransactions(symbol, network, fromBlock, toBlock, addresses) {

        // For now, fall back to address-based scanning
        // This could be enhanced with actual block scanning for supported networks
        for (const address of addresses) {
            try {
                const transactions = await this.getAddressTransactions(
                    symbol, 
                    address, 
                    new Date(Date.now() - 60 * 60 * 1000) // Last hour
                );

                for (const tx of transactions) {
                    if (!this.processedTransactions.has(tx.hash)) {
                        await this.processDiscoveredTransaction(symbol, address, tx);
                        this.processedTransactions.add(tx.hash);
                    }
                }
            } catch (error) {
                Logger.error('Error scanning address transactions', { 
                    network: symbol, 
                    address, 
                    error: error.message 
                });
            }
        }
    }

    // Process a discovered transaction
    async processDiscoveredTransaction(cryptoType, address, transaction) {
        try {
            const client = await pool.connect();
            try {
                // Find matching payment channels
                const result = await client.query(`
                    SELECT * FROM payment_channels 
                    WHERE crypto_type = $1 
                    AND payment_address = $2 
                    AND status IN ('pending', 'confirming')
                    AND expires_at > NOW()
                `, [cryptoType, address]);

                for (const channel of result.rows) {
                    const network = this.networks.get(cryptoType);
                    const isMatch = await this.verifyTransactionMatch(channel, transaction, network);
                    
                    if (isMatch) {
                        console.log(`💰 Payment found for ${channel.crypto_type} channel ${channel.channel_id}: ${transaction.amount} ${channel.crypto_type} (${transaction.hash})`);
                        
                        await this.processPaymentFound(channel, transaction);
                        break; // Only process once per transaction
                    }
                }
            } finally {
                client.release();
            }
        } catch (error) {
            Logger.error('Error processing discovered transaction', { 
                cryptoType, 
                address, 
                txHash: transaction.hash, 
                error: error.message 
            });
        }
    }

    // Get current block height for a network
    async getCurrentBlockHeight(symbol) {
        try {
            switch (symbol) {
                case 'BTC':
                    const btcResponse = await fetch('https://blockstream.info/api/blocks/tip/height');
                    if (!btcResponse.ok) {
                        throw new APIError(`Bitcoin API error: ${btcResponse.statusText}`, 'BTC', btcResponse.status);
                    }
                    return parseInt(await btcResponse.text());
                    
                case 'ETH':
                case 'BNB':
                case 'MATIC':
                    const network = this.networks.get(symbol);
                    const response = await fetch(`https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=proxy&action=eth_blockNumber&apikey=${process.env.ETHERSCAN_API_KEY}`);
                    if (!response.ok) {
                        throw new APIError(`${network.name} API error: ${response.statusText}`, symbol, response.status);
                    }
                    const data = await response.json();
                    if (data.error) {
                        throw new APIError(`${network.name} API error: ${data.error.message}`, symbol);
                    }
                    return parseInt(data.result, 16);
                    
                case 'SOL':
                    const solResponse = await fetch('https://api.mainnet-beta.solana.com', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'getSlot'
                        })
                    });
                    if (!solResponse.ok) {
                        throw new APIError(`Solana API error: ${solResponse.statusText}`, 'SOL', solResponse.status);
                    }
                    const solData = await solResponse.json();
                    if (solData.error) {
                        throw new APIError(`Solana RPC error: ${solData.error.message}`, 'SOL');
                    }
                    return solData.result;
                    
                default:
                    throw new BlockchainMonitorError(`Unsupported network: ${symbol}`, 'UNSUPPORTED_NETWORK');
            }
        } catch (error) {
            if (error instanceof BlockchainMonitorError) {
                throw error;
            }
            Logger.error('Error getting current block height', { 
                network: symbol, 
                error: error.message 
            });
            throw new APIError(`Failed to get block height for ${symbol}: ${error.message}`, symbol);
        }
    }

    // Monitor all active payment channels with smart network selection
    async monitorActiveChannels() {
        try {
            const client = await pool.connect();
            try {
                // Get all pending and confirming channels grouped by crypto type
                const result = await client.query(`
                    SELECT crypto_type, COUNT(*) as channel_count,
                           array_agg(channel_id) as channel_ids
                    FROM payment_channels 
                    WHERE status IN ('pending', 'confirming') 
                    AND expires_at > NOW()
                    GROUP BY crypto_type
                    ORDER BY channel_count DESC
                `);

                const activeNetworks = new Set();
                const networkChannelCounts = {};

                // Process each network that has active channels
                for (const row of result.rows) {
                    const cryptoType = row.crypto_type;
                    const channelCount = parseInt(row.channel_count);
                    
                    activeNetworks.add(cryptoType);
                    networkChannelCounts[cryptoType] = channelCount;

                    Logger.info(`Monitoring ${cryptoType} network`, {
                        activeChannels: channelCount,
                        channelIds: row.channel_ids
                    });

                    // Get specific channels for this network
                    const channelResult = await client.query(`
                        SELECT channel_id, crypto_type, payment_address, amount_crypto, memo, tx_hash, confirmations, created_at
                        FROM payment_channels 
                        WHERE crypto_type = $1
                        AND status IN ('pending', 'confirming') 
                        AND expires_at > NOW()
                        ORDER BY created_at ASC
                    `, [cryptoType]);

                    // Check each channel for this network
                    for (const channel of channelResult.rows) {
                        await this.checkChannelPayment(channel);
                    }
                }

                // Log smart monitoring status
                const allNetworks = Array.from(this.networks.keys());
                const monitoredNetworks = Array.from(activeNetworks);
                const skippedNetworks = allNetworks.filter(net => !activeNetworks.has(net));

                if (skippedNetworks.length > 0) {
                    Logger.debug('Smart monitoring: skipping networks with no active channels', {
                        skippedNetworks: skippedNetworks,
                        monitoredNetworks: monitoredNetworks,
                        channelCounts: networkChannelCounts
                    });
                }

                // Update monitoring intervals based on active networks
                await this.updateSmartMonitoring(activeNetworks);

            } finally {
                client.release();
            }
        } catch (error) {
            Logger.error('Error monitoring active channels', { error: error.message });
            throw new BlockchainMonitorError(
                `Failed to monitor active channels: ${error.message}`,
                'MONITORING_FAILED'
            );
        }
    }

    // Update monitoring to only watch networks with active channels
    async updateSmartMonitoring(activeNetworks) {
        const currentlyMonitored = new Set(this.monitoringIntervals.keys());
        
        // Stop monitoring networks that no longer have active channels
        for (const network of currentlyMonitored) {
            if (network !== 'staggered' && !activeNetworks.has(network)) {
                if (this.monitoringIntervals.has(network)) {
                    clearInterval(this.monitoringIntervals.get(network));
                    this.monitoringIntervals.delete(network);
                    Logger.info(`Stopped monitoring ${network} - no active channels`, {
                        network: network
                    });
                }
            }
        }

        // Start monitoring networks that now have active channels
        for (const network of activeNetworks) {
            if (!currentlyMonitored.has(network) && this.networks.has(network)) {
                try {
                    await this.startNetworkMonitoring(network, this.networks.get(network));
                    Logger.info(`Started monitoring ${network} - active channels detected`, {
                        network: network
                    });
                } catch (error) {
                    Logger.error(`Failed to start monitoring for ${network}`, {
                        network: network,
                        error: error.message
                    });
                }
            }
        }
    }

    // Check a specific payment channel for transactions
    async checkChannelPayment(channel) {
        const network = this.networks.get(channel.crypto_type);
        if (!network) {
            return;
        }

        try {
            let transactions = [];

            // Prevent duplicate processing
            if (channel.tx_hash && this.processedTransactions.has(channel.tx_hash)) {
                return;
            }

            // If we have a tx_hash, verify it specifically
            if (channel.tx_hash) {
                const txData = await this.getTransactionData(channel.crypto_type, channel.tx_hash);
                if (txData) {
                    transactions = [txData];
                }
            } else {
                // Look for transactions to the payment address
                transactions = await this.getAddressTransactions(
                    channel.crypto_type, 
                    channel.payment_address,
                    channel.created_at
                );
            }

            // Check transactions for matching payments
            for (const tx of transactions) {
                // Skip if already processed
                if (this.processedTransactions.has(tx.hash)) {
                    continue;
                }

                const isMatch = await this.verifyTransactionMatch(channel, tx, network);
                if (isMatch) {
                    await this.processPaymentFound(channel, tx);
                    this.processedTransactions.add(tx.hash);
                    break; // Only process the first matching transaction
                }
            }

        } catch (error) {
            Logger.error('Error checking payment for channel', { 
                channelId: channel.channel_id,
                cryptoType: channel.crypto_type,
                error: error.message 
            });
        }
    }

    // Verify if a transaction matches the payment channel requirements
    async verifyTransactionMatch(channel, transaction, network) {
        try {

            // Check minimum amount (prevent dust attacks)
            const actualAmount = parseFloat(transaction.amount);
            if (actualAmount < network.min_amount) {
                return false;
            }

            // Check amount (allow configurable tolerance for fees/slippage)
            const expectedAmount = parseFloat(channel.amount_crypto);
            const tolerance = expectedAmount * 0.05; // 5% tolerance
            
            if (actualAmount < (expectedAmount - tolerance)) {
                return false;
            }

            // Check recipient address (handle Bitcoin multiple outputs)
            let addressMatch = false;
            if (transaction.allOutputs && Array.isArray(transaction.allOutputs)) {
                // Bitcoin: check all outputs for a match
                addressMatch = transaction.allOutputs.some(output => 
                    output.address?.toLowerCase() === channel.payment_address.toLowerCase()
                );
            } else {
                // Other networks: single recipient
                addressMatch = transaction.to?.toLowerCase() === channel.payment_address.toLowerCase();
            }

            if (!addressMatch) {
                return false;
            }

            // No memo checking needed - using unique addresses instead

            // Check if transaction is after channel creation (with buffer)
            const txTime = new Date(transaction.timestamp);
            const channelTime = new Date(channel.created_at);
            const timeBuffer = 60 * 1000; // 1 minute buffer for clock skew
            
            if (txTime < (channelTime.getTime() - timeBuffer)) {
                return false;
            }

            // Check confirmations meet requirements
            const requiredConfirmations = network.confirmations_required;
            if (transaction.confirmations < requiredConfirmations) {
                // Still return true for processing, but mark as 'confirming'
            }

            // Additional security checks for double-spending prevention
            if (await this.checkForDoubleSpend(channel, transaction)) {
                Logger.error('Potential double-spend detected', {
                    channelId: channel.channel_id,
                    txHash: transaction.hash
                });
                return false;
            }

            return true;
        } catch (error) {
            Logger.error('Error verifying transaction match', {
                channelId: channel.channel_id,
                txHash: transaction.hash,
                error: error.message
            });
            return false;
        }
    }

    // Check for potential double-spending
    async checkForDoubleSpend(channel, transaction) {
        try {
            const client = await pool.connect();
            try {
                // Check if this channel already has a different confirmed transaction
                const result = await client.query(`
                    SELECT tx_hash, status 
                    FROM payment_channels 
                    WHERE channel_id = $1 
                    AND tx_hash IS NOT NULL 
                    AND tx_hash != $2 
                    AND status = 'confirmed'
                `, [channel.channel_id, transaction.hash]);

                return result.rows.length > 0;
            } finally {
                client.release();
            }
        } catch (error) {
            Logger.error('Error checking for double spend', {
                channelId: channel.channel_id,
                error: error.message
            });
            return false; // Assume no double spend if we can't check
        }
    }

    // Process a found payment
    async processPaymentFound(channel, transaction) {
        try {
            const client = await pool.connect();
            try {
                // Update payment channel with transaction info
                await client.query(`
                    UPDATE payment_channels 
                    SET tx_hash = $1, status = $2, confirmations = $3, confirmed_at = CURRENT_TIMESTAMP
                    WHERE channel_id = $4 AND status IN ('pending', 'confirming')
                `, [
                    transaction.hash,
                    transaction.confirmations >= this.networks.get(channel.crypto_type).confirmations_required ? 'confirmed' : 'confirming',
                    transaction.confirmations,
                    channel.channel_id
                ]);

                // Record the confirmation
                await client.query(`
                    INSERT INTO payment_confirmations 
                    (channel_id, tx_hash, block_height, confirmations, amount_received, detected_at)
                    VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                    ON CONFLICT (channel_id, tx_hash) DO UPDATE SET
                    confirmations = EXCLUDED.confirmations,
                    processed_at = CURRENT_TIMESTAMP
                `, [
                    channel.channel_id,
                    transaction.hash,
                    transaction.blockHeight,
                    transaction.confirmations,
                    transaction.amount
                ]);

                console.log(`💰 Payment detected for channel ${channel.channel_id}: ${transaction.amount} ${channel.crypto_type} (${transaction.confirmations} confirmations)`);

                // Notify WebSocket subscribers
                if (global.paymentMonitor) {
                    global.paymentMonitor.notifyStatusChange(channel.channel_id, 
                        transaction.confirmations >= this.networks.get(channel.crypto_type).confirmations_required ? 'confirmed' : 'confirming',
                        transaction.hash
                    );
                }

                // If fully confirmed, trigger account creation
                if (transaction.confirmations >= this.networks.get(channel.crypto_type).confirmations_required) {
                    console.log(`✅ Payment fully confirmed for channel ${channel.channel_id}, triggering account creation`);
                    
                    // Import the account service if available
                    try {
                        const { hiveAccountService } = require('./onboarding');
                        if (hiveAccountService) {
                            setImmediate(() => {
                                hiveAccountService.monitorPendingCreations();
                            });
                        }
                    } catch (importError) {
                        console.log('Could not trigger account creation automatically:', importError.message);
                    }
                }

            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error processing payment found:', error);
        }
    }

    // Get transaction data for a specific transaction hash
    async getTransactionData(cryptoType, txHash) {
        const network = this.networks.get(cryptoType);
        if (!network) return null;

        switch (cryptoType) {
            case 'BTC':
                return await this.getBitcoinTransaction(txHash);
            case 'ETH':
                return await this.getEthereumTransaction(txHash);
            case 'BNB':
                return await this.getBNBTransaction(txHash);
            case 'MATIC':
                return await this.getPolygonTransaction(txHash);
            case 'SOL':
                return await this.getSolanaTransaction(txHash);
            case 'DASH':
                return await this.getDashTransaction(txHash);
            case 'XMR':
                return await this.getMoneroTransaction(txHash);
            default:
                return null;
        }
    }

    // Get transactions for a specific address
    async getAddressTransactions(cryptoType, address, sinceTimestamp) {
        const network = this.networks.get(cryptoType);
        if (!network) return [];

        switch (cryptoType) {
            case 'BTC':
                return await this.getBitcoinAddressTransactions(address, sinceTimestamp);
            case 'ETH':
                return await this.getEthereumAddressTransactions(address, sinceTimestamp);
            case 'BNB':
                return await this.getBNBAddressTransactions(address, sinceTimestamp);
            case 'MATIC':
                return await this.getPolygonAddressTransactions(address, sinceTimestamp);
            case 'SOL':
                return await this.getSolanaAddressTransactions(address, sinceTimestamp);
            case 'DASH':
                return await this.getDashAddressTransactions(address, sinceTimestamp);
            case 'XMR':
                return await this.getMoneroAddressTransactions(address, sinceTimestamp);
            default:
                return [];
        }
    }

    // Bitcoin-specific methods
    async getBitcoinTransaction(txHash) {
        try {
            // Try Blockstream API first
            let response = await fetch(`https://blockstream.info/api/tx/${txHash}`);
            let data;
            
            if (!response.ok) {
                // Fallback to BlockCypher
                response = await fetch(`https://api.blockcypher.com/v1/btc/main/txs/${txHash}`);
                if (!response.ok) {
                    throw new TransactionNotFoundError(txHash, 'BTC');
                }
                data = await response.json();
            } else {
                data = await response.json();
            }

            // Get current block height for confirmations
            const currentHeight = await this.getCurrentBlockHeight('BTC');
            const confirmations = data.status?.block_height ? currentHeight - data.status.block_height + 1 : 0;

            // Parse Bitcoin transaction - handle multiple outputs
            const outputs = data.vout || data.outputs || [];
            
            // Extract memo from OP_RETURN if present
            let memo = null;
            const opReturnOutput = outputs.find(output => 
                output.scriptpubkey_type === 'op_return' || 
                output.script_type === 'null-data'
            );
            
            if (opReturnOutput && opReturnOutput.scriptpubkey_hex) {
                try {
                    // Decode OP_RETURN data (simplified)
                    const hex = opReturnOutput.scriptpubkey_hex.replace(/^6a/, ''); // Remove OP_RETURN opcode
                    if (hex.length >= 2) {
                        const length = parseInt(hex.substring(0, 2), 16);
                        if (length > 0 && hex.length >= (length * 2 + 2)) {
                            const memoHex = hex.substring(2, 2 + length * 2);
                            memo = Buffer.from(memoHex, 'hex').toString('utf8');
                        }
                    }
                } catch (memoError) {
                    // Could not decode OP_RETURN memo
                }
            }

            // Find all payment outputs (non-zero value, non-OP_RETURN)
            const paymentOutputs = outputs.filter(output => 
                output.value > 0 && 
                output.scriptpubkey_type !== 'op_return' &&
                output.script_type !== 'null-data'
            );

            // Return the largest output as the main payment
            const mainOutput = paymentOutputs.reduce((max, output) => 
                output.value > (max?.value || 0) ? output : max, null
            );

            if (!mainOutput) {
                throw new BlockchainMonitorError(
                    `No valid payment outputs found in transaction ${txHash}`,
                    'INVALID_TRANSACTION',
                    'BTC'
                );
            }

            return {
                hash: txHash,
                amount: mainOutput.value / 100000000, // Convert satoshis to BTC
                to: mainOutput.scriptpubkey_address || mainOutput.addresses?.[0],
                confirmations: Math.max(0, confirmations),
                blockHeight: data.status?.block_height || data.block_height,
                timestamp: data.status?.block_time ? new Date(data.status.block_time * 1000) : new Date(),
                memo: memo,
                allOutputs: paymentOutputs.map(output => ({
                    address: output.scriptpubkey_address || output.addresses?.[0],
                    amount: output.value / 100000000,
                    scriptType: output.scriptpubkey_type || output.script_type
                }))
            };
        } catch (error) {
            if (error instanceof BlockchainMonitorError) {
                throw error;
            }
            Logger.error('Error fetching Bitcoin transaction', { 
                txHash, 
                error: error.message 
            });
            throw new APIError(`Failed to fetch Bitcoin transaction ${txHash}: ${error.message}`, 'BTC');
        }
    }

    async getBitcoinAddressTransactions(address, sinceTimestamp) {
        try {
            const response = await fetch(`https://blockstream.info/api/address/${address}/txs`);
            if (!response.ok) return [];

            const transactions = await response.json();
            const since = new Date(sinceTimestamp).getTime() / 1000;

            return transactions
                .filter(tx => tx.status?.block_time && tx.status.block_time >= since)
                .map(tx => {
                    const output = tx.vout.find(out => 
                        out.scriptpubkey_address === address && out.value > 0
                    );
                    
                    return {
                        hash: tx.txid,
                        amount: output ? output.value / 100000000 : 0,
                        to: address,
                        confirmations: tx.status.confirmed ? 1 : 0, // Simplified
                        blockHeight: tx.status.block_height,
                        timestamp: new Date(tx.status.block_time * 1000),
                        memo: null
                    };
                })
                .filter(tx => tx.amount > 0);
        } catch (error) {
            console.error('Error fetching Bitcoin address transactions:', error);
            return [];
        }
    }

    // Ethereum-specific methods
    async getEthereumTransaction(txHash) {
        try {
            const apiKey = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
            const network = this.networks.get('ETH');
            const response = await fetch(
                `https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${apiKey}`
            );

            if (!response.ok) return null;
            const data = await response.json();
            const tx = data.result;

            if (!tx) return null;

            // Get receipt for confirmation status
            const receiptResponse = await fetch(
                `https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${apiKey}`
            );
            const receiptData = await receiptResponse.json();
            const receipt = receiptData.result;

            // Get current block number
            const blockResponse = await fetch(
                `https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=proxy&action=eth_blockNumber&apikey=${apiKey}`
            );
            const blockData = await blockResponse.json();
            const currentBlock = parseInt(blockData.result, 16);
            const txBlock = parseInt(tx.blockNumber, 16);
            const confirmations = currentBlock - txBlock + 1;

            return {
                hash: txHash,
                amount: parseInt(tx.value, 16) / Math.pow(10, 18), // Convert wei to ETH
                to: tx.to,
                confirmations: Math.max(0, confirmations),
                blockHeight: txBlock,
                timestamp: new Date(), // Would need additional API call for exact time
                memo: null
            };
        } catch (error) {
            console.error('Error fetching Ethereum transaction:', error);
            return null;
        }
    }

    async getEthereumAddressTransactions(address, sinceTimestamp) {
        try {
            const apiKey = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
            const network = this.networks.get('ETH');
            const startBlock = Math.floor(Date.now() / 1000 - 24 * 60 * 60) / 12; // Rough estimate
            
            const response = await fetch(
                `https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=account&action=txlist&address=${address}&startblock=${Math.floor(startBlock)}&endblock=latest&sort=desc&apikey=${apiKey}`
            );

            if (!response.ok) return [];
            const data = await response.json();
            
            return (data.result || [])
                .filter(tx => tx.to?.toLowerCase() === address.toLowerCase())
                .filter(tx => parseInt(tx.timeStamp) >= Math.floor(new Date(sinceTimestamp).getTime() / 1000))
                .map(tx => ({
                    hash: tx.hash,
                    amount: parseInt(tx.value) / Math.pow(10, 18),
                    to: tx.to,
                    confirmations: 1, // Simplified
                    blockHeight: parseInt(tx.blockNumber),
                    timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                    memo: null
                }));
        } catch (error) {
            console.error('Error fetching Ethereum address transactions:', error);
            return [];
        }
    }

    // BNB Smart Chain methods (using V2 API)
    async getBNBTransaction(txHash) {
        try {
            const apiKey = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
            const network = this.networks.get('BNB');
            const response = await fetch(
                `https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${apiKey}`
            );

            // Similar to Ethereum implementation
            return await this.parseEVMTransaction(response, txHash, 18);
        } catch (error) {
            console.error('Error fetching BNB transaction:', error);
            return null;
        }
    }

    async getBNBAddressTransactions(address, sinceTimestamp) {
        try {
            const apiKey = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
            const network = this.networks.get('BNB');
            const response = await fetch(
                `https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`
            );

            return await this.parseEVMAddressTransactions(response, address, sinceTimestamp, 18);
        } catch (error) {
            console.error('Error fetching BNB address transactions:', error);
            return [];
        }
    }

    // Polygon methods (using V2 API)
    async getPolygonTransaction(txHash) {
        try {
            const apiKey = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
            const network = this.networks.get('MATIC');
            const response = await fetch(
                `https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${apiKey}`
            );

            return await this.parseEVMTransaction(response, txHash, 18);
        } catch (error) {
            console.error('Error fetching Polygon transaction:', error);
            return null;
        }
    }

    async getPolygonAddressTransactions(address, sinceTimestamp) {
        try {
            const apiKey = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
            const network = this.networks.get('MATIC');
            const response = await fetch(
                `https://api.etherscan.io/v2/api?chainid=${network.chainId}&module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`
            );

            return await this.parseEVMAddressTransactions(response, address, sinceTimestamp, 18);
        } catch (error) {
            console.error('Error fetching Polygon address transactions:', error);
            return [];
        }
    }

    // Solana methods
    async getSolanaTransaction(txHash) {
        try {
            const response = await fetch('https://api.mainnet-beta.solana.com', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getTransaction',
                    params: [txHash, { encoding: 'json', maxSupportedTransactionVersion: 0 }]
                })
            });

            const data = await response.json();
            const tx = data.result;

            if (!tx || !tx.meta) {
                Logger.warn('Solana transaction not found or invalid', { txHash });
                return null;
            }

            // Find the recipient by looking for the largest positive balance change
            const accountKeys = tx.transaction.message.accountKeys;
            let maxBalanceChange = 0;
            let recipientAddress = null;
            let recipientIndex = -1;

            for (let i = 0; i < accountKeys.length; i++) {
                const preBalance = tx.meta.preBalances[i] || 0;
                const postBalance = tx.meta.postBalances[i] || 0;
                const balanceChange = postBalance - preBalance;

                if (balanceChange > maxBalanceChange) {
                    maxBalanceChange = balanceChange;
                    recipientAddress = accountKeys[i];
                    recipientIndex = i;
                }
            }

            if (maxBalanceChange <= 0) {
                Logger.warn('No positive balance change found in Solana transaction', { txHash });
                return null;
            }

            const transaction = {
                hash: txHash,
                amount: maxBalanceChange / Math.pow(10, 9), // Convert lamports to SOL
                to: recipientAddress,
                confirmations: tx.meta.confirmationStatus === 'finalized' ? 1 : 0,
                blockHeight: tx.slot,
                timestamp: new Date((tx.blockTime || Math.floor(Date.now() / 1000)) * 1000),
                memo: null, // Could parse memo program if needed
                lamports: maxBalanceChange, // Keep original lamports for precision
                fee: (tx.meta.fee || 0) / Math.pow(10, 9) // Transaction fee in SOL
            };

            Logger.info('Parsed Solana transaction', { 
                hash: txHash,
                amount: transaction.amount,
                to: recipientAddress,
                lamports: maxBalanceChange
            });

            return transaction;

        } catch (error) {
            Logger.error('Error fetching Solana transaction', { 
                txHash,
                error: error.message 
            });
            return null;
        }
    }

    async getSolanaAddressTransactions(address, sinceTimestamp) {
        try {
            // Get signatures for the address
            const response = await fetch('https://api.mainnet-beta.solana.com', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getSignaturesForAddress',
                    params: [address, { limit: 50 }]
                })
            });

            const data = await response.json();
            const signatures = data.result || [];

            if (signatures.length === 0) {
                Logger.info('No signatures found for Solana address', { address });
                return [];
            }

            Logger.info(`Found ${signatures.length} signatures for Solana address`, { address });

            // Fetch details for each transaction signature
            const transactions = [];
            const sinceTime = Math.floor(new Date(sinceTimestamp).getTime() / 1000);

            for (const sig of signatures.slice(0, 20)) { // Limit to 20 recent transactions
                try {
                    if (sig.blockTime && sig.blockTime < sinceTime) {
                        continue; // Skip transactions older than since timestamp
                    }

                    const txResponse = await fetch('https://api.mainnet-beta.solana.com', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'getTransaction',
                            params: [sig.signature, { 
                                encoding: 'json',
                                maxSupportedTransactionVersion: 0 
                            }]
                        })
                    });

                    const txData = await txResponse.json();
                    const tx = txData.result;

                    if (!tx || !tx.meta) {
                        continue;
                    }

                    // Parse transaction to find transfers to our address
                    const accountKeys = tx.transaction.message.accountKeys;
                    const addressIndex = accountKeys.findIndex(key => key === address);
                    
                    if (addressIndex === -1) {
                        continue; // Address not involved in this transaction
                    }

                    // Calculate balance change for our address
                    const preBalance = tx.meta.preBalances[addressIndex] || 0;
                    const postBalance = tx.meta.postBalances[addressIndex] || 0;
                    const balanceChange = postBalance - preBalance;

                    // Only consider incoming transactions (positive balance change)
                    if (balanceChange > 0) {
                        const transaction = {
                            hash: sig.signature,
                            amount: balanceChange / Math.pow(10, 9), // Convert lamports to SOL
                            to: address,
                            confirmations: sig.confirmationStatus === 'finalized' ? 1 : 0,
                            blockHeight: tx.slot,
                            timestamp: new Date((sig.blockTime || Math.floor(Date.now() / 1000)) * 1000),
                            memo: null, // Could parse memo program if needed
                            lamports: balanceChange // Keep original lamports for precision
                        };

                        transactions.push(transaction);
                        Logger.info('Found Solana transaction', { 
                            hash: transaction.hash, 
                            amount: transaction.amount,
                            lamports: balanceChange,
                            address
                        });
                    }

                    // Add small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));

                } catch (txError) {
                    Logger.warn('Error fetching Solana transaction details', { 
                        signature: sig.signature,
                        error: txError.message 
                    });
                    continue;
                }
            }

            return transactions;

        } catch (error) {
            Logger.error('Error fetching Solana address transactions', { 
                address,
                error: error.message 
            });
            return [];
        }
    }

    // Helper method for EVM-based transactions
    async parseEVMTransaction(response, txHash, decimals) {
        if (!response.ok) return null;
        
        const data = await response.json();
        const tx = data.result;
        
        if (!tx) return null;

        return {
            hash: txHash,
            amount: parseInt(tx.value, 16) / Math.pow(10, decimals),
            to: tx.to,
            confirmations: 1, // Simplified - would need additional API calls
            blockHeight: parseInt(tx.blockNumber, 16),
            timestamp: new Date(),
            memo: null
        };
    }

    // Helper method for EVM-based address transactions
    async parseEVMAddressTransactions(response, address, sinceTimestamp, decimals) {
        if (!response.ok) return [];
        
        const data = await response.json();
        return (data.result || [])
            .filter(tx => tx.to?.toLowerCase() === address.toLowerCase())
            .filter(tx => parseInt(tx.timeStamp) >= Math.floor(new Date(sinceTimestamp).getTime() / 1000))
            .map(tx => ({
                hash: tx.hash,
                amount: parseInt(tx.value) / Math.pow(10, decimals),
                to: tx.to,
                confirmations: 1,
                blockHeight: parseInt(tx.blockNumber),
                timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                memo: null
            }));
    }

    // Verify a specific transaction hash against a payment channel
    async verifyTransactionHash(channelId, txHash) {
        try {
            const client = await pool.connect();
            try {
                const result = await client.query(
                    'SELECT * FROM payment_channels WHERE channel_id = $1',
                    [channelId]
                );

                if (result.rows.length === 0) {
                    return { success: false, error: 'Channel not found' };
                }

                const channel = result.rows[0];
                const network = this.networks.get(channel.crypto_type);
                
                if (!network) {
                    return { success: false, error: 'Network not supported' };
                }

                const txData = await this.getTransactionData(channel.crypto_type, txHash);
                
                if (!txData) {
                    return { success: false, error: 'Transaction not found on blockchain' };
                }

                const isValid = await this.verifyTransactionMatch(channel, txData, network);
                
                if (!isValid) {
                    return { success: false, error: 'Transaction does not match payment requirements' };
                }

                // Update channel with verified transaction
                await this.processPaymentFound(channel, txData);

                return { 
                    success: true, 
                    transaction: txData,
                    channel: channel.channel_id 
                };

            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error verifying transaction hash:', error);
            return { success: false, error: 'Verification failed' };
        }
    }

    // Public method to manually verify a transaction
    async manualVerifyTransaction(channelId, txHash) {
        return await this.verifyTransactionHash(channelId, txHash);
    }

    // DASH methods (using Insight API)
    async getDashTransaction(txHash) {
        try {
            // Try multiple Dash Insight APIs
            const apis = [
                `https://insight.dash.org/insight-api/tx/${txHash}`,
                `https://explorer.dash.org/insight-api/tx/${txHash}`
            ];

            for (const apiUrl of apis) {
                try {
                    const response = await fetch(apiUrl);
                    if (!response.ok) continue;

                    const data = await response.json();
                    
                    // Parse Dash transaction (similar to Bitcoin structure)
                    const outputs = data.vout || [];
                    const totalOutput = outputs.reduce((sum, output) => sum + (output.value || 0), 0);
                    
                    return {
                        hash: txHash,
                        amount: totalOutput,
                        to: outputs[0]?.scriptPubKey?.addresses?.[0] || null,
                        allOutputs: outputs.map(output => ({
                            address: output.scriptPubKey?.addresses?.[0],
                            amount: output.value
                        })),
                        confirmations: data.confirmations || 0,
                        blockHeight: data.blockheight,
                        timestamp: new Date(data.time * 1000),
                        memo: null, // Dash doesn't typically use memos
                        fees: data.fees || 0
                    };
                } catch (apiError) {
                    console.warn(`Failed to fetch from ${apiUrl}:`, apiError.message);
                    continue;
                }
            }
            
            console.warn('All Dash APIs failed for transaction:', txHash);
            return null;
        } catch (error) {
            console.error('Error fetching DASH transaction:', error);
            return null;
        }
    }

    async getDashAddressTransactions(address, sinceTimestamp) {
        try {
            // Try multiple Dash APIs for address transactions
            const apis = [
                `https://insight.dash.org/insight-api/addr/${address}/txs`,
                `https://explorer.dash.org/insight-api/addr/${address}/txs`
            ];

            for (const apiUrl of apis) {
                try {
                    const response = await fetch(apiUrl);
                    if (!response.ok) continue;

                    const data = await response.json();
                    const transactions = data.txs || data || [];
                    
                    return transactions
                        .filter(tx => new Date(tx.time * 1000) >= new Date(sinceTimestamp))
                        .map(tx => ({
                            hash: tx.txid,
                            amount: tx.vout?.reduce((sum, output) => 
                                output.scriptPubKey?.addresses?.includes(address) ? sum + output.value : sum, 0) || 0,
                            to: address,
                            confirmations: tx.confirmations || 0,
                            blockHeight: tx.blockheight,
                            timestamp: new Date(tx.time * 1000),
                            memo: null
                        }));
                } catch (apiError) {
                    console.warn(`Failed to fetch from ${apiUrl}:`, apiError.message);
                    continue;
                }
            }
            
            console.warn('All Dash APIs failed for address:', address);
            return [];
        } catch (error) {
            console.error('Error fetching DASH address transactions:', error);
            return [];
        }
    }

    // Monero methods
    async getMoneroTransaction(txHash) {
        try {
            // Try public Monero block explorers
            const apis = [
                `https://xmrchain.net/api/transaction/${txHash}`,
                `https://moneroblocks.info/api/get_tx_info/${txHash}`
            ];

            for (const apiUrl of apis) {
                try {
                    const response = await fetch(apiUrl);
                    if (!response.ok) continue;

                    const data = await response.json();
                    
                    return {
                        hash: txHash,
                        amount: data.total_output || data.amount || 0,
                        to: null, // Monero doesn't expose recipient addresses
                        confirmations: data.confirmations || 0,
                        blockHeight: data.block_height || data.height,
                        timestamp: new Date((data.timestamp || data.block_timestamp) * 1000),
                        memo: null,
                        fees: data.tx_fee || data.fee || 0,
                        ring_size: data.ring_size || 16,
                        outputs: data.outputs?.length || 0
                    };
                } catch (apiError) {
                    console.warn(`Failed to fetch from ${apiUrl}:`, apiError.message);
                    continue;
                }
            }
            
            console.warn('All Monero APIs failed for transaction:', txHash);
            return null;
        } catch (error) {
            console.error('Error fetching Monero transaction:', error);
            return null;
        }
    }

    async getMoneroAddressTransactions(address, sinceTimestamp) {
        try {
            // Note: Monero address transaction lookup is very limited due to privacy features
            // Most public APIs cannot track specific addresses due to ring signatures
            console.info('Monero address monitoring limited due to privacy features');
            
            // Try to get some basic info if available
            const apis = [
                `https://xmrchain.net/api/outputs?address=${address}&limit=10`,
                `https://moneroblocks.info/api/get_address_info/${address}`
            ];

            for (const apiUrl of apis) {
                try {
                    const response = await fetch(apiUrl);
                    if (!response.ok) continue;

                    const data = await response.json();
                    
                    // Very limited data available due to privacy
                    return (data.outputs || []).map(output => ({
                        hash: output.tx_hash || 'unknown',
                        amount: output.amount || 0,
                        to: address,
                        confirmations: 10, // Assume confirmed if in explorer
                        blockHeight: output.block_height || 0,
                        timestamp: new Date((output.timestamp || Date.now()/1000) * 1000),
                        memo: null,
                        privacy_note: 'Limited data due to Monero privacy features'
                    }));
                } catch (apiError) {
                    console.warn(`Failed to fetch from ${apiUrl}:`, apiError.message);
                    continue;
                }
            }
            
            return [];
        } catch (error) {
            console.error('Error fetching Monero address transactions:', error);
            return [];
        }
    }

    // Get monitoring status
    getStatus() {
        return {
            isRunning: this.isRunning,
            networks: Array.from(this.networks.keys()),
            activeMonitors: this.monitoringIntervals.size,
            lastBlockChecked: Object.fromEntries(this.lastBlockChecked),
            configuration: this.configurationStatus,
            uptime: this.isRunning ? Date.now() - (this.startTime || Date.now()) : 0
        };
    }
}

// Export singleton instance
module.exports = new BlockchainMonitoringService(); 