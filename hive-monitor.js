const fetch = require('node-fetch');
const { pool } = require('./index');

class HiveMonitor {
    constructor() {
        this.currentAddress = 'https://hive-api.dlux.io';
        this.lastProcessedBlock = 0;
        this.isRunning = false;
        this.operationHandlers = new Map();
        this.hasListeners = false;
        this.retryDelay = 3000;
        this.maxRetryDelay = 30000;
        this.apiHealth = {
            status: 'healthy',
            lastError: null,
            errorCount: 0,
            lastSuccess: Date.now(),
            consecutiveErrors: 0
        };
        
        // State for tracking transactions for read notifications
        this.pendingReadTransactions = new Map();
        this.readTransactionResolvers = new Map();
        
        // Block processing state
        this.blocks = {
            processing: 0,
            completed: 0,
            data: {},
            requests: {
                last_range: 0,
                last_block: 0,
            }
        };
        
        this.isStreaming = false;
        this.behind = 0;
        this.head_block = 0;
    }

    async initialize() {
        try {
            // Get the last processed block from database
            const result = await pool.query('SELECT last_block FROM hive_state WHERE id = 1');
            if (result.rows.length > 0) {
                const dbBlock = Number(result.rows[0].last_block);
                this.lastProcessedBlock = dbBlock > 96726250 ? dbBlock : 96726250;
                
            } else {
                // Initialize state with specific block number
                const initialBlock = 96726250;
                await pool.query('INSERT INTO hive_state (id, last_block) VALUES (1, $1)', [initialBlock]);
                this.lastProcessedBlock = initialBlock;
                
            }
            this.blocks.completed = this.lastProcessedBlock;
            
        } catch (error) {
            console.error('Failed to initialize Hive monitor:', error);
            throw error;
        }
    }

    async start() {
        if (this.isRunning || !this.hasListeners) return;
        this.isRunning = true;
        this.retryDelay = 3000;
        
        try {
            await this.initialize();
            await this.beginBlockComputing();
        } catch (error) {
            console.error('Error in Hive monitor:', error);
            this.isRunning = false;
        }
    }

    async getHeadBlockNumber() {
        try {
            const response = await fetch(this.currentAddress, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'dlux-data-monitor'
                },
                body: JSON.stringify({
                    "jsonrpc": "2.0",
                    "method": "database_api.get_dynamic_global_properties",
                    "params": {},
                    "id": 1
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            if (data.error) {
                throw new Error(`API Error: ${data.error.message}`);
            }
            
            return data.result.head_block_number;
        } catch (error) {
            console.error('Error getting head block number:', error);
            throw error;
        }
    }

    async getBlock(blockNum) {
        try {
            const response = await fetch(this.currentAddress, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'dlux-data-monitor'
                },
                body: JSON.stringify({
                    "jsonrpc": "2.0",
                    "method": "block_api.get_block",
                    "params": {
                        "block_num": blockNum
                    },
                    "id": 1
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            if (data.error) {
                throw new Error(`API Error: ${data.error.message}`);
            }
            
            return data.result.block;
        } catch (error) {
            console.error(`Error getting block ${blockNum}:`, error);
            throw error;
        }
    }

    async getBlockRange(startBlock, count) {
        try {
            const response = await fetch(this.currentAddress, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'dlux-data-monitor'
                },
                body: JSON.stringify({
                    "jsonrpc": "2.0",
                    "method": "block_api.get_block_range",
                    "params": {
                        "starting_block_num": startBlock,
                        "count": count
                    },
                    "id": 1
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            if (data.error) {
                throw new Error(`API Error: ${data.error.message}`);
            }
            
            return data.result.blocks;
        } catch (error) {
            console.error(`Error getting block range ${startBlock}-${startBlock + count - 1}:`, error);
            throw error;
        }
    }

    async beginBlockComputing() {
        while (this.isRunning && this.hasListeners) {
            try {
                this.head_block = await this.getHeadBlockNumber();
                
                // Ensure both values are numbers
                const headBlock = Number(this.head_block);
                const currentBlock = Number(this.lastProcessedBlock);
                
                // Calculate how many blocks we're behind
                this.behind = headBlock - (currentBlock + 1);
             
                
                if (this.behind > 0) {
                    // Process blocks in batches when behind
                    const batchSize = this.behind > 100 ? 100 : this.behind;
                    const startBlock = currentBlock + 1;
                  
                    
                    if (batchSize === 1) {
                        // Process single block
                        const block = await this.getBlock(startBlock);
                        if (block) {
                            await this.processBlock(block);
                            this.lastProcessedBlock = startBlock;
                            await this.updateLastProcessedBlock(startBlock);
                        } else {
                            console.error(`Failed to fetch block ${startBlock}`);
                        }
                    } else {
                        // Process block range sequentially to ensure proper ordering
                       
                        const blocks = await this.getBlockRange(startBlock, batchSize);
                        if (blocks && blocks.length > 0) {
                            
                            for (let i = 0; i < blocks.length; i++) {
                                const block = blocks[i];
                                const blockNum = parseInt(block.block_id.slice(0, 8), 16);
                                
                                // Add transaction metadata
                                if (block.transactions && block.transaction_ids) {
                                    for (let j = 0; j < block.transactions.length; j++) {
                                        block.transactions[j].block_num = blockNum;
                                        block.transactions[j].transaction_id = block.transaction_ids[j];
                                        block.transactions[j].transaction_num = j;
                                    }
                                }
                                
                                // Process this block completely before moving to next
                                await this.processBlock(block);
                                this.lastProcessedBlock = blockNum;
                                
                                // Update database every 10 blocks or on last block
                                if (blockNum % 10 === 0 || i === blocks.length - 1) {
                                    await this.updateLastProcessedBlock(blockNum);
                                }
                                
                                if (blockNum % 100 === 0) {
                                   
                                }
                            }
                            
                        } else {
                            console.error(`Failed to fetch block range ${startBlock}-${startBlock + batchSize - 1}`);
                        }
                    }
                    
                    // Reset API health on successful processing
                    this.apiHealth.consecutiveErrors = 0;
                    this.apiHealth.status = 'healthy';
                    this.apiHealth.lastSuccess = Date.now();
                    
                    // Don't wait - immediately check for next batch
                    continue;
                    
                } else if (this.behind === 0) {
                    // We're exactly caught up, wait a bit before checking again
                    
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } else {
                    // This shouldn't happen (behind < 0)
                    console.error(`ERROR: Behind calculation is negative: ${this.behind} (Current: ${currentBlock}, Head: ${headBlock})`);
                    console.error(`Type check - Current type: ${typeof currentBlock}, Head type: ${typeof headBlock}`);
                    console.error(`Raw values - this.lastProcessedBlock: ${this.lastProcessedBlock}, this.head_block: ${this.head_block}`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                
                // Clean up old transactions periodically
                if (Date.now() % 60000 < 3000) {
                    this.cleanupOldTransactions();
                }
                
            } catch (error) {
                console.error('Error in block computing:', error);
                this.apiHealth.consecutiveErrors++;
                this.apiHealth.lastError = error;
                this.apiHealth.status = 'error';
                
                // Wait before retrying with exponential backoff
                const delay = Math.min(this.retryDelay * Math.pow(2, this.apiHealth.consecutiveErrors), this.maxRetryDelay);
                console.log(`Waiting ${delay}ms before retry (consecutive errors: ${this.apiHealth.consecutiveErrors})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        console.log('Hive monitor stopped');
    }

    async processBlock(block) {
        if (!block || !block.transactions) return;

        const blockNum = parseInt(block.block_id.slice(0, 8), 16);
       
        
        // Collect all operations to process
        const allOperations = [];
        
        for (const tx of block.transactions) {
            const txId = tx.transaction_id;
            
            // Process regular operations
            if (tx.operations && Array.isArray(tx.operations)) {
                for (const op of tx.operations) {
                    if (Array.isArray(op) && op.length >= 2) {
                        const opType = op[0];
                        const opData = op[1];
                        
                        // Add metadata to operation data
                        opData.transaction_id = txId;
                        opData.block_num = blockNum;
                        opData.timestamp = block.timestamp;
                        opData.block_id = block.block_id;
                        
                        const handler = this.operationHandlers.get(opType);
                        if (handler) {
                            allOperations.push({
                                type: opType,
                                data: opData,
                                handler: handler,
                                block: block,
                                txId: txId
                            });
                        }
                    }
                }
            }
        }

        // Process all operations and wait for completion
        if (allOperations.length > 0) {
            
            
            // Process operations in parallel since we don't need strict ordering
            const operationPromises = allOperations.map(async (op) => {
                try {
                    await op.handler(op.data, op.block, op.txId);
                    return { success: true, type: op.type };
                } catch (error) {
                    console.error(`Error processing operation ${op.type} in block ${blockNum}:`, error);
                    return { success: false, type: op.type, error: error.message };
                }
            });
            
            // Wait for all operations to complete
            const results = await Promise.allSettled(operationPromises);
            
            // Log results
            const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
            const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;
            
            if (failed > 0) {
                console.warn(`Block ${blockNum}: ${successful} operations succeeded, ${failed} operations failed`);
            } else {
                
            }
        } else {
        }
        
        // Block processing is complete
    }

    async updateLastProcessedBlock(blockNum) {
        try {
            await pool.query('UPDATE hive_state SET last_block = $1 WHERE id = 1', [blockNum]);
        } catch (error) {
            console.error('Error updating last processed block in database:', error);
            // Don't throw here - we want to continue processing even if database update fails
            // The block counter in memory will still advance
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
            readTransactionResolvers: this.readTransactionResolvers.size,
            behind: this.behind,
            headBlock: this.head_block
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
                    blockNum: block.block_num || opData.block_num,
                    timestamp: block.timestamp || opData.timestamp
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
                opData.block_num,
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
                            opData.block_num,
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
                        opData.block_num,
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
                logMessage += ` in block ${opData.block_num}`;
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
