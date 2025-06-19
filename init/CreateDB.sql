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