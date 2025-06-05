// Admin Users Component
window.DLUX_COMPONENTS['admin-users-view'] = {
    props: ['apiClient'],
    emits: ['loading'],
    
    template: `
        <div class="admin-users-view">
            <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                <h1 class="h2">Admin Users Management</h1>
                <div class="btn-toolbar mb-2 mb-md-0">
                    <button class="btn btn-success me-2" @click="showAddUserModal" :disabled="loading">
                        <i class="bi bi-person-plus"></i>
                        Add Admin
                    </button>
                    <button class="btn btn-outline-primary" @click="refreshData" :disabled="loading">
                        <i class="bi bi-arrow-clockwise"></i>
                        Refresh
                    </button>
                </div>
            </div>

            <!-- Admin Users Table -->
            <div class="card">
                <div class="card-header">
                    <h5>Current Admin Users</h5>
                </div>
                <div class="card-body">
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th>Username</th>
                                    <th>Permissions</th>
                                    <th>Added By</th>
                                    <th>Added Date</th>
                                    <th>Last Login</th>
                                    <th>Status</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="admin in data.admins" :key="admin.username">
                                    <td>
                                        <div class="d-flex align-items-center">
                                            <div class="me-2">
                                                <i class="bi bi-person-circle fs-4"></i>
                                            </div>
                                            <div>
                                                <strong>@{{ admin.username }}</strong>
                                                <span v-if="admin.permissions?.super" class="badge bg-danger ms-2">SUPER</span>
                                            </div>
                                        </div>
                                    </td>
                                    <td>
                                        <div class="d-flex flex-wrap gap-1">
                                            <span v-if="admin.permissions?.admin" class="badge bg-primary">Admin</span>
                                            <span v-if="admin.permissions?.super" class="badge bg-danger">Super Admin</span>
                                            <span v-for="(value, key) in admin.permissions" 
                                                  v-if="key !== 'admin' && key !== 'super' && value"
                                                  :key="key" 
                                                  class="badge bg-info">
                                                {{ key }}
                                            </span>
                                        </div>
                                    </td>
                                    <td>
                                        <span v-if="admin.added_by === 'system'" class="badge bg-secondary">System</span>
                                        <span v-else>@{{ admin.added_by }}</span>
                                    </td>
                                    <td>{{ formatDate(admin.added_at) }}</td>
                                    <td>
                                        <span v-if="admin.last_login">
                                            {{ formatDate(admin.last_login) }}
                                        </span>
                                        <span v-else class="text-muted">Never</span>
                                    </td>
                                    <td>
                                        <span class="badge" :class="admin.active ? 'bg-success' : 'bg-secondary'">
                                            {{ admin.active ? 'Active' : 'Inactive' }}
                                        </span>
                                    </td>
                                    <td>
                                        <div class="btn-group btn-group-sm">
                                            <button class="btn btn-outline-info" 
                                                    @click="viewAdminDetails(admin)"
                                                    title="View Details">
                                                <i class="bi bi-eye"></i>
                                            </button>
                                            <button v-if="canRemoveAdmin(admin)" 
                                                    class="btn btn-outline-danger"
                                                    @click="confirmRemoveAdmin(admin)"
                                                    title="Remove Admin">
                                                <i class="bi bi-person-dash"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <div v-if="!data.admins || data.admins.length === 0" 
                             class="text-center text-muted py-4">
                            No admin users found
                        </div>
                    </div>
                </div>
            </div>

            <!-- Add Admin Modal -->
            <div class="modal fade" id="addAdminModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Add New Admin User</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <form @submit.prevent="addAdmin">
                            <div class="modal-body">
                                <div class="mb-3">
                                    <label for="newAdminUsername" class="form-label">Hive Username</label>
                                    <input type="text" 
                                           class="form-control" 
                                           id="newAdminUsername"
                                           v-model="newAdmin.username"
                                           placeholder="Enter Hive username (without @)"
                                           pattern="[a-z0-9.-]{3,16}"
                                           required>
                                    <div class="form-text">
                                        Must be a valid Hive username (3-16 characters, lowercase letters, numbers, dots, and hyphens only)
                                    </div>
                                </div>
                                
                                <div class="mb-3">
                                    <label class="form-label">Permissions</label>
                                    <div class="form-check">
                                        <input class="form-check-input" 
                                               type="checkbox" 
                                               id="adminPermission"
                                               v-model="newAdmin.permissions.admin">
                                        <label class="form-check-label" for="adminPermission">
                                            Standard Admin Access
                                        </label>
                                    </div>
                                    <div class="form-check">
                                        <input class="form-check-input" 
                                               type="checkbox" 
                                               id="superPermission"
                                               v-model="newAdmin.permissions.super">
                                        <label class="form-check-label" for="superPermission">
                                            Super Admin (Can manage other admins)
                                        </label>
                                    </div>
                                </div>

                                <div class="alert alert-warning">
                                    <i class="bi bi-exclamation-triangle"></i>
                                    <strong>Warning:</strong> The user must exist on the Hive blockchain. 
                                    Only grant admin access to trusted users.
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                                <button type="submit" class="btn btn-success" :disabled="addingAdmin">
                                    <span v-if="addingAdmin">
                                        <i class="bi bi-hourglass-split"></i>
                                        Adding...
                                    </span>
                                    <span v-else>
                                        <i class="bi bi-person-plus"></i>
                                        Add Admin
                                    </span>
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>

            <!-- Admin Details Modal -->
            <div class="modal fade" id="adminDetailsModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Admin User Details</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedAdmin">
                            <div class="row">
                                <div class="col-md-6">
                                    <h6>Basic Information</h6>
                                    <table class="table table-sm">
                                        <tr>
                                            <td><strong>Username:</strong></td>
                                            <td>@{{ selectedAdmin.username }}</td>
                                        </tr>
                                        <tr>
                                            <td><strong>Status:</strong></td>
                                            <td>
                                                <span class="badge" :class="selectedAdmin.active ? 'bg-success' : 'bg-secondary'">
                                                    {{ selectedAdmin.active ? 'Active' : 'Inactive' }}
                                                </span>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td><strong>Added By:</strong></td>
                                            <td>
                                                <span v-if="selectedAdmin.added_by === 'system'" class="badge bg-secondary">System</span>
                                                <span v-else>@{{ selectedAdmin.added_by }}</span>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td><strong>Added Date:</strong></td>
                                            <td>{{ formatDate(selectedAdmin.added_at) }}</td>
                                        </tr>
                                        <tr>
                                            <td><strong>Last Login:</strong></td>
                                            <td>
                                                <span v-if="selectedAdmin.last_login">
                                                    {{ formatDate(selectedAdmin.last_login) }}
                                                </span>
                                                <span v-else class="text-muted">Never</span>
                                            </td>
                                        </tr>
                                    </table>
                                </div>
                                <div class="col-md-6">
                                    <h6>Permissions</h6>
                                    <div class="d-flex flex-wrap gap-2">
                                        <span v-if="selectedAdmin.permissions?.admin" class="badge bg-primary">Admin Access</span>
                                        <span v-if="selectedAdmin.permissions?.super" class="badge bg-danger">Super Admin</span>
                                        <span v-for="(value, key) in selectedAdmin.permissions" 
                                              v-if="key !== 'admin' && key !== 'super' && value"
                                              :key="key" 
                                              class="badge bg-info">
                                            {{ key }}
                                        </span>
                                    </div>
                                    
                                    <h6 class="mt-4">Permissions Details</h6>
                                    <ul class="list-unstyled">
                                        <li><i class="bi bi-check-circle text-success"></i> View admin dashboard</li>
                                        <li><i class="bi bi-check-circle text-success"></i> Monitor system status</li>
                                        <li><i class="bi bi-check-circle text-success"></i> View payment channels</li>
                                        <li><i class="bi bi-check-circle text-success"></i> Manage ACT tokens</li>
                                        <li v-if="selectedAdmin.permissions?.super">
                                            <i class="bi bi-check-circle text-success"></i> Manage other admins
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                            <button v-if="canRemoveAdmin(selectedAdmin)" 
                                    type="button" 
                                    class="btn btn-danger"
                                    @click="confirmRemoveAdmin(selectedAdmin)">
                                Remove Admin
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Remove Admin Confirmation Modal -->
            <div class="modal fade" id="removeAdminModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Confirm Admin Removal</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="adminToRemove">
                            <div class="alert alert-danger">
                                <i class="bi bi-exclamation-triangle"></i>
                                <strong>Warning:</strong> You are about to remove admin privileges from 
                                <strong>@{{ adminToRemove.username }}</strong>.
                            </div>
                            <p>This action will:</p>
                            <ul>
                                <li>Revoke all admin access for this user</li>
                                <li>Prevent them from accessing the admin dashboard</li>
                                <li>Log them out if they are currently logged in</li>
                            </ul>
                            <p><strong>This action cannot be undone easily.</strong></p>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" 
                                    class="btn btn-danger" 
                                    @click="removeAdmin"
                                    :disabled="removingAdmin">
                                <span v-if="removingAdmin">
                                    <i class="bi bi-hourglass-split"></i>
                                    Removing...
                                </span>
                                <span v-else>
                                    <i class="bi bi-person-dash"></i>
                                    Remove Admin
                                </span>
                            </button>
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
                admins: [],
                requestedBy: null
            },
            newAdmin: {
                username: '',
                permissions: {
                    admin: true,
                    super: false
                }
            },
            selectedAdmin: null,
            adminToRemove: null,
            addingAdmin: false,
            removingAdmin: false,
            alert: {
                message: '',
                type: 'info',
                icon: ''
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
                const response = await this.apiClient.get('/api/onboarding/admin/users');
                
                if (response.success) {
                    this.data = {
                        admins: response.data?.admins || response.admins || [],
                        requestedBy: response.data?.requestedBy || response.requestedBy
                    };
                } else {
                    this.showAlert('Failed to load admin users', 'danger', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error loading admin users:', error);
                this.showAlert('Error loading admin users: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.loading = false;
                this.$emit('loading', false);
            }
        },

        async refreshData() {
            await this.loadData();
        },

        showAddUserModal() {
            this.newAdmin = {
                username: '',
                permissions: {
                    admin: true,
                    super: false
                }
            };
            const modal = new bootstrap.Modal(document.getElementById('addAdminModal'));
            modal.show();
        },

        async addAdmin() {
            if (!this.newAdmin.username.trim()) {
                this.showAlert('Please enter a username', 'warning', 'bi-exclamation-triangle');
                return;
            }

            this.addingAdmin = true;
            
            try {
                const response = await this.apiClient.post('/api/onboarding/admin/users/add', {
                    username: this.newAdmin.username.toLowerCase().replace('@', ''),
                    permissions: this.newAdmin.permissions
                });
                
                if (response.success) {
                    this.showAlert(response.message, 'success', 'bi-check-circle');
                    
                    // Close modal
                    const modal = bootstrap.Modal.getInstance(document.getElementById('addAdminModal'));
                    modal.hide();
                    
                    // Refresh data
                    await this.loadData();
                } else {
                    this.showAlert('Failed to add admin: ' + response.error, 'danger', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error adding admin:', error);
                this.showAlert('Error adding admin: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.addingAdmin = false;
            }
        },

        viewAdminDetails(admin) {
            this.selectedAdmin = admin;
            const modal = new bootstrap.Modal(document.getElementById('adminDetailsModal'));
            modal.show();
        },

        confirmRemoveAdmin(admin) {
            this.adminToRemove = admin;
            
            // Close details modal if open
            const detailsModal = bootstrap.Modal.getInstance(document.getElementById('adminDetailsModal'));
            if (detailsModal) {
                detailsModal.hide();
            }
            
            // Show confirmation modal
            const confirmModal = new bootstrap.Modal(document.getElementById('removeAdminModal'));
            confirmModal.show();
        },

        async removeAdmin() {
            if (!this.adminToRemove) return;

            this.removingAdmin = true;
            
            try {
                const response = await this.apiClient.post(`/api/onboarding/admin/users/${this.adminToRemove.username}/remove`);
                
                if (response.success) {
                    this.showAlert(response.message, 'success', 'bi-check-circle');
                    
                    // Close modal
                    const modal = bootstrap.Modal.getInstance(document.getElementById('removeAdminModal'));
                    modal.hide();
                    
                    // Refresh data
                    await this.loadData();
                } else {
                    this.showAlert('Failed to remove admin: ' + response.error, 'danger', 'bi-exclamation-triangle');
                }
            } catch (error) {
                console.error('Error removing admin:', error);
                this.showAlert('Error removing admin: ' + error.message, 'danger', 'bi-exclamation-triangle');
            } finally {
                this.removingAdmin = false;
                this.adminToRemove = null;
            }
        },

        canRemoveAdmin(admin) {
            // Can't remove yourself, and only super admins can remove other admins
            if (!admin || !admin.username || !this.data.requestedBy) {
                return false;
            }
            return admin.username !== this.data.requestedBy && 
                   this.currentUserIsSuperAdmin();
        },

        currentUserIsSuperAdmin() {
            if (!this.data.admins || !this.data.requestedBy) {
                return false;
            }
            const currentUser = this.data.admins.find(admin => admin && admin.username === this.data.requestedBy);
            return currentUser && currentUser.permissions && currentUser.permissions.super;
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