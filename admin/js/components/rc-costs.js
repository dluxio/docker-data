// RC Costs Component
window.DLUX_COMPONENTS['rc-costs-view'] = {
    props: ['apiClient'],
    emits: ['loading'],
    
    template: `
        <div class="rc-costs-view">
            <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                <h1 class="h2">Resource Credit Costs</h1>
                <div class="btn-toolbar mb-2 mb-md-0">
                    <button class="btn btn-outline-primary" @click="refreshData" :disabled="loading">
                        <i class="bi bi-arrow-clockwise"></i>
                        Refresh
                    </button>
                </div>
            </div>

            <!-- Key Operations Summary -->
            <div class="row mb-4">
                <div class="col-md-4">
                    <div class="card text-white bg-primary">
                        <div class="card-body">
                            <h6 class="card-title">Claim Account Operation</h6>
                            <h4>{{ formatRC(data.keyOperations.claim_account?.rc_needed) }}</h4>
                            <small>{{ data.keyOperations.claim_account?.hp_needed }} HP</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card text-white bg-success">
                        <div class="card-body">
                            <h6 class="card-title">Create Claimed Account</h6>
                            <h4>{{ formatRC(data.keyOperations.create_claimed_account?.rc_needed) }}</h4>
                            <small>{{ data.keyOperations.create_claimed_account?.hp_needed }} HP</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card text-white bg-warning">
                        <div class="card-body">
                            <h6 class="card-title">Create Account (Direct)</h6>
                            <h4>{{ formatRC(data.keyOperations.create_account?.rc_needed) }}</h4>
                            <small>{{ data.keyOperations.create_account?.hp_needed }} HP</small>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Summary Stats -->
            <div class="row mb-4">
                <div class="col-md-12">
                    <div class="card">
                        <div class="card-header">
                            <h5>Cost Efficiency Analysis</h5>
                        </div>
                        <div class="card-body">
                            <div class="row text-center">
                                <div class="col-md-3">
                                    <h6>Total Operations Tracked</h6>
                                    <h3>{{ data.summary.totalOperations }}</h3>
                                </div>
                                <div class="col-md-3">
                                    <h6>Claim Cost (Billion RC)</h6>
                                    <h3>{{ data.summary.claimAccountCostInBillionRC }}</h3>
                                </div>
                                <div class="col-md-3">
                                    <h6>Create Cost (Million RC)</h6>
                                    <h3>{{ data.summary.createAccountCostInMillionRC }}</h3>
                                </div>
                                <div class="col-md-3">
                                    <h6>Efficiency Ratio</h6>
                                    <h3>{{ data.summary.efficiencyRatio }}x</h3>
                                    <small class="text-muted">Claim vs Create</small>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Historical Trends Chart -->
            <div class="row mb-4">
                <div class="col-md-12">
                    <div class="card">
                        <div class="card-header">
                            <h5>RC Cost Trends (7 days)</h5>
                        </div>
                        <div class="card-body">
                            <canvas id="rcTrendsChart" style="height: 400px;"></canvas>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Trends Analysis -->
            <div class="row mb-4" v-if="Object.keys(data.trends).length > 0">
                <div class="col-md-12">
                    <div class="card">
                        <div class="card-header">
                            <h5>Cost Change Analysis</h5>
                        </div>
                        <div class="card-body">
                            <div class="row">
                                <div class="col-md-4" v-for="(trend, operation) in data.trends" :key="operation">
                                    <div class="card border-0 bg-light">
                                        <div class="card-body text-center">
                                            <h6>{{ formatOperationName(operation) }}</h6>
                                            <h4 :class="getTrendClass(trend.change_direction)">
                                                <i class="bi" :class="getTrendIcon(trend.change_direction)"></i>
                                                {{ trend.change_percent.toFixed(2) }}%
                                            </h4>
                                            <small class="text-muted">
                                                {{ trend.change_direction.toUpperCase() }}
                                            </small>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Detailed RC Costs Table -->
            <div class="card mb-4">
                <div class="card-header">
                    <h5>All Operation Costs</h5>
                </div>
                <div class="card-body">
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th>Operation</th>
                                    <th>RC Needed</th>
                                    <th>HP Needed</th>
                                    <th>RC (Formatted)</th>
                                    <th>Relative Cost</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="(cost, operation) in data.currentCosts" :key="operation">
                                    <td>
                                        <strong>{{ formatOperationName(operation) }}</strong>
                                        <span v-if="isKeyOperation(operation)" class="badge bg-primary ms-2">Key</span>
                                    </td>
                                    <td>{{ cost.rc_needed?.toLocaleString() }}</td>
                                    <td>{{ cost.hp_needed }}</td>
                                    <td>{{ formatRC(cost.rc_needed) }}</td>
                                    <td>
                                        <div class="progress" style="height: 20px;">
                                            <div class="progress-bar" 
                                                 :style="{ width: getRelativeCost(cost.rc_needed) + '%' }"
                                                 :class="getProgressBarClass(cost.rc_needed)">
                                                {{ getRelativeCost(cost.rc_needed) }}%
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- Historical Data -->
            <div class="card" v-if="Object.keys(data.historical).length > 0">
                <div class="card-header">
                    <h5>Historical Data (Last 7 Days)</h5>
                </div>
                <div class="card-body">
                    <div class="accordion" id="historicalAccordion">
                        <div class="accordion-item" v-for="(history, operation) in data.historical" :key="operation">
                            <h2 class="accordion-header">
                                <button class="accordion-button collapsed" type="button" 
                                        :data-bs-target="'#collapse' + operation.replace(/[^a-zA-Z0-9]/g, '')"
                                        data-bs-toggle="collapse">
                                    {{ formatOperationName(operation) }} 
                                    <span class="badge bg-secondary ms-2">{{ history.length }} records</span>
                                </button>
                            </h2>
                            <div :id="'collapse' + operation.replace(/[^a-zA-Z0-9]/g, '')" 
                                 class="accordion-collapse collapse"
                                 data-bs-parent="#historicalAccordion">
                                <div class="accordion-body">
                                    <div class="table-responsive">
                                        <table class="table table-sm">
                                            <thead>
                                                <tr>
                                                    <th>Timestamp</th>
                                                    <th>RC Needed</th>
                                                    <th>HP Needed</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <tr v-for="record in history.slice(0, 10)" :key="record.timestamp">
                                                    <td>{{ formatDate(record.timestamp) }}</td>
                                                    <td>{{ record.rc_needed.toLocaleString() }}</td>
                                                    <td>{{ record.hp_needed }}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
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
                lastUpdate: null,
                currentCosts: {},
                keyOperations: {
                    claim_account: null,
                    create_claimed_account: null,
                    create_account: null
                },
                historical: {},
                trends: {},
                summary: {
                    totalOperations: 0,
                    claimAccountCostInBillionRC: 'N/A',
                    createAccountCostInMillionRC: 'N/A',
                    efficiencyRatio: 'N/A'
                }
            },
            alert: {
                message: '',
                type: 'info',
                icon: ''
            },
            chart: null
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
                const response = await this.apiClient.get('/api/onboarding/admin/rc-costs');
                
                if (response.success) {
                    this.data = {
                        lastUpdate: response.rcCosts.lastUpdate,
                        currentCosts: response.rcCosts.currentCosts || {},
                        keyOperations: response.rcCosts.keyOperations || {},
                        historical: response.rcCosts.historical || {},
                        trends: response.rcCosts.trends || {},
                        summary: response.rcCosts.summary || this.data.summary
                    };

                    // Create chart after data loads
                    this.$nextTick(() => {
                        this.createTrendsChart();
                    });
                } else {
                    this.showAlert('Failed to load RC costs', 'danger', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error loading RC costs:', error);
                this.showAlert('Error loading RC costs: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.loading = false;
                this.$emit('loading', false);
            }
        },

        async refreshData() {
            await this.loadData();
        },

        createTrendsChart() {
            const ctx = document.getElementById('rcTrendsChart');
            if (!ctx) return;

            if (this.chart) {
                this.chart.destroy();
            }

            const operations = ['claim_account_operation', 'create_claimed_account_operation', 'account_create_operation'];
            const datasets = [];
            const colors = ['#e31337', '#28a745', '#ffc107'];

            operations.forEach((op, index) => {
                if (this.data.historical[op] && this.data.historical[op].length > 0) {
                    const data = this.data.historical[op].map(record => ({
                        x: new Date(record.timestamp),
                        y: record.rc_needed / 1e6 // Convert to millions for readability
                    }));

                    datasets.push({
                        label: this.formatOperationName(op),
                        data: data.reverse(), // Reverse to show chronological order
                        borderColor: colors[index],
                        backgroundColor: colors[index] + '20',
                        tension: 0.1,
                        fill: false
                    });
                }
            });

            this.chart = new Chart(ctx, {
                type: 'line',
                data: { datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            type: 'time',
                            time: {
                                unit: 'day'
                            },
                            title: {
                                display: true,
                                text: 'Date'
                            }
                        },
                        y: {
                            title: {
                                display: true,
                                text: 'RC Cost (Millions)'
                            },
                            beginAtZero: true
                        }
                    },
                    plugins: {
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    return context.dataset.label + ': ' + (context.parsed.y * 1e6).toLocaleString() + ' RC';
                                }
                            }
                        }
                    }
                }
            });
        },

        formatRC(rc) {
            if (!rc) return '0';
            if (rc >= 1e9) return (rc / 1e9).toFixed(2) + 'B';
            if (rc >= 1e6) return (rc / 1e6).toFixed(2) + 'M';
            if (rc >= 1e3) return (rc / 1e3).toFixed(2) + 'K';
            return rc.toLocaleString();
        },

        formatOperationName(operation) {
            return operation
                .replace(/_/g, ' ')
                .replace(/operation$/, '')
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
        },

        formatDate(dateString) {
            if (!dateString) return 'N/A';
            return new Date(dateString).toLocaleString();
        },

        isKeyOperation(operation) {
            const keyOps = ['claim_account_operation', 'create_claimed_account_operation', 'account_create_operation'];
            return keyOps.includes(operation);
        },

        getRelativeCost(rcCost) {
            if (!rcCost) return 0;
            const maxCost = Math.max(...Object.values(this.data.currentCosts).map(c => c.rc_needed || 0));
            return maxCost > 0 ? Math.round((rcCost / maxCost) * 100) : 0;
        },

        getProgressBarClass(rcCost) {
            const relativeCost = this.getRelativeCost(rcCost);
            if (relativeCost >= 80) return 'bg-danger';
            if (relativeCost >= 60) return 'bg-warning';
            if (relativeCost >= 40) return 'bg-info';
            return 'bg-success';
        },

        getTrendClass(direction) {
            switch (direction) {
                case 'up': return 'text-danger';
                case 'down': return 'text-success';
                default: return 'text-muted';
            }
        },

        getTrendIcon(direction) {
            switch (direction) {
                case 'up': return 'bi-arrow-up';
                case 'down': return 'bi-arrow-down';
                default: return 'bi-dash';
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