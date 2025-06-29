const { Pool } = require("pg");
const config = require("../config");
const fetch = require("node-fetch");
const sharp = require("sharp");
const vm = require('vm');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: config.dbcs,
});
let RAM = {};

const VERSION = process.env.npm_package_version || 'unknown';

let changes;
try {
  changes = require('./changes').changes || [];
} catch (e) {
  console.warn("Could not load ./changes.js, initializing with empty changes array.", e);
  changes = [];
}

async function insertData(initialChanges) {
  if (!initialChanges || initialChanges.length === 0) {
    console.log("No initial data to insert.");
    return;
  }
  const values = initialChanges.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(",");
  const query = `INSERT INTO posts (author, permlink, type) VALUES ${values} ON CONFLICT (author, permlink) DO NOTHING`;
  const flatValues = initialChanges.flatMap((change) => [change.author, change.permlink, change.type]);
  try {
    const res = await pool.query(query, flatValues);
    console.log(`Attempted to insert ${initialChanges.length} records. Inserted: ${res.rowCount}`);
  } catch (err) {
    console.error("Batch insert failed:", err);
  }
}

async function waitForDatabase(retries = 10, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("Database is ready");
      return true;
    } catch (err) {
      console.log(`Waiting for database... (${i + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  console.error("Database connection failed after retries");
  return false;
}

async function startApp() {
  const dbReady = await waitForDatabase();
  if (!dbReady) {
    console.error("Exiting application because database is not available.");
    process.exit(1);
  }
  await insertData(changes);
}

startApp();

// HTTPS redirect middleware (missing function that was causing the error)
exports.https_redirect = (req, res, next) => {
  // In production, redirect HTTP to HTTPS
  if (req.header('x-forwarded-proto') !== 'https' && process.env.NODE_ENV === 'production') {
    return res.redirect(`https://${req.header('host')}${req.url}`)
  }
  next()
}

exports.start = async (array) => {
  console.log('Start loading scripts:', array);
  const promises = [];
  for (const set in array) {
    console.log(`Calling pop for script ${array[set]} with set ${set}`);
    promises.push(pop(array[set], set, 3));
  }
  try {
    await Promise.all(promises);
    console.log('Finished loading scripts');
  } catch(error) {
    console.error("Error loading one or more scripts:", error)
  }
};

function pop(script, set, retriesLeft = 3) {
  return new Promise((resolve, reject) => {
    if (retriesLeft <= 0) {
      console.error(`Failed to load script ${script} for set ${set} after retries`);
      reject(new Error(`Failed to load script ${script} for set ${set}`));
      return;
    }

    console.log(`Attempting to fetch script ${script} for set ${set}, retries left: ${retriesLeft}`);
    fetch(`https://ipfs.dlux.io/ipfs/${script}`)
      .then((r) => {
        console.log(`Received response for ${script}, status: ${r.status}`);
        if (r.status !== 200) {
          setTimeout(() => {
            pop(script, set, retriesLeft - 1)
              .then(resolve)
              .catch(reject);
          }, 1000);
        } else {
          return r.text();
        }
      })
      .then((text) => {
        if (text) {
          RAM[script] = text;
          RAM[set] = script;
          console.log(`Loaded script ${script} for set ${set}`);
          resolve();
        }
      })
      .catch((e) => {
        console.error(`Error fetching script ${script}: ${e.message}`);
        setTimeout(() => {
          pop(script, set, retriesLeft - 1)
            .then(resolve)
            .catch(reject);
        }, 1000);
      });
  });
}

async function executeQuery(query, params = [], errorMessage = "Database query failed") {
    try {
        const result = await pool.query(query, params);
        return result;
    } catch (err) {
        console.error(errorMessage, err);
        throw new Error(errorMessage);
    }
}

function getStats(table) {
  return new Promise(async (resolve, reject) => {
    try {
      const query = `SELECT * FROM statssi;`;
      const res = await executeQuery(query, [], `Error - Failed to select all from statssi`);
      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

exports.createAuthorPost = async (req, res, next) => {
  const { amt = 50, off = 0, bitMask = 255 } = req.query;
  try {
    const results = await getSearchResults(req.params.author, amt, off, bitMask);
    res.send(JSON.stringify({ result: results, node: config.username }, null, 3));
  } catch (error) {
      console.error("Error in createAuthorPost:", error);
      res.status(500).send(JSON.stringify({ error: "Failed to search results", node: config.username }, null, 3));
  }
};

exports.createAuthor = async (req, res, next) => {
  const { amt = 50, off = 0, bitMask = 255 } = req.query;
  try {
      const results = await getSearchResults(req.params.author, amt, off, bitMask);
      res.send(JSON.stringify({ result: results, node: config.username }, null, 3));
  } catch (error) {
      console.error("Error in createAuthor:", error);
      res.status(500).send(JSON.stringify({ error: "Failed to search results", node: config.username }, null, 3));
  }
};

exports.getSearchResults = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50,
    off = parseInt(req.query.o) || 0,
    bitMask = parseInt(req.query.b) || 255;
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  try {
    const results = await getSearchResults(req.params.search_term, amt, off, bitMask);
    res.send(
      JSON.stringify(
        {
          result: results,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (error) {
    console.error("Error in getSearchResults endpoint:", error);
    res.status(500).send(JSON.stringify({ error: "Failed to search results", node: config.username }, null, 3));
  }
};

function getSearchResults(st, amt, off, bitMask) {
  return new Promise(async (resolve, reject) => {
    try {
      const types = typeMask(bitMask);
      if (types.length === 0) {
          resolve([]);
          return;
      }
      const query = `
          SELECT *
          FROM posts
          WHERE type = ANY($1) AND
              (author ILIKE $2 OR permlink ILIKE $3)
          ORDER BY block DESC
          OFFSET $4 ROWS FETCH FIRST $5 ROWS ONLY;`;
      const searchTerm = `%${st}%`;
      const params = [types, searchTerm, searchTerm, off, amt];
      const res = await executeQuery(query, params, 'Error - Failed to execute search query');

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function typeMask(bitMask) {
  const arr = [];
  if (bitMask & 1) arr.push("VR");
  if (bitMask & 2) arr.push("AR");
  if (bitMask & 4) arr.push("XR");
  if (bitMask & 8) arr.push("APP");
  if (bitMask & 16) arr.push("360");
  if (bitMask & 32) arr.push("3D");
  if (bitMask & 64) arr.push("Audio");
  if (bitMask & 128) arr.push("Video");
  return arr;
}

function getNewPosts(amt, off, bitMask) {
  return new Promise(async (resolve, reject) => {
    try {
      const types = typeMask(bitMask);
      if (types.length === 0) {
        resolve([]);
        return;
      }
      const query = `
        SELECT *
        FROM posts
        WHERE type = ANY($1)
        ORDER BY block DESC
        OFFSET $2 ROWS FETCH FIRST $3 ROWS ONLY;`;
      const params = [types, off, amt];
      const res = await executeQuery(query, params, 'Error - Failed to get new posts');

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getTrendingPosts(amt, off, bitMask) {
  return new Promise(async (resolve, reject) => {
    try {
      const types = typeMask(bitMask);
      if (types.length === 0) {
        resolve([]);
        return;
      }
      // Order by votes or some trending metric if available, otherwise by recent activity
      const query = `
        SELECT *
        FROM posts
        WHERE type = ANY($1)
        ORDER BY votes DESC, block DESC
        OFFSET $2 ROWS FETCH FIRST $3 ROWS ONLY;`;
      const params = [types, off, amt];
      const res = await executeQuery(query, params, 'Error - Failed to get trending posts');

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getDBPromotedPosts(amt, off, bitMask) {
  return new Promise(async (resolve, reject) => {
    try {
      const types = typeMask(bitMask);
      if (types.length === 0) {
        resolve([]);
        return;
      }
      // Order by some promotion metric if available, otherwise by votes
      const query = `
        SELECT *
        FROM posts
        WHERE type = ANY($1)
        ORDER BY promoted DESC, votes DESC, block DESC
        OFFSET $2 ROWS FETCH FIRST $3 ROWS ONLY;`;
      const params = [types, off, amt];
      const res = await executeQuery(query, params, 'Error - Failed to get promoted posts');

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

// New ReMix content functions
function getNewReMixPosts(amt, off, license = null, tag = null) {
  return new Promise(async (resolve, reject) => {
    try {
      let query = `
        SELECT *
        FROM posts
        WHERE remix_cid IS NOT NULL`;
      
      const params = [];
      let paramIndex = 1;
      
      if (license) {
        query += ` AND license = $${paramIndex}`;
        params.push(license);
        paramIndex++;
      }
      
      if (tag) {
        query += ` AND $${paramIndex} = ANY(tags)`;
        params.push(tag);
        paramIndex++;
      }
      
      query += ` ORDER BY block DESC OFFSET $${paramIndex} ROWS FETCH FIRST $${paramIndex + 1} ROWS ONLY;`;
      params.push(off, amt);
      
      const res = await executeQuery(query, params, 'Error - Failed to get new ReMix posts');

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getTrendingReMixPosts(amt, off, license = null, tag = null) {
  return new Promise(async (resolve, reject) => {
    try {
      let query = `
        SELECT *
        FROM posts
        WHERE remix_cid IS NOT NULL`;
      
      const params = [];
      let paramIndex = 1;
      
      if (license) {
        query += ` AND license = $${paramIndex}`;
        params.push(license);
        paramIndex++;
      }
      
      if (tag) {
        query += ` AND $${paramIndex} = ANY(tags)`;
        params.push(tag);
        paramIndex++;
      }
      
      query += ` ORDER BY votes DESC, block DESC OFFSET $${paramIndex} ROWS FETCH FIRST $${paramIndex + 1} ROWS ONLY;`;
      params.push(off, amt);
      
      const res = await executeQuery(query, params, 'Error - Failed to get trending ReMix posts');

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getReMixLicenses() {
  return new Promise(async (resolve, reject) => {
    try {
      const query = `
        SELECT license, COUNT(*) as count
        FROM posts
        WHERE remix_cid IS NOT NULL AND license IS NOT NULL
        GROUP BY license
        ORDER BY count DESC;`;
      
      const res = await executeQuery(query, [], 'Error - Failed to get ReMix licenses');
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getReMixTags() {
  return new Promise(async (resolve, reject) => {
    try {
      const query = `
        SELECT UNNEST(tags) as tag, COUNT(*) as count
        FROM posts
        WHERE remix_cid IS NOT NULL AND tags IS NOT NULL
        GROUP BY tag
        ORDER BY count DESC
        LIMIT 50;`;
      
      const res = await executeQuery(query, [], 'Error - Failed to get ReMix tags');
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

// New ReMix Application functions
function getPopularReMixApplications(amt, off) {
  return new Promise(async (resolve, reject) => {
    try {
      const query = `
        SELECT ra.*, COUNT(rd.id) as derivative_count
        FROM remix_applications ra
        LEFT JOIN remix_derivatives rd ON ra.remix_cid = rd.remix_cid
        GROUP BY ra.remix_cid
        ORDER BY ra.usage_count DESC, derivative_count DESC
        OFFSET $1 ROWS FETCH FIRST $2 ROWS ONLY;`;
      
      const res = await executeQuery(query, [off, amt], 'Error - Failed to get popular ReMix applications');
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getNewestReMixApplications(amt, off) {
  return new Promise(async (resolve, reject) => {
    try {
      const query = `
        SELECT ra.*, COUNT(rd.id) as derivative_count
        FROM remix_applications ra
        LEFT JOIN remix_derivatives rd ON ra.remix_cid = rd.remix_cid
        GROUP BY ra.remix_cid
        ORDER BY ra.created_at DESC
        OFFSET $1 ROWS FETCH FIRST $2 ROWS ONLY;`;
      
      const res = await executeQuery(query, [off, amt], 'Error - Failed to get newest ReMix applications');
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getReMixApplicationDetails(remixCid) {
  return new Promise(async (resolve, reject) => {
    try {
      // Get application details
      const appQuery = `
        SELECT ra.*, COUNT(rd.id) as derivative_count
        FROM remix_applications ra
        LEFT JOIN remix_derivatives rd ON ra.remix_cid = rd.remix_cid
        WHERE ra.remix_cid = $1
        GROUP BY ra.remix_cid;`;
      
      const appRes = await executeQuery(appQuery, [remixCid], 'Error - Failed to get ReMix application details');
      
      if (appRes.rows.length === 0) {
        resolve(null);
        return;
      }
      
      // Get derivative works
      const derivativesQuery = `
        SELECT rd.*, p.votes, p.voteweight
        FROM remix_derivatives rd
        LEFT JOIN posts p ON rd.author = p.author AND rd.permlink = p.permlink
        WHERE rd.remix_cid = $1
        ORDER BY rd.created_at DESC;`;
      
      const derivativesRes = await executeQuery(derivativesQuery, [remixCid], 'Error - Failed to get derivative works');
      
      const result = {
        application: appRes.rows[0],
        derivatives: derivativesRes.rows
      };
      
      resolve(result);
    } catch (err) {
      reject(err);
    }
  });
}

function getDerivativeWorksByAuthor(author, amt, off) {
  return new Promise(async (resolve, reject) => {
    try {
      const query = `
        SELECT rd.*, ra.title as app_title, ra.license as app_license,
               p.votes, p.voteweight
        FROM remix_derivatives rd
        JOIN remix_applications ra ON rd.remix_cid = ra.remix_cid
        LEFT JOIN posts p ON rd.author = p.author AND rd.permlink = p.permlink
        WHERE rd.author = $1
        ORDER BY rd.created_at DESC
        OFFSET $2 ROWS FETCH FIRST $3 ROWS ONLY;`;
      
      const res = await executeQuery(query, [author, off, amt], 'Error - Failed to get derivative works by author');
      
      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getReMixApplicationStats() {
  return new Promise(async (resolve, reject) => {
    try {
      // Get total applications
      const totalQuery = 'SELECT COUNT(*) as total FROM remix_applications';
      const totalRes = await executeQuery(totalQuery, [], 'Error counting ReMix applications');
      
      // Get total derivative works
      const derivativesQuery = 'SELECT COUNT(*) as total FROM remix_derivatives';
      const derivativesRes = await executeQuery(derivativesQuery, [], 'Error counting derivative works');
      
      // Get most popular application
      const popularQuery = `
        SELECT remix_cid, usage_count, first_author, title
        FROM remix_applications
        ORDER BY usage_count DESC
        LIMIT 1`;
      const popularRes = await executeQuery(popularQuery, [], 'Error getting most popular app');
      
      // Get recent activity (last 7 days)
      const recentQuery = `
        SELECT COUNT(*) as recent
        FROM remix_derivatives
        WHERE created_at > NOW() - INTERVAL '7 days'`;
      const recentRes = await executeQuery(recentQuery, [], 'Error counting recent activity');
      
      const stats = {
        totalApplications: parseInt(totalRes.rows[0].total),
        totalDerivativeWorks: parseInt(derivativesRes.rows[0].total),
        mostPopular: popularRes.rows[0] || null,
        recentActivity: parseInt(recentRes.rows[0].recent)
      };
      
      resolve(stats);
    } catch (err) {
      reject(err);
    }
  });
}

exports.getPromotedPosts = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  let bitMask = parseInt(req.query.b) || 255;
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getDBPromotedPosts(amt, off, bitMask);
    res.send(
      JSON.stringify(
        {
          result: results,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting promoted posts:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get promoted posts", node: config.username }, null, 3));
  }
};

const tickers = {
  duat: {
    api: "https://duat.hivehoneycomb.com/",
    token: "DUAT",
    tick: "",
    hbd_tick: "",
    change: "",
    vol: 0
  },
  dlux: {
    api: config.honeycombapi,
    token: "DLUX",
    tick: "",
    hbd_tick: "",
    change: "",
    vol: 0
  },
  larynx: {
    api: "https://spktest.dlux.io/",
    token: "LARYNX",
    tick: "",
    hbd_tick: "",
    change: "",
    vol: 0
  },
  spk: {
    api: "https://spktest.dlux.io/spk/",
    token: "SPK",
    tick: "",
    hbd_tick: "",
    change: "",
    vol: 0
  },
  broca: {
    api: "https://spktest.dlux.io/broca/",
    token: "BROCA",
    tick: "",
    hbd_tick: "",
    change: "",
    vol: 0
  },
};

exports.tickers = (req, res, next) => {
  const r = [];
  for (const token in tickers) {
    r.push(tickers[token]);
  }
  res.send(
    JSON.stringify(
      {
        tickers: r,
        node: config.username,
      },
      null,
      3
    )
  );
};

exports.stats = async (req, res, next) => {
  try {
    const query = `SELECT COUNT(*) AS record_count FROM posts;`;
    const r = await executeQuery(query, [], "Error fetching post count");
    res.send(
      JSON.stringify(
        {
          number_of_dApps: parseInt(r.rows[0].record_count, 10),
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (err) {
    res.status(500).send(
      JSON.stringify(
        {
          error: "Failed to retrieve stats",
          node: config.username,
        },
        null,
        3
      )
    );
  }
};

async function fetchDex(tok) {
  try {
    const response = await fetch(`${tickers[tok].api}dex`);
    if (!response.ok) {
        throw new Error(`Failed to fetch DEX for ${tok}: ${response.statusText}`);
    }
    const res = await response.json();

    const dex = res.markets;
    if (!dex || !dex.hive || !dex.hbd) {
        console.warn(`Incomplete DEX data received for ${tok}`);
        return;
    }

    tickers[tok].tick = dex.hive.tick || "";
    tickers[tok].hbd_tick = dex.hbd.tick || "";

    let changePrice = tickers[tok].tick;
    let earliestTime = new Date().getTime();
    const twentyFourHoursAgo = new Date().getTime() - 86400000;
    let vol = 0;

    if (dex.hive.his && Array.isArray(dex.hive.his)) {
      for (const trade of dex.hive.his) {
        if (trade.t < earliestTime && trade.t > twentyFourHoursAgo) {
          changePrice = trade.price;
          earliestTime = trade.t;
        }
        if (trade.t > twentyFourHoursAgo) {
          vol += trade.target_vol || 0;
        }
      }
    }

    if (changePrice && typeof changePrice === 'number' && changePrice !== 0 && tickers[tok].tick && typeof tickers[tok].tick === 'number') {
        tickers[tok].change = parseFloat(
            ((tickers[tok].tick / changePrice) - 1) * 100
        ).toFixed(4);
    } else {
        tickers[tok].change = "0.0000";
    }
    tickers[tok].vol = vol;

  } catch (e) {
    console.error(`Error fetching DEX data for ${tok}:`, e);
    tickers[tok].tick = "";
    tickers[tok].hbd_tick = "";
    tickers[tok].change = "";
    tickers[tok].vol = 0;
  }
}

let isFetchingTickers = false;
let tickerTimeoutId = null;

async function getTickers() {
  if (isFetchingTickers) {
    console.log("Ticker fetch already in progress, skipping.");
    return;
  }
  isFetchingTickers = true;
  console.log("Fetching tickers...");

  if (tickerTimeoutId) {
    clearTimeout(tickerTimeoutId);
    tickerTimeoutId = null;
  }

  try {
    const fetchPromises = [];
    for (const tok in tickers) {
      fetchPromises.push(fetchDex(tok));
    }
    await Promise.all(fetchPromises);
    console.log("Finished fetching tickers.");
  } catch (e) {
    console.error("An error occurred during the ticker fetch cycle:", e);
  } finally {
    isFetchingTickers = false;
    tickerTimeoutId = setTimeout(getTickers, 60000);
  }
}

getTickers();

async function getDetails(uid, script, opt, req) {
  const startTime = Date.now();
  let scriptHash = null;
  let executionSuccess = false;
  let executionError = null;
  
  try {
    if (!RAM[script]) {
      throw new Error(`Script ${script} not loaded`);
    }
    
    scriptHash = calculateScriptHash(RAM[script]);
    
        const whitelistEntry = await checkScriptWhitelist(scriptHash);
    if (!whitelistEntry) {
      await addScriptToReview(
        scriptHash,
        RAM[script], 
        'getDetails', 
        req?.user?.username || 'anonymous',
        { uid, opt, script }
      );
      
      console.log(`Script ${scriptHash} not whitelisted - execution blocked`);
      throw new Error(`Script execution blocked: Script ${scriptHash} is not whitelisted. It has been submitted for review.`);
    }
    
    const sanitizedUid = sanitizeInput(uid, 100);
    const sanitizedExe = opt?.exe ? sanitizeInput(opt.exe, 255) : '';
    
    if (!sanitizedUid || (opt?.exe && !sanitizedExe)) {
      throw new Error('Invalid or potentially dangerous input parameters');
    }
    
    const context = {
      console: {
        log: (...args) => console.log('[SANDBOX]', ...args),
        warn: (...args) => console.warn('[SANDBOX]', ...args),
        error: (...args) => console.error('[SANDBOX]', ...args)
      },
      Math: Math,
      JSON: JSON,
      Array: Array,
      Object: Object,
      String: String,
      Number: Number,
      Boolean: Boolean,
      Date: Date
    };
    
    // Extract JavaScript from HTML script if needed
    let scriptContent = RAM[script];
    if (scriptContent.includes('<!DOCTYPE html>') || scriptContent.includes('<html>')) {
      // Extract JavaScript from HTML
      const scriptMatch = scriptContent.match(/<script[^>]*>([\s\S]*?)<\/script>/);
      if (scriptMatch && scriptMatch[1]) {
        scriptContent = scriptMatch[1].trim();
        // Remove HTML comments if present
        scriptContent = scriptContent.replace(/\/\/<.*?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
      }
    }

    const codeToRun = `(function() {
      const scriptFunc = ${scriptContent};
      return scriptFunc(${JSON.stringify(sanitizedUid)}, ${opt?.exe ? JSON.stringify(sanitizedExe) : 'undefined'});
    })()`;

    const NFT = vm.runInNewContext(codeToRun, vm.createContext(context), { 
      timeout: 1000,
      displayErrors: false
    });

    if (!NFT || typeof NFT.attributes === 'undefined' || typeof NFT.set === 'undefined') {
        throw new Error(`Invalid NFT object structure from script ${script}`);
    }
    
    executionSuccess = true;
    return { attributes: NFT.attributes, set: NFT.set, opt };
    
  } catch (evalError) {
    executionError = evalError.message || evalError.toString();
    console.error(`Error evaluating script ${script} for getDetails:`, evalError);
    throw evalError;
  } finally {
    const executionTime = Date.now() - startTime;
    if (scriptHash) {
      await logScriptExecution(
        scriptHash, 
        req?.user?.username || 'anonymous',
        { uid, opt, function: 'getDetails' },
        executionSuccess,
        executionError,
        executionTime,
        req
      );
    }
  }
}

async function makePNG(uid, script, opt, req) {
  const startTime = Date.now();
  let scriptHash = null;
  let executionSuccess = false;
  let executionError = null;
  
  try {
    if (!RAM[script]) {
        console.error(`Script ${script} not loaded for makePNG`);
        console.log(`Attempting to load missing script ${script} on demand...`);
        try {
            await pop(script, `unknown_set_for_${script}`, 1);
            if (!RAM[script]) {
                throw new Error(`Failed to load script ${script} on demand.`);
            }
            console.log(`Successfully loaded script ${script} on demand.`);
        } catch (loadError) {
            console.error(`Failed to load script ${script} on demand:`, loadError);
            throw new Error(`Script ${script} is not loaded and could not be fetched.`);
        }
    }
    
    scriptHash = calculateScriptHash(RAM[script]);
    
    const whitelistEntry = await checkScriptWhitelist(scriptHash);
    if (!whitelistEntry) {
      await addScriptToReview(
        scriptHash,
        RAM[script],
        'makePNG',
        req?.user?.username || 'anonymous',
        { uid, opt, script }
      );
      
      console.log(`Script ${scriptHash} not whitelisted - execution blocked`);
      throw new Error(`Script execution blocked: Script ${scriptHash} is not whitelisted. It has been submitted for review.`);
    }

    const sanitizedUid = sanitizeInput(uid, 100);
    const sanitizedOpt = opt ? sanitizeInput(opt, 255) : '';
    
    if (!sanitizedUid || (opt && !sanitizedOpt)) {
      throw new Error('Invalid or potentially dangerous input parameters');
    }

    const context = {
      console: {
        log: (...args) => console.log('[SANDBOX]', ...args),
        warn: (...args) => console.warn('[SANDBOX]', ...args),
        error: (...args) => console.error('[SANDBOX]', ...args)
      },
      Math: Math,
      JSON: JSON,
      Array: Array,
      Object: Object,
      String: String,
      Number: Number,
      Boolean: Boolean,
      Date: Date
    };

    // Extract JavaScript from HTML script if needed
    let scriptContent = RAM[script];
    if (scriptContent.includes('<!DOCTYPE html>') || scriptContent.includes('<html>')) {
      // Extract JavaScript from HTML
      const scriptMatch = scriptContent.match(/<script[^>]*>([\s\S]*?)<\/script>/);
      if (scriptMatch && scriptMatch[1]) {
        scriptContent = scriptMatch[1].trim();
        // Remove HTML comments if present
        scriptContent = scriptContent.replace(/\/\/<.*?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
      }
    }

    const codeToRun = `(function() {
      const scriptFunc = ${scriptContent};
      return scriptFunc(${JSON.stringify(sanitizedUid)}, ${opt ? JSON.stringify(sanitizedOpt) : 'undefined'});
    })()`;

    const NFT = vm.runInNewContext(codeToRun, vm.createContext(context), { 
      timeout: 1000,
      displayErrors: false
    });

    if (!NFT || typeof NFT.HTML !== 'string') {
        throw new Error(`Script ${script} did not return a valid NFT object with HTML string`);
    }
    
    executionSuccess = true;
    const htmlContent = NFT.HTML.trim();
    
    if (htmlContent.length > 1000000) {
      throw new Error('Generated HTML content exceeds size limit');
    }

    if (htmlContent.startsWith("<svg")) {
      console.log("Generating PNG from SVG");
      try {
        const buffer = await sharp(Buffer.from(htmlContent))
          .resize(333, 333, {
            kernel: sharp.kernel.nearest,
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .png()
          .toBuffer();
        return [buffer, "png"];
      } catch (svgError) {
          console.error("Error converting SVG to PNG:", svgError);
          throw new Error("Failed to convert SVG to PNG");
      }
    }
    else if (htmlContent.includes("data:image/")) {
        console.log("Generating PNG from composite Base64");
        try {
          const parts = htmlContent.split('data:image/');
          if (parts.length < 2) throw new Error("No valid base64 image data found.");

          const basePart = parts[1].split(';base64,');
          if (basePart.length < 2) throw new Error("Invalid base64 image data format for base image.");
          const baseImageData = basePart[1].split('"')[0];
          const baseBuffer = Buffer.from(baseImageData, "base64");

          const compositeInputs = [];
          for (let i = 2; i < parts.length; i++) {
              const layerPart = parts[i].split(';base64,');
              if (layerPart.length < 2) {
                  console.warn(`Skipping invalid base64 image data format for layer ${i-1}`);
                  continue;
              }
              const layerImageData = layerPart[1].split('"')[0];
              compositeInputs.push({
                  input: Buffer.from(layerImageData, "base64"),
              });
          }

          const finalBuffer = await sharp(baseBuffer)
              .composite(compositeInputs)
              .png()
              .toBuffer();

          return [finalBuffer, "png"];

        } catch (compositeError) {
            console.error("Error composing PNG from Base64:", compositeError);
            throw new Error("Failed to compose PNG from Base64 data");
        }
    }
    else {
      console.error("Unsupported NFT.HTML format for image generation:", htmlContent.substring(0, 100) + "...");
      throw new Error("Unsupported format for image generation");
    }
  } catch(error) {
    executionError = error.message || error.toString();
    console.error(`Error in makePNG for script ${script}:`, error);
    throw error;
  } finally {
    const executionTime = Date.now() - startTime;
    if (scriptHash) {
      await logScriptExecution(
        scriptHash,
        req?.user?.username || 'anonymous',
        { uid, opt, function: 'makePNG' },
        executionSuccess,
        executionError,
        executionTime,
        req
      );
    }
  }
}

exports.detailsNFT = async (req, res, next) => {
  const { uid, script: scriptParam, set: setParam } = req.params;
  const { opt, exe } = req.query;

  let script = scriptParam;
  if (!RAM[script] && setParam && RAM[setParam]) {
    script = RAM[setParam];
    console.log(`Using script ${script} mapped from set ${setParam}`);
  } else if (!RAM[script]) {
       res.status(404).send(
        JSON.stringify(
          {
            error: `Script ${scriptParam || setParam} not loaded or found.`,
          },
          null,
          3
        )
      );
      return;
  }

  try {
    const details = await getDetails(uid, script, { opt, exe }, req);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(details, null, 3));
  } catch (e) {
    console.error(`Error getting NFT details for ${uid}, script ${script}:`, e);
    res.status(500).send(
      JSON.stringify(
        {
          error: "Failed to get NFT details.",
          details: e.message || e
        },
        null,
        3
      )
    );
  }
};

exports.renderNFT = async (req, res, next) => {
  const { uid, script: scriptParam, set: setParam } = req.params;
  const { exe } = req.query;

  let script = scriptParam;
  if (!RAM[script] && setParam && RAM[setParam]) {
      script = RAM[setParam];
      console.log(`Using script ${script} mapped from set ${setParam}`);
  } else if (!RAM[script]) {
       res.status(404).send(
        JSON.stringify(
          {
            error: `Script ${scriptParam || setParam} not loaded or found.`,
            node: config.username,
            text: RAM[scriptParam]?.substr(0, 100) + '...' || 'Script not in RAM'
          },
          null,
          3
        )
      );
      return;
  }

  try {
    const [imgBuffer, imgType] = await makePNG(uid, script, exe, req);
    res.setHeader("Content-Type", `image/${imgType}`);
    res.send(imgBuffer);
  } catch (e) {
    console.error(`Error rendering NFT for UID ${uid}, script ${script}:`, e);
    res.status(500).send(
      JSON.stringify(
        {
          error: "Failed to render NFT image.",
          details: e.message || e,
          node: config.username,
          script: script,
          script_preview: RAM[script]?.substr(0, 100) + '...' || 'Script not in RAM'
        },
        null,
        3
      )
    );
  }
};

exports.getPFP = async (req, res, next) => {
  const user = req.params.user;
  try {
    const response = await fetch(`${config.honeycombapi}api/pfp/${user}`);
    if (!response.ok) throw new Error(`Honeycomb API request failed: ${response.statusText}`);

    const json = await response.json();

    if (json.result && typeof json.result !== 'string' && json.result.length > 0) {
      const pfpData = json.result[0];
      const script = pfpData?.set?.s || "";
      const uid = pfpData?.pfp?.split(":")[1] || "";
      const setType = pfpData?.set?.t;
      const nftS = pfpData?.nft?.s;
      const exe = (setType == 2 || setType == 4) && typeof nftS === 'string' ? nftS.split(",")[1] : "";

      if (!script || !uid) {
          throw new Error("Incomplete PFP data received from Honeycomb API (missing script or UID)");
      }

      console.log({ user, uid, script, exe });

      try {
        const [imgBuffer, imgType] = await makePNG(uid, script, exe, req);
        res.setHeader("Content-Type", `image/${imgType}`);
        res.send(imgBuffer);
      } catch (renderError) {
          console.error(`Error rendering PFP for ${user} (uid: ${uid}, script: ${script}):`, renderError);
          res.status(500).send(
              JSON.stringify(
                {
                  error: "Error generating PFP image.",
                  details: renderError.message || renderError,
                  script: script,
                  script_preview: RAM[script]?.substr(0, 100) + '...' || 'Script not in RAM',
                  node: config.username,
                },
                null,
                3
              )
            );
      }
    } else {
       res.status(404).send(
        JSON.stringify(
          {
            result: json.result || "No PFP set or error fetching PFP data.",
            node: config.username,
          },
          null,
          3
        )
      );
    }
  } catch (fetchError) {
    console.error(`Error fetching PFP for ${user}:`, fetchError);
    res.status(500).send(
      JSON.stringify(
        {
          error: "Failed to fetch PFP information.",
          details: fetchError.message || fetchError,
          node: config.username,
        },
        null,
        3
      )
    );
  }
};

// API endpoints for posts management

exports.getPosts = async (req, res, next) => {
  const { limit = 100, offset = 0, type, search, nsfw, hidden, featured, flagged } = req.query;
  
  try {
    let whereClause = '';
    const params = [];
    let paramIndex = 1;
    
    if (type) {
      whereClause += `WHERE type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }
    
    if (search) {
      const searchCondition = `(author ILIKE $${paramIndex} OR permlink ILIKE $${paramIndex})`;
      if (whereClause) {
        whereClause += ` AND ${searchCondition}`;
      } else {
        whereClause = `WHERE ${searchCondition}`;
      }
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    // Filter by content flags
    if (nsfw !== undefined) {
      const nsfwCondition = `nsfw = $${paramIndex}`;
      if (whereClause) {
        whereClause += ` AND ${nsfwCondition}`;
      } else {
        whereClause = `WHERE ${nsfwCondition}`;
      }
      params.push(nsfw === 'true');
      paramIndex++;
    }
    
    if (hidden !== undefined) {
      const hiddenCondition = `hidden = $${paramIndex}`;
      if (whereClause) {
        whereClause += ` AND ${hiddenCondition}`;
      } else {
        whereClause = `WHERE ${hiddenCondition}`;
      }
      params.push(hidden === 'true');
      paramIndex++;
    }
    
    if (featured !== undefined) {
      const featuredCondition = `featured = $${paramIndex}`;
      if (whereClause) {
        whereClause += ` AND ${featuredCondition}`;
      } else {
        whereClause = `WHERE ${featuredCondition}`;
      }
      params.push(featured === 'true');
      paramIndex++;
    }
    
    if (flagged !== undefined) {
      const flaggedCondition = `flagged = $${paramIndex}`;
      if (whereClause) {
        whereClause += ` AND ${flaggedCondition}`;
      } else {
        whereClause = `WHERE ${flaggedCondition}`;
      }
      params.push(flagged === 'true');
      paramIndex++;
    }
    
    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM posts ${whereClause}`;
    const countResult = await executeQuery(countQuery, params, 'Error counting posts');
    const totalCount = parseInt(countResult.rows[0].total);
    
    // Get posts with pagination
    const postsQuery = `
      SELECT author, permlink, type, block, votes, voteweight, promote, paid,
             nsfw, sensitive, hidden, featured, flagged, flag_reason, 
             moderated_by, moderated_at
      FROM posts 
      ${whereClause}
      ORDER BY block DESC 
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(parseInt(limit), parseInt(offset));
    
    const postsResult = await executeQuery(postsQuery, params, 'Error fetching posts');
    
    // Add URL to each post
    const posts = postsResult.rows.map(post => ({
      ...post,
      url: `/dlux/@${post.author}/${post.permlink}`
    }));
    
    res.json({
      posts,
      totalCount,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
  } catch (error) {
    console.error('Error in getPosts:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
};

exports.getPostsStats = async (req, res, next) => {
  try {
    // Get total posts
    const totalQuery = 'SELECT COUNT(*) as total FROM posts';
    const totalResult = await executeQuery(totalQuery, [], 'Error counting total posts');
    
    // Get unique authors
    const authorsQuery = 'SELECT COUNT(DISTINCT author) as authors FROM posts';
    const authorsResult = await executeQuery(authorsQuery, [], 'Error counting authors');
    
    // Get unique types
    const typesQuery = 'SELECT COUNT(DISTINCT type) as types FROM posts';
    const typesResult = await executeQuery(typesQuery, [], 'Error counting types');
    
    // Get recent posts (last 24 hours, assuming block numbers are recent)
    const recentQuery = `
      SELECT COUNT(*) as recent 
      FROM posts 
      WHERE block > (SELECT MAX(block) - 2880 FROM posts)
    `;
    const recentResult = await executeQuery(recentQuery, [], 'Error counting recent posts');
    
    const stats = {
      total: parseInt(totalResult.rows[0].total),
      authors: parseInt(authorsResult.rows[0].authors),
      types: parseInt(typesResult.rows[0].types),
      recent: parseInt(recentResult.rows[0].recent)
    };
    
    res.json({ stats });
    
  } catch (error) {
    console.error('Error in getPostsStats:', error);
    res.status(500).json({ error: 'Failed to fetch posts statistics' });
  }
};

exports.createPost = async (req, res, next) => {
  const { 
    author, permlink, type, block, votes = 0, voteweight = 0, promote = 0, paid = false,
    nsfw = false, sensitive = false, hidden = false, featured = false, 
    flagged = false, flag_reason = null, moderated_by = null
  } = req.body;
  
  if (!author || !permlink || !type) {
    return res.status(400).json({ error: 'Author, permlink, and type are required' });
  }
  
  try {
    const query = `
      INSERT INTO posts (author, permlink, type, block, votes, voteweight, promote, paid,
                        nsfw, sensitive, hidden, featured, flagged, flag_reason, 
                        moderated_by, moderated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (author, permlink) DO NOTHING
      RETURNING *
    `;
    const moderated_at = (nsfw || sensitive || hidden || featured || flagged) && moderated_by ? new Date() : null;
    const params = [author, permlink, type, block, votes, voteweight, promote, paid,
                   nsfw, sensitive, hidden, featured, flagged, flag_reason, 
                   moderated_by, moderated_at];
    
    const result = await executeQuery(query, params, 'Error creating post');
    
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Post already exists' });
    }
    
    const post = result.rows[0];
    post.url = `/dlux/@${post.author}/${post.permlink}`;
    
    res.status(201).json({ post });
    
  } catch (error) {
    console.error('Error in createPost:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
};

exports.updatePost = async (req, res, next) => {
  const { author, permlink } = req.params;
  const { 
    type, block, votes, voteweight, promote, paid,
    nsfw, sensitive, hidden, featured, flagged, flag_reason, moderated_by
  } = req.body;
  
  try {
    const updates = [];
    const params = [];
    let paramIndex = 1;
    let moderationChanged = false;
    
    if (type !== undefined) {
      updates.push(`type = $${paramIndex}`);
      params.push(type);
      paramIndex++;
    }
    if (block !== undefined) {
      updates.push(`block = $${paramIndex}`);
      params.push(block);
      paramIndex++;
    }
    if (votes !== undefined) {
      updates.push(`votes = $${paramIndex}`);
      params.push(votes);
      paramIndex++;
    }
    if (voteweight !== undefined) {
      updates.push(`voteweight = $${paramIndex}`);
      params.push(voteweight);
      paramIndex++;
    }
    if (promote !== undefined) {
      updates.push(`promote = $${paramIndex}`);
      params.push(promote);
      paramIndex++;
    }
    if (paid !== undefined) {
      updates.push(`paid = $${paramIndex}`);
      params.push(paid);
      paramIndex++;
    }
    if (nsfw !== undefined) {
      updates.push(`nsfw = $${paramIndex}`);
      params.push(nsfw);
      paramIndex++;
      moderationChanged = true;
    }
    if (sensitive !== undefined) {
      updates.push(`sensitive = $${paramIndex}`);
      params.push(sensitive);
      paramIndex++;
      moderationChanged = true;
    }
    if (hidden !== undefined) {
      updates.push(`hidden = $${paramIndex}`);
      params.push(hidden);
      paramIndex++;
      moderationChanged = true;
    }
    if (featured !== undefined) {
      updates.push(`featured = $${paramIndex}`);
      params.push(featured);
      paramIndex++;
      moderationChanged = true;
    }
    if (flagged !== undefined) {
      updates.push(`flagged = $${paramIndex}`);
      params.push(flagged);
      paramIndex++;
      moderationChanged = true;
    }
    if (flag_reason !== undefined) {
      updates.push(`flag_reason = $${paramIndex}`);
      params.push(flag_reason);
      paramIndex++;
    }
    if (moderated_by !== undefined) {
      updates.push(`moderated_by = $${paramIndex}`);
      params.push(moderated_by);
      paramIndex++;
    }
    
    // Update moderated_at timestamp if any moderation flags were changed
    if (moderationChanged && moderated_by) {
      updates.push(`moderated_at = $${paramIndex}`);
      params.push(new Date());
      paramIndex++;
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    const query = `
      UPDATE posts 
      SET ${updates.join(', ')}
      WHERE author = $${paramIndex} AND permlink = $${paramIndex + 1}
      RETURNING *
    `;
    params.push(author, permlink);
    
    const result = await executeQuery(query, params, 'Error updating post');
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const post = result.rows[0];
    post.url = `/dlux/@${post.author}/${post.permlink}`;
    
    res.json({ post });
    
  } catch (error) {
    console.error('Error in updatePost:', error);
    res.status(500).json({ error: 'Failed to update post' });
  }
};

exports.deletePost = async (req, res, next) => {
  const { author, permlink } = req.params;
  
  try {
    const query = `
      DELETE FROM posts 
      WHERE author = $1 AND permlink = $2
      RETURNING author, permlink
    `;
    const params = [author, permlink];
    
    const result = await executeQuery(query, params, 'Error deleting post');
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    res.json({ message: 'Post deleted successfully' });
    
  } catch (error) {
    console.error('Error in deletePost:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
};

exports.updatePostFlags = async (req, res, next) => {
  const { author, permlink } = req.params;
  const { 
    nsfw, sensitive, hidden, featured, flagged, flag_reason, moderated_by
  } = req.body;
  
  if (!moderated_by) {
    return res.status(400).json({ error: 'moderated_by is required for flag operations' });
  }
  
  try {
    const updates = [];
    const params = [];
    let paramIndex = 1;
    
    if (nsfw !== undefined) {
      updates.push(`nsfw = $${paramIndex}`);
      params.push(nsfw);
      paramIndex++;
    }
    if (sensitive !== undefined) {
      updates.push(`sensitive = $${paramIndex}`);
      params.push(sensitive);
      paramIndex++;
    }
    if (hidden !== undefined) {
      updates.push(`hidden = $${paramIndex}`);
      params.push(hidden);
      paramIndex++;
    }
    if (featured !== undefined) {
      updates.push(`featured = $${paramIndex}`);
      params.push(featured);
      paramIndex++;
    }
    if (flagged !== undefined) {
      updates.push(`flagged = $${paramIndex}`);
      params.push(flagged);
      paramIndex++;
    }
    if (flag_reason !== undefined) {
      updates.push(`flag_reason = $${paramIndex}`);
      params.push(flag_reason);
      paramIndex++;
    }
    
    // Always update moderation metadata
    updates.push(`moderated_by = $${paramIndex}`);
    params.push(moderated_by);
    paramIndex++;
    
    updates.push(`moderated_at = $${paramIndex}`);
    params.push(new Date());
    paramIndex++;
    
    if (updates.length === 2) { // Only moderated_by and moderated_at were added
      return res.status(400).json({ error: 'No flags to update' });
    }
    
    const query = `
      UPDATE posts 
      SET ${updates.join(', ')}
      WHERE author = $${paramIndex} AND permlink = $${paramIndex + 1}
      RETURNING *
    `;
    params.push(author, permlink);
    
    const result = await executeQuery(query, params, 'Error updating post flags');
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const post = result.rows[0];
    post.url = `/dlux/@${post.author}/${post.permlink}`;
    
    res.json({ 
      message: 'Post flags updated successfully',
      post 
    });
    
  } catch (error) {
    console.error('Error in updatePostFlags:', error);
    res.status(500).json({ error: 'Failed to update post flags' });
  }
};

// Test endpoint to verify flag functionality
exports.testFlags = async (req, res, next) => {
  try {
    // Test if the new columns exist
    const testQuery = `
      SELECT nsfw, sensitive, hidden, featured, flagged, flag_reason, moderated_by, moderated_at 
      FROM posts 
      LIMIT 1
    `;
    
    const result = await executeQuery(testQuery, [], 'Testing flag columns');
    
    // Test flag_reports table
    const flagReportsQuery = 'SELECT COUNT(*) as count FROM flag_reports';
    const flagReportsResult = await executeQuery(flagReportsQuery, [], 'Testing flag_reports table');
    
    // Test flag_user_stats table
    const userStatsQuery = 'SELECT COUNT(*) as count FROM flag_user_stats';
    const userStatsResult = await executeQuery(userStatsQuery, [], 'Testing flag_user_stats table');
    
    res.json({
      message: 'Community flagging system is ready',
      posts_table: {
        has_flag_columns: result.rows.length > 0,
        sample: result.rows[0] || null
      },
      flag_reports_table: {
        exists: true,
        count: parseInt(flagReportsResult.rows[0].count)
      },
      flag_user_stats_table: {
        exists: true,
        count: parseInt(userStatsResult.rows[0].count)
      },
      available_endpoints: {
        public: [
          'POST /api/flags/report - Submit flag report (requires auth)',
          'GET /api/flags/users/{username}/stats - Get user flag statistics'
        ],
        admin: [
          'GET /api/flags/pending - Get pending flag reports',
          'POST /api/flags/review/{reportId} - Accept/reject flag reports',
          'PUT /api/flags/users/{username}/permissions - Manage user flag permissions'
        ]
      },
      demo_page: '/api/public-flag-demo.html',
      node: config.username
    });
    
  } catch (error) {
    console.error('Error testing flags:', error);
    res.status(500).json({ 
      error: 'Community flagging system not properly initialized',
      details: error.message,
      node: config.username 
    });
  }
};

// Public endpoint for users to submit flag reports
exports.submitFlagReport = async (req, res, next) => {
  const { post_author, post_permlink, flag_type, reason } = req.body;
  const reporter_account = req.user?.username; // From auth middleware
  
  if (!reporter_account) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (!post_author || !post_permlink || !flag_type) {
    return res.status(400).json({ error: 'post_author, post_permlink, and flag_type are required' });
  }
  
  const validFlagTypes = ['nsfw', 'spam', 'harassment', 'inappropriate', 'copyright', 'other'];
  if (!validFlagTypes.includes(flag_type)) {
    return res.status(400).json({ error: 'Invalid flag_type. Must be one of: ' + validFlagTypes.join(', ') });
  }
  
  try {
    // Check if user can flag
    const userStatsQuery = 'SELECT can_flag, banned_until FROM flag_user_stats WHERE account = $1';
    const userStats = await executeQuery(userStatsQuery, [reporter_account], 'Error checking user flag permissions');
    
    if (userStats.rows.length > 0) {
      const stats = userStats.rows[0];
      if (!stats.can_flag) {
        return res.status(403).json({ error: 'You are not allowed to submit flag reports' });
      }
      if (stats.banned_until && new Date(stats.banned_until) > new Date()) {
        return res.status(403).json({ 
          error: 'You are temporarily banned from flagging until ' + new Date(stats.banned_until).toISOString() 
        });
      }
    }
    
    // Check if post exists
    const postQuery = 'SELECT author, permlink FROM posts WHERE author = $1 AND permlink = $2';
    const postResult = await executeQuery(postQuery, [post_author, post_permlink], 'Error checking post existence');
    
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    // Check if user already flagged this post
    const existingFlagQuery = `
      SELECT id FROM flag_reports 
      WHERE post_author = $1 AND post_permlink = $2 AND reporter_account = $3 AND status = 'pending'
    `;
    const existingFlag = await executeQuery(existingFlagQuery, [post_author, post_permlink, reporter_account], 'Error checking existing flags');
    
    if (existingFlag.rows.length > 0) {
      return res.status(409).json({ error: 'You have already flagged this post' });
    }
    
    // Insert flag report
    const insertQuery = `
      INSERT INTO flag_reports (post_author, post_permlink, reporter_account, flag_type, reason)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const flagResult = await executeQuery(insertQuery, [post_author, post_permlink, reporter_account, flag_type, reason], 'Error submitting flag report');
    
    // Update user statistics
    const updateStatsQuery = `
      INSERT INTO flag_user_stats (account, flags_submitted) 
      VALUES ($1, 1)
      ON CONFLICT (account) 
      DO UPDATE SET 
        flags_submitted = flag_user_stats.flags_submitted + 1,
        updated_at = CURRENT_TIMESTAMP
    `;
    await executeQuery(updateStatsQuery, [reporter_account], 'Error updating user stats');
    
    res.status(201).json({
      message: 'Flag report submitted successfully',
      report: flagResult.rows[0],
      node: config.username
    });
    
  } catch (error) {
    console.error('Error submitting flag report:', error);
    res.status(500).json({ error: 'Failed to submit flag report' });
  }
};

// Admin endpoint to get pending flag reports
exports.getPendingFlags = async (req, res, next) => {
  const { limit = 50, offset = 0, flag_type, reporter } = req.query;
  
  try {
    let whereClause = "WHERE fr.status = 'pending'";
    const params = [];
    let paramIndex = 1;
    
    if (flag_type) {
      whereClause += ` AND fr.flag_type = $${paramIndex}`;
      params.push(flag_type);
      paramIndex++;
    }
    
    if (reporter) {
      whereClause += ` AND fr.reporter_account = $${paramIndex}`;
      params.push(reporter);
      paramIndex++;
    }
    
    const query = `
      SELECT 
        fr.*,
        p.type as post_type,
        p.votes as post_votes,
        p.voteweight as post_voteweight,
        fus.flags_submitted,
        fus.flags_accepted,
        fus.flags_rejected,
        CASE 
          WHEN fus.flags_submitted > 0 
          THEN ROUND((fus.flags_accepted::decimal / fus.flags_submitted) * 100, 2)
          ELSE 0 
        END as reporter_accuracy
      FROM flag_reports fr
      JOIN posts p ON fr.post_author = p.author AND fr.post_permlink = p.permlink
      LEFT JOIN flag_user_stats fus ON fr.reporter_account = fus.account
      ${whereClause}
      ORDER BY fr.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await executeQuery(query, params, 'Error fetching pending flags');
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM flag_reports fr 
      JOIN posts p ON fr.post_author = p.author AND fr.post_permlink = p.permlink
      ${whereClause.replace(/\$\d+/g, (match) => {
        const num = parseInt(match.substring(1));
        return num <= params.length - 2 ? match : '';
      })}
    `;
    const countParams = params.slice(0, -2); // Remove limit and offset
    const countResult = await executeQuery(countQuery, countParams, 'Error counting pending flags');
    
    res.json({
      reports: result.rows,
      totalCount: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset),
      node: config.username
    });
    
  } catch (error) {
    console.error('Error fetching pending flags:', error);
    res.status(500).json({ error: 'Failed to fetch pending flag reports' });
  }
};

// Admin endpoint to review flag reports
exports.reviewFlagReport = async (req, res, next) => {
  const { reportId } = req.params;
  const { action, moderator_username, apply_to_post } = req.body; // action: 'accept' or 'reject'
  
  if (!action || !moderator_username) {
    return res.status(400).json({ error: 'action and moderator_username are required' });
  }
  
  if (!['accept', 'reject', 'block'].includes(action)) {
    return res.status(400).json({ error: 'action must be "accept" or "reject"' });
  }
  
  try {
    // Get the flag report
    const reportQuery = 'SELECT * FROM flag_reports WHERE id = $1 AND status = $2';
    const reportResult = await executeQuery(reportQuery, [reportId, 'pending'], 'Error fetching flag report');
    
    if (reportResult.rows.length === 0) {
      return res.status(404).json({ error: 'Flag report not found or already reviewed' });
    }
    
    const report = reportResult.rows[0];
    
    // Update the flag report status
    const updateReportQuery = `
      UPDATE flag_reports 
      SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `;
    const updatedReport = await executeQuery(updateReportQuery, [action === 'accept' ? 'accepted' : 'rejected', moderator_username, reportId], 'Error updating flag report');
    
    // Update user statistics
    const updateUserStatsQuery = `
      UPDATE flag_user_stats 
      SET ${action === 'accept' ? 'flags_accepted' : 'flags_rejected'} = ${action === 'accept' ? 'flags_accepted' : 'flags_rejected'} + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE account = $1
    `;
    await executeQuery(updateUserStatsQuery, [report.reporter_account], 'Error updating user flag stats');
    
    // If flag is accepted and apply_to_post is true, update the post
    if (action === 'accept' && apply_to_post) {
      const flagTypeMap = {
        'nsfw': 'nsfw = true',
        'inappropriate': 'flagged = true, flag_reason = $4',
        'spam': 'flagged = true, flag_reason = $4',
        'harassment': 'flagged = true, flag_reason = $4',
        'copyright': 'flagged = true, flag_reason = $4',
        'other': 'flagged = true, flag_reason = $4'
      };
      
      if (flagTypeMap[report.flag_type]) {
        const updatePostQuery = `
          UPDATE posts 
          SET ${flagTypeMap[report.flag_type]}, 
              moderated_by = $2, 
              moderated_at = CURRENT_TIMESTAMP
          WHERE author = $1 AND permlink = $3
        `;
        
        const params = [report.post_author, moderator_username, report.post_permlink];
        if (report.flag_type !== 'nsfw') {
          params.push(`${report.flag_type}: ${report.reason || 'Community reported'}`);
        }
        
        await executeQuery(updatePostQuery, params, 'Error updating post flags');
      }
    }
    
    res.json({
      message: `Flag report ${action}ed successfully`,
      report: updatedReport.rows[0],
      post_updated: action === 'accept' && apply_to_post,
      node: config.username
    });
    
  } catch (error) {
    console.error('Error reviewing flag report:', error);
    res.status(500).json({ error: 'Failed to review flag report' });
  }
};

// Admin endpoint to manage user flag permissions
exports.updateUserFlagPermissions = async (req, res, next) => {
  const { username } = req.params;
  const { can_flag, ban_duration_hours, ban_reason } = req.body;
  
  try {
    const updates = [];
    const params = [];
    let paramIndex = 1;
    
    if (can_flag !== undefined) {
      updates.push(`can_flag = $${paramIndex}`);
      params.push(can_flag);
      paramIndex++;
    }
    
    if (ban_duration_hours !== undefined) {
      if (ban_duration_hours > 0) {
        updates.push(`banned_until = CURRENT_TIMESTAMP + INTERVAL '${ban_duration_hours} hours'`);
        if (ban_reason) {
          updates.push(`ban_reason = $${paramIndex}`);
          params.push(ban_reason);
          paramIndex++;
        }
      } else {
        updates.push(`banned_until = NULL, ban_reason = NULL`);
      }
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    
    const query = `
      INSERT INTO flag_user_stats (account, can_flag, banned_until, ban_reason) 
      VALUES ($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3})
      ON CONFLICT (account) 
      DO UPDATE SET ${updates.join(', ')}
      RETURNING *
    `;
    
    params.push(username, can_flag !== undefined ? can_flag : true, null, ban_reason || null);
    
    const result = await executeQuery(query, params, 'Error updating user flag permissions');
    
    res.json({
      message: 'User flag permissions updated successfully',
      user_stats: result.rows[0],
      node: config.username
    });
    
  } catch (error) {
    console.error('Error updating user flag permissions:', error);
    res.status(500).json({ error: 'Failed to update user flag permissions' });
  }
};

// Get user flag statistics
exports.getUserFlagStats = async (req, res, next) => {
  const { username } = req.params;
  
  try {
    const query = `
      SELECT 
        fus.*,
        CASE 
          WHEN fus.flags_submitted > 0 
          THEN ROUND((fus.flags_accepted::decimal / fus.flags_submitted) * 100, 2)
          ELSE 0 
        END as accuracy_rate,
        COUNT(fr.id) as pending_reports
      FROM flag_user_stats fus
      LEFT JOIN flag_reports fr ON fus.account = fr.reporter_account AND fr.status = 'pending'
      WHERE fus.account = $1
      GROUP BY fus.account, fus.flags_submitted, fus.flags_accepted, fus.flags_rejected, fus.can_flag, fus.banned_until, fus.ban_reason, fus.created_at, fus.updated_at
    `;
    
    const result = await executeQuery(query, [username], 'Error fetching user flag stats');
    
    if (result.rows.length === 0) {
      // Return default stats for new users
      return res.json({
        account: username,
        flags_submitted: 0,
        flags_accepted: 0,
        flags_rejected: 0,
        can_flag: true,
        banned_until: null,
        ban_reason: null,
        accuracy_rate: 0,
        pending_reports: 0,
        node: config.username
      });
    }
    
    res.json({
      ...result.rows[0],
      node: config.username
    });
    
  } catch (error) {
    console.error('Error fetching user flag stats:', error);
    res.status(500).json({ error: 'Failed to fetch user flag statistics' });
  }
};

// ===============================
// SCRIPT SECURITY SYSTEM
// ===============================

// Enhanced input sanitization
function sanitizeInput(input, maxLength = 255) {
  if (!input || typeof input !== 'string') return '';
  
  return input
    .replace(/[`'"\\]/g, '')
    .replace(/[\r\n\t]/g, '')
    .replace(/[<>]/g, '')
    .substring(0, maxLength)
    .trim();
}

function calculateScriptHash(script) {
  return crypto.createHash('sha256').update(script).digest('hex');
}

function analyzeScriptSafety(script) {
  const dangerousPatterns = [
    /require\s*\(/gi, /import\s+/gi, /process\./gi, /global\./gi,
    /eval\s*\(/gi, /Function\s*\(/gi, /setTimeout|setInterval/gi, /child_process/gi,
    /fs\.|filesystem/gi, /http\.|https\./gi, /\.prototype\./gi,
    /constructor/gi, /__proto__/gi, /delete\s+/gi, /with\s*\(/gi,
    /arguments\.callee/gi,
  ];
  
  const flaggedReasons = [];
  const riskFactors = [];
  
  dangerousPatterns.forEach((pattern, index) => {
    const patternNames = [
      'require() calls', 'import statements', 'process access', 'global access',
      'eval() calls', 'Function constructor', 'timers', 'child_process',
      'filesystem access', 'network access', 'prototype pollution',
      'constructor access', 'proto access', 'delete operator',
      'with statement', 'arguments.callee'
    ];
    
    if (pattern.test(script)) {
      flaggedReasons.push(patternNames[index]);
      riskFactors.push(index < 8 ? 'high' : 'medium');
    }
  });
  
  const riskLevel = riskFactors.includes('high') ? 'critical' : 
                   riskFactors.includes('medium') ? 'high' : 
                   riskFactors.length > 0 ? 'medium' : 'low';
  
  return { riskLevel, flaggedReasons, isAutoFlagged: riskFactors.length > 0 };
}

async function checkScriptWhitelist(scriptHash) {
  try {
    const query = 'SELECT * FROM script_whitelist WHERE script_hash = $1 AND is_active = true';
    const result = await executeQuery(query, [scriptHash], 'Error checking script whitelist');
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error checking script whitelist:', error);
    // Return null for strict whitelist enforcement
    return null;
  }
}

async function addScriptToReview(scriptHash, scriptContent, source, requestedBy, context) {
  try {
    console.log(`Adding script ${scriptHash} to review queue...`);
    const safety = analyzeScriptSafety(scriptContent);
    const query = `
      INSERT INTO script_reviews (
        script_hash, script_content, request_source, requested_by, 
        request_context, risk_assessment, auto_flagged, flagged_reasons
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (script_hash) DO UPDATE SET
        request_source = EXCLUDED.request_source,
        requested_by = EXCLUDED.requested_by,
        request_context = EXCLUDED.request_context,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `;
    const result = await executeQuery(query, [
      scriptHash, scriptContent, source, requestedBy,
      JSON.stringify(context), JSON.stringify({ riskLevel: safety.riskLevel }), safety.isAutoFlagged, safety.flaggedReasons
    ], 'Error adding script to review');
    
    if (result.rows.length > 0) {
      console.log(`Script ${scriptHash} added to review queue with ID ${result.rows[0].id}`);
      return result.rows[0].id;
    } else {
      console.log(`Script ${scriptHash} already exists in review queue`);
      return null;
    }
  } catch (error) {
    console.error('Error adding script to review:', error);
    console.error('Script hash:', scriptHash);
    console.error('Source:', source);
    console.error('Requested by:', requestedBy);
    // Still block execution for security, but provide better error info
    throw new Error(`Script review system error: ${error.message}`);
  }
}

async function logScriptExecution(scriptHash, executedBy, context, success, error, executionTime, req) {
  try {
    const query = `
      INSERT INTO script_execution_logs (
        script_hash, executed_by, execution_context, execution_time_ms,
        success, error_message, request_ip, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    // Extract IP address without port and handle various formats
    let clientIP = req?.ip || req?.connection?.remoteAddress || null;
    if (clientIP) {
      // Handle IPv6 wrapped IPv4 (e.g., "::ffff:192.168.1.1")
      if (clientIP.startsWith('::ffff:')) {
        clientIP = clientIP.substring(7);
      }
      // Remove port if present (e.g., "71.93.158.159:22606" -> "71.93.158.159")
      if (clientIP.includes(':') && !clientIP.includes('::')) {
        const parts = clientIP.split(':');
        // For IPv4:port, take the first part
        if (parts.length === 2 && /^\d+$/.test(parts[1])) {
          clientIP = parts[0];
        }
      }
      // Validate it's a valid IP format
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(clientIP) && !/^([0-9a-fA-F:]+)$/.test(clientIP)) {
        console.warn('Invalid IP format detected:', clientIP);
        clientIP = null;
      }
    }
    
    await executeQuery(query, [
      scriptHash, executedBy, JSON.stringify(context), executionTime,
      success, error, clientIP, req?.get('User-Agent')
    ], 'Error logging script execution');
  } catch (logError) {
    console.error('Error logging script execution:', logError);
    // Don't fail the execution if logging fails
  }
}

// ===============================
// SCRIPT MANAGEMENT API ENDPOINTS
// ===============================

exports.getScriptStats = async (req, res, next) => {
  try {
    const pendingResult = await executeQuery('SELECT COUNT(*) as count FROM script_reviews WHERE status = $1', ['pending']);
    const whitelistResult = await executeQuery('SELECT COUNT(*) as count FROM script_whitelist WHERE is_active = true');
    const inactiveResult = await executeQuery('SELECT COUNT(*) as count FROM script_whitelist WHERE is_active = false');
    const executionsResult = await executeQuery('SELECT COUNT(*) as count FROM script_execution_logs');
    const successResult = await executeQuery(`
      SELECT COUNT(*) as total, SUM(CASE WHEN success = true THEN 1 ELSE 0 END) as successful
      FROM script_execution_logs WHERE executed_at >= CURRENT_DATE - INTERVAL '7 days'`);
    const riskResult = await executeQuery(`
      SELECT risk_level, COUNT(*) as count FROM script_whitelist WHERE is_active = true GROUP BY risk_level`);

    const successData = successResult.rows[0];
    const successRate = successData.total > 0 ? Math.round((successData.successful / successData.total) * 100) : 100;
    const riskDistribution = riskResult.rows.reduce((acc, row) => ({...acc, [row.risk_level]: parseInt(row.count)}), {});
    
    res.json({
      stats: {
        totalPending: parseInt(pendingResult.rows[0].count),
        totalWhitelisted: parseInt(whitelistResult.rows[0].count),
        totalInactive: parseInt(inactiveResult.rows[0].count),
        totalExecutions: parseInt(executionsResult.rows[0].count),
        executionSuccess: successRate,
        riskDistribution
      },
      node: config.username
    });
  } catch (error) {
    console.error('Error fetching script stats:', error);
    res.status(500).json({ error: 'Failed to fetch script statistics' });
  }
};

exports.getPendingScriptReviews = async (req, res, next) => {
  const { limit = 50, offset = 0, risk_level } = req.query;
  try {
    let whereClause = "WHERE status = 'pending'";
    const params = [];
    let paramIndex = 1;
    if (risk_level) {
      whereClause += ` AND risk_assessment->>'riskLevel' = $${paramIndex++}`;
      params.push(risk_level);
    }
    const query = `
      SELECT id, script_hash, request_source, requested_by,
             request_context, risk_assessment, auto_flagged, flagged_reasons,
             LEFT(script_content, 200) as script_preview, created_at
      FROM script_reviews 
      ${whereClause}
      ORDER BY CASE risk_assessment->>'riskLevel' WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));
    const result = await executeQuery(query, params);
    const countResult = await executeQuery(`SELECT COUNT(*) as total FROM script_reviews ${whereClause}`, params.slice(0, -2));
    res.json({
      reviews: result.rows,
      totalCount: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pending script reviews' });
  }
};

exports.getScriptReviewDetails = async (req, res, next) => {
  try {
    const result = await executeQuery('SELECT * FROM script_reviews WHERE id = $1', [req.params.reviewId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Script review not found' });
    const review = result.rows[0];
    res.json({ review, safety_analysis: analyzeScriptSafety(review.script_content) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch script review details' });
  }
};

exports.reviewScript = async (req, res, next) => {
  const { reviewId } = req.params;
  const { action, reviewer_username, review_notes, script_name, risk_level, tags } = req.body;
  if (!action || !reviewer_username || !['approve', 'reject', 'block'].includes(action)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    const reviewResult = await executeQuery('SELECT * FROM script_reviews WHERE id = $1 AND status = $2', [reviewId, 'pending']);
    if (reviewResult.rows.length === 0) return res.status(404).json({ error: 'Script review not found or already processed' });
    const review = reviewResult.rows[0];
    await executeQuery(`UPDATE script_reviews SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, reviewer_notes = $3 WHERE id = $4`,
      [action === 'approve' ? 'approved' : action, reviewer_username, review_notes, reviewId]);
    if (action === 'approve') {
      await executeQuery(`
        INSERT INTO script_whitelist (script_hash, script_name, whitelisted_by, risk_level, description) 
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (script_hash) DO UPDATE SET
          script_name = EXCLUDED.script_name, whitelisted_by = EXCLUDED.whitelisted_by, risk_level = EXCLUDED.risk_level,
          description = EXCLUDED.description, is_active = true`,
        [review.script_hash, script_name || `Script-${review.script_hash.substring(0, 8)}`,
         reviewer_username, risk_level || 'medium', review_notes]);
    }
    res.json({ message: `Script ${action}ed successfully`, whitelisted: action === 'approve' });
  } catch (error) {
    console.error('Script review error:', error);
    res.status(500).json({ error: 'Failed to review script', details: error.message });
  }
};

exports.getWhitelistedScripts = async (req, res, next) => {
  const { limit = 50, offset = 0, risk_level, search, include_inactive } = req.query;
  try {
    let whereClause = include_inactive === 'true' ? 'WHERE 1=1' : 'WHERE is_active = true';
    const params = [];
    let paramIndex = 1;
    if (risk_level) {
      whereClause += ` AND risk_level = $${paramIndex++}`;
      params.push(risk_level);
    }
    if (search) {
      whereClause += ` AND (script_name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
    }
    const query = `
      SELECT script_hash, script_name, whitelisted_by as approved_by, whitelisted_at as approved_at, risk_level, description, notes, 
             is_active, 'No content preview' as script_preview
      FROM script_whitelist 
      ${whereClause} ORDER BY whitelisted_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));
    const result = await executeQuery(query, params);
    res.json({ scripts: result.rows, totalCount: result.rows.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch whitelisted scripts' });
  }
};

exports.removeFromWhitelist = async (req, res, next) => {
  const { remover_username } = req.body;
  if (!remover_username) return res.status(400).json({ error: 'remover_username is required' });
  try {
    const result = await executeQuery('UPDATE script_whitelist SET is_active = false WHERE script_hash = $1 AND is_active = true RETURNING script_name', [req.params.scriptHash]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Script not found or already inactive' });
    res.json({ message: 'Script removed from whitelist successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove script from whitelist' });
  }
};

exports.reactivateScript = async (req, res, next) => {
  const { reactivator_username } = req.body;
  if (!reactivator_username) return res.status(400).json({ error: 'reactivator_username is required' });
  try {
    const result = await executeQuery('UPDATE script_whitelist SET is_active = true WHERE script_hash = $1 AND is_active = false RETURNING script_name', [req.params.scriptHash]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Script not found or already active' });
    res.json({ message: 'Script reactivated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reactivate script' });
  }
};

exports.updateScript = async (req, res, next) => {
  const { script_name, risk_level, description, notes, is_active, editor_username } = req.body;
  if (!editor_username) return res.status(400).json({ error: 'editor_username is required' });
  
  try {
    const result = await executeQuery(`
      UPDATE script_whitelist 
      SET script_name = $1, risk_level = $2, description = $3, notes = $4, is_active = $5
      WHERE script_hash = $6 
      RETURNING script_name, script_hash
    `, [script_name, risk_level, description, notes, is_active, req.params.scriptHash]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Script not found' });
    }
    
    res.json({ 
      message: 'Script updated successfully',
      script: result.rows[0],
      updatedBy: editor_username
    });
  } catch (error) {
    console.error('Error updating script:', error);
    res.status(500).json({ error: 'Failed to update script' });
  }
};

exports.getScriptExecutionLogs = async (req, res, next) => {
  const { limit = 100, offset = 0, script_hash, success, date_from, date_to } = req.query;
  try {
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    if (script_hash) {
      whereClause += ` AND sel.script_hash = $${paramIndex++}`;
      params.push(script_hash);
    }
    if (success !== undefined) {
      whereClause += ` AND sel.success = $${paramIndex++}`;
      params.push(success === 'true');
    }
    if (date_from) {
      whereClause += ` AND sel.executed_at >= $${paramIndex++}`;
      params.push(date_from);
    }
    if (date_to) {
      whereClause += ` AND sel.executed_at <= $${paramIndex++}`;
      params.push(date_to);
    }
    const query = `
      SELECT sel.*, sw.script_name, sw.risk_level
      FROM script_execution_logs sel LEFT JOIN script_whitelist sw ON sel.script_hash = sw.script_hash
      ${whereClause} ORDER BY sel.executed_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));
    const result = await executeQuery(query, params);
    const countResult = await executeQuery(`SELECT COUNT(*) as total FROM script_execution_logs sel ${whereClause}`, params.slice(0,-2));
    res.json({
      logs: result.rows,
      totalCount: parseInt(countResult.rows[0].total)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch script execution logs' });
  }
};

exports.testScriptSecurity = async (req, res, next) => {
  try {
    const results = await Promise.all([
      executeQuery('SELECT COUNT(*) as count FROM script_whitelist'),
      executeQuery('SELECT COUNT(*) as count FROM script_reviews'), 
      executeQuery('SELECT COUNT(*) as count FROM script_execution_logs')
    ]);
    res.json({
      message: 'Script security system is ready',
      tables: {
        script_whitelist: parseInt(results[0].rows[0].count),
        script_reviews: parseInt(results[1].rows[0].count),
        script_execution_logs: parseInt(results[2].rows[0].count)
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Script security system not properly initialized' });
  }
};

// Missing API route handlers
exports.hive_api = async (req, res, next) => {
  try {
    res.status(501).json({
      error: 'Hive API endpoint not implemented',
      requested: `${req.params.api_type}/${req.params.api_call}`
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.getPostRoute = async (req, res, next) => {
  try {
    res.status(501).json({
      error: 'Get post route not implemented',
      requested: `@${req.params.author}/${req.params.permlink}`
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.getAuthorPosts = async (req, res, next) => {
  try {
    res.status(501).json({
      error: 'Get author posts not implemented',
      requested: `@${req.params.author}`
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

exports.getNewPosts = async (req, res, next) => {
  const { amt = 50, off = 0, bitMask = 255 } = req.query;
  try {
    const results = await getNewPosts(parseInt(amt), parseInt(off), parseInt(bitMask));
    res.send(JSON.stringify({ result: results, node: config.username }, null, 3));
  } catch (error) {
    console.error("Error in getNewPosts:", error);
    res.status(500).send(JSON.stringify({ error: "Failed to get new posts", node: config.username }, null, 3));
  }
}

exports.getTrendingPosts = async (req, res, next) => {
  const { amt = 50, off = 0, bitMask = 255 } = req.query;
  try {
    const results = await getTrendingPosts(parseInt(amt), parseInt(off), parseInt(bitMask));
    res.send(JSON.stringify({ result: results, node: config.username }, null, 3));
  } catch (error) {
    console.error("Error in getTrendingPosts:", error);
    res.status(500).send(JSON.stringify({ error: "Failed to get trending posts", node: config.username }, null, 3));
  }
}

// Endpoint to test Y.js update type detection (for debugging)
exports.test_yjs_update_type = async (req, res, next) => {
  try {
    const { updateHex } = req.body
    
    if (!updateHex) {
      return res.status(400).json({ error: 'updateHex is required' })
    }
    
    // Convert hex string back to binary
    const update = new Uint8Array(Buffer.from(updateHex, 'hex'))
    
    // Test content change detection
    const Y = require('yjs')
    const testDoc = new Y.Doc()
    const yText = testDoc.getText('content')
    
    const initialContent = yText.toString()
    const initialLength = yText.length
    
    Y.applyUpdate(testDoc, update)
    
    const finalContent = yText.toString()
    const finalLength = yText.length
    
    const contentChanged = initialContent !== finalContent || initialLength !== finalLength
    
    res.json({
      isDocumentContentUpdate: contentChanged,
      analysis: {
        initialContent,
        finalContent,
        initialLength,
        finalLength,
        contentChanged,
        updateSize: update.length,
        updateHex: updateHex.substring(0, 100) + (updateHex.length > 100 ? '...' : '')
      }
    })
  } catch (error) {
    console.error('Error testing Y.js update type:', error)
    res.status(500).json({ error: error.message })
  }
}

exports.getCollaborationActivity = async (req, res, next) => {
  try {
    const { owner, permlink } = req.params
    const { limit = 50 } = req.query
    
    const result = await pool.query(`
      SELECT 
        account,
        activity_type,
        activity_data,
        created_at
      FROM collaboration_activity 
      WHERE owner = $1 AND permlink = $2
      ORDER BY created_at DESC
      LIMIT $3
    `, [owner, permlink, parseInt(limit)])
    
    res.json({
      success: true,
      document: `${owner}/${permlink}`,
      activity: result.rows.map(row => ({
        account: row.account,
        type: row.activity_type,
        data: row.activity_data,
        timestamp: row.created_at
      }))
    })
  } catch (error) {
    console.error('Error fetching collaboration activity:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to fetch collaboration activity'
    })
  }
}

exports.getCollaborationStats = async (req, res, next) => {
  try {
    const { owner, permlink } = req.params
    
    const [statsResult, docResult, permissionsResult] = await Promise.all([
      pool.query(`
        SELECT 
          active_users,
          total_edits,
          last_activity,
          document_size
        FROM collaboration_stats 
        WHERE owner = $1 AND permlink = $2
      `, [owner, permlink]),
      
      pool.query(`
        SELECT 
          document_name,
          is_public,
          created_at,
          updated_at
        FROM collaboration_documents 
        WHERE owner = $1 AND permlink = $2
      `, [owner, permlink]),
      
      pool.query(`
        SELECT 
          account,
          permission_type,
          can_read,
          can_edit,
          can_post_to_hive,
          granted_by,
          granted_at
        FROM collaboration_permissions 
        WHERE owner = $1 AND permlink = $2
        ORDER BY granted_at DESC
      `, [owner, permlink])
    ])
    
    const stats = statsResult.rows[0] || {
      active_users: 0,
      total_edits: 0,
      last_activity: null,
      document_size: 0
    }
    
    const document = docResult.rows[0] || null
    const permissions = permissionsResult.rows
    
    res.json({
      success: true,
      document: `${owner}/${permlink}`,
      stats,
      document_info: document,
      permissions,
      permission_summary: {
        total_permissions: permissions.length,
        can_edit: permissions.filter(p => p.can_edit).length,
        can_read_only: permissions.filter(p => p.can_read && !p.can_edit).length,
        is_public: document?.is_public || false
      }
    })
  } catch (error) {
    console.error('Error fetching collaboration stats:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to fetch collaboration stats'
    })
  }
}

exports.getCollaborationTestInfo = async (req, res, next) => {
  try {
    const testInfo = {
      message: 'Collaboration server awareness test endpoint',
      server_improvements: {
        awareness_handling: 'Read-only users can now send cursor position updates',
        sync_protocol: 'Y.js sync protocol messages are allowed during grace period',
        grace_period: '10 seconds after connection for initial sync',
        message_types: {
          allowed_for_readonly: [
            'awareness updates (cursor position)',
            'sync protocol messages',
            'user presence updates'
          ],
          blocked_for_readonly: [
            'document content modifications',
            'text insertions/deletions',
            'structural changes'
          ]
        }
      },
      testing_instructions: {
        step1: 'Connect a read-only user to a collaborative document',
        step2: 'Verify they can see other users cursors',
        step3: 'Verify their cursor is visible to other users',
        step4: 'Verify they cannot edit document content',
        step5: 'Check activity logs at /collaboration/activity/owner/permlink'
      },
      websocket_url: 'ws://localhost:1234',
      test_document: 'testuser/test-document'
    }
    
    res.json(testInfo)
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Test endpoint error'
    })
  }
}

// ReMix API endpoints
exports.getNewReMixPosts = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  const license = req.query.license || null;
  const tag = req.query.tag || null;
  
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getNewReMixPosts(amt, off, license, tag);
    res.send(
      JSON.stringify(
        {
          result: results,
          filters: { license, tag },
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting new ReMix posts:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get new ReMix posts", node: config.username }, null, 3));
  }
};

exports.getTrendingReMixPosts = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  const license = req.query.license || null;
  const tag = req.query.tag || null;
  
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getTrendingReMixPosts(amt, off, license, tag);
    res.send(
      JSON.stringify(
        {
          result: results,
          filters: { license, tag },
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting trending ReMix posts:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get trending ReMix posts", node: config.username }, null, 3));
  }
};

exports.getReMixLicenses = async (req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getReMixLicenses();
    res.send(
      JSON.stringify(
        {
          result: results,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting ReMix licenses:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get ReMix licenses", node: config.username }, null, 3));
  }
};

exports.getReMixTags = async (req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getReMixTags();
    res.send(
      JSON.stringify(
        {
          result: results,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting ReMix tags:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get ReMix tags", node: config.username }, null, 3));
  }
};

// Add monitoring endpoint to expose last processed block
exports.getBlockMonitorStatus = async (req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  try {
    // Import hive monitor here to avoid circular dependency
    const hiveMonitor = require('../hive-monitor');
    const status = hiveMonitor.getStatus();
    
    res.send(
      JSON.stringify(
        {
          result: {
            isRunning: status.isRunning,
            lastProcessedBlock: status.lastProcessedBlock,
            activeListeners: status.activeListeners,
            apiHealth: status.apiHealth,
            retryDelay: status.retryDelay,
            pendingReadTransactions: status.pendingReadTransactions,
            readTransactionResolvers: status.readTransactionResolvers
          },
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting block monitor status:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get block monitor status", node: config.username }, null, 3));
  }
};

// Test endpoint for ReMix functionality
exports.testReMixData = async (req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  
  // Check admin headers
  const account = req.headers['x-account'];
  const challenge = req.headers['x-challenge'];
  const pubkey = req.headers['x-pubkey'];
  const signature = req.headers['x-signature'];
  
  // Simple admin check (you can enhance this)
  if (account !== 'dlux-io') {
    return res.status(403).send(JSON.stringify({ error: "Access denied" }, null, 3));
  }

  try {
    // Create a test ReMix post
    const testPost = {
      author: 'test-user',
      permlink: `test-remix-${Date.now()}`,
      type: 'dapp',
      block: 96726251,
      remix_cid: 'QmTestReMixCIDExample123456789',
      license: 'CC BY-SA 4.0',
      tags: ['test', 'remix', 'example']
    };
    
    const insertQuery = `
      INSERT INTO posts (author, permlink, type, block, votes, voteweight, promote, paid, remix_cid, license, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (author, permlink) DO UPDATE SET
          remix_cid = EXCLUDED.remix_cid,
          license = EXCLUDED.license,
          tags = EXCLUDED.tags
      RETURNING *
    `;
    
    const result = await executeQuery(insertQuery, [
      testPost.author,
      testPost.permlink,
      testPost.type,
      testPost.block,
      0, // votes
      0, // voteweight
      0, // promote
      false, // paid
      testPost.remix_cid,
      testPost.license,
      testPost.tags
    ], 'Error creating test ReMix post');
    
    res.send(
      JSON.stringify(
        {
          message: "Test ReMix post created successfully",
          result: result.rows[0],
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error creating test ReMix data:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to create test ReMix data", details: e.message, node: config.username }, null, 3));
  }
};

// ReMix Applications API endpoints
exports.getPopularReMixApplications = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getPopularReMixApplications(amt, off);
    res.send(
      JSON.stringify(
        {
          result: results,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting popular ReMix applications:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get popular ReMix applications", node: config.username }, null, 3));
  }
};

exports.getNewestReMixApplications = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getNewestReMixApplications(amt, off);
    res.send(
      JSON.stringify(
        {
          result: results,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting newest ReMix applications:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get newest ReMix applications", node: config.username }, null, 3));
  }
};

exports.getReMixApplicationDetails = async (req, res, next) => {
  const { remixCid } = req.params;
  
  if (!remixCid) {
    return res.status(400).send(JSON.stringify({ error: "ReMix CID parameter is required" }, null, 3));
  }

  res.setHeader("Content-Type", "application/json");
  try {
    const result = await getReMixApplicationDetails(remixCid);
    
    if (!result) {
      return res.status(404).send(JSON.stringify({ error: "ReMix application not found" }, null, 3));
    }
    
    // Add URLs to derivative works
    result.derivatives.forEach(derivative => {
      derivative.url = `/dlux/@${derivative.author}/${derivative.permlink}`;
    });
    
    res.send(
      JSON.stringify(
        {
          result: result,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting ReMix application details:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get ReMix application details", node: config.username }, null, 3));
  }
};

exports.getDerivativeWorksByAuthor = async (req, res, next) => {
  const { author } = req.params;
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  
  if (!author) {
    return res.status(400).send(JSON.stringify({ error: "Author parameter is required" }, null, 3));
  }
  
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getDerivativeWorksByAuthor(author, amt, off);
    res.send(
      JSON.stringify(
        {
          result: results,
          author: author,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting derivative works by author:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get derivative works by author", node: config.username }, null, 3));
  }
};

exports.getReMixApplicationStats = async (req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getReMixApplicationStats();
    res.send(
      JSON.stringify(
        {
          result: results,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting ReMix application stats:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get ReMix application stats", node: config.username }, null, 3));
  }
};

// Hive Monitor Status endpoint
exports.getHiveMonitorStatus = async (req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const hiveMonitor = require('../hive-monitor');
    const status = hiveMonitor.getStatus();
    
    res.send(
      JSON.stringify(
        {
          result: status,
          node: config.username,
          timestamp: new Date().toISOString()
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error getting hive monitor status:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get hive monitor status", node: config.username }, null, 3));
  }
};

// Test Hive API connectivity endpoint
exports.testHiveAPI = async (req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const fetch = require('node-fetch');
    const currentAddress = 'https://hive-api.dlux.io';
    
    console.log('Testing Hive API connectivity...');
    
    const response = await fetch(currentAddress, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'dlux-data-monitor-test'
      },
      body: JSON.stringify({
        "jsonrpc": "2.0",
        "method": "database_api.get_dynamic_global_properties",
        "params": {},
        "id": 1
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    if (data.error) {
      throw new Error(`API Error: ${data.error.message}`);
    }
    
    const headBlock = data.result.head_block_number;
    
    console.log(`✓ Hive API test successful. Current head block: ${headBlock}`);
    
    res.send(
      JSON.stringify(
        {
          success: true,
          result: {
            headBlock: headBlock,
            apiEndpoint: currentAddress,
            response: data.result
          },
          node: config.username,
          timestamp: new Date().toISOString()
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error("Error testing Hive API:", e);
    res.status(500).send(JSON.stringify({ 
      success: false,
      error: "Failed to test Hive API", 
      details: e.message,
      node: config.username 
    }, null, 3));
  }
};

// ==================================================================
// ENHANCED PRESENCE API ROUTES (VIRAL CAPACITY SYSTEM)
// ==================================================================

// Enhanced presence session creation with viral capacity
exports.createPresenceSession = require('./presence-api').createPresenceSession;

// Update presence session activity
exports.updatePresenceActivity = require('./presence-api').updatePresenceActivity;

// Remove presence session
exports.removePresenceSession = require('./presence-api').removePresenceSession;

// Get space capacity information (enhanced with premium multipliers)
exports.getSpaceCapacity = require('./presence-api').getSpaceCapacity;

// Get user's current spaces (for guest limitation enforcement)
exports.getUserSpaces = require('./presence-api').getUserSpaces;

// Track viral events for subscription growth analytics
exports.trackViralEvent = require('./presence-api').trackViralEvent;

// Get viral growth analytics
exports.getViralAnalytics = require('./presence-api').getViralAnalytics;

// Send chat message
exports.sendChatMessage = require('./presence-api').sendChatMessage;

// Add document comment
exports.addDocumentComment = require('./presence-api').addDocumentComment;

// Update space audio configuration
exports.updateSpaceAudioConfig = require('./presence-api').updateSpaceAudioConfig;

// Start audio session
exports.startAudioSession = require('./presence-api').startAudioSession;

// End audio session
exports.endAudioSession = require('./presence-api').endAudioSession;

// Log space activity
exports.logSpaceActivity = require('./presence-api').logSpaceActivity;

// Presence API health check
exports.presenceHealthCheck = require('./presence-api').presenceHealthCheck;

// Add database initialization endpoint
exports.initSubscriptionSystem = async (req, res, next) => {
  try {
    console.log('🔧 Initializing subscription system tables...');
    
    // Check if subscription tables already exist
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('subscription_tiers', 'user_subscriptions', 'subscription_payments', 'promo_codes', 'promo_code_usage')
    `);
    
    const existingTables = tableCheck.rows.map(row => row.table_name);
    
    if (existingTables.length === 5) {
      return res.json({
        success: true,
        message: 'Subscription system tables already exist',
        tables: existingTables
      });
    }
    
    console.log(`Found ${existingTables.length}/5 subscription tables, creating missing ones...`);
    
    // Create subscription_tiers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_tiers (
        id SERIAL PRIMARY KEY,
        tier_code varchar(50) UNIQUE NOT NULL,
        tier_name varchar(100) NOT NULL,
        description text,
        features jsonb NOT NULL DEFAULT '{}',
        monthly_price_hive decimal(10,3),
        yearly_price_hive decimal(10,3),
        monthly_price_hbd decimal(10,3),
        yearly_price_hbd decimal(10,3),
        max_presence_sessions integer DEFAULT 1,
        max_collaboration_docs integer DEFAULT 5,
        max_event_attendees integer DEFAULT 10,
        storage_limit_gb integer DEFAULT 1,
        bandwidth_limit_gb integer DEFAULT 10,
        priority_support boolean DEFAULT false,
        custom_branding boolean DEFAULT false,
        api_access boolean DEFAULT false,
        analytics_access boolean DEFAULT false,
        is_active boolean DEFAULT true,
        sort_order integer DEFAULT 0,
        created_at timestamp DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Insert default subscription tiers
    await pool.query(`
      INSERT INTO subscription_tiers (tier_code, tier_name, description, features, monthly_price_hive, yearly_price_hive, monthly_price_hbd, yearly_price_hbd, max_presence_sessions, max_collaboration_docs, max_event_attendees, storage_limit_gb, bandwidth_limit_gb, priority_support, custom_branding, api_access, analytics_access, sort_order) VALUES
      ('free', 'Free', 'Basic presence features for individual users', '{"vr_spaces": true, "basic_chat": true, "file_sharing": false, "screen_sharing": false, "recording": false}', 0, 0, 0, 0, 1, 1, 5, 0, 1, false, false, false, false, 1),
      ('basic', 'Basic', 'Enhanced presence with file sharing and collaboration', '{"vr_spaces": true, "basic_chat": true, "file_sharing": true, "screen_sharing": true, "recording": false, "custom_avatars": true}', 5.000, 50.000, 2.500, 25.000, 2, 5, 15, 1, 5, false, false, false, false, 2),
      ('premium', 'Premium', 'Advanced features for teams and content creators', '{"vr_spaces": true, "basic_chat": true, "file_sharing": true, "screen_sharing": true, "recording": true, "custom_avatars": true, "custom_environments": true, "live_streaming": true}', 15.000, 150.000, 7.500, 75.000, 5, 25, 50, 5, 25, true, false, true, true, 3),
      ('pro', 'Professional', 'Everything for professional organizations', '{"vr_spaces": true, "basic_chat": true, "file_sharing": true, "screen_sharing": true, "recording": true, "custom_avatars": true, "custom_environments": true, "live_streaming": true, "api_integration": true, "webhooks": true, "sso": true}', 50.000, 500.000, 25.000, 250.000, 20, 100, 200, 25, 100, true, true, true, true, 4)
      ON CONFLICT (tier_code) DO NOTHING
    `);
    
    // Create user_subscriptions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id SERIAL PRIMARY KEY,
        user_account varchar(16) NOT NULL,
        tier_id INTEGER REFERENCES subscription_tiers(id),
        subscription_type varchar(20) NOT NULL,
        status varchar(20) DEFAULT 'active',
        original_price_hive decimal(10,3),
        original_price_hbd decimal(10,3),
        effective_price_hive decimal(10,3),
        effective_price_hbd decimal(10,3),
        currency_used varchar(10),
        started_at timestamp DEFAULT CURRENT_TIMESTAMP,
        expires_at timestamp,
        last_payment_at timestamp,
        next_payment_due timestamp,
        cancelled_at timestamp,
        payment_transaction_id varchar(255),
        auto_renew boolean DEFAULT true,
        renewal_failures integer DEFAULT 0,
        promo_code_id INTEGER,
        discount_applied decimal(5,2) DEFAULT 0,
        features_used jsonb DEFAULT '{}',
        usage_stats jsonb DEFAULT '{}',
        created_at timestamp DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_account)
      )
    `);
    
    // Create promo_codes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id SERIAL PRIMARY KEY,
        code varchar(50) UNIQUE NOT NULL,
        description text,
        discount_type varchar(20) NOT NULL,
        discount_value decimal(10,3) NOT NULL,
        applicable_tiers integer[] DEFAULT '{}',
        min_subscription_months integer DEFAULT 1,
        max_uses integer,
        uses_per_user integer DEFAULT 1,
        valid_from timestamp DEFAULT CURRENT_TIMESTAMP,
        valid_until timestamp,
        is_active boolean DEFAULT true,
        total_uses integer DEFAULT 0,
        created_by varchar(16) NOT NULL,
        created_at timestamp DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create promo_code_usage table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_code_usage (
        id SERIAL PRIMARY KEY,
        promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE CASCADE,
        user_account varchar(16) NOT NULL,
        subscription_id INTEGER REFERENCES user_subscriptions(id) ON DELETE CASCADE,
        discount_applied decimal(10,3),
        used_at timestamp DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(promo_code_id, user_account)
      )
    `);
    
    // Create subscription_payments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_payments (
        id SERIAL PRIMARY KEY,
        transaction_id varchar(255) UNIQUE NOT NULL,
        block_num integer,
        from_account varchar(16) NOT NULL,
        to_account varchar(16) NOT NULL,
        amount decimal(10,3) NOT NULL,
        currency varchar(10) NOT NULL,
        memo text,
        status varchar(20) DEFAULT 'pending',
        processed_at timestamp,
        subscription_id INTEGER REFERENCES user_subscriptions(id),
        expected_amount decimal(10,3),
        amount_matches boolean DEFAULT false,
        memo_parsed jsonb,
        error_message text,
        retry_count integer DEFAULT 0,
        created_at timestamp DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscription_tiers_code ON subscription_tiers(tier_code);
      CREATE INDEX IF NOT EXISTS idx_subscription_tiers_active ON subscription_tiers(is_active);
      CREATE INDEX IF NOT EXISTS idx_user_subscriptions_account ON user_subscriptions(user_account);
      CREATE INDEX IF NOT EXISTS idx_user_subscriptions_tier ON user_subscriptions(tier_id);
      CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
      CREATE INDEX IF NOT EXISTS idx_user_subscriptions_expires ON user_subscriptions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_subscription_payments_tx ON subscription_payments(transaction_id);
      CREATE INDEX IF NOT EXISTS idx_subscription_payments_from ON subscription_payments(from_account);
      CREATE INDEX IF NOT EXISTS idx_subscription_payments_status ON subscription_payments(status);
      CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
      CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active);
    `);
    
    console.log('✅ Subscription system tables initialized successfully');
    
    res.json({
      success: true,
      message: 'Subscription system tables created successfully',
      tables_created: ['subscription_tiers', 'user_subscriptions', 'promo_codes', 'promo_code_usage', 'subscription_payments']
    });
    
  } catch (error) {
    console.error('❌ Error initializing subscription system:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};


