// Posts Management Component
window.DLUX_COMPONENTS['posts-view'] = {
    props: ['apiClient'],
    emits: ['loading'],
    
    template: `
        <div class="posts-view">
            <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                <h1 class="h2">Posts Management</h1>
                <div class="btn-toolbar mb-2 mb-md-0">
                    <div class="btn-group me-2">
                        <button class="btn btn-outline-primary" @click="refreshData" :disabled="loading">
                            <i class="bi bi-arrow-clockwise"></i>
                            Refresh
                        </button>
                        <button class="btn btn-outline-success" @click="showAddPostModal">
                            <i class="bi bi-plus-circle"></i>
                            Add Post
                        </button>
                    </div>
                </div>
            </div>

            <!-- Search and Filters -->
            <div class="row mb-4">
                <div class="col-md-4">
                    <div class="input-group">
                        <span class="input-group-text"><i class="bi bi-search"></i></span>
                        <input type="text" 
                               class="form-control" 
                               placeholder="Search by author, permlink, or type..." 
                               v-model="searchTerm"
                               @input="debounceSearch">
                    </div>
                </div>
                <div class="col-md-2">
                    <select class="form-select" v-model="filters.type" @change="refreshData">
                        <option value="">All Types</option>
                        <option value="VR">VR</option>
                        <option value="AR">AR</option>
                        <option value="XR">XR</option>
                        <option value="APP">APP</option>
                        <option value="360">360</option>
                        <option value="3D">3D</option>
                        <option value="Audio">Audio</option>
                        <option value="Video">Video</option>
                    </select>
                </div>
                <div class="col-md-2">
                    <select class="form-select" v-model="filters.contentFilter" @change="refreshData">
                        <option value="">All Content</option>
                        <option value="nsfw">NSFW Only</option>
                        <option value="hidden">Hidden Only</option>
                        <option value="featured">Featured Only</option>
                        <option value="flagged">Flagged Only</option>
                        <option value="clean">Clean Content</option>
                    </select>
                </div>
                <div class="col-md-2">
                    <select class="form-select" v-model="filters.limit" @change="refreshData">
                        <option value="25">25 per page</option>
                        <option value="50">50 per page</option>
                        <option value="100">100 per page</option>
                        <option value="200">200 per page</option>
                    </select>
                </div>
                <div class="col-md-2">
                    <button class="btn btn-outline-secondary w-100" @click="showFlagsLegend">
                        <i class="bi bi-info-circle"></i> Flag Info
                    </button>
                </div>
            </div>

            <!-- Stats Cards -->
            <div class="row mb-4">
                <div class="col-md-3">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Total Posts</h6>
                                    <h3>{{ stats.total || 0 }}</h3>
                                </div>
                                <i class="bi bi-collection fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Authors</h6>
                                    <h3>{{ stats.authors || 0 }}</h3>
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
                                    <h6 class="card-title">Types</h6>
                                    <h3>{{ stats.types || 0 }}</h3>
                                </div>
                                <i class="bi bi-tags fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card">
                        <div class="card-body">
                            <div class="d-flex justify-content-between">
                                <div>
                                    <h6 class="card-title">Recent (24h)</h6>
                                    <h3>{{ stats.recent || 0 }}</h3>
                                </div>
                                <i class="bi bi-clock-history fs-1 opacity-50"></i>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Posts Table -->
            <div class="card">
                <div class="card-header d-flex justify-content-between align-items-center">
                    <h5>Posts ({{ data.posts.length }} of {{ data.totalCount }})</h5>
                    <div class="d-flex align-items-center">
                        <span class="me-3" v-if="searchTerm">
                            <i class="bi bi-search text-muted"></i>
                            Searching: "{{ searchTerm }}"
                        </span>
                        <span v-if="filters.type" class="badge bg-primary me-2">
                            Type: {{ filters.type }}
                        </span>
                    </div>
                </div>
                <div class="card-body">
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th>Author</th>
                                    <th>Permlink</th>
                                    <th>Type</th>
                                    <th>Flags</th>
                                    <th>Block</th>
                                    <th>Votes</th>
                                    <th>Vote Weight</th>
                                    <th>Promote</th>
                                    <th>Paid</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="post in data.posts" :key="getPostKey(post)">
                                    <td>
                                        <strong>@{{ post.author }}</strong>
                                    </td>
                                    <td>
                                        <code>{{ post.permlink }}</code>
                                        <a :href="post.url" target="_blank" class="btn btn-sm btn-outline-info ms-1" title="View on DLUX">
                                            <i class="bi bi-box-arrow-up-right"></i>
                                        </a>
                                    </td>
                                    <td>
                                        <span class="badge" :class="getTypeClass(post.type)">{{ post.type }}</span>
                                    </td>
                                    <td>
                                        <div class="d-flex flex-wrap gap-1">
                                            <span v-if="post.nsfw" class="badge bg-danger" title="NSFW Content">NSFW</span>
                                            <span v-if="post.sensitive" class="badge bg-warning text-dark" title="Sensitive Content">SENS</span>
                                            <span v-if="post.hidden" class="badge bg-secondary" title="Hidden Content">HIDDEN</span>
                                            <span v-if="post.featured" class="badge bg-success" title="Featured Content">FEAT</span>
                                            <span v-if="post.flagged" class="badge bg-danger" title="Flagged Content">FLAG</span>
                                            <span v-if="!post.nsfw && !post.sensitive && !post.hidden && !post.featured && !post.flagged" 
                                                  class="badge bg-light text-dark" title="Clean Content">CLEAN</span>
                                        </div>
                                    </td>
                                    <td>{{ post.block || 'N/A' }}</td>
                                    <td>{{ post.votes || 0 }}</td>
                                    <td>{{ formatNumber(post.voteweight || 0) }}</td>
                                    <td>{{ formatNumber(post.promote || 0) }}</td>
                                    <td>
                                        <span class="badge" :class="post.paid ? 'bg-success' : 'bg-warning text-dark'">
                                            {{ post.paid ? 'Yes' : 'No' }}
                                        </span>
                                    </td>
                                    <td>
                                        <div class="btn-group btn-group-sm">
                                            <button class="btn btn-outline-info" 
                                                    @click="viewPostDetails(post)"
                                                    title="View Details">
                                                <i class="bi bi-eye"></i>
                                            </button>
                                            <button class="btn btn-outline-secondary" 
                                                    @click="showFlagsModal(post)"
                                                    title="Manage Flags">
                                                <i class="bi bi-flag"></i>
                                            </button>
                                            <button class="btn btn-outline-warning" 
                                                    @click="editPost(post)"
                                                    title="Edit Post">
                                                <i class="bi bi-pencil"></i>
                                            </button>
                                            <button class="btn btn-outline-danger" 
                                                    @click="deletePost(post)"
                                                    title="Delete Post">
                                                <i class="bi bi-trash"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <div v-if="!data.posts || data.posts.length === 0" 
                             class="text-center text-muted py-4">
                            <i class="bi bi-inbox fs-1 d-block mb-2"></i>
                            No posts found{{ searchTerm ? ' for your search' : '' }}
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

            <!-- Add/Edit Post Modal -->
            <div class="modal fade" id="postModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">{{ editingPost ? 'Edit Post' : 'Add Post' }}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <form @submit.prevent="savePost">
                                <div class="mb-3">
                                    <label class="form-label">Author *</label>
                                    <input type="text" class="form-control" v-model="postForm.author" required>
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">Permlink *</label>
                                    <input type="text" class="form-control" v-model="postForm.permlink" required>
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">Type *</label>
                                    <select class="form-select" v-model="postForm.type" required>
                                        <option value="">Select Type</option>
                                        <option value="VR">VR</option>
                                        <option value="AR">AR</option>
                                        <option value="XR">XR</option>
                                        <option value="APP">APP</option>
                                        <option value="360">360</option>
                                        <option value="3D">3D</option>
                                        <option value="Audio">Audio</option>
                                        <option value="Video">Video</option>
                                    </select>
                                </div>
                                <div class="row">
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Block</label>
                                            <input type="number" class="form-control" v-model="postForm.block">
                                        </div>
                                    </div>
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Votes</label>
                                            <input type="number" class="form-control" v-model="postForm.votes">
                                        </div>
                                    </div>
                                </div>
                                <div class="row">
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Vote Weight</label>
                                            <input type="number" step="0.01" class="form-control" v-model="postForm.voteweight">
                                        </div>
                                    </div>
                                    <div class="col-md-6">
                                        <div class="mb-3">
                                            <label class="form-label">Promote</label>
                                            <input type="number" step="0.01" class="form-control" v-model="postForm.promote">
                                        </div>
                                    </div>
                                </div>
                                <div class="mb-3">
                                    <div class="form-check">
                                        <input class="form-check-input" type="checkbox" v-model="postForm.paid" id="paidCheck">
                                        <label class="form-check-label" for="paidCheck">
                                            Post is paid
                                        </label>
                                    </div>
                                </div>
                                
                                <!-- Content Flags Section -->
                                <div class="mb-3">
                                    <label class="form-label"><strong>Content Flags</strong></label>
                                    <div class="row">
                                        <div class="col-md-6">
                                            <div class="form-check">
                                                <input class="form-check-input" type="checkbox" v-model="postForm.nsfw" id="nsfwCheck">
                                                <label class="form-check-label" for="nsfwCheck">
                                                    <span class="badge bg-danger me-1">NSFW</span> Not Safe For Work
                                                </label>
                                            </div>
                                            <div class="form-check">
                                                <input class="form-check-input" type="checkbox" v-model="postForm.sensitive" id="sensitiveCheck">
                                                <label class="form-check-label" for="sensitiveCheck">
                                                    <span class="badge bg-warning text-dark me-1">SENS</span> Sensitive Content
                                                </label>
                                            </div>
                                            <div class="form-check">
                                                <input class="form-check-input" type="checkbox" v-model="postForm.hidden" id="hiddenCheck">
                                                <label class="form-check-label" for="hiddenCheck">
                                                    <span class="badge bg-secondary me-1">HIDDEN</span> Hidden from public
                                                </label>
                                            </div>
                                        </div>
                                        <div class="col-md-6">
                                            <div class="form-check">
                                                <input class="form-check-input" type="checkbox" v-model="postForm.featured" id="featuredCheck">
                                                <label class="form-check-label" for="featuredCheck">
                                                    <span class="badge bg-success me-1">FEAT</span> Featured Content
                                                </label>
                                            </div>
                                            <div class="form-check">
                                                <input class="form-check-input" type="checkbox" v-model="postForm.flagged" id="flaggedCheck">
                                                <label class="form-check-label" for="flaggedCheck">
                                                    <span class="badge bg-danger me-1">FLAG</span> Flagged Content
                                                </label>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="mb-3" v-if="postForm.flagged">
                                    <label class="form-label">Flag Reason</label>
                                    <textarea class="form-control" v-model="postForm.flag_reason" 
                                              placeholder="Explain why this content is flagged..." rows="2"></textarea>
                                </div>
                                
                                <div class="mb-3" v-if="anyFlagSet">
                                    <label class="form-label">Moderated By</label>
                                    <input type="text" class="form-control" v-model="postForm.moderated_by" 
                                           placeholder="Enter moderator username">
                                    <div class="form-text">Required when setting any content flags</div>
                                </div>
                            </form>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" class="btn btn-primary" @click="savePost" :disabled="!isFormValid">
                                {{ editingPost ? 'Update' : 'Create' }} Post
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Post Details Modal -->
            <div class="modal fade" id="postDetailsModal" tabindex="-1">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Post Details</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedPost">
                            <div class="row">
                                <div class="col-md-6">
                                    <table class="table table-sm">
                                        <tbody>
                                            <tr>
                                                <td><strong>Author:</strong></td>
                                                <td>@{{ selectedPost.author }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Permlink:</strong></td>
                                                <td><code>{{ selectedPost.permlink }}</code></td>
                                            </tr>
                                            <tr>
                                                <td><strong>Type:</strong></td>
                                                <td><span class="badge" :class="getTypeClass(selectedPost.type)">{{ selectedPost.type }}</span></td>
                                            </tr>
                                            <tr>
                                                <td><strong>Block:</strong></td>
                                                <td>{{ selectedPost.block || 'N/A' }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>URL:</strong></td>
                                                <td><a :href="selectedPost.url" target="_blank">{{ selectedPost.url }}</a></td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                                <div class="col-md-6">
                                    <table class="table table-sm">
                                        <tbody>
                                            <tr>
                                                <td><strong>Votes:</strong></td>
                                                <td>{{ selectedPost.votes || 0 }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Vote Weight:</strong></td>
                                                <td>{{ formatNumber(selectedPost.voteweight || 0) }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Promote:</strong></td>
                                                <td>{{ formatNumber(selectedPost.promote || 0) }}</td>
                                            </tr>
                                            <tr>
                                                <td><strong>Paid:</strong></td>
                                                <td>
                                                    <span class="badge" :class="selectedPost.paid ? 'bg-success' : 'bg-warning text-dark'">
                                                        {{ selectedPost.paid ? 'Yes' : 'No' }}
                                                    </span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td><strong>Content Flags:</strong></td>
                                                <td>
                                                    <div class="d-flex flex-wrap gap-1">
                                                        <span v-if="selectedPost.nsfw" class="badge bg-danger">NSFW</span>
                                                        <span v-if="selectedPost.sensitive" class="badge bg-warning text-dark">Sensitive</span>
                                                        <span v-if="selectedPost.hidden" class="badge bg-secondary">Hidden</span>
                                                        <span v-if="selectedPost.featured" class="badge bg-success">Featured</span>
                                                        <span v-if="selectedPost.flagged" class="badge bg-danger">Flagged</span>
                                                        <span v-if="!selectedPost.nsfw && !selectedPost.sensitive && !selectedPost.hidden && !selectedPost.featured && !selectedPost.flagged" 
                                                              class="badge bg-light text-dark">Clean</span>
                                                    </div>
                                                </td>
                                            </tr>
                                            <tr v-if="selectedPost.flagged && selectedPost.flag_reason">
                                                <td><strong>Flag Reason:</strong></td>
                                                <td>{{ selectedPost.flag_reason }}</td>
                                            </tr>
                                            <tr v-if="selectedPost.moderated_by">
                                                <td><strong>Moderated By:</strong></td>
                                                <td>@{{ selectedPost.moderated_by }}</td>
                                            </tr>
                                            <tr v-if="selectedPost.moderated_at">
                                                <td><strong>Moderated At:</strong></td>
                                                <td>{{ formatDate(selectedPost.moderated_at) }}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Flag Management Modal -->
            <div class="modal fade" id="flagsModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Manage Content Flags</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" v-if="selectedPost">
                            <div class="mb-3">
                                <h6>Post: @{{ selectedPost.author }}/{{ selectedPost.permlink }}</h6>
                                <p class="text-muted small">Use these flags to control content visibility and categorization</p>
                            </div>
                            
                            <form @submit.prevent="saveFlags">
                                <div class="row">
                                    <div class="col-md-6">
                                        <div class="form-check mb-2">
                                            <input class="form-check-input" type="checkbox" v-model="flagForm.nsfw" id="flagNsfwCheck">
                                            <label class="form-check-label" for="flagNsfwCheck">
                                                <span class="badge bg-danger me-1">NSFW</span> Not Safe For Work
                                            </label>
                                        </div>
                                        <div class="form-check mb-2">
                                            <input class="form-check-input" type="checkbox" v-model="flagForm.sensitive" id="flagSensitiveCheck">
                                            <label class="form-check-label" for="flagSensitiveCheck">
                                                <span class="badge bg-warning text-dark me-1">SENS</span> Sensitive Content
                                            </label>
                                        </div>
                                        <div class="form-check mb-2">
                                            <input class="form-check-input" type="checkbox" v-model="flagForm.hidden" id="flagHiddenCheck">
                                            <label class="form-check-label" for="flagHiddenCheck">
                                                <span class="badge bg-secondary me-1">HIDDEN</span> Hidden from public
                                            </label>
                                        </div>
                                    </div>
                                    <div class="col-md-6">
                                        <div class="form-check mb-2">
                                            <input class="form-check-input" type="checkbox" v-model="flagForm.featured" id="flagFeaturedCheck">
                                            <label class="form-check-label" for="flagFeaturedCheck">
                                                <span class="badge bg-success me-1">FEAT</span> Featured Content
                                            </label>
                                        </div>
                                        <div class="form-check mb-2">
                                            <input class="form-check-input" type="checkbox" v-model="flagForm.flagged" id="flagFlaggedCheck">
                                            <label class="form-check-label" for="flagFlaggedCheck">
                                                <span class="badge bg-danger me-1">FLAG</span> Flagged Content
                                            </label>
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="mb-3" v-if="flagForm.flagged">
                                    <label class="form-label">Flag Reason</label>
                                    <textarea class="form-control" v-model="flagForm.flag_reason" 
                                              placeholder="Explain why this content is flagged..." rows="3"></textarea>
                                </div>
                                
                                <div class="mb-3">
                                    <label class="form-label">Moderated By <span class="text-danger">*</span></label>
                                    <input type="text" class="form-control" v-model="flagForm.moderated_by" 
                                           placeholder="Enter your username" required>
                                    <div class="form-text">Required for flag operations</div>
                                </div>
                            </form>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" class="btn btn-primary" @click="saveFlags" :disabled="!flagForm.moderated_by">
                                Update Flags
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Flags Legend Modal -->
            <div class="modal fade" id="flagsLegendModal" tabindex="-1">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Content Flags Information</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <div class="row">
                                <div class="col-12">
                                    <table class="table table-sm">
                                        <thead>
                                            <tr>
                                                <th>Flag</th>
                                                <th>Description</th>
                                                <th>Effect</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr>
                                                <td><span class="badge bg-danger">NSFW</span></td>
                                                <td>Not Safe For Work</td>
                                                <td>Content requires age verification or warnings</td>
                                            </tr>
                                            <tr>
                                                <td><span class="badge bg-warning text-dark">SENS</span></td>
                                                <td>Sensitive Content</td>
                                                <td>May contain sensitive themes or material</td>
                                            </tr>
                                            <tr>
                                                <td><span class="badge bg-secondary">HIDDEN</span></td>
                                                <td>Hidden Content</td>
                                                <td>Not visible in public listings</td>
                                            </tr>
                                            <tr>
                                                <td><span class="badge bg-success">FEAT</span></td>
                                                <td>Featured Content</td>
                                                <td>Highlighted in featured sections</td>
                                            </tr>
                                            <tr>
                                                <td><span class="badge bg-danger">FLAG</span></td>
                                                <td>Flagged Content</td>
                                                <td>Reported content requiring review</td>
                                            </tr>
                                            <tr>
                                                <td><span class="badge bg-light text-dark">CLEAN</span></td>
                                                <td>Clean Content</td>
                                                <td>No flags set, suitable for all audiences</td>
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
    `,
    
    data() {
        return {
            loading: false,
            searchTerm: '',
            searchTimeout: null,
            data: {
                posts: [],
                totalCount: 0
            },
            stats: {
                total: 0,
                authors: 0,
                types: 0,
                recent: 0
            },
            filters: {
                type: '',
                contentFilter: '',
                limit: 100,
                offset: 0
            },
            selectedPost: null,
            editingPost: false,
            postForm: {
                author: '',
                permlink: '',
                type: '',
                block: null,
                votes: 0,
                voteweight: 0,
                promote: 0,
                paid: false,
                nsfw: false,
                sensitive: false,
                hidden: false,
                featured: false,
                flagged: false,
                flag_reason: '',
                moderated_by: ''
            },
            flagForm: {
                nsfw: false,
                sensitive: false,
                hidden: false,
                featured: false,
                flagged: false,
                flag_reason: '',
                moderated_by: ''
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
        },
        
        isFormValid() {
            return this.postForm.author && this.postForm.permlink && this.postForm.type;
        },
        
        anyFlagSet() {
            return this.postForm.nsfw || this.postForm.sensitive || this.postForm.hidden || 
                   this.postForm.featured || this.postForm.flagged;
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
                
                if (this.filters.type) {
                    params.append('type', this.filters.type);
                }
                if (this.searchTerm) {
                    params.append('search', this.searchTerm);
                }
                
                // Handle content filters
                if (this.filters.contentFilter) {
                    switch (this.filters.contentFilter) {
                        case 'nsfw':
                            params.append('nsfw', 'true');
                            break;
                        case 'hidden':
                            params.append('hidden', 'true');
                            break;
                        case 'featured':
                            params.append('featured', 'true');
                            break;
                        case 'flagged':
                            params.append('flagged', 'true');
                            break;
                        case 'clean':
                            params.append('nsfw', 'false');
                            params.append('sensitive', 'false');
                            params.append('hidden', 'false');
                            params.append('flagged', 'false');
                            break;
                    }
                }
                
                const response = await fetch(`${this.apiClient.baseURL}/api/posts?${params}`, {
                    headers: this.apiClient.headers
                });
                
                if (response.ok) {
                    const result = await response.json();
                    this.data = {
                        posts: result.posts || [],
                        totalCount: result.totalCount || 0
                    };
                } else {
                    console.error('Failed to load posts:', response.statusText);
                    this.showAlert('Failed to load posts', 'danger');
                }
            } catch (error) {
                console.error('Error loading posts:', error);
                this.showAlert('Error loading posts: ' + error.message, 'danger');
            } finally {
                this.loading = false;
                this.$emit('loading', false);
            }
        },
        
        async loadStats() {
            try {
                const response = await fetch(`${this.apiClient.baseURL}/api/posts/stats`, {
                    headers: this.apiClient.headers
                });
                
                if (response.ok) {
                    const result = await response.json();
                    this.stats = result.stats || {};
                }
            } catch (error) {
                console.error('Error loading stats:', error);
            }
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
        
        showAddPostModal() {
            this.editingPost = false;
            this.postForm = {
                author: '',
                permlink: '',
                type: '',
                block: null,
                votes: 0,
                voteweight: 0,
                promote: 0,
                paid: false,
                nsfw: false,
                sensitive: false,
                hidden: false,
                featured: false,
                flagged: false,
                flag_reason: '',
                moderated_by: ''
            };
            const modal = new bootstrap.Modal(document.getElementById('postModal'));
            modal.show();
        },
        
        editPost(post) {
            this.editingPost = true;
            this.postForm = {
                originalAuthor: post.author,
                originalPermlink: post.permlink,
                author: post.author,
                permlink: post.permlink,
                type: post.type,
                block: post.block,
                votes: post.votes || 0,
                voteweight: post.voteweight || 0,
                promote: post.promote || 0,
                paid: post.paid || false,
                nsfw: post.nsfw || false,
                sensitive: post.sensitive || false,
                hidden: post.hidden || false,
                featured: post.featured || false,
                flagged: post.flagged || false,
                flag_reason: post.flag_reason || '',
                moderated_by: post.moderated_by || ''
            };
            const modal = new bootstrap.Modal(document.getElementById('postModal'));
            modal.show();
        },
        
        async savePost() {
            if (!this.isFormValid) return;
            
            try {
                const url = this.editingPost 
                    ? `${this.apiClient.baseURL}/api/posts/${this.postForm.originalAuthor}/${this.postForm.originalPermlink}`
                    : `${this.apiClient.baseURL}/api/posts`;
                
                const method = this.editingPost ? 'PUT' : 'POST';
                
                const response = await fetch(url, {
                    method,
                    headers: {
                        ...this.apiClient.headers,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        author: this.postForm.author,
                        permlink: this.postForm.permlink,
                        type: this.postForm.type,
                        block: this.postForm.block,
                        votes: this.postForm.votes,
                        voteweight: this.postForm.voteweight,
                        promote: this.postForm.promote,
                        paid: this.postForm.paid,
                        nsfw: this.postForm.nsfw,
                        sensitive: this.postForm.sensitive,
                        hidden: this.postForm.hidden,
                        featured: this.postForm.featured,
                        flagged: this.postForm.flagged,
                        flag_reason: this.postForm.flag_reason,
                        moderated_by: this.postForm.moderated_by
                    })
                });
                
                if (response.ok) {
                    this.showAlert(`Post ${this.editingPost ? 'updated' : 'created'} successfully`, 'success');
                    bootstrap.Modal.getInstance(document.getElementById('postModal')).hide();
                    await this.refreshData();
                } else {
                    const error = await response.json();
                    this.showAlert(error.message || 'Failed to save post', 'danger');
                }
            } catch (error) {
                console.error('Error saving post:', error);
                this.showAlert('Error saving post: ' + error.message, 'danger');
            }
        },
        
        async deletePost(post) {
            if (!confirm(`Are you sure you want to delete post by @${post.author}/${post.permlink}?`)) {
                return;
            }
            
            try {
                const response = await fetch(`${this.apiClient.baseURL}/api/posts/${post.author}/${post.permlink}`, {
                    method: 'DELETE',
                    headers: this.apiClient.headers
                });
                
                if (response.ok) {
                    this.showAlert('Post deleted successfully', 'success');
                    await this.refreshData();
                } else {
                    const error = await response.json();
                    this.showAlert(error.message || 'Failed to delete post', 'danger');
                }
            } catch (error) {
                console.error('Error deleting post:', error);
                this.showAlert('Error deleting post: ' + error.message, 'danger');
            }
        },
        
        viewPostDetails(post) {
            this.selectedPost = post;
            const modal = new bootstrap.Modal(document.getElementById('postDetailsModal'));
            modal.show();
        },
        
        getPostKey(post) {
            return `${post.author}-${post.permlink}`;
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
        
        showFlagsModal(post) {
            this.selectedPost = post;
            this.flagForm = {
                nsfw: post.nsfw || false,
                sensitive: post.sensitive || false,
                hidden: post.hidden || false,
                featured: post.featured || false,
                flagged: post.flagged || false,
                flag_reason: post.flag_reason || '',
                moderated_by: ''
            };
            const modal = new bootstrap.Modal(document.getElementById('flagsModal'));
            modal.show();
        },
        
        showFlagsLegend() {
            const modal = new bootstrap.Modal(document.getElementById('flagsLegendModal'));
            modal.show();
        },
        
        async saveFlags() {
            if (!this.flagForm.moderated_by || !this.selectedPost) return;
            
            try {
                const response = await fetch(`${this.apiClient.baseURL}/api/posts/${this.selectedPost.author}/${this.selectedPost.permlink}/flags`, {
                    method: 'PATCH',
                    headers: {
                        ...this.apiClient.headers,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(this.flagForm)
                });
                
                if (response.ok) {
                    this.showAlert('Post flags updated successfully', 'success');
                    bootstrap.Modal.getInstance(document.getElementById('flagsModal')).hide();
                    await this.refreshData();
                } else {
                    const error = await response.json();
                    this.showAlert(error.error || 'Failed to update flags', 'danger');
                }
            } catch (error) {
                console.error('Error updating flags:', error);
                this.showAlert('Error updating flags: ' + error.message, 'danger');
            }
        },
        
        showAlert(message, type = 'info') {
            console.log(`Alert [${type}]: ${message}`);
            // This can be enhanced to show actual UI alerts
        }
    }
}; 