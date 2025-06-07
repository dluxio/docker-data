# Crypto Account Generation System

This document describes the new cryptocurrency account generation system that replaces the memo-based payment system.

## Overview

The system has been updated to generate unique cryptocurrency addresses for each payment channel instead of using shared addresses with memos. This improves compatibility with wallets that don't support memos and provides better security through address isolation.

## Key Changes

### 1. Account Generation Instead of Memos
- **Before**: Shared addresses with unique memos per payment
- **After**: Unique addresses generated per payment channel using HD wallets

### 2. New Supported Cryptocurrencies
- **Bitcoin (BTC)** - P2WPKH (native segwit) addresses
- **Ethereum (ETH)** - Standard EOA addresses  
- **Solana (SOL)** - Ed25519 keypairs
- **Polygon (MATIC)** - Ethereum-compatible addresses
- **Binance Smart Chain (BNB)** - Ethereum-compatible addresses
- **Dash (DASH)** - P2PKH addresses (placeholder implementation)
- **Monero (XMR)** - Standard addresses (placeholder implementation)

### 3. Address Reuse System
- Addresses become reusable 1 week after channel completion/expiration
- Helps optimize gas fees by batching movements from reused addresses
- Maintains security through time-based isolation

## Environment Setup

Add the following to your `.env` file:

```bash
# Master seed for HD wallet generation (will be generated if not provided)
CRYPTO_MASTER_SEED=your_64_character_hex_seed_here

# Optional: API keys for better blockchain monitoring
ETHERSCAN_API_KEY=your_etherscan_api_key
ALCHEMY_API_KEY=your_alchemy_api_key
```

## Database Schema Changes

New table `crypto_addresses`:
```sql
CREATE TABLE crypto_addresses (
    id SERIAL PRIMARY KEY,
    channel_id VARCHAR(100) NOT NULL,
    crypto_type VARCHAR(10) NOT NULL,
    address VARCHAR(255) NOT NULL,
    public_key TEXT,
    private_key_encrypted BYTEA,
    derivation_path VARCHAR(100),
    derivation_index INTEGER NOT NULL,
    address_type VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reusable_after TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 week'),
    UNIQUE(crypto_type, address),
    UNIQUE(crypto_type, derivation_index)
);
```

## API Changes

### Payment Initiation
- **Endpoint**: `POST /api/onboarding/payment/initiate`
- **Changes**: 
  - No longer requires memo in response
  - Returns `addressInfo` with transaction assembly details
  - Each payment gets unique address automatically

### Payment Status
- **Endpoint**: `GET /api/onboarding/payment/status/:channelId`
- **Changes**:
  - Instructions updated to remove memo requirements
  - Address is unique per channel

### New Endpoints

#### Test Address Generation
```
GET /api/onboarding/test-address-generation/:cryptoType
```
Test endpoint to verify address generation for each crypto type.

#### Transaction Information
```
GET /api/onboarding/transaction-info/:cryptoType/:address
```
Provides transaction assembly information for client-side transaction creation.

## Client-Side Transaction Assembly

The system now provides all necessary information for clients to assemble transactions:

### Bitcoin/DASH
- UTXOs for the address
- Current fee rates (fast/medium/slow)
- Address type information

### Ethereum/MATIC/BNB
- Current nonce
- Gas price recommendations
- Chain ID and RPC endpoints
- Account balance

### Solana
- Recent blockhash
- Account balance
- Minimum rent exemption

### Monero
- Placeholder implementation (requires specialized libraries)

## Security Features

1. **HD Wallet Derivation**: Uses BIP44 standard derivation paths
2. **Address Isolation**: Each payment gets unique address
3. **Time-based Reuse**: Addresses only reusable after 1 week
4. **Double-spend Protection**: Blockchain monitor prevents reuse conflicts
5. **Encrypted Storage**: Private keys stored encrypted in database

## Implementation Status

### Fully Implemented
- ✅ Bitcoin (BTC)
- ✅ Ethereum (ETH) 
- ✅ Polygon (MATIC)
- ✅ Binance Smart Chain (BNB)
- ✅ Solana (SOL)

### Placeholder Implementation
- ⚠️ Dash (DASH) - Address generation works, monitoring needs implementation
- ⚠️ Monero (XMR) - Requires monero-javascript library integration

## Testing

Test the system using:
```bash
curl https://data.dlux.io/api/onboarding/test-address-generation/BTC
curl https://data.dlux.io/api/onboarding/test-address-generation/ETH
curl https://data.dlux.io/api/onboarding/test-address-generation/SOL
# etc.
```

## Migration Notes

- Existing memo-based payments will continue to work during transition
- New payments automatically use the address generation system
- No action required for existing users
- Blockchain monitoring updated to work without memo verification

## Future Enhancements

1. **Dash Integration**: Implement proper Dash blockchain APIs
2. **Monero Integration**: Add monero-javascript library for full support
3. **Hardware Wallet Support**: Add support for hardware wallet address generation
4. **Multi-signature**: Support for multi-sig addresses
5. **Address Monitoring**: Real-time address balance monitoring 