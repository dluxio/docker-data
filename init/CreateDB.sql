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
    voters LONGTEXT,
    voters_paid LONGTEXT,
    type varchar(16),
    rating int,
    ratings int,
    raters varchar(255)
);

CREATE TABLE statssi (
    string varchar(255) NOT NULL,
    int integer
);