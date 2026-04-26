const gamesEl = document.querySelector("#games");
const messageEl = document.querySelector("#message");
const statusEl = document.querySelector("#status");
const refreshEl = document.querySelector("#refresh");
const backEl = document.querySelector("#back");
const detailEl = document.querySelector("#detail");
const titleEl = document.querySelector("#screen-title");
const shellEl = document.querySelector(".shell");
const template = document.querySelector("#game-template");

let games = [];
let selectedGameId = null;
let buyNotionalUsd = 1.02;

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

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || response.statusText);
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

async function loadGames() {
  clearMessage();
  gamesEl.innerHTML = '<div class="empty">Loading NHL markets...</div>';
  const data = await requestJson("/api/nhl-games");
  games = data.games || [];
  renderGames();
}

function renderGames() {
  gamesEl.innerHTML = "";
  detailEl.hidden = true;
  gamesEl.hidden = false;
  backEl.hidden = true;
  titleEl.textContent = "Games";
  shellEl.dataset.view = "list";

  if (!games.length) {
    gamesEl.innerHTML = '<div class="empty">No active NHL moneyline markets are available right now.</div>';
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

function showGame(gameId) {
  const game = games.find((item) => item.id === gameId);
  if (!game) return;

  selectedGameId = gameId;
  gamesEl.hidden = true;
  detailEl.hidden = false;
  backEl.hidden = false;
  titleEl.textContent = shortTitle(game);
  shellEl.dataset.view = "detail";
  detailEl.innerHTML = "";
  window.scrollTo(0, 0);

  const header = document.createElement("div");
  header.className = "game-strip";
  header.innerHTML = `
    <p>${formatTime(game.startTime)}${game.live ? " · Live" : ""}</p>
    <strong>${game.market.question}</strong>
  `;
  detailEl.append(header);

  for (const side of game.sides) {
    const card = document.createElement("article");
    card.className = "team-card";
    card.style.setProperty("--team-color", side.color || "#394150");
    card.innerHTML = `
      <div class="team-art">${side.logo ? `<img src="${side.logo}" alt="" />` : `<span>${side.shortName}</span>`}</div>
      <div class="team-card-footer">
        <div>
          <strong>${side.shortName || side.name}</strong>
          <span>${side.name}</span>
        </div>
        <div class="price-pill">${priceLabel(side.displayPrice)}</div>
      </div>
      <div class="trade-actions">
        <button type="button" class="trade-button buy-button">Buy</button>
        <button type="button" class="trade-button sell-button">Sell</button>
      </div>
    `;
    const buyButton = card.querySelector(".buy-button");
    const sellButton = card.querySelector(".sell-button");
    buyButton.addEventListener("click", () => submitTrade(side, "buy", buyButton));
    sellButton.addEventListener("click", () => submitTrade(side, "sell", sellButton));
    detailEl.append(card);
  }
}

async function submitTrade(side, action, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = action === "buy" ? "Buying" : "Selling";

  try {
    const result = await requestJson("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketSlug: side.marketSlug,
        intent: action === "buy" ? side.buyIntent : side.sellIntent,
        action,
        sideLong: side.long,
        orderPrice: side.orderPrice,
      }),
    });

    const label = action === "buy" ? "buy" : "sell";
    if (result.dryRun) {
      const details = action === "buy" ? `$${buyNotionalUsd.toFixed(2)}` : "all available shares";
      showMessage(`Dry run: ${side.name} ${label} order prepared for ${details}.`, "neutral");
    } else {
      const details = action === "buy" ? `$${buyNotionalUsd.toFixed(2)}` : "all available shares";
      showMessage(`${label[0].toUpperCase() + label.slice(1)} order submitted for ${side.name}: ${details}.`, "success");
    }
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

refreshEl.addEventListener("click", loadGames);
backEl.addEventListener("click", () => {
  selectedGameId = null;
  renderGames();
});

try {
  await loadHealth();
  await loadGames();
  if (selectedGameId) showGame(selectedGameId);
} catch (error) {
  gamesEl.innerHTML = "";
  showMessage(error.message, "error");
}
