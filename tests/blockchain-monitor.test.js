const BlockchainMonitoringService = require('../api/blockchain-monitor');
const { pool } = require('../index');

// Mock dependencies
jest.mock('node-fetch');
jest.mock('../index', () => ({
    pool: {
        connect: jest.fn(),
    }
}));

const fetch = require('node-fetch');

describe('BlockchainMonitoringService', () => {
    let service;
    let mockClient;

    beforeEach(() => {
        // Reset environment variables
        process.env.ETHERSCAN_API_KEY = 'test-eth-key';
        process.env.BSCSCAN_API_KEY = 'test-bnb-key';
        process.env.POLYGONSCAN_API_KEY = 'test-matic-key';
        
        // Mock database client
        mockClient = {
            query: jest.fn(),
            release: jest.fn()
        };
        pool.connect.mockResolvedValue(mockClient);
        
        // Create new service instance
        service = new (require('../api/blockchain-monitor').constructor)();
        
        // Clear mocks
        fetch.mockClear();
    });

    afterEach(() => {
        if (service.isRunning) {
            service.stopMonitoring();
        }
        jest.clearAllMocks();
    });

    describe('Configuration Validation', () => {
        test('should validate required API keys', () => {
            expect(() => {
                new (require('../api/blockchain-monitor').constructor)();
            }).not.toThrow();
        });

        test('should throw error for missing API keys', () => {
            delete process.env.ETHERSCAN_API_KEY;
            
            expect(() => {
                new (require('../api/blockchain-monitor').constructor)();
            }).toThrow('Missing required API keys');
        });

        test('should reject dummy API keys', () => {
            process.env.ETHERSCAN_API_KEY = 'YourApiKeyToken';
            
            expect(() => {
                new (require('../api/blockchain-monitor').constructor)();
            }).toThrow('Missing required API keys');
        });
    });

    describe('Network Configuration', () => {
        test('should initialize all supported networks', () => {
            const networks = service.getStatus().networks;
            expect(networks).toContain('BTC');
            expect(networks).toContain('ETH');
            expect(networks).toContain('BNB');
            expect(networks).toContain('MATIC');
            expect(networks).toContain('SOL');
        });

        test('should have correct network properties', () => {
            const btcNetwork = service.networks.get('BTC');
            expect(btcNetwork).toHaveProperty('name', 'Bitcoin');
            expect(btcNetwork).toHaveProperty('type', 'utxo');
            expect(btcNetwork).toHaveProperty('confirmations_required', 2);
            expect(btcNetwork).toHaveProperty('supports_memo', true);
        });
    });

    describe('Block Height Retrieval', () => {
        test('should get Bitcoin block height', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('800000')
            });

            const height = await service.getCurrentBlockHeight('BTC');
            expect(height).toBe(800000);
            expect(fetch).toHaveBeenCalledWith('https://blockstream.info/api/blocks/tip/height');
        });

        test('should get Ethereum block height', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ result: '0x112a880' })
            });

            const height = await service.getCurrentBlockHeight('ETH');
            expect(height).toBe(18012288);
        });

        test('should handle API errors gracefully', async () => {
            fetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error'
            });

            await expect(service.getCurrentBlockHeight('BTC'))
                .rejects
                .toThrow('Bitcoin API error: Internal Server Error');
        });

        test('should throw error for unsupported network', async () => {
            await expect(service.getCurrentBlockHeight('UNSUPPORTED'))
                .rejects
                .toThrow('Unsupported network: UNSUPPORTED');
        });
    });

    describe('Bitcoin Transaction Parsing', () => {
        test('should parse simple Bitcoin transaction', async () => {
            const mockTxData = {
                status: { block_height: 800000, block_time: 1699000000 },
                vout: [
                    {
                        value: 50000000, // 0.5 BTC in satoshis
                        scriptpubkey_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
                        scriptpubkey_type: 'p2pkh'
                    }
                ]
            };

            fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockTxData)
                })
                .mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve('800005')
                });

            const result = await service.getBitcoinTransaction('test-tx-hash');
            
            expect(result).toEqual({
                hash: 'test-tx-hash',
                amount: 0.5,
                to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
                confirmations: 6,
                blockHeight: 800000,
                timestamp: new Date(1699000000 * 1000),
                memo: null,
                allOutputs: [{
                    address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
                    amount: 0.5,
                    scriptType: 'p2pkh'
                }]
            });
        });

        test('should extract OP_RETURN memo', async () => {
            const mockTxData = {
                status: { block_height: 800000, block_time: 1699000000 },
                vout: [
                    {
                        value: 50000000,
                        scriptpubkey_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
                        scriptpubkey_type: 'p2pkh'
                    },
                    {
                        value: 0,
                        scriptpubkey_type: 'op_return',
                        scriptpubkey_hex: '6a0c48656c6c6f20576f726c64' // "Hello World"
                    }
                ]
            };

            fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockTxData)
                })
                .mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve('800005')
                });

            const result = await service.getBitcoinTransaction('test-tx-hash');
            expect(result.memo).toBe('Hello World');
        });

        test('should handle multiple outputs', async () => {
            const mockTxData = {
                status: { block_height: 800000, block_time: 1699000000 },
                vout: [
                    {
                        value: 30000000, // 0.3 BTC
                        scriptpubkey_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
                        scriptpubkey_type: 'p2pkh'
                    },
                    {
                        value: 20000000, // 0.2 BTC
                        scriptpubkey_address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
                        scriptpubkey_type: 'p2pkh'
                    }
                ]
            };

            fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockTxData)
                })
                .mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve('800005')
                });

            const result = await service.getBitcoinTransaction('test-tx-hash');
            
            // Should return the largest output as main
            expect(result.amount).toBe(0.3);
            expect(result.to).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
            expect(result.allOutputs).toHaveLength(2);
        });

        test('should throw error for transaction not found', async () => {
            fetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            }).mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            await expect(service.getBitcoinTransaction('invalid-hash'))
                .rejects
                .toThrow('Transaction invalid-hash not found on BTC network');
        });
    });

    describe('Transaction Verification', () => {
        const mockChannel = {
            channel_id: 'test-channel',
            crypto_type: 'BTC',
            payment_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
            amount_crypto: '0.5',
            memo: null,
            created_at: '2023-01-01T00:00:00Z'
        };

        const mockTransaction = {
            hash: 'test-tx',
            amount: 0.5,
            to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
            confirmations: 3,
            timestamp: new Date('2023-01-01T01:00:00Z'),
            memo: null
        };

        test('should verify valid transaction', async () => {
            mockClient.query.mockResolvedValue({ rows: [] }); // No double spend

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(mockChannel, mockTransaction, network);
            
            expect(isValid).toBe(true);
        });

        test('should reject transaction with insufficient amount', async () => {
            const lowAmountTx = { ...mockTransaction, amount: 0.4 }; // Below 5% tolerance
            mockClient.query.mockResolvedValue({ rows: [] });

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(mockChannel, lowAmountTx, network);
            
            expect(isValid).toBe(false);
        });

        test('should reject transaction to wrong address', async () => {
            const wrongAddressTx = { ...mockTransaction, to: '1WrongAddress123' };
            mockClient.query.mockResolvedValue({ rows: [] });

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(mockChannel, wrongAddressTx, network);
            
            expect(isValid).toBe(false);
        });

        test('should verify Bitcoin transaction with multiple outputs', async () => {
            const multiOutputTx = {
                ...mockTransaction,
                allOutputs: [
                    { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', amount: 0.3 },
                    { address: '1WrongAddress123', amount: 0.2 }
                ]
            };
            mockClient.query.mockResolvedValue({ rows: [] });

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(mockChannel, multiOutputTx, network);
            
            expect(isValid).toBe(true);
        });

        test('should verify memo when required', async () => {
            const channelWithMemo = { ...mockChannel, memo: 'test-memo' };
            const txWithMemo = { ...mockTransaction, memo: 'test-memo' };
            mockClient.query.mockResolvedValue({ rows: [] });

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(channelWithMemo, txWithMemo, network);
            
            expect(isValid).toBe(true);
        });

        test('should reject transaction with wrong memo', async () => {
            const channelWithMemo = { ...mockChannel, memo: 'expected-memo' };
            const txWithWrongMemo = { ...mockTransaction, memo: 'wrong-memo' };
            mockClient.query.mockResolvedValue({ rows: [] });

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(channelWithMemo, txWithWrongMemo, network);
            
            expect(isValid).toBe(false);
        });

        test('should detect double spending', async () => {
            mockClient.query.mockResolvedValue({ 
                rows: [{ tx_hash: 'other-tx', status: 'confirmed' }] 
            });

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(mockChannel, mockTransaction, network);
            
            expect(isValid).toBe(false);
        });

        test('should reject transactions before channel creation', async () => {
            const oldTx = { 
                ...mockTransaction, 
                timestamp: new Date('2022-12-31T23:00:00Z') // Before channel creation
            };
            mockClient.query.mockResolvedValue({ rows: [] });

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(mockChannel, oldTx, network);
            
            expect(isValid).toBe(false);
        });

        test('should reject dust transactions', async () => {
            const dustTx = { ...mockTransaction, amount: 0.000001 }; // Below network minimum
            mockClient.query.mockResolvedValue({ rows: [] });

            const network = service.networks.get('BTC');
            const isValid = await service.verifyTransactionMatch(mockChannel, dustTx, network);
            
            expect(isValid).toBe(false);
        });
    });

    describe('Service Lifecycle', () => {
        test('should start monitoring successfully', async () => {
            fetch.mockResolvedValue({
                ok: true,
                text: () => Promise.resolve('800000')
            });

            await expect(service.startMonitoring()).resolves.not.toThrow();
            expect(service.isRunning).toBe(true);
        });

        test('should not start if already running', async () => {
            service.isRunning = true;
            await service.startMonitoring();
            
            // Should not throw, but should log warning
            expect(service.isRunning).toBe(true);
        });

        test('should stop monitoring cleanly', () => {
            service.isRunning = true;
            service.monitoringIntervals.set('BTC', 123);
            
            service.stopMonitoring();
            
            expect(service.isRunning).toBe(false);
            expect(service.monitoringIntervals.size).toBe(0);
        });
    });

    describe('Error Handling', () => {
        test('should handle network failures gracefully', async () => {
            fetch.mockRejectedValue(new Error('Network error'));

            await expect(service.getCurrentBlockHeight('BTC'))
                .rejects
                .toThrow('Failed to get block height for BTC');
        });

        test('should handle malformed API responses', async () => {
            fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({}) // Empty response
            });

            await expect(service.getBitcoinTransaction('test-hash'))
                .rejects
                .toThrow();
        });

        test('should handle database connection errors', async () => {
            pool.connect.mockRejectedValue(new Error('Database connection failed'));

            await expect(service.monitorActiveChannels())
                .rejects
                .toThrow('Failed to monitor active channels');
        });
    });

    describe('Manual Transaction Verification', () => {
        test('should verify transaction hash manually', async () => {
            const mockChannelData = {
                rows: [{
                    channel_id: 'test-channel',
                    crypto_type: 'BTC',
                    payment_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
                    amount_crypto: '0.5',
                    memo: null,
                    created_at: '2023-01-01T00:00:00Z'
                }]
            };

            mockClient.query
                .mockResolvedValueOnce(mockChannelData) // Get channel
                .mockResolvedValueOnce({ rows: [] }) // Check double spend
                .mockResolvedValueOnce({}) // Update channel
                .mockResolvedValueOnce({}); // Insert confirmation

            const mockTxData = {
                status: { block_height: 800000, block_time: 1699000000 },
                vout: [{
                    value: 50000000,
                    scriptpubkey_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
                    scriptpubkey_type: 'p2pkh'
                }]
            };

            fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockTxData)
                })
                .mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve('800005')
                });

            const result = await service.manualVerifyTransaction('test-channel', 'test-tx-hash');
            
            expect(result.success).toBe(true);
            expect(result.channel).toBe('test-channel');
        });

        test('should handle channel not found', async () => {
            mockClient.query.mockResolvedValue({ rows: [] });

            const result = await service.manualVerifyTransaction('nonexistent', 'test-tx');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('Channel not found');
        });
    });

    describe('Status Reporting', () => {
        test('should return correct status', () => {
            service.isRunning = true;
            service.monitoringIntervals.set('BTC', 123);
            service.lastBlockChecked.set('BTC', 800000);

            const status = service.getStatus();

            expect(status).toEqual({
                isRunning: true,
                networks: ['BTC', 'ETH', 'BNB', 'MATIC', 'SOL'],
                activeMonitors: 1,
                lastBlockChecked: { BTC: 800000 }
            });
        });
    });
}); 