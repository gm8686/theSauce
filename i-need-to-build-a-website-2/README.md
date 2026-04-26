# NHL Polymarket US Trader

Local website for browsing available NHL Polymarket US moneyline contracts and trading either team from a server-side route.

## Run

Fill in `.env`, then run `node server.js`.

Open `http://localhost:5173`.

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
