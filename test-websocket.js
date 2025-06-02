#!/usr/bin/env node
/**
 * WebSocket Connection Tester for DLUX API
 * 
 * This script tests WebSocket connections to the payment monitor endpoint
 * with different origin headers to verify CORS configuration.
 */

const WebSocket = require('ws');

// Test configurations
const TEST_CONFIGS = [
    {
        name: 'Production vue.dlux.io',
        url: 'wss://api.dlux.io/ws/payment-monitor',
        origin: 'https://vue.dlux.io'
    },
    {
        name: 'Production www.dlux.io',
        url: 'wss://api.dlux.io/ws/payment-monitor',
        origin: 'https://www.dlux.io'
    },
    {
        name: 'Production dlux.io',
        url: 'wss://api.dlux.io/ws/payment-monitor',
        origin: 'https://dlux.io'
    },
    {
        name: 'Local development',
        url: 'ws://localhost:3000/ws/payment-monitor',
        origin: 'http://localhost:8080'
    },
    {
        name: 'No origin header',
        url: 'ws://localhost:3000/ws/payment-monitor',
        origin: null
    }
];

function testWebSocketConnection(config) {
    return new Promise((resolve) => {
        console.log(`\n🔌 Testing: ${config.name}`);
        console.log(`   URL: ${config.url}`);
        console.log(`   Origin: ${config.origin || 'None'}`);

        const options = {
            headers: config.origin ? { 'Origin': config.origin } : {}
        };

        const ws = new WebSocket(config.url, options);
        
        const timeout = setTimeout(() => {
            ws.terminate();
            console.log(`   ❌ TIMEOUT - Connection took too long`);
            resolve({ success: false, error: 'timeout' });
        }, 5000);

        ws.on('open', () => {
            clearTimeout(timeout);
            console.log(`   ✅ CONNECTED successfully`);
            
            // Send a ping to test bidirectional communication
            ws.send(JSON.stringify({ type: 'ping' }));
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                console.log(`   📨 Received: ${message.type} - ${message.message || 'No message'}`);
                
                if (message.type === 'pong') {
                    console.log(`   ✅ PING/PONG successful`);
                    ws.close();
                    resolve({ success: true });
                }
            } catch (error) {
                console.log(`   📨 Received raw: ${data}`);
            }
        });

        ws.on('close', (code, reason) => {
            clearTimeout(timeout);
            console.log(`   🔌 CLOSED - Code: ${code}, Reason: ${reason || 'No reason given'}`);
            
            if (code === 1000) {
                resolve({ success: true });
            } else {
                resolve({ success: false, error: `Closed with code ${code}`, reason });
            }
        });

        ws.on('error', (error) => {
            clearTimeout(timeout);
            console.log(`   ❌ ERROR - ${error.message}`);
            resolve({ success: false, error: error.message });
        });
    });
}

async function runTests() {
    console.log('🚀 DLUX WebSocket Connection Tester');
    console.log('=====================================');

    const results = [];

    for (const config of TEST_CONFIGS) {
        const result = await testWebSocketConnection(config);
        results.push({ config, result });
        
        // Wait a bit between tests
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Summary
    console.log('\n📊 TEST SUMMARY');
    console.log('================');
    
    results.forEach(({ config, result }) => {
        const status = result.success ? '✅ PASS' : '❌ FAIL';
        const error = result.error ? ` (${result.error})` : '';
        console.log(`${status} ${config.name}${error}`);
    });

    const successful = results.filter(r => r.result.success).length;
    const total = results.length;
    
    console.log(`\n🎯 ${successful}/${total} tests passed`);

    if (successful < total) {
        console.log('\n🔧 TROUBLESHOOTING TIPS:');
        console.log('- Check if the server is running');
        console.log('- Verify CORS/origin configuration in wsmonitor.js');
        console.log('- Check reverse proxy configuration');
        console.log('- Look at server logs for WebSocket connection attempts');
        console.log('- Ensure firewall allows WebSocket connections');
    }
}

// Handle command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('DLUX WebSocket Connection Tester');
    console.log('');
    console.log('Usage: node test-websocket.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --help, -h     Show this help message');
    console.log('  --url URL      Test specific WebSocket URL');
    console.log('  --origin URL   Set origin header for the test');
    console.log('');
    console.log('Examples:');
    console.log('  node test-websocket.js');
    console.log('  node test-websocket.js --url ws://localhost:3000/ws/payment-monitor --origin https://vue.dlux.io');
    process.exit(0);
}

// Check for custom URL and origin
const urlIndex = process.argv.indexOf('--url');
const originIndex = process.argv.indexOf('--origin');

if (urlIndex !== -1 && urlIndex + 1 < process.argv.length) {
    const customUrl = process.argv[urlIndex + 1];
    const customOrigin = originIndex !== -1 && originIndex + 1 < process.argv.length 
        ? process.argv[originIndex + 1] 
        : null;
    
    console.log('🎯 Running custom test');
    testWebSocketConnection({
        name: 'Custom Test',
        url: customUrl,
        origin: customOrigin
    }).then(() => process.exit(0));
} else {
    // Run all tests
    runTests().then(() => process.exit(0));
} 