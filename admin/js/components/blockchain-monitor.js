const BlockchainMonitorView = {
    template: `
        <div class="blockchain-monitor-view">
            <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                <h1 class="h2">Blockchain Monitor</h1>
                <div class="btn-group">
                    <button class="btn btn-outline-primary" @click="refreshData" :disabled="loading">
                        <i class="bi bi-arrow-clockwise"></i>
                        Refresh
                    </button>
                </div>
            </div>

            <div class="row">
                <div class="col-md-6 mb-4">
                    <div class="card">
                        <div class="card-header">
                            <h5>Block Processing Status</h5>
                        </div>
                        <div class="card-body">
                            <div class="row">
                                <div class="col-6">
                                    <h6>Current Block</h6>
                                    <h3>{{ formatNumber(currentBlock) }}</h3>
                                </div>
                                <div class="col-6">
                                    <h6>Last Processed Block</h6>
                                    <h3>{{ formatNumber(lastProcessedBlock) }}</h3>
                                </div>
                            </div>
                            <div class="mt-3">
                                <div class="progress">
                                    <div class="progress-bar" role="progressbar" 
                                         :style="{ width: processingProgress + '%' }"
                                         :class="processingProgressClass">
                                        {{ processingProgress.toFixed(1) }}%
                                    </div>
                                </div>
                                <small class="text-muted mt-2 d-block">
                                    {{ blocksRemaining }} blocks remaining
                                </small>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="col-md-6 mb-4">
                    <div class="card">
                        <div class="card-header">
                            <h5>Monitor Status</h5>
                        </div>
                        <div class="card-body">
                            <div class="row">
                                <div class="col-6">
                                    <h6>Status</h6>
                                    <h3 :class="isRunning ? 'text-success' : 'text-danger'">
                                        {{ isRunning ? 'Running' : 'Stopped' }}
                                    </h3>
                                </div>
                                <div class="col-6">
                                    <h6>Active Listeners</h6>
                                    <h3>{{ activeListeners }}</h3>
                                </div>
                            </div>
                            <div class="mt-3">
                                <button class="btn btn-primary" 
                                        @click="toggleMonitor" 
                                        :disabled="loading">
                                    {{ isRunning ? 'Stop Monitor' : 'Start Monitor' }}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="row">
                <div class="col-md-12 mb-4">
                    <div class="card">
                        <div class="card-header">
                            <h5>API Health Status</h5>
                        </div>
                        <div class="card-body">
                            <div class="row">
                                <div class="col-md-3">
                                    <h6>API Status</h6>
                                    <h4 :class="getApiStatusClass(apiHealth.status)">
                                        {{ formatApiStatus(apiHealth.status) }}
                                    </h4>
                                </div>
                                <div class="col-md-3">
                                    <h6>Error Count</h6>
                                    <h4>{{ apiHealth.errorCount || 0 }}</h4>
                                </div>
                                <div class="col-md-3">
                                    <h6>Consecutive Errors</h6>
                                    <h4>{{ apiHealth.consecutiveErrors || 0 }}</h4>
                                </div>
                                <div class="col-md-3">
                                    <h6>Retry Delay</h6>
                                    <h4>{{ formatDelay(retryDelay) }}</h4>
                                </div>
                            </div>
                            <div v-if="apiHealth.lastError" class="mt-3">
                                <h6>Last Error:</h6>
                                <div class="alert alert-warning">
                                    <small>{{ apiHealth.lastError.message || apiHealth.lastError }}</small>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `,

    props: {
        apiClient: {
            type: Object,
            required: true
        }
    },

    data() {
        return {
            loading: false,
            currentBlock: 0,
            lastProcessedBlock: 0,
            isRunning: false,
            activeListeners: 0,
            apiHealth: {},
            retryDelay: 0,
            refreshInterval: null
        };
    },

    computed: {
        blocksRemaining() {
            return Math.max(0, this.currentBlock - this.lastProcessedBlock);
        },
        processingProgress() {
            if (this.currentBlock === 0) return 0;
            return Math.min(100, (this.lastProcessedBlock / this.currentBlock) * 100);
        },
        processingProgressClass() {
            if (this.processingProgress > 95) return 'bg-success';
            if (this.processingProgress > 80) return 'bg-warning';
            return 'bg-danger';
        }
    },

    methods: {
        async refreshData() {
            this.loading = true;
            try {
                const response = await fetch('/api/onboarding/admin/blockchain-monitor-status', {
                    headers: this.apiClient.getAuthHeaders()
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const result = await response.json();
                if (result.success && result.data) {
                    const data = result.data;
                    this.currentBlock = data.currentBlock;
                    this.lastProcessedBlock = data.lastProcessedBlock;
                    this.isRunning = data.isRunning;
                    this.activeListeners = data.activeListeners;
                    this.apiHealth = data.apiHealth || {};
                    this.retryDelay = data.retryDelay;
                } else {
                    throw new Error(result.error || 'Failed to fetch blockchain monitor status');
                }
            } catch (error) {
                console.error('Error fetching blockchain monitor status:', error);
                // Show error to user
                alert('Error fetching blockchain monitor status: ' + error.message);
            } finally {
                this.loading = false;
            }
        },

        async toggleMonitor() {
            this.loading = true;
            try {
                const action = this.isRunning ? 'stop' : 'start';
                const response = await fetch(`/api/onboarding/admin/blockchain-monitor/${action}`, {
                    method: 'POST',
                    headers: this.apiClient.getAuthHeaders()
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const result = await response.json();
                if (result.success) {
                    await this.refreshData();
                    alert(result.message);
                } else {
                    throw new Error(result.error || 'Failed to toggle blockchain monitor');
                }
            } catch (error) {
                console.error('Error toggling blockchain monitor:', error);
                alert('Error toggling blockchain monitor: ' + error.message);
            } finally {
                this.loading = false;
            }
        },

        formatNumber(num) {
            return new Intl.NumberFormat().format(num);
        },

        formatApiStatus(status) {
            const statusMap = {
                'healthy': 'Healthy',
                'rate_limited': 'Rate Limited',
                'parse_error': 'Parse Error',
                'error': 'Error',
                'unknown': 'Unknown'
            };
            return statusMap[status] || status;
        },

        getApiStatusClass(status) {
            const classMap = {
                'healthy': 'text-success',
                'rate_limited': 'text-warning',
                'parse_error': 'text-danger',
                'error': 'text-danger',
                'unknown': 'text-muted'
            };
            return classMap[status] || 'text-muted';
        },

        formatDelay(delay) {
            if (delay < 1000) return `${delay}ms`;
            return `${(delay / 1000).toFixed(1)}s`;
        }
    },

    mounted() {
        this.refreshData();
        // Refresh data every 30 seconds
        this.refreshInterval = setInterval(this.refreshData, 30000);
    },

    beforeUnmount() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
    }
};

// Register the component
Vue.createApp(BlockchainMonitorView).mount('#blockchain-monitor'); 