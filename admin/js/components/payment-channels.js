// Payment Channels Component
window.DLUX_COMPONENTS['payment-channels-view'] = {
    props: ['apiClient'],
    emits: ['loading'],
    
    template: `
        <div class="payment-channels-view">
            <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                <h1 class="h2">Payment Channels</h1>
                <div class="btn-toolbar mb-2 mb-md-0">
                    <div class="btn-group me-2">
                        <button class="btn btn-outline-primary" @click="refreshData" :disabled="loading">
                            <i class="bi bi-arrow-clockwise"></i>
                            Refresh
                        </button>
                        <div class="btn-group">
                            <button class="btn btn-outline-secondary dropdown-toggle" data-bs-toggle="dropdown">
                                <i class="bi bi-funnel"></i>
                                Filter
                            </button>
                            <ul class="dropdown-menu">
                                <li><a class="dropdown-item" @click="setStatusFilter(null)">All Status</a></li>
                                <li><a class="dropdown-item" @click="setStatusFilter('pending')">Pending</a></li>
                                <li><a class="dropdown-item" @click="setStatusFilter('confirmed')">Confirmed</a></li>
                                <li><a class="dropdown-item" @click="setStatusFilter('completed')">Completed</a></li>
                                <li><a class="dropdown-item" @click="setStatusFilter('failed')">Failed</a></li>
                                <li><hr class="dropdown-divider"></li>
                                <li><a class="dropdown-item" @click="setCryptoFilter(null)">All Crypto</a></li>
                                <li><a class="dropdown-item" @click="setCryptoFilter('BTC')">Bitcoin</a></li>
                                <li><a class="dropdown-item" @click="setCryptoFilter('ETH')">Ethereum</a></li>
                                <li><a class="dropdown-item" @click="setCryptoFilter('BNB')">BNB</a></li>
                                <li><a class="dropdown-item" @click="setCryptoFilter('SOL')">Solana</a></li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Summary Cards -->
            <div class="row mb-4">
                <div class="col-md-3" v-for="(stat, status) in data.summary" :key="status">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title text-capitalize">{{ status }}</h6>
                                    <h3>{{ stat.count || 0 }}</h3>
                                    <small class="text-muted">Avg: {{ getAverageDisplay(stat.totalUsd, stat.count) }} | Total: {{ getTotalDisplay(stat.totalUsd) }}</small>
                                </div>
                                <i class="bi fs-1 opacity-50" :class="getStatusIcon(status)"></i>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Charts Row -->
            <div class="row mb-4">
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header">
                            <h5>Channels by Crypto Type</h5>
                        </div>
                        <div class="card-body">
                            <canvas id="cryptoTypeChart" style="height: 300px;"></canvas>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header">
                            <h5>Processing Time Distribution</h5>
                        </div>
                        <div class="card-body">
                            <canvas id="processingTimeChart" style="height: 300px;"></canvas>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Active Filters -->
            <div class="mb-3" v-if="filters.status || filters.cryptoType">
                <span class="me-2">Active filters:</span>
                <span v-if="filters.status" class="badge bg-primary me-2">
                    Status: {{ filters.status }}
                    <button class="btn-close btn-close-white ms-1" @click="setStatusFilter(null)"></button>
                </span>
                <span v-if="filters.cryptoType" class="badge bg-info me-2">
                    Crypto: {{ filters.cryptoType }}
                    <button class="btn-close btn-close-white ms-1" @click="setCryptoFilter(null)"></button>
                </span>
            </div>

            <!-- Channels Table -->
            <div class="card">
                <div class="card-header d-flex justify-content-between align-items-center">
                    <h5>Payment Channels ({{ data.channels.length }} of {{ data.totalCount }})</h5>
                    <div class="d-flex align-items-center">
                        <label class="form-label me-2 mb-0">Days:</label>
                        <select class="form-select form-select-sm" v-model="filters.days" @change="refreshData" style="width: auto;">
                            <option value="1">1 day</option>
                            <option value="7">7 days</option>
                            <option value="30">30 days</option>
                            <option value="90">90 days</option>
                        </select>
                    </div>
                </div>
                <div class="card-body">
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th>Channel ID</th>
                                    <th>Username</th>
                                    <th>Crypto</th>
                                    <th>Amount</th>
                                    <th>USD Value</th>
                                    <th>Status</th>
                                    <th>Processing Time</th>
                                    <th>Created</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="channel in data.channels" :key="channel.channelId || channel.channel_id">
                                    <td>
                                        <code>{{ getChannelIdDisplay(channel) }}</code>
                                        <button class="btn btn-sm btn-outline-secondary ms-1" 
                                                @click="copyToClipboard(channel.channelId || channel.channel_id)"
                                                title="Copy full ID">
                                            <i class="bi bi-clipboard"></i>
                                        </button>
                                    </td>
                                    <td>
                                        <strong>@{{ channel.username }}</strong>
                                    </td>
                                    <td>
                                        <span class="badge bg-info">{{ channel.cryptoType || channel.crypto_type || 'N/A' }}</span>
                                    </td>
                                    <td>
                                        <strong>{{ getAmountDisplay(channel) }}</strong>
                                    </td>
                                    <td>
                                        {{ getUsdDisplay(channel) }}
                                    </td>
                                    <td>
                                        <span class="badge" :class="getStatusClass(channel.status)">
                                            {{ channel.status }}
                                        </span>
                                    </td>
                                    <td>
                                        <span v-if="channel.processing_time_seconds">
                                            {{ formatProcessingTime(channel.processing_time_seconds) }}
                                        </span>
                                        <span v-else class="text-muted">-</span>
                                    </td>
                                    <td>{{ formatDate(channel.created_at) }}</td>
                                    <td>
                                        <div class="btn-group btn-group-sm">
                                            <button class="btn btn-outline-info" 
                                                    @click="viewChannelDetails(channel)"
                                                    title="View Details">
                                                <i class="bi bi-eye"></i>
                                            </button>
                                            <button v-if="channel.payment_address" 
                                                    class="btn btn-outline-secondary"
                                                    @click="openExplorer(channel)"
                                                    title="View on Blockchain">
                                                <i class="bi bi-box-arrow-up-right"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <div v-if="!data.channels || data.channels.length === 0" 
                             class="text-center text-muted py-4">
                            No payment channels found for the selected filters
                        </div>
                    </div>
                </div>

                <!-- Pagination -->
                <div class="card-footer" v-if="data.totalCount > filters.limit">
                    <nav>
                        <ul class="pagination pagination-sm justify-content-center mb-0">
                            <li class="page-item" :class="{ disabled: currentPage === 1 }">
                                <button class="page-link" @click="goToPage(currentPage - 1)">Previous</button>
                            </li>
                            <li class="page-item" 
                                v-for="page in visiblePages" 
                                :key="page"
                                :class="{ active: page === currentPage }">
                                <button class="page-link" @click="goToPage(page)">{{ page }}</button>
                            </li>
                            <li class="page-item" :class="{ disabled: currentPage === totalPages }">
                                <button class="page-link" @click="goToPage(currentPage + 1)">Next</button>
                            </li>
                        </ul>
                    </nav>
                </div>
            </div>

            <!-- Channel Details Modal -->
            <div class="modal fade" id="channelDetailsModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Channel Details</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedChannel">
                            <div class="row">
                                <div class="col-md-6">
                                    <h6>Basic Information</h6>
                                    <table class="table table-sm">
                                        <tbody>
                                            <tr>
                                                <td><strong>Channel ID:</strong></td>
                                                <td><code>{{ selectedChannel.channel_id || 'N/A' }}</code></td>
                                            </tr>
                                            <tr>
                                                <td><strong>Username:</strong></td>
                                                <td>@{{ selectedChannel.username || 'N/A' }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Status:</strong></td>
                                                <td>
                                                    <span class="badge" :class="getStatusClass(selectedChannel.status)">
                                                        {{ selectedChannel.status || 'Unknown' }}
                                                    </span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td><strong>Created:</strong></td>
                                                <td>{{ formatDate(selectedChannel.created_at) }}</td>
                                            </tr>
                                            <tr v-if="selectedChannel.confirmed_at">
                                                <td><strong>Confirmed:</strong></td>
                                                <td>{{ formatDate(selectedChannel.confirmed_at) }}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                                <div class="col-md-6">
                                    <h6>Payment Information</h6>
                                    <table class="table table-sm">
                                        <tbody>
                                            <tr>
                                                <td><strong>Crypto Type:</strong></td>
                                                <td><span class="badge bg-info">{{ selectedChannel.crypto_type || 'N/A' }}</span></td>
                                            </tr>
                                            <tr>
                                                <td><strong>Amount:</strong></td>
                                                <td>{{ selectedChannel.amount_crypto || 0 }} {{ selectedChannel.crypto_type || '' }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>USD Value:</strong></td>
                                                <td>\${{ (selectedChannel.amount_usd || 0).toFixed(2) }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Address:</strong></td>
                                                <td><code>{{ selectedChannel.payment_address || 'N/A' }}</code></td>
                                            </tr>
                                            <tr v-if="selectedChannel.memo">
                                                <td><strong>Memo:</strong></td>
                                                <td><code>{{ selectedChannel.memo }}</code></td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
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
                channels: [],
                summary: {},
                totalCount: 0
            },
            selectedChannel: null,
            filters: {
                status: null,
                cryptoType: null,
                days: 30,
                limit: 50,
                offset: 0
            },
            alert: {
                message: '',
                type: 'info',
                icon: ''
            },
            charts: {
                cryptoType: null,
                processingTime: null
            }
        };
    },

    computed: {
        currentPage() {
            return Math.floor(this.filters.offset / this.filters.limit) + 1;
        },
        
        totalPages() {
            return Math.ceil(this.data.totalCount / this.filters.limit);
        },
        
        visiblePages() {
            const total = this.totalPages;
            const current = this.currentPage;
            const pages = [];
            
            for (let i = Math.max(1, current - 2); i <= Math.min(total, current + 2); i++) {
                pages.push(i);
            }
            return pages;
        }
    },

    async mounted() {
        await this.loadData();
    },

    methods: {
        async loadData() {
            this.loading = true;
            this.$emit('loading', true);
            
            try {
                const params = new URLSearchParams({
                    days: this.filters.days,
                    limit: this.filters.limit,
                    offset: this.filters.offset
                });
                
                if (this.filters.status) {
                    params.append('status', this.filters.status);
                }
                if (this.filters.cryptoType) {
                    params.append('cryptoType', this.filters.cryptoType);
                }
                
                const response = await this.apiClient.get(`/api/onboarding/admin/payment-channels?${params}`);
                
                if (response.ok) {
                    const result = await response.json();
                    this.data = {
                        channels: result.channels || [],
                        summary: result.summary || {},
                        totalCount: result.totalCount || 0
                    };
                    
                    setTimeout(() => this.createCharts(), 100);
                } else {
                    console.error('Failed to load payment channels:', response.statusText);
                    this.showAlert('Failed to load payment channels', 'danger', 'exclamation-triangle');
                }
            } catch (error) {
                console.error('Error loading payment channels:', error);
                this.showAlert('Error loading payment channels: ' + error.message, 'danger', 'exclamation-triangle');
            } finally {
                this.loading = false;
                this.$emit('loading', false);
            }
        },
        
        async refreshData() {
            await this.loadData();
        },
        
        setStatusFilter(status) {
            this.filters.status = status;
            this.filters.offset = 0;
            this.refreshData();
        },
        
        setCryptoFilter(cryptoType) {
            this.filters.cryptoType = cryptoType;
            this.filters.offset = 0;
            this.refreshData();
        },
        
        goToPage(page) {
            if (page >= 1 && page <= this.totalPages) {
                this.filters.offset = (page - 1) * this.filters.limit;
                this.loadData();
            }
        },
        
        createCharts() {
            this.createCryptoTypeChart();
            this.createProcessingTimeChart();
        },
        
        createCryptoTypeChart() {
            const ctx = document.getElementById('cryptoTypeChart');
            if (!ctx) return;
            
            // Destroy existing chart if it exists
            if (window.cryptoChart) {
                window.cryptoChart.destroy();
            }
            
            const cryptoData = {};
            for (const channel of this.data.channels) {
                const crypto = channel.cryptoType || channel.crypto_type || 'Unknown';
                cryptoData[crypto] = (cryptoData[crypto] || 0) + 1;
            }
            
            window.cryptoChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: Object.keys(cryptoData),
                    datasets: [{
                        data: Object.values(cryptoData),
                        backgroundColor: [
                            '#FF6384',
                            '#36A2EB',
                            '#FFCE56',
                            '#4BC0C0',
                            '#9966FF',
                            '#FF9F40'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom'
                        }
                    }
                }
            });
        },
        
        createProcessingTimeChart() {
            const ctx = document.getElementById('processingTimeChart');
            if (!ctx) return;
            
            // Destroy existing chart if it exists
            if (window.timeChart) {
                window.timeChart.destroy();
            }
            
            const timeRanges = {
                '< 1 min': 0,
                '1-5 min': 0,
                '5-15 min': 0,
                '15-60 min': 0,
                '> 1 hour': 0
            };
            
            for (const channel of this.data.channels) {
                const seconds = channel.processing_time_seconds;
                if (!seconds) continue;
                
                const minutes = seconds / 60;
                if (minutes < 1) timeRanges['< 1 min']++;
                else if (minutes < 5) timeRanges['1-5 min']++;
                else if (minutes < 15) timeRanges['5-15 min']++;
                else if (minutes < 60) timeRanges['15-60 min']++;
                else timeRanges['> 1 hour']++;
            }
            
            window.timeChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: Object.keys(timeRanges),
                    datasets: [{
                        label: 'Number of Channels',
                        data: Object.values(timeRanges),
                        backgroundColor: '#36A2EB',
                        borderColor: '#36A2EB',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        }
                    }
                }
            });
        },
        
        viewChannelDetails(channel) {
            this.selectedChannel = channel;
            const modal = new bootstrap.Modal(document.getElementById('channelDetailsModal'));
            modal.show();
        },
        
        openExplorer(channel) {
            const explorerUrls = {
                'BTC': `https://blockstream.info/address/${channel.payment_address}`,
                'ETH': `https://etherscan.io/address/${channel.payment_address}`,
                'BNB': `https://bscscan.com/address/${channel.payment_address}`,
                'MATIC': `https://polygonscan.com/address/${channel.payment_address}`,
                'SOL': `https://solscan.io/account/${channel.payment_address}`
            };
            
            const cryptoType = channel.cryptoType || channel.crypto_type;
            const url = explorerUrls[cryptoType];
            if (url) {
                window.open(url, '_blank');
            }
        },
        
        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.showAlert('Copied to clipboard!', 'success', 'check');
            } catch (err) {
                console.error('Failed to copy to clipboard:', err);
                this.showAlert('Failed to copy to clipboard', 'warning', 'exclamation');
            }
        },
        
        getStatusClass(status) {
            const classes = {
                'pending': 'bg-warning text-dark',
                'confirmed': 'bg-info',
                'completed': 'bg-success',
                'failed': 'bg-danger'
            };
            return classes[status] || 'bg-secondary';
        },
        
        getStatusIcon(status) {
            const icons = {
                'pending': 'bi-clock',
                'confirmed': 'bi-check-circle',
                'completed': 'bi-check-circle-fill',
                'failed': 'bi-x-circle'
            };
            return icons[status] || 'bi-question-circle';
        },
        
        formatProcessingTime(seconds) {
            if (seconds < 60) return `${seconds}s`;
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
        },
        
        formatDate(dateString) {
            if (!dateString) return 'N/A';
            return new Date(dateString).toLocaleString();
        },
        
        showAlert(message, type = 'info', icon = 'info-circle') {
            // This will be handled by the parent component or global alert system
            console.log(`Alert [${type}]: ${message}`);
        },
        
        clearAlert() {
            // Clear any existing alerts
        },
        
        getAverage(totalUsd, count) {
            return count > 0 ? (totalUsd / count).toFixed(2) : '0.00';
        },
        
        // Template helper methods
        getChannelIdDisplay(channel) {
            const id = channel.channelId || channel.channel_id || 'N/A';
            return id.length > 8 ? id.substring(0, 8) + '...' : id;
        },
        
        getAmountDisplay(channel) {
            const amount = channel.amountCrypto || channel.amount_crypto || 0;
            const crypto = channel.cryptoType || channel.crypto_type || '';
            return `${amount} ${crypto}`;
        },
        
        getUsdDisplay(channel) {
            const usd = (channel.amountUsd || channel.amount_usd) || 0;
            return `$${usd.toFixed(2)}`;
        },
        
        getAverageDisplay(totalUsd, count) {
            return `$${this.getAverage(totalUsd, count)}`;
        },
        
        getTotalDisplay(totalUsd) {
            return `$${(totalUsd || 0).toFixed(2)}`;
        }
    }
}; 