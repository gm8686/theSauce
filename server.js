import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, sign } from "node:crypto";
import { randomBytes, timingSafeEqual } from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const tradeLogPath = join(__dirname, "trades.jsonl");
const latencyLogPath = join(__dirname, "latency.jsonl");
const gatewayBase = "https://gateway.polymarket.us";
const tradingBase = "https://api.polymarket.us";

loadEnv();

const port = Number(process.env.PORT || 5173);
const databaseUrl = process.env.DATABASE_URL || "";
const liveTradingEnabled = process.env.ENABLE_LIVE_TRADING === "true";
const buyNotionalUsd = parsePositiveMoney(process.env.BUY_NOTIONAL_USD || "1.02", 1.02);
const slippageBips = parseNonNegativeInteger(process.env.SLIPPAGE_BIPS || "500", 500);
const appPassword = process.env.APP_PASSWORD || "";
const appSessions = new Set();
let tradePool = null;
let tradeStoreReadyPromise = null;

function loadEnv() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        return eq === -1 ? [part, ""] : [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
      }),
  );
}

function passwordMatches(candidate) {
  const expected = Buffer.from(appPassword);
  const actual = Buffer.from(String(candidate || ""));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isAuthenticated(req) {
  if (!appPassword) return true;
  const token = parseCookies(req).nhl_trader_session;
  return Boolean(token && appSessions.has(token));
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `nhl_trader_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "nhl_trader_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const message = body?.message || body?.error || response.statusText;
    throw Object.assign(new Error(message), { status: response.status, body });
  }

  return body;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePositiveMoney(value, fallback) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  return amount;
}

function parseNonNegativeInteger(value, fallback) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 0) return fallback;
  return amount;
}

function amount(value) {
  return { value: Number(value).toFixed(2), currency: "USD" };
}

function fixedMoney(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : fallback;
}

function fixedMs(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function money(value) {
  const number = asNumber(value);
  if (number === null) return null;
  return number.toFixed(2);
}

function diffMs(start, end) {
  if (!start || !end) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return fixedMs(value);
}

function selectedTeamOrderPrice(side) {
  const teamPrice = asNumber(side.quote?.value ?? side.price);
  if (teamPrice === null) return null;
  return Math.min(0.99, Math.max(0.01, teamPrice)).toFixed(2);
}

function contractPrice(side) {
  return money(side.quote?.value ?? side.price);
}

function normalizeGame(event) {
  const moneyline = event.markets?.find((market) => {
    return (
      market.active &&
      !market.closed &&
      !market.archived &&
      !market.hidden &&
      (market.sportsMarketTypeV2 === "SPORTS_MARKET_TYPE_MONEYLINE" ||
        market.sportsMarketType === "moneyline" ||
        market.marketType === "moneyline")
    );
  });

  if (!moneyline || !Array.isArray(moneyline.marketSides) || moneyline.marketSides.length < 2) {
    return null;
  }

  const sides = moneyline.marketSides
    .filter((side) => side.team || side.description)
    .map((side) => ({
      sideId: String(side.id),
      marketSlug: moneyline.slug,
      marketId: String(moneyline.id),
      name: side.team?.name || side.description,
      shortName: side.team?.displayAbbreviation || side.team?.abbreviation?.toUpperCase() || side.description,
      logo: side.team?.logo || side.team?.shortIcon || side.team?.longIcon || null,
      color: side.team?.colorPrimary || side.team?.color?.light || "#20262f",
      long: Boolean(side.long),
      buyIntent: side.long ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT",
      sellIntent: side.long ? "ORDER_INTENT_SELL_LONG" : "ORDER_INTENT_SELL_SHORT",
      displayPrice: contractPrice(side),
      orderPrice: selectedTeamOrderPrice(side),
    }));

  return {
    id: String(event.id),
    league: event.categoryTitle || event.league || null,
    slug: event.slug,
    title: event.title,
    startTime: event.startTime || event.startDate,
    live: Boolean(event.live),
    period: event.period || null,
    score: event.score || null,
    market: {
      id: String(moneyline.id),
      slug: moneyline.slug,
      question: moneyline.question,
      tickSize: moneyline.orderPriceMinTickSize || 0.01,
      bestBid: money(moneyline.bestBidQuote?.value),
      bestAsk: money(moneyline.bestAskQuote?.value),
    },
    sides,
  };
}

async function getLeagueGames(league) {
  const normalizedLeague = String(league || "").toLowerCase();
  if (!["nhl", "mlb"].includes(normalizedLeague)) {
    throw Object.assign(new Error("Unsupported league"), { status: 400 });
  }

  const url = new URL(`/v2/leagues/${normalizedLeague}/events`, gatewayBase);
  url.searchParams.set("limit", "100");
  url.searchParams.set("type", "sport");
  const data = await fetchJson(url);
  const games = (data.events || []).map(normalizeGame).filter(Boolean);
  games.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  return games;
}

function polymarketHeaders(method, path) {
  const keyId = process.env.POLYMARKET_KEY_ID;
  const secretKey = process.env.POLYMARKET_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw Object.assign(new Error("Missing POLYMARKET_KEY_ID or POLYMARKET_SECRET_KEY"), { status: 401 });
  }

  const seed = Buffer.from(secretKey, "base64").subarray(0, 32);
  if (seed.length !== 32) {
    throw Object.assign(new Error("POLYMARKET_SECRET_KEY must decode to at least 32 bytes"), { status: 401 });
  }

  const derPrefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([derPrefix, seed]),
    format: "der",
    type: "pkcs8",
  });

  const timestamp = String(Date.now());
  const message = Buffer.from(`${timestamp}${method}${path}`);
  const signature = sign(null, message, privateKey).toString("base64");

  return {
    "Content-Type": "application/json",
    "X-PM-Access-Key": keyId,
    "X-PM-Timestamp": timestamp,
    "X-PM-Signature": signature,
  };
}

function executionQuantity(execution) {
  const lastShares = Number(execution?.lastShares || 0);
  const cumQuantity = Number(execution?.order?.cumQuantity || 0);
  return Math.max(lastShares, cumQuantity);
}

function executionRejectMessage(execution) {
  return (
    execution?.text ||
    execution?.orderRejectReason ||
    execution?.order?.state ||
    "Order was not filled."
  );
}

function requireFill(result, action) {
  const executions = Array.isArray(result?.executions) ? result.executions : [];
  const filledQuantity = executions.reduce((total, execution) => total + executionQuantity(execution), 0);

  if (filledQuantity > 0) {
    return {
      ...result,
      filledQuantity,
    };
  }

  const reject = executions.find((execution) => execution?.orderRejectReason || execution?.text || execution?.order?.state);
  const message = reject
    ? executionRejectMessage(reject)
    : `${action === "buy" ? "Buy" : "Sell"} order was submitted but no fill was confirmed.`;
  throw Object.assign(new Error(message), { status: 409, body: result });
}

function executionPrice(execution) {
  const values = [
    execution?.lastPrice,
    execution?.order?.avgPrice,
    execution?.order?.price?.value,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values[0] || 0;
}

function nominalValueFromFill(result, fallbackPrice, fallbackNotional) {
  const executions = Array.isArray(result?.executions) ? result.executions : [];
  let nominal = 0;

  for (const execution of executions) {
    nominal += executionQuantity(execution) * executionPrice(execution);
  }

  if (nominal > 0) return fixedMoney(nominal);

  const fallbackQuantity = Number(result?.filledQuantity || 0);
  if (fallbackQuantity > 0 && Number.isFinite(fallbackPrice)) {
    return fixedMoney(fallbackQuantity * fallbackPrice, fixedMoney(fallbackNotional));
  }

  return fixedMoney(fallbackNotional);
}

function averageFillPrice(result, fallbackPrice = null) {
  const executions = Array.isArray(result?.executions) ? result.executions : [];
  let valueSum = 0;
  let quantitySum = 0;

  for (const execution of executions) {
    const quantity = executionQuantity(execution);
    const price = executionPrice(execution);
    if (quantity > 0 && price > 0) {
      valueSum += quantity * price;
      quantitySum += quantity;
    }
  }

  if (quantitySum > 0) return fixedMoney(valueSum / quantitySum, fallbackPrice);
  return fixedMoney(fallbackPrice, null);
}

async function ensureTradeStoreReady() {
  if (!databaseUrl) return "file";
  if (tradeStoreReadyPromise) return tradeStoreReadyPromise;

  tradeStoreReadyPromise = (async () => {
    const { Pool } = await import("pg");
    tradePool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("render.com") ? { rejectUnauthorized: false } : undefined,
    });

    await tradePool.query(`
      CREATE TABLE IF NOT EXISTS trade_log (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        league TEXT,
        market_slug TEXT NOT NULL,
        market_title TEXT,
        team_name TEXT,
        action TEXT NOT NULL,
        nominal_usd NUMERIC(12, 2) NOT NULL,
        filled_quantity NUMERIC(12, 4),
        price NUMERIC(12, 4)
      )
    `);

    await tradePool.query(`
      CREATE TABLE IF NOT EXISTS latency_log (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        league TEXT,
        team_name TEXT,
        market_slug TEXT,
        action TEXT NOT NULL,
        success BOOLEAN,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        error_message TEXT,
        client_click_started_at TIMESTAMPTZ,
        client_request_started_at TIMESTAMPTZ,
        server_received_at TIMESTAMPTZ,
        polymarket_request_started_at TIMESTAMPTZ,
        polymarket_response_received_at TIMESTAMPTZ,
        server_response_sent_at TIMESTAMPTZ,
        client_response_received_at TIMESTAMPTZ,
        client_to_server_ms INTEGER,
        server_total_ms INTEGER,
        polymarket_roundtrip_ms INTEGER,
        server_to_client_ms INTEGER,
        client_total_ms INTEGER,
        contract_price_at_press NUMERIC(12, 4),
        contract_price_at_fill NUMERIC(12, 4),
        contract_price_delta NUMERIC(12, 4)
      )
    `);

    await tradePool.query(`ALTER TABLE latency_log ADD COLUMN IF NOT EXISTS contract_price_at_press NUMERIC(12, 4)`);
    await tradePool.query(`ALTER TABLE latency_log ADD COLUMN IF NOT EXISTS contract_price_at_fill NUMERIC(12, 4)`);
    await tradePool.query(`ALTER TABLE latency_log ADD COLUMN IF NOT EXISTS contract_price_delta NUMERIC(12, 4)`);

    return "postgres";
  })();

  return tradeStoreReadyPromise;
}

function readTradeLogFile() {
  if (!existsSync(tradeLogPath)) return [];
  return readFileSync(tradeLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function appendTradeLogFile(entry) {
  appendFileSync(tradeLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function readTradeLog() {
  if (!databaseUrl) return readTradeLogFile();
  await ensureTradeStoreReady();
  const result = await tradePool.query(
    `
      SELECT
        id,
        created_at AS "createdAt",
        league,
        market_slug AS "marketSlug",
        market_title AS "marketTitle",
        team_name AS "teamName",
        action,
        nominal_usd AS "nominalUsd",
        filled_quantity AS "filledQuantity",
        price
      FROM trade_log
      ORDER BY created_at DESC
      LIMIT 100
    `,
  );
  return result.rows.map((row) => ({
    ...row,
    nominalUsd: fixedMoney(row.nominalUsd),
    filledQuantity: fixedMoney(row.filledQuantity),
    price: fixedMoney(row.price),
  }));
}

async function logTrade(entry) {
  const record = {
    id: randomBytes(10).toString("hex"),
    createdAt: new Date().toISOString(),
    ...entry,
  };

  if (!databaseUrl) {
    appendTradeLogFile(record);
    return record;
  }

  await ensureTradeStoreReady();
  await tradePool.query(
    `
      INSERT INTO trade_log (
        id,
        created_at,
        league,
        market_slug,
        market_title,
        team_name,
        action,
        nominal_usd,
        filled_quantity,
        price
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,
    [
      record.id,
      record.createdAt,
      record.league || null,
      record.marketSlug,
      record.marketTitle || null,
      record.teamName || null,
      record.action,
      record.nominalUsd,
      record.filledQuantity ?? null,
      record.price ?? null,
    ],
  );

  return record;
}

function createLatencyRecord(input) {
  return {
    id: String(input.latencyId || randomBytes(10).toString("hex")),
    createdAt: new Date().toISOString(),
    league: String(input.league || "").toLowerCase(),
    teamName: String(input.teamName || ""),
    marketSlug: String(input.marketSlug || ""),
    action: String(input.action || "buy"),
    success: null,
    dryRun: false,
    errorMessage: null,
    clientClickStartedAt: input.clientClickStartedAt || null,
    clientRequestStartedAt: input.clientRequestStartedAt || null,
    serverReceivedAt: new Date().toISOString(),
    polymarketRequestStartedAt: null,
    polymarketResponseReceivedAt: null,
    serverResponseSentAt: null,
    clientResponseReceivedAt: null,
    clientToServerMs: null,
    serverTotalMs: null,
    polymarketRoundtripMs: null,
    serverToClientMs: null,
    clientTotalMs: null,
    contractPriceAtPress: fixedMoney(input.orderPrice, null),
    contractPriceAtFill: null,
    contractPriceDelta: null,
  };
}

function finalizeLatencyDerived(record) {
  const contractPriceAtPress = fixedMoney(record.contractPriceAtPress, null);
  const contractPriceAtFill = fixedMoney(record.contractPriceAtFill, null);
  return {
    ...record,
    clientToServerMs: diffMs(record.clientRequestStartedAt, record.serverReceivedAt),
    serverTotalMs: diffMs(record.serverReceivedAt, record.serverResponseSentAt),
    polymarketRoundtripMs: diffMs(record.polymarketRequestStartedAt, record.polymarketResponseReceivedAt),
    serverToClientMs: diffMs(record.serverResponseSentAt, record.clientResponseReceivedAt),
    clientTotalMs: diffMs(record.clientClickStartedAt, record.clientResponseReceivedAt),
    contractPriceAtPress,
    contractPriceAtFill,
    contractPriceDelta:
      contractPriceAtPress !== null && contractPriceAtFill !== null
        ? fixedMoney(contractPriceAtFill - contractPriceAtPress, null)
        : fixedMoney(record.contractPriceDelta, null),
  };
}

function readLatencyLogFile() {
  if (!existsSync(latencyLogPath)) return [];
  const byId = new Map();

  for (const line of readFileSync(latencyLogPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      byId.set(record.id, record);
    } catch {
      // Ignore malformed log lines and keep the latest valid record per id.
    }
  }

  return [...byId.values()]
    .map(finalizeLatencyDerived)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function appendLatencyLogFile(record) {
  appendFileSync(latencyLogPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function upsertLatencyRecord(record) {
  const normalized = finalizeLatencyDerived(record);

  if (!databaseUrl) {
    appendLatencyLogFile(normalized);
    return normalized;
  }

  await ensureTradeStoreReady();
  await tradePool.query(
    `
      INSERT INTO latency_log (
        id,
        created_at,
        league,
        team_name,
        market_slug,
        action,
        success,
        dry_run,
        error_message,
        client_click_started_at,
        client_request_started_at,
        server_received_at,
        polymarket_request_started_at,
        polymarket_response_received_at,
        server_response_sent_at,
        client_response_received_at,
        client_to_server_ms,
        server_total_ms,
        polymarket_roundtrip_ms,
        server_to_client_ms,
        client_total_ms,
        contract_price_at_press,
        contract_price_at_fill,
        contract_price_delta
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
      )
      ON CONFLICT (id) DO UPDATE SET
        success = EXCLUDED.success,
        dry_run = EXCLUDED.dry_run,
        error_message = EXCLUDED.error_message,
        client_click_started_at = EXCLUDED.client_click_started_at,
        client_request_started_at = EXCLUDED.client_request_started_at,
        server_received_at = EXCLUDED.server_received_at,
        polymarket_request_started_at = EXCLUDED.polymarket_request_started_at,
        polymarket_response_received_at = EXCLUDED.polymarket_response_received_at,
        server_response_sent_at = EXCLUDED.server_response_sent_at,
        client_response_received_at = EXCLUDED.client_response_received_at,
        client_to_server_ms = EXCLUDED.client_to_server_ms,
        server_total_ms = EXCLUDED.server_total_ms,
        polymarket_roundtrip_ms = EXCLUDED.polymarket_roundtrip_ms,
        server_to_client_ms = EXCLUDED.server_to_client_ms,
        client_total_ms = EXCLUDED.client_total_ms,
        contract_price_at_press = EXCLUDED.contract_price_at_press,
        contract_price_at_fill = EXCLUDED.contract_price_at_fill,
        contract_price_delta = EXCLUDED.contract_price_delta,
        error_message = EXCLUDED.error_message
    `,
    [
      normalized.id,
      normalized.createdAt,
      normalized.league || null,
      normalized.teamName || null,
      normalized.marketSlug || null,
      normalized.action,
      normalized.success,
      normalized.dryRun,
      normalized.errorMessage || null,
      normalized.clientClickStartedAt,
      normalized.clientRequestStartedAt,
      normalized.serverReceivedAt,
      normalized.polymarketRequestStartedAt,
      normalized.polymarketResponseReceivedAt,
      normalized.serverResponseSentAt,
      normalized.clientResponseReceivedAt,
      normalized.clientToServerMs,
      normalized.serverTotalMs,
      normalized.polymarketRoundtripMs,
      normalized.serverToClientMs,
      normalized.clientTotalMs,
      normalized.contractPriceAtPress,
      normalized.contractPriceAtFill,
      normalized.contractPriceDelta,
    ],
  );

  return normalized;
}

async function readLatencyLog() {
  if (!databaseUrl) return readLatencyLogFile().slice(0, 100);
  await ensureTradeStoreReady();
  const result = await tradePool.query(
    `
      SELECT
        id,
        created_at AS "createdAt",
        league,
        team_name AS "teamName",
        market_slug AS "marketSlug",
        action,
        success,
        dry_run AS "dryRun",
        error_message AS "errorMessage",
        client_click_started_at AS "clientClickStartedAt",
        client_request_started_at AS "clientRequestStartedAt",
        server_received_at AS "serverReceivedAt",
        polymarket_request_started_at AS "polymarketRequestStartedAt",
        polymarket_response_received_at AS "polymarketResponseReceivedAt",
        server_response_sent_at AS "serverResponseSentAt",
        client_response_received_at AS "clientResponseReceivedAt",
        client_to_server_ms AS "clientToServerMs",
        server_total_ms AS "serverTotalMs",
        polymarket_roundtrip_ms AS "polymarketRoundtripMs",
        server_to_client_ms AS "serverToClientMs",
        client_total_ms AS "clientTotalMs",
        contract_price_at_press AS "contractPriceAtPress",
        contract_price_at_fill AS "contractPriceAtFill",
        contract_price_delta AS "contractPriceDelta"
      FROM latency_log
      ORDER BY created_at DESC
      LIMIT 100
    `,
  );
  return result.rows.map(finalizeLatencyDerived);
}

async function getLatencyRecordById(id) {
  if (!id) return null;
  if (!databaseUrl) {
    return readLatencyLogFile().find((record) => record.id === id) || null;
  }

  await ensureTradeStoreReady();
  const result = await tradePool.query(
    `
      SELECT
        id,
        created_at AS "createdAt",
        league,
        team_name AS "teamName",
        market_slug AS "marketSlug",
        action,
        success,
        dry_run AS "dryRun",
        error_message AS "errorMessage",
        client_click_started_at AS "clientClickStartedAt",
        client_request_started_at AS "clientRequestStartedAt",
        server_received_at AS "serverReceivedAt",
        polymarket_request_started_at AS "polymarketRequestStartedAt",
        polymarket_response_received_at AS "polymarketResponseReceivedAt",
        server_response_sent_at AS "serverResponseSentAt",
        client_response_received_at AS "clientResponseReceivedAt",
        client_to_server_ms AS "clientToServerMs",
        server_total_ms AS "serverTotalMs",
        polymarket_roundtrip_ms AS "polymarketRoundtripMs",
        server_to_client_ms AS "serverToClientMs",
        client_total_ms AS "clientTotalMs",
        contract_price_at_press AS "contractPriceAtPress",
        contract_price_at_fill AS "contractPriceAtFill",
        contract_price_delta AS "contractPriceDelta"
      FROM latency_log
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );
  return result.rows[0] ? finalizeLatencyDerived(result.rows[0]) : null;
}

function summarizeLatency(records) {
  const totals = records.map((record) => record.clientTotalMs).filter((value) => Number.isFinite(value));
  const serverTotals = records.map((record) => record.serverTotalMs).filter((value) => Number.isFinite(value));
  const marketTotals = records.map((record) => record.polymarketRoundtripMs).filter((value) => Number.isFinite(value));
  const deltas = records
    .map((record) => record.contractPriceDelta)
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.abs(Number(value)));
  const successes = records.filter((record) => record.success === true).length;
  const failures = records.filter((record) => record.success === false).length;

  function stat(values, mode) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (mode === "avg") return fixedMs(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
    if (mode === "p95") return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    if (mode === "max") return sorted[sorted.length - 1];
    return sorted[Math.floor(sorted.length / 2)];
  }

  return {
    totalRecords: records.length,
    successes,
    failures,
    clientTotalP50Ms: stat(totals, "p50"),
    clientTotalP95Ms: stat(totals, "p95"),
    clientTotalAvgMs: stat(totals, "avg"),
    serverTotalAvgMs: stat(serverTotals, "avg"),
    polymarketAvgMs: stat(marketTotals, "avg"),
    contractDeltaAvg: deltas.length ? fixedMoney(deltas.reduce((sum, value) => sum + value, 0) / deltas.length, null) : null,
  };
}

async function placeOrder(input) {
  const latencyRecord = createLatencyRecord(input);
  const action = input.action;
  const intent = input.intent;
  const marketSlug = String(input.marketSlug || "");
  const teamName = String(input.teamName || "");
  const marketTitle = String(input.marketTitle || "");
  const league = String(input.league || "").toLowerCase();
  if (!marketSlug) {
    throw Object.assign(new Error("Missing market slug"), { status: 400 });
  }

  if (
    ![
      "ORDER_INTENT_BUY_LONG",
      "ORDER_INTENT_BUY_SHORT",
      "ORDER_INTENT_SELL_LONG",
      "ORDER_INTENT_SELL_SHORT",
    ].includes(intent)
  ) {
    throw Object.assign(new Error("Invalid order intent"), { status: 400 });
  }

  if (action === "sell") {
    return closePosition(input, latencyRecord);
  }

  if (action !== "buy") {
    throw Object.assign(new Error("Invalid order action"), { status: 400 });
  }

  const price = Number(input.orderPrice);
  if (!Number.isFinite(price) || price < 0.01 || price > 0.99) {
    throw Object.assign(new Error("Price must be between 0.01 and 0.99"), { status: 400 });
  }

  const order = {
    marketSlug,
    type: "ORDER_TYPE_MARKET",
    price: amount(price),
    cashOrderQty: amount(buyNotionalUsd),
    slippageTolerance: {
      currentPrice: amount(price),
      bips: slippageBips,
    },
    intent,
    manualOrderIndicator: "MANUAL_ORDER_INDICATOR_MANUAL",
    synchronousExecution: true,
    maxBlockTime: "5",
  };

  if (!liveTradingEnabled) {
    latencyRecord.dryRun = true;
    return {
      dryRun: true,
      action: "buy",
      message: "Live trading is disabled. Set ENABLE_LIVE_TRADING=true to submit real orders.",
      order,
      latencyRecord,
    };
  }

  const path = "/v1/orders";
  let result;
  try {
    latencyRecord.polymarketRequestStartedAt = new Date().toISOString();
    result = await fetchJson(`${tradingBase}${path}`, {
      method: "POST",
      headers: polymarketHeaders("POST", path),
      body: JSON.stringify(order),
    });
    latencyRecord.polymarketResponseReceivedAt = new Date().toISOString();
  } catch (error) {
    latencyRecord.polymarketResponseReceivedAt = new Date().toISOString();
    error.latencyRecord = latencyRecord;
    throw error;
  }
  try {
    const filled = requireFill(result, "buy");
    latencyRecord.contractPriceAtFill = averageFillPrice(filled, price);
    const nominalUsd = nominalValueFromFill(filled, price, buyNotionalUsd);
    const trade = await logTrade({
      league,
      marketSlug,
      marketTitle,
      teamName,
      action: "buy",
      nominalUsd,
      filledQuantity: fixedMoney(filled.filledQuantity),
      price: fixedMoney(price),
    });

    return {
      ...filled,
      trade,
      latencyRecord,
    };
  } catch (error) {
    error.latencyRecord = latencyRecord;
    throw error;
  }
}

async function getMarketPosition(marketSlug) {
  const path = "/v1/portfolio/positions";
  const data = await fetchJson(`${tradingBase}${path}?market=${encodeURIComponent(marketSlug)}`, {
    method: "GET",
    headers: polymarketHeaders("GET", path),
  });
  return {
    position: data.positions?.[marketSlug] || null,
    availableQuantity: Number(data.positions?.[marketSlug]?.qtyAvailable ?? data.availablePositions?.[0] ?? 0),
  };
}

function assertPositionMatchesSide(positionResult, sideLong) {
  const position = positionResult?.position;
  const netPosition = Number(position?.netPosition || 0);
  const qtyAvailable = Number(positionResult?.availableQuantity || 0);

  if (!position || netPosition === 0 || qtyAvailable <= 0) {
    throw Object.assign(new Error("No available shares to sell for this market."), { status: 400 });
  }

  if (sideLong && netPosition < 0) {
    throw Object.assign(new Error("You currently hold the other team in this market, so this sell was blocked."), { status: 400 });
  }

  if (!sideLong && netPosition > 0) {
    throw Object.assign(new Error("You currently hold the other team in this market, so this sell was blocked."), { status: 400 });
  }

  return { netPosition, qtyAvailable };
}

async function closePosition(input, latencyRecord = createLatencyRecord(input)) {
  const marketSlug = String(input.marketSlug || "");
  const sideLong = Boolean(input.sideLong);
  const price = Number(input.orderPrice);
  if (!Number.isFinite(price) || price < 0.01 || price > 0.99) {
    throw Object.assign(new Error("Price must be between 0.01 and 0.99"), { status: 400 });
  }

  const closeOrder = {
    marketSlug,
    price: amount(price),
    manualOrderIndicator: "MANUAL_ORDER_INDICATOR_MANUAL",
    synchronousExecution: true,
    maxBlockTime: "5",
    slippageTolerance: {
      currentPrice: amount(price),
      bips: slippageBips,
    },
  };

  if (!liveTradingEnabled) {
    latencyRecord.dryRun = true;
    return {
      dryRun: true,
      action: "sell",
      message: "Live trading is disabled. Set ENABLE_LIVE_TRADING=true to submit real orders.",
      order: closeOrder,
      latencyRecord,
    };
  }

  const position = assertPositionMatchesSide(await getMarketPosition(marketSlug), sideLong);
  const path = "/v1/order/close-position";
  let result;
  try {
    latencyRecord.polymarketRequestStartedAt = new Date().toISOString();
    result = await fetchJson(`${tradingBase}${path}`, {
      method: "POST",
      headers: polymarketHeaders("POST", path),
      body: JSON.stringify(closeOrder),
    });
    latencyRecord.polymarketResponseReceivedAt = new Date().toISOString();
  } catch (error) {
    latencyRecord.polymarketResponseReceivedAt = new Date().toISOString();
    error.latencyRecord = latencyRecord;
    throw error;
  }

  try {
    const filled = requireFill(result, "sell");
    latencyRecord.contractPriceAtFill = averageFillPrice(filled, price);
    const nominalUsd = nominalValueFromFill(filled, price, position.qtyAvailable * price);
    const trade = await logTrade({
      league: String(input.league || "").toLowerCase(),
      marketSlug,
      marketTitle: String(input.marketTitle || ""),
      teamName: String(input.teamName || ""),
      action: "sell",
      nominalUsd,
      filledQuantity: fixedMoney(filled.filledQuantity),
      price: fixedMoney(price),
    });

    return {
      ...filled,
      closedPosition: position,
      trade,
      latencyRecord,
    };
  } catch (error) {
    error.latencyRecord = latencyRecord;
    throw error;
  }
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (appPassword && !isAuthenticated(req)) {
    const login = await readFile(join(publicDir, "login.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(login);
    return;
  }

  const requested = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    }[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!appPassword) {
        json(res, 200, { ok: true, authenticated: true });
        return;
      }

      const body = await readJson(req);
      if (!passwordMatches(body.password)) {
        json(res, 401, { error: "Incorrect password" });
        return;
      }

      const token = randomBytes(32).toString("base64url");
      appSessions.add(token);
      setSessionCookie(res, token);
      json(res, 200, { ok: true, authenticated: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = parseCookies(req).nhl_trader_session;
      if (token) appSessions.delete(token);
      clearSessionCookie(res);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        authRequired: Boolean(appPassword),
        authenticated: isAuthenticated(req),
        liveTradingEnabled,
        buyNotionalUsd,
        slippageBips,
        tradeStore: databaseUrl ? "postgres" : "file",
        hasCredentials: Boolean(process.env.POLYMARKET_KEY_ID && process.env.POLYMARKET_SECRET_KEY),
      });
      return;
    }

    if (url.pathname.startsWith("/api/") && !isAuthenticated(req)) {
      json(res, 401, { error: "Password required" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/games") {
      json(res, 200, {
        games: await getLeagueGames(url.searchParams.get("league") || "nhl"),
        fetchedAt: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/trades") {
      json(res, 200, {
        trades: await readTradeLog(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/latency") {
      const records = await readLatencyLog();
      json(res, 200, {
        records,
        summary: summarizeLatency(records),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/latency/client") {
      const body = await readJson(req);
      const existing = await getLatencyRecordById(body.latencyId);
      if (!existing) {
        json(res, 404, { error: "Latency record not found" });
        return;
      }

      const updated = await upsertLatencyRecord({
        ...existing,
        clientResponseReceivedAt: body.clientResponseReceivedAt || new Date().toISOString(),
      });
      json(res, 200, {
        ok: true,
        record: updated,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/orders") {
      const body = await readJson(req);
      try {
        const result = await placeOrder(body);
        const latency = await upsertLatencyRecord({
          ...result.latencyRecord,
          success: true,
          dryRun: Boolean(result.dryRun),
          serverResponseSentAt: new Date().toISOString(),
        });
        json(res, 200, {
          ...result,
          latency,
        });
      } catch (error) {
        if (error.latencyRecord) {
          const latency = await upsertLatencyRecord({
            ...error.latencyRecord,
            success: false,
            errorMessage: error.message || "Unexpected error",
            serverResponseSentAt: new Date().toISOString(),
          });
          json(res, error.status || 500, {
            error: error.message || "Unexpected error",
            details: error.body || undefined,
            latency,
          });
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    json(res, error.status || 500, {
      error: error.message || "Unexpected error",
      details: error.body || undefined,
    });
  }
});

await ensureTradeStoreReady();

server.listen(port, () => {
  console.log(`NHL Polymarket trader running at http://localhost:${port}`);
  console.log(`Live trading: ${liveTradingEnabled ? "enabled" : "disabled"}`);
  console.log(`Buy notional: $${buyNotionalUsd.toFixed(2)}`);
  console.log(`Slippage bips: ${slippageBips}`);
  console.log(`Password gate: ${appPassword ? "enabled" : "disabled"}`);
  console.log(`Trade store: ${databaseUrl ? "postgres" : "file"}`);
});
