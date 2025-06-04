/**
 * Performance monitoring utility for blockchain operations
 * Tracks API calls, response times, caching, and rate limiting
 */

class PerformanceMonitor {
    constructor() {
        this.metrics = {
            apiCalls: new Map(), // API endpoint -> call stats
            responseNimes: new Map(), // endpoint -> response time history
            cacheHits: new Map(), // cache key -> hit/miss stats
            rateLimits: new Map(), // API -> rate limit info
            errors: new Map(), // error type -> count
            networkStats: new Map() // network -> monitoring stats
        };
        
        this.cache = new Map(); // Simple in-memory cache
        this.rateLimiters = new Map(); // Rate limiters per API
        this.startTime = Date.now();
        
        // Cleanup interval for old metrics
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldMetrics();
        }, 5 * 60 * 1000); // Every 5 minutes
    }

    // Start timing an operation
    startTimer(operation, metadata = {}) {
        const timerId = `${operation}_${Date.now()}_${Math.random()}`;
        const timer = {
            operation,
            startTime: Date.now(),
            metadata
        };
        
        // Store in a temporary map for completion
        if (!this.activeTimers) {
            this.activeTimers = new Map();
        }
        this.activeTimers.set(timerId, timer);
        
        return timerId;
    }

    // End timing and record metrics
    endTimer(timerId, additionalMetadata = {}) {
        if (!this.activeTimers || !this.activeTimers.has(timerId)) {
            console.warn('Timer not found:', timerId);
            return null;
        }

        const timer = this.activeTimers.get(timerId);
        const duration = Date.now() - timer.startTime;
        
        this.recordResponseTime(timer.operation, duration, {
            ...timer.metadata,
            ...additionalMetadata
        });

        this.activeTimers.delete(timerId);
        return duration;
    }

    // Record API call metrics
    recordAPICall(endpoint, method = 'GET', success = true, responseTime = null, responseSize = null) {
        const key = `${method}:${endpoint}`;
        
        if (!this.metrics.apiCalls.has(key)) {
            this.metrics.apiCalls.set(key, {
                totalCalls: 0,
                successfulCalls: 0,
                failedCalls: 0,
                totalResponseTime: 0,
                avgResponseTime: 0,
                lastCall: null,
                responseSize: [],
                errors: []
            });
        }

        const stats = this.metrics.apiCalls.get(key);
        stats.totalCalls++;
        stats.lastCall = new Date();

        if (success) {
            stats.successfulCalls++;
        } else {
            stats.failedCalls++;
        }

        if (responseTime !== null) {
            stats.totalResponseTime += responseTime;
            stats.avgResponseTime = stats.totalResponseTime / stats.totalCalls;
        }

        if (responseSize !== null) {
            stats.responseSize.push(responseSize);
            // Keep only last 100 response sizes
            if (stats.responseSize.length > 100) {
                stats.responseSize = stats.responseSize.slice(-100);
            }
        }
    }

    // Record response time for specific operations
    recordResponseTime(operation, duration, metadata = {}) {
        if (!this.metrics.responseNimes.has(operation)) {
            this.metrics.responseNimes.set(operation, []);
        }

        const times = this.metrics.responseNimes.get(operation);
        times.push({
            duration,
            timestamp: Date.now(),
            metadata
        });

        // Keep only last 1000 measurements per operation
        if (times.length > 1000) {
            times.splice(0, times.length - 1000);
        }
    }

    // Cache management
    getCached(key) {
        const cached = this.cache.get(key);
        if (!cached) {
            this.recordCacheHit(key, false);
            return null;
        }

        // Check if expired
        if (cached.expiry && Date.now() > cached.expiry) {
            this.cache.delete(key);
            this.recordCacheHit(key, false);
            return null;
        }

        this.recordCacheHit(key, true);
        return cached.data;
    }

    setCached(key, data, ttlSeconds = 300) {
        const expiry = ttlSeconds > 0 ? Date.now() + (ttlSeconds * 1000) : null;
        this.cache.set(key, { data, expiry });
    }

    recordCacheHit(key, hit) {
        if (!this.metrics.cacheHits.has(key)) {
            this.metrics.cacheHits.set(key, { hits: 0, misses: 0 });
        }

        const stats = this.metrics.cacheHits.get(key);
        if (hit) {
            stats.hits++;
        } else {
            stats.misses++;
        }
    }

    // Rate limiting
    checkRateLimit(apiKey, limit = 60, windowMs = 60000) { // 60 requests per minute default
        if (!this.rateLimiters.has(apiKey)) {
            this.rateLimiters.set(apiKey, {
                requests: [],
                limit,
                windowMs
            });
        }

        const limiter = this.rateLimiters.get(apiKey);
        const now = Date.now();
        
        // Remove old requests outside the window
        limiter.requests = limiter.requests.filter(time => now - time < limiter.windowMs);
        
        // Check if under limit
        if (limiter.requests.length >= limiter.limit) {
            this.recordRateLimitHit(apiKey, true);
            return false;
        }

        // Add current request
        limiter.requests.push(now);
        this.recordRateLimitHit(apiKey, false);
        return true;
    }

    recordRateLimitHit(apiKey, limited) {
        if (!this.metrics.rateLimits.has(apiKey)) {
            this.metrics.rateLimits.set(apiKey, {
                totalRequests: 0,
                rateLimitedRequests: 0,
                lastRateLimit: null
            });
        }

        const stats = this.metrics.rateLimits.get(apiKey);
        stats.totalRequests++;
        
        if (limited) {
            stats.rateLimitedRequests++;
            stats.lastRateLimit = new Date();
        }
    }

    // Error tracking
    recordError(errorType, message, metadata = {}) {
        if (!this.metrics.errors.has(errorType)) {
            this.metrics.errors.set(errorType, {
                count: 0,
                lastOccurrence: null,
                messages: [],
                metadata: []
            });
        }

        const errorStats = this.metrics.errors.get(errorType);
        errorStats.count++;
        errorStats.lastOccurrence = new Date();
        errorStats.messages.push(message);
        errorStats.metadata.push(metadata);

        // Keep only last 50 messages
        if (errorStats.messages.length > 50) {
            errorStats.messages = errorStats.messages.slice(-50);
            errorStats.metadata = errorStats.metadata.slice(-50);
        }
    }

    // Network-specific monitoring
    recordNetworkStats(network, stats) {
        if (!this.metrics.networkStats.has(network)) {
            this.metrics.networkStats.set(network, {
                blocksProcessed: 0,
                transactionsFound: 0,
                addressesMonitored: 0,
                lastBlockHeight: 0,
                avgBlockTime: 0,
                blockTimes: []
            });
        }

        const networkStats = this.metrics.networkStats.get(network);
        Object.assign(networkStats, stats);
        
        // Track block times for average calculation
        if (stats.blockTime) {
            networkStats.blockTimes.push(stats.blockTime);
            if (networkStats.blockTimes.length > 100) {
                networkStats.blockTimes = networkStats.blockTimes.slice(-100);
            }
            networkStats.avgBlockTime = networkStats.blockTimes.reduce((a, b) => a + b, 0) / networkStats.blockTimes.length;
        }
    }

    // Get performance metrics
    getMetrics() {
        return {
            uptime: Date.now() - this.startTime,
            apiCalls: this.getAPICallSummary(),
            responseNimes: this.getResponseTimeSummary(),
            cacheStats: this.getCacheStatsSummary(),
            rateLimits: this.getRateLimitSummary(),
            errors: this.getErrorSummary(),
            networkStats: Object.fromEntries(this.metrics.networkStats),
            memoryUsage: this.getMemoryUsage()
        };
    }

    getAPICallSummary() {
        const summary = {};
        for (const [endpoint, stats] of this.metrics.apiCalls) {
            summary[endpoint] = {
                totalCalls: stats.totalCalls,
                successRate: stats.totalCalls > 0 ? (stats.successfulCalls / stats.totalCalls * 100).toFixed(2) + '%' : '0%',
                avgResponseTime: Math.round(stats.avgResponseTime) + 'ms',
                lastCall: stats.lastCall,
                avgResponseSize: stats.responseSize.length > 0 ? 
                    Math.round(stats.responseSize.reduce((a, b) => a + b, 0) / stats.responseSize.length) + ' bytes' : 'N/A'
            };
        }
        return summary;
    }

    getResponseTimeSummary() {
        const summary = {};
        for (const [operation, times] of this.metrics.responseNimes) {
            if (times.length === 0) continue;
            
            const durations = times.map(t => t.duration);
            const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
            const min = Math.min(...durations);
            const max = Math.max(...durations);
            const p95 = this.calculatePercentile(durations, 95);
            
            summary[operation] = {
                count: times.length,
                avg: Math.round(avg) + 'ms',
                min: min + 'ms',
                max: max + 'ms',
                p95: Math.round(p95) + 'ms'
            };
        }
        return summary;
    }

    getCacheStatsSummary() {
        let totalHits = 0;
        let totalMisses = 0;
        
        for (const stats of this.metrics.cacheHits.values()) {
            totalHits += stats.hits;
            totalMisses += stats.misses;
        }
        
        const total = totalHits + totalMisses;
        return {
            hitRate: total > 0 ? ((totalHits / total) * 100).toFixed(2) + '%' : '0%',
            totalRequests: total,
            cacheSize: this.cache.size
        };
    }

    getRateLimitSummary() {
        const summary = {};
        for (const [api, stats] of this.metrics.rateLimits) {
            summary[api] = {
                totalRequests: stats.totalRequests,
                rateLimited: stats.rateLimitedRequests,
                rateLimitRate: stats.totalRequests > 0 ? 
                    ((stats.rateLimitedRequests / stats.totalRequests) * 100).toFixed(2) + '%' : '0%',
                lastRateLimit: stats.lastRateLimit
            };
        }
        return summary;
    }

    getErrorSummary() {
        const summary = {};
        for (const [errorType, stats] of this.metrics.errors) {
            summary[errorType] = {
                count: stats.count,
                lastOccurrence: stats.lastOccurrence,
                recentMessage: stats.messages[stats.messages.length - 1] || 'N/A'
            };
        }
        return summary;
    }

    getMemoryUsage() {
        if (typeof process !== 'undefined' && process.memoryUsage) {
            const usage = process.memoryUsage();
            return {
                heapUsed: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100 + ' MB',
                heapTotal: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100 + ' MB',
                external: Math.round(usage.external / 1024 / 1024 * 100) / 100 + ' MB'
            };
        }
        return { error: 'Memory usage not available' };
    }

    // Utility function to calculate percentiles
    calculatePercentile(arr, percentile) {
        const sorted = arr.slice().sort((a, b) => a - b);
        const index = (percentile / 100) * (sorted.length - 1);
        
        if (Math.floor(index) === index) {
            return sorted[index];
        } else {
            const lower = sorted[Math.floor(index)];
            const upper = sorted[Math.ceil(index)];
            const weight = index % 1;
            return lower * (1 - weight) + upper * weight;
        }
    }

    // Cleanup old metrics to prevent memory leaks
    cleanupOldMetrics() {
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        const cutoff = Date.now() - maxAge;

        // Clean up old response times
        for (const [operation, times] of this.metrics.responseNimes) {
            const filtered = times.filter(t => t.timestamp > cutoff);
            this.metrics.responseNimes.set(operation, filtered);
        }

        // Clean up expired cache entries
        for (const [key, cached] of this.cache) {
            if (cached.expiry && Date.now() > cached.expiry) {
                this.cache.delete(key);
            }
        }

        // Clean up old rate limit data
        for (const [api, limiter] of this.rateLimiters) {
            limiter.requests = limiter.requests.filter(time => Date.now() - time < limiter.windowMs * 2);
        }
    }

    // Generate performance report
    generateReport() {
        const metrics = this.getMetrics();
        const report = {
            timestamp: new Date().toISOString(),
            uptime: Math.round(metrics.uptime / 1000 / 60) + ' minutes',
            summary: {
                totalAPICalls: Object.values(metrics.apiCalls).reduce((sum, api) => sum + api.totalCalls, 0),
                cacheHitRate: metrics.cacheStats.hitRate,
                errorCount: Object.values(metrics.errors).reduce((sum, error) => sum + error.count, 0),
                avgResponseTime: this.calculateOverallAvgResponseTime()
            },
            details: metrics
        };

        return report;
    }

    calculateOverallAvgResponseTime() {
        let totalTime = 0;
        let totalCalls = 0;

        for (const stats of this.metrics.apiCalls.values()) {
            totalTime += stats.totalResponseTime;
            totalCalls += stats.totalCalls;
        }

        return totalCalls > 0 ? Math.round(totalTime / totalCalls) + 'ms' : '0ms';
    }

    // Shutdown cleanup
    shutdown() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.cache.clear();
        this.metrics = null;
    }
}

// Export singleton instance
module.exports = new PerformanceMonitor(); 