const WebSocket = require('ws');
const { deviceService, setWebSocketInstance } = require('./device-connection');

class DeviceConnectionWebSocket {
    constructor() {
        this.clients = new Map(); // sessionId -> Set of WebSocket connections
        this.userSessions = new Map(); // username -> Set of sessionIds
        this.pendingAcks = new Map(); // messageId -> {sessionId, userType, message, retries, timestamp}
        this.maxRetries = 3;
        this.ackTimeout = 5000; // 5 seconds
        this.retryInterval = 2000; // 2 seconds
    }

    initialize(wss) {
        this.wss = wss;
        
        // Connect back to the device service for notifications
        setWebSocketInstance(this);
        
        // Start acknowledgment timeout checker
        this.startAckTimeoutChecker();
        
        console.log('Device Connection WebSocket service initialized');
    }

    // Handle WebSocket messages related to device connections
    async handleMessage(ws, data) {
        try {
            switch (data.type) {
                case 'device_subscribe':
                    await this.subscribeToSession(ws, data.sessionId, data.userType);
                    break;
                case 'device_unsubscribe':
                    this.unsubscribeFromSession(ws, data.sessionId);
                    break;
                case 'device_ping':
                    ws.send(JSON.stringify({ 
                        type: 'device_pong',
                        sessionId: data.sessionId,
                        timestamp: new Date().toISOString()
                    }));
                    break;
                case 'device_ack':
                    this.handleAcknowledgment(data.messageId);
                    break;
                case 'device_signing_response':
                    await this.handleSigningResponse(ws, data);
                    break;
                default:
                    return false; // Not a device connection message
            }
            return true; // Message was handled
        } catch (error) {
            console.error('Error in device connection WebSocket message handling:', error);
            try {
                ws.send(JSON.stringify({
                    type: 'device_error',
                    message: 'Server error processing device message',
                    details: error.message
                }));
            } catch (sendError) {
                console.error('Failed to send device error response:', sendError);
            }
            return true;
        }
    }

    async subscribeToSession(ws, sessionId, userType = 'requester') {
        if (!sessionId) {
            ws.send(JSON.stringify({
                type: 'device_error',
                message: 'Session ID required for device subscription'
            }));
            return;
        }

        // Verify session exists
        const sessionStatus = deviceService.getSessionStatus(sessionId);
        if (!sessionStatus.isConnected) {
            ws.send(JSON.stringify({
                type: 'device_error',
                message: 'Invalid or expired session ID'
            }));
            return;
        }

        // Add client to session subscribers
        if (!this.clients.has(sessionId)) {
            this.clients.set(sessionId, new Set());
        }
        this.clients.get(sessionId).add(ws);

        // Store session info on WebSocket for cleanup
        if (!ws.deviceSessions) ws.deviceSessions = new Set();
        ws.deviceSessions.add(sessionId);
        ws.userType = userType;

        // Track user sessions for targeted messaging
        const username = userType === 'signer' ? sessionStatus.signerUsername : 'requester';
        if (!this.userSessions.has(username)) {
            this.userSessions.set(username, new Set());
        }
        this.userSessions.get(username).add(sessionId);

        // Send current session status
        ws.send(JSON.stringify({
            type: 'device_session_status',
            status: {
                connected: sessionStatus.isConnected
            }
        }));

        console.log(`Device WebSocket subscribed to session ${sessionId} as ${userType}`);
    }

    unsubscribeFromSession(ws, sessionId) {
        if (this.clients.has(sessionId)) {
            this.clients.get(sessionId).delete(ws);
            if (this.clients.get(sessionId).size === 0) {
                this.clients.delete(sessionId);
            }
        }

        if (ws.deviceSessions) {
            ws.deviceSessions.delete(sessionId);
        }

        console.log(`Device WebSocket unsubscribed from session ${sessionId}`);
    }

    removeClient(ws) {
        if (ws.deviceSessions) {
            ws.deviceSessions.forEach(sessionId => {
                this.unsubscribeFromSession(ws, sessionId);
            });
        }
    }

    // Broadcast to all clients subscribed to a session
    broadcastToSession(sessionId, message) {
        if (this.clients.has(sessionId)) {
            const clients = this.clients.get(sessionId);
            const messageStr = JSON.stringify({
                timestamp: new Date().toISOString(),
                ...message
            });

            clients.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(messageStr);
                    } catch (error) {
                        console.error('Error sending device message to client:', error);
                    }
                }
            });
        }
    }

    // Broadcast to specific user type in a session
    broadcastToSessionUserType(sessionId, userType, message) {
        if (this.clients.has(sessionId)) {
            const clients = this.clients.get(sessionId);
            const messageStr = JSON.stringify({
                timestamp: new Date().toISOString(),
                ...message
            });

            clients.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN && ws.userType === userType) {
                    try {
                        ws.send(messageStr);
                    } catch (error) {
                        console.error('Error sending targeted device message to client:', error);
                    }
                }
            });
        }
    }

    // Send message with acknowledgment requirement
    sendWithAck(sessionId, userType, message, requiresAck = false) {
        if (!requiresAck) {
            // For non-critical messages, use regular broadcast
            if (userType) {
                this.broadcastToSessionUserType(sessionId, userType, message);
            } else {
                this.broadcastToSession(sessionId, message);
            }
            return;
        }

        // For critical messages, add message ID and track for acknowledgment
        const messageId = this.generateMessageId();
        const messageWithId = {
            ...message,
            messageId,
            requiresAck: true
        };

        // Store for retry logic
        this.pendingAcks.set(messageId, {
            sessionId,
            userType,
            message: messageWithId,
            retries: 0,
            timestamp: Date.now()
        });

        // Send initial message
        if (userType) {
            this.broadcastToSessionUserType(sessionId, userType, messageWithId);
        } else {
            this.broadcastToSession(sessionId, messageWithId);
        }

        console.log(`Sent message ${messageId} to session ${sessionId} (${userType || 'all'}) with ACK required`);
    }

    // Generate unique message ID
    generateMessageId() {
        return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    // Handle acknowledgment received
    handleAcknowledgment(messageId) {
        if (this.pendingAcks.has(messageId)) {
            console.log(`Received ACK for message ${messageId}`);
            this.pendingAcks.delete(messageId);
        }
    }

    // Handle signing response from WebSocket client
    async handleSigningResponse(ws, data) {
        try {
            const { sessionId, requestId, response, error, timestamp } = data;

            if (!sessionId || !requestId) {
                ws.send(JSON.stringify({
                    type: 'device_error',
                    message: 'sessionId and requestId are required for signing response'
                }));
                return;
            }

            // Verify session exists and user has access
            const sessionStatus = deviceService.getSessionStatus(sessionId);
            if (!sessionStatus.isConnected) {
                ws.send(JSON.stringify({
                    type: 'device_error',
                    message: 'Invalid or expired session ID'
                }));
                return;
            }

            // Verify the client is connected as a signer to this session
            if (ws.userType !== 'signer') {
                ws.send(JSON.stringify({
                    type: 'device_error',
                    message: 'Only signers can send signing responses'
                }));
                return;
            }

            // Submit the response through the device service
            await deviceService.respondToRequest(sessionId, requestId, response, error);

            // Send confirmation to the signer
            ws.send(JSON.stringify({
                type: 'device_response_accepted',
                sessionId,
                requestId,
                timestamp: new Date().toISOString()
            }));

            console.log(`WebSocket signing response received for request ${requestId} in session ${sessionId}`);

        } catch (error) {
            console.error('Error handling WebSocket signing response:', error);
            ws.send(JSON.stringify({
                type: 'device_error',
                message: 'Failed to process signing response',
                details: error.message
            }));
        }
    }

    // Start acknowledgment timeout checker
    startAckTimeoutChecker() {
        this.ackChecker = setInterval(() => {
            const now = Date.now();
            
            for (const [messageId, ackData] of this.pendingAcks.entries()) {
                const timeElapsed = now - ackData.timestamp;
                
                if (timeElapsed > this.ackTimeout) {
                    if (ackData.retries < this.maxRetries) {
                        // Retry sending
                        ackData.retries++;
                        ackData.timestamp = now;
                        
                        console.log(`Retrying message ${messageId} (attempt ${ackData.retries}/${this.maxRetries})`);
                        
                        if (ackData.userType) {
                            this.broadcastToSessionUserType(ackData.sessionId, ackData.userType, ackData.message);
                        } else {
                            this.broadcastToSession(ackData.sessionId, ackData.message);
                        }
                    } else {
                        // Max retries exceeded
                        console.error(`Message ${messageId} delivery failed after ${this.maxRetries} attempts`);
                        this.pendingAcks.delete(messageId);
                        
                        // Notify about delivery failure
                        this.broadcastToSession(ackData.sessionId, {
                            type: 'device_delivery_failed',
                            originalMessage: ackData.message,
                            reason: 'Maximum retry attempts exceeded'
                        });
                    }
                }
            }
        }, this.retryInterval);
    }

    // Device connection event handlers
    notifyPairingCreated(sessionId, pairCode, expiresIn) {
        this.broadcastToSession(sessionId, {
            type: 'device_pairing_created',
            sessionId,
            pairCode,
            expiresIn,
            message: `Pairing code created: ${pairCode}`
        });
    }

    notifyDeviceConnected(sessionId, signerInfo) {
        this.broadcastToSession(sessionId, {
            type: 'device_connected',
            signerInfo
        });
    }

    notifyDeviceDisconnected(sessionId) {
        this.broadcastToSession(sessionId, {
            type: 'device_disconnected'
        });
    }

    notifySigningRequestReceived(sessionId, requestId, requestType, requestData, deviceInfo) {
        // Notify signing device about new request - CRITICAL MESSAGE, requires ACK
        this.sendWithAck(sessionId, 'signer', {
            type: 'device_signing_request',
            sessionId,
            requestId,
            requestType,
            data: requestData,
            deviceInfo,
            timestamp: new Date().toISOString()
        }, true); // Requires acknowledgment
        
        console.log(`Sent signing request ${requestId} to signer in session ${sessionId}`);
    }

    notifySigningResponse(sessionId, requestId, response, error = null) {
        // Notify requesting device about response - CRITICAL MESSAGE, requires ACK
        this.sendWithAck(sessionId, 'requester', {
            type: 'device_signing_response',
            sessionId,
            requestId,
            response,
            error,
            success: !error,
            message: error ? 'Signing request failed' : 'Signing request completed'
        }, true); // Requires acknowledgment
        
        console.log(`Sent signing response for ${requestId} to requester in session ${sessionId}`);
    }

    notifySessionExpired(sessionId) {
        this.broadcastToSession(sessionId, {
            type: 'device_session_expired'
        });
    }

    notifyRequestTimeout(sessionId, requestId) {
        // Send timeout notification to BOTH signer and requester
        const timeoutMessage = {
            type: 'device_request_timeout',
            sessionId,
            requestId,
            message: 'Signing request timed out'
        };
        
        // Send to both user types
        this.broadcastToSessionUserType(sessionId, 'signer', timeoutMessage);
        this.broadcastToSessionUserType(sessionId, 'requester', timeoutMessage);
        
        console.log(`Sent timeout notifications for request ${requestId} in session ${sessionId}`);
    }

    // Get connected clients info for debugging
    getConnectedClients() {
        const stats = {
            totalSessions: this.clients.size,
            totalClients: 0,
            pendingAcks: this.pendingAcks.size,
            sessions: {}
        };

        this.clients.forEach((clients, sessionId) => {
            stats.totalClients += clients.size;
            stats.sessions[sessionId] = {
                clientCount: clients.size,
                userTypes: Array.from(clients).map(ws => ws.userType).filter(Boolean)
            };
        });

        return stats;
    }

    // Cleanup method
    shutdown() {
        if (this.ackChecker) {
            clearInterval(this.ackChecker);
            this.ackChecker = null;
        }
        this.pendingAcks.clear();
        console.log('Device Connection WebSocket service shut down');
    }
}

// Create singleton instance
const deviceConnectionWS = new DeviceConnectionWebSocket();

module.exports = { DeviceConnectionWebSocket, deviceConnectionWS }; 