// Flag Reports Management Component
window.DLUX_COMPONENTS = window.DLUX_COMPONENTS || {};
window.DLUX_COMPONENTS['flags-view'] = {
    props: ['apiClient'],
    emits: ['loading'],
    
    template: `
        <div class="flags-view">
            <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                <h1 class="h2">Community Flag Reports</h1>
                <div class="btn-toolbar mb-2 mb-md-0">
                    <div class="btn-group me-2">
                        <button class="btn btn-outline-primary" @click="refreshData" :disabled="loading">
                            <i class="bi bi-arrow-clockwise"></i>
                            Refresh
                        </button>
                        <button class="btn btn-outline-info" @click="showUserManagement">
                            <i class="bi bi-people"></i>
                            User Management
                        </button>
                    </div>
                </div>
            </div>

            <!-- Statistics Cards -->
            <div class="row mb-4">
                <div class="col-md-3">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Pending Reports</h6>
                                    <h3>{{ stats.pending || 0 }}</h3>
                                </div>
                                <i class="bi bi-flag fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Today's Reports</h6>
                                    <h3>{{ stats.today || 0 }}</h3>
                                </div>
                                <i class="bi bi-calendar-day fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Total Reporters</h6>
                                    <h3>{{ stats.reporters || 0 }}</h3>
                                </div>
                                <i class="bi bi-people fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Accuracy Rate</h6>
                                    <h3>{{ stats.accuracy || 0 }}%</h3>
                                </div>
                                <i class="bi bi-bullseye fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Filters -->
            <div class="row mb-4">
                <div class="col-md-3">
                    <select class="form-select" v-model="filters.flag_type" @change="refreshData">
                        <option value="">All Flag Types</option>
                        <option value="nsfw">NSFW</option>
                        <option value="spam">Spam</option>
                        <option value="harassment">Harassment</option>
                        <option value="inappropriate">Inappropriate</option>
                        <option value="copyright">Copyright</option>
                        <option value="other">Other</option>
                    </select>
                </div>
                <div class="col-md-3">
                    <input type="text" class="form-control" placeholder="Filter by reporter..." 
                           v-model="filters.reporter" @input="debounceSearch">
                </div>
                <div class="col-md-3">
                    <select class="form-select" v-model="filters.limit" @change="refreshData">
                        <option value="25">25 per page</option>
                        <option value="50">50 per page</option>
                        <option value="100">100 per page</option>
                    </select>
                </div>
                <div class="col-md-3">
                    <button class="btn btn-outline-secondary w-100" @click="showFlagTypesInfo">
                        <i class="bi bi-info-circle"></i> Flag Types Info
                    </button>
                </div>
            </div>

            <!-- Flag Reports Table -->
            <div class="card">
                <div class="card-header d-flex justify-content-between align-items-center">
                    <h5>Pending Flag Reports ({{ data.reports.length }} of {{ data.totalCount }})</h5>
                </div>
                <div class="card-body">
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th>Report #</th>
                                    <th>Post</th>
                                    <th>Flag Type</th>
                                    <th>Reporter</th>
                                    <th>Reason</th>
                                    <th>Date</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="report in data.reports" :key="report.id">
                                    <td><strong>#{{ report.id }}</strong></td>
                                    <td>
                                        <div>
                                            <strong>@{{ report.post_author }}</strong>
                                            <br>
                                            <code class="small">{{ report.post_permlink }}</code>
                                        </div>
                                    </td>
                                    <td>
                                        <span class="badge" :class="getFlagTypeClass(report.flag_type)">
                                            {{ report.flag_type.toUpperCase() }}
                                        </span>
                                    </td>
                                    <td>
                                        <strong>@{{ report.reporter_account }}</strong>
                                        <br>
                                        <small class="text-muted">{{ report.reporter_accuracy || 0 }}% accuracy</small>
                                    </td>
                                    <td>
                                        <div class="text-truncate" style="max-width: 200px;" :title="report.reason">
                                            {{ report.reason || 'No reason provided' }}
                                        </div>
                                    </td>
                                    <td>
                                        <small>{{ formatDate(report.created_at) }}</small>
                                    </td>
                                    <td>
                                        <div class="btn-group btn-group-sm">
                                            <button class="btn btn-outline-success" 
                                                    @click="reviewReport(report, 'accept')"
                                                    title="Accept Report">
                                                <i class="bi bi-check-lg"></i>
                                            </button>
                                            <button class="btn btn-outline-danger" 
                                                    @click="reviewReport(report, 'reject')"
                                                    title="Reject Report">
                                                <i class="bi bi-x-lg"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <div v-if="!data.reports || data.reports.length === 0" 
                             class="text-center text-muted py-4">
                            <i class="bi bi-inbox fs-1 d-block mb-2"></i>
                            No pending flag reports
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

            <!-- Report Details Modal -->
            <div class="modal fade" id="reportDetailsModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Flag Report Details</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedReport">
                            <div class="row">
                                <div class="col-md-6">
                                    <h6>Report Information</h6>
                                    <table class="table table-sm">
                                        <tbody>
                                            <tr>
                                                <td><strong>Report ID:</strong></td>
                                                <td>#{{ selectedReport.id }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Flag Type:</strong></td>
                                                <td>
                                                    <span class="badge" :class="getFlagTypeClass(selectedReport.flag_type)">
                                                        {{ selectedReport.flag_type.toUpperCase() }}
                                                    </span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td><strong>Reporter:</strong></td>
                                                <td>@{{ selectedReport.reporter_account }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Submitted:</strong></td>
                                                <td>{{ formatDate(selectedReport.created_at) }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Reason:</strong></td>
                                                <td>{{ selectedReport.reason || 'No reason provided' }}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                                <div class="col-md-6">
                                    <h6>Post Information</h6>
                                    <table class="table table-sm">
                                        <tbody>
                                            <tr>
                                                <td><strong>Author:</strong></td>
                                                <td>@{{ selectedReport.post_author }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Permlink:</strong></td>
                                                <td><code>{{ selectedReport.post_permlink }}</code></td>
                                            </tr>
                                            <tr>
                                                <td><strong>Type:</strong></td>
                                                <td>
                                                    <span class="badge" :class="getTypeClass(selectedReport.post_type)">
                                                        {{ selectedReport.post_type }}
                                                    </span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td><strong>Votes:</strong></td>
                                                <td>{{ selectedReport.post_votes || 0 }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Vote Weight:</strong></td>
                                                <td>{{ formatNumber(selectedReport.post_voteweight || 0) }}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            
                            <div class="row mt-3" v-if="selectedReport.reporter_accuracy !== undefined">
                                <div class="col-12">
                                    <h6>Reporter Statistics</h6>
                                    <div class="d-flex justify-content-around text-center">
                                        <div>
                                            <strong>{{ selectedReport.flags_submitted || 0 }}</strong>
                                            <br><small class="text-muted">Submitted</small>
                                        </div>
                                        <div>
                                            <strong>{{ selectedReport.flags_accepted || 0 }}</strong>
                                            <br><small class="text-muted">Accepted</small>
                                        </div>
                                        <div>
                                            <strong>{{ selectedReport.flags_rejected || 0 }}</strong>
                                            <br><small class="text-muted">Rejected</small>
                                        </div>
                                        <div>
                                            <strong>{{ selectedReport.reporter_accuracy || 0 }}%</strong>
                                            <br><small class="text-muted">Accuracy</small>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                            <button type="button" class="btn btn-success" @click="reviewReport(selectedReport, 'accept')">
                                <i class="bi bi-check-lg"></i> Accept Report
                            </button>
                            <button type="button" class="btn btn-danger" @click="reviewReport(selectedReport, 'reject')">
                                <i class="bi bi-x-lg"></i> Reject Report
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Review Modal -->
            <div class="modal fade" id="reviewModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ reviewAction === 'accept' ? 'Accept' : 'Reject' }} Flag Report</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedReport">
                            <div class="mb-3">
                                <h6>Report: #{{ selectedReport.id }}</h6>
                                <p>
                                    <strong>Post:</strong> @{{ selectedReport.post_author }}/{{ selectedReport.post_permlink }}<br>
                                    <strong>Flag Type:</strong> 
                                    <span class="badge" :class="getFlagTypeClass(selectedReport.flag_type)">
                                        {{ selectedReport.flag_type.toUpperCase() }}
                                    </span><br>
                                    <strong>Reporter:</strong> @{{ selectedReport.reporter_account }}
                                </p>
                            </div>
                            
                            <div class="mb-3">
                                <label class="form-label">Moderator Username <span class="text-danger">*</span></label>
                                <input type="text" class="form-control" v-model="reviewForm.moderator_username" 
                                       placeholder="Enter your username" required>
                            </div>
                            
                            <div class="mb-3" v-if="reviewAction === 'accept'">
                                <div class="form-check">
                                    <input class="form-check-input" type="checkbox" v-model="reviewForm.apply_to_post" id="applyToPostCheck">
                                    <label class="form-check-label" for="applyToPostCheck">
                                        Apply flag to the post (update post flags)
                                    </label>
                                </div>
                                <div class="form-text">
                                    If checked, the post will be automatically flagged based on the report type.
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" class="btn" 
                                    :class="reviewAction === 'accept' ? 'btn-success' : 'btn-danger'"
                                    @click="confirmReview" 
                                    :disabled="!reviewForm.moderator_username">
                                {{ reviewAction === 'accept' ? 'Accept' : 'Reject' }} Report
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- User Management Modal -->
            <div class="modal fade" id="userManagementModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">User Flag Permissions</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <div class="mb-3">
                                <label class="form-label">Username</label>
                                <div class="input-group">
                                    <input type="text" class="form-control" v-model="userManagement.username" 
                                           placeholder="Enter Hive username">
                                    <button class="btn btn-outline-primary" @click="loadUserStats" 
                                            :disabled="!userManagement.username">
                                        Load Stats
                                    </button>
                                </div>
                            </div>
                            
                            <div v-if="userManagement.stats" class="mb-3">
                                <h6>Current Statistics</h6>
                                <div class="row">
                                    <div class="col-md-6">
                                        <table class="table table-sm">
                                            <tbody>
                                                <tr>
                                                    <td><strong>Flags Submitted:</strong></td>
                                                    <td>{{ userManagement.stats.flags_submitted }}</td>
                                                </tr>
                                                <tr>
                                                    <td><strong>Flags Accepted:</strong></td>
                                                    <td>{{ userManagement.stats.flags_accepted }}</td>
                                                </tr>
                                                <tr>
                                                    <td><strong>Flags Rejected:</strong></td>
                                                    <td>{{ userManagement.stats.flags_rejected }}</td>
                                                </tr>
                                                <tr>
                                                    <td><strong>Accuracy Rate:</strong></td>
                                                    <td>{{ userManagement.stats.accuracy_rate }}%</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                    <div class="col-md-6">
                                        <table class="table table-sm">
                                            <tbody>
                                                <tr>
                                                    <td><strong>Can Flag:</strong></td>
                                                    <td>
                                                        <span class="badge" :class="userManagement.stats.can_flag ? 'bg-success' : 'bg-danger'">
                                                            {{ userManagement.stats.can_flag ? 'Yes' : 'No' }}
                                                        </span>
                                                    </td>
                                                </tr>
                                                <tr v-if="userManagement.stats.banned_until">
                                                    <td><strong>Banned Until:</strong></td>
                                                    <td>{{ formatDate(userManagement.stats.banned_until) }}</td>
                                                </tr>
                                                <tr v-if="userManagement.stats.ban_reason">
                                                    <td><strong>Ban Reason:</strong></td>
                                                    <td>{{ userManagement.stats.ban_reason }}</td>
                                                </tr>
                                                <tr>
                                                    <td><strong>Pending Reports:</strong></td>
                                                    <td>{{ userManagement.stats.pending_reports }}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                            
                            <div class="mb-3">
                                <div class="form-check">
                                    <input class="form-check-input" type="checkbox" v-model="userManagement.form.can_flag" id="canFlagCheck">
                                    <label class="form-check-label" for="canFlagCheck">
                                        User can submit flag reports
                                    </label>
                                </div>
                            </div>
                            
                            <div class="mb-3">
                                <label class="form-label">Temporary Ban (hours)</label>
                                <input type="number" class="form-control" v-model="userManagement.form.ban_duration_hours" 
                                       placeholder="0 = no ban, >0 = ban duration in hours" min="0">
                                <div class="form-text">Set to 0 to remove any existing ban</div>
                            </div>
                            
                            <div class="mb-3" v-if="userManagement.form.ban_duration_hours > 0">
                                <label class="form-label">Ban Reason</label>
                                <textarea class="form-control" v-model="userManagement.form.ban_reason" 
                                          placeholder="Reason for the ban..." rows="2"></textarea>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" class="btn btn-primary" @click="updateUserPermissions" 
                                    :disabled="!userManagement.username">
                                Update Permissions
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Flag Types Info Modal -->
            <div class="modal fade" id="flagTypesModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Flag Types Information</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <table class="table table-sm">
                                <thead>
                                    <tr>
                                        <th>Flag Type</th>
                                        <th>Description</th>
                                        <th>When to Use</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr>
                                        <td><span class="badge bg-danger">NSFW</span></td>
                                        <td>Not Safe For Work</td>
                                        <td>Adult content, nudity, sexual themes</td>
                                    </tr>
                                    <tr>
                                        <td><span class="badge bg-warning text-dark">SPAM</span></td>
                                        <td>Spam Content</td>
                                        <td>Repetitive, promotional, or low-quality content</td>
                                    </tr>
                                    <tr>
                                        <td><span class="badge bg-danger">HARASSMENT</span></td>
                                        <td>Harassment</td>
                                        <td>Bullying, threats, or targeted harassment</td>
                                    </tr>
                                    <tr>
                                        <td><span class="badge bg-warning text-dark">INAPPROPRIATE</span></td>
                                        <td>Inappropriate</td>
                                        <td>Offensive language, hate speech, discriminatory content</td>
                                    </tr>
                                    <tr>
                                        <td><span class="badge bg-info">COPYRIGHT</span></td>
                                        <td>Copyright Violation</td>
                                        <td>Unauthorized use of copyrighted material</td>
                                    </tr>
                                    <tr>
                                        <td><span class="badge bg-secondary">OTHER</span></td>
                                        <td>Other Issues</td>
                                        <td>Any other policy violations not covered above</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `,
    
    data() {
        return {
            loading: false,
            searchTimeout: null,
            data: {
                reports: [],
                totalCount: 0
            },
            stats: {
                pending: 0,
                today: 0,
                reporters: 0,
                accuracy: 0
            },
            filters: {
                flag_type: '',
                reporter: '',
                limit: 50,
                offset: 0
            },
            selectedReport: null,
            reviewAction: null,
            reviewForm: {
                moderator_username: '',
                apply_to_post: false
            },
            userManagement: {
                username: '',
                stats: null,
                form: {
                    can_flag: true,
                    ban_duration_hours: 0,
                    ban_reason: ''
                }
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
        await this.loadStats();
    },
    
    methods: {
        async loadData() {
            this.loading = true;
            this.$emit('loading', true);
            
            try {
                const params = new URLSearchParams({
                    limit: this.filters.limit,
                    offset: this.filters.offset
                });
                
                if (this.filters.flag_type) {
                    params.append('flag_type', this.filters.flag_type);
                }
                if (this.filters.reporter) {
                    params.append('reporter', this.filters.reporter);
                }
                
                const response = await fetch(`${this.apiClient.baseURL}/api/flags/pending?${params}`, {
                    headers: this.apiClient.headers
                });
                
                if (response.ok) {
                    const result = await response.json();
                    this.data = {
                        reports: result.reports || [],
                        totalCount: result.totalCount || 0
                    };
                    this.stats.pending = result.totalCount || 0;
                } else {
                    console.error('Failed to load flag reports:', response.statusText);
                    this.showAlert('Failed to load flag reports', 'danger');
                }
            } catch (error) {
                console.error('Error loading flag reports:', error);
                this.showAlert('Error loading flag reports: ' + error.message, 'danger');
            } finally {
                this.loading = false;
                this.$emit('loading', false);
            }
        },
        
        async loadStats() {
            // This would need to be implemented as a separate endpoint
            // For now, calculate basic stats from current data
            this.stats = {
                pending: this.data.totalCount,
                today: this.data.reports.filter(r => 
                    new Date(r.created_at).toDateString() === new Date().toDateString()
                ).length,
                reporters: [...new Set(this.data.reports.map(r => r.reporter_account))].length,
                accuracy: this.data.reports.length > 0 ? 
                    Math.round(this.data.reports.reduce((acc, r) => acc + (r.reporter_accuracy || 0), 0) / this.data.reports.length) : 0
            };
        },
        
        async refreshData() {
            this.filters.offset = 0;
            await this.loadData();
            await this.loadStats();
        },
        
        debounceSearch() {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.filters.offset = 0;
                this.loadData();
            }, 500);
        },
        
        goToPage(page) {
            if (page >= 1 && page <= this.totalPages) {
                this.filters.offset = (page - 1) * this.filters.limit;
                this.loadData();
            }
        },
        
        viewReportDetails(report) {
            this.selectedReport = report;
            const modal = new bootstrap.Modal(document.getElementById('reportDetailsModal'));
            modal.show();
        },
        
        async reviewReport(report, action) {
            this.selectedReport = report;
            this.reviewAction = action;
            this.reviewForm = {
                moderator_username: '',
                apply_to_post: action === 'accept'
            };
            
            // Close details modal if open
            const detailsModal = bootstrap.Modal.getInstance(document.getElementById('reportDetailsModal'));
            if (detailsModal) {
                detailsModal.hide();
            }
            
            const modal = new bootstrap.Modal(document.getElementById('reviewModal'));
            modal.show();
        },
        
        async confirmReview() {
            if (!this.reviewForm.moderator_username || !this.selectedReport) return;
            
            try {
                const response = await fetch(`${this.apiClient.baseURL}/api/flags/review/${this.selectedReport.id}`, {
                    method: 'POST',
                    headers: {
                        ...this.apiClient.headers,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        action: this.reviewAction,
                        moderator_username: this.reviewForm.moderator_username,
                        apply_to_post: this.reviewForm.apply_to_post
                    })
                });
                
                if (response.ok) {
                    this.showAlert(`Flag report ${this.reviewAction}ed successfully`, 'success');
                    bootstrap.Modal.getInstance(document.getElementById('reviewModal')).hide();
                    await this.refreshData();
                } else {
                    const error = await response.json();
                    this.showAlert(error.error || `Failed to ${this.reviewAction} report`, 'danger');
                }
            } catch (error) {
                console.error(`Error ${this.reviewAction}ing report:`, error);
                this.showAlert(`Error ${this.reviewAction}ing report: ` + error.message, 'danger');
            }
        },
        
        showUserManagement() {
            this.userManagement = {
                username: '',
                stats: null,
                form: {
                    can_flag: true,
                    ban_duration_hours: 0,
                    ban_reason: ''
                }
            };
            const modal = new bootstrap.Modal(document.getElementById('userManagementModal'));
            modal.show();
        },
        
        async loadUserStats() {
            if (!this.userManagement.username) return;
            
            try {
                const response = await fetch(`${this.apiClient.baseURL}/api/flags/users/${this.userManagement.username}/stats`, {
                    headers: this.apiClient.headers
                });
                
                if (response.ok) {
                    const stats = await response.json();
                    this.userManagement.stats = stats;
                    this.userManagement.form.can_flag = stats.can_flag;
                    this.userManagement.form.ban_duration_hours = 0;
                    this.userManagement.form.ban_reason = '';
                } else {
                    this.showAlert('Failed to load user statistics', 'danger');
                }
            } catch (error) {
                console.error('Error loading user stats:', error);
                this.showAlert('Error loading user stats: ' + error.message, 'danger');
            }
        },
        
        async updateUserPermissions() {
            if (!this.userManagement.username) return;
            
            try {
                const response = await fetch(`${this.apiClient.baseURL}/api/flags/users/${this.userManagement.username}/permissions`, {
                    method: 'PUT',
                    headers: {
                        ...this.apiClient.headers,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(this.userManagement.form)
                });
                
                if (response.ok) {
                    this.showAlert('User permissions updated successfully', 'success');
                    bootstrap.Modal.getInstance(document.getElementById('userManagementModal')).hide();
                    await this.loadUserStats(); // Refresh stats
                } else {
                    const error = await response.json();
                    this.showAlert(error.error || 'Failed to update user permissions', 'danger');
                }
            } catch (error) {
                console.error('Error updating user permissions:', error);
                this.showAlert('Error updating user permissions: ' + error.message, 'danger');
            }
        },
        
        showFlagTypesInfo() {
            const modal = new bootstrap.Modal(document.getElementById('flagTypesModal'));
            modal.show();
        },
        
        getFlagTypeClass(flagType) {
            const classes = {
                'nsfw': 'bg-danger',
                'spam': 'bg-warning text-dark',
                'harassment': 'bg-danger',
                'inappropriate': 'bg-warning text-dark',
                'copyright': 'bg-info',
                'other': 'bg-secondary'
            };
            return classes[flagType] || 'bg-secondary';
        },
        
        getTypeClass(type) {
            const classes = {
                'VR': 'bg-primary',
                'AR': 'bg-info',
                'XR': 'bg-success',
                'APP': 'bg-warning text-dark',
                '360': 'bg-danger',
                '3D': 'bg-secondary',
                'Audio': 'bg-dark',
                'Video': 'bg-light text-dark'
            };
            return classes[type] || 'bg-secondary';
        },
        
        formatNumber(num) {
            if (!num || num === 0) return '0';
            return parseFloat(num).toLocaleString();
        },
        
        formatDate(dateString) {
            if (!dateString) return 'N/A';
            return new Date(dateString).toLocaleString();
        },
        
        showAlert(message, type = 'info') {
            console.log(`Alert [${type}]: ${message}`);
            // This can be enhanced to show actual UI alerts
        }
    }
}; 