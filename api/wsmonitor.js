const WebSocket = require('ws');
const { Pool } = require('pg');
const config = require('../config');
const { deviceConnectionWS } = require('./device-connection-ws');

// Create database pool directly to avoid circular dependency
const pool = new Pool({
  connectionString: config.dbcs,
});

// Helper function to explain WebSocket close codes
function getCloseCodeMeaning(code) {
    const codes = {
        1000: 'Normal Closure',
        1001: 'Going Away (e.g., server going down)',
        1002: 'Protocol Error',
        1003: 'Unsupported Data (e.g., text when expecting binary)',
        1004: 'Reserved',
        1005: 'No Status Received',
        1006: 'Abnormal Closure (no close frame received)',
        1007: 'Invalid Data (e.g., malformed UTF-8)',
        1008: 'Policy Violation',
        1009: 'Message Too Big',
        1010: 'Missing Extension',
        1011: 'Internal Server Error',
        1012: 'Service Restart',
        1013: 'Try Again Later',
        1014: 'Bad Gateway',
        1015: 'TLS Handshake Failure'
    };
    return codes[code] || `Unknown code: ${code}`;
}

class PaymentChannelMonitor {
    constructor() {
        this.wss = null;
        this.clients = new Map(); // channelId -> Set of WebSocket connections
        this.monitoringIntervals = new Map(); // channelId -> interval ID
    }

    initialize(server) {
        // Allowed origins for WebSocket connections
        const allowedOrigins = process.env.ALLOWED_ORIGINS 
            ? process.env.ALLOWED_ORIGINS.split(',')
            : [
                'http://localhost:8080',
                'http://localhost:5507',
                'https://dlux.io',
                'https://www.dlux.io', 
                'https://vue.dlux.io',
                'https://data.dlux.io'  // Add the data subdomain
            ];

        this.wss = new WebSocket.Server({
            server,
            path: '/ws/payment-monitor',
            verifyClient: (info) => {
                const origin = info.origin;
                
                // Allow connections without origin (for testing tools, native apps, etc.)
                if (!origin) {
                    return true;
                }
                
                // Check if origin is in allowed list
                const isAllowed = allowedOrigins.some(allowedOrigin => {
                    // Handle both exact match and wildcard subdomains
                    if (allowedOrigin === origin) return true;
                    if (allowedOrigin.startsWith('https://*.') && origin.endsWith(allowedOrigin.substring(7))) return true;
                    // Allow localhost with any port for development
                    if (allowedOrigin.includes('localhost') && origin.includes('localhost')) return true;
                    return false;
                });
                
                return isAllowed;
            }
        });

        this.wss.on('connection', (ws, req) => {
            const connectionId = Math.random().toString(36).substring(7);
            
            // Store connection ID and start time for debugging
            ws.connectionId = connectionId;
            ws.connectionStartTime = Date.now();
            ws.messageCount = 0;
            ws.lastPingTime = Date.now();
            
            // Initialize device connection WebSocket if not already done
            if (!deviceConnectionWS.wss) {
                deviceConnectionWS.initialize(this.wss);
            }

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    ws.messageCount++;
                    ws.lastMessageTime = Date.now();
                    await this.handleMessage(ws, data);
                } catch (error) {
                    console.error(`WebSocket message error:`, error);
                    
                    try {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Invalid message format',
                            details: error.message,
                            timestamp: new Date().toISOString()
                        }));
                    } catch (sendError) {
                        console.error(`Failed to send error message:`, sendError);
                    }
                }
            });

            ws.on('close', (code, reason) => {
                this.removeClient(ws);
                deviceConnectionWS.removeClient(ws);
            });

            ws.on('error', (error) => {
                console.error(`WebSocket error:`, error);
                this.removeClient(ws);
                deviceConnectionWS.removeClient(ws);
            });

            // Send initial connection confirmation
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    const welcomeMessage = {
                        type: 'connected',
                        message: 'WebSocket connection established',
                        timestamp: new Date().toISOString(),
                        server: 'DLUX Payment Monitor',
                        connectionId: connectionId
                    };
                    
                    try {
                        ws.send(JSON.stringify(welcomeMessage));
                    } catch (sendError) {
                        console.error(`Error sending welcome message:`, sendError);
                    }
                }
            }, 150);
        });


    }

    async handleMessage(ws, data) {
        try {
            // Try device connection messages first
            const deviceHandled = await deviceConnectionWS.handleMessage(ws, data);
            if (deviceHandled) {
                return; // Message was handled by device connection system
            }

            // Handle payment monitoring messages
            switch (data.type) {
                case 'subscribe':
                    await this.subscribeToChannel(ws, data.channelId);
                    break;
                case 'unsubscribe':
                    this.unsubscribeFromChannel(ws, data.channelId);
                    break;
                case 'payment_sent':
                    await this.handlePaymentSent(data.channelId, data.txHash);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ 
                        type: 'pong',
                        timestamp: new Date().toISOString()
                    }));
                    break;
                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown message type',
                        receivedType: data.type
                    }));
            }
        } catch (error) {
            console.error('Error in handleMessage:', error);
            try {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Server error processing message',
                    details: error.message
                }));
            } catch (sendError) {
                console.error('Failed to send error response:', sendError);
            }
        }
    }

    async subscribeToChannel(ws, channelId) {
        if (!channelId) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Channel ID required'
            }));
            return;
        }

        // Add client to channel subscribers
        if (!this.clients.has(channelId)) {
            this.clients.set(channelId, new Set());
        }
        this.clients.get(channelId).add(ws);

        // Store channel ID on WebSocket for cleanup
        if (!ws.channels) ws.channels = new Set();
        ws.channels.add(channelId);

        // Send current status
        await this.sendChannelStatus(channelId);

        // Start monitoring if not already active
        if (!this.monitoringIntervals.has(channelId)) {
            this.startChannelMonitoring(channelId);
        }


    }

    unsubscribeFromChannel(ws, channelId) {
        if (this.clients.has(channelId)) {
            this.clients.get(channelId).delete(ws);
            if (this.clients.get(channelId).size === 0) {
                this.clients.delete(channelId);
                this.stopChannelMonitoring(channelId);
            }
        }

        if (ws.channels) {
            ws.channels.delete(channelId);
        }


    }

    removeClient(ws) {
        if (ws.channels) {
            ws.channels.forEach(channelId => {
                this.unsubscribeFromChannel(ws, channelId);
            });
        }
    }

    async sendChannelStatus(channelId) {
        try {
            const client = await pool.connect();
            
            try {
                const result = await client.query(
                    'SELECT * FROM payment_channels WHERE channel_id = $1',
                    [channelId]
                );

                if (result.rows.length === 0) {
                    this.broadcastToChannel(channelId, {
                        type: 'error',
                        message: 'Payment channel not found',
                        channelId: channelId
                    });
                    return;
                }

                const channel = result.rows[0];
                const status = this.determineDetailedStatus(channel);

                const statusMessage = {
                    type: 'status_update',
                    channelId,
                    status: status.code,
                    message: status.message,
                    details: status.details,
                    progress: status.progress,
                    channel: {
                        username: channel.username,
                        cryptoType: channel.crypto_type,
                        amountCrypto: parseFloat(channel.amount_crypto),
                        amountUsd: parseFloat(channel.amount_usd),
                        address: channel.payment_address,
                        memo: channel.memo,
                        confirmations: channel.confirmations || 0,
                        txHash: channel.tx_hash,
                        expiresAt: channel.expires_at,
                        createdAt: channel.created_at,
                        isExpired: new Date() > new Date(channel.expires_at)
                    }
                };

                this.broadcastToChannel(channelId, statusMessage);
                
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(`Error sending channel status for ${channelId}:`, error);
            
            try {
                this.broadcastToChannel(channelId, {
                    type: 'error',
                    message: 'Failed to get channel status',
                    details: error.message,
                    channelId: channelId
                });
            } catch (broadcastError) {
                console.error('Failed to broadcast error message:', broadcastError);
            }
        }
    }

    determineDetailedStatus(channel) {
        const now = new Date();
        const expiresAt = new Date(channel.expires_at);
        const isExpired = now > expiresAt;

        if (isExpired && channel.status === 'pending') {
            return {
                code: 'expired',
                message: '⏰ Payment expired',
                details: 'Payment window has closed. Please start a new payment.',
                progress: 0
            };
        }

        switch (channel.status) {
            case 'pending':
                if (!channel.tx_hash) {
                    return {
                        code: 'waiting_payment',
                        message: '💳 Waiting for payment',
                        details: `Send ${channel.amount_crypto} ${channel.crypto_type} to the address with the specified memo.`,
                        progress: 20
                    };
                } else {
                    return {
                        code: 'payment_detected',
                        message: '🔍 Payment detected, waiting for confirmations',
                        details: `Transaction found: ${channel.tx_hash.substring(0, 10)}...`,
                        progress: 40
                    };
                }

            case 'confirming':
                const confirmations = channel.confirmations || 0;
                const required = this.getRequiredConfirmations(channel.crypto_type);
                return {
                    code: 'confirming',
                    message: `⏳ Confirming transaction (${confirmations}/${required})`,
                    details: `Waiting for network confirmations. This may take a few minutes.`,
                    progress: 40 + (confirmations / required) * 30
                };

            case 'confirmed':
                return {
                    code: 'creating_account',
                    message: '⚙️ Creating HIVE account',
                    details: 'Payment confirmed! Generating your HIVE account...',
                    progress: 80
                };

            case 'completed':
                return {
                    code: 'completed',
                    message: '🎉 Account created successfully!',
                    details: `Welcome to HIVE, @${channel.username}!`,
                    progress: 100
                };

            case 'failed':
                return {
                    code: 'failed',
                    message: '❌ Account creation failed',
                    details: 'Something went wrong. Please contact support.',
                    progress: 0
                };

            default:
                return {
                    code: 'unknown',
                    message: '❓ Unknown status',
                    details: 'Please refresh the page.',
                    progress: 0
                };
        }
    }

    getRequiredConfirmations(cryptoType) {
        const confirmations = {
            SOL: 1,
            ETH: 2,
            MATIC: 10,
            BNB: 3,
            BTC: 1,
        };
        return confirmations[cryptoType] || 1;
    }

    async handlePaymentSent(channelId, txHash) {
        try {
            const client = await pool.connect();
            try {
                // Get the blockchain monitoring service
                const blockchainMonitor = require('./blockchain-monitor');
                
                // First, verify the transaction using blockchain monitoring
                const verificationResult = await blockchainMonitor.manualVerifyTransaction(channelId, txHash);
                
                if (verificationResult.success) {
                    // Transaction is valid and has been processed
                    this.broadcastToChannel(channelId, {
                        type: 'payment_verified',
                        channelId,
                        txHash,
                        message: '✅ Payment verified on blockchain',
                        transaction: verificationResult.transaction
                    });
                } else {
                    // Transaction couldn't be verified yet, but record it for monitoring
                    await client.query(
                        'UPDATE payment_channels SET tx_hash = $1, status = $2 WHERE channel_id = $3',
                        [txHash, 'confirming', channelId]
                    );

                    this.broadcastToChannel(channelId, {
                        type: 'payment_sent_confirmed',
                        channelId,
                        txHash,
                        message: '⏳ Payment recorded, verifying on blockchain...',
                        note: 'Transaction will be automatically verified when confirmed'
                    });
                }

                // Send updated status
                await this.sendChannelStatus(channelId);

                console.log(`Payment sent for channel ${channelId}: ${txHash}`);
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error handling payment sent:', error);
            this.broadcastToChannel(channelId, {
                type: 'error',
                message: 'Failed to process payment transaction',
                details: error.message
            });
        }
    }

    startChannelMonitoring(channelId) {
        console.log(`Starting monitoring for channel: ${channelId}`);

        const interval = setInterval(async () => {
            try {
                await this.checkChannelProgress(channelId);
            } catch (error) {
                console.error(`Error monitoring channel ${channelId}:`, error);
            }
        }, 10000); // Check every 10 seconds

        this.monitoringIntervals.set(channelId, interval);

        // Auto-cleanup after 25 hours (1 hour after expiration)
        setTimeout(() => {
            this.stopChannelMonitoring(channelId);
        }, 25 * 60 * 60 * 1000);
    }

    stopChannelMonitoring(channelId) {
        if (this.monitoringIntervals.has(channelId)) {
            clearInterval(this.monitoringIntervals.get(channelId));
            this.monitoringIntervals.delete(channelId);
            console.log(`Stopped monitoring channel: ${channelId}`);
        }
    }

    async checkChannelProgress(channelId) {
        // Integrate with blockchain monitoring
        await this.sendChannelStatus(channelId);

        // The blockchain monitoring service handles:
        // - Checking transaction status on blockchain
        // - Updating confirmations count
        // - Triggering HIVE account creation when confirmed
        // This method now just sends status updates via WebSocket
    }

    async checkNetworkForPayments(symbol, network) {
        // This method is called by the blockchain monitoring service
        // and should be implemented there, not here
        // Keeping this stub for compatibility
        console.log(`Network check for ${symbol} delegated to blockchain monitoring service`);
    }

    broadcastToChannel(channelId, message) {
        if (this.clients.has(channelId)) {
            const clients = this.clients.get(channelId);
            const messageStr = JSON.stringify({
                timestamp: new Date().toISOString(),
                ...message
            });

            clients.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(messageStr);
                }
            });
        }
    }

    // Method to be called when payment status changes externally
    async notifyStatusChange(channelId, newStatus, txHash = null) {
        if (txHash) {
            // Update database
            const client = await pool.connect();
            try {
                await client.query(
                    'UPDATE payment_channels SET status = $1, tx_hash = $2 WHERE channel_id = $3',
                    [newStatus, txHash, channelId]
                );
            } finally {
                client.release();
            }
        }

        // Send update to subscribers
        await this.sendChannelStatus(channelId);
    }

    // Cleanup on server shutdown
    shutdown() {
        this.monitoringIntervals.forEach((interval, channelId) => {
            clearInterval(interval);
        });
        this.monitoringIntervals.clear();

        // Shutdown device connection WebSocket
        if (deviceConnectionWS) {
            deviceConnectionWS.shutdown();
        }

        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = { PaymentChannelMonitor }; 