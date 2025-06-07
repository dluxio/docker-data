// Test API endpoint for device WebSocket functionality
const { deviceService } = require('./device-connection');
const { deviceConnectionWS } = require('./device-connection-ws');

const testWebSocketIntegration = async (req, res) => {
    try {
        // Create a test session
        const testSession = await deviceService.createPairing('testuser', { deviceName: 'Test Device' });
        
        // Get WebSocket stats
        const wsStats = deviceConnectionWS.getConnectedClients();
        
        // Test WebSocket notification (if any clients connected)
        if (wsStats.totalClients > 0) {
            deviceConnectionWS.notifyPairingCreated(testSession.sessionId, testSession.pairCode, 300);
            
            // Test critical message with ACK
            setTimeout(() => {
                deviceConnectionWS.notifySigningRequestReceived(
                    testSession.sessionId,
                    'test-request-123',
                    'sign-transaction',
                    { test: 'data' },
                    { deviceName: 'Test Requester' }
                );
            }, 1000);
        }
        
        res.json({
            success: true,
            message: 'WebSocket integration test completed',
            testSession: {
                sessionId: testSession.sessionId,
                pairCode: testSession.pairCode,
                expiresIn: testSession.expiresIn
            },
            websocketStats: wsStats,
            instructions: {
                connect: 'Connect to WebSocket at wss://data.dlux.io/ws/payment-monitor',
                subscribe: `Send: {"type": "device_subscribe", "sessionId": "${testSession.sessionId}", "userType": "signer"}`,
                testNotification: wsStats.totalClients > 0 ? 'Notifications sent to connected clients (including ACK test)' : 'No clients connected to receive notification',
                acknowledgments: 'Critical messages require ACK response: {"type": "device_ack", "messageId": "received-message-id"}'
            }
        });
    } catch (error) {
        console.error('WebSocket integration test error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = { testWebSocketIntegration }; 