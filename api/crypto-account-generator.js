const bitcoin = require('bitcoinjs-lib');
const { Keypair } = require('@solana/web3.js');
const { ethers } = require('ethers');
const BIP32Factory = require('bip32');
const ecc = require('tiny-secp256k1');
const { generateMnemonic, mnemonicToSeedSync } = require('bip39');
const { pool } = require('../index');
const CryptoEncryption = require('./crypto-encryption');

// Initialize BIP32 with secp256k1
const bip32 = BIP32Factory.default(ecc);

class CryptoAccountGenerator {
    constructor() {
        this.masterSeed = null;
        this.encryption = new CryptoEncryption();
        this.networks = {
            BTC: bitcoin.networks.bitcoin,
            ETH: null, // Ethereum doesn't use bitcoin networks
            SOL: null, // Solana has its own keypair system
            MATIC: null, // Polygon uses Ethereum addresses
            BNB: null, // Binance Smart Chain uses Ethereum addresses
            XMR: null, // Monero will need special handling
            DASH: bitcoin.networks.bitcoin // Dash uses similar network to Bitcoin
        };
        this.derivationPaths = {
            BTC: "m/44'/0'/0'/0/", // Bitcoin BIP44 path
            ETH: "m/44'/60'/0'/0/", // Ethereum BIP44 path
            SOL: "m/44'/501'/0'/0/", // Solana BIP44 path
            MATIC: "m/44'/60'/0'/0/", // Polygon uses same as Ethereum
            BNB: "m/44'/60'/0'/0/", // BSC uses same as Ethereum
            XMR: "m/44'/128'/0'/0/", // Monero BIP44 path
            DASH: "m/44'/5'/0'/0/" // Dash BIP44 path
        };
    }

    async initialize() {
        try {
            // Check if we have a master seed in environment
            if (process.env.CRYPTO_MASTER_SEED) {
                this.masterSeed = Buffer.from(process.env.CRYPTO_MASTER_SEED, 'hex');
                console.log('✅ Loaded master seed from environment');
            } else {
                // Generate a new master seed and save it (for development only)
                console.warn('⚠️  No CRYPTO_MASTER_SEED found in environment, generating new one');
                const mnemonic = generateMnemonic(256); // 24 words for maximum security
                this.masterSeed = mnemonicToSeedSync(mnemonic);
                
                console.log('🔑 Generated master seed. Add this to your .env file:');
                console.log(`CRYPTO_MASTER_SEED=${this.masterSeed.toString('hex')}`);
                console.log('🔑 Mnemonic backup (store securely):');
                console.log(mnemonic);
            }

            // Test encryption functionality
            this.encryption.testEncryption();
        } catch (error) {
            console.error('Error initializing crypto account generator:', error);
            throw error;
        }
    }

    /**
     * Generate a unique address for a payment channel
     * @param {string} cryptoType - The cryptocurrency type (BTC, ETH, SOL, etc.)
     * @param {string} channelId - Unique channel identifier
     * @param {number} index - Derivation index for address generation
     * @returns {Object} Generated address information
     */
    async generateChannelAddress(cryptoType, channelId, index = 0) {
        if (!this.masterSeed) {
            await this.initialize();
        }

        try {
            switch (cryptoType.toUpperCase()) {
                case 'BTC':
                case 'DASH':
                    return await this.generateBitcoinAddress(cryptoType, channelId, index);
                case 'ETH':
                case 'MATIC':
                case 'BNB':
                    return await this.generateEthereumAddress(cryptoType, channelId, index);
                case 'SOL':
                    return await this.generateSolanaAddress(channelId, index);
                case 'XMR':
                    return await this.generateMoneroAddress(channelId, index);
                default:
                    throw new Error(`Unsupported cryptocurrency: ${cryptoType}`);
            }
        } catch (error) {
            console.error(`Error generating ${cryptoType} address:`, error);
            throw error;
        }
    }

    async generateBitcoinAddress(cryptoType, channelId, index) {
        const derivationPath = this.derivationPaths[cryptoType] + index;
        const root = bip32.fromSeed(this.masterSeed);
        const child = root.derivePath(derivationPath);
        
        const network = cryptoType === 'DASH' ? bitcoin.networks.bitcoin : this.networks[cryptoType];
        
        // Generate P2WPKH (native segwit) address for Bitcoin, P2PKH for DASH
        let address;
        if (cryptoType === 'BTC') {
            const { address: segwitAddress } = bitcoin.payments.p2wpkh({
                pubkey: child.publicKey,
                network: network
            });
            address = segwitAddress;
        } else {
            // DASH uses P2PKH
            const { address: p2pkhAddress } = bitcoin.payments.p2pkh({
                pubkey: child.publicKey,
                network: network
            });
            address = p2pkhAddress;
        }

        return {
            address,
            publicKey: child.publicKey.toString('hex'),
            privateKey: child.privateKey.toString('hex'),
            derivationPath,
            cryptoType,
            channelId,
            index,
            addressType: cryptoType === 'BTC' ? 'P2WPKH' : 'P2PKH'
        };
    }

    async generateEthereumAddress(cryptoType, channelId, index) {
        const derivationPath = this.derivationPaths[cryptoType] + index;
        const root = bip32.fromSeed(this.masterSeed);
        const child = root.derivePath(derivationPath);
        
        // Create wallet from private key
        const wallet = new ethers.Wallet(child.privateKey);
        
        return {
            address: wallet.address,
            publicKey: wallet.publicKey,
            privateKey: child.privateKey.toString('hex'),
            derivationPath,
            cryptoType,
            channelId,
            index,
            addressType: 'EOA' // Externally Owned Account
        };
    }

    async generateSolanaAddress(channelId, index) {
        const derivationPath = this.derivationPaths.SOL + index;
        const root = bip32.fromSeed(this.masterSeed);
        const child = root.derivePath(derivationPath);
        
        // Create Solana keypair from the derived private key
        const keypair = Keypair.fromSeed(child.privateKey.slice(0, 32));
        
        return {
            address: keypair.publicKey.toBase58(),
            publicKey: keypair.publicKey.toBase58(),
            privateKey: Buffer.from(keypair.secretKey).toString('hex'),
            derivationPath,
            cryptoType: 'SOL',
            channelId,
            index,
            addressType: 'ED25519'
        };
    }

    async generateMoneroAddress(channelId, index) {
        // Improved Monero address generation using deterministic keys
        const derivationPath = this.derivationPaths.XMR + index;
        
        try {
            // Use the crypto library to generate deterministic Monero keys
            const root = bip32.fromSeed(this.masterSeed);
            const child = root.derivePath(derivationPath);
            
            // Generate Monero keys from the derived seed
            const crypto = require('crypto');
            const seedHash = crypto.createHash('sha256').update(child.privateKey).digest();
            
            // Create deterministic private keys for Monero
            const privateSpendKey = seedHash.toString('hex');
            const privateViewKey = crypto.createHash('sha256').update(seedHash).digest().toString('hex');
            
            // For a proper implementation, you would use monero-javascript here:
            // const moneroWallet = await MoneroWalletKeys.createWallet({
            //     privateSpendKey: privateSpendKey,
            //     privateViewKey: privateViewKey,
            //     networkType: MoneroNetworkType.MAINNET
            // });
            // const address = await moneroWallet.getPrimaryAddress();
            
            // Placeholder address generation (deterministic but not valid Monero format)
            const addressSeed = crypto.createHash('sha256').update(privateSpendKey + privateViewKey).digest();
            const address = `4${addressSeed.toString('hex').slice(0, 94)}`; // Monero addresses start with 4
            
            return {
                address,
                publicKey: '', // Would be derived from spend key
                privateKey: privateSpendKey,
                privateViewKey,
                derivationPath,
                cryptoType: 'XMR',
                channelId,
                index,
                addressType: 'XMR_STANDARD',
                note: 'Deterministic Monero address - requires full monero-javascript integration for real addresses'
            };
        } catch (error) {
            console.error('Error generating Monero address:', error);
            throw error;
        }
    }

    /**
     * Get or create a unique address for a payment channel
     * @param {string} cryptoType - The cryptocurrency type
     * @param {string} channelId - Unique channel identifier
     * @returns {Object} Address information
     */
    async getChannelAddress(cryptoType, channelId) {
        const client = await pool.connect();
        try {
            // Check if we already have an address for this channel
            const existingResult = await client.query(
                'SELECT * FROM crypto_addresses WHERE channel_id = $1 AND crypto_type = $2',
                [channelId, cryptoType.toUpperCase()]
            );

            if (existingResult.rows.length > 0) {
                const existing = existingResult.rows[0];
                return {
                    address: existing.address,
                    publicKey: existing.public_key,
                    derivationPath: existing.derivation_path,
                    cryptoType: existing.crypto_type,
                    channelId: existing.channel_id,
                    index: existing.derivation_index,
                    addressType: existing.address_type,
                    reused: false,
                    createdAt: existing.created_at
                };
            }

            // Check for reusable addresses (older than 1 week and channel completed/expired)
            const reusableResult = await client.query(`
                SELECT ca.* FROM crypto_addresses ca
                JOIN payment_channels pc ON ca.channel_id = pc.channel_id
                WHERE ca.crypto_type = $1 
                AND ca.reusable_after < NOW()
                AND pc.status IN ('completed', 'expired', 'cancelled')
                AND ca.channel_id NOT IN (
                    SELECT channel_id FROM payment_channels 
                    WHERE status IN ('pending', 'confirming', 'confirmed')
                )
                ORDER BY ca.reusable_after ASC
                LIMIT 1
            `, [cryptoType.toUpperCase()]);

            if (reusableResult.rows.length > 0) {
                // Reuse an existing address
                const reusable = reusableResult.rows[0];
                
                // Update the address record for the new channel
                await client.query(`
                    UPDATE crypto_addresses 
                    SET channel_id = $1, created_at = NOW(), reusable_after = NOW() + INTERVAL '1 week'
                    WHERE id = $2
                `, [channelId, reusable.id]);

                console.log(`♻️  Reusing ${cryptoType} address for channel ${channelId}: ${reusable.address}`);

                return {
                    address: reusable.address,
                    publicKey: reusable.public_key,
                    derivationPath: reusable.derivation_path,
                    cryptoType: reusable.crypto_type,
                    channelId,
                    index: reusable.derivation_index,
                    addressType: reusable.address_type,
                    reused: true,
                    originalChannelId: reusable.channel_id
                };
            }

            // Generate a new address
            const nextIndexResult = await client.query(
                'SELECT COALESCE(MAX(derivation_index), -1) + 1 as next_index FROM crypto_addresses WHERE crypto_type = $1',
                [cryptoType.toUpperCase()]
            );
            
            const nextIndex = nextIndexResult.rows[0].next_index;
            const addressInfo = await this.generateChannelAddress(cryptoType, channelId, nextIndex);

            // Save the new address to database with encrypted private key
            const encryptedPrivateKey = this.encryption.encryptPrivateKey(addressInfo.privateKey);
            
            await client.query(`
                INSERT INTO crypto_addresses 
                (channel_id, crypto_type, address, public_key, private_key_encrypted, derivation_path, derivation_index, address_type, reusable_after)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '1 week')
            `, [
                channelId,
                cryptoType.toUpperCase(),
                addressInfo.address,
                addressInfo.publicKey,
                encryptedPrivateKey,
                addressInfo.derivationPath,
                addressInfo.index,
                addressInfo.addressType
            ]);

            console.log(`🔑 Generated new ${cryptoType} address for channel ${channelId}: ${addressInfo.address}`);

            return {
                ...addressInfo,
                reused: false
            };

        } finally {
            client.release();
        }
    }

    /**
     * Get transaction information needed for client-side transaction assembly
     * @param {string} cryptoType - The cryptocurrency type
     * @param {string} address - The address to get info for
     * @returns {Object} Transaction assembly information
     */
    async getTransactionInfo(cryptoType, address) {
        switch (cryptoType.toUpperCase()) {
            case 'BTC':
                return await this.getBitcoinTransactionInfo(address);
            case 'ETH':
            case 'MATIC':
            case 'BNB':
                return await this.getEthereumTransactionInfo(cryptoType, address);
            case 'SOL':
                return await this.getSolanaTransactionInfo(address);
            case 'XMR':
                return await this.getMoneroTransactionInfo(address);
            case 'DASH':
                return await this.getDashTransactionInfo(address);
            default:
                throw new Error(`Unsupported cryptocurrency: ${cryptoType}`);
        }
    }

    async getBitcoinTransactionInfo(address) {
        // Get UTXOs and fee information for Bitcoin
        try {
            const response = await fetch(`https://blockstream.info/api/address/${address}/utxo`);
            const utxos = await response.json();
            
            // Get current fee rates
            const feeResponse = await fetch('https://blockstream.info/api/fee-estimates');
            const feeRates = await feeResponse.json();
            
            return {
                type: 'bitcoin',
                utxos: utxos || [],
                feeRates: {
                    fast: feeRates['1'] || 20, // 1 block (~10 min)
                    medium: feeRates['6'] || 10, // 6 blocks (~1 hour) 
                    slow: feeRates['144'] || 1 // 144 blocks (~24 hours)
                },
                network: 'mainnet',
                addressType: 'P2WPKH'
            };
        } catch (error) {
            console.error('Error getting Bitcoin transaction info:', error);
            return {
                type: 'bitcoin',
                utxos: [],
                feeRates: { fast: 20, medium: 10, slow: 1 },
                network: 'mainnet',
                addressType: 'P2WPKH',
                error: error.message
            };
        }
    }

    async getEthereumTransactionInfo(cryptoType, address) {
        // Get nonce and gas price information for Ethereum-based networks
        const networks = {
            ETH: { rpc: 'https://eth.llamarpc.com', chainId: 1, name: 'Ethereum' },
            MATIC: { rpc: 'https://polygon.llamarpc.com', chainId: 137, name: 'Polygon' },
            BNB: { rpc: 'https://bsc-dataseed.binance.org', chainId: 56, name: 'BSC' }
        };
        
        const network = networks[cryptoType.toUpperCase()];
        if (!network) {
            throw new Error(`Unknown Ethereum network: ${cryptoType}`);
        }

        try {
            const provider = new ethers.providers.JsonRpcProvider(network.rpc);
            
            const [nonce, gasPrice, balance] = await Promise.all([
                provider.getTransactionCount(address),
                provider.getGasPrice(),
                provider.getBalance(address)
            ]);

            return {
                type: 'ethereum',
                nonce,
                gasPrice: gasPrice.toString(),
                balance: balance.toString(),
                chainId: network.chainId,
                network: network.name,
                rpcUrl: network.rpc,
                gasLimit: '21000' // Standard transfer gas limit
            };
        } catch (error) {
            console.error(`Error getting ${cryptoType} transaction info:`, error);
            return {
                type: 'ethereum',
                nonce: 0,
                gasPrice: '20000000000', // 20 gwei fallback
                balance: '0',
                chainId: network.chainId,
                network: network.name,
                rpcUrl: network.rpc,
                gasLimit: '21000',
                error: error.message
            };
        }
    }

    async getSolanaTransactionInfo(address) {
        // Get recent blockhash and minimum rent exemption for Solana
        try {
            const response = await fetch('https://api.mainnet-beta.solana.com', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getRecentBlockhash'
                })
            });
            
            const result = await response.json();
            const blockhash = result.result?.value?.blockhash;

            // Get balance
            const balanceResponse = await fetch('https://api.mainnet-beta.solana.com', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getBalance',
                    params: [address]
                })
            });
            
            const balanceResult = await balanceResponse.json();
            const balance = balanceResult.result?.value || 0;

            return {
                type: 'solana',
                blockhash,
                balance,
                network: 'mainnet-beta',
                rpcUrl: 'https://api.mainnet-beta.solana.com',
                minimumRentExemption: 890880 // ~0.0009 SOL for rent exemption
            };
        } catch (error) {
            console.error('Error getting Solana transaction info:', error);
            return {
                type: 'solana',
                blockhash: null,
                balance: 0,
                network: 'mainnet-beta',
                rpcUrl: 'https://api.mainnet-beta.solana.com',
                minimumRentExemption: 890880,
                error: error.message
            };
        }
    }

    async getDashTransactionInfo(address) {
        // Dash transaction info using Insight API
        try {
            // Try multiple Dash APIs
            const apis = [
                `https://insight.dash.org/insight-api/addr/${address}/utxo`,
                `https://explorer.dash.org/insight-api/addr/${address}/utxo`
            ];
            
            let utxos = [];
            for (const apiUrl of apis) {
                try {
                    const response = await fetch(apiUrl);
                    if (response.ok) {
                        utxos = await response.json();
                        break;
                    }
                } catch (apiError) {
                    console.warn(`Failed to fetch from ${apiUrl}:`, apiError.message);
                    continue;
                }
            }
            
            return {
                type: 'dash',
                utxos: utxos || [],
                feeRates: { 
                    fast: 1000, // 1000 duffs per byte (fast)
                    medium: 500, // 500 duffs per byte (medium) 
                    slow: 100 // 100 duffs per byte (slow)
                },
                network: 'mainnet',
                addressType: 'P2PKH',
                minRelayFee: 1000, // 1000 duffs minimum
                dustThreshold: 5460 // 5460 duffs dust threshold
            };
        } catch (error) {
            console.error('Error getting Dash transaction info:', error);
            return {
                type: 'dash',
                utxos: [],
                feeRates: { fast: 1000, medium: 500, slow: 100 },
                network: 'mainnet',
                addressType: 'P2PKH',
                minRelayFee: 1000,
                dustThreshold: 5460,
                error: error.message
            };
        }
    }

    async getMoneroTransactionInfo(address) {
        // Monero transaction info using public APIs
        try {
            // Try to get basic address info from public APIs
            const apis = [
                `https://xmrchain.net/api/outputs?address=${address}&limit=10`,
                `https://moneroblocks.info/api/get_address_info/${address}`
            ];
            
            let addressInfo = null;
            for (const apiUrl of apis) {
                try {
                    const response = await fetch(apiUrl);
                    if (response.ok) {
                        addressInfo = await response.json();
                        break;
                    }
                } catch (apiError) {
                    console.warn(`Failed to fetch from ${apiUrl}:`, apiError.message);
                    continue;
                }
            }
            
            return {
                type: 'monero',
                network: 'mainnet',
                addressInfo: addressInfo || null,
                balance: addressInfo?.total_received || 0,
                unlocked_balance: addressInfo?.total_received || 0,
                outputs: addressInfo?.outputs || [],
                ringSize: 16, // Current Monero ring size
                fee: {
                    priority_1: 0.000012, // Low priority
                    priority_2: 0.000024, // Normal priority  
                    priority_3: 0.000036, // High priority
                    priority_4: 0.000048  // Highest priority
                },
                note: 'Monero requires specialized wallet software for transaction creation'
            };
        } catch (error) {
            console.error('Error getting Monero transaction info:', error);
            return {
                type: 'monero',
                network: 'mainnet',
                balance: 0,
                unlocked_balance: 0,
                outputs: [],
                ringSize: 16,
                fee: {
                    priority_1: 0.000012,
                    priority_2: 0.000024,
                    priority_3: 0.000036,
                    priority_4: 0.000048
                },
                error: error.message,
                note: 'Monero requires specialized wallet software for transaction creation'
            };
        }
    }

    async markAddressAsReusable(channelId) {
        const sql = `
            UPDATE crypto_addresses 
            SET reusable_after = NOW() 
            WHERE channel_id = $1`;
        
        const client = await pool.connect();
        try {
            await client.query(sql, [channelId]);
            console.log(`Marked addresses for channel ${channelId} as immediately reusable`);
        } finally {
            client.release();
        }
    }

    // Fund consolidation methods
    async getAllAddressesWithFunds(cryptoType) {
        const sql = `
            SELECT address, private_key_encrypted, derivation_path, derivation_index, channel_id, created_at
            FROM crypto_addresses 
            WHERE crypto_type = $1 
            ORDER BY created_at ASC`;
        
        const client = await pool.connect();
        try {
            const result = await client.query(sql, [cryptoType]);
            return result.rows;
        } finally {
            client.release();
        }
    }

    /**
     * Decrypt a private key from the database
     * @param {Buffer} encryptedPrivateKey - The encrypted private key from database
     * @returns {string} Decrypted private key (hex string)
     */
    decryptPrivateKey(encryptedPrivateKey) {
        return this.encryption.decryptPrivateKey(encryptedPrivateKey);
    }

    async estimateConsolidationFee(cryptoType, addressCount) {
        try {
            switch (cryptoType.toUpperCase()) {
                case 'BTC':
                    // Bitcoin: estimate fee for multi-input transaction
                    const inputSize = 148; // bytes per input (approximately)
                    const outputSize = 34; // bytes per output
                    const baseSize = 10; // base transaction size
                    const txSize = baseSize + (inputSize * addressCount) + outputSize;
                    
                    return {
                        low: Math.ceil(txSize * 1), // 1 sat/byte
                        medium: Math.ceil(txSize * 5), // 5 sat/byte
                        high: Math.ceil(txSize * 10), // 10 sat/byte
                        txSize,
                        currency: 'sats'
                    };

                case 'DASH':
                    // Dash: similar to Bitcoin
                    const dashTxSize = baseSize + (inputSize * addressCount) + outputSize;
                    return {
                        low: Math.ceil(dashTxSize * 100), // 100 duffs/byte
                        medium: Math.ceil(dashTxSize * 500), // 500 duffs/byte
                        high: Math.ceil(dashTxSize * 1000), // 1000 duffs/byte
                        txSize: dashTxSize,
                        currency: 'duffs'
                    };

                case 'ETH':
                case 'MATIC':
                case 'BNB':
                    // Ethereum-based: single transaction, gas limit increases slightly with more sends
                    const baseGasLimit = 21000;
                    const gasPerSend = 5000; // additional gas per send
                    const totalGasLimit = baseGasLimit + (gasPerSend * addressCount);
                    
                    return {
                        low: totalGasLimit * 20, // 20 gwei
                        medium: totalGasLimit * 50, // 50 gwei
                        high: totalGasLimit * 100, // 100 gwei
                        gasLimit: totalGasLimit,
                        currency: 'gwei'
                    };

                case 'SOL':
                    // Solana: fixed fee per transaction
                    const baseFeeLamports = 5000; // 0.000005 SOL
                    return {
                        low: baseFeeLamports * addressCount,
                        medium: baseFeeLamports * addressCount,
                        high: baseFeeLamports * addressCount,
                        currency: 'lamports'
                    };

                case 'XMR':
                    // Monero: varies by priority
                    return {
                        low: 0.000012 * addressCount, // Low priority
                        medium: 0.000024 * addressCount, // Normal priority
                        high: 0.000048 * addressCount, // High priority
                        currency: 'XMR'
                    };

                default:
                    throw new Error(`Unsupported crypto type: ${cryptoType}`);
            }
        } catch (error) {
            console.error('Error estimating consolidation fee:', error);
            return {
                low: 0,
                medium: 0,
                high: 0,
                currency: 'unknown',
                error: error.message
            };
        }
    }

    async generateConsolidationTransaction(cryptoType, sourceAddresses, destinationAddress, priority = 'medium') {
        try {
            const feeEstimate = await this.estimateConsolidationFee(cryptoType, sourceAddresses.length);
            
            return {
                type: 'consolidation',
                cryptoType,
                sourceAddresses: sourceAddresses.map(addr => addr.address),
                destinationAddress,
                addressCount: sourceAddresses.length,
                estimatedFee: feeEstimate[priority],
                feeEstimate,
                priority,
                instructions: this.getConsolidationInstructions(cryptoType),
                note: 'This is a consolidation operation to gather funds from multiple addresses'
            };
        } catch (error) {
            console.error('Error generating consolidation transaction:', error);
            throw error;
        }
    }

    getConsolidationInstructions(cryptoType) {
        switch (cryptoType.toUpperCase()) {
            case 'BTC':
            case 'DASH':
                return {
                    method: 'UTXO_CONSOLIDATION',
                    description: 'Create a single transaction with multiple inputs (all source addresses) and one output (destination address)',
                    requirements: ['Private keys for all source addresses', 'UTXO data for all addresses', 'Fee calculation'],
                    tool_recommendation: 'Use bitcoinjs-lib or similar library'
                };

            case 'ETH':
            case 'MATIC':
            case 'BNB':
                return {
                    method: 'SEQUENTIAL_TRANSFERS',
                    description: 'Send separate transactions from each source address to destination address',
                    requirements: ['Private keys for all source addresses', 'Current nonce for each address', 'Gas price data'],
                    tool_recommendation: 'Use ethers.js or web3.js'
                };

            case 'SOL':
                return {
                    method: 'BATCH_TRANSFER',
                    description: 'Use Solana batch transfer or send individual transactions',
                    requirements: ['Private keys for all source addresses', 'Recent blockhash', 'Rent exemption data'],
                    tool_recommendation: 'Use @solana/web3.js'
                };

            case 'XMR':
                return {
                    method: 'SPECIALIZED_WALLET',
                    description: 'Monero requires specialized wallet software due to privacy features',
                    requirements: ['Monero wallet software', 'View keys and spend keys', 'Ring signature handling'],
                    tool_recommendation: 'Use official Monero CLI wallet or monero-javascript'
                };

            default:
                return {
                    method: 'UNKNOWN',
                    description: 'Consolidation method not defined for this cryptocurrency',
                    requirements: [],
                    tool_recommendation: 'Research specific implementation requirements'
                };
        }
    }
}

module.exports = CryptoAccountGenerator; 