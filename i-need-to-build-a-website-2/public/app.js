const gamesEl = document.querySelector("#games");
const messageEl = document.querySelector("#message");
const statusEl = document.querySelector("#status");
const refreshEl = document.querySelector("#refresh");
const backEl = document.querySelector("#back");
const detailEl = document.querySelector("#detail");
const tradeLogEl = document.querySelector("#trade-log");
const latencyPageEl = document.querySelector("#latency-page");
const titleEl = document.querySelector("#screen-title");
const leagueLabelEl = document.querySelector("#league-label");
const shellEl = document.querySelector(".shell");
const template = document.querySelector("#game-template");
const leagueTabs = [...document.querySelectorAll(".league-tab")];
const viewTabs = [...document.querySelectorAll(".view-tab")];

const gamesByLeague = {
  nhl: [],
  mlb: [],
};
let trades = [];
let latencyRecords = [];
let latencySummary = null;
let selectedGameId = null;
let activeLeague = "nhl";
let buyNotionalUsd = 1.02;
let activePage = "markets";

function showMessage(text, tone = "neutral") {
  messageEl.hidden = false;
  messageEl.textContent = text;
  messageEl.dataset.tone = tone;
}

function clearMessage() {
  messageEl.hidden = true;
  messageEl.textContent = "";
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function priceLabel(price) {
  if (!price) return "No quote";
  return `${Math.round(Number(price) * 100)}¢`;
}

function shortTitle(game) {
  return game.sides.map((side) => side.shortName || side.name).join(" vs ");
}

function leagueTitle(league) {
  return `${String(league || "").toUpperCase()} Games`;
}

function dollarLabel(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || response.statusText);
    error.body = body;
    throw error;
  }
  return body;
}

async function loadHealth() {
  const health = await requestJson("/api/health");
  buyNotionalUsd = health.buyNotionalUsd || 1.02;
  statusEl.textContent = health.liveTradingEnabled
    ? "Live trading enabled"
    : "Dry-run mode";
  statusEl.dataset.live = String(health.liveTradingEnabled);
}

async function loadGames(league = activeLeague) {
  clearMessage();
  gamesEl.innerHTML = `<div class="empty">Loading ${String(league).toUpperCase()} markets...</div>`;
  const data = await requestJson(`/api/games?league=${encodeURIComponent(league)}`);
  gamesByLeague[league] = data.games || [];
  renderGames();
}

async function loadTrades() {
  const data = await requestJson("/api/trades");
  trades = data.trades || [];
  renderTrades();
}

async function loadLatency() {
  const data = await requestJson("/api/latency");
  latencyRecords = data.records || [];
  latencySummary = data.summary || null;
  renderLatencyPage();
}

function currentGames() {
  return gamesByLeague[activeLeague] || [];
}

function renderGames() {
  if (activePage !== "markets") return;
  gamesEl.innerHTML = "";
  detailEl.hidden = true;
  gamesEl.hidden = false;
  tradeLogEl.hidden = false;
  latencyPageEl.hidden = true;
  backEl.hidden = true;
  titleEl.textContent = leagueTitle(activeLeague);
  leagueLabelEl.textContent = activeLeague.toUpperCase();
  shellEl.dataset.view = "list";
  document.title = `${activeLeague.toUpperCase()} Polymarket Trader`;
  for (const tab of leagueTabs) {
    tab.dataset.active = String(tab.dataset.league === activeLeague);
    tab.setAttribute("aria-pressed", String(tab.dataset.league === activeLeague));
  }

  const games = currentGames();
  if (!games.length) {
    gamesEl.innerHTML = `<div class="empty">No active ${activeLeague.toUpperCase()} moneyline markets are available right now.</div>`;
    return;
  }

  for (const game of games) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("h2").textContent = game.title;
    node.querySelector(".time").textContent = `${formatTime(game.startTime)}${game.live ? " · Live" : ""}`;
    node.querySelector(".market").textContent = game.market.question;
    node.setAttribute("aria-label", `Open ${game.title}`);
    node.addEventListener("click", () => showGame(game.id));

    const teams = node.querySelector(".teams");
    for (const side of game.sides) {
      const team = document.createElement("span");
      team.className = "team-mini";
      team.style.setProperty("--team-color", side.color || "#20262f");
      team.innerHTML = `
        <span class="logo-wrap">${side.logo ? `<img src="${side.logo}" alt="" />` : ""}</span>
        <span class="team-copy">
          <strong>${side.name}</strong>
          <span>${priceLabel(side.displayPrice)} contract</span>
        </span>
      `;
      teams.append(team);
    }

    gamesEl.append(node);
  }
}

function applyViewTabs() {
  for (const tab of viewTabs) {
    const active = tab.dataset.viewTab === activePage;
    tab.dataset.active = String(active);
    tab.setAttribute("aria-pressed", String(active));
  }
}

function showMarketsPage() {
  activePage = "markets";
  applyViewTabs();
  document.title = `${activeLeague.toUpperCase()} Polymarket Trader`;
  renderGames();
  renderTrades();
}

function latencyMetric(label, value) {
  return `
    <article class="latency-metric">
      <span>${label}</span>
      <strong>${value ?? "--"}</strong>
    </article>
  `;
}

function formatMs(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))} ms` : "--";
}

function contractLabel(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}c` : "--";
}

function discrepancyLabel(value) {
  if (!Number.isFinite(Number(value))) return "--";
  const cents = Number(value) * 100;
  const sign = cents > 0 ? "+" : cents < 0 ? "-" : "";
  return `${sign}${Math.abs(cents).toFixed(1)}c`;
}

function renderLatencyPage() {
  if (activePage !== "latency") return;

  activePage = "latency";
  applyViewTabs();
  shellEl.dataset.view = "latency";
  selectedGameId = null;
  gamesEl.hidden = true;
  detailEl.hidden = true;
  tradeLogEl.hidden = true;
  latencyPageEl.hidden = false;
  backEl.hidden = true;
  leagueLabelEl.textContent = "DATA";
  titleEl.textContent = "Latency";
  document.title = "Latency Dashboard";

  const summary = latencySummary || {};
  const metrics = [
    latencyMetric("Samples", summary.totalRecords ?? 0),
    latencyMetric("Success", summary.successes ?? 0),
    latencyMetric("Failure", summary.failures ?? 0),
    latencyMetric("Client Avg", formatMs(summary.clientTotalAvgMs)),
    latencyMetric("Client P95", formatMs(summary.clientTotalP95Ms)),
    latencyMetric("Market Avg", formatMs(summary.polymarketAvgMs)),
    latencyMetric("Avg Price Gap", discrepancyLabel(summary.contractDeltaAvg)),
  ].join("");

  const rows = latencyRecords.length
    ? latencyRecords
        .map((record) => {
          return `
            <article class="latency-entry">
              <div class="latency-copy">
                <strong>${String(record.teamName || "Unknown team")}</strong>
                <span>${String(record.league || "").toUpperCase()} · ${new Date(record.createdAt).toLocaleString()}</span>
                <span>${record.success ? "Success" : "Failure"}${record.errorMessage ? ` · ${record.errorMessage}` : ""}</span>
              </div>
              <div class="latency-values">
                <span>Total ${formatMs(record.clientTotalMs)}</span>
                <span>Server ${formatMs(record.serverTotalMs)}</span>
                <span>Market ${formatMs(record.polymarketRoundtripMs)}</span>
                <span>Press ${contractLabel(record.contractPriceAtPress)}</span>
                <span>Fill ${contractLabel(record.contractPriceAtFill)}</span>
                <span>Gap ${discrepancyLabel(record.contractPriceDelta)}</span>
              </div>
            </article>
          `;
        })
        .join("")
    : '<div class="empty">No latency samples have been recorded yet.</div>';

  latencyPageEl.innerHTML = `
    <section class="latency-summary">
      ${metrics}
    </section>
    <section class="latency-list">
      ${rows}
    </section>
  `;
}

function showGame(gameId) {
  const game = currentGames().find((item) => item.id === gameId);
  if (!game) return;

  selectedGameId = gameId;
  gamesEl.hidden = true;
  detailEl.hidden = false;
  tradeLogEl.hidden = true;
  latencyPageEl.hidden = true;
  backEl.hidden = false;
  titleEl.textContent = shortTitle(game);
  leagueLabelEl.textContent = activeLeague.toUpperCase();
  shellEl.dataset.view = "detail";
  detailEl.innerHTML = "";
  window.scrollTo(0, 0);

  const trackerLabel = document.createElement("p");
  trackerLabel.className = "detail-kicker";
  trackerLabel.textContent = "Stat Tracker";
  detailEl.append(trackerLabel);

  const header = document.createElement("div");
  header.className = "game-strip";
  header.innerHTML = `
    <p>${formatTime(game.startTime)}${game.live ? " · Live" : ""}</p>
    <strong>${game.market.question}</strong>
  `;
  detailEl.append(header);

  for (const side of game.sides) {
    const card = document.createElement("button");
    card.className = "team-card";
    card.type = "button";
    card.setAttribute("aria-label", `Buy ${side.name} for $${buyNotionalUsd.toFixed(2)}`);
    card.setAttribute("title", `Buy ${side.name} for $${buyNotionalUsd.toFixed(2)}`);
    card.style.setProperty("--team-color", side.color || "#394150");
    card.innerHTML = `
      <div class="team-art">${side.logo ? `<img src="${side.logo}" alt="" />` : `<span>${side.shortName}</span>`}</div>
      <div class="team-card-footer">
        <div>
          <strong>${side.shortName || side.name}</strong>
          <span>${side.name}</span>
        </div>
      </div>
    `;
    card.addEventListener("click", () => submitTrade(side, card));
    detailEl.append(card);
  }
}

async function submitTrade(side, button) {
  button.disabled = true;
  button.dataset.busy = "true";
  const latencyId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clientClickStartedAt = new Date().toISOString();

  try {
    const clientRequestStartedAt = new Date().toISOString();
    const result = await requestJson("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latencyId,
        clientClickStartedAt,
        clientRequestStartedAt,
        marketSlug: side.marketSlug,
        intent: side.buyIntent,
        action: "buy",
        sideLong: side.long,
        league: activeLeague,
        teamName: side.name,
        marketTitle: selectedGameId ? shortTitle(currentGames().find((item) => item.id === selectedGameId) || { sides: [side] }) : side.name,
        orderPrice: side.orderPrice,
      }),
    });

    if (result.latency?.id) {
      await requestJson("/api/latency/client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latencyId: result.latency.id,
          clientResponseReceivedAt: new Date().toISOString(),
        }),
      });
      if (activePage === "latency") await loadLatency();
    }

    if (result.dryRun) {
      showMessage(`Dry run: ${side.name} buy order prepared for $${buyNotionalUsd.toFixed(2)}.`, "neutral");
    } else {
      const details = result.trade?.nominalUsd ? dollarLabel(result.trade.nominalUsd) : `$${buyNotionalUsd.toFixed(2)}`;
      showMessage(`Buy order submitted for ${side.name}: ${details}.`, "success");
      await loadTrades();
    }
  } catch (error) {
    if (error.body?.latency?.id) {
      await requestJson("/api/latency/client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latencyId: error.body.latency.id,
          clientResponseReceivedAt: new Date().toISOString(),
        }),
      }).catch(() => {});
      if (activePage === "latency") await loadLatency().catch(() => {});
    }
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.dataset.busy = "false";
  }
}

function renderTrades() {
  if (!trades.length) {
    tradeLogEl.innerHTML = `
      <div class="trade-log-header">
        <div>
          <p class="eyebrow">Trades</p>
          <h2>Recent Activity</h2>
        </div>
      </div>
      <div class="empty">No trades have been logged yet.</div>
    `;
    return;
  }

  const items = trades
    .map((trade) => {
      return `
        <article class="trade-entry">
          <div class="trade-copy">
            <strong>${String(trade.teamName || "Unknown team")}</strong>
            <span>${String(trade.league || "").toUpperCase()} · ${String(trade.action || "").toUpperCase()} · ${new Date(trade.createdAt).toLocaleString()}</span>
          </div>
          <div class="trade-value">${dollarLabel(trade.nominalUsd)}</div>
        </article>
      `;
    })
    .join("");

  tradeLogEl.innerHTML = `
    <div class="trade-log-header">
      <div>
        <p class="eyebrow">Trades</p>
        <h2>Recent Activity</h2>
      </div>
    </div>
    <div class="trade-list">${items}</div>
  `;
}

refreshEl.addEventListener("click", async () => {
  if (activePage === "latency") {
    await loadLatency();
    return;
  }
  await Promise.all([loadGames(activeLeague), loadTrades()]);
});
backEl.addEventListener("click", () => {
  selectedGameId = null;
  showMarketsPage();
});
for (const tab of leagueTabs) {
  tab.addEventListener("click", async () => {
    if (tab.dataset.league === activeLeague) return;
    activeLeague = tab.dataset.league;
    selectedGameId = null;
    activePage = "markets";
    if (!gamesByLeague[activeLeague].length) {
      await loadGames(activeLeague);
    } else {
      showMarketsPage();
    }
  });
}
for (const tab of viewTabs) {
  tab.addEventListener("click", async () => {
    if (tab.dataset.viewTab === activePage) return;
    if (tab.dataset.viewTab === "latency") {
      activePage = "latency";
      await loadLatency();
      return;
    }
    showMarketsPage();
  });
}

try {
  await loadHealth();
  await Promise.all([loadGames(activeLeague), loadTrades(), loadLatency()]);
  if (selectedGameId) showGame(selectedGameId);
  else showMarketsPage();
} catch (error) {
  gamesEl.innerHTML = "";
  showMessage(error.message, "error");
}
