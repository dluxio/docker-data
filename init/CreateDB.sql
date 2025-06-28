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

-- Create replication user for presence.dlux.io
DO $$ 
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'presence_replica') THEN
      CREATE ROLE presence_replica WITH REPLICATION LOGIN ENCRYPTED PASSWORD 'presence_replica_password_2024';
   END IF;
END
$$;