const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ================= CONFIG =================
const WORKING_CAPITAL = 100;
const TRADE_FEE       = 0.00175;
const SPREAD          = 0.0002;
const TARGET          = 0.004;   // 0.4% take profit
const PATIENCE_DROP   = 0.006;   // -0.6% triggers patience timer (both strategies)
const PATIENCE_MS     = 24 * 3600000; // 24h below -1% → cashout
const GRACE_MS        = 30 * 60000;   // 30min no timer at all
const WAVE_DROP       = 0.002;   // 0.2% drop from peak → wave cashout
const VOLATILITY_MIN  = 0.002;   // skip trade if 30min movement < 0.2%
const SLIPPAGE        = 0.0005;  // 0.05% — you never get exact price in real life
const OVERNIGHT_FEE   = 0.0003;  // 0.03% per night for stocks/commodities held overnight

// ⚠️  Get your FREE key at https://finnhub.io
const FINNHUB_KEY = 'YOUR_FINNHUB_KEY_HERE';

// Crypto assets (Binance)
const COINS = ['btcusdt','ethusdt','solusdt','bnbusdt','xrpusdt','dogeusdt','adausdt','avaxusdt'];
const COIN_LABELS = { btcusdt:'BTC', ethusdt:'ETH', solusdt:'SOL', bnbusdt:'BNB', xrpusdt:'XRP', dogeusdt:'DOGE', adausdt:'ADA', avaxusdt:'AVAX' };

// Stock assets (Finnhub / Yahoo fallback)
const STOCKS = ['GOOGL','AAPL','TSLA','NVDA','AMZN','META','MSFT','AMD'];
const STOCK_LABELS = { GOOGL:'Google', AAPL:'Apple', TSLA:'Tesla', NVDA:'Nvidia', AMZN:'Amazon', META:'Meta', MSFT:'Microsoft', AMD:'AMD' };

// Commodities via Yahoo Finance polling
const COMMODITIES = ['GC=F','SI=F','CL=F','NG=F'];
const COMMODITY_LABELS = { 'GC=F':'Gold', 'SI=F':'Silver', 'CL=F':'Oil', 'NG=F':'Nat.Gas' };

const ALL_ASSETS = [
  ...COINS.map(id => ({ id, type:'crypto', label: COIN_LABELS[id] })),
  ...STOCKS.map(id => ({ id, type:'stock', label: STOCK_LABELS[id] })),
  ...COMMODITIES.map(id => ({ id, type:'commodity', label: COMMODITY_LABELS[id] })),
];

const DATA_FILE = path.join(__dirname, 'data', 'trades.json');

let prices = {};
let priceHistory = {}; // rolling 30min history for volatility check
let botState = {};

ALL_ASSETS.forEach(({ id }) => {
  prices[id] = 0;
  priceHistory[id] = [];
  ['safe','wave'].forEach(strat => {
    botState[`${id}_${strat}`] = {
      id, strat, type: ALL_ASSETS.find(a=>a.id===id).type,
      label: ALL_ASSETS.find(a=>a.id===id).label,
      tradeActive: false,
      entryPrice: 0, targetPrice: 0, peakPrice: 0,
      tradeStartTime: 0,
      // SAFE: patience timer state
      belowDropSince: null,   // timestamp when price first dropped below -1%
      patienceTimeoutId: null,
      monitorInterval: null, nextTradeTimeout: null,
      trades: [], totalProfit: 0, totalTrades: 0, totalWins: 0, overnightFees: 0,
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
          botState[key].trades       = s.trades || [];
          botState[key].totalProfit  = s.totalProfit || 0;
          botState[key].totalTrades  = s.totalTrades || 0;
          botState[key].totalWins    = s.totalWins || 0;
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

function addLog(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Stocks: Mon-Fri 9:30am-4pm ET
function isMarketOpen() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const m = et.getHours() * 60 + et.getMinutes();
  return m >= 570 && m < 960;
}

// Commodities: Sun 6pm - Fri 5pm ET (nearly 24/7)
function isCommodityMarketOpen() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const m = et.getHours() * 60 + et.getMinutes();
  if (day === 6) return false;                   // all Saturday closed
  if (day === 5 && m >= 1020) return false;      // Friday after 5pm closed
  if (day === 0 && m < 1080) return false;       // Sunday before 6pm closed
  return true;
}

function netProfit(move) {
  return (WORKING_CAPITAL * move) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
}

// Volatility check: has price moved at least VOLATILITY_MIN in last 30 min?
function hasEnoughVolatility(id) {
  const hist = priceHistory[id];
  if (hist.length < 2) return true;
  // Need at least 2 minutes of history before we start filtering
  // Otherwise bot just started and has no data to judge volatility
  const spanMs = hist[hist.length - 1].ts - hist[0].ts;
  if (spanMs < 2 * 60000) return true; // less than 2min of data → allow trade
  const oldest = hist[0].price;
  const newest = hist[hist.length - 1].price;
  if (oldest === 0) return true;
  return Math.abs((newest - oldest) / oldest) >= VOLATILITY_MIN;
}

// Keep 30min of price history (one entry per price update, max 1800 entries)
function recordPrice(id, price) {
  const now = Date.now();
  priceHistory[id].push({ price, ts: now });
  // Keep only last 30 minutes
  const cutoff = now - 30 * 60000;
  priceHistory[id] = priceHistory[id].filter(p => p.ts >= cutoff);
  // Also cap array size
  if (priceHistory[id].length > 2000) priceHistory[id] = priceHistory[id].slice(-1000);
}

function closeTrade(key, exitReason, exitPrice, profit, isWin, durationMs) {
  const s = botState[key];
  if (!s.tradeActive) return;
  s.tradeActive = false;
  if (s.monitorInterval) clearInterval(s.monitorInterval);
  if (s.nextTradeTimeout) clearTimeout(s.nextTradeTimeout);
  if (s.patienceTimeoutId) clearTimeout(s.patienceTimeoutId);
  s.belowDropSince = null;
  s.patienceTimeoutId = null;

  // Deduct any overnight fees accumulated during this trade
  const overnightDeduction = s.overnightFees || 0;
  const finalProfit = profit - overnightDeduction;
  const finalWin = finalProfit > 0;
  s.overnightFees = 0; // reset for next trade

  s.trades.push({
    id: s.trades.length + 1,
    timestamp: new Date().toISOString(),
    entryPrice: s.entryPrice, targetPrice: s.targetPrice,
    exitPrice, profitUsd: parseFloat(finalProfit.toFixed(4)),
    win: finalWin, durationSeconds: Math.floor(durationMs / 1000), exitReason,
    overnightFees: parseFloat(overnightDeduction.toFixed(4)),
    slippage: parseFloat((s.entryPrice * SLIPPAGE / (1 + SLIPPAGE)).toFixed(4))
  });
  s.totalProfit += finalProfit;
  s.totalTrades++;
  if (finalWin) s.totalWins++;
  saveData();

  const overStr = overnightDeduction > 0 ? ` | overnight: -$${overnightDeduction.toFixed(3)}` : '';
  addLog(`[${s.label}/${s.strat}] ${finalWin ? '✅' : '❌'} $${finalProfit.toFixed(3)}${overStr} | ${exitReason} | total: $${s.totalProfit.toFixed(2)}`);
  s.nextTradeTimeout = setTimeout(() => { if (!s.tradeActive) startTrade(key); }, 300000 + Math.random() * 600000);
}

function startTrade(key) {
  const s = botState[key];
  if (s.tradeActive) return;

  // Stocks & commodities: only during market hours
  if ((s.type === 'stock' && !isMarketOpen()) || (s.type === 'commodity' && !isCommodityMarketOpen())) {
    s.nextTradeTimeout = setTimeout(() => startTrade(key), 60000);
    return;
  }

  const price = prices[s.id];
  if (!price || price < 0.0001) { setTimeout(() => startTrade(key), 5000); return; }

  // Volatility check — skip dead/frozen markets
  if (!hasEnoughVolatility(s.id)) {
    addLog(`[${s.label}/${s.strat}] ⏸ Skipping — market too quiet (< 0.2% movement in 30min)`);
    s.nextTradeTimeout = setTimeout(() => startTrade(key), 1800000); // retry in 30min
    return;
  }

  // Apply slippage — in real life you never get the exact price shown
  const slippedPrice = price * (1 + SLIPPAGE);
  s.entryPrice    = slippedPrice;
  s.targetPrice   = slippedPrice * (1 + TARGET);
  s.peakPrice     = slippedPrice;
  s.tradeActive   = true;
  s.tradeStartTime = Date.now();
  s.lastOvernightCheck = Date.now();
  s.belowDropSince = null;

  addLog(`[${s.label}/${s.strat}] 🟢 BUY @ ${slippedPrice.toFixed(4)} (slip +0.05%) | TARGET +0.4% @ ${s.targetPrice.toFixed(4)}`);

  s.monitorInterval = setInterval(() => {
    if (!s.tradeActive) return;

    // Market closed mid-trade
    if ((s.type === 'stock' && !isMarketOpen()) || (s.type === 'commodity' && !isCommodityMarketOpen())) {
      clearInterval(s.monitorInterval);
      const cur = prices[s.id];
      const move = (cur - s.entryPrice) / s.entryPrice;
      const profit = move >= 0
        ? netProfit(Math.min(move, TARGET))
        : -(WORKING_CAPITAL * Math.abs(move)) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
      closeTrade(key, 'market_closed', cur, profit, profit > 0, Date.now() - s.tradeStartTime);
      return;
    }

    const cur     = prices[s.id];
    if (!cur) return;
    const elapsed = Date.now() - s.tradeStartTime;
    const move    = (cur - s.entryPrice) / s.entryPrice;
    if (cur > s.peakPrice) s.peakPrice = cur;

    // Overnight fee: charge every 24h for stocks and commodities
    if (s.type === 'stock' || s.type === 'commodity') {
      const hoursSinceCheck = (Date.now() - s.lastOvernightCheck) / 3600000;
      if (hoursSinceCheck >= 24) {
        const fee = WORKING_CAPITAL * OVERNIGHT_FEE;
        s.overnightFees = (s.overnightFees || 0) + fee;
        s.lastOvernightCheck = Date.now();
        addLog(`[${s.label}/${s.strat}] 💸 Overnight fee -$${fee.toFixed(3)} (total fees: $${s.overnightFees.toFixed(3)})`);
      }
    }

    // ============ SAFE STRATEGY ============
    if (s.strat === 'safe') {

      // WIN: hit target
      if (cur >= s.targetPrice) {
        clearInterval(s.monitorInterval);
        closeTrade(key, 'target_hit', cur, netProfit(TARGET), true, elapsed);
        return;
      }

      // Patience timer logic (only after grace period)
      if (elapsed > GRACE_MS) {
        if (move <= -PATIENCE_DROP) {
          // Price is below -1%
          if (!s.belowDropSince) {
            // Just crossed below — start patience timer
            s.belowDropSince = Date.now();
            addLog(`[${s.label}/safe] ⚠️ Dropped -0.6% @ ${cur.toFixed(4)} — 24h patience timer started`);
            s.patienceTimeoutId = setTimeout(() => {
              if (!s.tradeActive) return;
              // Still below after 24h → cashout
              clearInterval(s.monitorInterval);
              const c = prices[s.id];
              const m = (c - s.entryPrice) / s.entryPrice;
              const profit = -(WORKING_CAPITAL * Math.abs(m)) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
              closeTrade(key, 'patience_exhausted', c, profit, false, Date.now() - s.tradeStartTime);
            }, PATIENCE_MS);
          }
          // else: already timing, keep waiting
        } else {
          // Price recovered above -1% → reset patience timer
          if (s.belowDropSince) {
            s.belowDropSince = null;
            if (s.patienceTimeoutId) { clearTimeout(s.patienceTimeoutId); s.patienceTimeoutId = null; }
            addLog(`[${s.label}/safe] 🔄 Recovered above -0.6% — patience timer reset`);
          }
        }
      }

    // ============ WAVE STRATEGY ============
    } else {
      const aboveTarget = cur >= s.targetPrice;
      const peakMove    = (s.peakPrice - s.entryPrice) / s.entryPrice;
      const dropFromPeak = (s.peakPrice - cur) / s.peakPrice;

      // Cashout: above target and dropped 0.2% from peak
      if (aboveTarget && dropFromPeak >= WAVE_DROP) {
        clearInterval(s.monitorInterval);
        closeTrade(key, 'wave_cashout', cur, netProfit(peakMove - WAVE_DROP), true, elapsed);
        return;
      }
      // No separate trailing stop — patience timer at -0.6% handles exits
      // WAVE has no hard timeout — it waits indefinitely using same patience logic
      if (elapsed > GRACE_MS) {
        if (move <= -PATIENCE_DROP) {
          if (!s.belowDropSince) {
            s.belowDropSince = Date.now();
            s.patienceTimeoutId = setTimeout(() => {
              if (!s.tradeActive) return;
              clearInterval(s.monitorInterval);
              const c = prices[s.id];
              const m = (c - s.entryPrice) / s.entryPrice;
              const profit = -(WORKING_CAPITAL * Math.abs(m)) - (WORKING_CAPITAL * TRADE_FEE) - (WORKING_CAPITAL * SPREAD);
              closeTrade(key, 'patience_exhausted', c, profit, false, Date.now() - s.tradeStartTime);
            }, PATIENCE_MS);
          }
        } else {
          if (s.belowDropSince) {
            s.belowDropSince = null;
            if (s.patienceTimeoutId) { clearTimeout(s.patienceTimeoutId); s.patienceTimeoutId = null; }
          }
        }
      }
    }
  }, 2000);
}

// ================= BINANCE WS =================
function connectCryptoWS() {
  const streams = COINS.map(c => `${c}@trade`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  ws.on('open', () => addLog('🟢 Binance WS connected'));
  ws.on('message', data => {
    try {
      const json = JSON.parse(data);
      const id = json.stream.split('@')[0];
      const price = parseFloat(json.data.p);
      if (price > 0) { prices[id] = price; recordPrice(id, price); }
    } catch(e) {}
  });
  ws.on('close', () => { addLog('⚠️ Binance WS closed'); setTimeout(connectCryptoWS, 3000); });
  ws.on('error', () => ws.close());
}
connectCryptoWS();

// ================= FINNHUB WS (Stocks) =================
function connectStockWS() {
  if (FINNHUB_KEY === 'YOUR_FINNHUB_KEY_HERE') {
    addLog('⚠️ No Finnhub key — using Yahoo Finance polling');
    pollYahoo([...STOCKS, ...COMMODITIES]);
    return;
  }
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => {
    addLog('🟢 Finnhub WS connected');
    STOCKS.forEach(s => ws.send(JSON.stringify({ type:'subscribe', symbol: s })));
  });
  ws.on('message', data => {
    try {
      const json = JSON.parse(data);
      if (json.type === 'trade' && json.data) {
        json.data.forEach(t => { if (t.p > 0) { prices[t.s] = t.p; recordPrice(t.s, t.p); } });
      }
    } catch(e) {}
  });
  ws.on('close', () => { addLog('⚠️ Finnhub WS closed'); setTimeout(connectStockWS, 5000); });
  ws.on('error', () => ws.close());
  // Always poll commodities (not on Finnhub free tier)
  pollYahoo(COMMODITIES);
}

async function pollYahoo(symbols) {
  const poll = async () => {
    await Promise.all(symbols.map(async sym => {
      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`);
        const json = await res.json();
        const p = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (p && p > 0) { prices[sym] = p; recordPrice(sym, p); }
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
  ALL_ASSETS.forEach(({ id, type, label }) => {
    ['safe','wave'].forEach(strat => {
      const key = `${id}_${strat}`;
      const s = botState[key];
      const cumulative = [];
      let sum = 0;
      for (const t of s.trades) { sum += t.profitUsd; cumulative.push(parseFloat(sum.toFixed(4))); }

      // Patience timer progress for UI
      let patienceProgress = null;
      if (s.belowDropSince) {
        const elapsed = Date.now() - s.belowDropSince;
        patienceProgress = Math.min((elapsed / PATIENCE_MS) * 100, 100);
      }

      result[key] = {
        label, strat, type,
        totalProfit: parseFloat(s.totalProfit.toFixed(4)),
        totalTrades: s.totalTrades, totalWins: s.totalWins,
        winRate: s.totalTrades ? (s.totalWins / s.totalTrades) * 100 : 0,
        currentPrice: prices[id] || 0,
        tradeActive: s.tradeActive,
        marketOpen: s.type === 'commodity' ? isCommodityMarketOpen() : isMarketOpen(),
        patienceProgress,  // null or 0-100%
        belowDrop: s.belowDropSince !== null,
        trades: s.trades.slice(-30).reverse(),
        cumulative
      };
    });
  });
  res.json({ data: result, prices, marketOpen: isMarketOpen(), allAssets: ALL_ASSETS });
});

// Export endpoint — full JSON dump
app.get(['/api/export', '/crypto/api/export'], (req, res) => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    config: { WORKING_CAPITAL, TRADE_FEE, SPREAD, TARGET, PATIENCE_DROP, PATIENCE_MS, GRACE_MS, WAVE_DROP, VOLATILITY_MIN, SLIPPAGE, OVERNIGHT_FEE },
    summary: {},
    allTrades: []
  };
  ALL_ASSETS.forEach(({ id, label, type }) => {
    ['safe','wave'].forEach(strat => {
      const key = `${id}_${strat}`;
      const s = botState[key];
      exportData.summary[key] = {
        label, type, strat,
        totalProfit: parseFloat(s.totalProfit.toFixed(4)),
        totalTrades: s.totalTrades, totalWins: s.totalWins,
        winRate: s.totalTrades ? parseFloat(((s.totalWins/s.totalTrades)*100).toFixed(1)) : 0,
        avgProfit: s.totalTrades ? parseFloat((s.totalProfit/s.totalTrades).toFixed(4)) : 0,
      };
      s.trades.forEach(t => exportData.allTrades.push({ ...t, asset: label, type, strat }));
    });
  });
  exportData.allTrades.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.setHeader('Content-Disposition', `attachment; filename="trading_export_${new Date().toISOString().slice(0,10)}.json"`);
  res.json(exportData);
});

app.get(['/', '/crypto'], (req, res) => res.send(getDashboardHTML()));

// ================= DASHBOARD =================
function getDashboardHTML() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Arena</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#060608;--surface:#0d0d12;--border:#1a1a24;--text:#e8e8f0;--muted:#555566;
--safe:#00e5ff;--wave:#ff6b35;--win:#00ff9d;--loss:#ff3d6b;--gold:#ffd700;
--stock:#a78bfa;--crypto:#f59e0b;--commodity:#34d399;}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);font-family:'Space Mono',monospace;color:var(--text);min-height:100vh;}
.header{padding:1rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.6rem;}
.logo{font-family:'Syne',sans-serif;font-size:1.1rem;font-weight:800;}
.logo .c{color:var(--crypto);}.logo .s{color:var(--stock);}.logo .cm{color:var(--commodity);}
.hdr-right{display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;}
.live-dot{width:7px;height:7px;background:var(--win);border-radius:50%;display:inline-block;margin-right:4px;animation:pulse 1.5s infinite;}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.3)}}
.badge{font-size:0.58rem;border:1px solid #333;padding:0.18rem 0.5rem;border-radius:2px;color:var(--muted);}
.mkt-badge{font-size:0.58rem;padding:0.18rem 0.5rem;border-radius:2px;}
.mkt-badge.open{background:#00ff9d22;color:var(--win);border:1px solid var(--win);}
.mkt-badge.closed{background:#ff3d6b22;color:var(--loss);border:1px solid var(--loss);}
.export-btn{font-family:'Space Mono',monospace;font-size:0.58rem;padding:0.3rem 0.7rem;background:transparent;border:1px solid var(--gold);color:var(--gold);border-radius:3px;cursor:pointer;transition:all 0.2s;}
.export-btn:hover{background:var(--gold);color:#000;}
.section-bar{display:flex;border-bottom:2px solid var(--border);background:var(--surface);}
.section-btn{flex:1;padding:0.7rem 0.4rem;font-family:'Space Mono',monospace;font-size:0.65rem;font-weight:700;border:none;background:transparent;color:var(--muted);cursor:pointer;transition:all 0.2s;border-bottom:3px solid transparent;margin-bottom:-2px;}
.section-btn:hover{color:var(--text);}
.section-btn.active.leaderboard{color:var(--gold);border-bottom-color:var(--gold);}
.section-btn.active.crypto{color:var(--crypto);border-bottom-color:var(--crypto);}
.section-btn.active.stock{color:var(--stock);border-bottom-color:var(--stock);}
.section-btn.active.commodity{color:var(--commodity);border-bottom-color:var(--commodity);}
.tabs-bar{display:flex;overflow-x:auto;border-bottom:1px solid var(--border);background:#09090e;scrollbar-width:none;}
.tabs-bar::-webkit-scrollbar{display:none;}
.tab{padding:0.55rem 0.9rem;font-size:0.62rem;font-family:'Space Mono',monospace;cursor:pointer;border:none;background:transparent;color:var(--muted);border-bottom:2px solid transparent;transition:all 0.2s;white-space:nowrap;}
.tab:hover{color:var(--text);}.tab.active{color:var(--text);border-bottom-color:var(--safe);}
.section{display:none;}.section.active{display:block;}
.lb-wrap{padding:1rem 1.5rem;}
.lb-title{font-family:'Syne',sans-serif;font-size:0.85rem;font-weight:800;margin-bottom:0.7rem;}
.lb-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;margin-bottom:1.2rem;}
@media(max-width:560px){.lb-grid{grid-template-columns:1fr;}}
.lb-table{background:var(--surface);border:1px solid var(--border);border-radius:4px;overflow:hidden;}
.lb-table-title{padding:0.45rem 0.8rem;font-size:0.58rem;color:var(--muted);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:0.3rem;}
.strat-dot{width:5px;height:5px;border-radius:50%;display:inline-block;}
.lb-row{display:grid;grid-template-columns:1.2rem 3.5rem 1fr 1fr 1fr;align-items:center;padding:0.4rem 0.8rem;border-bottom:1px solid var(--border);font-size:0.58rem;gap:0.3rem;}
.lb-row:last-child{border-bottom:none;}
.lb-rank{color:var(--muted);font-size:0.52rem;}.lb-rank.gold{color:var(--gold);}.lb-rank.silver{color:#aaa;}.lb-rank.bronze{color:#cd7f32;}
.lb-coin{font-weight:700;font-size:0.62rem;}
.pos{color:var(--win);}.neg{color:var(--loss);}.mu{color:var(--muted);}
.divider{border:none;border-top:1px solid var(--border);margin:1rem 0;}
.asset-panel{display:none;padding:1rem 1.5rem;}.asset-panel.active{display:block;}
.asset-header{display:flex;align-items:center;gap:0.7rem;margin-bottom:0.8rem;flex-wrap:wrap;}
.asset-name{font-family:'Syne',sans-serif;font-size:1.3rem;font-weight:800;}
.asset-price{font-size:0.85rem;color:var(--muted);}
.strats-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;}
@media(max-width:600px){.strats-grid{grid-template-columns:1fr;}}
.strat-card{background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;}
.strat-header{padding:0.6rem 0.8rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:0.4rem;flex-wrap:wrap;}
.strat-label{font-size:0.62rem;font-weight:700;}.strat-label.safe{color:var(--safe);}.strat-label.wave{color:var(--wave);}
.strat-status{font-size:0.52rem;padding:0.1rem 0.4rem;border-radius:2px;}
.strat-status.active-trade{background:#00ff9d22;color:var(--win);border:1px solid var(--win);}
.strat-status.waiting{background:#ffffff11;color:var(--muted);}
.strat-status.paused{background:#ff3d6b22;color:var(--loss);border:1px solid var(--loss);}
.strat-status.patience{background:#ffd70022;color:var(--gold);border:1px solid var(--gold);}
.patience-bar-wrap{padding:0.3rem 0.8rem;border-bottom:1px solid var(--border);display:none;}
.patience-bar-wrap.visible{display:block;}
.patience-bar-label{font-size:0.48rem;color:var(--gold);margin-bottom:0.2rem;}
.patience-bar{height:3px;background:#333;border-radius:2px;overflow:hidden;}
.patience-bar-fill{height:100%;background:var(--gold);transition:width 0.5s;}
.stats-row{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border);}
.stat-box{padding:0.55rem 0.3rem;border-right:1px solid var(--border);text-align:center;}.stat-box:last-child{border-right:none;}
.stat-val{font-size:0.9rem;font-weight:700;}.stat-lbl{font-size:0.48rem;color:var(--muted);margin-top:0.1rem;}
.chart-wrap{height:90px;padding:0.4rem;}
.trades-wrap{max-height:160px;overflow-y:auto;}.trades-wrap::-webkit-scrollbar{width:2px;}.trades-wrap::-webkit-scrollbar-thumb{background:var(--border);}
table{width:100%;border-collapse:collapse;font-size:0.56rem;}
th{padding:0.3rem 0.45rem;color:var(--muted);text-align:left;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);}
td{padding:0.28rem 0.45rem;border-bottom:1px solid #0f0f18;}
.w{color:var(--win);}.l{color:var(--loss);}
.type-badge{font-size:0.44rem;padding:0.07rem 0.22rem;border-radius:2px;margin-left:0.2rem;vertical-align:middle;}
.type-badge.crypto{background:#f59e0b22;color:var(--crypto);border:1px solid var(--crypto);}
.type-badge.stock{background:#a78bfa22;color:var(--stock);border:1px solid var(--stock);}
.type-badge.commodity{background:#34d39922;color:var(--commodity);border:1px solid var(--commodity);}
.footer{text-align:center;font-size:0.48rem;color:var(--muted);padding:0.7rem;border-top:1px solid var(--border);margin-top:1rem;line-height:1.6;}
</style>
</head>
<body>
<div class="header">
  <div class="logo"><span class="c">₿</span> · <span class="s">📈</span> · <span class="cm">🥇</span> Trading Arena</div>
  <div class="hdr-right">
    <button class="export-btn" onclick="exportData()">⬇ Export JSON</button>
    <div id="marketBadge" class="mkt-badge closed">🔴 Market Closed</div>
    <div class="badge"><span class="live-dot"></span>24 ASSETS · LIVE</div>
  </div>
</div>

<div class="section-bar">
  <button class="section-btn active leaderboard" onclick="showSection('leaderboard')">🏆 Board</button>
  <button class="section-btn crypto" onclick="showSection('crypto')">₿ Crypto</button>
  <button class="section-btn stock" onclick="showSection('stock')">📈 Stocks</button>
  <button class="section-btn commodity" onclick="showSection('commodity')">🥇 Metals</button>
</div>

<!-- LEADERBOARD -->
<div id="section-leaderboard" class="section active">
  <div class="lb-wrap">
    <div class="lb-title" style="color:var(--crypto)">₿ Crypto</div>
    <div class="lb-grid">
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--safe)"></span>SAFE</div><div id="lb-crypto-safe"></div></div>
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--wave)"></span>WAVE</div><div id="lb-crypto-wave"></div></div>
    </div>
    <hr class="divider">
    <div class="lb-title" style="color:var(--stock)">📈 Stocks <span style="font-size:0.6rem;color:var(--muted);font-weight:400">(market hours only)</span></div>
    <div class="lb-grid">
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--safe)"></span>SAFE</div><div id="lb-stock-safe"></div></div>
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--wave)"></span>WAVE</div><div id="lb-stock-wave"></div></div>
    </div>
    <hr class="divider">
    <div class="lb-title" style="color:var(--commodity)">🥇 Commodities <span style="font-size:0.6rem;color:var(--muted);font-weight:400">(Gold, Silver, Oil, Gas)</span></div>
    <div class="lb-grid">
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--safe)"></span>SAFE</div><div id="lb-commodity-safe"></div></div>
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--wave)"></span>WAVE</div><div id="lb-commodity-wave"></div></div>
    </div>
    <hr class="divider">
    <div class="lb-title">🌍 Overall — All 24 Assets</div>
    <div class="lb-grid">
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--safe)"></span>SAFE</div><div id="lb-all-safe"></div></div>
      <div class="lb-table"><div class="lb-table-title"><span class="strat-dot" style="background:var(--wave)"></span>WAVE</div><div id="lb-all-wave"></div></div>
    </div>
  </div>
</div>

<!-- CRYPTO -->
<div id="section-crypto" class="section">
  <div class="tabs-bar" id="cryptoTabsBar"></div>
  <div id="cryptoPanels"></div>
</div>

<!-- STOCKS -->
<div id="section-stock" class="section">
  <div class="tabs-bar" id="stockTabsBar"></div>
  <div id="stockPanels"></div>
</div>

<!-- COMMODITIES -->
<div id="section-commodity" class="section">
  <div class="tabs-bar" id="commodityTabsBar"></div>
  <div id="commodityPanels"></div>
</div>

<div class="footer">
  Auto-refresh 10s · 0.4% target · Patience timer: -1% drop → 24h wait → cashout · 30min grace · WAVE: trailing stop 0.6% · wave drop 0.2%<br>
  Volatility filter: skips trades when market moves &lt;0.2% in 30min · $100/asset/strategy · 24 assets total<br>
  Stocks &amp; Commodities: Mon–Fri 9:30am–4pm ET · Tunisia brokers: AvaTrade · XTB · Interactive Brokers
</div>

<script>
const ALL_ASSETS = ${JSON.stringify(ALL_ASSETS)};
const COINS      = ${JSON.stringify(COINS)};
const STOCKS     = ${JSON.stringify(STOCKS)};
const COMMS      = ${JSON.stringify(COMMODITIES)};
const CLABELS    = ${JSON.stringify(COIN_LABELS)};
const SLABELS    = ${JSON.stringify(STOCK_LABELS)};
const COMLABELS  = ${JSON.stringify(COMMODITY_LABELS)};
const charts = {};

function buildTabs(ids, labels, tabBarId, panelsId, prefix, type) {
  const bar = document.getElementById(tabBarId);
  const wrap = document.getElementById(panelsId);
  ids.forEach((id, i) => {
    const lbl = labels[id];
    const btn = document.createElement('button');
    btn.className = 'tab'+(i===0?' active':'');
    btn.id = prefix+'tab-'+id;
    btn.textContent = lbl.length > 7 ? id : lbl;
    btn.onclick = () => showTab(prefix, id, ids);
    bar.appendChild(btn);
    const panel = document.createElement('div');
    panel.className = 'asset-panel'+(i===0?' active':'');
    panel.id = prefix+'panel-'+id;
    panel.innerHTML = buildPanel(id, lbl, type);
    wrap.appendChild(panel);
  });
}

function buildPanel(id, label, type) {
  const mktHtml = (type==='stock'||type==='commodity')
    ? \`<div id="mkt-\${id}" class="mkt-badge closed">🔴 Closed</div>\` : '';
  return \`
  <div class="asset-header">
    <div class="asset-name">\${label}</div>
    <div class="asset-price" id="price-\${id}">$---</div>
    \${mktHtml}
  </div>
  <div class="strats-grid">
    \${buildCard(id,'safe')}
    \${buildCard(id,'wave')}
  </div>\`;
}

function buildCard(id, strat) {
  const key = id+'_'+strat;
  const icon = strat==='safe'?'🛡':'🌊';
  const desc = strat==='safe'
    ? 'Target +0.4% · Patience -1% / 24h'
    : 'Ride wave · Exit on 0.2% drop from peak';
  return \`
  <div class="strat-card">
    <div class="strat-header">
      <div>
        <div class="strat-label \${strat}">\${icon} \${strat.toUpperCase()}</div>
        <div style="font-size:0.46rem;color:var(--muted);margin-top:0.1rem;">\${desc}</div>
      </div>
      <div class="strat-status waiting" id="status-\${key}">Waiting</div>
    </div>
    <div class="patience-bar-wrap" id="pbwrap-\${key}">
      <div class="patience-bar-label" id="pblabel-\${key}">⏳ Patience timer: 0%</div>
      <div class="patience-bar"><div class="patience-bar-fill" id="pbfill-\${key}" style="width:0%"></div></div>
    </div>
    <div class="stats-row">
      <div class="stat-box"><div class="stat-val" id="profit-\${key}">$0.00</div><div class="stat-lbl">PROFIT</div></div>
      <div class="stat-box"><div class="stat-val" id="wr-\${key}">0%</div><div class="stat-lbl">WIN RATE</div></div>
      <div class="stat-box"><div class="stat-val" id="tr-\${key}">0</div><div class="stat-lbl">TRADES</div></div>
    </div>
    <div class="chart-wrap"><canvas id="chart-\${key}"></canvas></div>
    <div class="trades-wrap">
      <table><thead><tr><th>Time</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Reason</th></tr></thead>
      <tbody id="tbody-\${key}"></tbody></table>
    </div>
  </div>\`;
}

buildTabs(COINS,  CLABELS,   'cryptoTabsBar',    'cryptoPanels',    'c', 'crypto');
buildTabs(STOCKS, SLABELS,   'stockTabsBar',     'stockPanels',     's', 'stock');
buildTabs(COMMS,  COMLABELS, 'commodityTabsBar', 'commodityPanels', 'm', 'commodity');

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
  if (!p) return '$---';
  if (p < 0.01) return '$'+p.toFixed(6);
  if (p < 1)    return '$'+p.toFixed(4);
  if (p < 100)  return '$'+p.toFixed(3);
  return '$'+p.toFixed(2);
}

function updateCard(key, d) {
  const pe = document.getElementById('profit-'+key);
  if (pe) { pe.textContent=(d.totalProfit>=0?'+':'')+'$'+d.totalProfit.toFixed(2); pe.className='stat-val '+(d.totalProfit>=0?'pos':'neg'); }
  const we = document.getElementById('wr-'+key); if (we) we.textContent=d.winRate.toFixed(1)+'%';
  const te = document.getElementById('tr-'+key); if (te) te.textContent=d.totalTrades;

  const se = document.getElementById('status-'+key);
  if (se) {
    if ((d.type==='stock'||d.type==='commodity') && !d.marketOpen) {
      se.textContent='Market Closed'; se.className='strat-status paused';
    } else if (d.tradeActive && d.belowDrop) {
      se.textContent='⏳ Patience...'; se.className='strat-status patience';
    } else if (d.tradeActive) {
      se.textContent='IN TRADE'; se.className='strat-status active-trade';
    } else {
      se.textContent='Waiting'; se.className='strat-status waiting';
    }
  }

  // Patience progress bar
  const pbwrap = document.getElementById('pbwrap-'+key);
  const pbfill = document.getElementById('pbfill-'+key);
  const pblabel = document.getElementById('pblabel-'+key);
  if (pbwrap) {
    if (d.patienceProgress !== null) {
      pbwrap.classList.add('visible');
      pbfill.style.width = d.patienceProgress.toFixed(1)+'%';
      pblabel.textContent = \`⏳ Patience timer: \${d.patienceProgress.toFixed(1)}% of 24h\`;
    } else {
      pbwrap.classList.remove('visible');
    }
  }

  const canvas = document.getElementById('chart-'+key);
  if (canvas) {
    if (charts[key]) charts[key].destroy();
    const color = key.endsWith('safe') ? '#00e5ff' : '#ff6b35';
    charts[key] = new Chart(canvas.getContext('2d'), {
      type:'line',
      data:{ labels:d.cumulative.map((_,i)=>i+1), datasets:[{data:d.cumulative,borderColor:color,backgroundColor:color+'22',fill:true,tension:0.3,pointRadius:0,borderWidth:1.5}] },
      options:{ responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
        scales:{ x:{display:false}, y:{display:true,ticks:{color:'#555566',font:{size:7},callback:v=>'$'+v.toFixed(2)},grid:{color:'#1a1a24'}} } }
    });
  }

  const tbody = document.getElementById('tbody-'+key);
  if (tbody) {
    tbody.innerHTML = '';
    for (const t of d.trades) {
      const tr = tbody.insertRow();
      tr.insertCell(0).textContent = new Date(t.timestamp).toLocaleTimeString();
      tr.insertCell(1).textContent = fmtPrice(t.entryPrice);
      tr.insertCell(2).textContent = fmtPrice(t.exitPrice);
      const p = tr.insertCell(3);
      p.innerHTML = \`<span class="\${t.win?'w':'l'}">\${t.win?'+':'-'}\$\${Math.abs(t.profitUsd).toFixed(3)}</span>\`;
      tr.insertCell(4).textContent = t.exitReason;
    }
  }
}

function buildLB(elId, entries) {
  const el = document.getElementById(elId); if (!el) return;
  el.innerHTML = entries.map((e,i) => {
    const rc = i===0?'gold':i===1?'silver':i===2?'bronze':'';
    const ri = i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1);
    const icon = e.type==='crypto'?'₿':e.type==='stock'?'📈':'🥇';
    return \`<div class="lb-row">
      <div class="lb-rank \${rc}">\${ri}</div>
      <div class="lb-coin">\${e.coin}<span class="type-badge \${e.type}">\${icon}</span></div>
      <div class="\${e.profit>=0?'pos':'neg'}">\${e.profit>=0?'+':''}\$\${e.profit.toFixed(2)}</div>
      <div class="mu">\${e.winRate.toFixed(0)}%</div>
      <div class="mu">\${e.trades}T</div>
    </div>\`;
  }).join('');
}

async function fetchData() {
  try {
    const res = await fetch('/crypto/api/stats');
    const json = await res.json();
    const data = json.data;

    const mb = document.getElementById('marketBadge');
    if (mb) { mb.textContent=json.marketOpen?'🟢 Market Open':'🔴 Market Closed'; mb.className='mkt-badge '+(json.marketOpen?'open':'closed'); }

    // Update all asset panels
    json.allAssets.forEach(({id, type}) => {
      const priceEl = document.getElementById('price-'+id);
      if (priceEl) priceEl.textContent = fmtPrice(json.prices[id]);
      const mktEl = document.getElementById('mkt-'+id);
      if (mktEl) { mktEl.textContent=json.marketOpen?'🟢 Open':'🔴 Closed'; mktEl.className='mkt-badge '+(json.marketOpen?'open':'closed'); }
      ['safe','wave'].forEach(strat => {
        const key = id+'_'+strat;
        if (data[key]) updateCard(key, data[key]);
      });
    });

    // Build all leaderboards
    ['safe','wave'].forEach(strat => {
      const make = (ids, labelMap, type) => ids.map(id => ({
        coin: labelMap[id], profit: data[id+'_'+strat]?.totalProfit||0,
        winRate: data[id+'_'+strat]?.winRate||0, trades: data[id+'_'+strat]?.totalTrades||0, type
      })).sort((a,b)=>b.profit-a.profit);

      const cE = make(COINS, ${JSON.stringify(COIN_LABELS)}, 'crypto');
      const sE = make(STOCKS, ${JSON.stringify(STOCK_LABELS)}, 'stock');
      const mE = make(COMMS, ${JSON.stringify(COMMODITY_LABELS)}, 'commodity');

      buildLB('lb-crypto-'+strat, cE);
      buildLB('lb-stock-'+strat, sE);
      buildLB('lb-commodity-'+strat, mE);
      buildLB('lb-all-'+strat, [...cE,...sE,...mE].sort((a,b)=>b.profit-a.profit));
    });
  } catch(e) { console.error(e); }
}

async function exportData() {
  try {
    const res = await fetch('/crypto/api/export');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'trading_export_'+new Date().toISOString().slice(0,10)+'.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch(e) { alert('Export failed: '+e.message); }
}

fetchData();
setInterval(fetchData, 10000);
</script>
</body>
</html>`; }

app.listen(3000, () => addLog('🚀 Dashboard on port 3000'));

setTimeout(() => {
  ALL_ASSETS.forEach(({ id }) => {
    ['safe','wave'].forEach(strat => {
      setTimeout(() => startTrade(`${id}_${strat}`), Math.random() * 15000);
    });
  });
}, 5000);