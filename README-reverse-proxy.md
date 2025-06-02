# Reverse Proxy Configuration for DLUX API Server

This guide explains how to set up reverse proxies for the DLUX API server that handles both HTTP API requests and WebSocket connections for payment monitoring.

## Server Configuration

Your DLUX API server runs on a configurable port (default: likely 3000 or 8080) and provides:
- HTTP API endpoints at various paths
- WebSocket server at `/ws/payment-monitor`

## Caddy Configuration

Caddy is the easiest option with automatic HTTPS via Let's Encrypt.

### Basic Caddy Configuration (`Caddyfile`)

```caddy
# Replace your-domain.com with your actual domain
your-domain.com {
    # Enable automatic HTTPS
    
    # Handle WebSocket connections - CRITICAL FIX for Code 1006
    @websockets {
        header Connection *Upgrade*
        header Upgrade websocket
        path /ws/*
    }
    reverse_proxy @websockets localhost:3000 {
        # WebSocket specific headers
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
        # Preserve origin header for WebSocket CORS validation
        header_up Origin {http.request.header.Origin}
        
        # CRITICAL: Disable buffering to prevent frame corruption
        flush_interval -1
        # Ensure proper WebSocket handling
        transport http {
            # Disable response buffering for WebSocket
            response_buffer_size 0
        }
    }
    
    # Handle all other HTTP requests
    reverse_proxy localhost:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
    }
    
    # Optional: Add security headers
    header {
        # Enable HSTS
        Strict-Transport-Security max-age=31536000;
        # Prevent MIME sniffing
        X-Content-Type-Options nosniff
        # Enable XSS protection
        X-Frame-Options DENY
        # Referrer policy
        Referrer-Policy strict-origin-when-cross-origin
    }
    
    # Optional: Enable compression
    encode gzip
    
    # Optional: Rate limiting (requires caddy-rate-limit plugin)
    # rate_limit {
    #     zone dynamic_rate_limit {
    #         key {remote}
    #         events 100
    #         window 1m
    #     }
    # }
}

# Optional: Redirect www to non-www
www.your-domain.com {
    redir https://your-domain.com{uri} permanent
}
```

### Advanced Caddy Configuration with Path-Based Routing

```caddy
your-domain.com {
    # WebSocket endpoint
    @websockets path /ws/*
    reverse_proxy @websockets localhost:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
        # Preserve origin header for WebSocket CORS validation
        header_up Origin {http.request.header.Origin}
    }
    
    # API endpoints
    @api path /api/*
    reverse_proxy @api localhost:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
    }
    
    # Static file serving (if you have a frontend)
    @static path /static/* /images/* /css/* /js/*
    reverse_proxy @static localhost:3000
    
    # Catch-all for other routes
    reverse_proxy localhost:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
    }
    
    # CORS handling for API
    @cors_preflight method OPTIONS
    respond @cors_preflight 200 {
        header Access-Control-Allow-Origin "*"
        header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS"
        header Access-Control-Allow-Headers "Content-Type, Authorization"
        header Access-Control-Max-Age "86400"
    }
    
    encode gzip
}
```

### Running Caddy

```bash
# Install Caddy (Ubuntu/Debian)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Place your Caddyfile in /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl start caddy
sudo systemctl status caddy
```

## Nginx Configuration

### Basic Nginx Configuration

Create `/etc/nginx/sites-available/dlux-api`:

```nginx
# Upstream for the DLUX API server
upstream dlux_api {
    server 127.0.0.1:3000;
    # Add more servers for load balancing if needed
    # server 127.0.0.1:3001;
}

# Rate limiting zones
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=ws_limit:10m rate=20r/s;

# WebSocket connection upgrade map
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name your-domain.com www.your-domain.com;
    
    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    # SSL Configuration (replace with your certificates)
    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;
    
    # Modern SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # WebSocket endpoint
    location /ws/ {
        # Rate limiting for WebSocket connections
        limit_req zone=ws_limit burst=5 nodelay;
        
        proxy_pass http://dlux_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Preserve origin header for WebSocket CORS validation
        proxy_set_header Origin $http_origin;
        
        # WebSocket specific timeouts
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
        
        # Critical for WebSocket stability - fixes code 1006 issues
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header X-Accel-Buffering no;
        
        # WebSocket frame size limits (adjust as needed)
        client_max_body_size 64k;
        proxy_max_temp_file_size 0;
        
        # Ensure proper connection handling
        proxy_redirect off;
        proxy_set_header Connection "upgrade";
    }
    
    # API endpoints
    location /api/ {
        # Rate limiting for API endpoints
        limit_req zone=api_limit burst=20 nodelay;
        
        proxy_pass http://dlux_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # CORS headers for API
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
        
        # Handle preflight requests
        if ($request_method = 'OPTIONS') {
            add_header Access-Control-Allow-Origin "*";
            add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS";
            add_header Access-Control-Allow-Headers "Content-Type, Authorization";
            add_header Access-Control-Max-Age 86400;
            add_header Content-Length 0;
            add_header Content-Type text/plain;
            return 204;
        }
        
        # Timeouts
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }
    
    # All other routes
    location / {
        proxy_pass http://dlux_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Standard timeouts
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }
    
    # Compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/javascript application/xml+rss application/json;
    
    # Logging
    access_log /var/log/nginx/dlux-api.access.log;
    error_log /var/log/nginx/dlux-api.error.log;
}

# Redirect www to non-www
server {
    listen 443 ssl http2;
    server_name www.your-domain.com;
    
    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;
    
    return 301 https://your-domain.com$request_uri;
}
```

### Setting up Nginx

```bash
# Install Nginx
sudo apt update
sudo apt install nginx

# Create the configuration
sudo nano /etc/nginx/sites-available/dlux-api

# Enable the site
sudo ln -s /etc/nginx/sites-available/dlux-api /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

## SSL Certificate Setup

### Using Let's Encrypt with Certbot

For both Caddy and Nginx, you can use Let's Encrypt for free SSL certificates:

```bash
# For Nginx
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# For Caddy (automatic with Caddyfile)
# Caddy handles Let's Encrypt automatically
```

## Testing Your Setup

### Test HTTP API
```bash
curl -H "Origin: https://your-domain.com" https://your-domain.com/api/onboarding/pricing
```

### Test WebSocket Connection
```javascript
// In browser console
const ws = new WebSocket('wss://your-domain.com/ws/payment-monitor');
ws.onopen = () => console.log('WebSocket connected');
ws.onmessage = (event) => console.log('Message:', event.data);
ws.send(JSON.stringify({ type: 'ping' }));
```

## Monitoring and Logs

### Caddy Logs
```bash
sudo journalctl -u caddy -f
```

### Nginx Logs
```bash
sudo tail -f /var/log/nginx/dlux-api.access.log
sudo tail -f /var/log/nginx/dlux-api.error.log
```

## Troubleshooting

### **URGENT: Code 1006 (Abnormal Closure) After Welcome Message**

If you see logs like:
```
Welcome message sent successfully
WebSocket connection closed [ID: xxx] - Code: 1006, Reason: 
Close code meaning: Abnormal Closure (no close frame received)
```

**This is a reverse proxy WebSocket frame corruption issue.** Apply these fixes:

#### For Caddy:
```caddy
@websockets path /ws/*
reverse_proxy @websockets localhost:3000 {
    # CRITICAL FIXES for Code 1006
    flush_interval -1
    transport http {
        response_buffer_size 0
    }
    header_up Origin {http.request.header.Origin}
}
```

#### For Nginx:
```nginx
location /ws/ {
    proxy_pass http://dlux_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    
    # CRITICAL FIXES for Code 1006
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header X-Accel-Buffering no;
    proxy_max_temp_file_size 0;
    
    # Essential WebSocket headers
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
}
```

#### Quick Test:
1. Apply the reverse proxy fixes above
2. Restart your reverse proxy
3. Test WebSocket connection - should stay open without immediate closure

### **Standard Troubleshooting**

1. **WebSocket connection fails**: Check that the upgrade headers are properly set
2. **CORS issues**: Verify the CORS headers in your reverse proxy configuration
3. **Timeouts**: Adjust timeout values for long-running WebSocket connections
4. **Rate limiting**: Monitor logs for rate limit hits and adjust as needed

## Security Considerations

1. **Rate Limiting**: Implement appropriate rate limits for both API and WebSocket endpoints
2. **SSL/TLS**: Always use HTTPS in production
3. **Headers**: Include security headers like HSTS, X-Frame-Options, etc.
4. **Firewall**: Only expose ports 80 and 443 to the internet
5. **Updates**: Keep your reverse proxy software updated

## Load Balancing (Optional)

If you need to scale your API server:

### Caddy Load Balancing
```caddy
your-domain.com {
    reverse_proxy {
        to localhost:3000
        to localhost:3001
        to localhost:3002
        health_uri /health
        health_interval 30s
    }
}
```

### Nginx Load Balancing
```nginx
upstream dlux_api {
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
    
    # Health checks (nginx plus only)
    # health_check interval=30s fails=3 passes=2;
}
```

This configuration ensures both your HTTP API and WebSocket connections are properly proxied with appropriate headers, security measures, and performance optimizations. 