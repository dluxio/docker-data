// Test message direction for device WebSocket functionality
const { deviceService } = require('./device-connection');
const { deviceConnectionWS } = require('./device-connection-ws');

const testMessageDirection = async (req, res) => {
    try {
        // Create a test session
        const testSession = await deviceService.createPairing('testuser', { deviceName: 'Test Device' });
        
        // Simulate connecting a requester
        await deviceService.connectToDevice(testSession.pairCode, { deviceName: 'Test Requester' });
        
        // Create a test signing request
        const requestId = await deviceService.createSigningRequest(
            testSession.sessionId,
            'sign-transaction',
            { test: 'transaction data' }
        );
        
        // Simulate a response
        await deviceService.respondToRequest(
            testSession.sessionId,
            requestId,
            { signature: 'test-signature' }
        );
        
        // Get WebSocket stats
        const wsStats = deviceConnectionWS.getConnectedClients();
        
        res.json({
            success: true,
            message: 'Message direction test completed',
            testFlow: {
                step1: 'Created pairing code → Notifies ALL users in session',
                step2: 'Device connected → Notifies ALL users in session', 
                step3: 'Signing request created → Notifies SIGNER only (requires ACK)',
                step4: 'Signing response sent → Notifies REQUESTER only (requires ACK)',
                step5: 'Timeout would notify → BOTH signer and requester (different messages)'
            },
            testSession: {
                sessionId: testSession.sessionId,
                pairCode: testSession.pairCode,
                requestId: requestId
            },
            websocketStats: wsStats,
            messageTargeting: {
                'device_pairing_created': 'ALL users in session',
                'device_connected': 'ALL users in session',
                'device_disconnected': 'ALL users in session',
                'device_signing_request': 'SIGNER only (userType: signer) [REQUIRES ACK]',
                'device_signing_response': 'REQUESTER only (userType: requester) [REQUIRES ACK]',
                'device_request_timeout': 'BOTH (different messages for each userType)',
                'device_session_expired': 'ALL users in session',
                'device_delivery_failed': 'ALL users in session'
            },
            instructions: {
                signerConnection: `Connect as signer: {"type": "device_subscribe", "sessionId": "${testSession.sessionId}", "userType": "signer"}`,
                requesterConnection: `Connect as requester: {"type": "device_subscribe", "sessionId": "${testSession.sessionId}", "userType": "requester"}`,
                note: 'Signer should receive signing_request messages, Requester should receive signing_response messages'
            }
        });
    } catch (error) {
        console.error('Message direction test error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = { testMessageDirection }; 