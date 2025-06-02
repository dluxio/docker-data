const { Pool } = require("pg");
const config = require("../config");
const fetch = require("node-fetch");
const sharp = require("sharp");
const vm = require('vm');

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
    api: "https://spktest.hivehoneycomb.com/",
    token: "LARYNX",
    tick: "",
    hbd_tick: "",
    change: "",
    vol: 0
  },
  spk: {
    api: "https://spktest.hivehoneycomb.com/spk/",
    token: "SPK",
    tick: "",
    hbd_tick: "",
    change: "",
    vol: 0
  },
  broca: {
    api: "https://spktest.hivehoneycomb.com/broca/",
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
    } else {
        console.warn(`No trade history (dex.hive.his) found for ${tok}`)
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

async function getDetails(uid, script, opt) {
  if (!RAM[script]) {
    console.error(`Script ${script} not loaded for getDetails`);
    return Promise.reject(new Error(`Script ${script} not loaded`));
  }
  const context = {
      console: console
  };
  const escapedUid = uid.replace(/'/g, "\\'");
  const escapedExe = opt.exe ? opt.exe.replace(/'/g, "\\'") : '';
  const codeToRun = `(//${RAM[script]}
)('${escapedUid}', ${opt.exe ? `'${escapedExe}'` : 'undefined'})`;

  try {
    const NFT = vm.runInNewContext(codeToRun, vm.createContext(context), { timeout: 1000 });

    if (!NFT || typeof NFT.attributes === 'undefined' || typeof NFT.set === 'undefined') {
        console.error(`Invalid NFT object structure returned by script ${script} for UID ${uid}`);
        return Promise.reject(new Error(`Invalid NFT object structure from script ${script}`));
    }
    return { attributes: NFT.attributes, set: NFT.set, opt };
  } catch (evalError) {
    console.error(`Error evaluating script ${script} for getDetails:`, evalError);
    return Promise.reject(evalError);
  }
}

async function makePNG(uid, script, opt) {
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

  let NFT;
  const context = {
      console: console
  };
  const escapedUid = uid.replace(/'/g, "\\'");
  const escapedOpt = opt ? opt.replace(/'/g, "\\'") : '';
  const codeToRun = `(//${RAM[script]}
)('${escapedUid}', ${opt ? `'${escapedOpt}'` : 'undefined'})`;

  try {
    NFT = vm.runInNewContext(codeToRun, vm.createContext(context), { timeout: 1000 });

    if (!NFT || typeof NFT.HTML !== 'string') {
        throw new Error(`Script ${script} did not return a valid NFT object with HTML string`);
    }
  } catch (evalError) {
      console.error(`Error evaluating script ${script} for makePNG:`, evalError);
      throw evalError;
  }

  const htmlContent = NFT.HTML.trim();

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
        const baseImageType = basePart[0];
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
    const details = await getDetails(uid, script, { opt, exe });
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
    const [imgBuffer, imgType] = await makePNG(uid, script, exe);
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
        const [imgBuffer, imgType] = await makePNG(uid, script, exe);
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

function getDBPromotedPosts(amount, offset, bitMask) {
  return new Promise(async (resolve, reject) => {
    try {
        const types = typeMask(bitMask);
        if (types.length === 0) {
            resolve([]);
            return;
        }
        const query = `
            SELECT
                author,
                permlink,
                block,
                votes,
                voteweight,
                promote,
                paid
            FROM
                posts
            WHERE type = ANY($1) AND
                promote > 0
            ORDER BY
                promote DESC
            OFFSET $2 ROWS FETCH FIRST $3 ROWS ONLY;`;
        const params = [types, offset, amount];
        const res = await executeQuery(query, params, 'Error - Failed to select promoted posts');

        for (const item of res.rows) {
            item.url = `/dlux/@${item.author}/${item.permlink}`;
        }
        resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

exports.getTrendingPosts = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  let bitMask = parseInt(req.query.b) || 255;
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getTrendingPostsDB(amt, off, bitMask);
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
    console.error("Error getting trending posts:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get trending posts", node: config.username }, null, 3));
  }
};

function getTrendingPostsDB(amount, offset, bitMask) {
  return new Promise(async (resolve, reject) => {
    try {
      const types = typeMask(bitMask);
      if (types.length === 0) {
          resolve([]);
          return;
      }
      const query = `
          SELECT
              author,
              permlink,
              block,
              votes,
              voteweight,
              promote,
              paid
          FROM
              posts
          WHERE type = ANY($1) AND
              paid = false
          ORDER BY
              voteweight DESC
          OFFSET $2 ROWS FETCH FIRST $3 ROWS ONLY;`;
      const params = [types, offset, amount];
      const res = await executeQuery(query, params, 'Error - Failed to select trending posts');

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getPost(author, permlink) {
  return new Promise(async (resolve, reject) => {
    try {
      const query = `SELECT * FROM posts WHERE author = $1 AND permlink = $2;`;
      const params = [author, permlink];
      const res = await executeQuery(query, params, `Error - Failed to get post @${author}/${permlink}`);

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

exports.getPost = getPost;

exports.getPostRoute = async (req, res, next) => {
  const a = req.params.author;
  const p = req.params.permlink;
  try {
    const results = await getPost(a, p);
    res.send(
      JSON.stringify(
        {
          result: results.length > 0 ? results[0] : null,
          node: config.username,
        },
        null,
        3
      )
    );
  } catch (e) {
    console.error(`Error in getPostRoute for @${a}/${p}:`, e);
    res.status(500).send(JSON.stringify({ error: "Failed to get post", node: config.username }, null, 3));
  }
};

exports.getNewPosts = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  let bitMask = parseInt(req.query.b) || 255;
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getNewPostsDB(amt, off, bitMask);
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
    console.error("Error getting new posts:", e);
    res.status(500).send(JSON.stringify({ error: "Failed to get new posts", node: config.username }, null, 3));
  }
};

function getNewPostsDB(amount, offset, bitMask) {
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
          OFFSET $2 ROWS
          FETCH FIRST $3 ROWS ONLY;`;
      const params = [types, offset, amount];
      const res = await executeQuery(query, params, 'Error - Failed to select new posts');

      for (const item of res.rows) {
        item.url = `/dlux/@${item.author}/${item.permlink}`;
        item.l2votes = item.votes;
      }
      resolve(res.rows);
    } catch (err) {
      reject(err);
    }
  });
}

function getAuthorPostsDB(author, amount, offset) {
  return new Promise(async (resolve, reject) => {
    try {
        const query = `
            SELECT
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
                author = $1
            ORDER BY
                block DESC
            OFFSET $2 ROWS FETCH FIRST $3 ROWS ONLY;`;
        const params = [author, offset, amount];
        const res = await executeQuery(query, params, `Error - Failed to select posts for author ${author}`);

        for (const item of res.rows) {
            item.url = `/dlux/@${item.author}/${item.permlink}`;
        }
        resolve(res.rows);
    } catch (err) {
        reject(err);
    }
  });
}

exports.getAuthorPostsDB = getAuthorPostsDB;

exports.getAuthorPosts = async (req, res, next) => {
  let amt = parseInt(req.query.a) || 50;
  let off = parseInt(req.query.o) || 0;
  const author = req.params.author;
  if (amt < 1) amt = 1;
  else if (amt > 100) amt = 100;
  if (off < 0) off = 0;

  res.setHeader("Content-Type", "application/json");
  try {
    const results = await getAuthorPostsDB(author, amt, off);
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
    console.error(`Error getting posts for author ${author}:`, e);
    res.status(500).send(JSON.stringify({ error: "Failed to get author posts", node: config.username }, null, 3));
  }
};

exports.https_redirect = (req, res, next) => {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging") {
    if (req.headers["x-forwarded-proto"] !== "https") {
       const host = req.headers.host;
       if (!host) {
           console.warn("Missing Host header, cannot perform HTTPS redirect.");
           return next();
       }
      console.log(`Redirecting http://${host}${req.url} to https`);
      return res.redirect(301, "https://" + host + req.url);
    } else {
      return next();
    }
  } else {
    console.log("Skipping HTTPS redirect in development mode");
    return next();
  }
};

exports.hive_api = async (req, res, next) => {
  const method = `${req.params.api_type}.${req.params.api_call}`;
  let params = {};
  let array = false;

  if (req.query.hasOwnProperty('0')) {
      array = true;
      params = [];
      let i = 0;
      while(req.query.hasOwnProperty(String(i))) {
          try {
             params.push(JSON.parse(req.query[String(i)]));
          } catch (e) {
             params.push(req.query[String(i)]);
          }
          i++;
      }
  } else {
      for (const param in req.query) {
          try {
              params[param] = JSON.parse(req.query[param]);
          } catch(e) {
              params[param] = req.query[param];
          }
      }
  }

  const body = {
    jsonrpc: "2.0",
    method: method,
    params: array ? params : [params],
    id: 1,
  };

  res.setHeader("Content-Type", "application/json");
  console.log(`Proxying Hive API call: ${method} with params: ${JSON.stringify(body.params)}`);

  try {
    const hiveResponse = await fetch(config.clientURL, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!hiveResponse.ok) {
        throw new Error(`Hive API error: ${hiveResponse.status} ${hiveResponse.statusText}`);
    }

    const hiveResult = await hiveResponse.json();
    res.send(JSON.stringify(hiveResult, null, 3));

  } catch (error) {
    console.error(`Error proxying Hive API call ${method}:`, error);
    res.status(502).send(JSON.stringify({ error: "Bad Gateway - Failed to proxy Hive API request", details: error.message }, null, 3));
  }
};

exports.getpic = async (req, res, next) => {
    const un = req.params.un || "";
    if (!un) {
        return res.status(400).send("Username parameter 'un' is required.");
    }

    const body = {
        jsonrpc: "2.0",
        method: "condenser_api.get_accounts",
        params: [[un]],
        id: 1,
    };

    try {
        console.log(`Fetching account info for ${un} for profile picture...`);
        const hiveResponse = await fetch(config.clientURL, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });

        if (!hiveResponse.ok) {
            throw new Error(`Hive API error: ${hiveResponse.status} ${hiveResponse.statusText}`);
        }

        const r = await hiveResponse.json();

        if (!r.result || r.result.length === 0) {
            console.log(`Account ${un} not found on Hive.`);
            return res.status(404).send(`Account ${un} not found.`);
        }

        const account = r.result[0];
        let imageUrl = null;
        let metadataSource = '';

        try {
            const json_metadata = JSON.parse(account.json_metadata || '{}');
            imageUrl = json_metadata?.profile?.profile_image;
            if (imageUrl) metadataSource = 'json_metadata';
        } catch (e) { console.warn(`Error parsing json_metadata for ${un}`, e); }

        if (!imageUrl) {
            try {
                const posting_json_metadata = JSON.parse(account.posting_json_metadata || '{}');
                imageUrl = posting_json_metadata?.profile?.profile_image;
                 if (imageUrl) metadataSource = 'posting_json_metadata';
            } catch (e) { console.warn(`Error parsing posting_json_metadata for ${un}`, e); }
        }

        if (!imageUrl) {
            console.log(`No profile image found in metadata for ${un}. Using fallback.`);
            imageUrl = "https://ipfs.dlux.io/images/user-icon.svg";
            metadataSource = 'fallback';
        }

        console.log(`Attempting to fetch profile image for ${un} from ${imageUrl} (source: ${metadataSource})`);

        const imageResponse = await fetch(imageUrl);
        if (imageResponse.ok) {
            const contentType = imageResponse.headers.get('content-type') || 'image/svg+xml';
             res.setHeader('Content-Type', contentType);
             imageResponse.body.pipe(res);
        } else {
            console.error(`Failed to fetch image ${imageUrl} for ${un} (status: ${imageResponse.status}). Trying fallback if not already used.`);
            if (metadataSource !== 'fallback') {
                 const fallbackUrl = "https://ipfs.dlux.io/images/user-icon.svg";
                 console.log(`Attempting fallback image: ${fallbackUrl}`);
                 const fallbackResponse = await fetch(fallbackUrl);
                 if (fallbackResponse.ok) {
                     res.setHeader('Content-Type', fallbackResponse.headers.get('content-type') || 'image/svg+xml');
                     fallbackResponse.body.pipe(res);
                 } else {
                     console.error(`Fallback image fetch also failed (status: ${fallbackResponse.status}).`);
                     res.status(404).send("Profile image not found or fetch failed.");
                 }
            } else {
                 res.status(404).send("Profile image not found or fetch failed.");
            }
        }

    } catch (error) {
        console.error(`Error fetching profile picture for ${un}:`, error);
        res.status(500).send(JSON.stringify({ error: "Failed to get profile picture", details: error.message }, null, 3));
    }
};


