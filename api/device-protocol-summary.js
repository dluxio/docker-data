// Device Connection Protocol Summary
const getProtocolSummary = async (req, res) => {
    try {
        res.json({
            success: true,
            protocolVersion: "1.1.0",
            lastUpdated: "2025-06-07",
            summary: "Updated DLUX Device Connection Protocol with WebSocket support and enhanced messaging",
            
            apiEndpoints: {
                "POST /api/device/pair": {
                    description: "Create a device pairing code",
                    authentication: "Required (HIVE auth headers)",
                    body: {
                        deviceName: "string (optional) - Name of the signing device",
                        username: "string (ignored) - Will use authenticated username"
                    },
                    response: {
                        success: "boolean",
                        pairCode: "string (6 chars)",
                        sessionId: "string (UUID)",
                        expiresIn: "number (300 seconds)"
                    }
                },
                
                "POST /api/device/connect": {
                    description: "Connect to a device using pairing code",
                    authentication: "None required",
                    body: {
                        pairCode: "string (6 chars) - Pairing code from signing device",
                        deviceName: "string (optional) - Name of the requesting device"
                    },
                    response: {
                        success: "boolean",
                        sessionId: "string (UUID)",
                        signerInfo: {
                            username: "string",
                            deviceName: "string"
                        }
                    }
                },
                
                "POST /api/device/request": {
                    description: "Send a transaction request to paired signing device",
                    body: {
                        sessionId: "string (UUID)",
                        type: "string (e.g., 'sign-transaction')",
                        data: "object (transaction or challenge data)",
                        timeout: "number (optional, default 60000ms)"
                    }
                },
                
                "GET /api/device/requests": {
                    description: "Poll for pending requests (signing device)",
                    authentication: "Required (HIVE auth headers)",
                    fallbackFor: "WebSocket communication"
                },
                
                "POST /api/device/respond": {
                    description: "Send response to a transaction request (REST fallback)",
                    authentication: "Required (HIVE auth headers)",
                    fallbackFor: "WebSocket communication"
                }
            },
            
            websocketProtocol: {
                url: "wss://data.dlux.io/ws/payment-monitor",
                description: "Real-time bidirectional communication for device connections",
                
                clientToServerMessages: {
                    device_subscribe: {
                        description: "Subscribe to device session events",
                        required: ["sessionId", "userType"],
                        userType: "signer|requester"
                    },
                    
                    device_signing_response: {
                        description: "Send signing response (signer only)",
                        required: ["sessionId", "requestId"],
                        optional: ["response", "error", "timestamp"],
                        restriction: "Only clients with userType 'signer' can send this"
                    },
                    
                    device_ack: {
                        description: "Acknowledge receipt of critical message",
                        required: ["messageId"],
                        purpose: "Confirm delivery of signing requests/responses"
                    }
                },
                
                serverToClientMessages: {
                    device_session_status: {
                        description: "Session status update",
                        sentOn: "WebSocket subscription",
                        audience: "subscriber"
                    },
                    
                    device_connected: {
                        description: "Device successfully connected",
                        audience: "all users in session",
                        includes: ["signerInfo"]
                    },
                    
                    device_signing_request: {
                        description: "New signing request",
                        audience: "signer only",
                        requiresAck: true,
                        includes: ["sessionId", "requestId", "requestType", "data", "deviceInfo", "timestamp"]
                    },
                    
                    device_signing_response: {
                        description: "Signing request completed",
                        audience: "requester only", 
                        requiresAck: true,
                        includes: ["sessionId", "requestId", "response", "error", "success"]
                    },
                    
                    device_request_timeout: {
                        description: "Signing request timed out",
                        audience: "both signer and requester",
                        includes: ["sessionId", "requestId", "message"]
                    },
                    
                    device_session_expired: {
                        description: "Session has expired",
                        audience: "all users in session"
                    },
                    
                    device_disconnected: {
                        description: "Device disconnected",
                        audience: "all users in session"
                    },
                    
                    device_delivery_failed: {
                        description: "Message delivery failed after retries",
                        audience: "all users in session"
                    },
                    
                    device_response_accepted: {
                        description: "Signing response was accepted",
                        audience: "signer (confirmation)",
                        includes: ["sessionId", "requestId", "timestamp"]
                    }
                }
            },
            
            reliabilityFeatures: {
                acknowledgments: {
                    description: "Critical messages require client acknowledgment",
                    timeout: "5 seconds",
                    retries: "Up to 3 attempts",
                    criticalMessages: ["device_signing_request", "device_signing_response"]
                },
                
                fallbackPolling: {
                    description: "REST endpoints available if WebSocket fails",
                    endpoints: ["GET /api/device/requests", "POST /api/device/respond"]
                },
                
                sessionManagement: {
                    pairingExpiry: "5 minutes",
                    sessionExpiry: "60 minutes",
                    requestTimeout: "60 seconds (configurable)",
                    automaticCleanup: "Every 30 seconds"
                }
            },
            
            security: {
                authentication: "HIVE blockchain signatures for pairing/signing operations",
                sessionIsolation: "Each session has unique UUID",
                userTypeValidation: "Messages only sent to appropriate user types",
                noDirectConnection: "All communication routed through secure backend"
            },
            
            messageTargeting: {
                "ALL users": ["device_connected", "device_disconnected", "device_session_expired", "device_delivery_failed"],
                "SIGNER only": ["device_signing_request"],
                "REQUESTER only": ["device_signing_response"],  
                "BOTH (same message)": ["device_request_timeout"]
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = { getProtocolSummary }; 