CREATE TABLE posts (
    author character varying(16) NOT NULL,
    permlink character varying(255) NOT NULL,
    block integer,
    votes integer,
    voteweight integer,
    promote integer,
    paid integer,
    payout integer,
    payout_author character varying(16),
    linear_weight integer,
    voters character varying(255),
    voters_paid character varying(255),
    type character varying(16),
    rating integer,
    ratings integer,
    raters character varying(255),
);

CREATE TABLE statssi (
    string character varying(255) NOT NULL,
    int integer,
);