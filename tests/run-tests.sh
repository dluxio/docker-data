#!/bin/bash

# Hive Onboarding API Test Runner
# Usage: ./tests/run-tests.sh [options]

echo "🔬 Hive Onboarding API Test Runner"
echo "=================================="

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is required but not installed."
    exit 1
fi

# Check if axios is available
if ! node -e "require('axios')" 2>/dev/null; then
    echo "❌ Error: axios dependency is missing. Please run 'npm install axios'"
    exit 1
fi

# Set default base URL
BASE_URL="https://data.dlux.io"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --url)
            BASE_URL="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --url <url>    Set base URL for API testing (default: https://data.dlux.io)"
            echo "  --help, -h     Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                           # Test against production API"
            echo "  $0 --url http://localhost:3010  # Test against local API"
            exit 0
            ;;
        *)
            echo "❌ Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

echo "📍 Target API: $BASE_URL"
echo "⏰ Test started at: $(date)"
echo ""

# Run the test suite
if [ "$BASE_URL" != "https://data.dlux.io" ]; then
    # Custom URL - modify the test file temporarily
    node -e "
        const TestSuite = require('./tests/api-test-suite.js');
        const testSuite = new TestSuite('$BASE_URL');
        testSuite.runAllTests().catch(console.error);
    "
else
    # Default URL
    node tests/api-test-suite.js
fi

TEST_EXIT_CODE=$?

echo ""
echo "⏰ Test completed at: $(date)"

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "🎉 Test suite execution completed!"
else
    echo "⚠️  Test suite execution finished with errors (exit code: $TEST_EXIT_CODE)"
fi

exit $TEST_EXIT_CODE 