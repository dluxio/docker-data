CREATE TABLE posts (
    author varchar(16) NOT NULL,
    permlink varchar(255) NOT NULL,
    block int,
    votes int,
    voteweight int,
    promote int,
    paid int,
    payout int,
    payout_author varchar(16),
    linear_weight int,
    voters text,
    voters_paid text,
    type varchar(16),
    rating int,
    ratings int,
    raters varchar(255),
    nsfw boolean DEFAULT false,
    sensitive boolean DEFAULT false,
    hidden boolean DEFAULT false,
    featured boolean DEFAULT false,
    flagged boolean DEFAULT false,
    flag_reason varchar(255),
    moderated_by varchar(16),
    moderated_at timestamp,
    PRIMARY KEY (author, permlink)
);

-- User flag reports table
CREATE TABLE flag_reports (
    id SERIAL PRIMARY KEY,
    post_author varchar(16) NOT NULL,
    post_permlink varchar(255) NOT NULL,
    reporter_account varchar(16) NOT NULL,
    flag_type varchar(20) NOT NULL,
    reason text,
    status varchar(20) DEFAULT 'pending',
    reviewed_by varchar(16),
    reviewed_at timestamp,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_flag_reports_post FOREIGN KEY (post_author, post_permlink) REFERENCES posts(author, permlink) ON DELETE CASCADE
);

-- User flag statistics and permissions
CREATE TABLE flag_user_stats (
    account varchar(16) PRIMARY KEY,
    flags_submitted integer DEFAULT 0,
    flags_accepted integer DEFAULT 0,
    flags_rejected integer DEFAULT 0,
    can_flag boolean DEFAULT true,
    banned_until timestamp,
    ban_reason varchar(255),
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_flag_reports_status ON flag_reports(status);
CREATE INDEX idx_flag_reports_reporter ON flag_reports(reporter_account);
CREATE INDEX idx_flag_reports_post ON flag_reports(post_author, post_permlink);
CREATE INDEX idx_flag_reports_created ON flag_reports(created_at);

CREATE TABLE statssi (
    string varchar(255) NOT NULL,
    int integer
);

-- Script security tables
CREATE TABLE script_whitelist (
    script_hash varchar(64) PRIMARY KEY,
    script_name varchar(255) NOT NULL,
    script_content text NOT NULL,
    approved_by varchar(16) NOT NULL,
    approved_at timestamp DEFAULT CURRENT_TIMESTAMP,
    risk_level varchar(20) DEFAULT 'medium', -- low, medium, high
    description text,
    version varchar(50),
    tags text[], -- array of tags for categorization
    is_active boolean DEFAULT true,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE script_reviews (
    id SERIAL PRIMARY KEY,
    script_hash varchar(64) NOT NULL,
    script_name varchar(255),
    script_content text NOT NULL,
    request_source varchar(255), -- where the script execution was attempted
    requested_by varchar(16), -- user who triggered the execution
    request_context jsonb, -- context data (uid, opt, etc.)
    status varchar(20) DEFAULT 'pending', -- pending, approved, rejected, blocked
    reviewed_by varchar(16),
    reviewed_at timestamp,
    review_notes text,
    risk_assessment varchar(20), -- low, medium, high, critical
    auto_flagged boolean DEFAULT false,
    flagged_reasons text[],
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(script_hash) -- Prevent duplicate reviews for the same script
);

CREATE TABLE script_execution_log (
    id SERIAL PRIMARY KEY,
    script_hash varchar(64) NOT NULL,
    executed_by varchar(16),
    execution_context jsonb,
    execution_time_ms integer,
    success boolean,
    error_message text,
    resource_usage jsonb, -- memory, timeout, etc.
    ip_address inet,
    user_agent text,
    executed_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_script_whitelist_hash ON script_whitelist(script_hash);
CREATE INDEX idx_script_whitelist_active ON script_whitelist(is_active);
CREATE INDEX idx_script_reviews_status ON script_reviews(status);
CREATE INDEX idx_script_reviews_hash ON script_reviews(script_hash);
CREATE INDEX idx_script_reviews_created ON script_reviews(created_at);
CREATE INDEX idx_script_execution_log_hash ON script_execution_log(script_hash);
CREATE INDEX idx_script_execution_log_executed_at ON script_execution_log(executed_at);
CREATE INDEX idx_script_execution_log_success ON script_execution_log(success);

-- ==================================================================
-- DLUX PRESENCE VR INTEGRATION TABLES
-- ==================================================================

-- VR presence sessions for tracking users in VR spaces
CREATE TABLE presence_sessions (
    id SERIAL PRIMARY KEY,
    socket_id varchar(255) UNIQUE NOT NULL,
    user_account varchar(16), -- Hive account (null for guests)
    space_type varchar(20) NOT NULL, -- 'post', 'community', 'document', 'global'
    space_id varchar(255) NOT NULL, -- post author/permlink, community name, document id, or 'lobby'
    subspace varchar(255) DEFAULT 'main', -- subroom within the space
    connected_at timestamp DEFAULT CURRENT_TIMESTAMP,
    last_activity timestamp DEFAULT CURRENT_TIMESTAMP
);

-- VR space permissions (who can access which VR spaces)
CREATE TABLE presence_permissions (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL, -- 'post', 'community', 'document'
    space_id varchar(255) NOT NULL, -- identifier for the space
    user_account varchar(16) NOT NULL, -- Hive account
    permission varchar(20) DEFAULT 'access', -- 'access', 'moderate', 'admin'
    granted_by varchar(16) NOT NULL,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(space_type, space_id, user_account)
);

-- WebRTC peer connections for debugging VR voice chat
CREATE TABLE presence_peer_connections (
    id SERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES presence_sessions(id) ON DELETE CASCADE,
    peer_socket_id varchar(255) NOT NULL,
    connection_state varchar(50),
    ice_connection_state varchar(50),
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- VR space settings (configuration for different spaces)
CREATE TABLE presence_space_settings (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL, -- 'post', 'community', 'document', 'global'
    space_id varchar(255) NOT NULL, -- identifier for the space
    settings jsonb NOT NULL DEFAULT '{}', -- VR scene settings, spawn points, etc.
    created_by varchar(16) NOT NULL,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(space_type, space_id)
);

-- Audit log for VR presence activities
CREATE TABLE presence_audit_log (
    id SERIAL PRIMARY KEY,
    user_account varchar(16),
    action varchar(100) NOT NULL, -- 'join_space', 'leave_space', 'voice_start', 'voice_end'
    space_type varchar(20),
    space_id varchar(255),
    details jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Performance indexes for presence tables
CREATE INDEX idx_presence_sessions_user ON presence_sessions(user_account);
CREATE INDEX idx_presence_sessions_space ON presence_sessions(space_type, space_id);
CREATE INDEX idx_presence_sessions_activity ON presence_sessions(last_activity);
CREATE INDEX idx_presence_permissions_space_user ON presence_permissions(space_type, space_id, user_account);
CREATE INDEX idx_presence_permissions_user ON presence_permissions(user_account);
CREATE INDEX idx_presence_space_settings_space ON presence_space_settings(space_type, space_id);
CREATE INDEX idx_presence_audit_log_user ON presence_audit_log(user_account);
CREATE INDEX idx_presence_audit_log_action ON presence_audit_log(action);
CREATE INDEX idx_presence_audit_log_created ON presence_audit_log(created_at);

-- ==================================================================
-- SUBSCRIPTION SYSTEM TABLES
-- ==================================================================

-- Subscription tiers/plans configuration
CREATE TABLE subscription_tiers (
    id SERIAL PRIMARY KEY,
    tier_code varchar(50) UNIQUE NOT NULL, -- 'basic', 'premium', 'pro', 'enterprise'
    tier_name varchar(100) NOT NULL,
    description text,
    features jsonb NOT NULL DEFAULT '{}', -- JSON object defining features
    monthly_price_hive decimal(10,3), -- Monthly price in HIVE
    yearly_price_hive decimal(10,3), -- Yearly price in HIVE (usually discounted)
    monthly_price_hbd decimal(10,3), -- Monthly price in HBD
    yearly_price_hbd decimal(10,3), -- Yearly price in HBD
    max_presence_sessions integer DEFAULT 1, -- Max concurrent VR sessions
    max_collaboration_docs integer DEFAULT 5, -- Max collaborative documents
    max_event_attendees integer DEFAULT 10, -- Max event participants
    storage_limit_gb integer DEFAULT 1, -- Storage limit in GB
    bandwidth_limit_gb integer DEFAULT 10, -- Monthly bandwidth limit
    priority_support boolean DEFAULT false,
    custom_branding boolean DEFAULT false,
    api_access boolean DEFAULT false,
    analytics_access boolean DEFAULT false,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Insert default subscription tiers
INSERT INTO subscription_tiers (tier_code, tier_name, description, features, monthly_price_hive, yearly_price_hive, monthly_price_hbd, yearly_price_hbd, max_presence_sessions, max_collaboration_docs, max_event_attendees, storage_limit_gb, bandwidth_limit_gb, priority_support, custom_branding, api_access, analytics_access, sort_order) VALUES
('free', 'Free', 'Basic presence features for individual users', '{"vr_spaces": true, "basic_chat": true, "file_sharing": false, "screen_sharing": false, "recording": false}', 0, 0, 0, 0, 1, 1, 5, 0, 1, false, false, false, false, 1),
('basic', 'Basic', 'Enhanced presence with file sharing and collaboration', '{"vr_spaces": true, "basic_chat": true, "file_sharing": true, "screen_sharing": true, "recording": false, "custom_avatars": true}', 5.000, 50.000, 2.500, 25.000, 2, 5, 15, 1, 5, false, false, false, false, 2),
('premium', 'Premium', 'Advanced features for teams and content creators', '{"vr_spaces": true, "basic_chat": true, "file_sharing": true, "screen_sharing": true, "recording": true, "custom_avatars": true, "custom_environments": true, "live_streaming": true}', 15.000, 150.000, 7.500, 75.000, 5, 25, 50, 5, 25, true, false, true, true, 3),
('pro', 'Professional', 'Everything for professional organizations', '{"vr_spaces": true, "basic_chat": true, "file_sharing": true, "screen_sharing": true, "recording": true, "custom_avatars": true, "custom_environments": true, "live_streaming": true, "api_integration": true, "webhooks": true, "sso": true}', 50.000, 500.000, 25.000, 250.000, 20, 100, 200, 25, 100, true, true, true, true, 4);

-- User subscriptions
CREATE TABLE user_subscriptions (
    id SERIAL PRIMARY KEY,
    user_account varchar(16) NOT NULL,
    tier_id INTEGER REFERENCES subscription_tiers(id),
    subscription_type varchar(20) NOT NULL, -- 'monthly', 'yearly', 'lifetime', 'promo'
    status varchar(20) DEFAULT 'active', -- 'active', 'cancelled', 'expired', 'suspended'
    
    -- Pricing information (locked at subscription time)
    original_price_hive decimal(10,3),
    original_price_hbd decimal(10,3),
    effective_price_hive decimal(10,3), -- After promos/discounts
    effective_price_hbd decimal(10,3),
    currency_used varchar(10), -- 'HIVE' or 'HBD'
    
    -- Subscription dates
    started_at timestamp DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp,
    last_payment_at timestamp,
    next_payment_due timestamp,
    cancelled_at timestamp,
    
    -- Payment tracking
    payment_transaction_id varchar(255), -- Hive transaction ID for initial payment
    auto_renew boolean DEFAULT true,
    renewal_failures integer DEFAULT 0,
    
    -- Promo/discount tracking
    promo_code_id INTEGER, -- References promo_codes table
    discount_applied decimal(5,2) DEFAULT 0, -- Percentage discount applied
    
    -- Usage tracking
    features_used jsonb DEFAULT '{}',
    usage_stats jsonb DEFAULT '{}',
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(user_account) -- One active subscription per user
);

-- Promo codes for discounts and special offers
CREATE TABLE promo_codes (
    id SERIAL PRIMARY KEY,
    code varchar(50) UNIQUE NOT NULL,
    description text,
    discount_type varchar(20) NOT NULL, -- 'percentage', 'fixed_hive', 'fixed_hbd', 'free_months'
    discount_value decimal(10,3) NOT NULL, -- Percentage (0.20 for 20%), fixed amount, or months
    
    -- Restrictions
    applicable_tiers integer[] DEFAULT '{}', -- Array of tier IDs this code applies to
    min_subscription_months integer DEFAULT 1,
    max_uses integer, -- NULL for unlimited
    uses_per_user integer DEFAULT 1,
    
    -- Validity
    valid_from timestamp DEFAULT CURRENT_TIMESTAMP,
    valid_until timestamp,
    is_active boolean DEFAULT true,
    
    -- Tracking
    total_uses integer DEFAULT 0,
    created_by varchar(16) NOT NULL,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Track promo code usage
CREATE TABLE promo_code_usage (
    id SERIAL PRIMARY KEY,
    promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE CASCADE,
    user_account varchar(16) NOT NULL,
    subscription_id INTEGER REFERENCES user_subscriptions(id) ON DELETE CASCADE,
    discount_applied decimal(10,3),
    used_at timestamp DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(promo_code_id, user_account) -- Prevent multiple uses per user (unless promo allows)
);

-- Payment transactions from Hive blockchain
CREATE TABLE subscription_payments (
    id SERIAL PRIMARY KEY,
    transaction_id varchar(255) UNIQUE NOT NULL, -- Hive transaction ID
    block_num integer,
    
    -- Payment details
    from_account varchar(16) NOT NULL,
    to_account varchar(16) NOT NULL, -- Should be 'dlux-io'
    amount decimal(10,3) NOT NULL,
    currency varchar(10) NOT NULL, -- 'HIVE' or 'HBD'
    memo text, -- Payment memo (may contain subscription info)
    
    -- Processing status
    status varchar(20) DEFAULT 'pending', -- 'pending', 'processed', 'failed', 'refunded'
    processed_at timestamp,
    subscription_id INTEGER REFERENCES user_subscriptions(id),
    
    -- Validation
    expected_amount decimal(10,3),
    amount_matches boolean DEFAULT false,
    memo_parsed jsonb, -- Parsed memo data
    
    -- Error handling
    error_message text,
    retry_count integer DEFAULT 0,
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Events and live collaboration sessions
CREATE TABLE presence_events (
    id SERIAL PRIMARY KEY,
    event_code varchar(50) UNIQUE NOT NULL, -- User-friendly event code
    title varchar(255) NOT NULL,
    description text,
    
    -- Event details
    event_type varchar(30) DEFAULT 'meeting', -- 'meeting', 'conference', 'workshop', 'presentation'
    max_attendees integer DEFAULT 50,
    requires_subscription boolean DEFAULT false,
    min_tier_required INTEGER REFERENCES subscription_tiers(id),
    
    -- Scheduling
    scheduled_start timestamp,
    scheduled_end timestamp,
    actual_start timestamp,
    actual_end timestamp,
    timezone varchar(50) DEFAULT 'UTC',
    
    -- VR Space configuration
    space_type varchar(20) DEFAULT 'event',
    space_settings jsonb DEFAULT '{}',
    recording_enabled boolean DEFAULT false,
    chat_enabled boolean DEFAULT true,
    screen_sharing_enabled boolean DEFAULT true,
    
    -- Access control
    host_account varchar(16) NOT NULL,
    co_hosts varchar(16)[] DEFAULT '{}',
    is_public boolean DEFAULT false,
    registration_required boolean DEFAULT false,
    password_protected boolean DEFAULT false,
    event_password varchar(255),
    
    -- Status
    status varchar(20) DEFAULT 'scheduled', -- 'scheduled', 'live', 'ended', 'cancelled'
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Event registrations and attendance
CREATE TABLE event_registrations (
    id SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES presence_events(id) ON DELETE CASCADE,
    user_account varchar(16) NOT NULL,
    registration_data jsonb DEFAULT '{}', -- Name, email, etc.
    
    -- Status
    status varchar(20) DEFAULT 'registered', -- 'registered', 'attended', 'no_show', 'cancelled'
    attended_at timestamp,
    left_at timestamp,
    
    -- Notifications
    confirmation_sent boolean DEFAULT false,
    reminder_sent boolean DEFAULT false,
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(event_id, user_account)
);

-- Collaboration documents (enhanced from previous presence system)
CREATE TABLE collaboration_documents (
    id SERIAL PRIMARY KEY,
    title varchar(255) NOT NULL,
    content text DEFAULT '',
    content_type varchar(20) DEFAULT 'markdown', -- 'markdown', 'html', 'text', 'code'
    
    -- Access control
    creator varchar(16) NOT NULL,
    is_public boolean DEFAULT false,
    requires_subscription boolean DEFAULT false,
    min_tier_required INTEGER REFERENCES subscription_tiers(id),
    
    -- Collaboration settings
    max_collaborators integer DEFAULT 10,
    edit_permissions varchar(20) DEFAULT 'all', -- 'creator_only', 'invited_only', 'all'
    comment_permissions varchar(20) DEFAULT 'all',
    
    -- Version control
    version integer DEFAULT 1,
    auto_save boolean DEFAULT true,
    
    -- Status
    is_deleted boolean DEFAULT false,
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Document permissions
CREATE TABLE collaboration_permissions (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES collaboration_documents(id) ON DELETE CASCADE,
    user_account varchar(16) NOT NULL,
    permission varchar(20) DEFAULT 'read', -- 'read', 'comment', 'edit', 'admin'
    granted_by varchar(16),
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(document_id, user_account)
);

-- Document comments
CREATE TABLE document_comments (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES collaboration_documents(id) ON DELETE CASCADE,
    user_account varchar(16) NOT NULL,
    parent_comment_id INTEGER REFERENCES document_comments(id), -- For threaded comments
    
    content text NOT NULL,
    position_data jsonb, -- Position in document (line, character, etc.)
    
    -- Status
    is_deleted boolean DEFAULT false,
    is_resolved boolean DEFAULT false,
    resolved_by varchar(16),
    resolved_at timestamp,
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Chat messages for VR spaces (enhanced)
CREATE TABLE chat_messages (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL,
    space_id varchar(255) NOT NULL,
    subspace varchar(255) DEFAULT 'main',
    
    -- Message details
    user_account varchar(16), -- NULL for guests
    guest_id varchar(50), -- For guest users
    message_type varchar(20) DEFAULT 'text', -- 'text', 'image', 'file', 'system'
    content text NOT NULL,
    
    -- Threading
    parent_message_id INTEGER REFERENCES chat_messages(id),
    thread_root_id INTEGER REFERENCES chat_messages(id),
    
    -- Attachments
    attachment_url varchar(500),
    attachment_type varchar(50),
    attachment_size integer,
    
    -- Moderation
    is_deleted boolean DEFAULT false,
    deleted_by varchar(16),
    deleted_at timestamp,
    is_flagged boolean DEFAULT false,
    flag_reason varchar(255),
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Space activity log (enhanced)
CREATE TABLE space_activity (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL,
    space_id varchar(255) NOT NULL,
    user_account varchar(16),
    
    activity_type varchar(50) NOT NULL, -- 'join', 'leave', 'chat', 'file_share', 'screen_share', 'voice_start', 'voice_end'
    activity_data jsonb DEFAULT '{}',
    
    -- Session tracking
    session_duration integer, -- Duration in seconds
    
    created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Audio/video session management for VR spaces
CREATE TABLE space_audio_config (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL,
    space_id varchar(255) NOT NULL,
    
    -- Audio settings
    audio_enabled boolean DEFAULT true,
    spatial_audio boolean DEFAULT true,
    audio_quality varchar(20) DEFAULT 'standard', -- 'low', 'standard', 'high'
    
    -- Voice chat settings
    push_to_talk boolean DEFAULT false,
    noise_suppression boolean DEFAULT true,
    echo_cancellation boolean DEFAULT true,
    
    -- Permissions
    who_can_speak varchar(20) DEFAULT 'all', -- 'all', 'registered', 'subscribers', 'invited'
    who_can_mute varchar(20) DEFAULT 'moderators', -- 'self', 'moderators', 'admin'
    
    -- Recording
    recording_enabled boolean DEFAULT false,
    recording_consent_required boolean DEFAULT true,
    
    created_by varchar(16),
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(space_type, space_id)
);

-- Audio session tracking
CREATE TABLE audio_sessions (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL,
    space_id varchar(255) NOT NULL,
    user_account varchar(16),
    
    -- Session details
    session_type varchar(20) DEFAULT 'voice', -- 'voice', 'presentation', 'recording'
    is_presenter boolean DEFAULT false,
    is_muted boolean DEFAULT false,
    
    -- Connection details
    peer_connection_id varchar(255),
    audio_codec varchar(50),
    bitrate integer,
    
    -- Status
    connected_at timestamp DEFAULT CURRENT_TIMESTAMP,
    disconnected_at timestamp,
    total_duration integer, -- Calculated on disconnect
    
    -- Quality metrics
    packet_loss decimal(5,2) DEFAULT 0,
    avg_latency integer DEFAULT 0,
    quality_score decimal(3,2) DEFAULT 0
);

-- ==================================================================
-- INDEXES FOR SUBSCRIPTION SYSTEM
-- ==================================================================

-- Subscription tier indexes
CREATE INDEX idx_subscription_tiers_code ON subscription_tiers(tier_code);
CREATE INDEX idx_subscription_tiers_active ON subscription_tiers(is_active);
CREATE INDEX idx_subscription_tiers_price_hive ON subscription_tiers(monthly_price_hive);
CREATE INDEX idx_subscription_tiers_price_hbd ON subscription_tiers(monthly_price_hbd);

-- User subscription indexes
CREATE INDEX idx_user_subscriptions_account ON user_subscriptions(user_account);
CREATE INDEX idx_user_subscriptions_tier ON user_subscriptions(tier_id);
CREATE INDEX idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX idx_user_subscriptions_expires ON user_subscriptions(expires_at);
CREATE INDEX idx_user_subscriptions_next_payment ON user_subscriptions(next_payment_due);

-- Promo code indexes
CREATE INDEX idx_promo_codes_code ON promo_codes(code);
CREATE INDEX idx_promo_codes_active ON promo_codes(is_active);
CREATE INDEX idx_promo_codes_valid_from ON promo_codes(valid_from);
CREATE INDEX idx_promo_codes_valid_until ON promo_codes(valid_until);

-- Payment indexes
CREATE INDEX idx_subscription_payments_tx ON subscription_payments(transaction_id);
CREATE INDEX idx_subscription_payments_from ON subscription_payments(from_account);
CREATE INDEX idx_subscription_payments_to ON subscription_payments(to_account);
CREATE INDEX idx_subscription_payments_status ON subscription_payments(status);
CREATE INDEX idx_subscription_payments_created ON subscription_payments(created_at);
CREATE INDEX idx_subscription_payments_block ON subscription_payments(block_num);

-- Event indexes
CREATE INDEX idx_presence_events_code ON presence_events(event_code);
CREATE INDEX idx_presence_events_host ON presence_events(host_account);
CREATE INDEX idx_presence_events_status ON presence_events(status);
CREATE INDEX idx_presence_events_start ON presence_events(scheduled_start);
CREATE INDEX idx_presence_events_public ON presence_events(is_public);

-- Registration indexes
CREATE INDEX idx_event_registrations_event ON event_registrations(event_id);
CREATE INDEX idx_event_registrations_user ON event_registrations(user_account);
CREATE INDEX idx_event_registrations_status ON event_registrations(status);

-- Document indexes
CREATE INDEX idx_collaboration_documents_creator ON collaboration_documents(creator);
CREATE INDEX idx_collaboration_documents_public ON collaboration_documents(is_public);
CREATE INDEX idx_collaboration_documents_created ON collaboration_documents(created_at);
CREATE INDEX idx_collaboration_documents_updated ON collaboration_documents(updated_at);

-- Chat message indexes
CREATE INDEX idx_chat_messages_space ON chat_messages(space_type, space_id);
CREATE INDEX idx_chat_messages_user ON chat_messages(user_account);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at);
CREATE INDEX idx_chat_messages_parent ON chat_messages(parent_message_id);

-- Activity indexes
CREATE INDEX idx_space_activity_space ON space_activity(space_type, space_id);
CREATE INDEX idx_space_activity_user ON space_activity(user_account);
CREATE INDEX idx_space_activity_type ON space_activity(activity_type);
CREATE INDEX idx_space_activity_created ON space_activity(created_at);

-- Audio session indexes
CREATE INDEX idx_audio_sessions_space ON audio_sessions(space_type, space_id);
CREATE INDEX idx_audio_sessions_user ON audio_sessions(user_account);
CREATE INDEX idx_audio_sessions_connected ON audio_sessions(connected_at);

-- Create replication user for presence.dlux.io
DO $$ 
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'presence_replica') THEN
      CREATE ROLE presence_replica WITH REPLICATION LOGIN ENCRYPTED PASSWORD 'presence_replica_password_2024';
   END IF;
END
$$;