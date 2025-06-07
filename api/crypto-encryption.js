const crypto = require('crypto');

class CryptoEncryption {
    constructor() {
        // Get encryption key from environment or generate one
        this.encryptionKey = this.getOrGenerateEncryptionKey();
        this.algorithm = 'aes-256-cbc';
    }

    getOrGenerateEncryptionKey() {
        if (process.env.CRYPTO_ENCRYPTION_KEY) {
            const key = Buffer.from(process.env.CRYPTO_ENCRYPTION_KEY, 'hex');
            if (key.length !== 32) {
                throw new Error('CRYPTO_ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
            }
            return key;
        } else {
            // Generate a new key for development
            const newKey = crypto.randomBytes(32);
            console.warn('⚠️  No CRYPTO_ENCRYPTION_KEY found in environment, generating new one');
            console.log('🔐 Add this to your .env file:');
            console.log(`CRYPTO_ENCRYPTION_KEY=${newKey.toString('hex')}`);
            return newKey;
        }
    }

    /**
     * Encrypt a private key
     * @param {string} privateKey - The private key to encrypt (hex string)
     * @returns {Buffer} Encrypted data with IV and encrypted data
     */
    encryptPrivateKey(privateKey) {
        try {
            const iv = crypto.randomBytes(16); // 128-bit IV for CBC
            const cipher = crypto.createCipher(this.algorithm, this.encryptionKey, iv);
            
            let encrypted = cipher.update(privateKey, 'utf8');
            encrypted = Buffer.concat([encrypted, cipher.final()]);
            
            // Combine IV + encrypted data
            return Buffer.concat([iv, encrypted]);
        } catch (error) {
            console.error('Error encrypting private key:', error);
            throw new Error('Failed to encrypt private key');
        }
    }

    /**
     * Decrypt a private key
     * @param {Buffer} encryptedData - The encrypted data with IV and encrypted data
     * @returns {string} Decrypted private key (hex string)
     */
    decryptPrivateKey(encryptedData) {
        try {
            if (!Buffer.isBuffer(encryptedData)) {
                throw new Error('Encrypted data must be a Buffer');
            }

            if (encryptedData.length < 16) { // IV(16) minimum
                throw new Error('Invalid encrypted data length');
            }

            const iv = encryptedData.slice(0, 16);
            const encrypted = encryptedData.slice(16);
            
            const decipher = crypto.createDecipher(this.algorithm, this.encryptionKey, iv);
            
            let decrypted = decipher.update(encrypted);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            
            return decrypted.toString('utf8');
        } catch (error) {
            console.error('Error decrypting private key:', error);
            throw new Error('Failed to decrypt private key');
        }
    }

    /**
     * Test encryption/decryption functionality
     * @returns {boolean} True if test passes
     */
    testEncryption() {
        try {
            const testPrivateKey = 'a'.repeat(64); // 64 hex chars = 32 bytes
            const encrypted = this.encryptPrivateKey(testPrivateKey);
            const decrypted = this.decryptPrivateKey(encrypted);
            
            const success = testPrivateKey === decrypted;
            console.log(`🔐 Encryption test: ${success ? 'PASSED' : 'FAILED'}`);
            return success;
        } catch (error) {
            console.error('Encryption test failed:', error);
            return false;
        }
    }
}

module.exports = CryptoEncryption; 