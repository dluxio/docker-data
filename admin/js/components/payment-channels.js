// Payment Channels Component
window.DLUX_COMPONENTS['payment-channels-view'] = {
    props: ['apiClient', 'adminAccountInfo'],
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
                                    <th>Public Keys</th>
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
                                        <div v-if="hasPublicKeys(channel)" class="text-center">
                                            <button class="btn btn-sm btn-outline-primary" 
                                                    @click="viewPublicKeys(channel)"
                                                    title="View Public Keys">
                                                <i class="bi bi-key"></i>
                                            </button>
                                        </div>
                                        <span v-else class="text-muted">-</span>
                                    </td>
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
                                            <button v-if="canManuallyCreateAccount(channel)" 
                                                    class="btn btn-outline-success"
                                                    @click="showManualCreateModal(channel)"
                                                    title="Manually Create Account">
                                                <i class="bi bi-person-plus"></i>
                                            </button>
                                            <button v-if="canBuildAccount(channel)" 
                                                    class="btn btn-outline-warning"
                                                    @click="showBuildAccountModal(channel)"
                                                    title="Build Account with Admin Keychain">
                                                <i class="bi bi-hammer"></i>
                                            </button>
                                            <button v-if="canBuildWithACT(channel)" 
                                                    class="btn btn-outline-primary"
                                                    @click="showBuildAccountWithACTModal(channel)"
                                                    title="Build Account with ACT">
                                                <i class="bi bi-wallet2"></i>
                                            </button>
                                            <button v-if="canCancelChannel(channel)" 
                                                    class="btn btn-outline-danger"
                                                                                        @click="showCancelModal(channel)"
                                    title="Delete Channel">
                                                <i class="bi bi-trash"></i>
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
                                                <td>{{ selectedChannel.cryptoType || selectedChannel.crypto_type || 'N/A' }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Amount:</strong></td>
                                                <td>{{ getAmountDisplay(selectedChannel) }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>USD Value:</strong></td>
                                                <td>{{ getUsdDisplay(selectedChannel) }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Payment Address:</strong></td>
                                                <td><code>{{ selectedChannel.payment_address || selectedChannel.address || 'N/A' }}</code></td>
                                            </tr>
                                            <tr>
                                                <td><strong>Memo:</strong></td>
                                                <td><code>{{ selectedChannel.memo || 'N/A' }}</code></td>
                                            </tr>
                                            <tr v-if="selectedChannel.tx_hash">
                                                <td><strong>Transaction:</strong></td>
                                                <td><code>{{ selectedChannel.tx_hash }}</code></td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            
                            <!-- Public Keys Section -->
                            <div v-if="hasPublicKeys(selectedChannel)" class="mt-4">
                                <h6>Public Keys</h6>
                                <div class="alert alert-info">
                                    <i class="bi bi-key"></i>
                                    Public keys provided for account creation
                                </div>
                                <div v-for="(key, keyType) in getPublicKeysObject(selectedChannel)" :key="keyType" class="mb-2">
                                    <label class="form-label">
                                        <strong>{{ keyType.charAt(0).toUpperCase() + keyType.slice(1) }}:</strong>
                                    </label>
                                    <div class="input-group input-group-sm">
                                        <input type="text" class="form-control font-monospace small" :value="key" readonly>
                                        <button class="btn btn-outline-secondary btn-sm" 
                                                @click="copyToClipboard(key)"
                                                title="Copy Key">
                                            <i class="bi bi-clipboard"></i>
                                        </button>
                                    </div>
                                </div>
                                
                                <!-- Manual Creation Button -->
                                <div v-if="canManuallyCreateAccount(selectedChannel)" class="mt-3">
                                    <button class="btn btn-warning" @click="showManualCreateModal(selectedChannel)">
                                        <i class="bi bi-person-plus"></i>
                                        Manually Create Account
                                    </button>
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

            <!-- Public Keys Modal -->
            <div class="modal fade" id="publicKeysModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Public Keys for @{{ selectedChannel?.username }}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedChannel">
                            <div class="alert alert-info">
                                <i class="bi bi-info-circle"></i>
                                These are the public keys provided during the payment process for account creation.
                            </div>
                            
                            <div v-if="getPublicKeysObject(selectedChannel)">
                                <div v-for="(key, keyType) in getPublicKeysObject(selectedChannel)" :key="keyType" class="mb-3">
                                    <label class="form-label">
                                        <strong>{{ keyType.charAt(0).toUpperCase() + keyType.slice(1) }} Key:</strong>
                                    </label>
                                    <div class="input-group">
                                        <input type="text" class="form-control font-monospace" :value="key" readonly>
                                        <button class="btn btn-outline-secondary" 
                                                @click="copyToClipboard(key)"
                                                title="Copy Key">
                                            <i class="bi bi-clipboard"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            
                            <div v-else class="text-muted">
                                No public keys available for this channel.
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Manual Account Creation Modal -->
            <div class="modal fade" id="manualCreateModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Manual Account Creation</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedChannel">
                            <div class="alert alert-warning">
                                <i class="bi bi-exclamation-triangle"></i>
                                <strong>Manual Override:</strong> This will attempt to create the HIVE account using your logged-in Keychain account.
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Target Username:</strong></label>
                                <input type="text" class="form-control" v-model="manualCreate.username" readonly>
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Channel ID:</strong></label>
                                <input type="text" class="form-control font-monospace" v-model="manualCreate.channelId" readonly>
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Public Keys Available:</strong></label>
                                <div v-if="getPublicKeysObject(selectedChannel)">
                                    <div v-for="(key, keyType) in getPublicKeysObject(selectedChannel)" :key="keyType" class="mb-2">
                                        <small class="text-muted">{{ keyType }}:</small>
                                        <div class="font-monospace small text-break">{{ key }}</div>
                                    </div>
                                </div>
                                <div v-else class="text-muted">No keys available</div>
                            </div>

                            <div class="form-check mb-3">
                                <input class="form-check-input" type="checkbox" v-model="manualCreate.useACT" id="useACTCheck">
                                <label class="form-check-label" for="useACTCheck">
                                    Use Account Creation Token (if available)
                                </label>
                            </div>

                            <div class="alert alert-info">
                                <strong>Note:</strong> This will use your current admin account credentials to sign the account creation transaction.
                                Make sure you have sufficient RC or ACT tokens.
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" 
                                    class="btn btn-success" 
                                    @click="executeManualAccountCreation"
                                    :disabled="creatingAccount || !selectedChannel">
                                <span v-if="creatingAccount">
                                    <i class="bi bi-hourglass-split"></i>
                                    Creating Account...
                                </span>
                                <span v-else>
                                    <i class="bi bi-person-plus"></i>
                                    Create Account
                                </span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Cancel Channel Modal -->
            <div class="modal fade" id="cancelChannelModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Delete Payment Channel</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedChannel">
                            <div class="alert alert-warning">
                                <i class="bi bi-exclamation-triangle"></i>
                                <strong>Warning:</strong> This will permanently delete the payment channel record.
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Channel ID:</strong></label>
                                <input type="text" class="form-control font-monospace" :value="selectedChannel.channel_id || selectedChannel.channelId" readonly>
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Username:</strong></label>
                                <input type="text" class="form-control" :value="selectedChannel.username" readonly>
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Status:</strong></label>
                                <span class="badge" :class="getStatusClass(selectedChannel.status)">
                                    {{ selectedChannel.status }}
                                </span>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" 
                                    class="btn btn-danger" 
                                    @click="executeCancelChannel"
                                    :disabled="canceling">
                                <span v-if="canceling">
                                    <i class="bi bi-hourglass-split"></i>
                                    Canceling...
                                </span>
                                <span v-else>
                                    <i class="bi bi-trash"></i>
                                    Delete Channel
                                </span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Build Account Modal -->
            <div class="modal fade" id="buildAccountModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Build Account with Admin Keychain</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedChannel">
                            <div class="alert alert-info">
                                <i class="bi bi-info-circle"></i>
                                This will use your admin keychain to create the HIVE account using 3 HIVE delegation.
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Target Username:</strong></label>
                                <input type="text" class="form-control" :value="selectedChannel.username" readonly>
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Creation Method:</strong></label>
                                <span class="badge bg-warning">HIVE Delegation (3 HIVE)</span>
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Public Keys Available:</strong></label>
                                <div v-if="getPublicKeysObject(selectedChannel)">
                                    <div v-for="(key, keyType) in getPublicKeysObject(selectedChannel)" :key="keyType" class="mb-2">
                                        <small class="text-muted">{{ keyType }}:</small>
                                        <div class="font-monospace small text-break">{{ key }}</div>
                                    </div>
                                </div>
                                <div v-else class="text-muted">No keys available</div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" 
                                    class="btn btn-warning" 
                                    @click="executeBuildAccount"
                                    :disabled="buildingAccount">
                                <span v-if="buildingAccount">
                                    <i class="bi bi-hourglass-split"></i>
                                    Building Account...
                                </span>
                                <span v-else>
                                    <i class="bi bi-hammer"></i>
                                    Build Account
                                </span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Build Account with ACT Modal -->
            <div class="modal fade" id="buildAccountACTModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Build Account with ACT</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedChannel">
                            <div class="alert alert-primary">
                                <i class="bi bi-wallet2"></i>
                                This will use your admin keychain to create the HIVE account using an Account Creation Token (ACT).
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Target Username:</strong></label>
                                <input type="text" class="form-control" :value="selectedChannel.username" readonly>
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Creation Method:</strong></label>
                                <span class="badge bg-primary">Account Creation Token (ACT)</span>
                            </div>

                            <div class="mb-3" v-if="adminAccountInfo">
                                <label class="form-label"><strong>Your ACT Balance:</strong></label>
                                <div>
                                    <span class="badge bg-info">{{ adminAccountInfo.actBalance || 0 }} ACT Available</span>
                                    <span v-if="(adminAccountInfo.actBalance || 0) === 0" class="text-warning ms-2">
                                        <i class="bi bi-exclamation-triangle"></i>
                                        Will fallback to HIVE delegation
                                    </span>
                                </div>
                            </div>

                            <div class="mb-3">
                                <label class="form-label"><strong>Public Keys Available:</strong></label>
                                <div v-if="getPublicKeysObject(selectedChannel)">
                                    <div v-for="(key, keyType) in getPublicKeysObject(selectedChannel)" :key="keyType" class="mb-2">
                                        <small class="text-muted">{{ keyType }}:</small>
                                        <div class="font-monospace small text-break">{{ key }}</div>
                                    </div>
                                </div>
                                <div v-else class="text-muted">No keys available</div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" 
                                    class="btn btn-primary" 
                                    @click="executeBuildAccountWithACT"
                                    :disabled="buildingAccountACT">
                                <span v-if="buildingAccountACT">
                                    <i class="bi bi-hourglass-split"></i>
                                    Building Account...
                                </span>
                                <span v-else>
                                    <i class="bi bi-wallet2"></i>
                                    Build with ACT
                                </span>
                            </button>
                        </div>
                    </div>
                </div>
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
            },
            creatingAccount: false,
            manualCreate: {
                username: '',
                channelId: '',
                useACT: true
            },
            canceling: false,
            buildingAccount: false,
            buildingAccountACT: false
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
                    params.append('crypto_type', this.filters.cryptoType);
                }
                
                const result = await this.apiClient.get(`/api/onboarding/admin/channels?${params}`);
                
                if (result.success) {
                    this.data = {
                        channels: result.channels || [],
                        summary: result.summary || {},
                        totalCount: result.pagination?.total || 0
                    };
                    
                    setTimeout(() => this.createCharts(), 100);
                } else {
                    throw new Error(result.error || 'Failed to load payment channels');
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
            this.alert = {
                message: message,
                type: type,
                icon: icon
            };
            
            // Auto-clear after 5 seconds
            setTimeout(() => {
                this.clearAlert();
            }, 5000);
        },
        
        clearAlert() {
            this.alert = {
                message: '',
                type: 'info',
                icon: ''
            };
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
        },

        // Public Keys related methods
        hasPublicKeys(channel) {
            const publicKeysData = channel.publicKeys || channel.public_keys;
            const result = publicKeysData && Object.keys(this.getPublicKeysObject(channel) || {}).length > 0;

            return result;
        },

        getPublicKeysObject(channel) {
            const publicKeysData = channel.publicKeys || channel.public_keys;
            if (!publicKeysData) return null;
            
            try {
                // Handle both string and object formats
                if (typeof publicKeysData === 'string') {
                    return JSON.parse(publicKeysData);
                }
                return publicKeysData;
            } catch (error) {
                console.error('Error parsing public keys:', error);
                return null;
            }
        },

        viewPublicKeys(channel) {
            this.selectedChannel = channel;
            const modal = new bootstrap.Modal(document.getElementById('publicKeysModal'));
            modal.show();
        },

        // Manual account creation methods
        canManuallyCreateAccount(channel) {
            // Show manual creation option for confirmed channels with public keys that haven't been completed
            return ['confirmed', 'failed'].includes(channel.status) && this.hasPublicKeys(channel);
        },

        showManualCreateModal(channel) {
            this.selectedChannel = channel;
            this.manualCreate = {
                username: channel.username,
                channelId: channel.channelId || channel.channel_id,
                useACT: true
            };
            const modal = new bootstrap.Modal(document.getElementById('manualCreateModal'));
            modal.show();
        },

        async executeManualAccountCreation() {
            if (!this.selectedChannel) return;

            this.creatingAccount = true;
            
            try {
                const publicKeys = this.getPublicKeysObject(this.selectedChannel);
                if (!publicKeys) {
                    throw new Error('No public keys available for account creation');
                }

                // Call the manual account creation API
                const response = await this.apiClient.post('/api/onboarding/admin/manual-create-account', {
                    channelId: this.manualCreate.channelId,
                    username: this.manualCreate.username,
                    publicKeys: publicKeys,
                    useACT: this.manualCreate.useACT
                });

                if (response.success) {
                    this.showAlert(`Account @${this.manualCreate.username} created successfully!`, 'success', 'check-circle');
                    
                    // Close modal and refresh data
                    bootstrap.Modal.getInstance(document.getElementById('manualCreateModal')).hide();
                    await this.refreshData();
                } else {
                    throw new Error(response.error || 'Account creation failed');
                }

            } catch (error) {
                console.error('Manual account creation failed:', error);
                this.showAlert('Failed to create account: ' + error.message, 'danger', 'exclamation-triangle');
            } finally {
                this.creatingAccount = false;
            }
        },

        // New methods for the three new actions
        canBuildAccount(channel) {
            // Allow building accounts for confirmed channels with public keys that haven't been completed

            return ['confirmed', 'failed', 'pending'].includes(channel.status) && this.hasPublicKeys(channel);
        },

        async showBuildAccountModal(channel) {
            this.selectedChannel = channel;
            const modal = new bootstrap.Modal(document.getElementById('buildAccountModal'));
            modal.show();
        },

        async executeBuildAccount() {
            if (!this.selectedChannel) return;

            this.buildingAccount = true;
            
            try {
                const channelId = this.selectedChannel.channelId || this.selectedChannel.channel_id;
                
                // Get the operation from the backend
                const response = await this.apiClient.post('/api/onboarding/admin/build-account', {
                    channelId: channelId,
                    useACT: false // Force HIVE delegation for this method
                });

                if (response.success) {
                    // Use the keychainTransaction method from the parent app
                    const result = await this.$parent.keychainTransaction([response.operation], 'active');
                    
                    if (result.success) {
                        // Complete the account creation
                        const completeResponse = await this.apiClient.post('/api/onboarding/admin/complete-account-creation', {
                            channelId: channelId,
                            txId: result.result.tx_id,
                            username: response.username,
                            creationMethod: response.creationMethod
                        });

                        if (completeResponse.success) {
                            this.showAlert(`Account @${response.username} created successfully with HIVE delegation!`, 'success', 'check-circle');
                            
                            // Close modal and refresh data
                            bootstrap.Modal.getInstance(document.getElementById('buildAccountModal')).hide();
                            await this.refreshData();
                        } else {
                            throw new Error(completeResponse.error || 'Failed to complete account creation');
                        }
                    } else {
                        throw new Error(result.message || 'Keychain transaction failed');
                    }
                } else {
                    throw new Error(response.error || 'Failed to prepare account creation');
                }

            } catch (error) {
                console.error('Account creation failed:', error);
                this.showAlert('Failed to create account: ' + error.message, 'danger', 'exclamation-triangle');
            } finally {
                this.buildingAccount = false;
            }
        },

        canBuildWithACT(channel) {
            // Same as canBuildAccount - we'll determine ACT availability in the modal

            return ['confirmed', 'failed', 'pending'].includes(channel.status) && this.hasPublicKeys(channel);
        },

        async showBuildAccountWithACTModal(channel) {
            this.selectedChannel = channel;
            const modal = new bootstrap.Modal(document.getElementById('buildAccountACTModal'));
            modal.show();
        },

        async executeBuildAccountWithACT() {
            if (!this.selectedChannel) return;

            this.buildingAccountACT = true;
            
            try {
                const channelId = this.selectedChannel.channelId || this.selectedChannel.channel_id;
                
                // Get the operation from the backend
                const response = await this.apiClient.post('/api/onboarding/admin/build-account', {
                    channelId: channelId,
                    useACT: true // Try to use ACT if available
                });

                if (response.success) {
                    // Use the keychainTransaction method from the parent app
                    const result = await this.$parent.keychainTransaction([response.operation], 'active');
                    
                    if (result.success) {
                        // Complete the account creation
                        const completeResponse = await this.apiClient.post('/api/onboarding/admin/complete-account-creation', {
                            channelId: channelId,
                            txId: result.result.id,
                            username: response.username,
                            creationMethod: response.creationMethod
                        });

                        if (completeResponse.success) {
                            const methodText = response.creationMethod === 'ACT' ? 'ACT' : 'HIVE delegation (fallback)';
                            this.showAlert(`Account @${response.username} created successfully with ${methodText}!`, 'success', 'check-circle');
                            
                            // Close modal and refresh data
                            bootstrap.Modal.getInstance(document.getElementById('buildAccountACTModal')).hide();
                            await this.refreshData();
                        } else {
                            throw new Error(completeResponse.error || 'Failed to complete account creation');
                        }
                    } else {
                        throw new Error(result.message || 'Keychain transaction failed');
                    }
                } else {
                    throw new Error(response.error || 'Failed to prepare account creation');
                }

            } catch (error) {
                console.error('Account creation with ACT failed:', error);
                this.showAlert('Failed to create account: ' + error.message, 'danger', 'exclamation-triangle');
            } finally {
                this.buildingAccountACT = false;
            }
        },

        canCancelChannel(channel) {
            // Allow deleting any channel (including completed ones) except currently processing ones
            return ['pending', 'confirmed', 'failed', 'completed', 'expired', 'cancelled'].includes(channel.status);
        },

        showCancelModal(channel) {
            this.selectedChannel = channel;
            const modal = new bootstrap.Modal(document.getElementById('cancelChannelModal'));
            modal.show();
        },

        async executeCancelChannel() {
            if (!this.selectedChannel) return;

            this.canceling = true;
            
            try {
                const channelId = this.selectedChannel.channelId || this.selectedChannel.channel_id;
                
                const response = await this.apiClient.delete(`/api/onboarding/admin/channels/${channelId}`);

                if (response.success) {
                    this.showAlert('Payment channel deleted successfully!', 'success', 'check-circle');
                    
                    // Close modal and refresh data
                    bootstrap.Modal.getInstance(document.getElementById('cancelChannelModal')).hide();
                    await this.refreshData();
                } else {
                    throw new Error(response.error || 'Failed to cancel channel');
                }

            } catch (error) {
                console.error('Channel cancellation failed:', error);
                this.showAlert('Failed to delete channel: ' + error.message, 'danger', 'exclamation-triangle');
            } finally {
                this.canceling = false;
            }
        }
    }
}; 