const hive = require('@hiveio/hive-js');
const { pool } = require('./index');

class HiveMonitor {
    constructor() {
        this.client = hive;
        this.client.api.setOptions({ url: 'https://hive-api.dlux.io' });
        this.lastProcessedBlock = 0;
        this.isRunning = false;
        this.operationHandlers = new Map();
        this.hasListeners = false;
        this.retryDelay = 3000; // Increased initial retry delay in ms
        this.maxRetryDelay = 30000; // Increased maximum retry delay in ms
        this.apiHealth = {
            status: 'healthy',
            lastError: null,
            errorCount: 0,
            lastSuccess: Date.now(),
            consecutiveErrors: 0
        };
        // State for tracking transactions for read notifications
        this.pendingReadTransactions = new Map(); // txid -> { username, timestamp, data }
        this.readTransactionResolvers = new Map(); // txid -> { resolve, reject, timeout }
    }

    async initialize() {
        try {
            // Get the last processed block from database
            const result = await pool.query('SELECT last_block FROM hive_state WHERE id = 1');
            if (result.rows.length > 0) {
                this.lastProcessedBlock = result.rows[0].last_block > 96726250 ? result.rows[0].last_block : 96726250;
            } else {
                // Initialize state with specific block number
                const initialBlock = 96726250;
                await pool.query('INSERT INTO hive_state (id, last_block) VALUES (1, $1)', [initialBlock]);
                this.lastProcessedBlock = initialBlock;
                console.log(`Initialized Hive monitor starting at block ${initialBlock}`);
            }
        } catch (error) {
            console.error('Failed to initialize Hive monitor:', error);
            throw error;
        }
    }

    async start() {
        if (this.isRunning || !this.hasListeners) return;
        this.isRunning = true;
        this.retryDelay = 3000; // Reset retry delay on start
        
        try {
            await this.initialize();
            await this.processBlocks();
        } catch (error) {
            console.error('Error in Hive monitor:', error);
            this.isRunning = false;
        }
    }

    async safeApiCall(method, ...args) {
        try {
            const result = await method.apply(this.client.api, args);
            
            // Validate response
            if (result === null || result === undefined) {
                throw new Error('API returned null or undefined response');
            }

            // Reset error counters on success
            this.apiHealth.consecutiveErrors = 0;
            this.apiHealth.status = 'healthy';
            this.apiHealth.lastSuccess = Date.now();
            
            return result;
        } catch (error) {
            this.apiHealth.consecutiveErrors++;
            this.apiHealth.lastError = error;
            
            // Handle specific error types
            if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                this.apiHealth.status = 'rate_limited';
                // Increase delay more aggressively for consecutive rate limits
                this.retryDelay = Math.min(this.retryDelay * 1.5, this.maxRetryDelay);
                console.warn(`Rate limit hit, waiting ${this.retryDelay}ms (consecutive errors: ${this.apiHealth.consecutiveErrors})`);
            } else if (error.message.includes('JSON')) {
                this.apiHealth.status = 'parse_error';
                console.error('JSON parsing error:', error);
            } else {
                this.apiHealth.status = 'error';
                console.error('API error:', error);
            }
            
            throw error;
        }
    }

    async processBlocks() {
        while (this.isRunning && this.hasListeners) {
            try {
                const currentBlock = await this.safeApiCall(this.client.api.getDynamicGlobalPropertiesAsync);
                const headBlock = currentBlock.head_block_number;

                if (this.lastProcessedBlock < headBlock) {
                    // Process blocks in smaller batches when having issues
                    const batchSize = this.apiHealth.consecutiveErrors > 0 ? 20 : 100;
                    const endBlock = Math.min(this.lastProcessedBlock + batchSize, headBlock);

                    for (let blockNum = this.lastProcessedBlock + 1; blockNum <= endBlock; blockNum++) {
                        try {
                            const block = await this.safeApiCall(this.client.api.getBlockAsync, blockNum);
                            
                            if (!block || !block.transactions) {
                                console.warn(`Invalid block data received for block ${blockNum}`);
                                continue;
                            }

                            await this.processBlock(block);
                            this.lastProcessedBlock = blockNum;
                            
                            // Update last processed block in database
                            await pool.query('UPDATE hive_state SET last_block = $1 WHERE id = 1', [blockNum]);
                            
                            // Enhanced logging every 100 blocks or on first block
                            if (blockNum % 100 === 0 || blockNum === this.lastProcessedBlock) {
                                console.log(`✓ Processed block ${blockNum} (${headBlock - blockNum} blocks behind)`);
                            }
                            
                            // Reset retry delay on success
                            this.retryDelay = 5000;
                            this.apiHealth.errorCount = 0;
                        } catch (error) {
                            if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                                break; // Break the loop to retry the current block
                            } else {
                                console.error(`Error processing block ${blockNum}:`, error);
                                this.apiHealth.errorCount++;
                                
                                // If we have too many consecutive errors, take a longer break
                                if (this.apiHealth.consecutiveErrors > 5) {
                                    console.warn('Too many consecutive errors, taking a longer break');
                                    await new Promise(resolve => setTimeout(resolve, this.maxRetryDelay));
                                    this.apiHealth.consecutiveErrors = 0;
                                }
                            }
                        }
                    }
                }

                // Adaptive delay based on API health
                const delay = this.apiHealth.status === 'healthy' ? 1000 : this.retryDelay;
                await new Promise(resolve => setTimeout(resolve, delay));

                // Clean up old transactions periodically
                if (Date.now() % 60000 < delay) { // Approximately every minute
                    this.cleanupOldTransactions();
                }
            } catch (error) {
                console.error('Error processing blocks:', error);
                this.apiHealth.errorCount++;
                
                // Wait longer on error before retrying
                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
            }
        }
    }

    async processBlock(block) {
        if (!block || !block.transactions) return;

        for (const tx of block.transactions) {
            const txId = tx.transaction_id;
            
            // Process regular operations
            for (const op of tx.operations) {
                const [opType, opData] = op;
                const handler = this.operationHandlers.get(opType);
                if (handler) {
                    try {
                        await handler(opData, block, txId);
                    } catch (error) {
                        console.error(`Error processing operation ${opType}:`, error);
                    }
                }
            }

            // Process virtual operations if they exist
            if (tx.virtual_operations) {
                for (const vop of tx.virtual_operations) {
                    const [vopType, vopData] = vop;
                    const handler = this.operationHandlers.get(`virtual_${vopType}`);
                    if (handler) {
                        try {
                            await handler(vopData, block, txId);
                        } catch (error) {
                            console.error(`Error processing virtual operation ${vopType}:`, error);
                        }
                    }
                }
            }
        }
    }

    registerOperationHandler(operationType, handler) {
        this.operationHandlers.set(operationType, handler);
        this.hasListeners = true;
        // Start processing if not already running
        if (!this.isRunning) {
            this.start();
        }
    }

    removeOperationHandler(operationType) {
        this.operationHandlers.delete(operationType);
        this.hasListeners = this.operationHandlers.size > 0;
        // Stop processing if no more listeners
        if (!this.hasListeners) {
            this.stop();
        }
    }

    async stop() {
        this.isRunning = false;
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            lastProcessedBlock: this.lastProcessedBlock,
            activeListeners: this.operationHandlers.size,
            apiHealth: this.apiHealth,
            retryDelay: this.retryDelay,
            pendingReadTransactions: this.pendingReadTransactions.size,
            readTransactionResolvers: this.readTransactionResolvers.size
        };
    }

    // Add method to wait for a specific transaction to be processed
    waitForReadTransaction(txId, timeout = 120000) {
        return new Promise((resolve, reject) => {
            // Check if transaction is already processed
            if (this.pendingReadTransactions.has(txId)) {
                const txData = this.pendingReadTransactions.get(txId);
                this.pendingReadTransactions.delete(txId);
                resolve(txData);
                return;
            }

            // Set up timeout
            const timeoutId = setTimeout(() => {
                if (this.readTransactionResolvers.has(txId)) {
                    this.readTransactionResolvers.delete(txId);
                    reject(new Error(`Transaction ${txId} not found within timeout period`));
                }
            }, timeout);

            // Store resolver for when transaction is found
            this.readTransactionResolvers.set(txId, {
                resolve,
                reject,
                timeout: timeoutId
            });
        });
    }

    // Method to process a found read transaction
    processFoundReadTransaction(txId, username, data) {
        // Check if someone is waiting for this transaction
        if (this.readTransactionResolvers.has(txId)) {
            const resolver = this.readTransactionResolvers.get(txId);
            clearTimeout(resolver.timeout);
            this.readTransactionResolvers.delete(txId);
            resolver.resolve({ username, data, txId });
        } else {
            // Store for future API calls
            this.pendingReadTransactions.set(txId, {
                username,
                data,
                timestamp: Date.now()
            });
        }
    }

    // Clean up old pending transactions (older than 5 minutes)
    cleanupOldTransactions() {
        const now = Date.now();
        const maxAge = 5 * 60 * 1000; // 5 minutes
        
        for (const [txId, txData] of this.pendingReadTransactions.entries()) {
            if (now - txData.timestamp > maxAge) {
                this.pendingReadTransactions.delete(txId);
            }
        }
    }
}

const hiveMonitor = new HiveMonitor();

// Register handler for custom JSON operation
hiveMonitor.registerOperationHandler('custom_json', async (opData, block, txId) => {
    const { required_auths, required_posting_auths, id, json } = opData;
    
    // Check if this is our notification operation
    if (id === 'notify') {
        try {
            const account = required_posting_auths[0] || required_auths[0];
            let parsedJson;
            try {
                parsedJson = JSON.parse(json);
            } catch (error) {
                console.error('Error parsing notification JSON:', error, json);
                return;
            }
            
            const [action, data] = parsedJson;
            
            if (action === 'setLastRead' && data.date) {
                // Store transaction for API processing instead of directly updating database
                console.log(`Found setLastRead transaction ${txId} for user ${account}`);
                hiveMonitor.processFoundReadTransaction(txId, account, {
                    action,
                    data,
                    blockNum: block.block_num || block.block_id,
                    timestamp: block.timestamp
                });
            }
        } catch (error) {
            console.error('Error processing notification custom_json:', error);
        }
    }
});

// Register handler for comment operations to capture dApp posts
hiveMonitor.registerOperationHandler('comment', async (opData, block, txId) => {
    try {
        const { author, permlink, parent_author, parent_permlink, json_metadata } = opData;
        
        // Only process root level comments (posts, not replies)
        if (parent_author && parent_author !== '') {
            return; // This is a reply, not a root level comment
        }
        
        // Parse json_metadata to check for dApp data
        let metadata;
        try {
            metadata = JSON.parse(json_metadata || '{}');
        } catch (error) {
            console.warn(`Invalid JSON metadata for @${author}/${permlink}:`, error);
            return;
        }
        
        // Check if this comment contains dApp data with dappCID
        if (metadata && metadata.dappCID && metadata.dappCID.trim() !== '') {
            console.log(`Found dApp post: @${author}/${permlink} with dappCID: ${metadata.dappCID}`);
            
            // Determine the type based on metadata
            let postType = 'dapp';
            if (metadata.dAppType) {
                postType = metadata.dAppType.toLowerCase();
            } else if (metadata.vrHash === 'dapp') {
                postType = 'dapp';
            }

            // Extract ReMix data if present
            const remixCid = metadata.ReMix && metadata.ReMix.trim() !== '' ? metadata.ReMix : null;
            
            // Extract license from .lic property
            const license = metadata['.lic'] || null;
            
            // Extract tags if present
            const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
            
            // Insert/update the main post record
            const insertQuery = `
                INSERT INTO posts (author, permlink, type, block, votes, voteweight, promote, paid, remix_cid, license, tags)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (author, permlink) DO UPDATE SET
                    remix_cid = EXCLUDED.remix_cid,
                    license = EXCLUDED.license,
                    tags = EXCLUDED.tags
                RETURNING author, permlink
            `;
            
            const postResult = await pool.query(insertQuery, [
                author,
                permlink,
                postType,
                block.block_num || block.block_id,
                0, // Initial votes
                0, // Initial voteweight
                0, // Initial promote
                false, // Initial paid status
                remixCid,
                license,
                tags
            ]);
            
            // If this post has a ReMix CID, handle the ReMix application tracking
            if (remixCid) {
                try {
                    // Check if this ReMix application already exists
                    const existingApp = await pool.query(
                        'SELECT remix_cid, usage_count FROM remix_applications WHERE remix_cid = $1',
                        [remixCid]
                    );
                    
                    if (existingApp.rows.length === 0) {
                        // This is a new ReMix application - create the application record
                        await pool.query(`
                            INSERT INTO remix_applications (
                                remix_cid, first_author, first_permlink, first_seen_block, 
                                license, title, description, usage_count
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        `, [
                            remixCid,
                            author,
                            permlink,
                            block.block_num || block.block_id,
                            license,
                            metadata.title || null,
                            metadata.description || null,
                            1
                        ]);
                        
                        console.log(`✓ Created new ReMix application: ${remixCid} by @${author}/${permlink}`);
                    } else {
                        // This ReMix application already exists - increment usage count
                        await pool.query(`
                            UPDATE remix_applications 
                            SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP
                            WHERE remix_cid = $1
                        `, [remixCid]);
                        
                        console.log(`✓ Incremented usage for ReMix application: ${remixCid} (now ${existingApp.rows[0].usage_count + 1} uses)`);
                    }
                    
                    // Add this post as a derivative work
                    await pool.query(`
                        INSERT INTO remix_derivatives (remix_cid, author, permlink, block, license, tags)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        ON CONFLICT (remix_cid, author, permlink) DO UPDATE SET
                            license = EXCLUDED.license,
                            tags = EXCLUDED.tags
                    `, [
                        remixCid,
                        author,
                        permlink,
                        block.block_num || block.block_id,
                        license,
                        tags
                    ]);
                    
                    console.log(`✓ Added derivative work: @${author}/${permlink} using ReMix ${remixCid}`);
                    
                } catch (remixError) {
                    console.error('Error processing ReMix application data:', remixError);
                }
            }
            
            if (postResult.rows.length > 0) {
                let logMessage = `✓ Stored new dApp post: @${author}/${permlink} (type: ${postType})`;
                if (remixCid) logMessage += ` with ReMix: ${remixCid}`;
                if (license) logMessage += ` license: ${license}`;
                if (tags.length > 0) logMessage += ` tags: [${tags.join(', ')}]`;
                logMessage += ` in block ${block.block_num || block.block_id}`;
                console.log(logMessage);
            } else {
                console.log(`ℹ Updated existing dApp post @${author}/${permlink} with new metadata`);
            }
        }
    } catch (error) {
        console.error('Error processing comment operation:', error);
    }
});

module.exports = hiveMonitor;
