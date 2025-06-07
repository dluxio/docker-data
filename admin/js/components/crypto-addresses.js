// Crypto Addresses Management Component
const CryptoAddressesView = {
    name: 'CryptoAddresses',
    
    data() {
        return {
            addresses: [],
            statistics: [],
            loading: false,
            error: null,
            success: null,
            pagination: {
                limit: 50,
                offset: 0,
                total: 0
            },
            filters: {
                cryptoType: ''
            },
            consolidation: {
                loading: false,
                selectedCrypto: '',
                destinationAddress: '',
                priority: 'medium',
                info: null,
                preparationData: null,
                executed: false,
                executionResult: null
            },
            supportedCryptos: ['BTC', 'ETH', 'SOL', 'MATIC', 'BNB']
        };
    },

    template: `
        <div class="crypto-addresses-view">
            <div class="header-section">
                <h2><i class="fas fa-wallet"></i> Crypto Address Management</h2>
                <p class="text-muted">Manage generated addresses and consolidate funds</p>
            </div>

            <!-- Statistics Cards -->
            <div class="row mb-4">
                <div class="col-12">
                    <div class="card">
                        <div class="card-header">
                            <h5><i class="fas fa-chart-bar"></i> Address Statistics</h5>
                            <button class="btn btn-sm btn-outline-primary" @click="loadStatistics">
                                <i class="fas fa-sync"></i> Refresh
                            </button>
                        </div>
                        <div class="card-body">
                            <div v-if="statistics.length === 0" class="text-center text-muted">
                                <i class="fas fa-info-circle"></i> No statistics available
                            </div>
                            <div v-else class="row">
                                <div v-for="stat in statistics" :key="stat.crypto_type" class="col-md-3 mb-3">
                                    <div class="card border-primary">
                                        <div class="card-body text-center">
                                            <h5 class="card-title">{{ stat.crypto_type }}</h5>
                                            <div class="row">
                                                <div class="col-6">
                                                    <div class="text-primary">
                                                        <strong>{{ stat.total_addresses }}</strong>
                                                        <br><small>Total</small>
                                                    </div>
                                                </div>
                                                <div class="col-6">
                                                    <div class="text-success">
                                                        <strong>{{ stat.reusable_addresses }}</strong>
                                                        <br><small>Reusable</small>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="row mt-2">
                                                <div class="col-4">
                                                    <div class="text-info">
                                                        <strong>{{ stat.pending_channels }}</strong>
                                                        <br><small>Pending</small>
                                                    </div>
                                                </div>
                                                <div class="col-4">
                                                    <div class="text-success">
                                                        <strong>{{ stat.completed_channels }}</strong>
                                                        <br><small>Complete</small>
                                                    </div>
                                                </div>
                                                <div class="col-4">
                                                    <div class="text-warning">
                                                        <strong>{{ stat.expired_channels }}</strong>
                                                        <br><small>Expired</small>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Fund Consolidation Section -->
            <div class="row mb-4">
                <div class="col-12">
                    <div class="card">
                        <div class="card-header">
                            <h5><i class="fas fa-compress-alt"></i> Fund Consolidation</h5>
                        </div>
                        <div class="card-body">
                            <div class="row">
                                <div class="col-md-6">
                                    <div class="form-group">
                                        <label>Cryptocurrency</label>
                                        <select v-model="consolidation.selectedCrypto" class="form-control">
                                            <option value="">Select crypto...</option>
                                            <option v-for="crypto in supportedCryptos" :key="crypto" :value="crypto">
                                                {{ crypto }}
                                            </option>
                                        </select>
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="form-group">
                                        <label>Priority</label>
                                        <select v-model="consolidation.priority" class="form-control">
                                            <option value="low">Low</option>
                                            <option value="medium">Medium</option>
                                            <option value="high">High</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            
                            <div class="form-group">
                                <label>Destination Address</label>
                                <input 
                                    v-model="consolidation.destinationAddress" 
                                    type="text" 
                                    class="form-control" 
                                    placeholder="Enter destination address..."
                                >
                            </div>

                            <div class="btn-group">
                                <button 
                                    @click="getConsolidationInfo" 
                                    :disabled="!consolidation.selectedCrypto || consolidation.loading"
                                    class="btn btn-info"
                                >
                                    <i class="fas fa-info-circle"></i> Get Info
                                </button>
                                <button 
                                    @click="prepareConsolidation" 
                                    :disabled="!consolidation.selectedCrypto || !consolidation.destinationAddress || consolidation.loading || !consolidation.info || consolidation.info.addressCount === 0"
                                    class="btn btn-warning"
                                >
                                    <i class="fas fa-cogs"></i> Prepare Consolidation
                                </button>
                                <button 
                                    @click="resetConsolidation" 
                                    :disabled="consolidation.loading"
                                    class="btn btn-secondary"
                                >
                                    <i class="fas fa-redo"></i> Reset
                                </button>
                            </div>

                            <!-- Consolidation Info Display -->
                            <div v-if="consolidation.info && consolidation.info.addressCount > 0" class="mt-3 p-3 border rounded">
                                <h6>Consolidation Information for {{ consolidation.info.cryptoType }}</h6>
                                <div class="row">
                                    <div class="col-md-4">
                                        <strong>Addresses:</strong> {{ consolidation.info.addressCount }}<br>
                                        <strong>Total Balance:</strong> {{ consolidation.info.totalBalance && consolidation.info.totalBalance.toFixed(8) }} {{ consolidation.info.cryptoType }}<br>
                                        <strong>USD Value:</strong> &#36;{{ consolidation.info.totalBalanceUSD.toFixed(2) }}
                                    </div>
                                    <div class="col-md-4">
                                        <strong>Est. Fee ({{ consolidation.priority }}):</strong><br>
                                        {{ consolidation.info.feeEstimate[consolidation.priority].fee.toFixed(8) }} {{ consolidation.info.cryptoType }}<br>
                                        <span class="text-muted">(&#36;{{ consolidation.info.feeEstimate[consolidation.priority].feeUSD.toFixed(2) }})</span>
                                    </div>
                                    <div class="col-md-4">
                                        <strong>Net Amount:</strong><br>
                                        {{ consolidation.info.netAmount[consolidation.priority].toFixed(8) }} {{ consolidation.info.cryptoType }}<br>
                                        <span class="text-muted">After fees</span>
                                    </div>
                                </div>
                                
                                <div class="mt-2">
                                    <strong>Addresses with funds:</strong>
                                    <div class="max-height-200 overflow-auto">
                                        <div v-for="addr in consolidation.info.addresses.slice(0, 10)" :key="addr.address" class="small d-flex justify-content-between">
                                            <span>{{ addr.address.substring(0, 20) }}...</span>
                                            <span>{{ addr.balance.toFixed(8) }} {{ consolidation.info.cryptoType }}</span>
                                        </div>
                                        <div v-if="consolidation.info.addresses.length > 10" class="small text-muted">
                                            ... and {{ consolidation.info.addresses.length - 10 }} more addresses
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="alert alert-info mt-2">
                                    <i class="fas fa-info-circle"></i>
                                    {{ consolidation.info.instructions.note }}
                                </div>
                            </div>

                            <!-- No funds message -->
                            <div v-if="consolidation.info && consolidation.info.addressCount === 0" class="mt-3 p-3 border rounded bg-light">
                                <div class="text-center text-muted">
                                    <i class="fas fa-info-circle"></i>
                                    {{ consolidation.info.message }}
                                </div>
                            </div>

                            <!-- Preparation Summary -->
                            <div v-if="consolidation.preparationData && !consolidation.executed" class="mt-3 p-3 border rounded bg-warning">
                                <h6><i class="fas fa-exclamation-triangle"></i> Consolidation Ready for Execution</h6>
                                <div class="row">
                                    <div class="col-md-6">
                                        <strong>Transaction ID:</strong> {{ consolidation.preparationData.txId }}<br>
                                        <strong>Addresses:</strong> {{ consolidation.preparationData.addressCount }}<br>
                                        <strong>Total Amount:</strong> {{ consolidation.preparationData.totalBalance.toFixed(8) }} {{ consolidation.preparationData.cryptoType }}
                                    </div>
                                    <div class="col-md-6">
                                        <strong>Estimated Fee:</strong> {{ consolidation.preparationData.estimatedFee.toFixed(8) }} {{ consolidation.preparationData.cryptoType }}<br>
                                        <strong>Fee USD:</strong> &#36;{{ consolidation.preparationData.estimatedFeeUSD.toFixed(2) }}<br>
                                        <strong>Net Amount:</strong> {{ consolidation.preparationData.netAmount.toFixed(8) }} {{ consolidation.preparationData.cryptoType }}
                                    </div>
                                </div>
                                <div class="mt-3">
                                    <strong>Destination:</strong> {{ consolidation.preparationData.destinationAddress }}
                                </div>
                                <div class="mt-3">
                                    <button 
                                        @click="executeConsolidation" 
                                        :disabled="consolidation.loading"
                                        class="btn btn-danger btn-lg"
                                    >
                                        <i class="fas fa-paper-plane"></i> Confirm & Execute Consolidation
                                    </button>
                                    <small class="form-text text-muted">This action cannot be undone!</small>
                                </div>
                            </div>

                            <!-- Execution Result -->
                            <div v-if="consolidation.executed && consolidation.executionResult" class="mt-3 p-3 border rounded bg-success text-white">
                                <h6><i class="fas fa-check-circle"></i> Consolidation Completed</h6>
                                <div class="row">
                                    <div class="col-md-6">
                                        <strong>Transaction Hash:</strong><br>
                                        <code class="text-white">{{ consolidation.executionResult.blockchainTxHash }}</code>
                                    </div>
                                    <div class="col-md-6">
                                        <strong>Consolidated:</strong> {{ consolidation.executionResult.totalAmount.toFixed(8) }} {{ consolidation.executionResult.cryptoType }}<br>
                                        <strong>Addresses:</strong> {{ consolidation.executionResult.addressesConsolidated }}<br>
                                        <strong>Completed:</strong> {{ new Date(consolidation.executionResult.completedAt).toLocaleString() }}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Address List -->
            <div class="row">
                <div class="col-12">
                    <div class="card">
                        <div class="card-header d-flex justify-content-between align-items-center">
                            <h5><i class="fas fa-list"></i> Generated Addresses</h5>
                            <div class="d-flex align-items-center">
                                <select v-model="filters.cryptoType" @change="loadAddresses" class="form-select me-2" style="width: auto;">
                                    <option value="">All Cryptocurrencies</option>
                                    <option v-for="crypto in supportedCryptos" :key="crypto" :value="crypto">
                                        {{ crypto }}
                                    </option>
                                </select>
                                <button class="btn btn-outline-primary" @click="loadAddresses">
                                    <i class="fas fa-sync"></i> Refresh
                                </button>
                            </div>
                        </div>
                        <div class="card-body">
                            <div v-if="loading" class="text-center">
                                <i class="fas fa-spinner fa-spin"></i> Loading...
                            </div>
                            
                            <div v-else-if="addresses.length === 0" class="text-center text-muted">
                                <i class="fas fa-info-circle"></i> No addresses found
                            </div>
                            
                            <div v-else>
                                <div class="table-responsive">
                                    <table class="table table-striped">
                                        <thead>
                                            <tr>
                                                <th>Crypto</th>
                                                <th>Address</th>
                                                <th>Channel ID</th>
                                                <th>Status</th>
                                                <th>Amount</th>
                                                <th>Created</th>
                                                <th>Reusable After</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr v-for="address in addresses" :key="address.address">
                                                <td>
                                                    <span class="badge bg-primary text-white">{{ address.crypto_type }}</span>
                                                </td>
                                                <td>
                                                    <code class="small">{{ address.address }}</code>
                                                    <button 
                                                        class="btn btn-sm btn-outline-secondary ms-1" 
                                                        @click="copyToClipboard(address.address)"
                                                        title="Copy address"
                                                    >
                                                        <i class="fas fa-copy"></i>
                                                    </button>
                                                </td>
                                                <td>
                                                    <code class="small">{{ address.channel_id }}</code>
                                                </td>
                                                <td>
                                                    <span 
                                                        :class="getStatusBadgeClass(address.channel_status)"
                                                        class="badge"
                                                    >
                                                        {{ address.channel_status || 'No Channel' }}
                                                    </span>
                                                </td>
                                                <td>
                                                    <div v-if="address.amount_crypto">
                                                        {{ address.amount_crypto }} {{ address.crypto_type }}<br>
                                                        <small class="text-muted">&#36;{{ address.amount_usd }}</small>
                                                    </div>
                                                    <span v-else class="text-muted">-</span>
                                                </td>
                                                <td>
                                                    <small>{{ formatDate(address.created_at) }}</small>
                                                </td>
                                                <td>
                                                    <small v-if="address.reusable_after">
                                                        {{ formatDate(address.reusable_after) }}
                                                        <span 
                                                            v-if="new Date(address.reusable_after) <= new Date()"
                                                            class="badge bg-success text-white ms-1"
                                                        >
                                                            Reusable
                                                        </span>
                                                    </small>
                                                    <span v-else class="text-muted">-</span>
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>

                                <!-- Pagination -->
                                <div class="d-flex justify-content-between align-items-center mt-3">
                                    <div>
                                        Showing {{ pagination.offset + 1 }} - {{ Math.min(pagination.offset + pagination.limit, pagination.total) }} 
                                        of {{ pagination.total }} addresses
                                    </div>
                                    <div>
                                        <button 
                                            class="btn btn-sm btn-outline-secondary me-2" 
                                            @click="previousPage"
                                            :disabled="pagination.offset === 0"
                                        >
                                            <i class="fas fa-chevron-left"></i> Previous
                                        </button>
                                        <button 
                                            class="btn btn-sm btn-outline-secondary" 
                                            @click="nextPage"
                                            :disabled="pagination.offset + pagination.limit >= pagination.total"
                                        >
                                            Next <i class="fas fa-chevron-right"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Alert Messages -->
            <div v-if="error" class="alert alert-danger alert-dismissible fade show" role="alert">
                <i class="fas fa-exclamation-circle"></i> {{ error }}
                <button type="button" class="close" @click="error = null">
                    <span>&times;</span>
                </button>
            </div>

            <div v-if="success" class="alert alert-success alert-dismissible fade show" role="alert">
                <i class="fas fa-check-circle"></i> {{ success }}
                <button type="button" class="close" @click="success = null">
                    <span>&times;</span>
                </button>
            </div>
        </div>
    `,

    async mounted() {
        await this.loadStatistics();
        await this.loadAddresses();
    },

    methods: {
        async loadStatistics() {
            try {
                const response = await fetch('/api/onboarding/admin/address-stats', {
                    headers: this.getAuthHeaders()
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                this.statistics = data.statistics || [];
            } catch (error) {
                this.error = `Failed to load statistics: ${error.message}`;
                console.error('Error loading statistics:', error);
            }
        },

        async loadAddresses() {
            this.loading = true;
            try {
                const params = new URLSearchParams({
                    limit: this.pagination.limit,
                    offset: this.pagination.offset
                });
                
                if (this.filters.cryptoType) {
                    params.append('cryptoType', this.filters.cryptoType);
                }
                
                const response = await fetch(`/api/onboarding/admin/crypto-addresses?${params}`, {
                    headers: this.getAuthHeaders()
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                this.addresses = data.addresses || [];
                this.pagination.total = data.pagination?.total || this.addresses.length;
            } catch (error) {
                this.error = `Failed to load addresses: ${error.message}`;
                console.error('Error loading addresses:', error);
            } finally {
                this.loading = false;
            }
        },

        async getConsolidationInfo() {
            if (!this.consolidation.selectedCrypto) return;
            
            this.consolidation.loading = true;
            this.consolidation.preparationData = null;
            this.consolidation.executed = false;
            try {
                const response = await fetch(`/api/onboarding/admin/consolidation-info/${this.consolidation.selectedCrypto}`, {
                    headers: this.getAuthHeaders()
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                this.consolidation.info = data;
                
                if (data.addressCount === 0) {
                    this.success = `No addresses with funds found for ${data.cryptoType}`;
                } else {
                    this.success = `Found ${data.addressCount} addresses with ${data.totalBalance.toFixed(8)} ${data.cryptoType} (${data.totalBalanceUSD.toFixed(2)} USD) available for consolidation`;
                }
            } catch (error) {
                this.error = `Failed to get consolidation info: ${error.message}`;
                console.error('Error getting consolidation info:', error);
            } finally {
                this.consolidation.loading = false;
            }
        },

        async prepareConsolidation() {
            if (!this.consolidation.selectedCrypto || !this.consolidation.destinationAddress) return;
            
            this.consolidation.loading = true;
            try {
                const response = await fetch('/api/onboarding/admin/prepare-consolidation', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.getAuthHeaders()
                    },
                    body: JSON.stringify({
                        cryptoType: this.consolidation.selectedCrypto,
                        destinationAddress: this.consolidation.destinationAddress,
                        priority: this.consolidation.priority
                    })
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                this.consolidation.preparationData = data.consolidationSummary;
                this.success = 'Consolidation prepared. Review details and confirm to execute.';
            } catch (error) {
                this.error = `Failed to prepare consolidation: ${error.message}`;
                console.error('Error preparing consolidation:', error);
            } finally {
                this.consolidation.loading = false;
            }
        },

        async executeConsolidation() {
            if (!this.consolidation.preparationData) return;
            
            this.consolidation.loading = true;
            try {
                const response = await fetch('/api/onboarding/admin/execute-consolidation', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.getAuthHeaders()
                    },
                    body: JSON.stringify({
                        txId: this.consolidation.preparationData.txId,
                        cryptoType: this.consolidation.preparationData.cryptoType,
                        destinationAddress: this.consolidation.preparationData.destinationAddress,
                        priority: this.consolidation.preparationData.priority
                    })
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                this.consolidation.executed = true;
                this.consolidation.executionResult = data.result;
                this.success = `Consolidation completed! Transaction hash: ${data.result.blockchainTxHash}`;
                
                // Reload addresses to reflect changes
                this.loadAddresses();
                this.loadStatistics();
            } catch (error) {
                this.error = `Failed to execute consolidation: ${error.message}`;
                console.error('Error executing consolidation:', error);
            } finally {
                this.consolidation.loading = false;
            }
        },

        resetConsolidation() {
            this.consolidation.preparationData = null;
            this.consolidation.executed = false;
            this.consolidation.executionResult = null;
            this.consolidation.destinationAddress = '';
        },

        getStatusBadgeClass(status) {
            switch (status) {
                case 'completed': return 'bg-success text-white';
                case 'pending': return 'bg-warning text-dark';
                case 'expired': return 'bg-danger text-white';
                case 'cancelled': return 'bg-secondary text-white';
                default: return 'bg-light text-dark';
            }
        },

        formatDate(dateString) {
            if (!dateString) return '-';
            return new Date(dateString).toLocaleString();
        },

        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.success = 'Address copied to clipboard';
            } catch (error) {
                console.error('Failed to copy:', error);
                this.error = 'Failed to copy address';
            }
        },

        nextPage() {
            this.pagination.offset += this.pagination.limit;
            this.loadAddresses();
        },

        previousPage() {
            this.pagination.offset = Math.max(0, this.pagination.offset - this.pagination.limit);
            this.loadAddresses();
        },

        getAuthHeaders() {
            // Use the same auth method as other components
            const savedAuth = localStorage.getItem('dlux_admin_auth');
            if (savedAuth) {
                try {
                    const authData = JSON.parse(savedAuth);
                    return {
                        'Content-Type': 'application/json',
                        'x-account': authData.account,
                        'x-challenge': authData.challenge,
                        'x-pubkey': authData.pubKey,
                        'x-signature': authData.signature
                    };
                } catch (error) {
                    console.error('Failed to parse auth data:', error);
                    return {};
                }
            }
            return {};
        }
    }
};

// Register component
if (!window.DLUX_COMPONENTS) {
    window.DLUX_COMPONENTS = {};
}
window.DLUX_COMPONENTS['crypto-addresses-view'] = CryptoAddressesView;

// CSS Styles
const style = document.createElement('style');
style.textContent = `
    .crypto-addresses-view .max-height-200 {
        max-height: 200px;
    }
    .crypto-addresses-view .table th {
        border-top: none;
        font-weight: 600;
        background-color: #f8f9fa;
    }
    .crypto-addresses-view .badge {
        font-size: 0.75em;
    }
    .crypto-addresses-view code {
        background-color: #f8f9fa;
        padding: 2px 4px;
        border-radius: 3px;
        font-size: 0.85em;
    }
    .crypto-addresses-view .card-title {
        margin-bottom: 0.5rem;
        font-size: 1rem;
        font-weight: 600;
    }
`;
document.head.appendChild(style); 