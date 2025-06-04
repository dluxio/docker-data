# DLUX Admin Dashboard

A Vue.js-based static admin dashboard for managing the DLUX onboarding service. Features Hive Keychain authentication and comprehensive analytics.

## Features

### 🔐 Authentication
- **Hive Keychain Integration**: Secure login using your Hive account
- **Admin-Only Access**: Only authorized admin users can access the dashboard
- **Session Management**: Automatic session handling with 24-hour expiration

### 📊 Dashboard Overview
- **Real-time Statistics**: ACT balance, RC available, pending accounts, active channels
- **Interactive Charts**: Account creation trends and payment method distribution
- **Recent Activity**: Live feed of recent account creations

### 💰 ACT (Account Creation Token) Management
- **Real-time Monitoring**: Current ACT balance and resource credits
- **Historical Charts**: ACT usage trends over time
- **Quick Actions**: Claim ACT, process pending accounts, run health checks
- **Detailed Statistics**: Weekly performance metrics

### ⚡ Resource Credit (RC) Monitoring
- **Cost Analysis**: Current RC costs for all Hive operations
- **Trend Analysis**: Historical cost changes with direction indicators
- **Efficiency Metrics**: Cost comparison between different account creation methods
- **Interactive Charts**: Visual representation of RC cost trends

### 🔗 Blockchain Monitoring
- **Multi-Network Support**: Bitcoin, Ethereum, BNB, Polygon, Solana
- **Payment Detection**: Real-time monitoring of incoming payments
- **Network Status**: Health monitoring for all supported networks
- **Explorer Integration**: Direct links to blockchain explorers

### 💳 Payment Channel Management
- **Advanced Filtering**: Filter by status, crypto type, and date range
- **Processing Analytics**: Processing time distribution and efficiency metrics
- **Detailed Views**: Comprehensive channel information with transaction links
- **Pagination**: Efficient browsing of large datasets

### 👥 Admin User Management
- **User Administration**: Add/remove admin users
- **Permission Management**: Standard admin vs super admin permissions
- **Activity Tracking**: Last login timestamps and user status
- **Security Features**: Self-protection (can't remove yourself)

## Setup Instructions

### 1. File Structure
Place all files in your web server directory:
```
admin/
├── index.html
├── js/
│   ├── app.js
│   └── components/
│       ├── act-status.js
│       ├── rc-costs.js
│       ├── blockchain-status.js
│       ├── payment-channels.js
│       └── admin-users.js
└── README.md
```

### 2. Web Server Configuration
- Serve the `admin/` directory via HTTP/HTTPS
- Ensure the backend API is accessible from the same domain
- No build process required - runs directly in the browser

### 3. Backend Requirements
Your API must have the following endpoints:
- `GET /api/onboarding/auth/challenge` - Get authentication challenge
- `GET /api/onboarding/auth/whoami` - Verify authentication
- `GET /api/onboarding/admin/*` - Various admin endpoints

### 4. Admin User Setup
1. Use the API directly to add your first admin user:
```bash
# This is typically done automatically when the system starts
# The username from config.username becomes the first super admin
```

2. Or use the database directly:
```sql
INSERT INTO admin_users (username, permissions, added_by)
VALUES ('your-hive-username', '{"admin": true, "super": true}', 'system');
```

## Usage

### 1. Login Process
1. Open the admin dashboard in your browser
2. Enter your Hive username
3. Click "Sign with Keychain"
4. Approve the signature request in Hive Keychain
5. You'll be automatically logged in if you have admin privileges

### 2. Navigation
- **Dashboard**: Overview and key metrics
- **ACT Status**: Account Creation Token management
- **RC Costs**: Resource Credit monitoring
- **Blockchain**: Network monitoring and payment detection
- **Payment Channels**: Transaction management
- **Admin Users**: User administration (super admins only)

### 3. Key Features

#### Dashboard
- View real-time system status
- Monitor recent account creations
- Track payment method distribution
- Quick access to all admin functions

#### ACT Management
- Monitor current ACT balance and RC levels
- Manually claim ACT tokens when needed
- Process pending account creations
- Run system health checks

#### RC Monitoring
- Track resource credit costs for all operations
- Analyze cost trends and efficiency
- Compare different account creation methods
- Monitor cost changes over time

#### Blockchain Monitoring
- View status of all supported networks
- Monitor recent payment detections
- Access blockchain explorer links
- Track payment confirmation status

#### Payment Channels
- Filter and search payment channels
- View detailed transaction information
- Monitor processing times
- Track payment completion rates

#### Admin Management
- Add new admin users (super admins only)
- View admin activity and permissions
- Remove admin access when needed
- Track login history

## Security Considerations

### Authentication
- Uses cryptographic signatures for authentication
- No passwords stored - relies on Hive Keychain security
- Session tokens have 24-hour expiration
- Admin privileges verified on each request

### Access Control
- Only verified admin users can access the dashboard
- Super admin permissions required for user management
- Self-protection prevents accidental lockout
- All admin actions are logged

### Data Protection
- All API calls use HTTPS in production
- Sensitive data is not logged in browser console
- Session data stored securely in localStorage
- Authentication headers properly secured

## Troubleshooting

### Common Issues

#### "Hive Keychain not found"
- Install the Hive Keychain browser extension
- Ensure it's enabled and unlocked
- Refresh the page and try again

#### "Admin privileges required"
- Verify your Hive username is in the admin_users table
- Check that your admin status is active
- Contact existing super admin to add you

#### "Authentication failed"
- Check that your system clock is accurate
- Ensure Keychain is unlocked and functioning
- Try refreshing and logging in again

#### API Errors
- Verify the backend service is running
- Check browser console for network errors
- Ensure CORS is properly configured
- Verify API endpoints are accessible

### Browser Requirements
- Modern browser with ES6+ support
- JavaScript enabled
- LocalStorage available
- Fetch API support

### Performance Tips
- Charts may lag with large datasets
- Use date filters to limit data loads
- Refresh periodically for latest data
- Close unused browser tabs to free memory

## Development

### Technology Stack
- **Frontend**: Vue.js 3, Bootstrap 5, Chart.js
- **Authentication**: Hive Keychain integration
- **Charts**: Chart.js with responsive design
- **Styling**: Bootstrap 5 with custom CSS variables

### Customization
- Edit CSS variables in `index.html` for theming
- Modify component templates for layout changes
- Add new endpoints by extending the API client
- Create new components following the existing pattern

### Contributing
1. Test thoroughly with real admin credentials
2. Ensure responsive design on all screen sizes
3. Validate error handling for all scenarios
4. Document any new features or changes

## License

This admin dashboard is part of the DLUX project. Please refer to the main project license for usage terms. 