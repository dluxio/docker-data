# WebSocket Connection Debugging Guide

## Current Issue Analysis

Based on the logs, we can see:

1. ✅ **Origin validation works**: `WebSocket connection allowed from: https://vue.dlux.io`
2. ✅ **Connection establishes**: `WebSocket connection established`  
3. ❌ **Connection immediately closes**: `WebSocket connection closed`
4. ❌ **Client gets error event**: Browser shows WebSocket error

## Likely Causes

### 1. **Database Query Issue**
When a client connects and tries to subscribe to a channel, the server queries the database. If there's a database connection error or the channel doesn't exist, this could cause the connection to close.

### 2. **Client-Side Subscription Issue** 
Your frontend might be immediately sending a `subscribe` message for a channel that doesn't exist in the database, causing an error that closes the connection.

### 3. **Message Format Issue**
The client might be sending a message in an unexpected format.

## Debugging Steps

### Step 1: Test with HTML Client
Open the `test-client-websocket.html` file in your browser and:

1. Connect to `wss://data.dlux.io/ws/payment-monitor`
2. **DON'T** immediately subscribe to a channel
3. Just send a ping first
4. Check if the connection stays open

### Step 2: Check Server Logs
After the enhanced logging, you should see detailed logs like:

```
WebSocket connection attempt from origin: https://vue.dlux.io
WebSocket connection allowed from: https://vue.dlux.io
WebSocket connection established from 1.2.3.4 (Origin: https://vue.dlux.io)
User Agent: Mozilla/5.0...
Sending welcome message: {"type":"connected","message":"WebSocket connection established"...}
```

If you see a message like this immediately after:
```
WebSocket message received: {"type":"subscribe","channelId":"someId"}
Client subscribing to channel: someId
Sending channel status for: someId
Database connection established for channel status
Database query result: 0 rows found
Channel someId not found in database
```

Then the issue is that your frontend is trying to subscribe to a non-existent channel.

### Step 3: Fix Frontend Code
If the issue is frontend subscription, you need to modify your frontend JavaScript to:

1. **Wait for connection confirmation** before subscribing
2. **Handle subscription errors gracefully**
3. **Only subscribe to valid channels**

Example fix for your frontend:

```javascript
// Wait for connection before subscribing
ws.onopen = function() {
    console.log('WebSocket connected');
    // DON'T immediately subscribe here
};

ws.onmessage = function(event) {
    const data = JSON.parse(event.data);
    
    if (data.type === 'connected') {
        console.log('Server confirmed connection');
        // NOW it's safe to subscribe
        if (validChannelId) {
            ws.send(JSON.stringify({
                type: 'subscribe',
                channelId: validChannelId
            }));
        }
    }
    
    if (data.type === 'error') {
        console.error('Server error:', data.message);
        // Handle the error instead of letting connection close
    }
};
```

## Quick Fixes

### Fix 1: Make the Server More Robust
The server should handle non-existent channels gracefully without closing connections.

### Fix 2: Client Should Handle Errors
The client should handle subscription errors without closing the connection.

### Fix 3: Only Subscribe When Needed
The client should only subscribe to channels that actually exist.

## Testing Commands

### Test WebSocket with curl (if curl supports WebSocket)
```bash
# Test with node script
node test-websocket.js --url wss://data.dlux.io/ws/payment-monitor --origin https://vue.dlux.io
```

### Test Direct Connection
```bash
# Use the HTML test client
python3 -m http.server 8000
# Then open http://localhost:8000/test-client-websocket.html
```

## Expected Behavior Flow

1. **Client connects** → Server allows connection based on origin
2. **Server sends welcome message** → Client receives connection confirmation  
3. **Client sends ping** → Server responds with pong
4. **Client subscribes to valid channel** → Server sends channel status
5. **Connection stays open** → Real-time updates work

## Common Issues and Solutions

### Issue: "WebSocket error Event"
**Cause**: Connection closes immediately after opening
**Solution**: Check server logs for database errors or invalid subscriptions

### Issue: "Channel not found"
**Cause**: Frontend subscribing to non-existent channel
**Solution**: Only subscribe to channels created via `/api/onboarding/payment/initiate`

### Issue: Database connection errors
**Cause**: PostgreSQL connection issues
**Solution**: Check database connectivity and pool configuration

## Next Steps

1. **Check current logs** - Look for the detailed logging we added
2. **Test with HTML client** - Use the test client to isolate the issue
3. **Fix frontend code** - Modify client-side WebSocket handling
4. **Add error recovery** - Make the client more resilient to errors

## Production Recommendations

1. **Add connection retry logic** in frontend
2. **Implement exponential backoff** for reconnections
3. **Show user-friendly error messages** instead of silent failures
4. **Add health check endpoint** for WebSocket monitoring
5. **Set up alerts** for WebSocket connection failures 