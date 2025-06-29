# DLUX Subscription System Tests

This directory contains comprehensive integration tests for the DLUX subscription system.

## What's Tested

### Core Functionality
- ✅ Database schema and table creation
- ✅ Subscription tier management
- ✅ Payment processing from HIVE blockchain
- ✅ Subscription creation and renewals
- ✅ Feature access control
- ✅ Promo code system

### Payment Notifications
- ✅ Payment due reminders (7, 3, 1 days)
- ✅ Overdue payment notifications
- ✅ Service suspension notifications
- ✅ Subscription renewal confirmations
- ✅ Payment failure alerts

### API Endpoints
- ✅ Public subscription APIs
- ✅ Admin subscription management
- ✅ Payment notification APIs
- ✅ Feature access validation
- ✅ Statistics and monitoring

### Error Handling
- ✅ Invalid payment amounts
- ✅ Expired promo codes
- ✅ Duplicate payment processing
- ✅ Unsupported currencies
- ✅ Network failures

## Setup and Running

### Prerequisites
- Node.js 16+
- PostgreSQL database (same as main system)
- DLUX data server running on port 3003

### Installation
```bash
cd docker-data/tests
npm install
```

### Running Tests
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test suite
npm run test:subscription

# Run with coverage report
npm run test:coverage
```

### Test Configuration

Set environment variables:
```bash
export TEST_BASE_URL=http://localhost:3003
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=dlux_data
export DB_USER=dlux_user
export DB_PASSWORD=your_password
```

## Test Structure

```
tests/
├── subscription-integration.test.js  # Main test suite
├── package.json                      # Test dependencies
├── setup.js                         # Jest configuration
└── README.md                        # This file
```

## Test Scenarios

### Payment Processing Tests
1. **Valid Payment Processing**
   - Tests HIVE/HBD payments to dlux-io account
   - Validates memo parsing (tier codes, yearly/monthly, promo codes)
   - Verifies subscription creation/renewal

2. **Payment Validation**
   - Amount matching with 2% tolerance
   - Currency validation (HIVE/HBD only)
   - Tier code recognition

3. **Promo Code System**
   - Code creation and validation
   - Discount application (percentage, fixed amounts)
   - Usage limits and expiration

### Notification System Tests
1. **Payment Due Notifications**
   - 7-day advance warning
   - 3-day urgent reminder
   - 1-day final notice

2. **Service Management**
   - Overdue payment handling
   - Grace period (3 days)
   - Service suspension
   - Feature restoration

### Feature Access Tests
1. **Tier-based Access Control**
   - VR features by subscription level
   - Storage limits enforcement
   - User limits per space
   - Premium collaboration tools

2. **Real-time Validation**
   - API endpoint access control
   - WebRTC feature gating
   - File upload limits

## Mock Data

The tests create and clean up test data automatically:
- Test users: `test-user-{timestamp}`
- Test transactions: `test-tx-{timestamp}`
- Test promo codes: `TEST50`, `EXPIRED50`

## Debugging Tests

1. **Enable Verbose Logging**
   ```bash
   npm test -- --verbose
   ```

2. **Run Single Test**
   ```bash
   npm test -- --testNamePattern="should process valid subscription payment"
   ```

3. **Debug Database State**
   ```sql
   SELECT * FROM user_subscriptions WHERE user_account LIKE 'test-%';
   SELECT * FROM subscription_payments WHERE from_account LIKE 'test-%';
   SELECT * FROM user_notifications WHERE username LIKE 'test-%';
   ```

## Expected Test Results

All tests should pass with the following approximate timing:
- Database schema tests: ~100ms
- Payment processing tests: ~2-5s each
- Notification tests: ~1-3s each
- API endpoint tests: ~500ms-1s each

Total test suite should complete in under 30 seconds.

## Continuous Integration

These tests are designed to run in CI/CD pipelines:
- Automatic database setup/teardown
- No external dependencies beyond PostgreSQL
- Configurable timeouts for slow networks
- Comprehensive error reporting

## Contributing

When adding new features to the subscription system:
1. Add corresponding tests in `subscription-integration.test.js`
2. Update test data cleanup in `cleanupTestDatabase()`
3. Add new environment variables to this README
4. Test both success and failure scenarios 