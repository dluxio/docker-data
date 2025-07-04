class SubscriptionManager {
  constructor() {
    this.baseUrl = '/api';
    this.currentPage = 1;
    this.stats = null;
    this.isLoading = false;
  }

  async init() {
    console.log('Initializing Subscription Manager...');
    this.render();
    await this.loadStats();
    this.setupEventListeners();
  }

  render() {
    const container = document.getElementById('subscription-manager');
    if (!container) {
      console.error('Subscription manager container not found');
      return;
    }

    container.innerHTML = `
      <div class="subscription-manager">
        <div class="row mb-4">
          <div class="col-12">
            <h2>Subscription Management</h2>
            <nav>
              <div class="nav nav-tabs" id="nav-tab" role="tablist">
                <button class="nav-link active" id="nav-overview-tab" data-bs-toggle="tab" 
                        data-bs-target="#nav-overview" type="button">Overview</button>
                <button class="nav-link" id="nav-payments-tab" data-bs-toggle="tab" 
                        data-bs-target="#nav-payments" type="button">Recent Payments</button>
                <button class="nav-link" id="nav-promos-tab" data-bs-toggle="tab" 
                        data-bs-target="#nav-promos" type="button">Promo Codes</button>
                <button class="nav-link" id="nav-tiers-tab" data-bs-toggle="tab" 
                        data-bs-target="#nav-tiers" type="button">Tiers</button>
                <button class="nav-link" id="nav-monitoring-tab" data-bs-toggle="tab" 
                        data-bs-target="#nav-monitoring" type="button">Monitoring</button>
              </div>
            </nav>
          </div>
        </div>

        <div class="tab-content" id="nav-tabContent">
          <!-- Overview Tab -->
          <div class="tab-pane fade show active" id="nav-overview">
            <div class="row" id="stats-cards">
              <div class="col-md-3">
                <div class="card bg-primary text-white">
                  <div class="card-body">
                    <div class="d-flex justify-content-between">
                      <div>
                        <h4 id="active-subs">-</h4>
                        <p class="mb-0">Active Subscriptions</p>
                      </div>
                      <div class="align-self-center">
                        <i class="fas fa-users fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="col-md-3">
                <div class="card bg-success text-white">
                  <div class="card-body">
                    <div class="d-flex justify-content-between">
                      <div>
                        <h4 id="monthly-revenue">-</h4>
                        <p class="mb-0">Monthly Revenue (HBD)</p>
                      </div>
                      <div class="align-self-center">
                        <i class="fas fa-dollar-sign fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="col-md-3">
                <div class="card bg-warning text-white">
                  <div class="card-body">
                    <div class="d-flex justify-content-between">
                      <div>
                        <h4 id="expiring-soon">-</h4>
                        <p class="mb-0">Expiring Soon</p>
                      </div>
                      <div class="align-self-center">
                        <i class="fas fa-clock fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="col-md-3">
                <div class="card bg-danger text-white">
                  <div class="card-body">
                    <div class="d-flex justify-content-between">
                      <div>
                        <h4 id="failed-payments">-</h4>
                        <p class="mb-0">Failed Payments (7d)</p>
                      </div>
                      <div class="align-self-center">
                        <i class="fas fa-exclamation-triangle fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="row mt-4">
              <div class="col-md-6">
                <div class="card">
                  <div class="card-header">
                    <h5>Tier Distribution</h5>
                  </div>
                  <div class="card-body">
                    <div id="tier-distribution"></div>
                  </div>
                </div>
              </div>
              <div class="col-md-6">
                <div class="card">
                  <div class="card-header">
                    <h5>Expiring Subscriptions</h5>
                  </div>
                  <div class="card-body">
                    <div id="expiring-list" style="max-height: 300px; overflow-y: auto;"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Recent Payments Tab -->
          <div class="tab-pane fade" id="nav-payments">
            <div class="card">
              <div class="card-header">
                <h5>Recent Subscription Payments</h5>
                <button class="btn btn-sm btn-outline-primary float-end" onclick="subscriptionManager.refreshPayments()">
                  <i class="fas fa-refresh"></i> Refresh
                </button>
              </div>
              <div class="card-body">
                <div id="payments-table"></div>
              </div>
            </div>
          </div>

          <!-- Promo Codes Tab -->
          <div class="tab-pane fade" id="nav-promos">
            <div class="row">
              <div class="col-md-4">
                <div class="card">
                  <div class="card-header">
                    <h5>Create Promo Code</h5>
                  </div>
                  <div class="card-body">
                    <form id="promo-form">
                      <div class="mb-3">
                        <label class="form-label">Code</label>
                        <input type="text" class="form-control" id="promo-code" required>
                      </div>
                      <div class="mb-3">
                        <label class="form-label">Description</label>
                        <textarea class="form-control" id="promo-description" rows="3"></textarea>
                      </div>
                      <div class="mb-3">
                        <label class="form-label">Discount Type</label>
                        <select class="form-control" id="promo-discount-type" required>
                          <option value="">Select type</option>
                          <option value="percentage">Percentage</option>
                          <option value="fixed_hive">Fixed HIVE</option>
                          <option value="fixed_hbd">Fixed HBD</option>
                        </select>
                      </div>
                      <div class="mb-3">
                        <label class="form-label">Discount Value</label>
                        <input type="number" class="form-control" id="promo-discount-value" step="0.001" required>
                      </div>
                      <div class="mb-3">
                        <label class="form-label">Max Uses</label>
                        <input type="number" class="form-control" id="promo-max-uses" placeholder="Unlimited">
                      </div>
                      <div class="mb-3">
                        <label class="form-label">Uses Per User</label>
                        <input type="number" class="form-control" id="promo-uses-per-user" value="1">
                      </div>
                      <div class="mb-3">
                        <label class="form-label">Valid Until</label>
                        <input type="datetime-local" class="form-control" id="promo-valid-until">
                      </div>
                      <button type="submit" class="btn btn-primary">Create Promo Code</button>
                    </form>
                  </div>
                </div>
              </div>
              <div class="col-md-8">
                <div class="card">
                  <div class="card-header">
                    <h5>Existing Promo Codes</h5>
                  </div>
                  <div class="card-body">
                    <div id="promo-codes-list"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Tiers Tab -->
          <div class="tab-pane fade" id="nav-tiers">
            <div class="card">
              <div class="card-header">
                <h5>Subscription Tiers</h5>
              </div>
              <div class="card-body">
                <div id="tiers-list"></div>
              </div>
            </div>
          </div>

          <!-- Monitoring Tab -->
          <div class="tab-pane fade" id="nav-monitoring">
            <div class="row">
              <div class="col-md-6 mb-4">
                <div class="card">
                  <div class="card-header">
                    <h5>Subscription Monitor Status</h5>
                    <button class="btn btn-sm btn-outline-primary float-end" onclick="subscriptionManager.refreshMonitoring()">
                      <i class="fas fa-refresh"></i> Refresh
                    </button>
                  </div>
                  <div class="card-body">
                    <div id="monitoring-status"></div>
                  </div>
                </div>
              </div>
              
              <div class="col-md-6 mb-4">
                <div class="card">
                  <div class="card-header d-flex justify-content-between align-items-center">
                    <h5 class="card-title mb-0">🔔 Payment Notifications</h5>
                    <button class="btn btn-sm btn-outline-primary" onclick="subscriptionManager.runNotificationChecks()">
                      Run Checks
                    </button>
                  </div>
                  <div class="card-body">
                    <div id="notification-stats">
                      <div class="text-center">
                        <div class="spinner-border spinner-border-sm me-2" role="status"></div>
                        Loading notification stats...
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  setupEventListeners() {
    // Auto-refresh every 30 seconds
    setInterval(() => {
      if (document.querySelector('#nav-overview').classList.contains('active')) {
        this.loadStats();
      } else if (document.querySelector('#nav-monitoring').classList.contains('active')) {
        this.loadMonitoringStatus();
      }
    }, 30000);

    // Promo code form
    document.getElementById('promo-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.createPromoCode();
    });

    // Tab change events
    document.querySelectorAll('[data-bs-toggle="tab"]').forEach(tab => {
      tab.addEventListener('shown.bs.tab', (e) => {
        const target = e.target.getAttribute('data-bs-target');
        switch (target) {
          case '#nav-payments':
            this.loadRecentPayments();
            break;
          case '#nav-promos':
            this.loadPromoCodes();
            break;
          case '#nav-tiers':
            this.migrateUSDPricing().then(() => this.loadTiers());
            break;
          case '#nav-monitoring':
            this.loadMonitoringStatus();
            this.loadNotificationStats();
            break;
        }
      });
    });
  }

  async loadStats() {
    try {
      this.isLoading = true;
      const response = await fetch(`${this.baseUrl}/admin/subscriptions/stats`);
      const data = await response.json();
      
      if (response.ok) {
        this.stats = data.stats;
        this.renderStats();
      } else {
        this.showError('Failed to load statistics: ' + data.error);
      }
    } catch (error) {
      console.error('Error loading stats:', error);
      this.showError('Error loading statistics');
    } finally {
      this.isLoading = false;
    }
  }

  renderStats() {
    if (!this.stats) return;

    // Update stat cards
    document.getElementById('active-subs').textContent = this.stats.active_subscriptions || 0;
    document.getElementById('monthly-revenue').textContent = (this.stats.revenue_this_month || 0).toFixed(2);
    document.getElementById('expiring-soon').textContent = this.stats.expiring_soon?.length || 0;
    document.getElementById('failed-payments').textContent = this.stats.failed_payments_week || 0;

    // Render tier distribution
    this.renderTierDistribution();
    
    // Render expiring subscriptions
    this.renderExpiringSoon();
  }

  renderTierDistribution() {
    const container = document.getElementById('tier-distribution');
    if (!this.stats?.tier_distribution) {
      container.innerHTML = '<p class="text-muted">No data available</p>';
      return;
    }

    const html = this.stats.tier_distribution.map(tier => `
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="badge bg-secondary">${tier.tier_name}</span>
        <span class="fw-bold">${tier.subscribers} users</span>
      </div>
    `).join('');

    container.innerHTML = html;
  }

  renderExpiringSoon() {
    const container = document.getElementById('expiring-list');
    if (!this.stats?.expiring_soon?.length) {
      container.innerHTML = '<p class="text-muted">No subscriptions expiring soon</p>';
      return;
    }

    const html = this.stats.expiring_soon.map(sub => {
      const expiresAt = new Date(sub.expires_at);
      const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
      
      return `
        <div class="d-flex justify-content-between align-items-center mb-2 p-2 border rounded">
          <div>
            <strong>@${sub.user_account}</strong>
            <br>
            <small class="text-muted">${sub.tier_name}</small>
          </div>
          <div class="text-end">
            <span class="badge ${daysLeft <= 1 ? 'bg-danger' : 'bg-warning'}">${daysLeft} days</span>
            <br>
            <small class="text-muted">${expiresAt.toLocaleDateString()}</small>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = html;
  }

  async loadRecentPayments() {
    try {
      const response = await fetch(`${this.baseUrl}/admin/subscriptions/stats`);
      const data = await response.json();
      
      if (response.ok) {
        this.renderPayments(data.stats.recent_payments || []);
      } else {
        this.showError('Failed to load payments: ' + data.error);
      }
    } catch (error) {
      console.error('Error loading payments:', error);
      this.showError('Error loading payments');
    }
  }

  renderPayments(payments) {
    const container = document.getElementById('payments-table');
    
    if (!payments.length) {
      container.innerHTML = '<p class="text-muted">No recent payments</p>';
      return;
    }

    const html = `
      <div class="table-responsive">
        <table class="table table-striped">
          <thead>
            <tr>
              <th>User</th>
              <th>Amount</th>
              <th>Tier</th>
              <th>Date</th>
              <th>Transaction</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${payments.map(payment => `
              <tr>
                <td>@${payment.from_account}</td>
                <td>${payment.amount} ${payment.currency}</td>
                <td>${payment.tier_name || 'Unknown'}</td>
                <td>${new Date(payment.created_at).toLocaleDateString()}</td>
                <td>
                  <small class="font-monospace">${payment.transaction_id.substring(0, 8)}...</small>
                </td>
                <td>
                  <span class="badge ${this.getStatusBadgeClass(payment.status)}">${payment.status}</span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.innerHTML = html;
  }

  async loadPromoCodes() {
    try {
      const response = await fetch(`${this.baseUrl}/admin/subscriptions/promo-codes`);
      const data = await response.json();
      
      if (response.ok) {
        this.renderPromoCodes(data.promo_codes || []);
      } else {
        this.showError('Failed to load promo codes: ' + data.error);
      }
    } catch (error) {
      console.error('Error loading promo codes:', error);
      this.showError('Error loading promo codes');
    }
  }

  renderPromoCodes(promoCodes) {
    const container = document.getElementById('promo-codes-list');
    
    if (!promoCodes.length) {
      container.innerHTML = '<p class="text-muted">No promo codes created</p>';
      return;
    }

    const html = `
      <div class="table-responsive">
        <table class="table table-striped">
          <thead>
            <tr>
              <th>Code</th>
              <th>Description</th>
              <th>Discount</th>
              <th>Usage</th>
              <th>Valid Until</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${promoCodes.map(promo => `
              <tr>
                <td><code>${promo.code}</code></td>
                <td>${promo.description || 'No description'}</td>
                <td>
                  ${promo.discount_type === 'percentage' ? 
                    `${promo.discount_value}%` : 
                    `${promo.discount_value} ${promo.discount_type.toUpperCase().replace('FIXED_', '')}`
                  }
                </td>
                <td>
                  ${promo.total_used}${promo.max_uses ? `/${promo.max_uses}` : ' (unlimited)'}
                </td>
                <td>
                  ${promo.valid_until ? new Date(promo.valid_until).toLocaleDateString() : 'No expiry'}
                </td>
                <td>
                  <span class="badge ${promo.is_active ? 'bg-success' : 'bg-secondary'}">
                    ${promo.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.innerHTML = html;
  }

  async loadTiers() {
    try {
      // Use admin endpoint to get all tiers including inactive ones
      const response = await fetch(`${this.baseUrl}/admin/subscriptions/tiers`);
      const data = await response.json();
      
      if (response.ok) {
        this.renderTiers(data.tiers || []);
      } else {
        this.showError('Failed to load tiers: ' + data.error);
      }
    } catch (error) {
      console.error('Error loading tiers:', error);
      this.showError('Error loading tiers');
    }
  }

  renderTiers(tiers) {
    const container = document.getElementById('tiers-list');
    
    const createNewTierForm = `
      <div class="card mb-4 border-primary">
        <div class="card-header bg-primary text-white">
          <h6 class="mb-0">Create New Subscription Tier</h6>
        </div>
        <div class="card-body">
          <form id="new-tier-form" class="row">
            <div class="col-md-6">
              <div class="mb-3">
                <label class="form-label">Tier Name</label>
                <input type="text" class="form-control" name="tier_name" placeholder="e.g., Basic (June 2025)" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Tier Code</label>
                <input type="text" class="form-control" name="tier_code" placeholder="e.g., basic-jun-2025" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Description</label>
                <textarea class="form-control" name="description" rows="3"></textarea>
              </div>
              <div class="row">
                <div class="col-6">
                  <div class="mb-3">
                    <label class="form-label">Monthly Price (USD)</label>
                    <input type="number" class="form-control" name="monthly_price_usd" step="0.01" min="0">
                  </div>
                </div>
                <div class="col-6">
                  <div class="mb-3">
                    <label class="form-label">Yearly Price (USD)</label>
                    <input type="number" class="form-control" name="yearly_price_usd" step="0.01" min="0">
                  </div>
                </div>
              </div>
            </div>
            <div class="col-md-6">
              <div class="row">
                <div class="col-6">
                  <div class="mb-3">
                    <label class="form-label">Max Presence Sessions</label>
                    <input type="number" class="form-control" name="max_presence_sessions" value="1" min="0">
                  </div>
                </div>
                <div class="col-6">
                  <div class="mb-3">
                    <label class="form-label">Max Collaboration Docs</label>
                    <input type="number" class="form-control" name="max_collaboration_docs" value="5" min="0">
                  </div>
                </div>
              </div>
              <div class="row">
                <div class="col-6">
                  <div class="mb-3">
                    <label class="form-label">Max Event Attendees</label>
                    <input type="number" class="form-control" name="max_event_attendees" value="10" min="0">
                  </div>
                </div>
                <div class="col-6">
                  <div class="mb-3">
                    <label class="form-label">Storage Limit (GB)</label>
                    <input type="number" class="form-control" name="storage_limit_gb" value="1" min="0">
                  </div>
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label">Bandwidth Limit (GB/month)</label>
                <input type="number" class="form-control" name="bandwidth_limit_gb" value="10" min="0">
              </div>
              <div class="row">
                <div class="col-4">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="priority_support">
                    <label class="form-check-label">Priority Support</label>
                  </div>
                </div>
                <div class="col-4">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="custom_branding">
                    <label class="form-check-label">Custom Branding</label>
                  </div>
                </div>
                <div class="col-4">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="api_access">
                    <label class="form-check-label">API Access</label>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-12 mt-3">
              <h6>Features</h6>
              <div class="row">
                <div class="col-3">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="feature_vr_spaces" checked>
                    <label class="form-check-label">VR Spaces</label>
                  </div>
                </div>
                <div class="col-3">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="feature_file_sharing">
                    <label class="form-check-label">File Sharing</label>
                  </div>
                </div>
                <div class="col-3">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="feature_screen_sharing">
                    <label class="form-check-label">Screen Sharing</label>
                  </div>
                </div>
                <div class="col-3">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="feature_recording">
                    <label class="form-check-label">Recording</label>
                  </div>
                </div>
                <div class="col-3">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="feature_custom_avatars">
                    <label class="form-check-label">Custom Avatars</label>
                  </div>
                </div>
                <div class="col-3">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="feature_custom_environments">
                    <label class="form-check-label">Custom Environments</label>
                  </div>
                </div>
                <div class="col-3">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="feature_live_streaming">
                    <label class="form-check-label">Live Streaming</label>
                  </div>
                </div>
                <div class="col-3">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" name="feature_api_integration">
                    <label class="form-check-label">API Integration</label>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-12 mt-3">
              <button type="submit" class="btn btn-primary">Create Tier</button>
              <button type="button" class="btn btn-success ms-2" onclick="subscriptionManager.updateTierPricing()">Update All Pricing</button>
            </div>
          </form>
        </div>
      </div>
    `;

    if (!tiers.length) {
      container.innerHTML = createNewTierForm + '<p class="text-muted">No subscription tiers found</p>';
      this.setupTierFormHandlers();
      return;
    }

    const tiersHtml = tiers.map(tier => `
      <div class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <div>
            <h6 class="mb-0">${tier.tier_name} (${tier.tier_code})</h6>
            <small class="text-muted">${tier.active_subscribers || 0} active subscribers</small>
          </div>
          <div>
            <span class="badge ${tier.is_active ? 'bg-success' : 'bg-secondary'} me-2">
              ${tier.is_active ? 'Active' : 'Inactive'}
            </span>
            <button class="btn btn-sm btn-outline-primary me-1" onclick="subscriptionManager.editTier(${tier.id})">
              Edit
            </button>
            <button class="btn btn-sm ${tier.is_active ? 'btn-outline-warning' : 'btn-outline-success'}" 
                    onclick="subscriptionManager.toggleTierStatus(${tier.id})">
              ${tier.is_active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </div>
        <div class="card-body">
          <div class="row">
            <div class="col-md-6">
              <p><strong>Description:</strong> ${tier.description || 'No description'}</p>
              <div class="row">
                <div class="col-6">
                  <p><strong>Monthly:</strong><br>
                    $${parseFloat(tier.monthly_price_usd || 0).toFixed(2)} USD<br>
                    <small class="text-muted">${parseFloat(tier.monthly_price_hive || 0).toFixed(3)} HIVE / ${parseFloat(tier.monthly_price_hbd || 0).toFixed(2)} HBD</small>
                  </p>
                </div>
                <div class="col-6">
                  <p><strong>Yearly:</strong><br>
                    $${parseFloat(tier.yearly_price_usd || 0).toFixed(2)} USD<br>
                    <small class="text-muted">${parseFloat(tier.yearly_price_hive || 0).toFixed(3)} HIVE / ${parseFloat(tier.yearly_price_hbd || 0).toFixed(2)} HBD</small>
                  </p>
                </div>
              </div>
            </div>
            <div class="col-md-6">
              <div class="row">
                <div class="col-6">
                  <p><strong>Max Sessions:</strong> ${tier.max_presence_sessions}</p>
                  <p><strong>Max Docs:</strong> ${tier.max_collaboration_docs}</p>
                </div>
                <div class="col-6">
                  <p><strong>Max Event Attendees:</strong> ${tier.max_event_attendees}</p>
                  <p><strong>Storage:</strong> ${tier.storage_limit_gb} GB</p>
                </div>
              </div>
              <div class="mt-2">
                <strong>Features:</strong>
                <div class="mt-1">
                  ${Object.entries(tier.features || {}).map(([key, value]) => 
                    `<span class="badge ${value ? 'bg-success' : 'bg-secondary'} me-1">${key.replace(/_/g, ' ')}</span>`
                  ).join('')}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    container.innerHTML = createNewTierForm + tiersHtml;
    this.setupTierFormHandlers();
  }

  setupTierFormHandlers() {
    const form = document.getElementById('new-tier-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.createTier(new FormData(form));
      });
    }
  }

  async createTier(formData) {
    try {
      const tierData = {
        tier_name: formData.get('tier_name'),
        tier_code: formData.get('tier_code'),
        description: formData.get('description'),
        monthly_price_usd: parseFloat(formData.get('monthly_price_usd')) || 0,
        yearly_price_usd: parseFloat(formData.get('yearly_price_usd')) || 0,
        max_presence_sessions: parseInt(formData.get('max_presence_sessions')) || 1,
        max_collaboration_docs: parseInt(formData.get('max_collaboration_docs')) || 5,
        max_event_attendees: parseInt(formData.get('max_event_attendees')) || 10,
        storage_limit_gb: parseInt(formData.get('storage_limit_gb')) || 1,
        bandwidth_limit_gb: parseInt(formData.get('bandwidth_limit_gb')) || 10,
        priority_support: formData.get('priority_support') === 'on',
        custom_branding: formData.get('custom_branding') === 'on',
        api_access: formData.get('api_access') === 'on',
        analytics_access: formData.get('analytics_access') === 'on',
        features: {
          vr_spaces: formData.get('feature_vr_spaces') === 'on',
          file_sharing: formData.get('feature_file_sharing') === 'on',
          screen_sharing: formData.get('feature_screen_sharing') === 'on',
          recording: formData.get('feature_recording') === 'on',
          custom_avatars: formData.get('feature_custom_avatars') === 'on',
          custom_environments: formData.get('feature_custom_environments') === 'on',
          live_streaming: formData.get('feature_live_streaming') === 'on',
          api_integration: formData.get('feature_api_integration') === 'on'
        }
      };

      const response = await fetch(`${this.baseUrl}/admin/subscriptions/tiers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tierData)
      });

      const data = await response.json();

      if (response.ok) {
        this.showSuccess('Tier created successfully!');
        document.getElementById('new-tier-form').reset();
        await this.loadTiers(); // Refresh the list
      } else {
        this.showError('Failed to create tier: ' + data.error);
      }
    } catch (error) {
      console.error('Error creating tier:', error);
      this.showError('Error creating tier');
    }
  }

  async toggleTierStatus(tierId) {
    try {
      const response = await fetch(`${this.baseUrl}/admin/subscriptions/tiers/${tierId}/toggle`, {
        method: 'POST'
      });

      const data = await response.json();

      if (response.ok) {
        this.showSuccess(`Tier ${data.tier.is_active ? 'activated' : 'deactivated'} successfully!`);
        await this.loadTiers(); // Refresh the list
      } else {
        this.showError('Failed to toggle tier status: ' + data.error);
      }
    } catch (error) {
      console.error('Error toggling tier status:', error);
      this.showError('Error toggling tier status');
    }
  }

  async updateTierPricing() {
    try {
      const response = await fetch(`${this.baseUrl}/admin/subscriptions/pricing/update`, {
        method: 'POST'
      });

      const data = await response.json();

      if (response.ok) {
        this.showSuccess(`Updated pricing for ${data.updated_tiers.length} tiers based on current HIVE price ($${data.current_prices.hive_usd.toFixed(3)})`);
        await this.loadTiers(); // Refresh the list
      } else {
        this.showError('Failed to update pricing: ' + data.error);
      }
    } catch (error) {
      console.error('Error updating pricing:', error);
      this.showError('Error updating pricing');
    }
  }

  editTier(tierId) {
    // For now, just show an alert. Could be enhanced with a modal form
    this.showSuccess(`Edit functionality for tier ${tierId} - to be implemented with modal form`);
  }

  async migrateUSDPricing() {
    try {
      const response = await fetch(`${this.baseUrl}/migrate-usd-pricing`, {
        method: 'POST'
      });

      const data = await response.json();

      if (response.ok && data.message.includes('added')) {
        console.log('USD pricing migration completed:', data.message);
      }
      // Don't show success/error for already existing columns
    } catch (error) {
      console.error('Error migrating USD pricing:', error);
      // Don't show error to user as this is background migration
    }
  }

  async loadMonitoringStatus() {
    try {
      const response = await fetch(`${this.baseUrl}/subscriptions/monitor/stats`);
      const data = await response.json();
      
      if (response.ok) {
        this.renderMonitoringStatus(data);
      } else {
        this.showError('Failed to load monitoring status: ' + data.error);
      }
    } catch (error) {
      console.error('Error loading monitoring status:', error);
      this.showError('Error loading monitoring status');
    }
  }

  renderMonitoringStatus(data) {
    const container = document.getElementById('monitoring-status');
    
    const html = `
      <div class="row">
        <div class="col-md-6">
          <div class="card">
            <div class="card-header">
              <h6>Monitor Status</h6>
            </div>
            <div class="card-body">
              <p><strong>Target Account:</strong> ${data.target_account}</p>
              <p><strong>Active Subscriptions:</strong> ${data.active_subscriptions}</p>
              <p><strong>Pending Payments:</strong> ${data.pending_payments}</p>
              <p><strong>Processing Queue:</strong> ${data.processing_queue_size} items</p>
              <p><strong>Last Updated:</strong> ${new Date(data.last_updated).toLocaleString()}</p>
            </div>
          </div>
        </div>
        <div class="col-md-6">
          <div class="card">
            <div class="card-header">
              <h6>Revenue Stats</h6>
            </div>
            <div class="card-body">
              <p><strong>Processed Today:</strong> ${data.processed_today} payments</p>
              <p><strong>Revenue (30 days):</strong> ${data.revenue_last_30_days.toFixed(2)} HBD</p>
              <div class="mt-3">
                <h6>Tier Distribution:</h6>
                ${data.tier_distribution.map(tier => `
                  <div class="d-flex justify-content-between">
                    <span>${tier.tier_code}:</span>
                    <span>${tier.count} users</span>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = html;
  }

  async createPromoCode() {
    try {
      const formData = {
        code: document.getElementById('promo-code').value,
        description: document.getElementById('promo-description').value,
        discount_type: document.getElementById('promo-discount-type').value,
        discount_value: parseFloat(document.getElementById('promo-discount-value').value),
        max_uses: document.getElementById('promo-max-uses').value ? 
                   parseInt(document.getElementById('promo-max-uses').value) : null,
        uses_per_user: parseInt(document.getElementById('promo-uses-per-user').value) || 1,
        valid_until: document.getElementById('promo-valid-until').value || null
      };

      const response = await fetch(`${this.baseUrl}/admin/subscriptions/promo-codes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(formData)
      });

      const data = await response.json();

      if (response.ok) {
        this.showSuccess('Promo code created successfully!');
        document.getElementById('promo-form').reset();
        this.loadPromoCodes(); // Refresh the list
      } else {
        this.showError('Failed to create promo code: ' + data.error);
      }
    } catch (error) {
      console.error('Error creating promo code:', error);
      this.showError('Error creating promo code');
    }
  }

  getStatusBadgeClass(status) {
    switch (status) {
      case 'processed': return 'bg-success';
      case 'pending': return 'bg-warning';
      case 'failed': return 'bg-danger';
      default: return 'bg-secondary';
    }
  }

  async refreshPayments() {
    await this.loadRecentPayments();
  }

  async refreshMonitoring() {
    await this.loadMonitoringStatus();
  }

  showError(message) {
    // You can implement a toast or alert system here
    console.error(message);
    alert('Error: ' + message);
  }

  showSuccess(message) {
    // You can implement a toast or alert system here
    console.log(message);
    alert('Success: ' + message);
  }

  // Payment notification methods
  async loadNotificationStats() {
    try {
      const response = await fetch(`${this.baseUrl}/admin/subscriptions/notifications/stats`);
      const data = await response.json();
      
      if (response.ok) {
        this.renderNotificationStats(data);
      } else {
        this.showError('Failed to load notification stats: ' + data.error);
      }
    } catch (error) {
      console.error('Error loading notification stats:', error);
      document.getElementById('notification-stats').innerHTML = `
        <div class="text-danger">
          <i class="fas fa-exclamation-triangle"></i>
          Error loading notification stats
        </div>
      `;
    }
  }

  renderNotificationStats(data) {
    const container = document.getElementById('notification-stats');
    
    if (!data.by_type || data.by_type.length === 0) {
      container.innerHTML = `
        <div class="text-muted">
          <i class="fas fa-bell-slash"></i>
          No notification data available
        </div>
      `;
      return;
    }

    const totalNotifications = data.by_type.reduce((sum, type) => sum + parseInt(type.total), 0);
    const unreadNotifications = data.by_type.reduce((sum, type) => sum + parseInt(type.unread), 0);
    
    const html = `
      <div class="row text-center mb-3">
        <div class="col-6">
          <h6 class="text-primary">${totalNotifications}</h6>
          <small class="text-muted">Total Sent</small>
        </div>
        <div class="col-6">
          <h6 class="text-warning">${unreadNotifications}</h6>
          <small class="text-muted">Unread</small>
        </div>
      </div>
      
      <div class="mb-3">
        <small class="text-muted">
          <i class="fas fa-users"></i>
          ${data.total_users_with_notifications} users with notifications
        </small>
      </div>
      
      <div class="notification-types">
        ${data.by_type.map(type => {
          const percentage = totalNotifications > 0 ? Math.round((type.total / totalNotifications) * 100) : 0;
          return `
            <div class="d-flex justify-content-between align-items-center mb-2">
              <div>
                <span class="badge bg-secondary">${this.formatNotificationType(type.type)}</span>
                <small class="text-muted ms-1">${type.unread}/${type.total}</small>
              </div>
              <div class="text-end">
                <div class="progress" style="width: 60px; height: 4px;">
                  <div class="progress-bar" style="width: ${percentage}%"></div>
                </div>
                <small class="text-muted">${percentage}%</small>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      
      <div class="text-muted mt-2">
        <small>
          <i class="fas fa-clock"></i>
          Last check: ${new Date(data.last_check).toLocaleString()}
        </small>
      </div>
    `;

    container.innerHTML = html;
  }

  formatNotificationType(type) {
    const typeMap = {
      'payment_due_soon': 'Due Soon',
      'payment_overdue': 'Overdue',
      'service_suspended': 'Suspended',
      'subscription_renewed': 'Renewed',
      'payment_failed': 'Failed'
    };
    return typeMap[type] || type;
  }

  async runNotificationChecks() {
    try {
      const button = document.querySelector('[onclick="subscriptionManager.runNotificationChecks()"]');
      const originalText = button.innerHTML;
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running...';
      button.disabled = true;

      const response = await fetch(`${this.baseUrl}/admin/subscriptions/notifications/run-checks`, {
        method: 'POST'
      });
      
      const data = await response.json();
      
      if (response.ok) {
        this.showSuccess('Notification checks completed successfully');
        // Refresh the stats
        await this.loadNotificationStats();
      } else {
        this.showError('Failed to run notification checks: ' + data.error);
      }
      
      button.innerHTML = originalText;
      button.disabled = false;
      
    } catch (error) {
      console.error('Error running notification checks:', error);
      this.showError('Error running notification checks');
      
      const button = document.querySelector('[onclick="subscriptionManager.runNotificationChecks()"]');
      button.innerHTML = 'Run Checks';
      button.disabled = false;
    }
  }
}

// Global instance
window.subscriptionManager = new SubscriptionManager(); 