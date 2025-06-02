const WebSocket = require('ws');
const http = require('http');
const express = require('express');

// Create minimal express app
const app = express();
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({
    server,
    path: '/ws/test-simple'
});

wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    console.log(`Simple WebSocket connected from origin: ${origin}`);
    
    // Don't send any welcome message immediately
    console.log('Connection established, not sending welcome message yet');
    
    ws.on('message', (message) => {
        console.log('Received message:', message.toString());
        
        try {
            const data = JSON.parse(message);
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', message: 'Simple pong' }));
            } else if (data.type === 'hello') {
                ws.send(JSON.stringify({ 
                    type: 'welcome', 
                    message: 'Hello from simple server',
                    timestamp: new Date().toISOString()
                }));
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`Simple WebSocket closed - Code: ${code}, Reason: ${reason || 'No reason'}`);
    });
    
    ws.on('error', (error) => {
        console.error('Simple WebSocket error:', error);
    });
});

const PORT = process.env.TEST_WS_PORT || 3001;

server.listen(PORT, () => {
    console.log(`Simple WebSocket test server running on port ${PORT}`);
    console.log(`Test URL: ws://localhost:${PORT}/ws/test-simple`);
    console.log('');
    console.log('Test instructions:');
    console.log('1. Connect to ws://localhost:3001/ws/test-simple');
    console.log('2. Send: {"type":"ping"} - should get pong back');
    console.log('3. Send: {"type":"hello"} - should get welcome message');
    console.log('');
    console.log('This will help isolate if the issue is with:');
    console.log('- WebSocket protocol handling');
    console.log('- Message content/format');
    console.log('- Immediate message sending');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down simple WebSocket test server...');
    server.close();
});

process.on('SIGINT', () => {
    console.log('Shutting down simple WebSocket test server...');
    server.close();
    process.exit(0);
}); 