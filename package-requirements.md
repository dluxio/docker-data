# Enhanced Onboarding Service - Package Requirements

## New Dependencies Required

### Core Validation & Security
```bash
npm install joi express-rate-limit
```

- **joi** (^17.11.0): Comprehensive data validation library for input sanitization
- **express-rate-limit** (^7.1.5): Rate limiting middleware to prevent abuse

### Installation Command
```bash
npm install joi@^17.11.0 express-rate-limit@^7.1.5
```

## Key Enhancements Implemented

### 1. Input Validation & Sanitization
- **Joi validation schemas** for all user inputs
- **Strict validation** for usernames, public keys, crypto types
- **Error message standardization** with field-specific validation
- **Input sanitization** to prevent injection attacks

### 2. Comprehensive Error Handling
- **Try-catch blocks** around all async operations
- **Specific error responses** for different failure scenarios
- **Timeout handling** for external API calls
- **Fallback mechanisms** for critical services

### 3. Enhanced Transaction Verification
- **Robust HIVE transaction validation** with multiple operation type support
- **Enhanced username extraction** with multiple fallback methods
- **Transaction format validation** for edge cases
- **Operation type checking** for account creation verification

### 4. Automated ACT Claiming
- **Proactive ACT management** with configurable thresholds
- **Multi-ACT claiming** when abundant RCs available
- **Smart threshold calculation** based on real-time RC costs
- **Batch claiming with delays** to avoid rate limits

### 5. Memo Implementation
- **BTC OP_RETURN memo support** with hex decoding
- **Solana memo instruction verification** with base64 decoding
- **Multi-API fallback** for blockchain data retrieval
- **Comprehensive memo verification** in payment processing

### 6. Rate Limiting
- **Tiered rate limiting** for different endpoint types:
  - General: 100 requests/15 minutes
  - Pricing: 10 requests/1 minute  
  - Payment: 5 requests/5 minutes
  - Strict: 10 requests/1 hour
- **IP-based limiting** with proper error messages
- **Standard headers** for rate limit information

## Validation Schemas

### Username Validation
```javascript
username: Joi.string()
    .pattern(/^[a-z0-9\-\.]{3,16}$/)
    .required()
```

### Public Key Validation
```javascript
publicKey: Joi.string()
    .pattern(/^(STM|TST)[A-Za-z0-9]{50,60}$/)
    .required()
```

### Crypto Type Validation
```javascript
cryptoType: Joi.string()
    .valid('BTC', 'SOL', 'ETH', 'MATIC', 'BNB')
    .required()
```

### Transaction Hash Validation
```javascript
txHash: Joi.string()
    .pattern(/^[a-fA-F0-9]+$/)
    .min(32)
    .max(128)
    .required()
```

## Rate Limiting Configuration

### Endpoint-Specific Limits
- **/pricing**: 10 requests per minute
- **/payment/initiate**: 5 requests per 5 minutes
- **/request/send**: 10 requests per hour
- **General endpoints**: 100 requests per 15 minutes

## Error Handling Improvements

### API Timeout Handling
- **10-second timeouts** for external API calls
- **User-Agent headers** for proper API identification
- **Multiple fallback endpoints** for critical services

### Database Error Handling
- **Connection error handling** with specific error messages
- **Transaction rollback** on failures
- **Graceful degradation** when possible

### Blockchain API Error Handling
- **Multiple RPC endpoint support** for redundancy
- **Service availability checks** before operations
- **Fallback pricing mechanisms** for service interruptions

## Memo Verification Features

### Bitcoin (BTC)
- **OP_RETURN data extraction** from transaction outputs
- **Hex to UTF-8 conversion** for memo content
- **Multiple block explorer APIs** for redundancy

### Solana (SOL)
- **Memo instruction detection** in transaction data
- **Base64 decoding** of memo content
- **RPC endpoint failover** for reliability

## Proactive ACT Claiming Logic

### Threshold Configuration
- **Minimum ACT balance**: 5 tokens
- **Optimal ACT balance**: 10 tokens  
- **RC threshold multiplier**: 2.5x claim cost
- **High RC threshold**: 5x claim cost for optimal balance

### Claiming Strategy
- **Real-time RC cost evaluation** using latest API data
- **Batch claiming** with 5-second delays between attempts
- **RC balance monitoring** during batch operations
- **Automatic stopping** when RCs insufficient

## Security Enhancements

### Input Sanitization
- **Joi schema validation** strips unknown fields
- **Pattern matching** for all user inputs
- **Length limits** on text fields
- **Type enforcement** for all parameters

### Rate Limiting Protection
- **IP-based throttling** across all endpoints
- **Progressive restrictions** for sensitive operations
- **Standard rate limit headers** for client awareness

### Transaction Verification
- **Multi-step validation** for HIVE transactions
- **Operation type verification** for account creation
- **Username format validation** from blockchain data
- **Edge case handling** for malformed transactions

## Usage Examples

### Validation Middleware Usage
```javascript
router.post('/api/endpoint', 
    validateInput(Joi.object({
        username: validationSchemas.username,
        publicKeys: validationSchemas.publicKeys
    })),
    async (req, res) => {
        // Validated and sanitized req.body available here
    }
);
```

### Rate Limiting Usage
```javascript
router.get('/api/pricing', rateLimits.pricing, async (req, res) => {
    // Rate limited endpoint
});
```

### Error Handling Pattern
```javascript
try {
    const result = await someAsyncOperation();
} catch (error) {
    console.error('Operation failed:', error);
    return res.status(500).json({
        success: false,
        error: 'Operation failed',
        details: error.message
    });
}
```