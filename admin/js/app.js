const { createApp } = Vue;

// API Client for handling authenticated requests
class ApiClient {
    constructor() {
        this.baseURL = window.location.origin;
        this.headers = {};
        this.authData = null;
    }

    setAuth(authData) {
        this.authData = authData;
        this.headers = {
            'Content-Type': 'application/json',
            'x-account': authData.account,
            'x-challenge': authData.challenge,
            'x-pubkey': authData.pubKey,
            'x-signature': authData.signature
        };
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const config = {
            ...options,
            headers: {
                ...this.headers,
                ...options.headers
            }
        };

        try {
            const response = await fetch(url, config);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }

            return data;
        } catch (error) {
            console.error('API Request failed:', error);
            throw error;
        }
    }

    async get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    }

    async post(endpoint, data = {}) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async put(endpoint, data = {}) {
        return this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    }
}

// Main Vue Application
const app = createApp({
    data() {
        return {
            // Authentication state
            isAuthenticated: false,
            isLoggingIn: false,
            currentUser: null,
            loginError: null,
            loginForm: {
                username: ''
            },

            // App state
            currentView: 'dashboard',
            loading: false,
            apiClient: new ApiClient(),

            // Dashboard data
            dashboardData: {
                actBalance: 0,
                rcAvailable: 0,
                pendingAccounts: 0,
                activeChannels: 0,
                recentAccounts: []
            },

            // Charts
            charts: {
                accountCreations: null,
                paymentMethods: null
            }
        };
    },

    async mounted() {
        // Check for existing authentication
        const savedAuth = localStorage.getItem('dlux_admin_auth');
        if (savedAuth) {
            try {
                const authData = JSON.parse(savedAuth);
                // Verify the auth is still valid (not expired)
                const now = Math.floor(Date.now() / 1000);
                if (authData.challenge && (now - authData.challenge) < (24 * 60 * 60)) {
                    this.apiClient.setAuth(authData);
                    this.currentUser = authData.account;
                    this.isAuthenticated = true;
                    await this.loadDashboard();
                } else {
                    localStorage.removeItem('dlux_admin_auth');
                }
            } catch (error) {
                console.error('Failed to restore authentication:', error);
                localStorage.removeItem('dlux_admin_auth');
            }
        }
    },

    methods: {
        async login() {
            if (!this.loginForm.username) {
                this.loginError = 'Please enter your Hive username';
                return;
            }

            this.isLoggingIn = true;
            this.loginError = null;

            try {
                // Check if Hive Keychain is available
                if (!window.hive_keychain) {
                    throw new Error('Hive Keychain not found. Please install the Hive Keychain browser extension.');
                }

                // Get challenge from server
                const challengeResponse = await fetch(`${window.location.origin}/api/auth/challenge`);
                const challengeData = await challengeResponse.json();

                if (!challengeData.success) {
                    throw new Error(challengeData.error || 'Failed to get challenge');
                }

                const challenge = challengeData.challenge.toString();

                // Request signature from Keychain
                return new Promise((resolve, reject) => {
                    window.hive_keychain.requestSignBuffer(
                        this.loginForm.username,
                        challenge,
                        'Active', // Key type
                        (response) => {
                            if (response.success) {
                                this.handleKeychainSuccess(response, challenge);
                                resolve();
                            } else {
                                reject(new Error(response.message || 'Keychain signature failed'));
                            }
                        }
                    );
                });

            } catch (error) {
                console.error('Login error:', error);
                this.loginError = error.message;
            } finally {
                this.isLoggingIn = false;
            }
        },

        async handleKeychainSuccess(keychainResponse, challenge) {
            try {
                const authData = {
                    account: this.loginForm.username,
                    challenge: parseInt(challenge),
                    pubKey: keychainResponse.publicKey,
                    signature: keychainResponse.result
                };

                // Test the authentication by making a whoami request
                this.apiClient.setAuth(authData);
                const whoamiResponse = await this.apiClient.get('/api/auth/whoami');

                if (whoamiResponse.success && whoamiResponse.isAdmin) {
                    // Save authentication data
                    localStorage.setItem('dlux_admin_auth', JSON.stringify(authData));
                    
                    this.currentUser = authData.account;
                    this.isAuthenticated = true;
                    this.loginForm.username = '';
                    
                    // Load dashboard data
                    await this.loadDashboard();
                } else {
                    throw new Error('Admin privileges required');
                }

            } catch (error) {
                console.error('Authentication failed:', error);
                this.loginError = error.message;
            }
        },

        logout() {
            localStorage.removeItem('dlux_admin_auth');
            this.isAuthenticated = false;
            this.currentUser = null;
            this.apiClient.headers = {};
            this.dashboardData = {
                actBalance: 0,
                rcAvailable: 0,
                pendingAccounts: 0,
                activeChannels: 0,
                recentAccounts: []
            };
            this.currentView = 'dashboard';
        },

        setView(view) {
            this.currentView = view;
            if (view === 'dashboard') {
                this.$nextTick(() => {
                    this.loadDashboard();
                });
            }
        },

        setLoading(isLoading) {
            this.loading = isLoading;
        },

        async loadDashboard() {
            this.loading = true;
            try {
                // Load multiple data sources in parallel
                const [actStatusData, channelsData] = await Promise.all([
                    this.apiClient.get('/api/admin/act-status'),
                    this.apiClient.get('/api/admin/channels?limit=10')
                ]);

                // Process ACT status data
                if (actStatusData.success) {
                    this.dashboardData.actBalance = actStatusData.status.actBalance || 0;
                    this.dashboardData.rcAvailable = actStatusData.status.resourceCredits || 0;
                    this.dashboardData.recentAccounts = actStatusData.recentCreations || [];
                    
                    // Count pending accounts
                    this.dashboardData.pendingAccounts = actStatusData.recentCreations
                        ? actStatusData.recentCreations.filter(acc => acc.status === 'pending').length
                        : 0;
                }

                // Process channels data
                if (channelsData.success) {
                    this.dashboardData.activeChannels = channelsData.summary
                        ? channelsData.summary.filter(s => s.status === 'pending' || s.status === 'confirmed').length
                        : 0;
                }

                // Create charts
                await this.$nextTick();
                this.createCharts();

            } catch (error) {
                console.error('Failed to load dashboard:', error);
            } finally {
                this.loading = false;
            }
        },

        async refreshDashboard() {
            await this.loadDashboard();
        },

        createCharts() {
            this.createAccountCreationsChart();
            this.createPaymentMethodsChart();
        },

        createAccountCreationsChart() {
            const ctx = document.getElementById('accountCreationsChart');
            if (!ctx) return;

            // Destroy existing chart
            if (this.charts.accountCreations) {
                this.charts.accountCreations.destroy();
            }

            // Process data for last 7 days
            const last7Days = [];
            const today = new Date();
            for (let i = 6; i >= 0; i--) {
                const date = new Date(today);
                date.setDate(date.getDate() - i);
                last7Days.push(date.toLocaleDateString());
            }

            // Count accounts per day
            const accountsPerDay = last7Days.map(day => {
                return this.dashboardData.recentAccounts.filter(acc => {
                    const accDate = new Date(acc.created_at).toLocaleDateString();
                    return accDate === day;
                }).length;
            });

            this.charts.accountCreations = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: last7Days,
                    datasets: [{
                        label: 'Accounts Created',
                        data: accountsPerDay,
                        borderColor: 'rgb(227, 19, 55)',
                        backgroundColor: 'rgba(227, 19, 55, 0.1)',
                        tension: 0.1,
                        fill: true
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

        createPaymentMethodsChart() {
            const ctx = document.getElementById('paymentMethodsChart');
            if (!ctx) return;

            // Destroy existing chart
            if (this.charts.paymentMethods) {
                this.charts.paymentMethods.destroy();
            }

            // Count payment methods
            const methodCounts = {};
            this.dashboardData.recentAccounts.forEach(acc => {
                const method = acc.creation_method || 'Unknown';
                methodCounts[method] = (methodCounts[method] || 0) + 1;
            });

            const labels = Object.keys(methodCounts);
            const data = Object.values(methodCounts);
            const colors = [
                '#e31337', '#28a745', '#ffc107', '#17a2b8', 
                '#6f42c1', '#fd7e14', '#20c997', '#6c757d'
            ];

            this.charts.paymentMethods = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: colors.slice(0, labels.length),
                        borderWidth: 2,
                        borderColor: '#fff'
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

        // Utility methods
        formatNumber(num) {
            if (!num) return '0';
            if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
            if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
            if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
            return num.toLocaleString();
        },

        formatDate(dateString) {
            if (!dateString) return 'N/A';
            return new Date(dateString).toLocaleString();
        },

        getStatusClass(status) {
            switch (status?.toLowerCase()) {
                case 'completed':
                case 'success':
                    return 'bg-success';
                case 'pending':
                case 'processing':
                    return 'bg-warning';
                case 'failed':
                case 'error':
                    return 'bg-danger';
                case 'confirmed':
                    return 'bg-info';
                default:
                    return 'bg-secondary';
            }
        }
    }
});

// This will be populated by component files
window.DLUX_COMPONENTS = {};

// Mount the app after all components are loaded
window.mountDLUXApp = function() {
    // Register all components
    Object.keys(window.DLUX_COMPONENTS).forEach(name => {
        app.component(name, window.DLUX_COMPONENTS[name]);
    });
    
    // Mount the app
    app.mount('#app');
}; 