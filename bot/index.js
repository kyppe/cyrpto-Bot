const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ================= CONFIG =================
const WORKING_CAPITAL = 100;
const TRADE_FEE = 0.00175;
const SPREAD = 0.0002;
const TARGET = 0.004;          // 0.4%
const HOLD_MS = 4 * 3600000;    // 4 hours

const DATA_FILE = path.join(__dirname, 'data', 'trades.json');
let trades = [];
let totalProfit = 0;
let totalTrades = 0;
let totalWins = 0;

// Load previous trades if file exists
if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE));
    trades = saved.trades || [];
    totalProfit = saved.totalProfit || 0;
    totalTrades = saved.totalTrades || 0;
    totalWins = saved.totalWins || 0;
    console.log(`Loaded ${trades.length} previous trades`);
  } catch(e) { console.log('No previous data'); }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ trades, totalProfit, totalTrades, totalWins }, null, 2));
}

// Bot state
let tradeActive = false;
let entryPrice = 0;
let targetPrice = 0;
let tradeStartTime = 0;
let btcPrice = 67000;
let monitorInterval = null;
let nextTradeTimeout = null;

function addLog(msg) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${msg}`);
}

function netProfitOnTarget() {
  return (WORKING_CAPITAL * TARGET) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
}

function closeTrade(exitReason, exitPrice, profit, isWin, durationMs) {
  if (!tradeActive) return;
  tradeActive = false;
  if (monitorInterval) clearInterval(monitorInterval);
  if (nextTradeTimeout) clearTimeout(nextTradeTimeout);

  const tradeRecord = {
    id: trades.length + 1,
    timestamp: new Date().toISOString(),
    entryPrice,
    targetPrice,
    exitPrice,
    profitUsd: profit,
    win: isWin,
    durationSeconds: Math.floor(durationMs / 1000),
    exitReason
  };
  trades.push(tradeRecord);
  totalProfit += profit;
  totalTrades++;
  if (isWin) totalWins++;
  saveData();

  addLog(`${isWin ? '✅ WIN' : '❌ LOSS'} → $${Math.abs(profit).toFixed(3)} | exit: $${exitPrice.toFixed(2)} | ${exitReason} | total profit: $${totalProfit.toFixed(2)}`);

  // Next trade after 5–15 minutes
  nextTradeTimeout = setTimeout(() => {
    if (!tradeActive) startTrade();
  }, 300000 + Math.random() * 600000);
}

function startTrade() {
  if (tradeActive) return;
  if (btcPrice < 10000) {
    addLog('Waiting for valid BTC price...');
    setTimeout(() => startTrade(), 5000);
    return;
  }
  entryPrice = btcPrice;
  targetPrice = entryPrice * (1 + TARGET);
  tradeActive = true;
  tradeStartTime = Date.now();
  addLog(`🟢 BUY @ $${entryPrice.toFixed(2)} | TARGET: $${targetPrice.toFixed(2)} (+0.4%) | HOLD: 4h`);

  monitorInterval = setInterval(() => {
    if (!tradeActive) return;
    const elapsed = Date.now() - tradeStartTime;
    if (btcPrice >= targetPrice) {
      clearInterval(monitorInterval);
      const profit = netProfitOnTarget();
      closeTrade('target_hit', btcPrice, profit, true, elapsed);
    } else if (elapsed >= HOLD_MS) {
      clearInterval(monitorInterval);
      const actualMove = (btcPrice - entryPrice) / entryPrice;
      let profit = 0;
      if (actualMove > 0) {
        const gross = WORKING_CAPITAL * Math.min(actualMove, TARGET);
        profit = gross - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
      } else {
        const grossLoss = WORKING_CAPITAL * Math.abs(actualMove);
        profit = -(grossLoss + (WORKING_CAPITAL * TRADE_FEE) + (WORKING_CAPITAL * SPREAD));
      }
      closeTrade('timeout_4h', btcPrice, profit, profit > 0, elapsed);
    }
  }, 2000);
}

// Binance WebSocket
const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
ws.on('open', () => addLog('🟢 WebSocket connected'));
ws.on('message', (data) => {
  try {
    const json = JSON.parse(data);
    if (json.p) {
      const newPrice = parseFloat(json.p);
      if (newPrice > 10000 && newPrice < 200000) btcPrice = newPrice;
    }
  } catch(e) {}
});
ws.on('close', () => {
  addLog('⚠️ WebSocket closed, reconnecting in 3s...');
  setTimeout(() => {
    const newWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
  }, 3000);
});

// ================= DASHBOARD (Express) =================
const app = express();

// API endpoint to get stats and trades
app.get('/api/stats', (req, res) => {
  const cumulativeProfit = [];
  let sum = 0;
  for (const t of trades) {
    sum += t.profitUsd;
    cumulativeProfit.push(sum);
  }
  res.json({
    totalProfit,
    totalTrades,
    totalWins,
    winRate: totalTrades ? (totalWins / totalTrades) * 100 : 0,
    currentPrice: btcPrice,
    tradeActive,
    trades: trades.slice(-20).reverse(), // last 20 trades for table
    cumulativeProfit
  });
});

// Serve the dashboard HTML
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
  <title>BTC Scalper Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0b0b0f;
      font-family: 'Courier New', monospace;
      color: #ededee;
      padding: 1rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #222;
    }
    h1 { color: #F7931A; font-size: 1.4rem; }
    .badge { background: #1D9E7522; border: 1px solid #1D9E75; padding: 0.2rem 0.8rem; border-radius: 60px; font-size: 0.7rem; }
    .grid-4 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 0.8rem;
      margin-bottom: 1rem;
    }
    .card {
      background: #111216;
      border: 1px solid #24262e;
      border-radius: 0.8rem;
      padding: 0.8rem;
      text-align: center;
    }
    .card-value { font-size: 1.5rem; font-weight: bold; }
    .positive { color: #00FFAA; }
    .negative { color: #E24B4A; }
    .btc-price { font-size: 1.8rem; font-weight: bold; color: #F7931A; text-align: center; margin: 1rem 0; }
    .chart-container { height: 200px; margin: 1rem 0; }
    .table-container {
      max-height: 300px;
      overflow-y: auto;
      background: #0a0a0e;
      border-radius: 0.5rem;
      margin-top: 1rem;
    }
    table { width: 100%; font-size: 0.7rem; border-collapse: collapse; }
    th, td { padding: 0.4rem; text-align: left; border-bottom: 1px solid #222; }
    th { color: #888; }
    .win { color: #00FFAA; }
    .loss { color: #E24B4A; }
    .footer { text-align: center; font-size: 0.6rem; color: #555; margin-top: 1rem; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>₿ BTC Scalper · Live Dashboard</h1>
    <div class="badge">🟢 24/7 · Real Binance Data</div>
  </div>

  <div class="grid-4">
    <div class="card"><div class="card-label">💰 TOTAL PROFIT</div><div class="card-value" id="profit">$0.00</div></div>
    <div class="card"><div class="card-label">📊 TRADES</div><div class="card-value" id="trades">0</div></div>
    <div class="card"><div class="card-label">✅ WIN RATE</div><div class="card-value" id="winrate">0%</div></div>
    <div class="card"><div class="card-label">⚡ STATUS</div><div class="card-value" id="status">Waiting</div></div>
  </div>

  <div class="btc-price" id="btcPrice">$---</div>

  <div class="chart-container">
    <canvas id="profitChart"></canvas>
  </div>

  <h3>📋 Recent Trades</h3>
  <div class="table-container">
    <table id="tradesTable">
      <thead><tr><th>Time</th><th>Entry</th><th>Exit</th><th>Profit</th><th>Result</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="footer">Auto‑refresh every 10s · 4h max hold · 0.4% target · $100 capital</div>
</div>

<script>
  let chart;
  async function fetchData() {
    const res = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('profit').innerHTML = \`$\${data.totalProfit.toFixed(2)}\`;
    document.getElementById('profit').className = \`card-value \${data.totalProfit >= 0 ? 'positive' : 'negative'}\`;
    document.getElementById('trades').innerText = data.totalTrades;
    document.getElementById('winrate').innerText = data.winRate.toFixed(1) + '%';
    document.getElementById('status').innerText = data.tradeActive ? 'In trade' : 'Waiting';
    document.getElementById('btcPrice').innerHTML = \`$\${data.currentPrice.toFixed(2)}\`;

    // Update chart
    if (chart) chart.destroy();
    const ctx = document.getElementById('profitChart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.cumulativeProfit.map((_, i) => i+1),
        datasets: [{ label: 'Cumulative Profit ($)', data: data.cumulativeProfit, borderColor: '#F7931A', fill: false, tension: 0.2, pointRadius: 0 }]
      },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } } }
    });

    // Update table
    const tbody = document.querySelector('#tradesTable tbody');
    tbody.innerHTML = '';
    for (const t of data.trades) {
      const row = tbody.insertRow();
      row.insertCell(0).innerText = new Date(t.timestamp).toLocaleString();
      row.insertCell(1).innerText = \`$\${t.entryPrice.toFixed(2)}\`;
      row.insertCell(2).innerText = \`$\${t.exitPrice.toFixed(2)}\`;
      row.insertCell(3).innerHTML = \`<span class="\${t.win ? 'win' : 'loss'}">\${t.win ? '+' : '-'}\$\${Math.abs(t.profitUsd).toFixed(2)}</span>\`;
      row.insertCell(4).innerText = t.win ? 'WIN' : 'LOSS';
    }
  }
  fetchData();
  setInterval(fetchData, 10000);
</script>
</body>
</html>
  `);
});

app.listen(3000, () => addLog('Dashboard on port 3000'));

// Start the bot
setTimeout(() => startTrade(), 5000);