```sql
CREATE TABLE posts (
    author varchar(16) NOT NULL,
    permlink varchar(255) NOT NULL,
    block integer,
    votes integer,
    voteweight integer,
    promote integer,
    paid integer,
    payout integer,
    payout_author varchar(16),
    linear_weight integer,
    voters varchar(255),
    voters_paid varchar(255),
    type varchar(16),
    rating integer,
    ratings integer,
    raters varchar(255),
);

CREATE TABLE statssi (
    string varchar(255) NOT NULL,
    int integer,
);
```