const express = require("express");
const axios = require("axios");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { initializeDatabase, getDb } = require("./database");

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use(cors());

const JWT_SECRET = "super_secret_key_change_this_in_prod";

// ------------------ AUTH MIDDLEWARE ------------------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ------------------ AUTH ROUTES ------------------

app.post("/api/auth/register", async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const db = getDb();
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await db.run(
      `INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)`,
      [email, hashedPassword, full_name]
    );

    // Create initial empty portfolio
    await db.run(
      `INSERT INTO portfolios (user_id) VALUES (?)`,
      [result.lastID]
    );

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    if (error.message.includes("UNIQUE constraint failed")) {
      return res.status(400).json({ error: "Email already exists" });
    }
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const db = getDb();
    const user = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);

    if (!user) {
      return res.status(400).json({ error: "User not found" });
    }

    if (await bcrypt.compare(password, user.password_hash)) {
      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
      res.json({ token, user: { id: user.id, email: user.email, full_name: user.full_name } });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const ccxt = require("ccxt");
const CryptoJS = require("crypto-js");

// ... (existing imports)

const ENCRYPTION_KEY = "another_super_secret_key"; // In prod, use env var

// Helper to encrypt/decrypt
function encrypt(text) {
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}

function decrypt(ciphertext) {
  const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// ------------------ EXCHANGE ROUTES ------------------

app.post("/api/exchange/keys", authenticateToken, async (req, res) => {
  const { exchange, apiKey, apiSecret } = req.body;

  if (!exchange || !apiKey || !apiSecret) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const db = getDb();

    // Sanitize Secret (Handle PEM keys)
    let sanitizedSecret = apiSecret.trim();

    // Replace literal \n with actual newlines
    if (sanitizedSecret.includes("\\n")) {
      sanitizedSecret = sanitizedSecret.replace(/\\n/g, '\n');
    }

    // Generic PEM cleanup (Handles EC and RSA)
    const pemRegex = /(-{5}BEGIN [A-Z ]+PRIVATE KEY-{5})([\s\S]*?)(-{5}END [A-Z ]+PRIVATE KEY-{5})/;
    const match = sanitizedSecret.match(pemRegex);

    if (match) {
      // Use the original headers to preserve the key format (SEC1 vs PKCS#8)
      // Changing the header without converting the body will break the key.
      const header = match[1];
      const body = match[2].replace(/\s/g, ""); // Remove all whitespace from body
      const footer = match[3];

      // Reconstruct PEM with correct newlines
      sanitizedSecret = `${header}\n${body}\n${footer}`;
    }

    console.log("Sanitized Key Length:", sanitizedSecret.length);
    console.log("Key Header (Normalized):", sanitizedSecret.substring(0, 40));
    console.log("Key Body Start:", sanitizedSecret.substring(30, 50));

    const encryptedKey = encrypt(apiKey);
    const encryptedSecret = encrypt(sanitizedSecret);

    await db.run(
      `INSERT INTO api_keys (user_id, exchange, api_key, api_secret) VALUES (?, ?, ?, ?)`,
      [req.user.id, exchange, encryptedKey, encryptedSecret]
    );

    res.json({ message: "Exchange connected successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/portfolio/sync", authenticateToken, async (req, res) => {
  try {
    const db = getDb();

    // 1. Get User's Keys
    const keys = await db.all(`SELECT * FROM api_keys WHERE user_id = ?`, [req.user.id]);

    if (keys.length === 0) {
      return res.status(400).json({ error: "No exchange connected" });
    }

    let totalValue = 0;
    let allAssets = [];

    // 2. Iterate through connected exchanges (handling multiple if needed)
    for (const key of keys) {
      const exchangeId = key.exchange.toLowerCase();
      const exchangeClass = ccxt[exchangeId];

      if (!exchangeClass) continue;

      const exchange = new exchangeClass({
        apiKey: decrypt(key.api_key),
        secret: decrypt(key.api_secret),
        enableRateLimit: true,
      });

      // 3. Fetch Balance
      const balance = await exchange.fetchBalance();
      const items = balance.total;

      // Filter for non-zero assets
      for (const [symbol, amount] of Object.entries(items)) {
        if (amount > 0) {
          // Fetch current price to calculate USD value
          let price = 0;
          try {
            if (symbol === 'USDT' || symbol === 'USD') {
              price = 1;
            } else {
              const ticker = await exchange.fetchTicker(`${symbol}/USDT`);
              price = ticker.last;
            }
          } catch (e) {
            console.warn(`Could not fetch price for ${symbol}`);
          }

          const valueUSD = amount * price;
          totalValue += valueUSD;

          allAssets.push({
            symbol,
            amount,
            value_usd: valueUSD,
            exchange: exchangeId
          });
        }
      }
    }

    // 4. Update Portfolio in DB
    await db.run(
      `UPDATE portfolios SET total_value_usd = ?, assets = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
      [totalValue, JSON.stringify(allAssets), req.user.id]
    );

    res.json({ message: "Portfolio synced", total_value_usd: totalValue, assets: allAssets });

  } catch (error) {
    console.error("Sync Error Stack:", error);
    res.status(500).json({ error: "Sync failed: " + error.message });
  }
});

app.get("/api/user/profile", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.get(`SELECT id, email, full_name, created_at FROM users WHERE id = ?`, [req.user.id]);
    const portfolio = await db.get(`SELECT * FROM portfolios WHERE user_id = ?`, [req.user.id]);

    res.json({ user, portfolio });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ------------------ HELPER FUNCTIONS ------------------

function runDataCollector(symbol) {
  return new Promise((resolve, reject) => {
    console.log(`Fetching data for ${symbol}...`);
    execFile(
      "./new_venv/bin/python",
      ["data_collector.py", symbol],
      { cwd: __dirname },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`Data collection error: ${stderr}`);
          return reject(error);
        }
        console.log(stdout);
        resolve(stdout);
      }
    );
  });
}

function getAIPrediction(symbol) {
  return new Promise((resolve, reject) => {
    // We no longer pass features manually, the python script fetches data and calculates them
    const args = ["ai_model.py", symbol];

    execFile(
      "./new_venv/bin/python",
      args,
      { cwd: __dirname },
      (error, stdout, stderr) => {
        if (error) return reject(error);

        try {
          // Find the last line that is valid JSON (in case of TF logs)
          const lines = stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const result = JSON.parse(lastLine);

          if (result.error) {
            reject(result.error);
          } else {
            resolve(result);
          }
        } catch (e) {
          reject("Could not parse Python output: " + stdout + " | Stderr: " + stderr);
        }
      }
    );
  });
}

// ======================================================
// ------------------ GENERIC ENDPOINT ------------------
// ======================================================

app.get("/predict/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const pair = `${symbol}USDT`; // Assuming USDT pairs for simplicity

  // Check if we have data for this symbol
  const dataFile = path.join(__dirname, `market_data_${pair}.csv`);

  try {
    // Always try to fetch fresh daily data if file is old or missing
    // For simplicity, we just run data collector every time or if missing.
    // Given the request for "live market trends", fetching fresh data is better.
    await runDataCollector(pair);

    // Run AI Model (which now handles feature engineering internally)
    const predictionResult = await getAIPrediction(pair);

    res.json(predictionResult);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.toString() });
  }
});

// ======================================================
// ----------------------- SERVER ------------------------
// ======================================================

const PORT = 3000;

// Initialize DB then start server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🔥 Server running on port ${PORT}`);
    console.log(`Open the App → http://localhost:${PORT}`);
    console.log(`API Example → http://localhost:${PORT}/predict/BTC`);
  });
}).catch(err => {
  console.error("Failed to initialize database:", err);
});
