const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ================= CONFIG =================
const WORKING_CAPITAL = 100;
const TRADE_FEE = 0.00175;
const SPREAD = 0.0002;
const TARGET = 0.004;           // 0.4%
const HOLD_MS = 2 * 3600000;   // 2 hours
const TRAILING_STOP = 0.006;   // 0.6% below peak
const GRACE_MS = 30 * 60000;   // 30min no stop
const WAVE_DROP = 0.002;       // 0.2% drop from peak to cashout

const COINS = ['btcusdt','ethusdt','solusdt','bnbusdt','xrpusdt','dogeusdt','adausdt','avaxusdt'];
const COIN_LABELS = { btcusdt:'BTC', ethusdt:'ETH', solusdt:'SOL', bnbusdt:'BNB', xrpusdt:'XRP', dogeusdt:'DOGE', adausdt:'ADA', avaxusdt:'AVAX' };

const DATA_FILE = path.join(__dirname, 'data', 'trades.json');

// State per coin per strategy
// strategies: 'safe' | 'wave'
let prices = {};
let botState = {};

COINS.forEach(coin => {
  prices[coin] = 0;
  ['safe','wave'].forEach(strat => {
    botState[`${coin}_${strat}`] = {
      coin, strat,
      tradeActive: false,
      entryPrice: 0,
      targetPrice: 0,
      peakPrice: 0,
      tradeStartTime: 0,
      monitorInterval: null,
      nextTradeTimeout: null,
      trades: [],
      totalProfit: 0,
      totalTrades: 0,
      totalWins: 0,
    };
  });
});

// Load saved data
if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE));
    if (saved.botState) {
      Object.keys(saved.botState).forEach(key => {
        if (botState[key]) {
          const s = saved.botState[key];
          botState[key].trades = s.trades || [];
          botState[key].totalProfit = s.totalProfit || 0;
          botState[key].totalTrades = s.totalTrades || 0;
          botState[key].totalWins = s.totalWins || 0;
        }
      });
      console.log('Loaded previous data');
    }
  } catch(e) { console.log('No previous data'); }
}

function saveData() {
  const toSave = {};
  Object.keys(botState).forEach(key => {
    const s = botState[key];
    toSave[key] = { trades: s.trades, totalProfit: s.totalProfit, totalTrades: s.totalTrades, totalWins: s.totalWins };
  });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ botState: toSave }, null, 2));
}

function addLog(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function netProfit(move) {
  const gross = WORKING_CAPITAL * move;
  return gross - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
}

function closeTrade(key, exitReason, exitPrice, profit, isWin, durationMs) {
  const s = botState[key];
  if (!s.tradeActive) return;
  s.tradeActive = false;
  if (s.monitorInterval) clearInterval(s.monitorInterval);
  if (s.nextTradeTimeout) clearTimeout(s.nextTradeTimeout);

  const record = {
    id: s.trades.length + 1,
    timestamp: new Date().toISOString(),
    entryPrice: s.entryPrice,
    targetPrice: s.targetPrice,
    exitPrice,
    profitUsd: profit,
    win: isWin,
    durationSeconds: Math.floor(durationMs / 1000),
    exitReason
  };
  s.trades.push(record);
  s.totalProfit += profit;
  s.totalTrades++;
  if (isWin) s.totalWins++;
  saveData();

  addLog(`[${COIN_LABELS[s.coin]}/${s.strat}] ${isWin ? '✅' : '❌'} $${profit.toFixed(3)} | ${exitReason} | total: $${s.totalProfit.toFixed(2)}`);

  s.nextTradeTimeout = setTimeout(() => {
    if (!s.tradeActive) startTrade(key);
  }, 300000 + Math.random() * 600000);
}

function startTrade(key) {
  const s = botState[key];
  if (s.tradeActive) return;
  const price = prices[s.coin];
  if (!price || price < 0.0001) {
    setTimeout(() => startTrade(key), 5000);
    return;
  }

  s.entryPrice = price;
  s.targetPrice = price * (1 + TARGET);
  s.peakPrice = price;
  s.tradeActive = true;
  s.tradeStartTime = Date.now();

  addLog(`[${COIN_LABELS[s.coin]}/${s.strat}] 🟢 BUY @ ${price.toFixed(4)} | TARGET: ${s.targetPrice.toFixed(4)}`);

  s.monitorInterval = setInterval(() => {
    if (!s.tradeActive) return;
    const cur = prices[s.coin];
    if (!cur) return;
    const elapsed = Date.now() - s.tradeStartTime;
    const move = (cur - s.entryPrice) / s.entryPrice;

    // Track peak
    if (cur > s.peakPrice) s.peakPrice = cur;

    if (s.strat === 'safe') {
      // --- SAFE STRATEGY ---
      // Hit target
      if (cur >= s.targetPrice) {
        clearInterval(s.monitorInterval);
        closeTrade(key, 'target_hit', cur, netProfit(TARGET), true, elapsed);
        return;
      }
      // Trailing stop after grace period
      if (elapsed > GRACE_MS) {
        const dropFromPeak = (s.peakPrice - cur) / s.peakPrice;
        if (dropFromPeak >= TRAILING_STOP) {
          clearInterval(s.monitorInterval);
          const profit = netProfit(Math.max(move, -TRAILING_STOP));
          closeTrade(key, 'trailing_stop', cur, profit, profit > 0, elapsed);
          return;
        }
      }
      // Timeout
      if (elapsed >= HOLD_MS) {
        clearInterval(s.monitorInterval);
        const profit = move >= 0
          ? netProfit(Math.min(move, TARGET))
          : -(WORKING_CAPITAL * Math.abs(move)) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
        closeTrade(key, 'timeout_2h', cur, profit, profit > 0, elapsed);
      }

    } else {
      // --- WAVE STRATEGY ---
      const aboveTarget = cur >= s.targetPrice;
      const peakMove = (s.peakPrice - s.entryPrice) / s.entryPrice;
      const dropFromPeak = (s.peakPrice - cur) / s.peakPrice;

      if (aboveTarget) {
        // Price dropped 0.2% from peak AND still above target → cashout
        if (dropFromPeak >= WAVE_DROP) {
          clearInterval(s.monitorInterval);
          const profit = netProfit(peakMove - WAVE_DROP);
          closeTrade(key, 'wave_cashout', cur, profit, profit > 0, elapsed);
          return;
        }
      }
      // Trailing stop after grace period (only if below target)
      if (elapsed > GRACE_MS && !aboveTarget) {
        if (dropFromPeak >= TRAILING_STOP) {
          clearInterval(s.monitorInterval);
          const profit = netProfit(Math.max(move, -TRAILING_STOP));
          closeTrade(key, 'trailing_stop', cur, profit, profit > 0, elapsed);
          return;
        }
      }
      // Timeout
      if (elapsed >= HOLD_MS) {
        clearInterval(s.monitorInterval);
        let profit;
        if (aboveTarget && peakMove > WAVE_DROP) {
          profit = netProfit(peakMove - WAVE_DROP);
        } else {
          profit = move >= 0
            ? netProfit(Math.min(move, TARGET))
            : -(WORKING_CAPITAL * Math.abs(move)) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
        }
        closeTrade(key, 'timeout_2h', cur, profit, profit > 0, elapsed);
      }
    }
  }, 2000);
}

// ================= WEBSOCKET =================
function connectWS() {
  const streams = COINS.map(c => `${c}@trade`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  ws.on('open', () => addLog('🟢 Binance WebSocket connected'));
  ws.on('message', (data) => {
    try {
      const json = JSON.parse(data);
      const stream = json.stream; // e.g. "btcusdt@trade"
      const coin = stream.split('@')[0];
      const price = parseFloat(json.data.p);
      if (price > 0) prices[coin] = price;
    } catch(e) {}
  });
  ws.on('close', () => {
    addLog('⚠️ WS closed, reconnecting in 3s...');
    setTimeout(connectWS, 3000);
  });
  ws.on('error', () => ws.close());
}
connectWS();

// ================= EXPRESS =================
const app = express();

app.get(['/api/stats', '/crypto/api/stats'], (req, res) => {
  const result = {};
  COINS.forEach(coin => {
    ['safe','wave'].forEach(strat => {
      const key = `${coin}_${strat}`;
      const s = botState[key];
      const cumulative = [];
      let sum = 0;
      for (const t of s.trades) { sum += t.profitUsd; cumulative.push(parseFloat(sum.toFixed(4))); }
      result[key] = {
        coin: COIN_LABELS[coin],
        strat,
        totalProfit: parseFloat(s.totalProfit.toFixed(4)),
        totalTrades: s.totalTrades,
        totalWins: s.totalWins,
        winRate: s.totalTrades ? (s.totalWins / s.totalTrades) * 100 : 0,
        currentPrice: prices[coin] || 0,
        tradeActive: s.tradeActive,
        trades: s.trades.slice(-20).reverse(),
        cumulative
      };
    });
  });
  res.json({ coins: COIN_LABELS, data: result, prices });
});

app.get(['/','  /crypto'], (req, res) => {
  res.send(getDashboardHTML());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Crypto Strategy Arena</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg: #060608;
  --surface: #0d0d12;
  --border: #1a1a24;
  --text: #e8e8f0;
  --muted: #555566;
  --safe: #00e5ff;
  --wave: #ff6b35;
  --win: #00ff9d;
  --loss: #ff3d6b;
  --gold: #ffd700;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--bg); font-family:'Space Mono',monospace; color:var(--text); min-height:100vh; }

/* HEADER */
.header {
  padding: 1.5rem 2rem;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;
}
.logo { font-family:'Syne',sans-serif; font-size:1.4rem; font-weight:800; letter-spacing:-0.02em; }
.logo span { color: var(--safe); }
.logo em { color: var(--wave); font-style:normal; }
.live-dot { width:8px; height:8px; background:var(--win); border-radius:50%; display:inline-block; margin-right:6px; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(1.3)} }
.badge { font-size:0.65rem; color:var(--win); border:1px solid var(--win); padding:0.2rem 0.7rem; border-radius:2px; }

/* TABS */
.tabs-bar {
  display: flex; gap: 0; overflow-x: auto; border-bottom: 1px solid var(--border);
  scrollbar-width: none;
}
.tabs-bar::-webkit-scrollbar { display:none; }
.tab {
  padding: 0.7rem 1.2rem; font-size:0.7rem; font-family:'Space Mono',monospace;
  cursor:pointer; border:none; background:transparent; color:var(--muted);
  border-bottom: 2px solid transparent; transition: all 0.2s; white-space:nowrap;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--safe); }
.tab.leaderboard-tab.active { border-bottom-color: var(--gold); }

/* LEADERBOARD */
.leaderboard { padding: 1.5rem 2rem; display:none; }
.leaderboard.active { display:block; }
.lb-title { font-family:'Syne',sans-serif; font-size:1.1rem; font-weight:800; margin-bottom:1.2rem; color:var(--gold); }
.lb-grid { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
@media(max-width:700px) { .lb-grid { grid-template-columns:1fr; } }
.lb-table { background:var(--surface); border:1px solid var(--border); border-radius:4px; overflow:hidden; }
.lb-table-title { padding:0.6rem 1rem; font-size:0.65rem; color:var(--muted); border-bottom:1px solid var(--border); display:flex; align-items:center; gap:0.5rem; }
.strat-dot { width:6px; height:6px; border-radius:50%; display:inline-block; }
.lb-row { display:grid; grid-template-columns:1.5rem 3rem 1fr 1fr 1fr; align-items:center; padding:0.5rem 1rem; border-bottom:1px solid var(--border); font-size:0.65rem; gap:0.5rem; }
.lb-row:last-child { border-bottom:none; }
.lb-rank { color:var(--muted); font-size:0.6rem; }
.lb-rank.gold { color:var(--gold); }
.lb-rank.silver { color:#aaa; }
.lb-rank.bronze { color:#cd7f32; }
.lb-coin { font-weight:700; font-size:0.7rem; }
.lb-profit.pos { color:var(--win); }
.lb-profit.neg { color:var(--loss); }

/* COIN PANEL */
.coin-panel { display:none; padding:1.5rem 2rem; }
.coin-panel.active { display:block; }
.coin-header { display:flex; align-items:baseline; gap:1rem; margin-bottom:1.2rem; flex-wrap:wrap; }
.coin-name { font-family:'Syne',sans-serif; font-size:1.8rem; font-weight:800; }
.coin-price { font-size:1rem; color:var(--muted); }

.strats-grid { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; }
@media(max-width:700px) { .strats-grid { grid-template-columns:1fr; } }

.strat-card { background:var(--surface); border:1px solid var(--border); border-radius:6px; overflow:hidden; }
.strat-header { padding:0.8rem 1rem; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
.strat-label { font-size:0.7rem; font-weight:700; display:flex; align-items:center; gap:0.5rem; }
.strat-label.safe { color:var(--safe); }
.strat-label.wave { color:var(--wave); }
.strat-status { font-size:0.6rem; padding:0.15rem 0.5rem; border-radius:2px; }
.strat-status.active-trade { background:#00ff9d22; color:var(--win); border:1px solid var(--win); }
.strat-status.waiting { background:#ffffff11; color:var(--muted); }

.stats-row { display:grid; grid-template-columns:repeat(3,1fr); gap:0; border-bottom:1px solid var(--border); }
.stat-box { padding:0.7rem; border-right:1px solid var(--border); text-align:center; }
.stat-box:last-child { border-right:none; }
.stat-val { font-size:1rem; font-weight:700; }
.stat-val.pos { color:var(--win); }
.stat-val.neg { color:var(--loss); }
.stat-lbl { font-size:0.55rem; color:var(--muted); margin-top:0.2rem; }

.chart-wrap { height:120px; padding:0.5rem; }
.trades-wrap { max-height:180px; overflow-y:auto; }
.trades-wrap::-webkit-scrollbar { width:3px; }
.trades-wrap::-webkit-scrollbar-thumb { background:var(--border); }
table { width:100%; border-collapse:collapse; font-size:0.6rem; }
th { padding:0.4rem 0.6rem; color:var(--muted); text-align:left; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--surface); }
td { padding:0.35rem 0.6rem; border-bottom:1px solid #0f0f18; }
.w { color:var(--win); }
.l { color:var(--loss); }

.footer { text-align:center; font-size:0.55rem; color:var(--muted); padding:1rem; border-top:1px solid var(--border); margin-top:1rem; }
</style>
</head>
<body>

<div class="header">
  <div class="logo">Crypto <span>SAFE</span> vs <em>WAVE</em> Arena</div>
  <div style="display:flex;align-items:center;gap:1rem;">
    <div id="globalPrice" style="font-size:0.7rem;color:var(--muted)">Loading...</div>
    <div class="badge"><span class="live-dot"></span>LIVE · 8 COINS · 2 STRATEGIES</div>
  </div>
</div>

<div class="tabs-bar" id="tabsBar">
  <button class="tab leaderboard-tab active" onclick="showTab('leaderboard')">🏆 LEADERBOARD</button>
</div>

<div id="leaderboardPanel" class="leaderboard active">
  <div class="lb-title">🏆 Strategy Leaderboard</div>
  <div class="lb-grid">
    <div class="lb-table">
      <div class="lb-table-title"><span class="strat-dot" style="background:var(--safe)"></span> SAFE Strategy Rankings</div>
      <div id="lb-safe"></div>
    </div>
    <div class="lb-table">
      <div class="lb-table-title"><span class="strat-dot" style="background:var(--wave)"></span> WAVE Strategy Rankings</div>
      <div id="lb-wave"></div>
    </div>
  </div>
</div>

<div id="coinPanels"></div>

<div class="footer">Auto-refresh 10s · 0.4% target · 2h max hold · 30min grace · Trailing stop 0.6% · Wave drop 0.2% · $100/coin/strategy</div>

<script>
const COINS = ['btcusdt','ethusdt','solusdt','bnbusdt','xrpusdt','dogeusdt','adausdt','avaxusdt'];
const LABELS = {btcusdt:'BTC',ethusdt:'ETH',solusdt:'SOL',bnbusdt:'BNB',xrpusdt:'XRP',dogeusdt:'DOGE',adausdt:'ADA',avaxusdt:'AVAX'};
const charts = {};
let currentTab = 'leaderboard';

// Build tabs and panels
const tabsBar = document.getElementById('tabsBar');
const coinPanels = document.getElementById('coinPanels');

COINS.forEach(coin => {
  const label = LABELS[coin];
  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.id = \`tab-\${coin}\`;
  btn.textContent = label;
  btn.onclick = () => showTab(coin);
  tabsBar.appendChild(btn);

  const panel = document.createElement('div');
  panel.className = 'coin-panel';
  panel.id = \`panel-\${coin}\`;
  panel.innerHTML = \`
    <div class="coin-header">
      <div class="coin-name">\${label}</div>
      <div class="coin-price" id="price-\${coin}">$---</div>
    </div>
    <div class="strats-grid">
      \${buildStratCard(coin, 'safe')}
      \${buildStratCard(coin, 'wave')}
    </div>
  \`;
  coinPanels.appendChild(panel);
});

function buildStratCard(coin, strat) {
  const key = \`\${coin}_\${strat}\`;
  const color = strat === 'safe' ? 'var(--safe)' : 'var(--wave)';
  const icon = strat === 'safe' ? '🛡' : '🌊';
  return \`
  <div class="strat-card">
    <div class="strat-header">
      <div class="strat-label \${strat}">\${icon} \${strat.toUpperCase()} Strategy</div>
      <div class="strat-status waiting" id="status-\${key}">Waiting</div>
    </div>
    <div class="stats-row">
      <div class="stat-box"><div class="stat-val" id="profit-\${key}">$0.00</div><div class="stat-lbl">PROFIT</div></div>
      <div class="stat-box"><div class="stat-val" id="winrate-\${key}">0%</div><div class="stat-lbl">WIN RATE</div></div>
      <div class="stat-box"><div class="stat-val" id="trades-\${key}">0</div><div class="stat-lbl">TRADES</div></div>
    </div>
    <div class="chart-wrap"><canvas id="chart-\${key}"></canvas></div>
    <div class="trades-wrap">
      <table>
        <thead><tr><th>Time</th><th>Entry</th><th>Exit</th><th>Profit</th><th>Reason</th></tr></thead>
        <tbody id="tbody-\${key}"></tbody>
      </table>
    </div>
  </div>\`;
}

function showTab(id) {
  currentTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.coin-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('leaderboardPanel').classList.remove('active');

  if (id === 'leaderboard') {
    document.querySelector('.leaderboard-tab').classList.add('active');
    document.getElementById('leaderboardPanel').classList.add('active');
  } else {
    document.getElementById(\`tab-\${id}\`).classList.add('active');
    document.getElementById(\`panel-\${id}\`).classList.add('active');
  }
}

function fmtPrice(p) {
  if (!p) return '$---';
  if (p < 0.01) return '$' + p.toFixed(6);
  if (p < 1) return '$' + p.toFixed(4);
  if (p < 100) return '$' + p.toFixed(3);
  return '$' + p.toFixed(2);
}

async function fetchData() {
  try {
    const res = await fetch('/crypto/api/stats');
    const json = await res.json();
    const data = json.data;

    // Update prices
    let priceStr = '';
    COINS.forEach(coin => {
      const p = json.prices[coin];
      const el = document.getElementById(\`price-\${coin}\`);
      if (el) el.textContent = fmtPrice(p);
      priceStr += \`\${LABELS[coin]}: \${fmtPrice(p)}  \`;
    });
    document.getElementById('globalPrice').textContent = priceStr.trim();

    // Update coin panels
    COINS.forEach(coin => {
      ['safe','wave'].forEach(strat => {
        const key = \`\${coin}_\${strat}\`;
        const d = data[key];
        if (!d) return;

        // Stats
        const profitEl = document.getElementById(\`profit-\${key}\`);
        if (profitEl) {
          profitEl.textContent = (d.totalProfit >= 0 ? '+' : '') + '$' + d.totalProfit.toFixed(2);
          profitEl.className = 'stat-val ' + (d.totalProfit >= 0 ? 'pos' : 'neg');
        }
        const wrEl = document.getElementById(\`winrate-\${key}\`);
        if (wrEl) wrEl.textContent = d.winRate.toFixed(1) + '%';
        const trEl = document.getElementById(\`trades-\${key}\`);
        if (trEl) trEl.textContent = d.totalTrades;

        const stEl = document.getElementById(\`status-\${key}\`);
        if (stEl) {
          stEl.textContent = d.tradeActive ? 'IN TRADE' : 'Waiting';
          stEl.className = 'strat-status ' + (d.tradeActive ? 'active-trade' : 'waiting');
        }

        // Chart
        const canvas = document.getElementById(\`chart-\${key}\`);
        if (canvas) {
          if (charts[key]) charts[key].destroy();
          const color = strat === 'safe' ? '#00e5ff' : '#ff6b35';
          charts[key] = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
              labels: d.cumulative.map((_,i) => i+1),
              datasets: [{
                data: d.cumulative,
                borderColor: color,
                backgroundColor: color + '22',
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 1.5
              }]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { display: false },
                y: { display: true, ticks: { color: '#555566', font: { size: 9 }, callback: v => '$'+v.toFixed(2) }, grid: { color: '#1a1a24' } }
              }
            }
          });
        }

        // Table
        const tbody = document.getElementById(\`tbody-\${key}\`);
        if (tbody) {
          tbody.innerHTML = '';
          for (const t of d.trades) {
            const tr = tbody.insertRow();
            tr.insertCell(0).textContent = new Date(t.timestamp).toLocaleTimeString();
            tr.insertCell(1).textContent = fmtPrice(t.entryPrice);
            tr.insertCell(2).textContent = fmtPrice(t.exitPrice);
            const p = tr.insertCell(3);
            p.innerHTML = \`<span class="\${t.win?'w':'l'}">\${t.win?'+':''}\$\${t.profitUsd.toFixed(3)}</span>\`;
            tr.insertCell(4).textContent = t.exitReason;
          }
        }
      });
    });

    // Leaderboard
    ['safe','wave'].forEach(strat => {
      const entries = COINS.map(coin => {
        const key = \`\${coin}_\${strat}\`;
        const d = data[key];
        return { coin: LABELS[coin], profit: d.totalProfit, winRate: d.winRate, trades: d.totalTrades };
      }).sort((a,b) => b.profit - a.profit);

      const lb = document.getElementById(\`lb-\${strat}\`);
      if (!lb) return;
      lb.innerHTML = entries.map((e, i) => {
        const rankClass = i===0?'gold':i===1?'silver':i===2?'bronze':'';
        const rankIcon = i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1);
        return \`<div class="lb-row">
          <div class="lb-rank \${rankClass}">\${rankIcon}</div>
          <div class="lb-coin">\${e.coin}</div>
          <div class="lb-profit \${e.profit>=0?'pos':'neg'}">\${e.profit>=0?'+':''}\$\${e.profit.toFixed(2)}</div>
          <div style="font-size:0.6rem;color:var(--muted)">\${e.winRate.toFixed(0)}% WR</div>
          <div style="font-size:0.6rem;color:var(--muted)">\${e.trades}T</div>
        </div>\`;
      }).join('');
    });

  } catch(e) { console.error(e); }
}

fetchData();
setInterval(fetchData, 10000);
</script>
</body>
</html>`;
}

app.listen(3000, () => addLog('🚀 Dashboard on port 3000'));

// Start all bots after 5s
setTimeout(() => {
  COINS.forEach(coin => {
    ['safe','wave'].forEach(strat => {
      const key = `${coin}_${strat}`;
      setTimeout(() => startTrade(key), Math.random() * 10000);
    });
  });
}, 5000);