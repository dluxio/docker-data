// ACT Status Component
window.DLUX_COMPONENTS['act-status-view'] = {
    props: ['apiClient'],
    emits: ['loading'],
    
    template: `
        <div class="act-status-view">
            <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                <h1 class="h2">Account Creation Tokens (ACT)</h1>
                <div class="btn-toolbar mb-2 mb-md-0">
                    <button class="btn btn-outline-primary me-2" @click="refreshData" :disabled="loading">
                        <i class="bi bi-arrow-clockwise"></i>
                        Refresh
                    </button>
                    <button class="btn btn-warning me-2" @click="claimACT" :disabled="loading">
                        <i class="bi bi-plus-circle"></i>
                        Claim ACT
                    </button>
                    <button class="btn btn-info me-2" @click="processAccounts" :disabled="loading">
                        <i class="bi bi-gear"></i>
                        Process Pending
                    </button>
                    <button class="btn btn-success" @click="healthCheck" :disabled="loading">
                        <i class="bi bi-heart-pulse"></i>
                        Health Check
                    </button>
                </div>
            </div>

            <!-- Status Cards -->
            <div class="row mb-4">
                <div class="col-md-3">
                    <div class="card text-white bg-primary">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Current ACT Balance</h6>
                                    <h3>{{ data.actBalance || 0 }}</h3>
                                </div>
                                <i class="bi bi-wallet2 fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-white bg-success">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Resource Credits</h6>
                                    <h3>{{ formatRC(data.resourceCredits) }}</h3>
                                </div>
                                <i class="bi bi-lightning fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-white bg-warning">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">RC Percentage</h6>
                                    <h3>{{ data.rcPercentage }}%</h3>
                                </div>
                                <i class="bi bi-battery-half fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-white bg-info">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Pending Creations</h6>
                                    <h3>{{ data.pendingCount || 0 }}</h3>
                                </div>
                                <i class="bi bi-hourglass-split fs-1 opacity-50"></i>
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
                            <h5>ACT Usage Trend (7 days)</h5>
                        </div>
                        <div class="card-body">
                            <canvas id="actUsageChart" style="height: 300px;"></canvas>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="card">
                        <div class="card-header">
                            <h5>Account Creation Methods</h5>
                        </div>
                        <div class="card-body">
                            <canvas id="creationMethodsChart" style="height: 300px;"></canvas>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Recent Account Creations -->
            <div class="card mb-4">
                <div class="card-header">
                    <h5>Recent Account Creations</h5>
                </div>
                <div class="card-body">
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th>Username</th>
                                    <th>Method</th>
                                    <th>Status</th>
                                    <th>ACT Used</th>
                                    <th>Fee</th>
                                    <th>Created</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="account in data.recentCreations" :key="account.id">
                                    <td><strong>@{{ account.requested_username }}</strong></td>
                                    <td>
                                        <span class="badge bg-info">{{ account.creation_method }}</span>
                                    </td>
                                    <td>
                                        <span class="badge" :class="getStatusClass(account.status)">
                                            {{ account.status }}
                                        </span>
                                    </td>
                                    <td>{{ account.act_used || 0 }}</td>
                                    <td>\\${{ account.creation_fee || 'Free' }}</td>
                                    <td>{{ formatDate(account.created_at) }}</td>
                                    <td>
                                        <div class="btn-group btn-group-sm">
                                            <button class="btn btn-outline-info btn-sm" 
                                                    @click="viewAccountDetails(account)"
                                                    title="View Details">
                                                <i class="bi bi-eye"></i>
                                            </button>
                                            <button v-if="account.status === 'pending'" 
                                                    class="btn btn-outline-warning btn-sm"
                                                    @click="retryAccountCreation(account)"
                                                    title="Retry Creation">
                                                <i class="bi bi-arrow-clockwise"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- Statistics Summary -->
            <div class="card">
                <div class="card-header">
                    <h5>Weekly Statistics</h5>
                </div>
                <div class="card-body">
                    <div class="row">
                        <div class="col-md-3" v-for="stat in data.weeklyStats" :key="stat.creation_method + stat.status">
                            <div class="card border-0 bg-light">
                                <div class="card-body text-center">
                                    <h6>{{ stat.creation_method }} - {{ stat.status }}</h6>
                                    <h4>{{ stat.count }}</h4>
                                    <small class="text-muted">
                                        ACTs: {{ stat.total_acts_used || 0 }} | 
                                        Avg Fee: \\${{ (stat.avg_fee || 0).toFixed(2) }}
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
                actBalance: 0,
                resourceCredits: 0,
                rcPercentage: 0,
                pendingCount: 0,
                recentCreations: [],
                weeklyStats: []
            },
            alert: {
                message: '',
                type: 'info',
                icon: ''
            },
            charts: {
                actUsage: null,
                creationMethods: null
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
                const response = await this.apiClient.get('/api/onboarding/admin/act-status');
                
                if (response.success) {
                    const statusData = response.data?.actStatus || response.actStatus || {};
                    this.data = {
                        actBalance: statusData.currentACTBalance || 0,
                        resourceCredits: statusData.currentResourceCredits || 0,
                        rcPercentage: statusData.rcPercentage || 0,
                        pendingCount: response.data?.pendingCount || response.pendingCount || 0,
                        recentCreations: response.data?.recentCreations || response.recentCreations || [],
                        weeklyStats: response.data?.creationStats || response.creationStats || []
                    };

                    // Create charts after data loads
                    this.$nextTick(() => {
                        this.createCharts();
                    });
                } else {
                    this.showAlert('Failed to load ACT status', 'danger', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error loading ACT status:', error);
                this.showAlert('Error loading ACT status: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.loading = false;
                this.$emit('loading', false);
            }
        },

        async refreshData() {
            await this.loadData();
        },

        async claimACT() {
            this.loading = true;
            try {
                const response = await this.apiClient.post('/api/onboarding/admin/claim-act');
                
                if (response.success) {
                    this.showAlert('ACT claimed successfully!', 'success', 'bi-check-circle');
                    await this.loadData();
                } else {
                    this.showAlert('Failed to claim ACT: ' + response.error, 'warning', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error claiming ACT:', error);
                this.showAlert('Error claiming ACT: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.loading = false;
            }
        },

        async processAccounts() {
            this.loading = true;
            try {
                const response = await this.apiClient.post('/api/onboarding/admin/process-pending');
                
                if (response.success) {
                    this.showAlert('Pending account processing triggered', 'info', 'bi-info-circle');
                    await this.loadData();
                } else {
                    this.showAlert('Failed to process accounts: ' + response.error, 'warning', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error processing accounts:', error);
                this.showAlert('Error processing accounts: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.loading = false;
            }
        },

        async healthCheck() {
            this.loading = true;
            try {
                const response = await this.apiClient.post('/api/onboarding/admin/health-check');
                
                if (response.success) {
                    this.showAlert('Health check completed successfully', 'success', 'bi-check-circle');
                    await this.loadData();
                } else {
                    this.showAlert('Health check failed: ' + response.error, 'warning', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error running health check:', error);
                this.showAlert('Error running health check: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.loading = false;
            }
        },

        createCharts() {
            this.createACTUsageChart();
            this.createCreationMethodsChart();
        },

        createACTUsageChart() {
            const ctx = document.getElementById('actUsageChart');
            if (!ctx) return;

            if (this.charts.actUsage) {
                this.charts.actUsage.destroy();
            }

            // Generate last 7 days data
            const labels = [];
            const actData = [];
            const today = new Date();
            
            for (let i = 6; i >= 0; i--) {
                const date = new Date(today);
                date.setDate(date.getDate() - i);
                labels.push(date.toLocaleDateString());
                
                // Count ACTs used on this day
                const dayUsage = this.data.recentCreations
                    .filter(acc => acc && acc.created_at && new Date(acc.created_at).toDateString() === date.toDateString())
                    .reduce((sum, acc) => sum + (acc.act_used || 0), 0);
                
                actData.push(dayUsage);
            }

            this.charts.actUsage = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'ACTs Used',
                        data: actData,
                        backgroundColor: 'rgba(54, 162, 235, 0.5)',
                        borderColor: 'rgba(54, 162, 235, 1)',
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
                    }
                }
            });
        },

        createCreationMethodsChart() {
            const ctx = document.getElementById('creationMethodsChart');
            if (!ctx) return;

            if (this.charts.creationMethods) {
                this.charts.creationMethods.destroy();
            }

            // Count creation methods
            const methodCounts = {};
            this.data.recentCreations.forEach(acc => {
                if (acc) {
                    const method = acc.creation_method || 'Unknown';
                    methodCounts[method] = (methodCounts[method] || 0) + 1;
                }
            });

            const labels = Object.keys(methodCounts);
            const data = Object.values(methodCounts);
            const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40'];

            this.charts.creationMethods = new Chart(ctx, {
                type: 'pie',
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

        showAlert(message, type, icon) {
            this.alert = { message, type, icon };
            setTimeout(() => {
                this.clearAlert();
            }, 5000);
        },

        clearAlert() {
            this.alert = { message: '', type: 'info', icon: '' };
        },

        formatRC(rc) {
            if (!rc) return '0';
            if (rc >= 1e9) return (rc / 1e9).toFixed(2) + 'B';
            if (rc >= 1e6) return (rc / 1e6).toFixed(2) + 'M';
            if (rc >= 1e3) return (rc / 1e3).toFixed(2) + 'K';
            return rc.toLocaleString();
        },

        formatDate(dateString) {
            if (!dateString) return 'N/A';
            return new Date(dateString).toLocaleString();
        },

        getStatusClass(status) {
            switch (status?.toLowerCase()) {
                case 'completed': return 'bg-success';
                case 'pending': return 'bg-warning';
                case 'failed': return 'bg-danger';
                case 'confirmed': return 'bg-info';
                default: return 'bg-secondary';
            }
        },

        viewAccountDetails(account) {
            // Could implement a modal or detailed view
            console.log('View account details:', account);
        },

        async retryAccountCreation(account) {
            // Could implement retry functionality
            console.log('Retry account creation:', account);
        }
    }
}; 