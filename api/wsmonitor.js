const WebSocket = require('ws');
const { pool } = require('../index');

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
                'http://localhost:3000',
                'https://dlux.io',
                'https://www.dlux.io', 
                'https://vue.dlux.io'
            ];

        this.wss = new WebSocket.Server({
            server,
            path: '/ws/payment-monitor',
            verifyClient: (info) => {
                const origin = info.origin;
                console.log(`WebSocket connection attempt from origin: ${origin}`);
                
                // Allow connections without origin (for testing tools)
                if (!origin) {
                    console.log('WebSocket connection allowed (no origin header)');
                    return true;
                }
                
                // Check if origin is in allowed list
                const isAllowed = allowedOrigins.some(allowedOrigin => {
                    // Handle both exact match and wildcard subdomains
                    if (allowedOrigin === origin) return true;
                    if (allowedOrigin.startsWith('https://*.') && origin.endsWith(allowedOrigin.substring(9))) return true;
                    return false;
                });
                
                if (isAllowed) {
                    console.log(`WebSocket connection allowed from: ${origin}`);
                } else {
                    console.log(`WebSocket connection REJECTED from: ${origin}`);
                    console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
                }
                
                return isAllowed;
            }
        });

        this.wss.on('connection', (ws, req) => {
            console.log('WebSocket connection established');

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleMessage(ws, data);
                } catch (error) {
                    console.error('WebSocket message error:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid message format'
                    }));
                }
            });

            ws.on('close', () => {
                this.removeClient(ws);
                console.log('WebSocket connection closed');
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.removeClient(ws);
            });

            // Send initial connection confirmation
            ws.send(JSON.stringify({
                type: 'connected',
                message: 'WebSocket connection established'
            }));
        });

        console.log('WebSocket server initialized on path /ws/payment-monitor');
    }

    async handleMessage(ws, data) {
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
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
            default:
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Unknown message type'
                }));
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

        console.log(`Client subscribed to channel: ${channelId}`);
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

        console.log(`Client unsubscribed from channel: ${channelId}`);
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
                        message: 'Payment channel not found'
                    });
                    return;
                }

                const channel = result.rows[0];
                const status = this.determineDetailedStatus(channel);

                this.broadcastToChannel(channelId, {
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
                });
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error sending channel status:', error);
            this.broadcastToChannel(channelId, {
                type: 'error',
                message: 'Failed to get channel status'
            });
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
            BNB: 3
        };
        return confirmations[cryptoType] || 1;
    }

    async handlePaymentSent(channelId, txHash) {
        try {
            const client = await pool.connect();
            try {
                // Update channel with user-provided transaction hash
                await client.query(
                    'UPDATE payment_channels SET tx_hash = $1, status = $2 WHERE channel_id = $3',
                    [txHash, 'confirming', channelId]
                );

                // Broadcast update
                this.broadcastToChannel(channelId, {
                    type: 'payment_sent_confirmed',
                    channelId,
                    txHash,
                    message: '✅ Payment transaction recorded'
                });

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
                message: 'Failed to record payment transaction'
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
        // This would integrate with blockchain monitoring
        // For now, we'll just send status updates
        await this.sendChannelStatus(channelId);

        // TODO: Add actual blockchain monitoring logic here
        // - Check transaction status on blockchain
        // - Update confirmations count
        // - Trigger HIVE account creation when confirmed
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

        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = { PaymentChannelMonitor }; 