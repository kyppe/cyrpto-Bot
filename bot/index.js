const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ================= CONFIG =================
const WORKING_CAPITAL = 100;
const TRADE_FEE = 0.00175;
const SPREAD = 0.0002;
const TARGET = 0.004;
const HOLD_MS = 2 * 3600000;
const TRAILING_STOP = 0.006;
const GRACE_MS = 30 * 60000;
const WAVE_DROP = 0.002;

// ⚠️  Get your FREE key at https://finnhub.io (takes 30 seconds)
const FINNHUB_KEY = 'd78h9qpr01qsbhvtsjggd78h9qpr01qsbhvtsjh0';

const COINS = ['btcusdt','ethusdt','solusdt','bnbusdt','xrpusdt','dogeusdt','adausdt','avaxusdt'];
const COIN_LABELS = { btcusdt:'BTC', ethusdt:'ETH', solusdt:'SOL', bnbusdt:'BNB', xrpusdt:'XRP', dogeusdt:'DOGE', adausdt:'ADA', avaxusdt:'AVAX' };

const STOCKS = ['GOOGL','AAPL','TSLA','NVDA','AMZN','META','MSFT','AMD'];
const STOCK_LABELS = { GOOGL:'Google', AAPL:'Apple', TSLA:'Tesla', NVDA:'Nvidia', AMZN:'Amazon', META:'Meta', MSFT:'Microsoft', AMD:'AMD' };

const DATA_FILE = path.join(__dirname, 'data', 'trades.json');

let prices = {};
let botState = {};

// Init crypto state
COINS.forEach(coin => {
  prices[coin] = 0;
  ['safe','wave'].forEach(strat => {
    botState[`${coin}_${strat}`] = {
      coin, strat, type: 'crypto',
      tradeActive: false, entryPrice: 0, targetPrice: 0, peakPrice: 0,
      tradeStartTime: 0, monitorInterval: null, nextTradeTimeout: null,
      trades: [], totalProfit: 0, totalTrades: 0, totalWins: 0,
    };
  });
});

// Init stock state
STOCKS.forEach(stock => {
  prices[stock] = 0;
  ['safe','wave'].forEach(strat => {
    botState[`${stock}_${strat}`] = {
      coin: stock, strat, type: 'stock',
      tradeActive: false, entryPrice: 0, targetPrice: 0, peakPrice: 0,
      tradeStartTime: 0, monitorInterval: null, nextTradeTimeout: null,
      trades: [], totalProfit: 0, totalTrades: 0, totalWins: 0,
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
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ botState: toSave }, null, 2));
}

function addLog(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 570 && minutes < 960;
}

function netProfit(move) {
  return (WORKING_CAPITAL * move) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
}

function getLabel(key) {
  const s = botState[key];
  return s.type === 'stock' ? STOCK_LABELS[s.coin] : COIN_LABELS[s.coin];
}

function closeTrade(key, exitReason, exitPrice, profit, isWin, durationMs) {
  const s = botState[key];
  if (!s.tradeActive) return;
  s.tradeActive = false;
  if (s.monitorInterval) clearInterval(s.monitorInterval);
  if (s.nextTradeTimeout) clearTimeout(s.nextTradeTimeout);

  s.trades.push({
    id: s.trades.length + 1,
    timestamp: new Date().toISOString(),
    entryPrice: s.entryPrice, targetPrice: s.targetPrice,
    exitPrice, profitUsd: profit, win: isWin,
    durationSeconds: Math.floor(durationMs / 1000), exitReason
  });
  s.totalProfit += profit;
  s.totalTrades++;
  if (isWin) s.totalWins++;
  saveData();

  addLog(`[${getLabel(key)}/${s.strat}] ${isWin ? '✅' : '❌'} $${profit.toFixed(3)} | ${exitReason} | total: $${s.totalProfit.toFixed(2)}`);

  s.nextTradeTimeout = setTimeout(() => { if (!s.tradeActive) startTrade(key); }, 300000 + Math.random() * 600000);
}

function startTrade(key) {
  const s = botState[key];
  if (s.tradeActive) return;

  if (s.type === 'stock' && !isMarketOpen()) {
    s.nextTradeTimeout = setTimeout(() => startTrade(key), 60000);
    return;
  }

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

  addLog(`[${getLabel(key)}/${s.strat}] 🟢 BUY @ ${price.toFixed(4)} | TARGET: ${s.targetPrice.toFixed(4)}`);

  s.monitorInterval = setInterval(() => {
    if (!s.tradeActive) return;

    if (s.type === 'stock' && !isMarketOpen()) {
      clearInterval(s.monitorInterval);
      const cur = prices[s.coin];
      const move = (cur - s.entryPrice) / s.entryPrice;
      const profit = move >= 0
        ? netProfit(Math.min(move, TARGET))
        : -(WORKING_CAPITAL * Math.abs(move)) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
      closeTrade(key, 'market_closed', cur, profit, profit > 0, Date.now() - s.tradeStartTime);
      return;
    }

    const cur = prices[s.coin];
    if (!cur) return;
    const elapsed = Date.now() - s.tradeStartTime;
    const move = (cur - s.entryPrice) / s.entryPrice;
    if (cur > s.peakPrice) s.peakPrice = cur;

    if (s.strat === 'safe') {
      if (cur >= s.targetPrice) {
        clearInterval(s.monitorInterval);
        closeTrade(key, 'target_hit', cur, netProfit(TARGET), true, elapsed);
        return;
      }
      if (elapsed > GRACE_MS) {
        const drop = (s.peakPrice - cur) / s.peakPrice;
        if (drop >= TRAILING_STOP) {
          clearInterval(s.monitorInterval);
          closeTrade(key, 'trailing_stop', cur, netProfit(Math.max(move, -TRAILING_STOP)), move > -TRAILING_STOP, elapsed);
          return;
        }
      }
      if (elapsed >= HOLD_MS) {
        clearInterval(s.monitorInterval);
        const profit = move >= 0
          ? netProfit(Math.min(move, TARGET))
          : -(WORKING_CAPITAL * Math.abs(move)) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
        closeTrade(key, 'timeout_2h', cur, profit, profit > 0, elapsed);
      }
    } else {
      const aboveTarget = cur >= s.targetPrice;
      const peakMove = (s.peakPrice - s.entryPrice) / s.entryPrice;
      const drop = (s.peakPrice - cur) / s.peakPrice;

      if (aboveTarget && drop >= WAVE_DROP) {
        clearInterval(s.monitorInterval);
        closeTrade(key, 'wave_cashout', cur, netProfit(peakMove - WAVE_DROP), true, elapsed);
        return;
      }
      if (elapsed > GRACE_MS && !aboveTarget && drop >= TRAILING_STOP) {
        clearInterval(s.monitorInterval);
        closeTrade(key, 'trailing_stop', cur, netProfit(Math.max(move, -TRAILING_STOP)), move > -TRAILING_STOP, elapsed);
        return;
      }
      if (elapsed >= HOLD_MS) {
        clearInterval(s.monitorInterval);
        let profit;
        if (aboveTarget && peakMove > WAVE_DROP) profit = netProfit(peakMove - WAVE_DROP);
        else profit = move >= 0
          ? netProfit(Math.min(move, TARGET))
          : -(WORKING_CAPITAL * Math.abs(move)) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
        closeTrade(key, 'timeout_2h', cur, profit, profit > 0, elapsed);
      }
    }
  }, 2000);
}

// ================= BINANCE WS (Crypto) =================
function connectCryptoWS() {
  const streams = COINS.map(c => `${c}@trade`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  ws.on('open', () => addLog('🟢 Binance WS connected'));
  ws.on('message', data => {
    try {
      const json = JSON.parse(data);
      const coin = json.stream.split('@')[0];
      const price = parseFloat(json.data.p);
      if (price > 0) prices[coin] = price;
    } catch(e) {}
  });
  ws.on('close', () => { addLog('⚠️ Binance WS closed, reconnecting...'); setTimeout(connectCryptoWS, 3000); });
  ws.on('error', () => ws.close());
}
connectCryptoWS();

// ================= FINNHUB WS (Stocks) =================
function connectStockWS() {
  if (FINNHUB_KEY === 'YOUR_FINNHUB_KEY_HERE') {
    addLog('⚠️  No Finnhub key — using Yahoo Finance polling (15s delay)');
    pollStockPrices();
    return;
  }
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => {
    addLog('🟢 Finnhub WS connected');
    STOCKS.forEach(s => ws.send(JSON.stringify({ type: 'subscribe', symbol: s })));
  });
  ws.on('message', data => {
    try {
      const json = JSON.parse(data);
      if (json.type === 'trade' && json.data) {
        json.data.forEach(t => { if (t.p > 0) prices[t.s] = t.p; });
      }
    } catch(e) {}
  });
  ws.on('close', () => { addLog('⚠️ Finnhub WS closed, reconnecting...'); setTimeout(connectStockWS, 5000); });
  ws.on('error', () => ws.close());
}

async function pollStockPrices() {
  const poll = async () => {
    await Promise.all(STOCKS.map(async symbol => {
      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`);
        const json = await res.json();
        const p = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (p && p > 0) prices[symbol] = p;
      } catch(e) {}
    }));
    setTimeout(poll, 15000);
  };
  poll();
}
connectStockWS();

// ================= EXPRESS =================
const app = express();

app.get(['/api/stats', '/crypto/api/stats'], (req, res) => {
  const result = {};

  [...COINS.map(c => ({ id: c, type: 'crypto', label: COIN_LABELS[c] })),
   ...STOCKS.map(s => ({ id: s, type: 'stock', label: STOCK_LABELS[s] }))
  ].forEach(({ id, type, label }) => {
    ['safe','wave'].forEach(strat => {
      const key = `${id}_${strat}`;
      const s = botState[key];
      const cumulative = [];
      let sum = 0;
      for (const t of s.trades) { sum += t.profitUsd; cumulative.push(parseFloat(sum.toFixed(4))); }
      result[key] = {
        label, strat, type,
        totalProfit: parseFloat(s.totalProfit.toFixed(4)),
        totalTrades: s.totalTrades, totalWins: s.totalWins,
        winRate: s.totalTrades ? (s.totalWins / s.totalTrades) * 100 : 0,
        currentPrice: prices[id] || 0,
        tradeActive: s.tradeActive,
        marketOpen: isMarketOpen(),
        trades: s.trades.slice(-20).reverse(), cumulative
      };
    });
  });

  res.json({ data: result, prices, marketOpen: isMarketOpen() });
});

app.get(['/', '/crypto'], (req, res) => res.send(getDashboardHTML()));

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Arena — Crypto & Stocks</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg:#060608; --surface:#0d0d12; --border:#1a1a24; --text:#e8e8f0; --muted:#555566;
  --safe:#00e5ff; --wave:#ff6b35; --win:#00ff9d; --loss:#ff3d6b; --gold:#ffd700;
  --stock:#a78bfa; --crypto:#f59e0b;
}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);font-family:'Space Mono',monospace;color:var(--text);min-height:100vh;}
.header{padding:1rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.6rem;}
.logo{font-family:'Syne',sans-serif;font-size:1.1rem;font-weight:800;}
.logo .c{color:var(--crypto);} .logo .s{color:var(--stock);}
.live-dot{width:7px;height:7px;background:var(--win);border-radius:50%;display:inline-block;margin-right:4px;animation:pulse 1.5s infinite;}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.3)}}
.badge{font-size:0.58rem;border:1px solid #333;padding:0.18rem 0.5rem;border-radius:2px;color:var(--muted);}
.mkt-badge{font-size:0.58rem;padding:0.18rem 0.5rem;border-radius:2px;}
.mkt-badge.open{background:#00ff9d22;color:var(--win);border:1px solid var(--win);}
.mkt-badge.closed{background:#ff3d6b22;color:var(--loss);border:1px solid var(--loss);}
.section-bar{display:flex;border-bottom:2px solid var(--border);background:var(--surface);}
.section-btn{flex:1;padding:0.75rem 0.5rem;font-family:'Space Mono',monospace;font-size:0.68rem;font-weight:700;border:none;background:transparent;color:var(--muted);cursor:pointer;transition:all 0.2s;border-bottom:3px solid transparent;margin-bottom:-2px;}
.section-btn:hover{color:var(--text);}
.section-btn.active.leaderboard{color:var(--gold);border-bottom-color:var(--gold);}
.section-btn.active.crypto{color:var(--crypto);border-bottom-color:var(--crypto);}
.section-btn.active.stock{color:var(--stock);border-bottom-color:var(--stock);}
.tabs-bar{display:flex;overflow-x:auto;border-bottom:1px solid var(--border);background:#09090e;scrollbar-width:none;}
.tabs-bar::-webkit-scrollbar{display:none;}
.tab{padding:0.55rem 0.9rem;font-size:0.62rem;font-family:'Space Mono',monospace;cursor:pointer;border:none;background:transparent;color:var(--muted);border-bottom:2px solid transparent;transition:all 0.2s;white-space:nowrap;}
.tab:hover{color:var(--text);} .tab.active{color:var(--text);border-bottom-color:var(--safe);}
.section{display:none;} .section.active{display:block;}
.lb-wrap{padding:1rem 1.5rem;}
.lb-title{font-family:'Syne',sans-serif;font-size:0.85rem;font-weight:800;margin-bottom:0.7rem;display:flex;align-items:center;gap:0.4rem;}
.lb-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;margin-bottom:1.2rem;}
@media(max-width:580px){.lb-grid{grid-template-columns:1fr;}}
.lb-table{background:var(--surface);border:1px solid var(--border);border-radius:4px;overflow:hidden;}
.lb-table-title{padding:0.45rem 0.8rem;font-size:0.58rem;color:var(--muted);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:0.3rem;}
.strat-dot{width:5px;height:5px;border-radius:50%;display:inline-block;}
.lb-row{display:grid;grid-template-columns:1.2rem 3rem 1fr 1fr 1fr;align-items:center;padding:0.4rem 0.8rem;border-bottom:1px solid var(--border);font-size:0.58rem;gap:0.3rem;}
.lb-row:last-child{border-bottom:none;}
.lb-rank{color:var(--muted);font-size:0.52rem;} .lb-rank.gold{color:var(--gold);} .lb-rank.silver{color:#aaa;} .lb-rank.bronze{color:#cd7f32;}
.lb-coin{font-weight:700;font-size:0.62rem;}
.pos{color:var(--win);} .neg{color:var(--loss);} .mu{color:var(--muted);}
.divider{border:none;border-top:1px solid var(--border);margin:1rem 0;}
.asset-panel{display:none;padding:1rem 1.5rem;} .asset-panel.active{display:block;}
.asset-header{display:flex;align-items:baseline;gap:0.7rem;margin-bottom:0.8rem;flex-wrap:wrap;}
.asset-name{font-family:'Syne',sans-serif;font-size:1.3rem;font-weight:800;}
.asset-price{font-size:0.85rem;color:var(--muted);}
.strats-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;}
@media(max-width:600px){.strats-grid{grid-template-columns:1fr;}}
.strat-card{background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;}
.strat-header{padding:0.6rem 0.8rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;}
.strat-label{font-size:0.62rem;font-weight:700;} .strat-label.safe{color:var(--safe);} .strat-label.wave{color:var(--wave);}
.strat-status{font-size:0.52rem;padding:0.1rem 0.4rem;border-radius:2px;}
.strat-status.active-trade{background:#00ff9d22;color:var(--win);border:1px solid var(--win);}
.strat-status.waiting{background:#ffffff11;color:var(--muted);}
.strat-status.paused{background:#ff3d6b22;color:var(--loss);border:1px solid var(--loss);}
.stats-row{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border);}
.stat-box{padding:0.55rem 0.3rem;border-right:1px solid var(--border);text-align:center;} .stat-box:last-child{border-right:none;}
.stat-val{font-size:0.9rem;font-weight:700;} .stat-lbl{font-size:0.48rem;color:var(--muted);margin-top:0.1rem;}
.chart-wrap{height:90px;padding:0.4rem;}
.trades-wrap{max-height:150px;overflow-y:auto;} .trades-wrap::-webkit-scrollbar{width:2px;} .trades-wrap::-webkit-scrollbar-thumb{background:var(--border);}
table{width:100%;border-collapse:collapse;font-size:0.56rem;}
th{padding:0.3rem 0.45rem;color:var(--muted);text-align:left;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);}
td{padding:0.28rem 0.45rem;border-bottom:1px solid #0f0f18;}
.w{color:var(--win);} .l{color:var(--loss);}
.type-badge{font-size:0.45rem;padding:0.08rem 0.25rem;border-radius:2px;margin-left:0.25rem;vertical-align:middle;}
.type-badge.crypto{background:#f59e0b22;color:var(--crypto);border:1px solid var(--crypto);}
.type-badge.stock{background:#a78bfa22;color:var(--stock);border:1px solid var(--stock);}
.footer{text-align:center;font-size:0.48rem;color:var(--muted);padding:0.7rem;border-top:1px solid var(--border);margin-top:1rem;}
</style>
</head>
<body>

<div class="header">
  <div class="logo"><span class="c">₿ Crypto</span> · <span class="s">📈 Stocks</span> Arena</div>
  <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
    <div id="marketBadge" class="mkt-badge closed">🔴 Market Closed</div>
    <div class="badge"><span class="live-dot"></span>16 ASSETS · 2 STRATEGIES · LIVE</div>
  </div>
</div>

<div class="section-bar">
  <button class="section-btn active leaderboard" onclick="showSection('leaderboard')">🏆 Leaderboard</button>
  <button class="section-btn crypto" onclick="showSection('crypto')">₿ Crypto</button>
  <button class="section-btn stock" onclick="showSection('stock')">📈 Stocks</button>
</div>

<!-- LEADERBOARD -->
<div id="section-leaderboard" class="section active">
  <div class="lb-wrap">
    <div class="lb-title"><span style="color:var(--crypto)">₿</span> Crypto Rankings</div>
    <div class="lb-grid">
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--safe)"></span>SAFE</div><div id="lb-crypto-safe"></div></div>
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--wave)"></span>WAVE</div><div id="lb-crypto-wave"></div></div>
    </div>
    <hr class="divider">
    <div class="lb-title"><span style="color:var(--stock)">📈</span> Stock Rankings <span style="font-size:0.6rem;color:var(--muted);font-weight:400">(trades only during market hours)</span></div>
    <div class="lb-grid">
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--safe)"></span>SAFE</div><div id="lb-stock-safe"></div></div>
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--wave)"></span>WAVE</div><div id="lb-stock-wave"></div></div>
    </div>
    <hr class="divider">
    <div class="lb-title">🌍 Overall — All 16 Assets</div>
    <div class="lb-grid">
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--safe)"></span>SAFE</div><div id="lb-all-safe"></div></div>
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--wave)"></span>WAVE</div><div id="lb-all-wave"></div></div>
    </div>
  </div>
</div>

<!-- CRYPTO SECTION -->
<div id="section-crypto" class="section">
  <div class="tabs-bar" id="cryptoTabsBar"></div>
  <div id="cryptoPanels"></div>
</div>

<!-- STOCK SECTION -->
<div id="section-stock" class="section">
  <div class="tabs-bar" id="stockTabsBar"></div>
  <div id="stockPanels"></div>
</div>

<div class="footer">
  Auto-refresh 10s · 0.4% target · 2h max hold · 30min grace period · Trailing stop 0.6% · Wave drop 0.2% · $100/asset/strategy
  · Stocks: Mon–Fri 9:30am–4pm ET · Brokers available in Tunisia: AvaTrade · XTB · Interactive Brokers
</div>

<script>
const COINS=['btcusdt','ethusdt','solusdt','bnbusdt','xrpusdt','dogeusdt','adausdt','avaxusdt'];
const CLABELS={btcusdt:'BTC',ethusdt:'ETH',solusdt:'SOL',bnbusdt:'BNB',xrpusdt:'XRP',dogeusdt:'DOGE',adausdt:'ADA',avaxusdt:'AVAX'};
const STOCKS=['GOOGL','AAPL','TSLA','NVDA','AMZN','META','MSFT','AMD'];
const SLABELS={GOOGL:'Google',AAPL:'Apple',TSLA:'Tesla',NVDA:'Nvidia',AMZN:'Amazon',META:'Meta',MSFT:'Microsoft',AMD:'AMD'};
const charts={};

// Build panels
function buildTabs(ids, labels, tabsBarId, panelsId, prefix) {
  const bar = document.getElementById(tabsBarId);
  const wrap = document.getElementById(panelsId);
  ids.forEach((id, i) => {
    const label = labels[id];
    const btn = document.createElement('button');
    btn.className='tab'+(i===0?' active':'');
    btn.id=prefix+'tab-'+id; btn.textContent=id.length>6?label:id;
    btn.onclick=()=>showTab(prefix,id,ids);
    bar.appendChild(btn);
    const panel=document.createElement('div');
    panel.className='asset-panel'+(i===0?' active':'');
    panel.id=prefix+'panel-'+id;
    panel.innerHTML=buildPanel(id,label,prefix==='s'?'stock':'crypto');
    wrap.appendChild(panel);
  });
}

function buildPanel(id, label, type) {
  return \`
  <div class="asset-header">
    <div class="asset-name">\${label}</div>
    <div class="asset-price" id="price-\${id}">$---</div>
    \${type==='stock'?'<div id="mkt-'+id+'" class="mkt-badge closed">Market Closed</div>':''}
  </div>
  <div class="strats-grid">
    \${buildCard(id,'safe')}
    \${buildCard(id,'wave')}
  </div>\`;
}

function buildCard(id, strat) {
  const key=id+'_'+strat;
  const icon=strat==='safe'?'🛡':'🌊';
  return \`
  <div class="strat-card">
    <div class="strat-header">
      <div class="strat-label \${strat}">\${icon} \${strat.toUpperCase()}</div>
      <div class="strat-status waiting" id="status-\${key}">Waiting</div>
    </div>
    <div class="stats-row">
      <div class="stat-box"><div class="stat-val" id="profit-\${key}">$0.00</div><div class="stat-lbl">PROFIT</div></div>
      <div class="stat-box"><div class="stat-val" id="wr-\${key}">0%</div><div class="stat-lbl">WIN RATE</div></div>
      <div class="stat-box"><div class="stat-val" id="tr-\${key}">0</div><div class="stat-lbl">TRADES</div></div>
    </div>
    <div class="chart-wrap"><canvas id="chart-\${key}"></canvas></div>
    <div class="trades-wrap">
      <table><thead><tr><th>Time</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr></thead>
      <tbody id="tbody-\${key}"></tbody></table>
    </div>
  </div>\`;
}

buildTabs(COINS,CLABELS,'cryptoTabsBar','cryptoPanels','c');
buildTabs(STOCKS,SLABELS,'stockTabsBar','stockPanels','s');

function showSection(s) {
  document.querySelectorAll('.section').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.section-btn').forEach(el=>el.classList.remove('active'));
  document.getElementById('section-'+s).classList.add('active');
  document.querySelector('.section-btn.'+s).classList.add('active');
}

function showTab(prefix, id, ids) {
  ids.forEach(i => {
    document.getElementById(prefix+'tab-'+i)?.classList.remove('active');
    document.getElementById(prefix+'panel-'+i)?.classList.remove('active');
  });
  document.getElementById(prefix+'tab-'+id)?.classList.add('active');
  document.getElementById(prefix+'panel-'+id)?.classList.add('active');
}

function fmtPrice(p) {
  if(!p) return '$---';
  if(p<0.01) return '$'+p.toFixed(6);
  if(p<1) return '$'+p.toFixed(4);
  if(p<100) return '$'+p.toFixed(3);
  return '$'+p.toFixed(2);
}

function updateCard(key, d) {
  const pe=document.getElementById('profit-'+key);
  if(pe){pe.textContent=(d.totalProfit>=0?'+':'')+'$'+d.totalProfit.toFixed(2);pe.className='stat-val '+(d.totalProfit>=0?'pos':'neg');}
  const we=document.getElementById('wr-'+key); if(we) we.textContent=d.winRate.toFixed(1)+'%';
  const te=document.getElementById('tr-'+key); if(te) te.textContent=d.totalTrades;
  const se=document.getElementById('status-'+key);
  if(se){
    if(d.type==='stock'&&!d.marketOpen){se.textContent='Market Closed';se.className='strat-status paused';}
    else if(d.tradeActive){se.textContent='IN TRADE';se.className='strat-status active-trade';}
    else{se.textContent='Waiting';se.className='strat-status waiting';}
  }
  const canvas=document.getElementById('chart-'+key);
  if(canvas){
    if(charts[key]) charts[key].destroy();
    const color=key.endsWith('safe')?'#00e5ff':'#ff6b35';
    charts[key]=new Chart(canvas.getContext('2d'),{
      type:'line',
      data:{labels:d.cumulative.map((_,i)=>i+1),datasets:[{data:d.cumulative,borderColor:color,backgroundColor:color+'22',fill:true,tension:0.3,pointRadius:0,borderWidth:1.5}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
        scales:{x:{display:false},y:{display:true,ticks:{color:'#555566',font:{size:7},callback:v=>'$'+v.toFixed(2)},grid:{color:'#1a1a24'}}}}
    });
  }
  const tbody=document.getElementById('tbody-'+key);
  if(tbody){
    tbody.innerHTML='';
    for(const t of d.trades){
      const tr=tbody.insertRow();
      tr.insertCell(0).textContent=new Date(t.timestamp).toLocaleTimeString();
      tr.insertCell(1).textContent=fmtPrice(t.entryPrice);
      tr.insertCell(2).textContent=fmtPrice(t.exitPrice);
      const p=tr.insertCell(3);
      p.innerHTML=\`<span class="\${t.win?'w':'l'}">\${t.win?'+':'-'}\$\${Math.abs(t.profitUsd).toFixed(3)}</span>\`;
      tr.insertCell(4).textContent=t.exitReason;
    }
  }
}

function buildLB(id, entries) {
  const el=document.getElementById(id); if(!el) return;
  el.innerHTML=entries.map((e,i)=>{
    const rc=i===0?'gold':i===1?'silver':i===2?'bronze':'';
    const ri=i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1);
    return \`<div class="lb-row">
      <div class="lb-rank \${rc}">\${ri}</div>
      <div class="lb-coin">\${e.coin}<span class="type-badge \${e.type}">\${e.type==='crypto'?'₿':'📈'}</span></div>
      <div class="\${e.profit>=0?'pos':'neg'}">\${e.profit>=0?'+':''}\$\${e.profit.toFixed(2)}</div>
      <div class="mu">\${e.winRate.toFixed(0)}%</div>
      <div class="mu">\${e.trades}T</div>
    </div>\`;
  }).join('');
}

async function fetchData() {
  try {
    const res=await fetch('/crypto/api/stats');
    const json=await res.json();
    const data=json.data;

    const mb=document.getElementById('marketBadge');
    if(mb){mb.textContent=json.marketOpen?'🟢 Market Open':'🔴 Market Closed';mb.className='mkt-badge '+(json.marketOpen?'open':'closed');}

    COINS.forEach(coin=>{
      const pe=document.getElementById('price-'+coin); if(pe) pe.textContent=fmtPrice(json.prices[coin]);
      ['safe','wave'].forEach(strat=>{ const k=coin+'_'+strat; if(data[k]) updateCard(k,data[k]); });
    });

    STOCKS.forEach(stock=>{
      const pe=document.getElementById('price-'+stock); if(pe) pe.textContent=fmtPrice(json.prices[stock]);
      const me=document.getElementById('mkt-'+stock);
      if(me){me.textContent=json.marketOpen?'🟢 Open':'🔴 Closed';me.className='mkt-badge '+(json.marketOpen?'open':'closed');}
      ['safe','wave'].forEach(strat=>{ const k=stock+'_'+strat; if(data[k]) updateCard(k,data[k]); });
    });

    ['safe','wave'].forEach(strat=>{
      const cEntries=COINS.map(c=>({coin:CLABELS[c],profit:data[c+'_'+strat].totalProfit,winRate:data[c+'_'+strat].winRate,trades:data[c+'_'+strat].totalTrades,type:'crypto'})).sort((a,b)=>b.profit-a.profit);
      buildLB('lb-crypto-'+strat,cEntries);
      const sEntries=STOCKS.map(s=>({coin:s,profit:data[s+'_'+strat].totalProfit,winRate:data[s+'_'+strat].winRate,trades:data[s+'_'+strat].totalTrades,type:'stock'})).sort((a,b)=>b.profit-a.profit);
      buildLB('lb-stock-'+strat,sEntries);
      buildLB('lb-all-'+strat,[...cEntries,...sEntries].sort((a,b)=>b.profit-a.profit));
    });

  } catch(e){console.error(e);}
}

fetchData();
setInterval(fetchData,10000);
</script>
</body>
</html>`;
}

app.listen(3000, () => addLog('🚀 Dashboard on port 3000'));

setTimeout(() => {
  [...COINS, ...STOCKS].forEach(id => {
    ['safe','wave'].forEach(strat => {
      setTimeout(() => startTrade(`${id}_${strat}`), Math.random() * 15000);
    });
  });
}, 5000);