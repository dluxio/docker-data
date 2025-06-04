# Blockchain Monitoring System

This document describes the comprehensive blockchain monitoring system implemented to handle real cryptocurrency payments for HIVE account creation.

## Overview

The system has been upgraded from an "honor system" to real blockchain monitoring with automatic payment verification and account creation.

## Supported Cryptocurrencies

- **Bitcoin (BTC)** - NEW! 
- **Ethereum (ETH)**
- **BNB Smart Chain (BNB)**
- **Polygon (MATIC)**
- **Solana (SOL)**

## Key Features

### 1. Real-time Blockchain Monitoring

- **Automatic Payment Detection**: Monitors payment addresses for incoming transactions
- **Transaction Verification**: Validates transactions against payment requirements (amount, address, timing)
- **Confirmation Tracking**: Tracks blockchain confirmations until required threshold is met
- **Multiple API Endpoints**: Uses multiple blockchain APIs for redundancy

### 2. Transaction Verification

- **Amount Validation**: Checks payment amount with 5% tolerance for network fees
- **Address Verification**: Ensures payment sent to correct address
- **Timing Validation**: Confirms transaction occurred after payment channel creation
- **Memo Support**: Validates memos where applicable (Bitcoin uses channel ID tracking)

### 3. Automatic Account Creation

- **Seamless Flow**: Automatically creates HIVE accounts when payments are fully confirmed
- **ACT Integration**: Uses Account Creation Tokens when available for cost efficiency
- **Fallback to Delegation**: Falls back to HIVE delegation if ACTs unavailable
- **Status Updates**: Real-time WebSocket updates throughout the process

## API Environment Variables

Add these to your `.env` file:

```bash
# Bitcoin
BTC_PAYMENT_ADDRESS=bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh

# Existing addresses
SOL_PAYMENT_ADDRESS=HLPSpmHEh9dvHhqhCtvutuffjfhxaFzFAvYNxRdTasqx
ETH_PAYMENT_ADDRESS=0x742e637BC6dc9e0dA3Bb4CD0cE2BE4e9d5fD8a6B
MATIC_PAYMENT_ADDRESS=0x742e637BC6dc9e0dA3Bb4CD0cE2BE4e9d5fD8a6B
BNB_PAYMENT_ADDRESS=0x742e637BC6dc9e0dA3Bb4CD0cE2BE4e9d5fD8a6B

# API Keys (optional but recommended for production)
ETHERSCAN_API_KEY=your_etherscan_api_key
BSCSCAN_API_KEY=your_bscscan_api_key
POLYGONSCAN_API_KEY=your_polygonscan_api_key
ALCHEMY_API_KEY=your_alchemy_api_key
```

## New API Endpoints

### 1. Manual Transaction Verification
```http
POST /api/onboarding/payment/verify-transaction
Content-Type: application/json

{
  "channelId": "CH_abc123...",
  "txHash": "0x1234567890abcdef..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "Transaction verified and payment processed",
  "transaction": {
    "hash": "0x1234567890abcdef...",
    "amount": 0.0012,
    "confirmations": 3,
    "blockHeight": 18500000
  },
  "channelId": "CH_abc123..."
}
```

### 2. Blockchain Monitoring Status (Admin)
```http
GET /api/onboarding/admin/blockchain-status
Headers:
  x-account: admin_username
  x-challenge: timestamp
  x-pubkey: public_key
  x-signature: signature
```

**Response:**
```json
{
  "success": true,
  "blockchainMonitoring": {
    "status": {
      "isRunning": true,
      "networks": ["BTC", "ETH", "BNB", "MATIC", "SOL"],
      "activeMonitors": 5
    },
    "supportedNetworks": ["BTC", "ETH", "BNB", "MATIC", "SOL"],
    "paymentAddresses": {
      "BTC": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
      "ETH": "0x742e637BC6dc9e0dA3Bb4CD0cE2BE4e9d5fD8a6B"
    },
    "recentDetections": [],
    "weeklyStats": []
  }
}
```

## WebSocket Integration

The WebSocket monitoring now includes real blockchain verification:

### Enhanced Payment Flow
1. **User sends payment** → WebSocket receives `payment_sent` message
2. **Immediate verification** → System attempts to verify transaction on blockchain  
3. **Real-time updates** → WebSocket sends verification status
4. **Automatic progression** → Confirmed payments trigger account creation

### WebSocket Message Types

```javascript
// Payment verified on blockchain
{
  "type": "payment_verified",
  "channelId": "CH_abc123...",
  "txHash": "0x1234567890abcdef...",
  "message": "✅ Payment verified on blockchain",
  "transaction": { /* transaction details */ }
}

// Payment recorded but still verifying
{
  "type": "payment_sent_confirmed", 
  "channelId": "CH_abc123...",
  "txHash": "0x1234567890abcdef...",
  "message": "⏳ Payment recorded, verifying on blockchain...",
  "note": "Transaction will be automatically verified when confirmed"
}
```

## Payment Process Flow

### Before (Honor System)
1. User sends payment
2. User reports transaction hash
3. System records hash without verification  
4. Manual account creation required

### After (Blockchain Monitoring)
1. User sends payment to shared address
2. **Automatic detection** when payment hits blockchain
3. **Real-time verification** of amount, address, confirmations
4. **Automatic account creation** when fully confirmed
5. **WebSocket updates** throughout entire process

## Configuration

### Network Settings

Each cryptocurrency has specific settings:

```javascript
BTC: {
  name: 'Bitcoin',
  confirmations_required: 2,
  block_time_seconds: 600, // 10 minutes
  decimals: 8,
  avg_transfer_fee: 0.0001
}
```

### Monitoring Intervals

- **Active channels**: Checked every 30 seconds
- **Network scanning**: Based on block time (Bitcoin: 10min, Ethereum: 12s, etc.)
- **Confirmation updates**: Real-time as blocks are mined

## Error Handling

The system includes comprehensive error handling:

- **API Fallbacks**: Multiple blockchain APIs per network
- **Transaction Retry**: Re-attempts failed verifications
- **Expiration Handling**: Automatic cleanup of expired channels  
- **WebSocket Errors**: Graceful degradation with error messages

## Security Features

- **Amount Tolerance**: 5% tolerance prevents minor fee discrepancies from failing payments
- **Time Validation**: Ensures transactions occurred after channel creation
- **Address Verification**: Strict validation of payment addresses
- **Confirmation Requirements**: Network-appropriate confirmation thresholds

## Database Schema Updates

New tables added:
- `payment_confirmations` - Tracks transaction confirmations
- Enhanced `payment_channels` - Includes tx_hash and confirmations

## Production Deployment

1. **Set environment variables** with real payment addresses
2. **Configure API keys** for blockchain APIs (recommended)
3. **Monitor logs** for blockchain service startup
4. **Test payment flow** with small amounts first

## Troubleshooting

### Common Issues

1. **"Network not supported"** - Check CRYPTO_CONFIG includes the currency
2. **"Transaction not found"** - Transaction may not be confirmed yet
3. **"Address mismatch"** - Verify payment sent to correct address
4. **"Amount mismatch"** - Check if amount is within 5% tolerance

### Monitoring

Check blockchain monitoring status via admin endpoint:
```bash
GET /api/onboarding/admin/blockchain-status
```

### Logs

Monitor console output for:
- `🔍 Starting blockchain monitoring service...`
- `📡 Started monitoring Bitcoin (BTC)...`
- `💰 Payment detected for channel...`
- `✅ Payment fully confirmed...`

This system eliminates the honor system and provides a fully automated, trustless payment verification and account creation process. 