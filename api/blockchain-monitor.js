const fetch = require('node-fetch');
const { pool } = require('../index');

// Blockchain monitoring service for crypto payments
class BlockchainMonitoringService {
    constructor() {
        this.monitoringIntervals = new Map();
        this.isRunning = false;
        this.networks = new Map();
        this.lastBlockChecked = new Map();
        
        this.initializeNetworks();
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
            min_amount: 0.00001 // Minimum amount to consider (in BTC)
        });

        this.networks.set('ETH', {
            name: 'Ethereum',
            type: 'account',
            apis: [
                'https://api.etherscan.io/api',
                'https://eth-mainnet.alchemyapi.io/v2/' + (process.env.ALCHEMY_API_KEY || 'demo')
            ],
            confirmations_required: 2,
            block_time: 12,
            decimals: 18,
            min_amount: 0.0001 // Minimum amount to consider (in ETH)
        });

        this.networks.set('BNB', {
            name: 'BNB Smart Chain',
            type: 'account',
            apis: [
                'https://api.bscscan.com/api',
                'https://bsc-dataseed.binance.org'
            ],
            confirmations_required: 3,
            block_time: 3,
            decimals: 18,
            min_amount: 0.001 // Minimum amount to consider (in BNB)
        });

        this.networks.set('MATIC', {
            name: 'Polygon',
            type: 'account',
            apis: [
                'https://api.polygonscan.com/api',
                'https://polygon-rpc.com'
            ],
            confirmations_required: 10,
            block_time: 2,
            decimals: 18,
            min_amount: 0.01 // Minimum amount to consider (in MATIC)
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
            min_amount: 0.001 // Minimum amount to consider (in SOL)
        });
    }

    // Start monitoring all active payment channels
    async startMonitoring() {
        if (this.isRunning) {
            console.log('Blockchain monitoring already running');
            return;
        }

        this.isRunning = true;
        console.log('🔍 Starting blockchain monitoring service...');

        // Monitor each network
        for (const [symbol, network] of this.networks) {
            this.startNetworkMonitoring(symbol, network);
        }

        // Global monitoring loop for payment channels
        this.globalMonitoringInterval = setInterval(async () => {
            await this.monitorActiveChannels();
        }, 30000); // Check every 30 seconds

        console.log('✅ Blockchain monitoring service started');
    }

    // Stop all monitoring
    stopMonitoring() {
        this.isRunning = false;
        
        // Clear all network monitoring intervals
        for (const interval of this.monitoringIntervals.values()) {
            clearInterval(interval);
        }
        this.monitoringIntervals.clear();

        if (this.globalMonitoringInterval) {
            clearInterval(this.globalMonitoringInterval);
        }

        console.log('🛑 Blockchain monitoring service stopped');
    }

    // Start monitoring for a specific network
    startNetworkMonitoring(symbol, network) {
        const interval = setInterval(async () => {
            try {
                await this.checkNetworkForPayments(symbol, network);
            } catch (error) {
                console.error(`Error monitoring ${symbol} network:`, error);
            }
        }, network.block_time * 1000); // Check based on block time

        this.monitoringIntervals.set(symbol, interval);
        console.log(`📡 Started monitoring ${network.name} (${symbol}) - checking every ${network.block_time}s`);
    }

    // Check specific network for new blocks/transactions
    async checkNetworkForPayments(symbol, network) {
        try {
            // This method can be used to check for new blocks
            // and scan for transactions to our monitored addresses
            // For now, the main monitoring happens in monitorActiveChannels()
            
            // You could implement block-by-block scanning here
            // to catch payments even before they're reported via WebSocket
            console.log(`Checking ${symbol} network for new payments...`);
            
            // Store the last checked block for more efficient scanning
            const currentBlock = await this.getCurrentBlockHeight(symbol);
            if (currentBlock) {
                this.lastBlockChecked.set(symbol, currentBlock);
            }
        } catch (error) {
            console.error(`Error checking ${symbol} network:`, error);
        }
    }

    // Get current block height for a network
    async getCurrentBlockHeight(symbol) {
        try {
            switch (symbol) {
                case 'BTC':
                    const btcResponse = await fetch('https://blockstream.info/api/blocks/tip/height');
                    return await btcResponse.text();
                case 'ETH':
                    const ethResponse = await fetch(`https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken'}`);
                    const ethData = await ethResponse.json();
                    return parseInt(ethData.result, 16);
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
                    const solData = await solResponse.json();
                    return solData.result;
                default:
                    return null;
            }
        } catch (error) {
            console.error(`Error getting current block height for ${symbol}:`, error);
            return null;
        }
    }

    // Monitor all active payment channels
    async monitorActiveChannels() {
        try {
            const client = await pool.connect();
            try {
                // Get all pending and confirming channels
                const result = await client.query(`
                    SELECT channel_id, crypto_type, payment_address, amount_crypto, memo, tx_hash, confirmations, created_at
                    FROM payment_channels 
                    WHERE status IN ('pending', 'confirming') 
                    AND expires_at > NOW()
                    ORDER BY created_at ASC
                `);

                for (const channel of result.rows) {
                    await this.checkChannelPayment(channel);
                }
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error monitoring active channels:', error);
        }
    }

    // Check a specific payment channel for transactions
    async checkChannelPayment(channel) {
        const network = this.networks.get(channel.crypto_type);
        if (!network) {
            console.log(`Network not supported for monitoring: ${channel.crypto_type}`);
            return;
        }

        try {
            let transactions = [];

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
                const isMatch = await this.verifyTransactionMatch(channel, tx, network);
                if (isMatch) {
                    await this.processPaymentFound(channel, tx);
                    break; // Only process the first matching transaction
                }
            }

        } catch (error) {
            console.error(`Error checking payment for channel ${channel.channel_id}:`, error);
        }
    }

    // Verify if a transaction matches the payment channel requirements
    async verifyTransactionMatch(channel, transaction, network) {
        try {
            // Check amount (allow 5% tolerance for fees/slippage)
            const expectedAmount = parseFloat(channel.amount_crypto);
            const actualAmount = parseFloat(transaction.amount);
            const tolerance = expectedAmount * 0.05; // 5% tolerance
            
            if (actualAmount < (expectedAmount - tolerance)) {
                console.log(`Amount mismatch: expected ${expectedAmount}, got ${actualAmount}`);
                return false;
            }

            // Check recipient address
            if (transaction.to?.toLowerCase() !== channel.payment_address.toLowerCase()) {
                console.log(`Address mismatch: expected ${channel.payment_address}, got ${transaction.to}`);
                return false;
            }

            // For UTXO-based cryptocurrencies, check memo/note if applicable
            if (channel.memo && transaction.memo) {
                if (transaction.memo !== channel.memo) {
                    console.log(`Memo mismatch: expected ${channel.memo}, got ${transaction.memo}`);
                    return false;
                }
            }

            // Check if transaction is after channel creation
            const txTime = new Date(transaction.timestamp);
            const channelTime = new Date(channel.created_at);
            if (txTime < channelTime) {
                console.log(`Transaction predates channel creation`);
                return false;
            }

            return true;
        } catch (error) {
            console.error('Error verifying transaction match:', error);
            return false;
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
            default:
                return [];
        }
    }

    // Bitcoin-specific methods
    async getBitcoinTransaction(txHash) {
        try {
            // Try Blockstream API first
            let response = await fetch(`https://blockstream.info/api/tx/${txHash}`);
            if (!response.ok) {
                // Fallback to BlockCypher
                response = await fetch(`https://api.blockcypher.com/v1/btc/main/txs/${txHash}`);
            }

            if (!response.ok) return null;
            const data = await response.json();

            // Get current block height for confirmations
            const blockHeightResponse = await fetch('https://blockstream.info/api/blocks/tip/height');
            const currentHeight = await blockHeightResponse.text();
            const confirmations = data.status?.block_height ? parseInt(currentHeight) - data.status.block_height + 1 : 0;

            // Parse Bitcoin transaction
            const outputs = data.vout || data.outputs || [];
            const mainOutput = outputs.find(output => output.value > 0);

            return {
                hash: txHash,
                amount: mainOutput ? mainOutput.value / 100000000 : 0, // Convert satoshis to BTC
                to: mainOutput ? mainOutput.scriptpubkey_address || mainOutput.addresses?.[0] : null,
                confirmations: confirmations,
                blockHeight: data.status?.block_height || data.block_height,
                timestamp: data.status?.block_time ? new Date(data.status.block_time * 1000) : new Date(),
                memo: null // Bitcoin doesn't have memos in standard transactions
            };
        } catch (error) {
            console.error('Error fetching Bitcoin transaction:', error);
            return null;
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
            const response = await fetch(
                `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${apiKey}`
            );

            if (!response.ok) return null;
            const data = await response.json();
            const tx = data.result;

            if (!tx) return null;

            // Get receipt for confirmation status
            const receiptResponse = await fetch(
                `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${apiKey}`
            );
            const receiptData = await receiptResponse.json();
            const receipt = receiptData.result;

            // Get current block number
            const blockResponse = await fetch(
                `https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${apiKey}`
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
            const startBlock = Math.floor(Date.now() / 1000 - 24 * 60 * 60) / 12; // Rough estimate
            
            const response = await fetch(
                `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=${Math.floor(startBlock)}&endblock=latest&sort=desc&apikey=${apiKey}`
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

    // BNB Smart Chain methods (similar to Ethereum)
    async getBNBTransaction(txHash) {
        try {
            const apiKey = process.env.BSCSCAN_API_KEY || 'YourApiKeyToken';
            const response = await fetch(
                `https://api.bscscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${apiKey}`
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
            const apiKey = process.env.BSCSCAN_API_KEY || 'YourApiKeyToken';
            const response = await fetch(
                `https://api.bscscan.com/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`
            );

            return await this.parseEVMAddressTransactions(response, address, sinceTimestamp, 18);
        } catch (error) {
            console.error('Error fetching BNB address transactions:', error);
            return [];
        }
    }

    // Polygon methods (similar to Ethereum)
    async getPolygonTransaction(txHash) {
        try {
            const apiKey = process.env.POLYGONSCAN_API_KEY || 'YourApiKeyToken';
            const response = await fetch(
                `https://api.polygonscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${apiKey}`
            );

            return await this.parseEVMTransaction(response, txHash, 18);
        } catch (error) {
            console.error('Error fetching Polygon transaction:', error);
            return null;
        }
    }

    async getPolygonAddressTransactions(address, sinceTimestamp) {
        try {
            const apiKey = process.env.POLYGONSCAN_API_KEY || 'YourApiKeyToken';
            const response = await fetch(
                `https://api.polygonscan.com/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`
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

            if (!tx) return null;

            // Parse Solana transaction (simplified)
            const amount = tx.meta?.postBalances?.[1] - tx.meta?.preBalances?.[1] || 0;
            
            return {
                hash: txHash,
                amount: amount / Math.pow(10, 9), // Convert lamports to SOL
                to: tx.transaction?.message?.accountKeys?.[1] || null,
                confirmations: tx.slot ? 1 : 0, // Simplified
                blockHeight: tx.slot,
                timestamp: new Date(tx.blockTime * 1000),
                memo: null // Would need to parse memo program
            };
        } catch (error) {
            console.error('Error fetching Solana transaction:', error);
            return null;
        }
    }

    async getSolanaAddressTransactions(address, sinceTimestamp) {
        try {
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

            // Would need to fetch each transaction individually for full details
            // This is a simplified implementation
            return [];
        } catch (error) {
            console.error('Error fetching Solana address transactions:', error);
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

    // Get monitoring status
    getStatus() {
        return {
            isRunning: this.isRunning,
            networks: Array.from(this.networks.keys()),
            activeMonitors: this.monitoringIntervals.size,
            lastBlockChecked: Object.fromEntries(this.lastBlockChecked)
        };
    }
}

// Export singleton instance
module.exports = new BlockchainMonitoringService(); 