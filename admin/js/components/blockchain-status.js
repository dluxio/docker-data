// Blockchain Status Component
window.DLUX_COMPONENTS['blockchain-status-view'] = {
    props: ['apiClient'],
    emits: ['loading'],
    
    template: `
        <div class="blockchain-status-view">
            <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                <h1 class="h2">Blockchain Monitoring Status</h1>
                <div class="btn-toolbar mb-2 mb-md-0">
                    <button class="btn btn-outline-primary" @click="refreshData" :disabled="loading">
                        <i class="bi bi-arrow-clockwise"></i>
                        Refresh
                    </button>
                </div>
            </div>

            <!-- Network Status Overview -->
            <div class="row mb-4">
                <div class="col-md-3">
                    <div class="card text-white bg-info">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Monitored Networks</h6>
                                    <h3>{{ data.supportedNetworks?.length || 0 }}</h3>
                                </div>
                                <i class="bi bi-globe fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-white bg-success">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Active Monitoring</h6>
                                    <h3>{{ data.status?.isRunning ? 'ON' : 'OFF' }}</h3>
                                </div>
                                <i class="bi bi-activity fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-white bg-warning">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Recent Detections</h6>
                                    <h3>{{ data.recentDetections?.length || 0 }}</h3>
                                </div>
                                <i class="bi bi-search fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-white bg-primary">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Uptime</h6>
                                    <h3>{{ formatUptime(data.status?.uptime) }}</h3>
                                </div>
                                <i class="bi bi-clock fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Network Status Cards -->
            <div class="row mb-4">
                <div class="col-md-12">
                    <div class="card">
                        <div class="card-header">
                            <h5>Network Status</h5>
                        </div>
                        <div class="card-body">
                            <div class="row">
                                <div class="col-md-3" v-for="network in data.supportedNetworks" :key="network">
                                    <div class="card border-0 bg-light mb-3">
                                        <div class="card-body text-center">
                                            <h6>{{ network.toUpperCase() }}</h6>
                                            <div class="mb-2">
                                                <span class="badge" :class="getNetworkStatusClass(network)">
                                                    {{ getNetworkStatus(network) }}
                                                </span>
                                            </div>
                                            <small class="text-muted">
                                                Address: {{ getPaymentAddress(network) }}
                                            </small>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Weekly Statistics Chart -->
            <div class="row mb-4">
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header">
                            <h5>Payment Detections by Network</h5>
                        </div>
                        <div class="card-body">
                            <canvas id="networkDetectionsChart" style="height: 300px;"></canvas>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header">
                            <h5>Payment Status Distribution</h5>
                        </div>
                        <div class="card-body">
                            <canvas id="paymentStatusChart" style="height: 300px;"></canvas>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Recent Payment Detections -->
            <div class="card mb-4">
                <div class="card-header">
                    <h5>Recent Payment Detections (24h)</h5>
                </div>
                <div class="card-body">
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th>Network</th>
                                    <th>Channel ID</th>
                                    <th>Amount</th>
                                    <th>TX Hash</th>
                                    <th>Confirmations</th>
                                    <th>Status</th>
                                    <th>Detected</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="detection in data.recentDetections" :key="detection.channel_id">
                                    <td>
                                        <span class="badge bg-info">{{ detection.crypto_type }}</span>
                                    </td>
                                    <td>
                                        <code>{{ detection.channel_id.substring(0, 8) }}...</code>
                                    </td>
                                    <td>
                                        <strong>{{ detection.amount_crypto }} {{ detection.crypto_type }}</strong>
                                        <br>
                                        <small class="text-muted">{{ detection.amount_received }} received</small>
                                    </td>
                                    <td>
                                        <a :href="getExplorerLink(detection.crypto_type, detection.tx_hash)" 
                                           target="_blank" class="text-decoration-none">
                                            <code>{{ detection.tx_hash.substring(0, 10) }}...</code>
                                            <i class="bi bi-box-arrow-up-right ms-1"></i>
                                        </a>
                                    </td>
                                    <td>
                                        <span class="badge" :class="getConfirmationClass(detection.confirmations)">
                                            {{ detection.confirmations }}
                                        </span>
                                    </td>
                                    <td>
                                        <span class="badge" :class="getStatusClass(detection.status)">
                                            {{ detection.status }}
                                        </span>
                                    </td>
                                    <td>{{ formatDate(detection.detected_at) }}</td>
                                </tr>
                            </tbody>
                        </table>
                        <div v-if="!data.recentDetections || data.recentDetections.length === 0" 
                             class="text-center text-muted py-4">
                            No recent payment detections
                        </div>
                    </div>
                </div>
            </div>

            <!-- Weekly Statistics Summary -->
            <div class="card mb-4">
                <div class="card-header">
                    <h5>Weekly Statistics</h5>
                </div>
                <div class="card-body">
                    <div class="row">
                        <div class="col-md-3" v-for="stat in data.weeklyStats" :key="stat.cryptoType + stat.status">
                            <div class="card border-0 bg-light">
                                <div class="card-body text-center">
                                    <h6>{{ stat.cryptoType }} - {{ stat.status }}</h6>
                                    <h4>{{ stat.count }}</h4>
                                    <small class="text-muted">
                                        Avg: $\${'{{ (stat.avgAmount || 0).toFixed(2) }}'} | 
                                        Total: $\${'{{ (stat.totalUsd || 0).toFixed(2) }}'}
                                    </small>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Payment Addresses -->
            <div class="card">
                <div class="card-header">
                    <h5>Monitored Payment Addresses</h5>
                </div>
                <div class="card-body">
                    <div class="row">
                        <div class="col-md-6" v-for="(address, network) in data.paymentAddresses" :key="network">
                            <div class="card border-0 bg-light mb-3">
                                <div class="card-body">
                                    <h6>{{ network.toUpperCase() }}</h6>
                                    <div class="input-group">
                                        <input type="text" class="form-control" :value="address" readonly>
                                        <button class="btn btn-outline-secondary" @click="copyToClipboard(address)">
                                            <i class="bi bi-clipboard"></i>
                                        </button>
                                    </div>
                                    <small class="text-muted">
                                        <a :href="getAddressExplorerLink(network, address)" target="_blank">
                                            View on Explorer <i class="bi bi-box-arrow-up-right"></i>
                                        </a>
                                    </small>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Alerts -->
            <div v-if="alert.message" :class="'alert alert-' + alert.type + ' mt-3'" role="alert">
                <i class="bi" :class="alert.icon"></i>
                {{ alert.message }}
                <button type="button" class="btn-close" @click="clearAlert"></button>
            </div>
        </div>
    `,

    data() {
        return {
            loading: false,
            data: {
                status: null,
                supportedNetworks: [],
                paymentAddresses: {},
                recentDetections: [],
                weeklyStats: []
            },
            alert: {
                message: '',
                type: 'info',
                icon: ''
            },
            charts: {
                networkDetections: null,
                paymentStatus: null
            }
        };
    },

    async mounted() {
        await this.loadData();
    },

    methods: {
        async loadData() {
            this.loading = true;
            this.$emit('loading', true);
            
            try {
                const response = await this.apiClient.get('/api/admin/blockchain-status');
                
                if (response.success) {
                    this.data = {
                        status: response.blockchainMonitoring.status,
                        supportedNetworks: response.blockchainMonitoring.supportedNetworks || [],
                        paymentAddresses: response.blockchainMonitoring.paymentAddresses || {},
                        recentDetections: response.blockchainMonitoring.recentDetections || [],
                        weeklyStats: response.blockchainMonitoring.weeklyStats || []
                    };

                    // Create charts after data loads
                    this.$nextTick(() => {
                        this.createCharts();
                    });
                } else {
                    this.showAlert('Failed to load blockchain status', 'danger', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error loading blockchain status:', error);
                this.showAlert('Error loading blockchain status: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.loading = false;
                this.$emit('loading', false);
            }
        },

        async refreshData() {
            await this.loadData();
        },

        createCharts() {
            this.createNetworkDetectionsChart();
            this.createPaymentStatusChart();
        },

        createNetworkDetectionsChart() {
            const ctx = document.getElementById('networkDetectionsChart');
            if (!ctx) return;

            if (this.charts.networkDetections) {
                this.charts.networkDetections.destroy();
            }

            // Count detections by network
            const networkCounts = {};
            this.data.recentDetections.forEach(detection => {
                const network = detection.crypto_type;
                networkCounts[network] = (networkCounts[network] || 0) + 1;
            });

            const labels = Object.keys(networkCounts);
            const data = Object.values(networkCounts);
            const colors = ['#e31337', '#28a745', '#ffc107', '#17a2b8', '#6f42c1', '#fd7e14'];

            this.charts.networkDetections = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Detections',
                        data: data,
                        backgroundColor: colors.slice(0, labels.length),
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1
                            }
                        }
                    }
                }
            });
        },

        createPaymentStatusChart() {
            const ctx = document.getElementById('paymentStatusChart');
            if (!ctx) return;

            if (this.charts.paymentStatus) {
                this.charts.paymentStatus.destroy();
            }

            // Count by status
            const statusCounts = {};
            this.data.weeklyStats.forEach(stat => {
                statusCounts[stat.status] = (statusCounts[stat.status] || 0) + stat.count;
            });

            const labels = Object.keys(statusCounts);
            const data = Object.values(statusCounts);
            const colors = {
                'completed': '#28a745',
                'confirmed': '#17a2b8',
                'pending': '#ffc107',
                'failed': '#dc3545'
            };

            this.charts.paymentStatus = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: labels.map(label => colors[label] || '#6c757d'),
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false
                }
            });
        },

        getNetworkStatus(network) {
            // This would typically come from the API
            return 'Active';
        },

        getNetworkStatusClass(network) {
            return 'bg-success'; // Assume all networks are active
        },

        getPaymentAddress(network) {
            const address = this.data.paymentAddresses[network];
            return address ? address.substring(0, 12) + '...' : 'N/A';
        },

        getExplorerLink(cryptoType, txHash) {
            const explorers = {
                'BTC': `https://blockstream.info/tx/${txHash}`,
                'ETH': `https://etherscan.io/tx/${txHash}`,
                'BNB': `https://bscscan.com/tx/${txHash}`,
                'MATIC': `https://polygonscan.com/tx/${txHash}`,
                'SOL': `https://explorer.solana.com/tx/${txHash}`
            };
            return explorers[cryptoType] || '#';
        },

        getAddressExplorerLink(network, address) {
            const explorers = {
                'btc': `https://blockstream.info/address/${address}`,
                'eth': `https://etherscan.io/address/${address}`,
                'bnb': `https://bscscan.com/address/${address}`,
                'matic': `https://polygonscan.com/address/${address}`,
                'sol': `https://explorer.solana.com/address/${address}`
            };
            return explorers[network.toLowerCase()] || '#';
        },

        getConfirmationClass(confirmations) {
            if (confirmations >= 6) return 'bg-success';
            if (confirmations >= 3) return 'bg-warning';
            return 'bg-danger';
        },

        getStatusClass(status) {
            switch (status?.toLowerCase()) {
                case 'completed': return 'bg-success';
                case 'confirmed': return 'bg-info';
                case 'pending': return 'bg-warning';
                case 'failed': return 'bg-danger';
                default: return 'bg-secondary';
            }
        },

        formatUptime(uptime) {
            if (!uptime) return '0m';
            const hours = Math.floor(uptime / 3600000);
            const minutes = Math.floor((uptime % 3600000) / 60000);
            if (hours > 0) {
                return `${hours}h ${minutes}m`;
            }
            return `${minutes}m`;
        },

        formatDate(dateString) {
            if (!dateString) return 'N/A';
            return new Date(dateString).toLocaleString();
        },

        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.showAlert('Address copied to clipboard', 'success', 'bi-check-circle');
            } catch (error) {
                this.showAlert('Failed to copy address', 'warning', 'bi-exclamation-triangle');
            }
        },

        showAlert(message, type, icon) {
            this.alert = { message, type, icon };
            setTimeout(() => {
                this.clearAlert();
            }, 5000);
        },

        clearAlert() {
            this.alert = { message: '', type: 'info', icon: '' };
        }
    }
}; 