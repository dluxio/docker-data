const { PrivateKey, PublicKey, Signature } = require('hive-tx')
const fetch = require('node-fetch')
const { sha256 } = require("hive-tx/helpers/crypto.js")

/**
 * Minimal Hive authentication utilities for collaboration server
 * This avoids importing the full onboarding module which has side effects
 */
class CollaborationAuth {
  /**
   * Get account keys from HIVE blockchain
   */
  static async getAccountKeys(account) {
    try {
      const response = await fetch('https://api.hive.blog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'condenser_api.get_accounts',
          params: [[account]],
          id: 1
        })
      })
      
      const data = await response.json()
      
      if (!data.result || data.result.length === 0) {
        return null
      }
      
      const accountData = data.result[0]
      
      return {
        owner: accountData.owner.key_auths.map(auth => auth[0]),
        active: accountData.active.key_auths.map(auth => auth[0]),
        posting: accountData.posting.key_auths.map(auth => auth[0]),
        memo: accountData.memo_key
      }
    } catch (error) {
      console.error('Error fetching account keys:', error)
      return null
    }
  }
  
  /**
   * Verify signature using HIVE cryptography
   */
  static async verifySignature(challenge, signature, key) {
    try {
            const publicKey = PublicKey.from(key);
            const message = sha256(challenge);
            return publicKey.verify(message, Signature.from(signature));
    } catch (error) {
        console.error('Signature verification error:', error);
        return false
    }
}
}

module.exports = { CollaborationAuth } 