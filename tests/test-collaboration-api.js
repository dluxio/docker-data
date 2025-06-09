#!/usr/bin/env node

/**
 * Test script for Hive Collaboration API
 * 
 * This script demonstrates how to:
 * 1. Create a collaboration document
 * 2. Grant permissions to other users
 * 3. Test authentication headers
 */

const fetch = require('node-fetch');
const { PrivateKey } = require('hive-tx');
const { createHash } = require('crypto');

// Configuration
const BASE_URL = 'https://data.dlux.io/api';  // Use your production URL
const TEST_ACCOUNT = 'disregardfiat';
const TEST_PRIVATE_KEY = ''; // Add your private key for testing

// Test headers (from your workspace rules)
const ADMIN_HEADERS = {
  'x-account': 'disregardfiat',
  'x-challenge': '1749187983',
  'x-pubkey': 'STM7BWmXwvuKHr8FpSPmj8knJspFMPKt3vcetAKKjZ2W2HoRgdkEg',
  'x-signature': '2021d0d63d340b6d963e9761c0cbe8096c65a94ba9cec69aed35b2f1fe891576b83680e82b1bc8018c1c819e02c63bf49386ffb4475cb67d3eadaf3115367877c4'
};

// Generate authentication headers
function generateAuthHeaders(account, privateKey) {
  const challenge = Math.floor(Date.now() / 1000);
  
  if (!privateKey) {
    console.log('⚠️  No private key provided, using mock headers');
    return ADMIN_HEADERS;
  }
  
  try {
    const publicKey = PrivateKey.from(privateKey).createPublic().toString();
    const signature = PrivateKey.from(privateKey)
      .sign(Buffer.from(challenge.toString(), 'utf8'))
      .toString();
    
    return {
      'x-account': account,
      'x-challenge': challenge.toString(),
      'x-pubkey': publicKey,
      'x-signature': signature
    };
  } catch (error) {
    console.error('Error generating auth headers:', error.message);
    console.log('Falling back to admin headers...');
    return ADMIN_HEADERS;
  }
}

// API request helper
async function apiRequest(endpoint, method = 'GET', body = null, headers = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const authHeaders = generateAuthHeaders(TEST_ACCOUNT, TEST_PRIVATE_KEY);
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...headers
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  console.log(`📡 ${method} ${url}`);
  
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    
    if (response.ok) {
      console.log('✅ Success:', data);
      return data;
    } else {
      console.log('❌ Error:', data);
      return null;
    }
  } catch (error) {
    console.error('🚨 Request failed:', error.message);
    return null;
  }
}

// Test functions
async function testCreateDocument() {
  console.log('\n🏗️  Testing document creation...');
  
  const docData = {
    permlink: `test-document-${Date.now()}`,
    isPublic: false,
    title: 'Test Collaboration Document',
    description: 'A test document for collaboration features'
  };
  
  return await apiRequest('/collaboration/documents', 'POST', docData);
}

async function testListDocuments() {
  console.log('\n📋 Testing document list...');
  
  return await apiRequest('/collaboration/documents?limit=10');
}

async function testGrantPermission(owner, permlink, targetAccount) {
  console.log(`\n🔑 Testing permission grant to @${targetAccount}...`);
  
  const permissionData = {
    targetAccount,
    permissionType: 'editable'
  };
  
  return await apiRequest(`/collaboration/permissions/${owner}/${permlink}`, 'POST', permissionData);
}

async function testGetDocumentInfo(owner, permlink) {
  console.log(`\n📄 Testing document info for ${owner}/${permlink}...`);
  
  const info = await apiRequest(`/collaboration/info/${owner}/${permlink}`);
  if (!info) return null;
  
  // Also test permissions
  console.log('\n🔐 Testing permissions...');
  await apiRequest(`/collaboration/permissions/${owner}/${permlink}`);
  
  // And activity
  console.log('\n📊 Testing activity log...');
  await apiRequest(`/collaboration/activity/${owner}/${permlink}`);
  
  return info;
}

async function testWebSocketAuth() {
  console.log('\n🔌 Testing WebSocket authentication token generation...');
  
  const authHeaders = generateAuthHeaders(TEST_ACCOUNT, TEST_PRIVATE_KEY);
  const token = JSON.stringify(authHeaders);
  
  console.log('Generated WebSocket token:');
  console.log(token);
  
  console.log('\n📡 WebSocket connection example:');
  console.log(`ws://localhost:1234/${TEST_ACCOUNT}/test-document`);
  console.log('Token:', token);
  
  return token;
}

// Main test function
async function runTests() {
  console.log('🚀 Starting Hive Collaboration API Tests\n');
  console.log('Base URL:', BASE_URL);
  console.log('Test Account:', TEST_ACCOUNT);
  console.log('Private Key:', TEST_PRIVATE_KEY ? '✅ Provided' : '❌ Missing (using admin headers)');
  
  try {
    // Test 1: List existing documents
    await testListDocuments();
    
    // Test 2: Create a new document
    const newDoc = await testCreateDocument();
    
    if (newDoc && newDoc.success) {
      const { owner, permlink } = newDoc.document;
      
      // Test 3: Get document info
      await testGetDocumentInfo(owner, permlink);
      
      // Test 4: Grant permission to another user
      await testGrantPermission(owner, permlink, 'alice');
      
      // Test 5: WebSocket authentication
      await testWebSocketAuth();
      
      console.log('\n✅ All tests completed!');
      console.log(`\n📝 Test document created: ${owner}/${permlink}`);
      console.log(`🌐 WebSocket URL: ws://localhost:1234/${owner}/${permlink}`);
      
    } else {
      console.log('\n❌ Document creation failed, skipping dependent tests');
    }
    
  } catch (error) {
    console.error('\n🚨 Test suite failed:', error.message);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = {
  generateAuthHeaders,
  apiRequest,
  runTests,
  testCreateDocument,
  testListDocuments,
  testGrantPermission,
  testGetDocumentInfo,
  testWebSocketAuth
}; 