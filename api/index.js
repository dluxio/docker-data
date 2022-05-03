const { Pool } = require('pg');
const config = require('../config');
const fetch = require('node-fetch');
const { svg2png } = require('svg-png-converter');
const safeEval = require('safe-eval');
const sharp = require("sharp");

console.log(config.dbcs)
const pool = new Pool({
    connectionString: config.dbcs
});
console.log({ pool })
var RAM = {}

exports.start = (array) => {
    for (script in array) {
        pop(array[script], script)
    }
    function pop(script, set) {
        fetch(`https://ipfs.io/ipfs/${script}`)
            .then(r => r.text())
            .then(text => {
                RAM[script] = text
                RAM[set] = script
            })
            .catch(e => console.log(e))
    }
}

exports.https_redirect = (req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
        if (req.headers['x-forwarded-proto'] != 'https') {
            return res.redirect('https://' + req.headers.host + req.url);
        } else {
            return next();
        }
    } else {
        return next();
    }
};

function getStats(table) {
    return new Promise((r, e) => {
        pool.query(`SELECT * FROM statssi;`, (err, res) => {
            if (err) {
                console.log(`Error - Failed to select all from ${table}`);
                e(err);
            }
            else {
                for (item in res.rows) {
                    res.rows[item].url = `/dlux/@${res.rows[item].author}/${res.rows[item].permlink}`
                }
                r(res.rows);
            }
        });
    })
}

exports.getSearchResults = (req, res, next) => {
    let amt = parseInt(req.query.a) || 50,
        off = parseInt(req.query.o) || 0
    if (amt < 1) {
        amt = 50
    } else if (amt > 100) {
        amt = 100
    }
    if (off < 0) {
        off = 0
    }
    getSearchResults(req.params.search_term, amt, off)
    .then(r => {
        res.send(
          JSON.stringify(
            {
              result: r,
              node: config.username,
            },
            null,
            3
          )
        );
    })
}

function getSearchResults(st, amt, off){
    return new Promise((r, e) => {
        pool.query(
          `SELECT *
                FROM posts
                WHERE to_tsvector(author  || ' ' || permlink) @@ to_tsquery('${st}')
                ORDER BY block DESC
                OFFSET ${off} ROWS FETCH FIRST ${amt} ROWS ONLY;`,
          (err, res) => {
            if (err) {
              console.log(`Error - Failed to select some new from ${table}`);
              e(err);
            } else {
              for (item in res.rows) {
                res.rows[
                  item
                ].url = `/dlux/@${res.rows[item].author}/${res.rows[item].permlink}`;
              }
              r(res.rows);
            }
          }
        );
    })
}

exports.getPromotedPosts = (req, res, next) => {
    let amt = parseInt(req.query.a),
        off = parseInt(req.query.o)
    if (amt < 1) {
        amt = 50
    } else if (amt > 100) {
        amt = 100
    }
    if (off < 0) {
        off = 0
    }
    res.setHeader('Content-Type', 'application/json')
    getDBPromotedPosts(amt, off)
        .then(r => {
            res.send(JSON.stringify({
                result: r,
                node: config.username
            }, null, 3))
        })
        .catch(e => {
            console.log(e)

        })
}

function getDetails(uid, script, opt) {
    return new Promise((resolve, reject) => {
        const NFT = opt.exe ? safeEval(`(//${RAM[script]}\n)('${uid}','${opt.exe}')`) : safeEval(`(//${RAM[script]}\n)('${uid}')`)
        resolve({ attributes: NFT.attributes, set: NFT.set, opt })
    })
}

function makePNG(uid, script, opt) {
    return new Promise((resolve, reject) => {
        const NFT = opt ? safeEval(`(//${RAM[script]}\n)('${uid}','${opt}')`) : safeEval(`(//${RAM[script]}\n)('${uid}')`)
        if (NFT.HTML.substr(0, 4) == '<svg') {
            SVG2PNG({
                input: NFT.HTML.trim(),
                encoding: 'buffer',
                format: 'jpeg'
            })
        }
        else {
            var string = NFT.HTML.trim()
            var i = 2, type = string.split('data:image/')[1].split(';')[0], toDo = string.split(`data:image/${type};base64,`).length - 2
            input = []
            var base = Buffer.from(string.split(`data:image/${type};base64,`)[1].split('"')[0], 'base64')
            while (toDo > 0) {
                input.push({ input: Buffer.from(string.split(`data:image/${type};base64,`)[i].split('"')[0], 'base64') })
                i++;
                toDo--
            }
            sharp(base)
                .composite(input)
                .toBuffer((err, buf) => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve([buf, type])
                    }
                })
        }
        function SVG2PNG(ip) {
            svg2png(ip)
                .then(img => { resolve([img, 'jpeg']) })
                .catch(e => { reject(e) })
        }
    })
}

exports.detailsNFT = (req, res, next) => {
    let uid = req.params.uid,
        script = req.params.script,
        set = req.params.set
    if (!RAM[script]) {
        try {
            script = RAM[set]
        } catch (e) {
            script = ''
        }
    }
    getDetails(uid, script, { opt: req.query.opt, exe: req.query.exe })
        .then(attributes => {
            res.setHeader('Content-Type', 'application/json')
            res.send(attributes)
        })
        .catch(e => {
            res.setHeader('Content-Type', 'application/json')
            res.send(JSON.stringify({
                result: 'Script is not from a defined NFT set.',
                error: e
            }, null, 3))
        })
}

exports.renderNFT = (req, res, next) => {
    let uid = req.params.uid,
        script = req.params.script,
        set = req.params.set
    if (!RAM[script]) {
        try {
            script = RAM[set]
        } catch (e) {
            script = ''
        }
    }
    makePNG(uid, script, req.query.exe)
        .then(img => {
            res.setHeader('Content-Type', `image/${img[1]}`)
            res.send(img[0])
        })
        .catch(e => {
            res.setHeader('Content-Type', 'application/json')
            res.send(JSON.stringify({
                result: 'Script is not from a defined NFT set.',
                error: e
            }, null, 3))
        })
}

exports.getPFP = (req, res, next) => {
    let user = req.params.user
    fetch(`${config.dluxapi}api/pfp/${user}`)
        .then(r => r.json())
        .then(json => {
            if (json.result != 'No Profile Picture Set or Owned') {
                let script = json.result[0].set.s || ''
                let exe = (json.result[0].set.t == 2 || json.result[0].set.t == 4) ? json.result[0].nft.s.split(',')[1] : ''
                let uid = json.result[0].pfp.split(':')[1] || ''
                makePNG(uid, script, exe)
                    .then(img => {
                        res.setHeader('Content-Type', `image/${img[1]}`)
                        res.send(img[0])
                    })
                    .catch(e => {
                        res.setHeader('Content-Type', 'application/json')
                        res.send(JSON.stringify({
                            result: 'Error or no PFP set.',
                            error: e
                        }, null, 3))
                    })
            } else {
                res.setHeader('Content-Type', 'application/json')
                res.send(JSON.stringify({
                    result: 'Error or no PFP set.'
                }, null, 3))
            }
        })
}


function getDBPromotedPosts(amount, offset) {
    let off = offset,
        amt = amount
    if (!amount) amt = 50
    if (!off) off = 0
    return new Promise((r, e) => {
        pool.query(`SELECT 
                        author, 
                        permlink, 
                        block, 
                        votes, 
                        voteweight, 
                        promote, 
                        paid 
                    FROM 
                        posts 
                    WHERE 
                        promote > 0
                    ORDER BY 
                        promote DESC
                    OFFSET ${off} ROWS FETCH FIRST ${amt} ROWS ONLY;`, (err, res) => {
            if (err) {
                console.log(`Error - Failed to select some new from ${table}`);
                e(err);
            }
            else {
                for (item in res.rows) {
                    res.rows[item].url = `/dlux/@${res.rows[item].author}/${res.rows[item].permlink}`
                }
                r(res.rows);
            }
        });
    })
}

exports.getTrendingPosts = (req, res, next) => {
    let amt = parseInt(req.query.a),
        off = parseInt(req.query.o)
    if (amt < 1) {
        amt = 50
    } else if (amt > 100) {
        amt = 100
    }
    if (off < 0) {
        off = 0
    }
    res.setHeader('Content-Type', 'application/json')
    getTrendingPosts(amt, off)
        .then(r => {
            res.send(JSON.stringify({
                result: r,
                node: config.username
            }, null, 3))
        })
        .catch(e => {
            console.log(e)

        })
}

function getTrendingPosts(amount, offset) {
    let off = offset,
        amt = amount
    if (!amount) amt = 50
    if (!off) off = 0
    return new Promise((r, e) => {
        pool.query(`SELECT 
                        author, 
                        permlink, 
                        block, 
                        votes, 
                        voteweight, 
                        promote, 
                        paid 
                    FROM 
                        posts 
                    WHERE 
                        paid = false
                    ORDER BY 
                        voteweight DESC
                    OFFSET ${off} ROWS FETCH FIRST ${amt} ROWS ONLY;`, (err, res) => {
            if (err) {
                console.log(`Error - Failed to select some new from ${table}`);
                e(err);
            }
            else {
                for (item in res.rows) {
                    res.rows[item].url = `/dlux/@${res.rows[item].author}/${res.rows[item].permlink}`
                }
                r(res.rows);
            }
        });
    })
}

exports.getPost = getPost

function getPost(author, permlink) {
    return new Promise((r, e) => {
        pool.query(`SELECT * FROM posts WHERE author = '${author}' AND permlink = '${permlink}';`, (err, res) => {
            if (err) {
                console.log(`Error - Failed to get a post from posts`);
                e(err);
            }
            else {
                for (item in res.rows) {
                    res.rows[item].url = `/dlux/@${res.rows[item].author}/${res.rows[item].permlink}`
                }
                r(res.rows);
            }
        });
    })
}

exports.getPostRoute = (req, res, next) => {
    let a = req.params.author,
        p = req.params.permlink;
    getPost(a, p)
        .then((r) => {
            res.send(
                JSON.stringify(
                    {
                        result: r,
                        node: config.username,
                    },
                    null,
                    3
                )
            );
        })
        .catch((e) => {
            console.log(e);
        });
}

exports.getNewPosts = (req, res, next) => {
    let amt = parseInt(req.query.a),
        off = parseInt(req.query.o)
    if (amt < 1) {
        amt = 50
    } else if (amt > 100) {
        amt = 100
    }
    if (off < 0) {
        off = 0
    }
    res.setHeader('Content-Type', 'application/json')
    getNewPosts(amt, off)
        .then(r => {
            res.send(JSON.stringify({
                result: r,
                node: config.username
            }, null, 3))
        })
        .catch(e => {
            console.log(e)

        })
}

function getNewPosts(amount, offset) {
    let off = offset,
        amt = amount
    if (!amount) amt = 50
    if (!off) off = 0
    return new Promise((r, e) => {
        pool.query(`SELECT * FROM posts ORDER BY block DESC OFFSET ${off} ROWS FETCH FIRST ${amt} ROWS ONLY;`, (err, res) => {
            if (err) {
                console.log(`Error - Failed to select some new`);
                e(err);
            }
            else {
                for (item in res.rows) {
                    res.rows[item].url = `/dlux/@${res.rows[item].author}/${res.rows[item].permlink}`
                    res.rows[item].l2votes = res.rows[item].votes
                }
                r(res.rows);
            }
        });
    })
}

exports.getAuthorPosts = getAuthorPosts

function getAuthorPosts(author, amount, offset) {
    let off = offset,
        amt = amount
    if (!amount) amt = 50
    if (!off) off = 0
    return new Promise((r, e) => {
        pool.query(`SELECT 
                        author, 
                        permlink, 
                        block, 
                        votes, 
                        voteweight, 
                        promote, 
                        paid 
                    FROM 
                        posts
                    WHERE
                        author = '${author}' 
                    ORDER BY 
                        block DESC 
                    OFFSET ${off} ROWS FETCH FIRST ${amt} ROWS ONLY;`, (err, res) => {
            if (err) {
                console.log(`Error - Failed to select some new from ${table}`);
                e(err);
            }
            else {
                for (item in res.rows) {
                    res.rows[item].url = `/dlux/@${res.rows[item].author}/${res.rows[item].permlink}`
                }
                r(res.rows);
            }
        });
    })
}


exports.insertNewPost = insertNewPost

function insertNewPost(post) { //is good
    let record = {
        author: post.author,
        permlink: post.permlink,
        block: post.block,
        votes: post.votes || 0,
        voteweight: post.voteweight || 0,
        promote: post.promote || 0,
        paid: post.paid || false,
        payout: post.payout || 0,
        payout_author: post.payout_author || 0,
        linear_weight: post.linear_weight || 0,
        voters: post.voters || '',
        voters_paid: post.voters_paid || '',
    }
    return new Promise((r, e) => {
        pool.query(`INSERT INTO posts(author,permlink,block,votes,voteweight,promote,paid,payout,payout_author,linear_weight,voters,voters_paid)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
                record.author,
                record.permlink,
                record.block,
                record.votes,
                record.voteweight,
                record.promote,
                record.paid,
                record.payout,
                record.payout_author,
                record.linear_weight,
                record.voters,
                record.voters_paid
            ], (err, res) => {
                if (err) {
                    console.log(`Error - Failed to insert data into posts`);
                    e(err);
                } else {
                    r(res)
                }
            });
    })
}

exports.updatePost = updatePost

function updatePost(post) {
    let record = {
        author: post.author,
        permlink: post.permlink,
        block: post.block,
        votes: Object.keys(post.votes).length,
        voteweight: post.t.totalWeight,
        paid: true,
        payout: post.paid,
        payout_author: post.author_payout,
        linear_weight: post.t.linearWeight || 0,
        voters: post.voters || '',
        voters_paid: post.voters_paid || '',
    }
    for (v in post.votes) {
        record.voters += v + ','
        record.voters_paid += post.votes[v].p + ','
    }
    record.voters = record.voters.substring(0, record.voters.length - 1)
    record.voters_paid = record.voters_paid.substring(0, record.voters_paid.length - 1)
    return new Promise((r, e) => {
        getPost(post.author, post.permlink)
            .then(ret => {
                pool.query(`UPDATE posts
                    SET votes = ${record.votes},
                        voteweight = ${record.voteweight},
                        paid = ${record.paid},
                        payout = ${record.payout},
                        payout_author = ${record.payout_author},
                        linear_weight = ${record.linear_weight},
                        voters = '${record.voters}',
                        voters_paid = '${record.voters_paid}'
                    WHERE author = '${record.author}' AND
                        permlink = '${record.permlink}';`, (err, res) => {
                    if (err) {
                        console.log(`Error - Failed to insert data into posts`);
                        e(err);
                    } else {
                        console.log(res)
                        r(res)
                    }
                });
            })

    })
}

exports.updatePostVotes = updatePostVotes

function updatePostVotes(post) { //live votes
    return new Promise((r, e) => {
        let votes = Object.keys(post.votes).length,
            voteweight = 0,
            voters = ''
        for (v in post.votes) {
            voteweight += post.votes[v].v
            voters += v + ','
        }
        voters = voters.substring(0, voters.length - 1)
        pool.query(`UPDATE posts
                    SET votes = ${votes},
                        voteweight = ${voteweight},
                        voters = '${voters}'
                    WHERE author = '${post.author}' AND
                        permlink = '${post.permlink}';`, (err, res) => {
            if (err) {
                console.log(`Error - Failed to insert data into posts`);
                e(err);
            } else {
                r(res)
            }
        });
    })
}

exports.updateStat = updateStat

function insertStats(stat) { //is good
    let stats = {
        string: stat.string,
        int: stat.int
    }
    return new Promise((r, e) => {
        pool.query(`INSERT INTO statssi(string,int)VALUES($1,$2)`,
            [
                stats.string,
                stats.int
            ], (err, res) => {
                if (err) {
                    console.log(`Error - Failed to insert data into statssi`);
                    e(err);
                } else {
                    r(res)
                }
            });
    })
}

function updateStat(stat) { //is good
    let record = {
        string: stat.string,
        int: stat.int
    }
    return new Promise((r, e) => {
        pool.query(`UPDATE statssi
                    SET int = '${record.int}'
                    WHERE string = '${record.string}';`, (err, res) => {
            if (err) {
                insertStats(stat)
                    .then(ret => {
                        r(ret)
                    })
                    .catch(errr => {
                        console.log(err, errr)
                        e(err, errr)
                    })
            } else {
                r(res)
            }
        });
    })
}

exports.updatePromote = updatePromote

function updatePromote(author, permlink, amt) { //is good
    return new Promise((r, e) => {
        getPost(post.author, post.permlink)
            .then(post => {
                amount = post.promote + amt
                pool.query(`UPDATE posts
                    SET promote = '${amount}'
                    WHERE author = '${author}' AND
                        permlink = '${permlink}';`, (err, res) => {
                    if (err) {
                        insertStats(stat)
                            .then(ret => {
                                r(ret)
                            })
                            .catch(errr => {
                                console.log(err, errr)
                                e(err, errr)
                            })
                    } else {
                        r(res)
                    }
                });
            })
    })
}

exports.getAuthorPosts = (req, res, next) => {
    let amt = parseInt(req.query.a),
        off = parseInt(req.query.o),
        author = req.params.author
    if (amt < 1) {
        amt = 50
    } else if (amt > 100) {
        amt = 100
    }
    if (off < 0) {
        off = 0
    }
    res.setHeader('Content-Type', 'application/json')
    getAuthorPosts(author, amt, off)
        .then(r => {
            res.send(JSON.stringify({
                result: r,
                node: config.username,
                VERSION
            }, null, 3))
        })
        .catch(e => {
            console.log(e)

        })
}

exports.getPost = (req, res, next) => {
    let permlink = req.params.permlink,
        author = req.params.author
    res.setHeader('Content-Type', 'application/json')
    getPost(author, permlink)
        .then(r => {
            res.send(JSON.stringify({
                result: r,
                node: config.username,
                VERSION
            }, null, 3))
        })
        .catch(e => {
            console.log(e)

        })
}

exports.coin = (req, res, next) => {
    var state = {}
    res.setHeader('Content-Type', 'application/json')
    store.get([], function (err, obj) {
        state = obj,
            supply = 0
        lbal = 0
        for (bal in state.balances) {
            supply += state.balances[bal]
            lbal += state.balances[bal]
        }
        var gov = 0,
            govt = 0
        var con = 0
        for (user in state.contracts) {
            for (contract in state.contracts[user]) {
                if (state.contracts[user][contract].amount && !state.contracts[user][contract].buyer && (state.contracts[user][contract].type == 'ss' || state.contracts[user][contract].type == 'ds')) {
                    supply += state.contracts[user][contract].amount
                    con += state.contracts[user][contract].amount
                }
            }
        }
        let coll = 0
        for (user in state.col) {
            supply += state.col[user]
            coll += state.col[user]
        }
        try { govt = state.gov.t - coll } catch (e) { }
        for (bal in state.gov) {
            if (bal != 't') {
                supply += state.gov[bal]
                gov += state.gov[bal]
            }
        }
        var pow = 0,
            powt = state.pow.t
        for (bal in state.pow) {
            if (bal != 't') {
                supply += state.pow[bal]
                pow += state.pow[bal]
            }
        }
        let info = {}
        let check = `supply check:state:${state.stats.tokenSupply} vs check: ${supply}: ${state.stats.tokenSupply - supply}`
        if (state.stats.tokenSupply != supply) {
            info = { lbal, gov, govt, pow, powt, con }
        }
        res.send(JSON.stringify({
            check,
            info,
            node: config.username,
            VERSION
        }, null, 3))
    });
}

exports.user = (req, res, next) => {
    let un = req.params.un,
        bal = getPathNum(['balances', un]),
        pb = getPathNum(['pow', un]),
        lp = getPathNum(['granted', un, 't']),
        lg = getPathNum(['granting', un, 't']),
        contracts = getPathObj(['contracts', un]),
        incol = getPathNum(['col', un]), //collateral
        gp = getPathNum(['gov', un]),
        pup = getPathObj(['up', un]),
        pdown = getPathObj(['down', un])
    res.setHeader('Content-Type', 'application/json');
    Promise.all([bal, pb, lp, contracts, incol, gp, pup, pdown, lg])
        .then(function (v) {
            console.log(bal, pb, lp, contracts)
            res.send(JSON.stringify({
                balance: v[0],
                poweredUp: v[1],
                granted: v[2],
                granting: v[8],
                heldCollateral: v[4],
                contracts: v[3],
                up: v[6],
                down: v[7],
                gov: v[5],
                node: config.username,
                VERSION
            }, null, 3))
        })
        .catch(function (err) {
            console.log(err)
        })
}

exports.blog = (req, res, next) => {
    let un = req.params.un
    res.setHeader('Content-Type', 'application/json')
    let unn = alphabeticShift(un)

    function alphabeticShift(inputString) {
        var newString = []
        for (var i = 0; i < inputString.length; i++) {
            if (i == inputString.length - 1) newString.push(String.fromCharCode(inputString.charCodeAt(i) + 1))
            else newString.push(String.fromCharCode(inputString.charCodeAt(i)))
        }
        return newString.join("")
    }
    store.someChildren(['posts'], {
        gte: un,
        lte: unn
    }, function (e, a) {
        let obj = {}
        for (p in a) {
            obj[a] = p[a]
        }
        res.send(JSON.stringify({
            blog: arr,
            node: config.username,
            VERSION
        }, null, 3))
    })
}

exports.state = (req, res, next) => {
    var state = {}
    res.setHeader('Content-Type', 'application/json')
    store.get([], function (err, obj) {
        state = obj,
            res.send(JSON.stringify({
                state,
                node: config.username,
                VERSION
            }, null, 3))
    });
}

exports.pending = (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(GetNodeOps(), null, 3))
}

//heroku force https

exports.https_redirect = (req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
        if (req.headers['x-forwarded-proto'] != 'https') {
            return res.redirect('https://' + req.headers.host + req.url);
        } else {
            return next();
        }
    } else {
        return next();
    }
};

//hive API helper functions

exports.hive_api = (req, res, next) => {
    let method = `${req.params.api_type}.${req.params.api_call}` || 'condenser_api.get_discussions_by_blog';
    let params = {};
    let array = false;
    for (param in req.query) {
        if (param == "0") {
            array = true;
            break;
        }
        params[param] = req.query[param];
    }
    if (array) {
        params = [];
        for (param in req.query) {
            params.push(req.query[param]);
        }
        params = [params];
    }
    switch (req.params.api_call) {
        case 'get_content':
            params = [params.author, params.permlink];
            break;
        case 'get_content_replies':
            params = [params.author, params.permlink];
            break;
        default:
    }
    res.setHeader('Content-Type', 'application/json');
    let body = {
        jsonrpc: "2.0",
        method,
        params,
        id: 1
    };
    fetch(config.clientURL, {
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        method: "POST"
    })
        .then(j => j.json())
        .then(r => {
            res.send(JSON.stringify(r, null, 3));
        });
}

exports.getwrap = (req, res, next) => {
    let method = req.query.method || 'condenser_api.get_discussions_by_blog';
    method.replace('%27', '');
    let iparams = JSON.parse(decodeURIcomponent((req.query.params.replace("%27", '')).replace('%2522', '%22')));
    switch (method) {
        case 'tags_api.get_discussions_by_blog':
        default:
            iparams = {
                tag: iparams[0]
            };
    }
    let params = iparams || { "tag": "robotolux" };
    res.setHeader('Content-Type', 'application/json');
    let body = {
        jsonrpc: "2.0",
        method,
        params,
        id: 1
    };
    fetch(config.clientURL, {
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        method: "POST"
    })
        .then(j => j.json())
        .then(r => {
            res.send(JSON.stringify(r, null, 3));
        });
}

exports.getpic = (req, res, next) => {
    let un = req.params.un || '';
    let body = {
        jsonrpc: "2.0",
        method: 'condenser_api.get_accounts',
        params: [
            [un]
        ],
        id: 1
    };
    fetch(config.clientURL, {
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        method: "POST"
    })
        .then(j => j.json())
        .then(r => {
            let image, i = 0;
            try {
                image = JSON.parse(r.result[0].json_metadata).profile.profile_image;
            } catch (e) {
                try {
                    i = 1;
                    image = JSON.parse(r.result[0].posting_json_metadata).profile.profile_image;
                } catch (e) {
                    i = 2;
                    image = 'https://a.ipfs.dlux.io/images/user-icon.svg';
                }
            }
            if (image) {
                fetch(image)
                    .then(response => {
                        response.body.pipe(res);
                    })
                    .catch(e => {
                        if (i == 0) {
                            try {
                                i = 1;
                                image = JSON.parse(r.result[0].posting_json_metadata).profile.profile_image;
                            } catch (e) {
                                i = 2;
                                image = 'https://a.ipfs.dlux.io/images/user-icon.svg';
                            }
                        } else {
                            i = 2;
                            image = 'https://a.ipfs.dlux.io/images/user-icon.svg';
                        }
                        fetch(image)
                            .then(response => {
                                response.body.pipe(res);
                            })
                            .catch(e => {
                                if (i == 1) {
                                    image = 'https://a.ipfs.dlux.io/images/user-icon.svg';
                                    fetch(image)
                                        .then(response => {
                                            response.body.pipe(res);
                                        })
                                        .catch(e => {
                                            res.status(404);
                                            res.send(e);

                                        });
                                } else {
                                    res.status(404);
                                    res.send(e);
                                }
                            });
                    });
            } else {
                res.status(404);
                res.send('Image not found');
            }
        });
}

exports.getblog = (req, res, next) => {
    let un = req.params.un;
    let start = req.query.s || 0;
    res.setHeader('Content-Type', 'application/json');
    fetch(config.clientURL, {
        body: `{\"jsonrpc\":\"2.0\", \"method\":\"follow_api.get_blog_entries\", \"params\":{\"account\":\"${un}\",\"start_entry_id\":${start},\"limit\":10}, \"id\":1}`,
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        method: "POST"
    })
        .then(j => j.json())
        .then(r => {
            var out = { items: [] };
            for (i in r.result) {
                r.result[i].media = { m: "https://a.ipfs.dlux.io/images/400X200.gif" };
            }
            out.id = r.id;
            out.jsonrpc = r.jsonrpc;
            out.items = r.result;
            res.send(JSON.stringify(out, null, 3));
        });
}