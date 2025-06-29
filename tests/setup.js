// Jest setup file for subscription tests
const { setupTestDatabase, cleanupTestDatabase } = require('./subscription-integration.test.js');

// Global test setup
beforeAll(async () => {
  // Extend timeout for database operations
  jest.setTimeout(30000);
  
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.TEST_BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3003';
  
  console.log('🧪 Starting subscription system tests...');
});

// Global test cleanup
afterAll(async () => {
  console.log('🧹 Cleaning up test environment...');
});

// Mock console.log to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: console.error // Keep errors visible
}; 