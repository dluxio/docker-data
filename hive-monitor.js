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
            // Process regular operations
            for (const op of tx.operations) {
                const [opType, opData] = op;
                const handler = this.operationHandlers.get(opType);
                if (handler) {
                    try {
                        await handler(opData, block);
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
                            await handler(vopData, block);
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
            retryDelay: this.retryDelay
        };
    }
}

const hiveMonitor = new HiveMonitor();

// Register handler for custom JSON operation
hiveMonitor.registerOperationHandler('custom_json', async (opData, block) => {
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
            
            if (action === 'setLastRead' && data.date && data.dlux) {
                const readDate = new Date(data.date);
                
                // Update local notifications
                await pool.query(`
                    UPDATE user_notifications 
                    SET read_at = $1, status = 'read'
                    WHERE username = $2 
                    AND (read_at IS NULL OR read_at < $1)
                    AND (expires_at IS NULL OR expires_at > NOW())
                `, [readDate, account]);

                // Update notification settings for Hive Bridge notifications
                await pool.query(`
                    INSERT INTO notification_settings (username, last_read)
                    VALUES ($1, $2)
                    ON CONFLICT (username) 
                    DO UPDATE SET last_read = $2
                    WHERE notification_settings.last_read < $2
                `, [account, readDate]);
            }
        } catch (error) {
            console.error('Error processing notification custom_json:', error);
        }
    }
});

module.exports = hiveMonitor;
