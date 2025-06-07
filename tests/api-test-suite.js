const axios = require('axios');
const assert = require('assert');

class OnboardingAPITestSuite {
    constructor(baseURL = 'https://data.dlux.io') {
        this.baseURL = baseURL;
        this.testResults = [];
        this.channelIds = [];
    }

    async runTest(testName, testFunction) {
        console.log(`\n🧪 Running: ${testName}`);
        const startTime = Date.now();
        
        try {
            await testFunction();
            const duration = Date.now() - startTime;
            console.log(`✅ PASSED: ${testName} (${duration}ms)`);
            this.testResults.push({ name: testName, status: 'PASSED', duration });
        } catch (error) {
            const duration = Date.now() - startTime;
            console.log(`❌ FAILED: ${testName} (${duration}ms)`);
            console.log(`   Error: ${error.message}`);
            this.testResults.push({ name: testName, status: 'FAILED', duration, error: error.message });
        }
    }

    async runAllTests() {
        console.log('🚀 Starting Hive Onboarding API Test Suite');
        console.log(`📍 Base URL: ${this.baseURL}`);
        
        // Core System Tests
        await this.runTest('System Health Check', () => this.testSystemHealth());
        await this.runTest('Pricing Service', () => this.testPricingService());
        
        // Crypto Address Generation Tests
        await this.runTest('SOL Address Generation', () => this.testAddressGeneration('SOL'));
        await this.runTest('BTC Address Generation', () => this.testAddressGeneration('BTC'));
        await this.runTest('ETH Address Generation', () => this.testAddressGeneration('ETH'));
        await this.runTest('DASH Address Generation', () => this.testAddressGeneration('DASH'));
        
        // Payment Flow Tests
        await this.runTest('SOL Payment Initiation', () => this.testPaymentInitiation('SOL', 'soltest123'));
        await this.runTest('BTC Payment Initiation', () => this.testPaymentInitiation('BTC', 'btctest123'));
        await this.runTest('Payment Status Check', () => this.testPaymentStatus());
        
        // Simulation Tests
        await this.runTest('Payment Simulation SOL', () => this.testPaymentSimulation('SOL', 'simtest123'));
        await this.runTest('Payment Simulation BTC', () => this.testPaymentSimulation('BTC', 'simtest456'));
        
        // Transaction Information Tests
        await this.runTest('Bitcoin Transaction Info', () => this.testTransactionInfo('BTC'));
        await this.runTest('Solana Transaction Info', () => this.testTransactionInfo('SOL'));
        
        // Error Handling Tests
        await this.runTest('Invalid Crypto Type', () => this.testInvalidCrypto());
        await this.runTest('Invalid Username Format', () => this.testInvalidUsername());
        await this.runTest('Missing Required Fields', () => this.testMissingFields());
        await this.runTest('Duplicate Username Prevention', () => this.testDuplicateUsername());
        
        // Crypto Implementation Tests
        await this.runTest('Crypto Implementations', () => this.testCryptoImplementations());
        
        this.printSummary();
    }

    async testSystemHealth() {
        const response = await axios.get(`${this.baseURL}/api/onboarding/debug/system-status`);
        assert.strictEqual(response.data.success, true);
        assert.strictEqual(response.data.healthy, true);
        assert(response.data.system_status.database.connected);
        assert(response.data.system_status.pricing.service);
        assert(response.data.system_status.crypto_generator.initialized);
    }

    async testPricingService() {
        const response = await axios.get(`${this.baseURL}/api/onboarding/pricing`);
        assert.strictEqual(response.data.success, true);
        assert(response.data.pricing.crypto_rates);
        assert(response.data.pricing.supported_currencies.includes('SOL'));
        assert(response.data.pricing.supported_currencies.includes('BTC'));
        assert(response.data.pricing.supported_currencies.length === 7);
        
        // Check SOL pricing structure
        const solRate = response.data.pricing.crypto_rates.SOL;
        assert(solRate.price_usd > 0);
        assert(solRate.total_amount > 0);
        assert(solRate.final_cost_usd > 0);
    }

    async testAddressGeneration(cryptoType) {
        const response = await axios.get(`${this.baseURL}/api/onboarding/test-address-generation/${cryptoType}`);
        assert.strictEqual(response.data.success, true);
        assert.strictEqual(response.data.cryptoType, cryptoType);
        assert(response.data.addressInfo.address);
        assert(response.data.addressInfo.derivationPath);
        assert(response.data.transactionInfo);
    }

    async testPaymentInitiation(cryptoType, username) {
        const publicKeys = {
            owner: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
            active: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
            posting: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
            memo: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd"
        };

        const response = await axios.post(`${this.baseURL}/api/onboarding/payment/initiate`, {
            username,
            cryptoType,
            publicKeys
        });

        assert.strictEqual(response.data.success, true);
        assert.strictEqual(response.data.payment.username, username);
        assert.strictEqual(response.data.payment.cryptoType, cryptoType);
        assert(response.data.payment.address);
        assert(response.data.payment.channelId);
        assert(response.data.payment.amount > 0);
        
        // Store channel ID for later tests
        this.channelIds.push(response.data.payment.channelId);
    }

    async testPaymentStatus() {
        if (this.channelIds.length === 0) {
            throw new Error('No channel IDs available for status check');
        }

        const channelId = this.channelIds[0];
        const response = await axios.get(`${this.baseURL}/api/onboarding/payment/status/${channelId}`);
        
        assert.strictEqual(response.data.success, true);
        assert.strictEqual(response.data.channel.channelId, channelId);
        assert(['pending', 'confirmed', 'completed', 'expired'].includes(response.data.channel.status));
    }

    async testPaymentSimulation(cryptoType, username) {
        const response = await axios.post(`${this.baseURL}/api/onboarding/test/simulate-payment`, {
            username,
            cryptoType
        });

        assert.strictEqual(response.data.success, true);
        assert.strictEqual(response.data.simulation, true);
        assert.strictEqual(response.data.payment.username, username);
        assert.strictEqual(response.data.payment.cryptoType, cryptoType);
        assert(response.data.payment.simulatedTxHash);
        
        // Test status check after 3 seconds
        const channelId = response.data.payment.channelId;
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const statusResponse = await axios.get(`${this.baseURL}/api/onboarding/payment/status/${channelId}`);
        assert.strictEqual(statusResponse.data.success, true);
        assert.strictEqual(statusResponse.data.channel.status, 'confirmed');
    }

    async testTransactionInfo(cryptoType) {
        // Get a test address first
        const addressResponse = await axios.get(`${this.baseURL}/api/onboarding/test-address-generation/${cryptoType}`);
        const address = addressResponse.data.addressInfo.address;

        const response = await axios.get(`${this.baseURL}/api/onboarding/transaction-info/${cryptoType}/${address}`);
        assert.strictEqual(response.data.success, true);
        assert.strictEqual(response.data.cryptoType, cryptoType);
        assert.strictEqual(response.data.address, address);
        assert(response.data.transactionInfo);
    }

    async testInvalidCrypto() {
        try {
            await axios.post(`${this.baseURL}/api/onboarding/payment/initiate`, {
                username: 'testuser',
                cryptoType: 'INVALID',
                publicKeys: {
                    owner: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
                    active: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
                    posting: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
                    memo: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd"
                }
            });
            throw new Error('Should have failed with invalid crypto type');
        } catch (error) {
            if (error.response) {
                assert.strictEqual(error.response.data.success, false);
                assert(error.response.data.error.includes('Unsupported cryptocurrency'));
            } else {
                throw error;
            }
        }
    }

    async testInvalidUsername() {
        try {
            await axios.post(`${this.baseURL}/api/onboarding/payment/initiate`, {
                username: 'invalid-username-with-special-chars!@#',
                cryptoType: 'SOL',
                publicKeys: {
                    owner: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
                    active: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
                    posting: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
                    memo: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd"
                }
            });
            throw new Error('Should have failed with invalid username');
        } catch (error) {
            if (error.response) {
                assert.strictEqual(error.response.data.success, false);
            } else {
                throw error;
            }
        }
    }

    async testMissingFields() {
        try {
            await axios.post(`${this.baseURL}/api/onboarding/payment/initiate`, {
                username: 'testuser',
                // Missing cryptoType and publicKeys
            });
            throw new Error('Should have failed with missing fields');
        } catch (error) {
            if (error.response) {
                assert.strictEqual(error.response.data.success, false);
            } else {
                throw error;
            }
        }
    }

    async testDuplicateUsername() {
        const username = 'duplicatetest123';
        const publicKeys = {
            owner: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
            active: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
            posting: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd",
            memo: "STM8GC13uCdBrSuNvQOYXdwDB9szXKM5Jij1KGnF5YW4Jz8AswAhd"
        };

        // First request should succeed
        const response1 = await axios.post(`${this.baseURL}/api/onboarding/payment/initiate`, {
            username,
            cryptoType: 'SOL',
            publicKeys
        });
        assert.strictEqual(response1.data.success, true);

        // Second request with same username should fail
        try {
            await axios.post(`${this.baseURL}/api/onboarding/payment/initiate`, {
                username,
                cryptoType: 'BTC',
                publicKeys
            });
            throw new Error('Should have failed with duplicate username');
        } catch (error) {
            if (error.response) {
                assert.strictEqual(error.response.data.success, false);
                assert(error.response.data.error.includes('already being processed'));
            } else {
                throw error;
            }
        }
    }

    async testCryptoImplementations() {
        const response = await axios.get(`${this.baseURL}/api/onboarding/test-crypto-implementations`);
        assert.strictEqual(response.data.success, true);
        assert(response.data.results.dash.success);
        assert(response.data.results.monero.success);
    }

    printSummary() {
        console.log('\n📊 TEST SUMMARY');
        console.log('================');
        
        const passed = this.testResults.filter(r => r.status === 'PASSED').length;
        const failed = this.testResults.filter(r => r.status === 'FAILED').length;
        const total = this.testResults.length;
        
        console.log(`Total Tests: ${total}`);
        console.log(`✅ Passed: ${passed}`);
        console.log(`❌ Failed: ${failed}`);
        console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%`);
        
        if (failed > 0) {
            console.log('\n❌ FAILED TESTS:');
            this.testResults
                .filter(r => r.status === 'FAILED')
                .forEach(test => {
                    console.log(`   ${test.name}: ${test.error}`);
                });
        }
        
        const totalDuration = this.testResults.reduce((sum, r) => sum + r.duration, 0);
        console.log(`\n⏱️ Total Duration: ${totalDuration}ms`);
        
        console.log('\n🏆 Test Suite Complete!');
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    const testSuite = new OnboardingAPITestSuite();
    testSuite.runAllTests().catch(console.error);
}

module.exports = OnboardingAPITestSuite; 