const { Pool } = require("pg");
const config = require("../config");
const crypto = require('crypto');
const { createHash } = require('crypto');

const pool = new Pool({
  connectionString: config.dbcs,
});

// Note: Authentication is handled in route definitions in index.js
let deviceConnectionWS;

// Initialize WebSocket integration (will be set by the websocket module)
function setWebSocketInstance(wsInstance) {
    deviceConnectionWS = wsInstance;
}

class DeviceConnectionService {
    constructor() {
        this.activeSessions = new Map(); // sessionId -> session data
        this.pendingRequests = new Map(); // requestId -> request data
        this.pairCodes = new Map(); // pairCode -> session data
        this.cleanupInterval = null;
        this.startCleanup();
    }

    // Generate a 6-character pairing code
    generatePairCode() {
        const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789'; // No O, 0 for clarity
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // Generate unique session ID
    generateSessionId() {
        return crypto.randomUUID();
    }

    // Generate unique request ID
    generateRequestId() {
        return crypto.randomUUID();
    }

    // Create a device pairing session
    async createPairing(username, deviceInfo = {}) {
        const pairCode = this.generatePairCode();
        const sessionId = this.generateSessionId();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        const sessionData = {
            sessionId,
            pairCode,
            signerUsername: username,
            signerDeviceInfo: deviceInfo,
            requesterConnected: false,
            requesterInfo: null,
            createdAt: new Date(),
            expiresAt,
            lastActivity: new Date()
        };

        this.pairCodes.set(pairCode, sessionData);
        this.activeSessions.set(sessionId, sessionData);

        // Also store in database for persistence
        try {
            const query = `
                INSERT INTO device_sessions (session_id, pair_code, signer_username, signer_device_info, expires_at, created_at, last_activity)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `;
            await pool.query(query, [
                sessionId, pairCode, username, 
                JSON.stringify(deviceInfo), expiresAt, 
                sessionData.createdAt, sessionData.lastActivity
            ]);
        } catch (error) {
            console.error('Error storing session in database:', error);
            // Continue anyway, in-memory storage is primary
        }

        const result = {
            pairCode,
            sessionId,
            expiresIn: 300 // 5 minutes
        };

        // Notify WebSocket clients
        if (deviceConnectionWS) {
            deviceConnectionWS.notifyPairingCreated(sessionId, pairCode, 300);
        }

        return result;
    }

    // Connect to a device using pairing code
    async connectToDevice(pairCode, requesterInfo = {}) {
        const sessionData = this.pairCodes.get(pairCode);
        
        if (!sessionData) {
            throw new Error('Invalid or expired pairing code');
        }

        if (new Date() > sessionData.expiresAt) {
            this.pairCodes.delete(pairCode);
            this.activeSessions.delete(sessionData.sessionId);
            throw new Error('Pairing code has expired');
        }

        if (sessionData.requesterConnected) {
            throw new Error('Device already connected');
        }

        // Update session with requester info
        sessionData.requesterConnected = true;
        sessionData.requesterInfo = requesterInfo;
        sessionData.lastActivity = new Date();

        // Update database
        try {
            const query = `
                UPDATE device_sessions 
                SET requester_connected = true, requester_info = $1, last_activity = $2
                WHERE session_id = $3
            `;
            await pool.query(query, [
                JSON.stringify(requesterInfo), 
                sessionData.lastActivity,
                sessionData.sessionId
            ]);
        } catch (error) {
            console.error('Error updating session in database:', error);
        }

        const result = {
            sessionId: sessionData.sessionId,
            signerInfo: {
                username: sessionData.signerUsername,
                deviceInfo: sessionData.signerDeviceInfo
            }
        };

        // Notify WebSocket clients
        if (deviceConnectionWS) {
            deviceConnectionWS.notifyDeviceConnected(sessionData.sessionId, result.signerInfo);
        }

        return result;
    }

    // Send a signing request to the paired device
    async createSigningRequest(sessionId, requestType, requestData, timeoutMs = 60000) {
        const sessionData = this.activeSessions.get(sessionId);
        
        if (!sessionData) {
            throw new Error('Invalid session ID');
        }

        if (!sessionData.requesterConnected) {
            throw new Error('No device connected to this session');
        }

        if (new Date() > sessionData.expiresAt) {
            throw new Error('Session has expired');
        }

        const requestId = this.generateRequestId();
        const request = {
            id: requestId,
            sessionId,
            type: requestType,
            data: requestData,
            timestamp: new Date(),
            expiresAt: new Date(Date.now() + timeoutMs),
            status: 'pending',
            response: null,
            error: null
        };

        this.pendingRequests.set(requestId, request);
        sessionData.lastActivity = new Date();

        // Store in database
        try {
            const query = `
                INSERT INTO device_requests (request_id, session_id, request_type, request_data, timestamp, expires_at, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `;
            await pool.query(query, [
                requestId, sessionId, requestType, 
                JSON.stringify(requestData), request.timestamp, 
                request.expiresAt, request.status
            ]);
        } catch (error) {
            console.error('Error storing request in database:', error);
        }

        // Notify WebSocket clients (signing device)
        if (deviceConnectionWS) {
            deviceConnectionWS.notifySigningRequestReceived(
                sessionId, 
                requestId, 
                requestType, 
                requestData, 
                sessionData.requesterInfo
            );
        }

        return requestId;
    }

    // Get pending requests for a session (polling endpoint for signer)
    getPendingRequests(sessionId) {
        const sessionData = this.activeSessions.get(sessionId);
        
        if (!sessionData) {
            throw new Error('Invalid session ID');
        }

        const requests = [];
        for (const [requestId, request] of this.pendingRequests.entries()) {
            if (request.sessionId === sessionId && request.status === 'pending') {
                if (new Date() > request.expiresAt) {
                    // Mark as expired
                    request.status = 'expired';
                    request.error = 'Request timeout';
                    this.updateRequestInDB(requestId, request);
                } else {
                    requests.push({
                        id: request.id,
                        type: request.type,
                        data: request.data,
                        timestamp: request.timestamp,
                        deviceInfo: sessionData.requesterInfo
                    });
                }
            }
        }

        return requests;
    }

    // Submit response to a signing request
    async respondToRequest(sessionId, requestId, response, error = null) {
        const sessionData = this.activeSessions.get(sessionId);
        
        if (!sessionData) {
            throw new Error('Invalid session ID');
        }

        const request = this.pendingRequests.get(requestId);
        
        if (!request) {
            throw new Error('Invalid request ID');
        }

        if (request.sessionId !== sessionId) {
            throw new Error('Request does not belong to this session');
        }

        if (request.status !== 'pending') {
            throw new Error('Request is no longer pending');
        }

        // Update request
        request.status = error ? 'failed' : 'completed';
        request.response = response;
        request.error = error;
        request.completedAt = new Date();

        sessionData.lastActivity = new Date();

        // Update database
        await this.updateRequestInDB(requestId, request);

        // Notify WebSocket clients (requesting device)
        if (deviceConnectionWS) {
            deviceConnectionWS.notifySigningResponse(sessionId, requestId, response, error);
        }

        return true;
    }

    // Wait for response to a signing request
    async waitForResponse(requestId, timeoutMs = 60000) {
        const request = this.pendingRequests.get(requestId);
        
        if (!request) {
            throw new Error('Invalid request ID');
        }

        const startTime = Date.now();
        
        return new Promise((resolve, reject) => {
            const checkResponse = () => {
                const currentRequest = this.pendingRequests.get(requestId);
                
                if (!currentRequest) {
                    reject(new Error('Request not found'));
                    return;
                }

                if (currentRequest.status === 'completed') {
                    resolve(currentRequest.response);
                    return;
                }

                if (currentRequest.status === 'failed') {
                    reject(new Error(currentRequest.error || 'Request failed'));
                    return;
                }

                if (currentRequest.status === 'expired' || Date.now() - startTime > timeoutMs) {
                    currentRequest.status = 'expired';
                    currentRequest.error = 'Request timeout';
                    this.updateRequestInDB(requestId, currentRequest);
                    reject(new Error('Request timeout'));
                    return;
                }

                // Continue polling
                setTimeout(checkResponse, 1000);
            };

            checkResponse();
        });
    }

    // Disconnect a device session
    disconnectSession(sessionId) {
        const sessionData = this.activeSessions.get(sessionId);
        
        if (sessionData) {
            // Clean up maps
            this.activeSessions.delete(sessionId);
            if (sessionData.pairCode) {
                this.pairCodes.delete(sessionData.pairCode);
            }

            // Clean up pending requests for this session
            for (const [requestId, request] of this.pendingRequests.entries()) {
                if (request.sessionId === sessionId) {
                    this.pendingRequests.delete(requestId);
                }
            }

            // Update database
            try {
                pool.query('UPDATE device_sessions SET disconnected_at = CURRENT_TIMESTAMP WHERE session_id = $1', [sessionId]);
            } catch (error) {
                console.error('Error updating disconnection in database:', error);
            }

            // Notify WebSocket clients
            if (deviceConnectionWS) {
                deviceConnectionWS.notifyDeviceDisconnected(sessionId);
            }
        }
    }

    // Get session status
    getSessionStatus(sessionId) {
        const sessionData = this.activeSessions.get(sessionId);
        
        if (!sessionData) {
            return { isConnected: false };
        }

        return {
            isConnected: true,
            sessionId: sessionData.sessionId,
            pairCode: sessionData.pairCode,
            signerUsername: sessionData.signerUsername,
            requesterConnected: sessionData.requesterConnected,
            createdAt: sessionData.createdAt,
            lastActivity: sessionData.lastActivity,
            expiresAt: sessionData.expiresAt
        };
    }

    // Clean up expired sessions and requests
    cleanup() {
        const now = new Date();
        
        // Clean up expired sessions
        for (const [sessionId, sessionData] of this.activeSessions.entries()) {
            if (now > sessionData.expiresAt) {
                // Notify WebSocket clients about session expiration
                if (deviceConnectionWS) {
                    deviceConnectionWS.notifySessionExpired(sessionId);
                }
                this.disconnectSession(sessionId);
            }
        }

        // Clean up expired pair codes
        for (const [pairCode, sessionData] of this.pairCodes.entries()) {
            if (now > sessionData.expiresAt) {
                this.pairCodes.delete(pairCode);
            }
        }

        // Clean up expired requests
        for (const [requestId, request] of this.pendingRequests.entries()) {
            if (now > request.expiresAt) {
                request.status = 'expired';
                request.error = 'Request timeout';
                this.updateRequestInDB(requestId, request);
                
                // Notify WebSocket clients about timeout
                if (deviceConnectionWS) {
                    deviceConnectionWS.notifyRequestTimeout(request.sessionId, requestId);
                }
                
                this.pendingRequests.delete(requestId);
            }
        }
    }

    // Start cleanup timer
    startCleanup() {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 30000); // Clean up every 30 seconds
    }

    // Stop cleanup timer
    stopCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    // Update request in database
    async updateRequestInDB(requestId, request) {
        try {
            const query = `
                UPDATE device_requests 
                SET status = $1, response = $2, error = $3, completed_at = $4
                WHERE request_id = $5
            `;
            await pool.query(query, [
                request.status,
                request.response ? JSON.stringify(request.response) : null,
                request.error,
                request.completedAt || null,
                requestId
            ]);
        } catch (error) {
            console.error('Error updating request in database:', error);
        }
    }
}

// Create singleton service instance
const deviceService = new DeviceConnectionService();

// Database setup function
async function setupDeviceDatabase() {
    try {
        // Create device sessions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS device_sessions (
                session_id UUID PRIMARY KEY,
                pair_code VARCHAR(6) NOT NULL,
                signer_username VARCHAR(255) NOT NULL,
                signer_device_info JSONB DEFAULT '{}',
                requester_connected BOOLEAN DEFAULT FALSE,
                requester_info JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                disconnected_at TIMESTAMP
            )
        `);

        // Create device requests table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS device_requests (
                request_id UUID PRIMARY KEY,
                session_id UUID NOT NULL,
                request_type VARCHAR(50) NOT NULL,
                request_data JSONB NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                response JSONB,
                error TEXT,
                completed_at TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES device_sessions(session_id) ON DELETE CASCADE
            )
        `);

        // Create indexes for better performance
        await pool.query('CREATE INDEX IF NOT EXISTS idx_pair_code ON device_sessions(pair_code)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_session_expires ON device_sessions(expires_at)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_request_session ON device_requests(session_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_request_status ON device_requests(status)');

        console.log('Device connection database tables created successfully');
    } catch (error) {
        console.error('Error setting up device connection database:', error);
        throw error;
    }
}

// API Endpoints

// POST /api/device/pair - Create a device pairing code
const createPairing = async (req, res) => {
    try {
        const username = req.auth.account;
        const { deviceName, username: bodyUsername } = req.body;
        
        // Use authenticated username, ignore any username in body
        const deviceInfo = {
            deviceName: deviceName || 'Unknown Device',
            ...req.body
        };
        delete deviceInfo.username; // Remove username from deviceInfo

        const result = await deviceService.createPairing(username, deviceInfo);

        res.json({
            success: true,
            pairCode: result.pairCode,
            sessionId: result.sessionId,
            expiresIn: result.expiresIn
        });
    } catch (error) {
        console.error('Error creating pairing:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create pairing code'
        });
    }
};

// POST /api/device/connect - Connect to a device using pairing code
const connectToDevice = async (req, res) => {
    try {
        const { pairCode, deviceName } = req.body;
        
        const requesterInfo = {
            deviceName: deviceName || 'Unknown Device',
            ...req.body.deviceInfo || {}
        };

        if (!pairCode || pairCode.length !== 6) {
            return res.status(400).json({
                success: false,
                error: 'Valid 6-character pairing code is required'
            });
        }

        const result = await deviceService.connectToDevice(pairCode, requesterInfo);

        res.json({
            success: true,
            sessionId: result.sessionId,
            signerInfo: result.signerInfo
        });
    } catch (error) {
        console.error('Error connecting to device:', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

// POST /api/device/request - Send a transaction request to the paired signing device
const createSigningRequest = async (req, res) => {
    try {
        const { sessionId, type, data, timeout = 60000 } = req.body;

        if (!sessionId || !type || !data) {
            return res.status(400).json({
                success: false,
                error: 'sessionId, type, and data are required'
            });
        }

        const requestId = await deviceService.createSigningRequest(sessionId, type, data, timeout);

        res.json({
            success: true,
            requestId
        });
    } catch (error) {
        console.error('Error creating signing request:', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

// GET /api/device/requests - Poll for pending requests (signing device)
const getPendingRequests = async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: 'sessionId is required'
            });
        }

        // Verify the authenticated user owns this session
        const sessionStatus = deviceService.getSessionStatus(sessionId);
        if (!sessionStatus.isConnected || sessionStatus.signerUsername !== req.auth.account) {
            return res.status(403).json({
                success: false,
                error: 'Access denied to this session'
            });
        }

        const requests = deviceService.getPendingRequests(sessionId);

        res.json({
            success: true,
            requests
        });
    } catch (error) {
        console.error('Error getting pending requests:', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

// POST /api/device/respond - Send response to a transaction request
const respondToRequest = async (req, res) => {
    try {
        const { sessionId, requestId, response, error } = req.body;

        if (!sessionId || !requestId) {
            return res.status(400).json({
                success: false,
                error: 'sessionId and requestId are required'
            });
        }

        // Verify the authenticated user owns this session
        const sessionStatus = deviceService.getSessionStatus(sessionId);
        if (!sessionStatus.isConnected || sessionStatus.signerUsername !== req.auth.account) {
            return res.status(403).json({
                success: false,
                error: 'Access denied to this session'
            });
        }

        await deviceService.respondToRequest(sessionId, requestId, response, error);

        res.json({
            success: true
        });
    } catch (error) {
        console.error('Error responding to request:', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

// POST /api/device/disconnect - Disconnect device session
const disconnectDevice = async (req, res) => {
    try {
        const { sessionId } = req.body;

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: 'sessionId is required'
            });
        }

        deviceService.disconnectSession(sessionId);

        res.json({
            success: true
        });
    } catch (error) {
        console.error('Error disconnecting device:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to disconnect device'
        });
    }
};

// GET /api/device/status - Get device connection status
const getDeviceStatus = async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: 'sessionId is required'
            });
        }

        const status = deviceService.getSessionStatus(sessionId);

        res.json({
            success: true,
            status
        });
    } catch (error) {
        console.error('Error getting device status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get device status'
        });
    }
};

// POST /api/device/wait-response - Wait for response to a signing request
const waitForResponse = async (req, res) => {
    try {
        const { requestId, timeout = 60000 } = req.body;

        if (!requestId) {
            return res.status(400).json({
                success: false,
                error: 'requestId is required'
            });
        }

        const response = await deviceService.waitForResponse(requestId, timeout);

        res.json({
            success: true,
            response
        });
    } catch (error) {
        console.error('Error waiting for response:', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

// GET /api/device/test - Test endpoint to verify device connection system
const testDeviceConnection = async (req, res) => {
    try {
        res.json({
            success: true,
            message: 'Device connection system is operational',
            timestamp: new Date().toISOString(),
            activeSessions: deviceService.activeSessions.size,
            pendingRequests: deviceService.pendingRequests.size,
            pairCodes: deviceService.pairCodes.size,
            websocketSupport: true
        });
    } catch (error) {
        console.error('Error in device connection test:', error);
        res.status(500).json({
            success: false,
            error: 'Device connection system error'
        });
    }
};



module.exports = {
    deviceService,
    setupDeviceDatabase,
    setWebSocketInstance,
    // API endpoints
    createPairing,
    connectToDevice,
    createSigningRequest,
    getPendingRequests,
    respondToRequest,
    disconnectDevice,
    getDeviceStatus,
    waitForResponse,
    testDeviceConnection
}; 