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
                <div class="col-md-3" v-for="stat in data.summary" :key="stat.status">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title text-capitalize">{{ stat.status }}</h6>
                                    <h3>{{ stat.count }}</h3>
                                    <small class="text-muted">\${{ (stat.total_usd || 0).toFixed(2) }}</small>
                                </div>
                                <i class="bi fs-1 opacity-50" :class="getStatusIcon(stat.status)"></i>
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
                                <tr v-for="channel in data.channels" :key="channel.channel_id">
                                    <td>
                                        <code>{{ channel.channel_id.substring(0, 8) }}...</code>
                                        <button class="btn btn-sm btn-outline-secondary ms-1" 
                                                @click="copyToClipboard(channel.channel_id)"
                                                title="Copy full ID">
                                            <i class="bi bi-clipboard"></i>
                                        </button>
                                    </td>
                                    <td>
                                        <strong>@{{ channel.username }}</strong>
                                    </td>
                                    <td>
                                        <span class="badge bg-info">{{ channel.crypto_type }}</span>
                                    </td>
                                    <td>
                                        <strong>{{ channel.amount_crypto }} {{ channel.crypto_type }}</strong>
                                    </td>
                                    <td>
                                        \${{ (channel.amount_usd || 0).toFixed(2) }}
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
                summary: [],
                totalCount: 0
            },
            filters: {
                status: null,
                cryptoType: null,
                days: 7,
                limit: 50,
                offset: 0
            },
            currentPage: 1,
            selectedChannel: null,
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
        totalPages() {
            return Math.ceil(this.data.totalCount / this.filters.limit);
        },

        visiblePages() {
            const pages = [];
            const start = Math.max(1, this.currentPage - 2);
            const end = Math.min(this.totalPages, this.currentPage + 2);
            
            for (let i = start; i <= end; i++) {
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
                    limit: this.filters.limit,
                    offset: this.filters.offset,
                    days: this.filters.days
                });

                if (this.filters.status) {
                    params.append('status', this.filters.status);
                }
                if (this.filters.cryptoType) {
                    params.append('crypto_type', this.filters.cryptoType);
                }

                const response = await this.apiClient.get(`/api/onboarding/admin/channels?${params}`);
                
                if (response.success) {
                    this.data = {
                        channels: response.data?.channels || response.channels || [],
                        summary: response.data?.summary || response.summary || [],
                        totalCount: response.data?.totalCount || response.totalCount || 0
                    };

                    // Create charts after data loads
                    this.$nextTick(() => {
                        this.createCharts();
                    });
                } else {
                    this.showAlert('Failed to load payment channels', 'danger', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error loading payment channels:', error);
                this.showAlert('Error loading payment channels: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.loading = false;
                this.$emit('loading', false);
            }
        },

        async refreshData() {
            this.filters.offset = 0;
            this.currentPage = 1;
            await this.loadData();
        },

        setStatusFilter(status) {
            this.filters.status = status;
            this.refreshData();
        },

        setCryptoFilter(cryptoType) {
            this.filters.cryptoType = cryptoType;
            this.refreshData();
        },

        goToPage(page) {
            if (page < 1 || page > this.totalPages) return;
            this.currentPage = page;
            this.filters.offset = (page - 1) * this.filters.limit;
            this.loadData();
        },

        createCharts() {
            this.createCryptoTypeChart();
            this.createProcessingTimeChart();
        },

        createCryptoTypeChart() {
            const ctx = document.getElementById('cryptoTypeChart');
            if (!ctx) return;

            if (this.charts.cryptoType) {
                this.charts.cryptoType.destroy();
            }

            // Count by crypto type
            const cryptoCounts = {};
            this.data.channels.forEach(channel => {
                if (channel && channel.crypto_type) {
                    const crypto = channel.crypto_type;
                    cryptoCounts[crypto] = (cryptoCounts[crypto] || 0) + 1;
                }
            });

            const labels = Object.keys(cryptoCounts);
            const data = Object.values(cryptoCounts);
            const colors = ['#e31337', '#28a745', '#ffc107', '#17a2b8', '#6f42c1'];

            this.charts.cryptoType = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: colors.slice(0, labels.length),
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false
                }
            });
        },

        createProcessingTimeChart() {
            const ctx = document.getElementById('processingTimeChart');
            if (!ctx) return;

            if (this.charts.processingTime) {
                this.charts.processingTime.destroy();
            }

            // Group processing times into buckets
            const buckets = {
                '< 1 min': 0,
                '1-5 min': 0,
                '5-15 min': 0,
                '15-60 min': 0,
                '> 1 hour': 0
            };

            this.data.channels.forEach(channel => {
                if (channel && channel.processing_time_seconds) {
                    const minutes = channel.processing_time_seconds / 60;
                    if (minutes < 1) buckets['< 1 min']++;
                    else if (minutes <= 5) buckets['1-5 min']++;
                    else if (minutes <= 15) buckets['5-15 min']++;
                    else if (minutes <= 60) buckets['15-60 min']++;
                    else buckets['> 1 hour']++;
                }
            });

            const labels = Object.keys(buckets);
            const data = Object.values(buckets);

            this.charts.processingTime = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Channels',
                        data: data,
                        backgroundColor: 'rgba(54, 162, 235, 0.5)',
                        borderColor: 'rgba(54, 162, 235, 1)',
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

        viewChannelDetails(channel) {
            this.selectedChannel = channel;
            const modal = new bootstrap.Modal(document.getElementById('channelDetailsModal'));
            modal.show();
        },

        openExplorer(channel) {
            const explorers = {
                'BTC': `https://blockstream.info/address/${channel.payment_address}`,
                'ETH': `https://etherscan.io/address/${channel.payment_address}`,
                'BNB': `https://bscscan.com/address/${channel.payment_address}`,
                'MATIC': `https://polygonscan.com/address/${channel.payment_address}`,
                'SOL': `https://explorer.solana.com/address/${channel.payment_address}`
            };
            
            const url = explorers[channel.crypto_type];
            if (url) {
                window.open(url, '_blank');
            }
        },

        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.showAlert('Copied to clipboard', 'success', 'bi-check-circle');
            } catch (error) {
                this.showAlert('Failed to copy', 'warning', 'bi-exclamation-triangle');
            }
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

        getStatusIcon(status) {
            switch (status?.toLowerCase()) {
                case 'completed': return 'bi-check-circle';
                case 'confirmed': return 'bi-info-circle';
                case 'pending': return 'bi-hourglass-split';
                case 'failed': return 'bi-x-circle';
                default: return 'bi-circle';
            }
        },

        formatProcessingTime(seconds) {
            if (seconds < 60) return `${seconds}s`;
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `${minutes}m`;
            const hours = Math.floor(minutes / 60);
            return `${hours}h ${minutes % 60}m`;
        },

        formatDate(dateString) {
            if (!dateString) return 'N/A';
            return new Date(dateString).toLocaleString();
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