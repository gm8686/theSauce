# NHL Polymarket US Trader

Local website for browsing available NHL Polymarket US moneyline contracts and trading either team from a server-side route.

Features:

- Daily NHL games
- Daily MLB games
- Password-gated local session
- Buy and sell trade flow
- Trade log with nominal value per recorded fill

## Run

Fill in `.env`, then run `node server.js`.

Open `http://localhost:5173`.

## Deploy To Render

This repo includes a Render blueprint in [render.yaml](/Users/gm/Documents/Codex/2026-04-25/i-need-to-build-a-website-2/render.yaml).

Use a `Web Service`, not a static site. Render can create it from the blueprint or from the dashboard with:

```bash
Build Command: npm install
Start Command: npm start
```

Set these environment variables in Render:

- `POLYMARKET_KEY_ID`
- `POLYMARKET_SECRET_KEY`
- `APP_PASSWORD`
- `DATABASE_URL`
- `ENABLE_LIVE_TRADING`
- `BUY_NOTIONAL_USD`
- `SLIPPAGE_BIPS`

Notes:

- `PORT` does not need to be set manually on Render. The app already reads Render's injected `PORT`.
- Keep `ENABLE_LIVE_TRADING=false` until you have confirmed login, market loading, and order behavior on the deployed site.
- If `DATABASE_URL` is set, the app stores trades in Postgres and auto-creates the `trade_log` table on boot.
- If `DATABASE_URL` is not set, the app falls back to `trades.jsonl` on the service filesystem.

## Live Trading

The app starts in protected mode. Orders are previewed locally unless:

```bash
ENABLE_LIVE_TRADING=true
```

When live trading is enabled, clicking `Buy` submits a market buy for the configured dollar amount. Clicking `Sell` closes all available shares for the current market after checking that the selected team matches your current position direction. The server signs requests with:

- `X-PM-Access-Key`
- `X-PM-Timestamp`
- `X-PM-Signature`

API keys stay in `.env` and are never sent to the browser.

Optional local password gate:

```bash
APP_PASSWORD=choose_a_local_site_password
```

Trading knobs:

```bash
BUY_NOTIONAL_USD=1.02
SLIPPAGE_BIPS=500
```

## Configuration Changes

The server reads `.env` when it starts. After changing `.env`, restart it:

```bash
# In the terminal running the server:
Ctrl+C
node server.js
```
