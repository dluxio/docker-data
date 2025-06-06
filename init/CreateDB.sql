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