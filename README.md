# Hive Onboarding API

A comprehensive cryptocurrency payment system for Hive blockchain account creation. This API enables users to create Hive accounts by paying with various cryptocurrencies including Bitcoin, Ethereum, Solana, and others.

## 🌟 Features

- **Multi-Crypto Support**: Accept payments in BTC, ETH, SOL, MATIC, BNB, XMR, and DASH
- **Real-time Pricing**: Dynamic pricing with CoinGecko integration
- **Unique Addresses**: Each payment gets a unique crypto address for security
- **Automated Account Creation**: Automatic Hive account creation after payment confirmation
- **Address Reuse**: Efficient address management with reuse for expired payments
- **Admin Dashboard**: Comprehensive monitoring and management tools
- **Rate Limiting**: Built-in protection against abuse
- **Transaction Verification**: Automatic payment verification and memo checking

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- PostgreSQL database
- Hive RPC access
- CoinGecko API access

### Environment Setup

Create a `.env` file with the following variables:

```env
# Database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable

# Crypto Configuration
CRYPTO_MASTER_SEED=your_256_bit_hex_seed_here

# Hive Configuration
HIVE_RPC_URL=https://api.hive.blog
HIVE_POSTING_KEY=your_posting_key_here
HIVE_ACTIVE_KEY=your_active_key_here

# API Keys
COINGECKO_API_KEY=your_coingecko_api_key

# Server
PORT=3010
NODE_ENV=production
```

### Installation

1. Clone the repository
2. Configure `docker-compose.yml` for your environment
3. Run the API:

```bash
docker-compose up -d
```

4. The API will be available at `http://localhost:3010`

## 📊 System Status

Check system health at any time:

```bash
curl https://your-domain.com/api/onboarding/debug/system-status
```

This endpoint provides comprehensive status of all system components including database, pricing service, crypto generator, and Hive connectivity.

## 💰 Supported Cryptocurrencies

| Crypto | Name | Network Fees | Confirmations | Block Time |
|--------|------|--------------|---------------|------------|
| BTC | Bitcoin | ~$10.50 | 2 | 10 min |
| SOL | Solana | ~$0.0007 | 1 | 24 sec |
| ETH | Ethereum | ~$5.00 | 2 | 12 sec |
| MATIC | Polygon | ~$0.002 | 10 | 2 sec |
| BNB | Binance Smart Chain | ~$0.15 | 3 | 3 sec |
| XMR | Monero | ~$0.03 | 10 | 2 min |
| DASH | Dash | ~$0.0002 | 6 | 2.5 min |

## 🔌 API Endpoints

### 1. Get Current Pricing

```http
GET /api/onboarding/pricing
```

**Response:**
```json
{
  "success": true,
  "pricing": {
    "timestamp": "2025-06-07T05:17:37.940Z",
    "hive_price_usd": 0.234862,
    "account_creation_cost_usd": 1.057,
    "crypto_rates": {
      "SOL": {
        "price_usd": 150.02,
        "amount_needed": 0.007046,
        "transfer_fee": 0.000005,
        "total_amount": 0.007051,
        "final_cost_usd": 1.057
      }
    },
    "supported_currencies": ["BTC", "SOL", "ETH", "MATIC", "BNB", "XMR", "DASH"]
  }
}
```

### 2. Initiate Payment

```http
POST /api/onboarding/payment/initiate
Content-Type: application/json

{
  "username": "newuser123",
  "cryptoType": "SOL",
  "publicKeys": {
    "owner": "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
    "active": "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
    "posting": "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
    "memo": "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd"
  }
}
```

**Response:**
```json
{
  "success": true,
  "payment": {
    "channelId": "ch_abc123...",
    "username": "newuser123",
    "cryptoType": "SOL",
    "amount": 0.007051,
    "amountUSD": 1.057,
    "address": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "expiresAt": "2025-06-08T05:17:39.000Z",
    "confirmationsRequired": 1,
    "instructions": [
      "Send exactly 0.007051 SOL to the address above",
      "This address is unique to your payment - no memo required",
      "Account will be created automatically after 1 confirmation(s)"
    ]
  }
}
```

### 3. Check Payment Status

```http
GET /api/onboarding/payment/status/{channelId}
```

**Response:**
```json
{
  "success": true,
  "payment": {
    "channelId": "ch_abc123...",
    "username": "newuser123",
    "status": "pending", // pending, confirmed, completed, expired, cancelled
    "cryptoType": "SOL",
    "amount": 0.007051,
    "address": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "txHash": null,
    "confirmations": 0,
    "timeRemaining": "23 hours 42 minutes",
    "accountCreated": false
  }
}
```

### 4. Manual Transaction Verification

```http
POST /api/onboarding/payment/verify-transaction
Content-Type: application/json

{
  "channelId": "ch_abc123...",
  "txHash": "5j7x8k9..."
}
```

### 5. Get Transaction Information

```http
GET /api/onboarding/transaction-info/{cryptoType}/{address}
```

Provides detailed information for client-side transaction assembly, including UTXOs (Bitcoin), nonce/gas prices (Ethereum), and recent blockhash (Solana).

### 6. Test Address Generation

```http
GET /api/onboarding/test-address-generation/{cryptoType}
```

Test endpoint to verify address generation is working for each supported cryptocurrency.

### 7. Payment Simulation (Testing)

```http
POST /api/onboarding/test/simulate-payment
Content-Type: application/json

{
  "username": "testuser123",
  "cryptoType": "SOL"
}
```

**Response:**
```json
{
  "success": true,
  "simulation": true,
  "payment": {
    "channelId": "21036b15abe1753c611ccf4ee776e748",
    "username": "testuser123",
    "cryptoType": "SOL",
    "amount": 0.007050,
    "amountUSD": 1.057,
    "address": "SOL_simulated_e776e748",
    "simulatedTxHash": "tx_81d36346b3e44d8b93f4aa257649a0fc",
    "instructions": [
      "[SIMULATION] Send exactly 0.007050 SOL to the address above",
      "Payment will be automatically 'confirmed' in 2 seconds"
    ],
    "note": "This is a test simulation. No real cryptocurrency payment is required."
  }
}
```

This endpoint creates a simulated payment that automatically confirms after 2 seconds, allowing you to test the complete payment flow without real cryptocurrency.

## 🔐 Admin Endpoints

All admin endpoints require Hive authentication headers:

```http
x-account: your-hive-username
x-challenge: unix-timestamp
x-pubkey: your-public-key
x-signature: signed-challenge
```

### View Payment Channels

```http
GET /api/onboarding/admin/channels?limit=50&status=pending&crypto_type=SOL
```

### Crypto Address Management

```http
GET /api/onboarding/admin/crypto-addresses?cryptoType=BTC&limit=100
```

### Fund Consolidation

```http
GET /api/onboarding/admin/consolidation-info/{cryptoType}
POST /api/onboarding/admin/generate-consolidation-tx
```

## 💳 Payment Flow

1. **Get Pricing**: Client calls `/pricing` to get current rates
2. **Initiate Payment**: Client submits username, crypto type, and Hive public keys
3. **Unique Address**: System generates unique payment address
4. **Send Payment**: User sends exact amount to provided address
5. **Monitor**: System automatically monitors for incoming transactions
6. **Verify**: After required confirmations, payment is verified
7. **Create Account**: Hive account is automatically created with provided keys

## 🛡️ Security Features

- **Unique Addresses**: Each payment gets its own address
- **Rate Limiting**: API calls are rate-limited by IP
- **Address Reuse**: Secure reuse of addresses after 1 week
- **Transaction Verification**: Multiple verification layers
- **Encrypted Storage**: Private keys are encrypted in database
- **Time Expiration**: Payments expire after 24 hours

## 🔧 Configuration

### Crypto Networks

Each cryptocurrency is configured with:
- Network endpoints
- Fee estimation
- Block confirmation requirements
- Address generation parameters

### Rate Limits

- General endpoints: 100 requests/15 minutes
- Pricing endpoints: 200 requests/15 minutes  
- Payment endpoints: 50 requests/15 minutes
- Admin endpoints: 20 requests/15 minutes

## 📈 Monitoring

The system includes comprehensive monitoring:

- **Real-time pricing updates** (hourly)
- **Payment channel monitoring**
- **Resource credit tracking**
- **Failed transaction alerts**
- **System health checks**

## 🐛 Troubleshooting

### Current Known Issues

1. **Circular Dependency**: The crypto address generator has a circular dependency with the main onboarding module, preventing real address generation. Use the simulation endpoint for testing.

2. **Address Generation**: Real crypto address generation currently fails due to database connection issues in the crypto generator module.

### Common Issues

1. **Payment not detected**: Check transaction hash and confirmations
2. **Address generation fails**: Verify CRYPTO_MASTER_SEED is set
3. **Pricing unavailable**: Check CoinGecko API connectivity
4. **Account creation fails**: Verify Hive RPC connectivity and RC balance

### Debug Endpoint

Use `/debug/system-status` to check all system components:

```bash
curl https://your-domain.com/api/onboarding/debug/system-status
```

### Testing the API

While the real crypto address generation has issues, you can test the complete payment flow using the simulation endpoint:

```bash
# Test SOL payment (low fees)
curl -X POST "https://data.dlux.io/api/onboarding/test/simulate-payment" \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser123", "cryptoType": "SOL"}'

# Test BTC payment (high fees)  
curl -X POST "https://data.dlux.io/api/onboarding/test/simulate-payment" \
  -H "Content-Type: application/json" \
  -d '{"username": "btcuser123", "cryptoType": "BTC"}'

# Check payment status
curl "https://data.dlux.io/api/onboarding/payment/status/{channelId}"
```

## 🔄 Dependencies

- **Node.js**: 18+ with crypto modules
- **PostgreSQL**: 13+ for data storage  
- **Redis**: Optional for caching
- **Docker**: For containerized deployment

## 📝 Database Schema

Key tables:
- `payment_channels`: Payment tracking
- `crypto_addresses`: Address management
- `pricing_history`: Pricing data
- `onboarding_requests`: Account creation tracking

## 🚀 Deployment

1. Set up environment variables
2. Configure `docker-compose.yml`
3. Run `docker-compose up -d`
4. Set up DNS to point to port 3010
5. Monitor logs for any issues

Example domain setup:
- `data.dlux.io` (Docker Data/Onboarding API)
- `token.dlux.io` (Honeycomb integration)

## 📄 License

See LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## 📋 Summary

This Hive Onboarding API provides a comprehensive cryptocurrency payment system for creating Hive blockchain accounts. Key highlights:

### ✅ What's Working
- **Real-time pricing** for 7 cryptocurrencies via CoinGecko
- **Database operations** and payment channel management
- **System monitoring** and health checks
- **Admin interfaces** for payment management
- **Rate limiting** and security features
- **Payment simulation** for testing

### ⚠️ Current Limitations
- **Address generation** has circular dependency issues
- **Real payments** cannot be processed until crypto generator is fixed
- **Account creation** flow needs testing after address generation fix

### 💡 Recommended Next Steps
1. Fix the circular dependency in `crypto-account-generator.js`
2. Test real address generation for each cryptocurrency
3. Implement proper private key encryption
4. Add comprehensive transaction monitoring
5. Set up automated account creation after payment confirmation

### 🧪 Testing
Use the simulation endpoints to test the complete payment flow:
- Pricing: `GET /api/onboarding/pricing`
- System Status: `GET /api/onboarding/debug/system-status`
- Payment Simulation: `POST /api/onboarding/test/simulate-payment`

For issues or questions, please check the system status endpoint first, then review the logs for specific error messages.

