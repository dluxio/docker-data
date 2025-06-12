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
        this.retryDelay = 1000; // Initial retry delay in ms
        this.maxRetryDelay = 30000; // Maximum retry delay in ms
        this.apiHealth = {
            status: 'healthy',
            lastError: null,
            errorCount: 0,
            lastSuccess: Date.now()
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
        this.retryDelay = 1000; // Reset retry delay on start
        
        try {
            await this.initialize();
            await this.processBlocks();
        } catch (error) {
            console.error('Error in Hive monitor:', error);
            this.isRunning = false;
        }
    }

    async processBlocks() {
        while (this.isRunning && this.hasListeners) {
            try {
                const currentBlock = await this.client.api.getDynamicGlobalPropertiesAsync();
                const headBlock = currentBlock.head_block_number;

                if (this.lastProcessedBlock < headBlock) {
                    // Process blocks in batches of 100
                    const batchSize = 100;
                    const endBlock = Math.min(this.lastProcessedBlock + batchSize, headBlock);

                    for (let blockNum = this.lastProcessedBlock + 1; blockNum <= endBlock; blockNum++) {
                        try {
                            const block = await this.client.api.getBlockAsync(blockNum);
                            await this.processBlock(block);
                            this.lastProcessedBlock = blockNum;
                            
                            // Update last processed block in database
                            await pool.query('UPDATE hive_state SET last_block = $1 WHERE id = 1', [blockNum]);
                            
                            // Reset retry delay on success
                            this.retryDelay = 1000;
                            this.apiHealth.status = 'healthy';
                            this.apiHealth.lastSuccess = Date.now();
                            this.apiHealth.errorCount = 0;
                        } catch (error) {
                            if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                                console.warn(`Rate limit hit at block ${blockNum}, waiting ${this.retryDelay}ms`);
                                this.apiHealth.status = 'rate_limited';
                                this.apiHealth.lastError = error;
                                this.apiHealth.errorCount++;
                                
                                // Exponential backoff
                                this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
                                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                                break; // Break the loop to retry the current block
                            } else {
                                console.error(`Error processing block ${blockNum}:`, error);
                                this.apiHealth.status = 'error';
                                this.apiHealth.lastError = error;
                                this.apiHealth.errorCount++;
                            }
                        }
                    }
                }

                // Wait a bit before next batch
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error('Error processing blocks:', error);
                this.apiHealth.status = 'error';
                this.apiHealth.lastError = error;
                this.apiHealth.errorCount++;
                
                // Wait longer on error before retrying
                await new Promise(resolve => setTimeout(resolve, 5000));
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
            const [action, data] = JSON.parse(json);
            
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
