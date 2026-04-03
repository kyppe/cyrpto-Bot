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
    // reassign global ws? Not needed for price updates, but keep reference
  }, 3000);
});

// Simple status page (accessible via /crypto)
const app = express();
app.get('/', (req, res) => {
  const lastTrades = trades.slice(-10).reverse().map(t => 
    `<li>${new Date(t.timestamp).toLocaleString()} → ${t.win ? 'WIN' : 'LOSS'} $${t.profitUsd.toFixed(2)} (${t.exitReason})</li>`
  ).join('');
  res.send(`
    <html>
    <head>
      <title>BTC Scalper Bot Status</title>
      <meta http-equiv="refresh" content="10">
      <style>body{background:#0b0b0f;color:#eee;font-family:monospace;padding:1rem;}</style>
    </head>
    <body>
      <h1>₿ BTC Scalper Bot (24/7)</h1>
      <p>Total Profit: <strong>$${totalProfit.toFixed(2)}</strong></p>
      <p>Trades: ${totalTrades} | Wins: ${totalWins} | Win Rate: ${totalTrades ? ((totalWins/totalTrades)*100).toFixed(1) : 0}%</p>
      <p>Current BTC Price: $${btcPrice.toFixed(2)}</p>
      <p>Bot Status: ${tradeActive ? 'In trade' : 'Waiting for next trade'}</p>
      <hr>
      <h3>Last 10 Trades</h3>
      <ul>${lastTrades}</ul>
      <hr>
      <p><a href="/crypto/export">Download trades.json</a></p>
    </body>
    </html>
  `);
});

// Optional: endpoint to download raw JSON
app.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=trades.json');
  res.json({ trades, totalProfit, totalTrades, totalWins });
});

app.listen(3000, () => addLog('Status page on port 3000'));

// Start the bot
setTimeout(() => startTrade(), 5000);