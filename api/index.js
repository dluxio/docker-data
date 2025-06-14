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
  
  if (!['accept', 'reject'].includes(action)) {
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


