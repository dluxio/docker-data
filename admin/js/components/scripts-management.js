const ScriptsManagement = {
  template: `
    <div class="container-fluid">
      <div class="row">
        <div class="col-12">
          <h1>Scripts Management</h1>
          <p>Review and manage executable scripts to ensure platform security.</p>
        </div>
      </div>
      
      <!-- Stats Overview -->
      <div class="row mb-4">
        <div class="col-md-3">
          <div class="card text-white bg-warning">
            <div class="card-body">
              <h5 class="card-title"><i class="bi bi-hourglass-split"></i> Pending Reviews</h5>
              <p class="card-text display-4">{{ stats.totalPending || 0 }}</p>
            </div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card text-white bg-success">
            <div class="card-body">
              <h5 class="card-title"><i class="bi bi-check-circle"></i> Whitelisted Scripts</h5>
              <p class="card-text display-4">{{ stats.totalWhitelisted || 0 }}</p>
            </div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card text-white bg-info">
            <div class="card-body">
              <h5 class="card-title"><i class="bi bi-play-circle"></i> Total Executions</h5>
              <p class="card-text display-4">{{ stats.totalExecutions || 0 }}</p>
            </div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card text-white bg-primary">
            <div class="card-body">
              <h5 class="card-title"><i class="bi bi-graph-up"></i> Execution Success (7d)</h5>
              <p class="card-text display-4">{{ stats.executionSuccess || 100 }}%</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <ul class="nav nav-tabs">
        <li class="nav-item">
          <a class="nav-link" :class="{ active: currentView === 'reviews' }" @click="setView('reviews')">
            <i class="bi bi-exclamation-triangle"></i> Pending Reviews
            <span v-if="stats.totalPending" class="badge bg-danger ms-1">{{ stats.totalPending }}</span>
          </a>
        </li>
        <li class="nav-item">
          <a class="nav-link" :class="{ active: currentView === 'whitelist' }" @click="setView('whitelist')">
            <i class="bi bi-shield-check"></i> Whitelist
          </a>
        </li>
        <li class="nav-item">
          <a class="nav-link" :class="{ active: currentView === 'logs' }" @click="setView('logs')">
            <i class="bi bi-card-list"></i> Execution Logs
          </a>
        </li>
      </ul>

      <!-- Dynamic Content -->
      <div class="mt-3">
        <div v-if="loading" class="text-center">
          <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
        </div>
        <div v-else>
          <!-- Pending Reviews View -->
          <div v-if="currentView === 'reviews'">
            <h3>Pending Script Reviews</h3>
            <table class="table table-hover">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Hash</th>
                  <th>Source</th>
                  <th>Requested By</th>
                  <th>Risk</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="review in reviews.reviews" :key="review.id" :class="getRiskClass(review.risk_assessment)">
                  <td>{{ new Date(review.created_at).toLocaleString() }}</td>
                  <td class="font-monospace">{{ review.script_hash.substring(0, 12) }}...</td>
                  <td>{{ review.request_source }}</td>
                  <td>{{ review.requested_by }}</td>
                  <td>
                    <span class="badge" :class="getRiskBadge(review.risk_assessment)">
                      {{ review.risk_assessment }}
                    </span>
                    <i v-if="review.auto_flagged" class="bi bi-robot text-danger" title="Auto-flagged"></i>
                  </td>
                  <td>
                    <button class="btn btn-primary btn-sm" @click="viewReviewDetails(review.id)">
                      <i class="bi bi-search"></i> Review
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Whitelist View -->
          <div v-if="currentView === 'whitelist'">
            <h3>Whitelisted Scripts</h3>
            <table class="table table-hover">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Hash</th>
                  <th>Risk Level</th>
                  <th>Approved By</th>
                  <th>Approved At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="script in whitelist.scripts" :key="script.script_hash">
                  <td>{{ script.script_name }}</td>
                  <td class="font-monospace">{{ script.script_hash.substring(0, 12) }}...</td>
                  <td>
                    <span class="badge" :class="getRiskBadge(script.risk_level)">
                      {{ script.risk_level }}
                    </span>
                  </td>
                  <td>{{ script.approved_by }}</td>
                  <td>{{ new Date(script.approved_at).toLocaleString() }}</td>
                  <td>
                    <button class="btn btn-danger btn-sm" @click="removeFromWhitelist(script.script_hash)">
                      <i class="bi bi-trash"></i> Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Execution Logs View -->
          <div v-if="currentView === 'logs'">
            <h3>Script Execution Logs</h3>
            <table class="table table-hover">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Hash</th>
                  <th>Executed By</th>
                  <th>Status</th>
                  <th>Duration (ms)</th>
                  <th>IP Address</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="log in logs.logs" :key="log.id">
                  <td>{{ new Date(log.executed_at).toLocaleString() }}</td>
                  <td class="font-monospace">{{ log.script_hash.substring(0, 12) }}...</td>
                  <td>{{ log.executed_by }}</td>
                  <td>
                    <span v-if="log.success" class="badge bg-success">Success</span>
                    <span v-else class="badge bg-danger">Failure</span>
                  </td>
                  <td>{{ log.execution_time_ms }}</td>
                  <td>{{ log.ip_address }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          
          <!-- Pagination Controls -->
          <nav>
            <ul class="pagination">
              <li class="page-item" :class="{ disabled: currentPage === 1 }">
                <a class="page-link" href="#" @click.prevent="changePage(currentPage - 1)">Previous</a>
              </li>
              <li class="page-item" v-for="page in totalPages" :key="page" :class="{ active: page === currentPage }">
                <a class="page-link" href="#" @click.prevent="changePage(page)">{{ page }}</a>
              </li>
              <li class="page-item" :class="{ disabled: currentPage === totalPages }">
                <a class="page-link" href="#" @click.prevent="changePage(currentPage + 1)">Next</a>
              </li>
            </ul>
          </nav>
        </div>
      </div>
      
      <!-- Review Modal -->
      <div class="modal" tabindex="-1" ref="reviewModal">
        <div class="modal-dialog modal-xl">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Review Script</h5>
              <button type="button" class="btn-close" @click="closeModal" aria-label="Close"></button>
            </div>
            <div class="modal-body" v-if="selectedReview.review">
              <div class="row">
                <div class="col-md-6">
                  <h4>Details</h4>
                  <p><strong>Hash:</strong> <span class="font-monospace">{{ selectedReview.review.script_hash }}</span></p>
                  <p><strong>Source:</strong> {{ selectedReview.review.request_source }}</p>
                  <p><strong>Requested By:</strong> {{ selectedReview.review.requested_by }}</p>
                  <p><strong>Context:</strong></p>
                  <pre><code>{{ JSON.stringify(selectedReview.review.request_context, null, 2) }}</code></pre>
                  
                  <h4>Safety Analysis</h4>
                  <p><strong>Risk:</strong> 
                    <span class="badge" :class="getRiskBadge(selectedReview.safety_analysis.riskLevel)">
                      {{ selectedReview.safety_analysis.riskLevel }}
                    </span>
                  </p>
                  <p v-if="selectedReview.safety_analysis.isAutoFlagged">
                    <strong>Flagged Reasons:</strong>
                    <ul>
                      <li v-for="reason in selectedReview.safety_analysis.flaggedReasons" :key="reason">{{ reason }}</li>
                    </ul>
                  </p>
                </div>
                <div class="col-md-6">
                  <h4>Script Content</h4>
                  <pre style="height: 400px; background-color: #f8f9fa; border: 1px solid #dee2e6; overflow: auto;"><code>{{ selectedReview.review.script_content }}</code></pre>
                </div>
              </div>
              <hr />
              <h4>Actions</h4>
              <div class="mb-3">
                <label for="scriptName" class="form-label">Script Name (for whitelist)</label>
                <input type="text" class="form-control" id="scriptName" v-model="reviewAction.script_name">
              </div>
              <div class="mb-3">
                <label for="riskLevel" class="form-label">Risk Level</label>
                <select class="form-select" id="riskLevel" v-model="reviewAction.risk_level">
                  <option>low</option>
                  <option>medium</option>
                  <option>high</option>
                </select>
              </div>
              <div class="mb-3">
                <label for="reviewNotes" class="form-label">Review Notes</label>
                <textarea class="form-control" id="reviewNotes" rows="3" v-model="reviewAction.review_notes"></textarea>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" @click="closeModal">Close</button>
              <button type="button" class="btn btn-danger" @click="processReview('reject')">Reject</button>
              <button type="button" class="btn btn-warning" @click="processReview('block')">Block Hash</button>
              <button type="button" class="btn btn-success" @click="processReview('approve')">Approve & Whitelist</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  `,
  data() {
    return {
      stats: {},
      reviews: { reviews: [], totalCount: 0 },
      whitelist: { scripts: [], totalCount: 0 },
      logs: { logs: [], totalCount: 0 },
      currentView: 'reviews',
      loading: false,
      currentPage: 1,
      itemsPerPage: 10,
      selectedReview: {},
      reviewAction: {
        script_name: '',
        risk_level: 'medium',
        review_notes: '',
      },
      modal: null
    };
  },
  computed: {
    totalPages() {
      const total = this[`${this.currentView}`]?.totalCount || 0;
      return Math.ceil(total / this.itemsPerPage);
    }
  },
  methods: {
    async fetchData() {
      this.loading = true;
      try {
        await this.fetchStats();
        await this.fetchCurrentViewData();
      } catch (error) {
        console.error('Error fetching data:', error);
        alert('Failed to fetch data. See console for details.');
      } finally {
        this.loading = false;
      }
    },
    async fetchStats() {
      const response = await fetch('/api/scripts/stats');
      if (!response.ok) throw new Error('Failed to fetch stats');
      const data = await response.json();
      this.stats = data.stats;
    },
    async fetchCurrentViewData() {
      const offset = (this.currentPage - 1) * this.itemsPerPage;
      const endpoints = {
        reviews: `/api/scripts/pending?limit=${this.itemsPerPage}&offset=${offset}`,
        whitelist: `/api/scripts/whitelist?limit=${this.itemsPerPage}&offset=${offset}`,
        logs: `/api/scripts/logs?limit=${this.itemsPerPage}&offset=${offset}`
      };
      
      const endpoint = endpoints[this.currentView];
      if (!endpoint) return;

      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`Failed to fetch ${this.currentView}`);
      const data = await response.json();
      this[this.currentView] = data;
    },
    setView(view) {
      this.currentView = view;
      this.currentPage = 1;
      this.fetchData();
    },
    changePage(page) {
      if (page < 1 || page > this.totalPages) return;
      this.currentPage = page;
      this.fetchData();
    },
    getRiskBadge(risk) {
      switch (risk) {
        case 'critical': return 'bg-danger';
        case 'high': return 'bg-warning text-dark';
        case 'medium': return 'bg-info text-dark';
        case 'low': return 'bg-success';
        default: return 'bg-secondary';
      }
    },
    getRiskClass(risk) {
      switch (risk) {
        case 'critical': return 'table-danger';
        case 'high': return 'table-warning';
        default: return '';
      }
    },
    async viewReviewDetails(reviewId) {
      try {
        const response = await fetch(`/api/scripts/review/${reviewId}`);
        if (!response.ok) throw new Error('Failed to fetch review details');
        this.selectedReview = await response.json();
        this.reviewAction.script_name = `Script-${this.selectedReview.review.script_hash.substring(0, 8)}`;
        this.reviewAction.risk_level = this.selectedReview.safety_analysis.riskLevel;
        this.openModal();
      } catch (error) {
        console.error('Error fetching review details:', error);
        alert('Failed to fetch review details.');
      }
    },
    async processReview(action) {
      if (!confirm(`Are you sure you want to ${action} this script?`)) return;

      try {
        const response = await fetch(`/api/scripts/review/${this.selectedReview.review.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: action,
            reviewer_username: this.$root.user.name, // Assuming user is in root
            ...this.reviewAction
          })
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to process review');
        }
        
        alert(`Script ${action}ed successfully.`);
        this.closeModal();
        this.fetchData();

      } catch (error) {
        console.error('Error processing review:', error);
        alert(`Failed to process review: ${error.message}`);
      }
    },
    async removeFromWhitelist(scriptHash) {
      if (!confirm('Are you sure you want to remove this script from the whitelist?')) return;
      
      try {
        const response = await fetch(`/api/scripts/whitelist/${scriptHash}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remover_username: this.$root.user.name })
        });
        
        if (!response.ok) throw new Error('Failed to remove from whitelist');
        
        alert('Script removed from whitelist.');
        this.fetchData();

      } catch (error) {
        console.error('Error removing from whitelist:', error);
        alert('Failed to remove script from whitelist.');
      }
    },
    openModal() {
      if (!this.modal) {
        this.modal = new bootstrap.Modal(this.$refs.reviewModal);
      }
      this.modal.show();
    },
    closeModal() {
      if (this.modal) {
        this.modal.hide();
      }
      this.selectedReview = {};
    }
  },
  mounted() {
    this.fetchData();
  }
};

// Register component with the global DLUX_COMPONENTS object
window.DLUX_COMPONENTS = window.DLUX_COMPONENTS || {};
window.DLUX_COMPONENTS['scripts-management'] = ScriptsManagement;
