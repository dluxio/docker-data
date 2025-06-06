const WebSocket = require('ws');
const { deviceService, setWebSocketInstance } = require('./device-connection');

class DeviceConnectionWebSocket {
    constructor() {
        this.clients = new Map(); // sessionId -> Set of WebSocket connections
        this.userSessions = new Map(); // username -> Set of sessionIds
    }

    initialize(wss) {
        this.wss = wss;
        
        // Connect back to the device service for notifications
        setWebSocketInstance(this);
        
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
            sessionId,
            status: sessionStatus,
            userType,
            timestamp: new Date().toISOString()
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
            sessionId,
            signerInfo,
            message: 'Device successfully connected'
        });
    }

    notifyDeviceDisconnected(sessionId) {
        this.broadcastToSession(sessionId, {
            type: 'device_disconnected',
            sessionId,
            message: 'Device disconnected'
        });
    }

    notifySigningRequestReceived(sessionId, requestId, requestType, requestData, deviceInfo) {
        // Notify signing device about new request
        this.broadcastToSessionUserType(sessionId, 'signer', {
            type: 'device_signing_request',
            sessionId,
            requestId,
            requestType,
            requestData,
            deviceInfo,
            message: `New signing request: ${requestType}`
        });
    }

    notifySigningResponse(sessionId, requestId, response, error = null) {
        // Notify requesting device about response
        this.broadcastToSessionUserType(sessionId, 'requester', {
            type: 'device_signing_response',
            sessionId,
            requestId,
            response,
            error,
            success: !error,
            message: error ? 'Signing request failed' : 'Signing request completed'
        });
    }

    notifySessionExpired(sessionId) {
        this.broadcastToSession(sessionId, {
            type: 'device_session_expired',
            sessionId,
            message: 'Session has expired'
        });
    }

    notifyRequestTimeout(sessionId, requestId) {
        this.broadcastToSession(sessionId, {
            type: 'device_request_timeout',
            sessionId,
            requestId,
            message: 'Signing request timed out'
        });
    }

    // Get connected clients info for debugging
    getConnectedClients() {
        const stats = {
            totalSessions: this.clients.size,
            totalClients: 0,
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
}

// Create singleton instance
const deviceConnectionWS = new DeviceConnectionWebSocket();

module.exports = { DeviceConnectionWebSocket, deviceConnectionWS }; 