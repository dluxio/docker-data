# DLUX Device Connection System

The DLUX Device Connection System enables secure wallet functionality across multiple devices, perfect for VR headsets, mobile phones, tablets, and public computers. This system allows one device to request transactions while another device with wallet access provides secure signing.

## Overview

The device connection system works by:

1. **Pairing**: A device with wallet access creates a 6-digit pairing code
2. **Connection**: Another device uses this code to establish a secure connection
3. **Remote Signing**: The requesting device can send transactions to the signing device
4. **User Confirmation**: All operations require explicit user approval on the signing device

## Use Cases

- **VR Headsets**: Use your phone to sign transactions while in VR
- **Public Computers**: Keep your wallet on your phone, use public terminals safely
- **Shared Devices**: Multiple users can request signing from their personal devices
- **Kiosks**: Interactive displays can request wallet operations from users' phones

## API Reference

### Device Pairing (Signing Device)

#### `requestDevicePairing()`

Creates a 6-digit pairing code that other devices can use to connect.

```javascript
// Create pairing code (requires logged in user)
try {
    const pairCode = await dluxWallet.requestDevicePairing();
    console.log('Share this code:', pairCode); // e.g., "A3X9K2"
} catch (error) {
    console.error('Pairing failed:', error.message);
}
```

**Returns**: `Promise<string>` - The 6-digit pairing code

**Requirements**: User must be logged in with any supported wallet method

**Events Triggered**: `dlux-wallet-device-pairing-created`

### Device Connection (Requesting Device)

#### `connectToDevice(pairCode)`

Connect to another device using a 6-digit pairing code.

```javascript
// Connect to device using pairing code
try {
    const success = await dluxWallet.connectToDevice('A3X9K2');
    if (success) {
        console.log('Connected successfully!');
    }
} catch (error) {
    console.error('Connection failed:', error.message);
}
```

**Parameters**:
- `pairCode` (string): 6-character pairing code from signing device

**Returns**: `Promise<boolean>` - True if connection successful

**Events Triggered**: `dlux-wallet-device-connected`

### Remote Transaction Signing

#### `requestRemoteSign(transaction, options)`

Send a transaction to the connected signing device for approval and signing.

```javascript
// Example vote transaction
const transaction = [
    'username',
    [
        [
            'vote',
            {
                voter: 'signer_username',
                author: 'disregardfiat',
                permlink: 'post-permlink',
                weight: 10000
            }
        ]
    ],
    'posting'
];

// Request remote signing
try {
    const result = await dluxWallet.requestRemoteSign(transaction, {
        broadcast: true, // Default true
        timeout: 60000   // 60 seconds, default
    });
    
    if (result.signed) {
        console.log('Transaction signed and broadcasted!');
        console.log('TX ID:', result.id);
    }
} catch (error) {
    console.error('Remote signing failed:', error.message);
}
```

**Parameters**:
- `transaction` (Array): Standard Hive transaction format
- `options` (Object, optional):
  - `broadcast` (boolean): Whether to broadcast after signing (default: true)
  - `timeout` (number): Timeout in milliseconds (default: 60000)

**Returns**: `Promise<Object>` - Transaction result with `signed` flag and potential `id`

#### `requestRemoteSignChallenge(challenge, keyType, options)`

Send a challenge/buffer to the connected signing device for signing.

```javascript
// Sign a challenge
try {
    const signature = await dluxWallet.requestRemoteSignChallenge(
        'challenge-string-123',
        'posting', // or 'active', 'memo'
        { timeout: 30000 }
    );
    
    console.log('Challenge signed:', signature);
} catch (error) {
    console.error('Remote challenge signing failed:', error.message);
}
```

**Parameters**:
- `challenge` (string): Challenge string to sign
- `keyType` (string): Key type to use ('posting', 'active', 'memo')
- `options` (Object, optional):
  - `timeout` (number): Timeout in milliseconds (default: 60000)

**Returns**: `Promise<string>` - The signature

### Device Management

#### `disconnectDevice()`

Disconnect from the paired device.

```javascript
// Disconnect from device
await dluxWallet.disconnectDevice();
console.log('Device disconnected');
```

**Returns**: `Promise<void>`

**Events Triggered**: `dlux-wallet-device-disconnected`

#### `getDeviceStatus()`

Get current device connection status.

```javascript
const status = dluxWallet.getDeviceStatus();
console.log('Device Status:', {
    isConnected: status.isConnected,
    role: status.role, // 'signer' or 'requester'
    sessionId: status.sessionId,
    pairCode: status.pairCode // Only on signing device
});
```

**Returns**: `Object` - Device connection status

## Events

The device connection system emits several events you can listen for:

### `dlux-wallet-device-pairing-created`

Fired when a pairing code is successfully created.

```javascript
dluxWallet.on('device-pairing-created', (data) => {
    console.log('Pairing code:', data.pairCode);
    console.log('Expires in:', data.expiresIn, 'seconds');
});
```

### `dlux-wallet-device-connected`

Fired when a device successfully connects.

```javascript
dluxWallet.on('device-connected', (data) => {
    console.log('Connected! Session:', data.sessionId);
    console.log('Signer info:', data.signerInfo);
});
```

### `dlux-wallet-device-disconnected`

Fired when device connection is terminated.

```javascript
dluxWallet.on('device-disconnected', () => {
    console.log('Device disconnected');
});
```

### `dlux-wallet-device-request-received`

Fired on the signing device when a request is received.

```javascript
dluxWallet.on('device-request-received', (data) => {
    console.log('Request type:', data.request.type);
    console.log('Request data:', data.request.data);
});
```

## Security Model

### Authentication
- Pairing requires an authenticated user with any supported wallet method
- Each pairing code is unique and expires in 5 minutes
- Sessions are cryptographically secured and expire automatically

### User Consent
- Every transaction requires explicit user approval on the signing device
- Users see full transaction details before confirming
- Users can cancel any operation at any time

### Network Security
- All communication is routed through the secure data.dlux.io backend
- No direct device-to-device communication
- Session tokens prevent unauthorized access

### Privacy
- Device names and identifying information are minimal
- Session data is temporary and automatically cleaned up
- No transaction data is permanently stored on backend

## Backend API Endpoints

The following endpoints are used by the client (implemented at data.dlux.io):

### WebSocket Connection (Recommended)

For real-time communication, connect to the WebSocket endpoint instead of polling:

**WebSocket URL**: `wss://data.dlux.io/ws/payment-monitor`

**Subscribe to device events**:
```javascript
// Connect to WebSocket
const ws = new WebSocket('wss://data.dlux.io/ws/payment-monitor');

// Subscribe to device session events
ws.send(JSON.stringify({
    type: 'device_subscribe',
    sessionId: 'your-session-id',
    userType: 'signer' // or 'requester'
}));

// Listen for device events
ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    switch (data.type) {
        case 'device_pairing_created':
            console.log('Pairing code:', data.pairCode);
            break;
        case 'device_connected':
            console.log('Device connected:', data.signerInfo);
            break;
        case 'device_signing_request':
            console.log('New signing request:', data.requestData);
            break;
        case 'device_signing_response':
            console.log('Signing response:', data.response);
            break;
        case 'device_disconnected':
            console.log('Device disconnected');
            break;
    }
};
```

**WebSocket Events**:
- `device_pairing_created` - Pairing code created
- `device_connected` - Device successfully connected
- `device_disconnected` - Device disconnected
- `device_signing_request` - New signing request received (signer only)
- `device_signing_response` - Signing request completed (requester only)
- `device_session_expired` - Session expired
- `device_request_timeout` - Request timed out

### REST API Endpoints

### `POST /api/device/pair`

Create a device pairing code.

**Headers Required**:
```
x-account: [hive_username]
x-challenge: [unix_timestamp]
x-pubkey: [public_key]
x-signature: [signature]
```

**Response**:
```json
{
    "success": true,
    "pairCode": "A3X9K2",
    "sessionId": "session_uuid",
    "expiresIn": 300
}
```

### `POST /api/device/connect`

Connect to a device using a pairing code.

**Body**:
```json
{
    "pairCode": "A3X9K2"
}
```

**Response**:
```json
{
    "success": true,
    "sessionId": "session_uuid",
    "signerInfo": {
        "username": "signer_username",
        "deviceName": "Phone"
    }
}
```

### `POST /api/device/request`

Send a transaction request to the paired signing device.

**Body**:
```json
{
    "sessionId": "session_uuid",
    "type": "sign-transaction",
    "data": {
        "transaction": [...],
        "broadcast": true
    },
    "timeout": 60000
}
```

**Response**:
```json
{
    "success": true,
    "requestId": "request_uuid"
}
```

### `GET /api/device/requests?sessionId=uuid`

Poll for pending requests (signing device). **Note: WebSocket subscription is recommended instead of polling.**

**Response**:
```json
{
    "success": true,
    "requests": [
        {
            "id": "request_uuid",
            "type": "sign-transaction",
            "data": {...},
            "deviceInfo": {...},
            "timestamp": 1234567890
        }
    ]
}
```

### `POST /api/device/respond`

Send response to a transaction request.

**Body**:
```json
{
    "sessionId": "session_uuid",
    "requestId": "request_uuid",
    "response": {...},
    "error": null
}
```

### `POST /api/device/disconnect`

Disconnect device session.

**Body**:
```json
{
    "sessionId": "session_uuid"
}
```

### `GET /api/device/websocket-info`

Get WebSocket connection information and supported events.

**Response**:
```json
{
    "success": true,
    "websocketUrl": "/ws/payment-monitor",
    "supportedEvents": [...],
    "instructions": {...}
}
```

## Integration Examples

### VR Headset Integration

```javascript
// In VR application
async function setupVRWallet() {
    // Check if we can connect to an existing session
    const deviceStatus = dluxWallet.getDeviceStatus();
    
    if (!deviceStatus.isConnected) {
        // Show pairing code input in VR interface
        const pairCode = await showVRPairingInput();
        await dluxWallet.connectToDevice(pairCode);
    }
    
    // Now we can request signatures remotely
    dluxWallet.on('device-connected', () => {
        showVRNotification('Wallet connected! You can now sign transactions.');
    });
}

async function voteInVR(author, permlink, weight) {
    const transaction = [
        '', // Username will be filled by signer
        [['vote', { voter: '', author, permlink, weight }]],
        'posting'
    ];
    
    try {
        showVRNotification('Check your phone to approve transaction...');
        const result = await dluxWallet.requestRemoteSign(transaction);
        showVRNotification('Vote successful!');
    } catch (error) {
        showVRNotification('Vote failed: ' + error.message);
    }
}
```

### Mobile Phone Signer

```javascript
// On mobile phone (signing device)
async function startMobileSigner() {
    if (!dluxWallet.currentUser) {
        // Prompt user to login first
        await promptUserLogin();
    }
    
    // Create pairing code
    const pairCode = await dluxWallet.requestDevicePairing();
    
    // Show pairing code to user
    showPairingCodeModal(pairCode);
    
    // Listen for incoming requests
    dluxWallet.on('device-request-received', (data) => {
        // The v3-nav component will handle showing confirmation dialogs
        console.log('Incoming request from connected device');
    });
}
```

## Best Practices

### For Requesting Devices (VR, Kiosks, etc.)
1. Always check connection status before attempting operations
2. Provide clear feedback about waiting for signing device
3. Implement reasonable timeouts for user experience
4. Handle disconnections gracefully

### For Signing Devices (Phones, Tablets, etc.)
1. Only create pairing codes when user explicitly requests
2. Display pairing codes clearly and securely
3. Automatically disconnect after period of inactivity
4. Provide clear indication of connected devices

### Security Recommendations
1. Use HTTPS only for all communications
2. Validate all transaction data before presenting to users
3. Implement session timeouts appropriate for your use case
4. Log security-relevant events for audit purposes

## Troubleshooting

### Common Issues

**"No master domain available"**
- Ensure device has internet connection
- Check that dlux.io, vue.dlux.io, or www.dlux.io are accessible

**"Failed to create pairing code"**
- User must be logged in with a supported wallet method
- Check network connectivity to data.dlux.io

**"Connection failed"**
- Verify pairing code is correct (6 characters)
- Ensure pairing code hasn't expired (5 minute limit)
- Check that signing device is still online

**"Remote signing timeout"**
- User may have dismissed confirmation dialog
- Check signing device is still connected
- Verify signing device user is logged in

### Debug Information

Enable debug logging to troubleshoot issues:

```javascript
// Enable debug mode
window.dluxWalletDebug = true;

// Check connection status
console.log('Wallet Status:', dluxWallet.getStatus());
console.log('Device Status:', dluxWallet.getDeviceStatus());
```

## Future Enhancements

Planned improvements to the device connection system:

- WebSocket support for real-time communication
- Multi-device support (connect multiple requesting devices)
- Device management interface (see all connected devices)
- Enhanced security with device fingerprinting
- Biometric authentication integration
- QR code pairing as alternative to text codes 