import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

const KALSHI_BASE =
  process.env.KALSHI_BASE_URL || "https://api.elections.kalshi.com/trade-api/v2";

const COINBASE_BASE =
  process.env.COINBASE_BASE_URL || "https://api.exchange.coinbase.com";

const NEWS_RSS_URL =
  process.env.RSS_FALLBACK_URL ||
  "https://news.google.com/rss/search?q=bitcoin%20OR%20btc%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen";

const DEFAULT_HEADERS = {
  "User-Agent": "kalshi-btc-15m-analyst-proxy/1.0",
  Accept: "application/json, text/plain, */*",
};

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseMaybeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildUrl(base, path, params = {}) {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null || raw === "") continue;
    url.searchParams.set(key, String(raw));
  }
  return url.toString();
}

async function fetchText(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...DEFAULT_HEADERS,
      ...(init.headers || {}),
    },
  });

  const text = await response.text();

  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} for ${url}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }

  return text;
}

async function fetchJson(url, init = {}) {
  const text = await fetchText(url, init);

  try {
    return JSON.parse(text);
  } catch (error) {
    const err = new Error(`Invalid JSON from ${url}`);
    err.cause = error;
    err.body = text;
    throw err;
  }
}

function normalizeKalshiMarket(raw) {
  if (!raw || typeof raw !== "object") return raw;

  const yesBid =
    toNumber(raw.yes_bid_dollars) ??
    toNumber(raw.yes_bid) ??
    toNumber(raw.yes_price_dollars) ??
    null;

  const yesAsk =
    toNumber(raw.yes_ask_dollars) ??
    toNumber(raw.yes_ask) ??
    null;

  const noBid =
    toNumber(raw.no_bid_dollars) ??
    toNumber(raw.no_bid) ??
    toNumber(raw.no_price_dollars) ??
    null;

  const noAsk =
    toNumber(raw.no_ask_dollars) ??
    toNumber(raw.no_ask) ??
    null;

  const closeTime =
    raw.close_time ||
    raw.expiration_time ||
    raw.end_date ||
    raw.end_time ||
    raw.close_date ||
    null;

  return {
    ticker: raw.ticker ?? null,
    title: raw.title ?? raw.question ?? raw.subtitle ?? null,
    question: raw.question ?? raw.title ?? null,
    status: raw.status ?? null,
    event_ticker: raw.event_ticker ?? null,
    series_ticker: raw.series_ticker ?? null,
    floor_strike: toNumber(raw.floor_strike) ?? toNumber(raw.floor_strike_dollars) ?? null,
    cap_strike: toNumber(raw.cap_strike) ?? toNumber(raw.cap_strike_dollars) ?? null,
    strike_type: raw.strike_type ?? null,
    yes_bid_dollars: yesBid,
    yes_ask_dollars: yesAsk,
    no_bid_dollars: noBid,
    no_ask_dollars: noAsk,
    last_price_dollars:
      toNumber(raw.last_price_dollars) ??
      toNumber(raw.last_price) ??
      null,
    previous_yes_bid_dollars:
      toNumber(raw.previous_yes_bid_dollars) ??
      toNumber(raw.previous_yes_bid) ??
      null,
    volume:
      toNumber(raw.volume) ??
      toNumber(raw.volume_dollars) ??
      toNumber(raw.volume_24h_fp) ??
      toNumber(raw.volume_fp) ??
      null,
    liquidity:
      toNumber(raw.liquidity) ??
      toNumber(raw.liquidity_dollars) ??
      null,
    open_interest:
      toNumber(raw.open_interest) ??
      toNumber(raw.open_interest_fp) ??
      null,
    yes_bid_size_fp: raw.yes_bid_size_fp ?? null,
    yes_ask_size_fp: raw.yes_ask_size_fp ?? null,
    close_time: closeTime,
    raw,
  };
}

function marketCloseTs(market) {
  const dt = parseMaybeDate(market?.close_time);
  return dt ? dt.getTime() : Number.POSITIVE_INFINITY;
}

function pickBestActiveMarket(markets, seriesTicker) {
  if (!Array.isArray(markets) || markets.length === 0) return null;

  const statusFiltered = markets.filter((m) => {
    const s = String(m.status || "").toLowerCase();
    return s === "open" || s === "active";
  });

  const pool = statusFiltered.length > 0 ? statusFiltered : markets;

  const prefix = seriesTicker ? `${seriesTicker}-` : null;
  const seriesFiltered = prefix
    ? pool.filter((m) => (m.ticker || "").startsWith(prefix))
    : pool;

  const candidates = seriesFiltered.length > 0 ? seriesFiltered : pool;

  return [...candidates].sort((a, b) => marketCloseTs(a) - marketCloseTs(b))[0] || null;
}

function summarizeKalshiOrderbook(payload) {
  const orderbook =
    payload?.orderbook_fp ||
    payload?.orderbook ||
    payload?.book ||
    payload ||
    {};

  const yes = Array.isArray(orderbook.yes_dollars) ? orderbook.yes_dollars : [];
  const no = Array.isArray(orderbook.no_dollars) ? orderbook.no_dollars : [];

  const bestYesBid = yes.length > 0 ? toNumber(yes[0][0]) : null;
  const bestNoBid = no.length > 0 ? toNumber(no[0][0]) : null;
  const bestYesAsk = bestNoBid !== null ? Number((1 - bestNoBid).toFixed(4)) : null;
  const bestNoAsk = bestYesBid !== null ? Number((1 - bestYesBid).toFixed(4)) : null;

  return {
    best_yes_bid_dollars: bestYesBid,
    best_yes_ask_dollars: bestYesAsk,
    best_no_bid_dollars: bestNoBid,
    best_no_ask_dollars: bestNoAsk,
    yes_bids: yes,
    no_bids: no,
    raw: payload,
  };
}

function extractItemsArray(payload, preferredKeys) {
  if (Array.isArray(payload)) return payload;
  for (const key of preferredKeys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function stripXmlCdata(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtmlEntities(stripXmlCdata(match[1])) : null;
}

function parseGoogleNewsRss(xml, limit = 10) {
  const items = [];
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const itemXml of itemMatches.slice(0, limit)) {
    const title = parseTag(itemXml, "title");
    const link = parseTag(itemXml, "link");
    const pubDate = parseTag(itemXml, "pubDate");
    const sourceMatch = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const source = sourceMatch
      ? decodeHtmlEntities(stripXmlCdata(sourceMatch[1]))
      : null;

    items.push({
      title,
      link,
      source,
      published_at: pubDate,
    });
  }

  return items;
}

async function getActiveKalshiMarket({ ticker, series_ticker = "KXBTC15M", limit = 200 } = {}) {
  if (ticker) {
    const url = buildUrl(KALSHI_BASE, `markets/${encodeURIComponent(ticker)}`);
    const payload = await fetchJson(url);
    const rawMarket = payload?.market ?? payload;
    return normalizeKalshiMarket(rawMarket);
  }

  const cappedLimit = clampInt(limit, 200, 1, 1000);

  const filteredUrl = buildUrl(KALSHI_BASE, "markets", {
    status: "open",
    series_ticker,
    limit: cappedLimit,
  });

  const filteredPayload = await fetchJson(filteredUrl);
  const filteredMarkets = extractItemsArray(filteredPayload, ["markets", "data"])
    .map(normalizeKalshiMarket);

  if (filteredMarkets.length > 0) {
    return pickBestActiveMarket(filteredMarkets, series_ticker);
  }

  const broadUrl = buildUrl(KALSHI_BASE, "markets", {
    status: "open",
    limit: cappedLimit,
  });

  const broadPayload = await fetchJson(broadUrl);
  const broadMarkets = extractItemsArray(broadPayload, ["markets", "data"])
    .map(normalizeKalshiMarket);

  const hardFiltered = broadMarkets.filter((m) => {
    const haystack = [
      m.ticker,
      m.event_ticker,
      m.series_ticker,
      m.title,
      m.question,
      m.raw?.subtitle,
      m.raw?.yes_sub_title,
      m.raw?.no_sub_title,
    ]
      .filter(Boolean)
      .join(" ")
      .toUpperCase();

    return (
      haystack.includes(String(series_ticker).toUpperCase()) ||
      (haystack.includes("BTC") && haystack.includes("15M")) ||
      haystack.includes("BITCOIN PRICE UP DOWN")
    );
  });

  return pickBestActiveMarket(hardFiltered, series_ticker);
}

async function getKalshiOrderbook({ ticker, depth = 10 }) {
  if (!ticker) {
    throw new Error("ticker is required");
  }

  const url = buildUrl(
    KALSHI_BASE,
    `markets/${encodeURIComponent(ticker)}/orderbook`,
    {
      depth: clampInt(depth, 10, 1, 100),
    }
  );

  const payload = await fetchJson(url);
  return summarizeKalshiOrderbook(payload);
}

async function getKalshiRecentTrades({
  ticker,
  limit = 50,
  cursor,
  lookback_seconds = 1800,
} = {}) {
  const cappedLimit = clampInt(limit, 50, 1, 1000);
  const cappedLookback = clampInt(lookback_seconds, 1800, 60, 86400);

  const nowSec = Math.floor(Date.now() / 1000);
  const minTs = nowSec - cappedLookback;

  const url = buildUrl(KALSHI_BASE, "markets/trades", {
    ticker: ticker || undefined,
    limit: cappedLimit,
    cursor,
    min_ts: minTs,
  });

  const payload = await fetchJson(url);

  const trades = extractItemsArray(payload, ["trades", "data"])
    .map((trade) => ({
      trade_id: trade.trade_id ?? null,
      ticker: trade.ticker ?? null,
      count_fp: trade.count_fp ?? trade.count ?? null,
      yes_price_dollars:
        toNumber(trade.yes_price_dollars) ??
        toNumber(trade.yes_price) ??
        null,
      no_price_dollars:
        toNumber(trade.no_price_dollars) ??
        toNumber(trade.no_price) ??
        null,
      taker_side: trade.taker_side ?? null,
      created_time: trade.created_time ?? null,
      raw: trade,
    }))
    .filter((trade) => !ticker || trade.ticker === ticker);

  return {
    trades,
    cursor: payload?.cursor ?? null,
    raw: payload,
  };
}

async function getBtcSpotSnapshot({ product_id = "BTC-USD" } = {}) {
  const [ticker, stats] = await Promise.all([
    fetchJson(
      buildUrl(COINBASE_BASE, `products/${encodeURIComponent(product_id)}/ticker`)
    ),
    fetchJson(
      buildUrl(COINBASE_BASE, `products/${encodeURIComponent(product_id)}/stats`)
    ),
  ]);

  return {
    product_id,
    price: toNumber(ticker?.price),
    bid: toNumber(ticker?.bid),
    ask: toNumber(ticker?.ask),
    size: toNumber(ticker?.size),
    trade_time: ticker?.time ?? null,
    trade_id: ticker?.trade_id ?? null,
    volume_24h: toNumber(ticker?.volume) ?? toNumber(stats?.volume),
    open_24h: toNumber(stats?.open),
    high_24h: toNumber(stats?.high),
    low_24h: toNumber(stats?.low),
    last_24h: toNumber(stats?.last),
    volume_30d: toNumber(stats?.volume_30day),
    raw: { ticker, stats },
  };
}

async function getBtcCandles({
  product_id = "BTC-USD",
  granularity = 60,
  limit = 30,
} = {}) {
  const granularityInt = clampInt(granularity, 60, 60, 86400);
  const allowed = new Set([60, 300, 900, 3600, 21600, 86400]);

  if (!allowed.has(granularityInt)) {
    throw new Error("granularity must be one of 60, 300, 900, 3600, 21600, 86400");
  }

  const cappedLimit = clampInt(limit, 30, 1, 300);
  const end = new Date();
  const start = new Date(end.getTime() - granularityInt * cappedLimit * 1000);

  const url = buildUrl(
    COINBASE_BASE,
    `products/${encodeURIComponent(product_id)}/candles`,
    {
      granularity: granularityInt,
      start: start.toISOString(),
      end: end.toISOString(),
    }
  );

  const payload = await fetchJson(url);

  const candles = (Array.isArray(payload) ? payload : [])
    .map((row) => {
      if (!Array.isArray(row) || row.length < 5) return null;
      return {
        time: new Date(Number(row[0]) * 1000).toISOString(),
        low: toNumber(row[1]),
        high: toNumber(row[2]),
        open: toNumber(row[3]),
        close: toNumber(row[4]),
        volume: row.length > 5 ? toNumber(row[5]) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  return {
    product_id,
    granularity: granularityInt,
    candles: candles.slice(-cappedLimit),
    raw_count: Array.isArray(payload) ? payload.length : 0,
  };
}

async function getBtcOrderbookTop({
  product_id = "BTC-USD",
  level = 1,
  top_n = 5,
} = {}) {
  const levelInt = clampInt(level, 1, 1, 3);
  const topN = clampInt(top_n, 5, 1, 20);

  const payload = await fetchJson(
    buildUrl(COINBASE_BASE, `products/${encodeURIComponent(product_id)}/book`, {
      level: levelInt,
    })
  );

  const bids = Array.isArray(payload?.bids) ? payload.bids.slice(0, topN) : [];
  const asks = Array.isArray(payload?.asks) ? payload.asks.slice(0, topN) : [];

  const bestBid = bids[0]
    ? {
        price: toNumber(bids[0][0]),
        size: toNumber(bids[0][1]),
        num_orders: bids[0][2] ?? null,
      }
    : null;

  const bestAsk = asks[0]
    ? {
        price: toNumber(asks[0][0]),
        size: toNumber(asks[0][1]),
        num_orders: asks[0][2] ?? null,
      }
    : null;

  return {
    product_id,
    level: levelInt,
    top_n: topN,
    sequence: payload?.sequence ?? null,
    time: payload?.time ?? null,
    best_bid: bestBid,
    best_ask: bestAsk,
    bids,
    asks,
  };
}

async function getRecentBtcNews({ limit = 10 } = {}) {
  const xml = await fetchText(NEWS_RSS_URL, {
    headers: {
      "User-Agent": DEFAULT_HEADERS["User-Agent"],
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
  });

  const items = parseGoogleNewsRss(xml, clampInt(limit, 10, 1, 25));

  return {
    source: "Google News RSS",
    query_url: NEWS_RSS_URL,
    items,
  };
}

function sendError(res, error) {
  const status =
    typeof error?.status === "number" && error.status >= 400 && error.status < 600
      ? error.status
      : 500;

  res.status(status).json({
    ok: false,
    error: error?.message || "Unknown error",
    details: error?.body || null,
  });
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "kalshi-btc-15m-analyst-proxy",
    endpoints: [
      "/health",
      "/get_active_kalshi_market",
      "/get_kalshi_orderbook",
      "/get_kalshi_recent_trades",
      "/get_btc_spot_snapshot",
      "/get_btc_candles",
      "/get_btc_orderbook_top",
      "/get_recent_btc_news",
    ],
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "kalshi-btc-15m-analyst-proxy",
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

app.get("/get_active_kalshi_market", async (req, res) => {
  try {
    const data = await getActiveKalshiMarket({
      ticker: req.query.ticker,
      series_ticker: req.query.series_ticker || "KXBTC15M",
      limit: req.query.limit,
    });

    res.json({
      ok: true,
      market: data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/get_kalshi_orderbook", async (req, res) => {
  try {
    const data = await getKalshiOrderbook({
      ticker: req.query.ticker,
      depth: req.query.depth || 10,
    });

    res.json({
      ok: true,
      ticker: req.query.ticker || null,
      orderbook: data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/get_kalshi_recent_trades", async (req, res) => {
  try {
    const data = await getKalshiRecentTrades({
      ticker: req.query.ticker,
      limit: req.query.limit,
      cursor: req.query.cursor,
      lookback_seconds: req.query.lookback_seconds || 1800,
    });

    res.json({
      ok: true,
      ...data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/get_btc_spot_snapshot", async (req, res) => {
  try {
    const data = await getBtcSpotSnapshot({
      product_id: req.query.product_id || "BTC-USD",
    });

    res.json({
      ok: true,
      snapshot: data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/get_btc_candles", async (req, res) => {
  try {
    const data = await getBtcCandles({
      product_id: req.query.product_id || "BTC-USD",
      granularity: req.query.granularity || 60,
      limit: req.query.limit || 30,
    });

    res.json({
      ok: true,
      ...data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/get_btc_orderbook_top", async (req, res) => {
  try {
    const data = await getBtcOrderbookTop({
      product_id: req.query.product_id || "BTC-USD",
      level: req.query.level || 1,
      top_n: req.query.top_n || 5,
    });

    res.json({
      ok: true,
      orderbook: data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/get_recent_btc_news", async (req, res) => {
  try {
    const data = await getRecentBtcNews({
      limit: req.query.limit || 10,
    });

    res.json({
      ok: true,
      ...data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kalshi BTC proxy listening on port ${PORT}`);
});
