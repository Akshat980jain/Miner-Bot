"use strict";

const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock, GoalFollow, GoalNear } = goals;
const autoeat = require("mineflayer-auto-eat").plugin;
const toolPlugin = require("mineflayer-tool").plugin;
const collectBlockPlugin = require("mineflayer-collectblock").plugin;
const express = require("express");
const http = require("http");
const https = require("https");
const { Vec3 } = require("vec3");

const config = require("./settings.json");
const { addLog, getLogs } = require("./logger");
const SafetyManager = require("./safety");
const MinerManager = require("./miner");
const SwarmManager = require("./swarm");

// ============================================================
// STATE TRACKING
// ============================================================
let bot = null;
let safety = null;
let miner = null;
let swarm = null;
let isReconnecting = false;
let reconnectTimeoutId = null;

const botState = {
  connected: false,
  startTime: Date.now(),
  reconnectAttempts: 0,
  currentAction: "Idle",
  coords: { x: 0, y: 0, z: 0 },
  health: 20,
  food: 20
};

// ============================================================
// EXPRESS WEB DASHBOARD & INTERACTION PAGE
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

app.get("/ping", (req, res) => res.json({ status: "alive", time: Date.now() }));
app.get("/logs", (req, res) => res.json(getLogs()));

app.get("/api/bot/position", (req, res) => {
  if (bot && bot.entity) {
    const p = bot.entity.position.floored();
    return res.json({ x: p.x, y: p.y, z: p.z });
  }
  res.json({ x: 0, y: 64, z: 0 });
});

app.get("/api/mission/status", (req, res) => {
  const minerStats = miner ? miner.stats : {};
  const currentState = miner ? miner.state : "IDLE";
  const mission = miner ? miner.currentMission : null;
  const timeRemaining = miner && miner.missionEndTime ? Math.max(0, Math.floor((miner.missionEndTime - Date.now()) / 1000)) : null;

  res.json({
    connected: botState.connected,
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position.floored() : botState.coords,
    health: bot ? bot.health : 0,
    food: bot ? bot.food : 0,
    state: currentState,
    stats: minerStats,
    mission,
    timeRemaining
  });
});

app.post("/api/mission/start", (req, res) => {
  if (!miner || !bot || !botState.connected) {
    return res.json({ success: false, message: "Bot is not connected to server." });
  }

  const {
    mineCoords,
    chestCoords,
    durationMode = "continuous",
    durationMinutes = 30,
    distanceLength = 50,
    strategy = "strip_mine",
    direction = "north"
  } = req.body;

  if (!mineCoords || !chestCoords) {
    return res.json({ success: false, message: "Missing mining or chest coordinates." });
  }

  addLog(`[Mission API] Starting mission with Strategy: ${strategy}, Duration: ${durationMode}`, "Miner");

  miner.startAutonomousMission({
    mineCoords,
    chestCoords,
    durationMode,
    durationMinutes: Number(durationMinutes) || 30,
    distanceLength: Number(distanceLength) || 50,
    strategy,
    direction
  });

  res.json({ success: true, message: "Autonomous mission launched!" });
});

app.post("/api/mission/stop", (req, res) => {
  if (!miner) return res.json({ success: false });
  miner.stop("Stop requested from Interaction Dashboard");
  res.json({ success: true, message: "Mission stopped." });
});

// ============================================================
// SWARM API ENDPOINTS
// ============================================================
app.get("/api/swarm/status", (req, res) => {
  if (swarm) return res.json(swarm.getSwarmStatus());
  res.json([]);
});

app.post("/api/swarm/spawn", async (req, res) => {
  const count = parseInt(req.body.count, 10) || 3;
  if (swarm) await swarm.spawnSwarm(count);
  res.json({ success: true, message: `Spawning ${count} bots...` });
});

app.post("/api/swarm/mission", async (req, res) => {
  if (swarm) await swarm.startSwarmMission(req.body);
  res.json({ success: true, message: `Swarm mission dispatched!` });
});

app.post("/api/swarm/stop", (req, res) => {
  if (swarm) swarm.stopSwarm("Stopped via web dashboard");
  res.json({ success: true, message: `Swarm stopped!` });
});

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.name || "Miner Bot"} Dashboard & Mission Control</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0e17;
      --card-bg: rgba(18, 25, 41, 0.75);
      --border: rgba(255, 255, 255, 0.08);
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.25);
      --accent-purple: #a855f7;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Outfit', sans-serif;
      background: radial-gradient(circle at 15% 15%, #131d31 0%, var(--bg) 95%);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    .container { max-width: 1240px; margin: 0 auto; }
    
    header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border);
    }
    .logo {
      font-size: 26px; font-weight: 800;
      background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .nav-tabs { display: flex; gap: 8px; }
    .tab-btn {
      background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-muted);
      padding: 8px 18px; border-radius: 10px; font-weight: 700; cursor: pointer; transition: all 0.2s;
    }
    .tab-btn.active, .tab-btn:hover { background: var(--accent); color: #000; box-shadow: 0 0 12px var(--accent-glow); }
    
    .status-badge {
      display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 9999px;
      font-weight: 600; font-size: 14px; background: rgba(0,0,0,0.5); border: 1px solid var(--border);
    }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); }
    .status-dot.online { background: var(--success); box-shadow: 0 0 10px var(--success); }

    .tab-content { display: none; }
    .tab-content.active { display: block; }
    
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
    @media (max-width: 900px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }

    .card {
      background: var(--card-bg); backdrop-filter: blur(16px); border: 1px solid var(--border);
      border-radius: 16px; padding: 22px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); margin-bottom: 20px;
    }
    .card h2 { font-size: 18px; margin-bottom: 16px; color: var(--accent); font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .card h3 { font-size: 14px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; margin: 14px 0 8px; }

    .input-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
    .coord-field label { font-size: 12px; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 4px; }
    .input-text {
      width: 100%; background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 8px;
      padding: 10px 12px; color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 15px; font-weight: 600;
    }
    .input-text:focus { outline: none; border-color: var(--accent); }
    
    .btn-pos {
      background: rgba(56, 189, 248, 0.1); border: 1px dashed var(--accent); color: var(--accent);
      padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer;
      width: 100%; margin-top: 4px; transition: all 0.2s;
    }
    .btn-pos:hover { background: var(--accent); color: #000; }

    .radio-pill-group { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 8px; }
    .radio-pill {
      background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 10px; padding: 10px;
      cursor: pointer; text-align: center; font-weight: 600; font-size: 13px; transition: all 0.2s;
    }
    .radio-pill.selected { border-color: var(--accent); background: rgba(56, 189, 248, 0.15); color: var(--accent); }

    .action-banner {
      display: flex; gap: 12px; margin-top: 20px; padding: 18px; border-radius: 14px;
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.1), rgba(168, 85, 247, 0.1));
      border: 1px solid rgba(56, 189, 248, 0.3); align-items: center; justify-content: space-between;
    }
    
    button.btn-launch {
      background: linear-gradient(135deg, #38bdf8, #818cf8); border: none; color: #000;
      padding: 14px 28px; border-radius: 10px; font-weight: 800; font-size: 15px; cursor: pointer;
      box-shadow: 0 0 20px var(--accent-glow); transition: all 0.2s;
    }
    button.btn-launch:hover { transform: scale(1.02); filter: brightness(1.1); }
    button.btn-abort {
      background: rgba(239, 68, 68, 0.15); border: 1px solid var(--danger); color: var(--danger);
      padding: 14px 24px; border-radius: 10px; font-weight: 700; font-size: 14px; cursor: pointer;
    }
    button.btn-abort:hover { background: var(--danger); color: #fff; }

    .hud-box {
      background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 12px; padding: 16px;
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
    }
    .hud-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; }
    .hud-val { font-size: 20px; font-weight: 800; font-family: 'JetBrains Mono', monospace; }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
    .stat-box { background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 10px; padding: 12px; text-align: center; }
    .stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; }
    .stat-val { font-size: 20px; font-weight: 800; margin-top: 4px; font-family: 'JetBrains Mono', monospace; }

    .terminal {
      background: #05070d; border: 1px solid var(--border); border-radius: 12px; height: 300px;
      overflow-y: auto; padding: 14px; font-family: 'JetBrains Mono', monospace; font-size: 13px;
      line-height: 1.5; color: #a6adbb; display: flex; flex-direction: column-reverse;
    }
    .log-line { margin-bottom: 4px; word-break: break-all; }
    .log-General { color: #94a3b8; }
    .log-Miner { color: #38bdf8; font-weight: 600; }
    .log-Safety { color: #f59e0b; }
    .log-Inventory { color: #10b981; }
    .log-Console { color: #c084fc; }

    .cmd-bar { display: flex; gap: 10px; margin-top: 12px; }
    .cmd-input {
      flex: 1; background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 10px;
      padding: 12px 16px; color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 14px;
    }
    .cmd-input:focus { outline: none; border-color: var(--accent); }
    .cmd-btn {
      background: var(--accent); color: #000; border: none; padding: 12px 20px; border-radius: 10px;
      font-weight: 700; cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <div class="logo">⛏️ ${config.name || "Minecraft Miner Bot"}</div>
        <p style="color: var(--text-muted); font-size: 13px; margin-top: 4px;">Server: <b>${config.server.ip}:${config.server.port}</b> (${config.server.version || "Auto"})</p>
      </div>
      <div style="display: flex; align-items: center; gap: 14px;">
        <div class="nav-tabs">
          <button class="tab-btn active" onclick="switchTab('interaction')">🚀 Mission Control</button>
          <button class="tab-btn" onclick="switchTab('overview')">📊 Stats & Console</button>
        </div>
        <div class="status-badge">
          <div id="statusDot" class="status-dot"></div>
          <span id="statusText">Connecting...</span>
        </div>
      </div>
    </header>

    <!-- ============================================================ -->
    <!-- TAB 1: INTERACTION & COORDINATE MISSION PAGE                 -->
    <!-- ============================================================ -->
    <div id="tab-interaction" class="tab-content active">
      <div class="grid-2">
        
        <!-- 1. MINING SITE COORDINATES -->
        <div class="card">
          <h2>📍 1. Mining Destination Coordinates</h2>
          <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px;">Where the bot will travel to begin mining.</p>
          <div class="input-row">
            <div class="coord-field"><label>X Coordinate</label><input id="mineX" class="input-text" type="number" value="100"></div>
            <div class="coord-field"><label>Y Coordinate (Level)</label><input id="mineY" class="input-text" type="number" value="-58"></div>
            <div class="coord-field"><label>Z Coordinate</label><input id="mineZ" class="input-text" type="number" value="200"></div>
          </div>
          <button class="btn-pos" onclick="fillCurrentPos('mine')">📌 Use Current Bot Position</button>

          <h3>Mining Strategy</h3>
          <div class="radio-pill-group">
            <div id="strat-strip" class="radio-pill selected" onclick="selectStrategy('strip_mine')">⛏️ Strip Mine 1x2</div>
            <div id="strat-ore" class="radio-pill" onclick="selectStrategy('ore_hunter')">💎 Ore Hunter (32r)</div>
            <div id="strat-tree" class="radio-pill" onclick="selectStrategy('tree_chopper')">🪵 Tree Chopper</div>
          </div>

          <div id="directionGroup" style="margin-top: 12px;">
            <h3>Mining Direction</h3>
            <div class="radio-pill-group">
              <div id="dir-north" class="radio-pill selected" onclick="selectDirection('north')">North (-Z)</div>
              <div id="dir-south" class="radio-pill" onclick="selectDirection('south')">South (+Z)</div>
              <div id="dir-east" class="radio-pill" onclick="selectDirection('east')">East (+X)</div>
              <div id="dir-west" class="radio-pill" onclick="selectDirection('west')">West (-X)</div>
            </div>
          </div>
        </div>

        <!-- 2. DEPOSIT CHEST COORDINATES & DURATION -->
        <div class="card">
          <h2>📦 2. Deposit Chest & Sorting Coordinates</h2>
          <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px;">Where the bot returns to deposit and sort ALL mined items.</p>
          <div class="input-row">
            <div class="coord-field"><label>Chest X</label><input id="chestX" class="input-text" type="number" value="0"></div>
            <div class="coord-field"><label>Chest Y</label><input id="chestY" class="input-text" type="number" value="64"></div>
            <div class="coord-field"><label>Chest Z</label><input id="chestZ" class="input-text" type="number" value="0"></div>
          </div>
          <button class="btn-pos" onclick="fillCurrentPos('chest')">📌 Use Current Bot Position</button>

          <h3>⏳ Mining Duration Control</h3>
          <div class="radio-pill-group">
            <div id="dur-cont" class="radio-pill selected" onclick="selectDuration('continuous')">♾️ Continuous (24/7)</div>
            <div id="dur-30m" class="radio-pill" onclick="selectDuration('timed', 30)">⏱️ 30 Minutes</div>
            <div id="dur-60m" class="radio-pill" onclick="selectDuration('timed', 60)">⏱️ 1 Hour</div>
            <div id="dur-dist" class="radio-pill" onclick="selectDuration('distance', 100)">📏 100 Blocks</div>
          </div>
          <div id="customDurationBox" style="margin-top: 10px; display: none;">
            <input id="customMinutes" class="input-text" type="number" placeholder="Custom Minutes (e.g. 45)" value="30">
          </div>

          <div style="margin-top: 14px; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 8px; font-size: 13px; color: var(--success); display: flex; align-items: center; gap: 8px;">
            <span>✨</span> <b>Universal Collector Active:</b> Bot will collect 100% of broken blocks and sort them into the chest.
          </div>
        </div>

      </div>

      <!-- MISSION ACTION BAR -->
      <div class="action-banner">
        <div>
          <div style="font-weight: 800; font-size: 18px; color: #fff;">Autonomous Round-Trip Mining Engine</div>
          <div style="font-size: 13px; color: var(--text-muted);">Bot will navigate to mining coords ➔ Harvest ALL items ➔ Auto-return to chest when full ➔ Sort and resume.</div>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="btn-launch" onclick="launchMission()">🚀 Launch Autonomous Mission</button>
          <button class="btn-abort" onclick="abortMission()">🛑 Stop & Return to Chest</button>
        </div>
      </div>

      <!-- LIVE MISSION HUD -->
      <div class="card" style="margin-top: 20px;">
        <h2>🛰️ Live Mission HUD</h2>
        <div class="grid-3">
          <div class="hud-box">
            <div><div class="hud-label">Current State</div><div id="hudState" class="hud-val" style="color: var(--accent);">IDLE</div></div>
          </div>
          <div class="hud-box">
            <div><div class="hud-label">Bot Location</div><div id="hudCoords" class="hud-val" style="font-size: 17px;">X: 0 | Y: 0 | Z: 0</div></div>
          </div>
          <div class="hud-box">
            <div><div class="hud-label">Chest Deposit Trips</div><div id="hudTrips" class="hud-val" style="color: var(--success);">0 Completed</div></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- TAB 2: OVERVIEW STATS & LIVE CONSOLE                          -->
    <!-- ============================================================ -->
    <div id="tab-overview" class="tab-content">
      <div class="grid-2">
        <div class="card">
          <h2>💎 Total Items Collected & Sorted</h2>
          <div class="stats-grid">
            <div class="stat-box"><div class="stat-label">Diamonds</div><div id="statDiamonds" class="stat-val" style="color:#38bdf8;">0</div></div>
            <div class="stat-box"><div class="stat-label">Debris</div><div id="statDebris" class="stat-val" style="color:#d97706;">0</div></div>
            <div class="stat-box"><div class="stat-label">Iron</div><div id="statIron" class="stat-val" style="color:#cbd5e1;">0</div></div>
            <div class="stat-box"><div class="stat-label">Gold</div><div id="statGold" class="stat-val" style="color:#fbbf24;">0</div></div>
            <div class="stat-box"><div class="stat-label">Lapis</div><div id="statLapis" class="stat-val" style="color:#60a5fa;">0</div></div>
            <div class="stat-box"><div class="stat-label">Redstone</div><div id="statRedstone" class="stat-val" style="color:#ef4444;">0</div></div>
            <div class="stat-box"><div class="stat-label">Coal</div><div id="statCoal" class="stat-val" style="color:#6b7280;">0</div></div>
            <div class="stat-box"><div class="stat-label">Deepslate</div><div id="statDeepslate" class="stat-val" style="color:#94a3b8;">0</div></div>
            <div class="stat-box"><div class="stat-label">Stone</div><div id="statStone" class="stat-val" style="color:#a8a29e;">0</div></div>
            <div class="stat-box"><div class="stat-label">Wood / Logs</div><div id="statWood" class="stat-val" style="color:#b45309;">0</div></div>
            <div class="stat-box" style="grid-column: span 2;"><div class="stat-label">Total Blocks Mined</div><div id="statTotal" class="stat-val" style="color:#a855f7;">0</div></div>
          </div>
        </div>

        <div class="card">
          <h2>🧭 Bot Vitals</h2>
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <div class="hud-box"><div><div class="hud-label">Health</div><div id="botHealth" class="hud-val" style="color: #ef4444;">20/20</div></div></div>
            <div class="hud-box"><div><div class="hud-label">Food Level</div><div id="botFood" class="hud-val" style="color: #f59e0b;">20/20</div></div></div>
            <div class="hud-box"><div><div class="hud-label">Uptime</div><div id="botUptime" class="hud-val">0s</div></div></div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>📜 Live Console & In-Game Chat</h2>
        <div id="terminal" class="terminal"></div>
        <div class="cmd-bar">
          <input id="cmdInput" class="cmd-input" type="text" placeholder="Type command (e.g. !stop, !coords, !stats, or in-game chat)..." onkeydown="if(event.key==='Enter') executeCommand()">
          <button class="cmd-btn" onclick="executeCommand()">Send</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let selectedStrategy = 'strip_mine';
    let selectedDirection = 'north';
    let selectedDurationMode = 'continuous';
    let durationValue = 30;

    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      if (tab === 'interaction') {
        document.querySelector('.tab-btn:nth-child(1)').classList.add('active');
        document.getElementById('tab-interaction').classList.add('active');
      } else {
        document.querySelector('.tab-btn:nth-child(2)').classList.add('active');
        document.getElementById('tab-overview').classList.add('active');
      }
    }

    function selectStrategy(strat) {
      selectedStrategy = strat;
      document.querySelectorAll('#strat-strip, #strat-ore, #strat-tree').forEach(e => e.classList.remove('selected'));
      if (strat === 'strip_mine') document.getElementById('strat-strip').classList.add('selected');
      if (strat === 'ore_hunter') document.getElementById('strat-ore').classList.add('selected');
      if (strat === 'tree_chopper') document.getElementById('strat-tree').classList.add('selected');
    }

    function selectDirection(dir) {
      selectedDirection = dir;
      document.querySelectorAll('#dir-north, #dir-south, #dir-east, #dir-west').forEach(e => e.classList.remove('selected'));
      document.getElementById('dir-' + dir).classList.add('selected');
    }

    function selectDuration(mode, val) {
      selectedDurationMode = mode;
      durationValue = val || 30;
      document.querySelectorAll('#dur-cont, #dur-30m, #dur-60m, #dur-dist').forEach(e => e.classList.remove('selected'));
      
      if (mode === 'continuous') document.getElementById('dur-cont').classList.add('selected');
      if (mode === 'timed' && val === 30) document.getElementById('dur-30m').classList.add('selected');
      if (mode === 'timed' && val === 60) document.getElementById('dur-60m').classList.add('selected');
      if (mode === 'distance') document.getElementById('dur-dist').classList.add('selected');
    }

    async function fillCurrentPos(target) {
      try {
        const res = await fetch('/api/bot/position');
        const pos = await res.json();
        if (target === 'mine') {
          document.getElementById('mineX').value = pos.x;
          document.getElementById('mineY').value = pos.y;
          document.getElementById('mineZ').value = pos.z;
        } else {
          document.getElementById('chestX').value = pos.x;
          document.getElementById('chestY').value = pos.y;
          document.getElementById('chestZ').value = pos.z;
        }
      } catch (_) {}
    }

    async function launchMission() {
      const mineCoords = {
        x: parseInt(document.getElementById('mineX').value, 10),
        y: parseInt(document.getElementById('mineY').value, 10),
        z: parseInt(document.getElementById('mineZ').value, 10)
      };
      const chestCoords = {
        x: parseInt(document.getElementById('chestX').value, 10),
        y: parseInt(document.getElementById('chestY').value, 10),
        z: parseInt(document.getElementById('chestZ').value, 10)
      };

      const payload = {
        mineCoords,
        chestCoords,
        durationMode: selectedDurationMode,
        durationMinutes: durationValue,
        distanceLength: durationValue,
        strategy: selectedStrategy,
        direction: selectedDirection
      };

      const res = await fetch('/api/mission/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      alert(data.message || 'Mission dispatched!');
    }

    async function abortMission() {
      await fetch('/api/mission/stop', { method: 'POST' });
    }

    async function updateDashboard() {
      try {
        const res = await fetch('/api/mission/status');
        const data = await res.json();
        
        document.getElementById('statusDot').className = 'status-dot ' + (data.connected ? 'online' : '');
        document.getElementById('statusText').innerText = data.connected ? 'ONLINE' : 'OFFLINE';
        
        if (data.coords) {
          const locStr = 'X: ' + data.coords.x + ' | Y: ' + data.coords.y + ' | Z: ' + data.coords.z;
          document.getElementById('hudCoords').innerText = locStr;
        }
        document.getElementById('hudState').innerText = data.state || 'IDLE';
        document.getElementById('botHealth').innerText = data.health + '/20';
        document.getElementById('botFood').innerText = data.food + '/20';
        document.getElementById('botUptime').innerText = Math.floor(data.uptime / 60) + 'm ' + (data.uptime % 60) + 's';

        if (data.stats) {
          document.getElementById('statDiamonds').innerText = data.stats.diamonds || 0;
          document.getElementById('statDebris').innerText = data.stats.ancientDebris || 0;
          document.getElementById('statIron').innerText = data.stats.iron || 0;
          document.getElementById('statGold').innerText = data.stats.gold || 0;
          document.getElementById('statLapis').innerText = data.stats.lapis || 0;
          document.getElementById('statRedstone').innerText = data.stats.redstone || 0;
          document.getElementById('statCoal').innerText = data.stats.coal || 0;
          document.getElementById('statDeepslate').innerText = data.stats.deepslate || 0;
          document.getElementById('statStone').innerText = data.stats.stone || 0;
          document.getElementById('statWood').innerText = data.stats.wood || 0;
          document.getElementById('statTotal').innerText = data.stats.totalBlocksMined || 0;
          document.getElementById('hudTrips').innerText = (data.stats.chestTrips || 0) + ' Completed';
        }
      } catch (err) {}
    }

    async function updateLogs() {
      try {
        const res = await fetch('/logs');
        const logs = await res.json();
        const term = document.getElementById('terminal');
        term.innerHTML = logs.slice(-60).reverse().map(l => 
          '<div class="log-line log-' + l.category + '">[' + l.time + '] [' + l.category + '] ' + l.message + '</div>'
        ).join('');
      } catch (err) {}
    }

    async function executeCommand() {
      const input = document.getElementById('cmdInput');
      const cmd = input.value.trim();
      if (!cmd) return;
      input.value = '';

      if (bot && typeof bot.chat === 'function') {
        bot.chat(cmd);
      }
    }

    setInterval(updateDashboard, 1500);
    setInterval(updateLogs, 2000);
    updateDashboard();
    updateLogs();
  </script>
</body>
</html>
  `);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`HTTP Web Dashboard & Mission Control started on port ${server.address().port}`, "General");
});

// Self-ping to prevent cloud sleep
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL;
    const protocol = url.startsWith("https") ? https : http;
    protocol.get(`${url}/ping`, () => {}).on("error", () => {});
  }, 10 * 60 * 1000);
}

// ============================================================
// BOT CREATION & LIFECYCLE
// ============================================================
function createMinerBot() {
  if (isReconnecting) return;

  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (_) {}
    bot = null;
  }

  addLog(`Connecting Miner Bot to ${config.server.ip}:${config.server.port}...`, "General");

  const botVersion = config.server.version && config.server.version.trim() !== ""
    ? config.server.version
    : false;

  bot = mineflayer.createBot({
    username: config.bot.username || "Miner_Bot",
    password: config.bot.password || undefined,
    auth: config.bot.type || "offline",
    host: config.server.ip,
    port: config.server.port,
    version: botVersion,
    hideErrors: false,
    checkTimeoutInterval: 120000
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(autoeat);
  bot.loadPlugin(toolPlugin);
  bot.loadPlugin(collectBlockPlugin);

  safety = new SafetyManager(bot, config);
  miner = new MinerManager(bot, config, safety);

  bot.once("spawn", () => {
    botState.connected = true;
    if (!swarm) {
      swarm = new SwarmManager(config.server, addLog, () => {});
    }
    swarm.bots.set(1, { id: 1, username: "Miner_Bot", bot, miner, safety, connected: true });

    const mcData = require("minecraft-data")(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.canDig = true;
    defaultMove.allow1by1towers = false;
    defaultMove.liquidCost = 1000;
    defaultMove.fallDamageCost = 1000;
    bot.pathfinder.setMovements(defaultMove);

    safety.init();

    if (config.safety?.autoEat?.enabled && bot.autoEat) {
      bot.autoEat.options = {
        priority: "foodPoints",
        startAt: config.safety.autoEat.minFood || 14,
        bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish"]
      };
    }

    if (config.utils && config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
      const pass = config.utils["auto-auth"].password;
      setTimeout(() => {
        bot.chat(`/register ${pass} ${pass}`);
        bot.chat(`/login ${pass}`);
      }, 1500);
    }

    // Force Creative Mode Enforcer & Auto Tool Supply
    if (config.server?.tryCreative !== false) {
      setTimeout(() => {
        bot.chat("/gamemode creative");
        bot.chat("/give Miner_Bot netherite_pickaxe 1");
        bot.chat("/give Miner_Bot torch 64");
        bot.chat("/give Miner_Bot chest 64");
        addLog("[Gamemode] Switched to Creative Mode & equipped tools & chests.", "General");
      }, 2500);

      bot.on("game", () => {
        if (bot.game && bot.game.gameMode !== "creative") {
          bot.chat("/gamemode creative");
        }
      });

      bot.on("respawn", () => {
        setTimeout(() => bot.chat("/gamemode creative"), 1000);
      });

      setInterval(() => {
        if (bot && botState.connected && bot.game && bot.game.gameMode !== "creative") {
          bot.chat("/gamemode creative");
        }
      }, 20000);
    }
  });

  // Listen for player right-click / punch interactions safely
  let lastInteractTime = {};
  bot._client.on("animation", (packet) => {
    try {
      if (!bot || !bot.entity) return;
      const entity = bot.entities[packet.entityId];
      if (!entity || entity.type !== "player" || entity.username === bot.username) return;

      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist <= 3.5) {
        const now = Date.now();
        const last = lastInteractTime[entity.username] || 0;
        if (now - last > 3000) {
          lastInteractTime[entity.username] = now;
          bot.lookAt(entity.position.offset(0, 1.6, 0)).catch(() => {});
          sendInteractiveMenu(entity.username);
        }
      }
    } catch (_) {}
  });

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (config.utils && config.utils["chat-log"]) {
      addLog(`<${username}> ${message}`, "Chat");
    }

    if (message.startsWith("!")) {
      handleChatCommands(username, message);
    }
  });

  bot.on("error", (err) => {
    addLog(`[Bot Error] ${err.message}`, "General");
  });

  bot.on("kicked", (reason) => {
    addLog(`[Kicked] ${reason}`, "General");
  });

  bot.on("end", () => {
    botState.connected = false;
    addLog("[Disconnected] Connection closed.", "General");
    scheduleReconnect();
  });
}

let inGameMissionConfig = {
  mineCoords: { x: 100, y: -58, z: 200 },
  chestCoords: { x: 0, y: 64, z: 0 },
  durationMode: "continuous",
  durationMinutes: 30,
  distanceLength: 50,
  strategy: "strip_mine",
  direction: "north"
};

function sendInteractiveMenu(username) {
  const dashUrl = process.env.RENDER_EXTERNAL_URL || "https://miner-bot-5340.onrender.com";
  
  if (bot && typeof bot.chat === "function") {
    try {
      bot.chat(`⛏️ [Miner Bot] Hey ${username}!`);
      bot.chat(`🌐 Dashboard: ${dashUrl}`);
      bot.chat(`📍 Mine: (${inGameMissionConfig.mineCoords.x}, ${inGameMissionConfig.mineCoords.y}, ${inGameMissionConfig.mineCoords.z}) | 📦 Chest: (${inGameMissionConfig.chestCoords.x}, ${inGameMissionConfig.chestCoords.y}, ${inGameMissionConfig.chestCoords.z})`);
      bot.chat(`Commands: !setmine | !setchest | !start | !stop | !status`);
    } catch (_) {}
  }
}

function handleChatCommands(sender, message) {
  const parts = message.trim().split(/\s+/);
  const trigger = parts[0].toLowerCase();
  const player = bot.players[sender];
  const playerPos = player && player.entity ? player.entity.position.floored() : null;

  switch (trigger) {
    case "!menu":
    case "!panel":
    case "!gui":
    case "!help":
    case "!miner": {
      bot.chat(`⛏️ === [ MINER BOT IN-GAME MENU ] ===`);
      bot.chat(`📍 Mine: (${inGameMissionConfig.mineCoords.x}, ${inGameMissionConfig.mineCoords.y}, ${inGameMissionConfig.mineCoords.z}) | 📦 Chest: (${inGameMissionConfig.chestCoords.x}, ${inGameMissionConfig.chestCoords.y}, ${inGameMissionConfig.chestCoords.z})`);
      bot.chat(`⚙️ Strat: ${inGameMissionConfig.strategy} (${inGameMissionConfig.direction}) | ⏳ Dur: ${inGameMissionConfig.durationMode === "timed" ? inGameMissionConfig.durationMinutes + "m" : "24/7 Continuous"}`);
      bot.chat(`Commands: !setmine | !setchest | !strat <strip/ore/tree> | !dir <n/s/e/w> | !time <mins> | !start | !status | !stop`);
      break;
    }

    case "!setmine": {
      if (parts.length >= 4) {
        inGameMissionConfig.mineCoords = {
          x: parseInt(parts[1], 10),
          y: parseInt(parts[2], 10),
          z: parseInt(parts[3], 10)
        };
      } else if (playerPos) {
        inGameMissionConfig.mineCoords = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
      } else {
        bot.chat(`Cannot detect your position. Usage: !setmine <x> <y> <z>`);
        return;
      }
      bot.chat(`📍 Mining site set to: (${inGameMissionConfig.mineCoords.x}, ${inGameMissionConfig.mineCoords.y}, ${inGameMissionConfig.mineCoords.z})`);
      break;
    }

    case "!setchest": {
      if (parts.length >= 4) {
        inGameMissionConfig.chestCoords = {
          x: parseInt(parts[1], 10),
          y: parseInt(parts[2], 10),
          z: parseInt(parts[3], 10)
        };
      } else if (playerPos) {
        inGameMissionConfig.chestCoords = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
      } else {
        bot.chat(`Cannot detect your position. Usage: !setchest <x> <y> <z>`);
        return;
      }
      bot.chat(`📦 Deposit chest set to: (${inGameMissionConfig.chestCoords.x}, ${inGameMissionConfig.chestCoords.y}, ${inGameMissionConfig.chestCoords.z})`);
      break;
    }

    case "!strat":
    case "!strategy":
    case "!mode": {
      const mode = (parts[1] || "").toLowerCase();
      if (mode.includes("strip") || mode === "1") {
        inGameMissionConfig.strategy = "strip_mine";
      } else if (mode.includes("ore") || mode.includes("diamond") || mode === "2") {
        inGameMissionConfig.strategy = "ore_hunter";
      } else if (mode.includes("tree") || mode.includes("chop") || mode === "3") {
        inGameMissionConfig.strategy = "tree_chopper";
      } else {
        bot.chat("Usage: !strat strip | ore | tree");
        return;
      }
      bot.chat(`⚙️ Mining strategy set to: ${inGameMissionConfig.strategy}`);
      break;
    }

    case "!dir":
    case "!direction": {
      const d = (parts[1] || "").toLowerCase();
      if (d === "n" || d === "north") inGameMissionConfig.direction = "north";
      else if (d === "s" || d === "south") inGameMissionConfig.direction = "south";
      else if (d === "e" || d === "east") inGameMissionConfig.direction = "east";
      else if (d === "w" || d === "west") inGameMissionConfig.direction = "west";
      else {
        bot.chat("Usage: !dir north | south | east | west");
        return;
      }
      bot.chat(`🧭 Direction set to: ${inGameMissionConfig.direction.toUpperCase()}`);
      break;
    }

    case "!time":
    case "!duration": {
      const mins = parseInt(parts[1], 10);
      if (isNaN(mins) || mins <= 0) {
        inGameMissionConfig.durationMode = "continuous";
        bot.chat("⏳ Duration set to: ♾️ 24/7 Continuous Infinite Mode");
      } else {
        inGameMissionConfig.durationMode = "timed";
        inGameMissionConfig.durationMinutes = mins;
        bot.chat(`⏳ Duration set to: ⏱️ ${mins} Minutes`);
      }
      break;
    }

    case "!start":
    case "!launch":
    case "!go": {
      bot.chat(`🚀 Launching mission to (${inGameMissionConfig.mineCoords.x}, ${inGameMissionConfig.mineCoords.y}, ${inGameMissionConfig.mineCoords.z})! Chest: (${inGameMissionConfig.chestCoords.x}, ${inGameMissionConfig.chestCoords.y}, ${inGameMissionConfig.chestCoords.z})`);
      miner.startAutonomousMission(inGameMissionConfig);
      break;
    }

    case "!mission": {
      // Syntax: !mission <mineX> <mineY> <mineZ> <chestX> <chestY> <chestZ> [duration] [strategy] [direction] [size]
      if (parts.length < 7) {
        bot.chat("Usage: !mission <mineX> <mineY> <mineZ> <chestX> <chestY> <chestZ> [dur] [strat] [dir] [size]");
        return;
      }
      const mineCoords = { x: parseInt(parts[1], 10), y: parseInt(parts[2], 10), z: parseInt(parts[3], 10) };
      const chestCoords = { x: parseInt(parts[4], 10), y: parseInt(parts[5], 10), z: parseInt(parts[6], 10) };
      const durParam = (parts[7] || "0").toLowerCase();
      const strategy = parts[8] || inGameMissionConfig.strategy || "strip_mine";
      const direction = parts[9] || inGameMissionConfig.direction || "north";
      const size = parts[10] || inGameMissionConfig.size || "3x3";

      let durationMode = "continuous";
      let durationMinutes = 30;
      let distanceLength = 100;

      if (durParam.startsWith("dist:")) {
        durationMode = "distance";
        distanceLength = parseInt(durParam.replace("dist:", ""), 10) || 100;
      } else if (durParam.startsWith("time:")) {
        durationMode = "timed";
        durationMinutes = parseInt(durParam.replace("time:", ""), 10) || 30;
      } else {
        const parsed = parseInt(durParam, 10);
        if (!isNaN(parsed) && parsed > 0) {
          durationMode = "timed";
          durationMinutes = parsed;
        }
      }

      inGameMissionConfig.mineCoords = mineCoords;
      inGameMissionConfig.chestCoords = chestCoords;
      inGameMissionConfig.strategy = strategy;
      inGameMissionConfig.direction = direction;
      inGameMissionConfig.size = size;
      inGameMissionConfig.durationMode = durationMode;
      inGameMissionConfig.durationMinutes = durationMinutes;

      const durLabel = durationMode === "distance" ? `${distanceLength} Blocks` : (durationMode === "timed" ? `${durationMinutes} Mins` : "24/7 Infinite");
      bot.chat(`🚀 Starting ${size} ${strategy} (${direction.toUpperCase()}, ${durLabel}) at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z}) | Chest: (${chestCoords.x}, ${chestCoords.y}, ${chestCoords.z})`);
      miner.startAutonomousMission({
        mineCoords,
        chestCoords,
        durationMode,
        durationMinutes,
        distanceLength,
        strategy,
        direction,
        size
      });
      break;
    }

    case "!stop":
    case "!abort": {
      miner.stop(`Stopped by ${sender}`);
      const hasLoot = bot.inventory.items().some((item) => miner.getItemSortTier(item) > 0);
      if (hasLoot && inGameMissionConfig.chestCoords && inGameMissionConfig.chestCoords.x !== undefined) {
        bot.chat("🛑 Mining stopped. Returning to chest to safely deposit all collected loot...");
        miner.depositAndSortAllItems(inGameMissionConfig.chestCoords);
      } else {
        bot.chat("🛑 Mining mission stopped.");
      }
      break;
    }

    case "!deposit":
      bot.chat(`Returning to chest at (${inGameMissionConfig.chestCoords.x}, ${inGameMissionConfig.chestCoords.y}, ${inGameMissionConfig.chestCoords.z}) to deposit and sort items...`);
      miner.depositAndSortAllItems(inGameMissionConfig.chestCoords);
      break;

    case "!status":
    case "!hud":
    case "!stats": {
      const s = miner.stats;
      const pos = bot.entity.position.floored();
      bot.chat(`📊 State: ${miner.state} | Pos: X=${pos.x} Y=${pos.y} Z=${pos.z}`);
      bot.chat(`💎${s.diamonds} 🧱${s.ancientDebris} ⚙️${s.iron} 🪙${s.gold} 🪨${s.coal} | Total: ${s.totalBlocksMined} (Trips: ${s.chestTrips})`);
      break;
    }

    case "!coords": {
      const pos = bot.entity.position.floored();
      bot.chat(`Bot Position: X=${pos.x} Y=${pos.y} Z=${pos.z}`);
      break;
    }

    case "!come":
    case "!follow": {
      if (player && player.entity) {
        bot.chat(`Following ${sender}...`);
        bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);
      } else {
        bot.chat(`Cannot see ${sender} nearby.`);
      }
      break;
    }

    case "!spawn": {
      const count = parseInt(parts[1], 10) || 3;
      bot.chat(`🤖 Spawning Swarm Fleet of ${count} Miner Bots...`);
      if (!swarm) swarm = new SwarmManager(config.server, addLog, () => {});
      swarm.bots.set(1, { id: 1, username: "Miner_Bot", bot, miner, safety, connected: true });
      swarm.spawnSwarm(count);
      break;
    }

    case "!despawn": {
      const id = parseInt(parts[1], 10);
      if (swarm) {
        if (!isNaN(id)) {
          bot.chat(`🤖 Despawning Bot ${id}...`);
          swarm.despawnBot(id);
        } else {
          bot.chat(`🤖 Despawning all extra swarm bots...`);
          swarm.despawnSwarm(true);
        }
      }
      break;
    }

    case "!swarm": {
      // Syntax: !swarm <mineX> <mineY> <mineZ> <chestX> <chestY> <chestZ> [duration] [strategy] [direction] [size]
      if (parts.length < 7) {
        bot.chat("Usage: !swarm <mineX> <mineY> <mineZ> <chestX> <chestY> <chestZ> [dur] [strat] [dir] [size]");
        return;
      }
      const mineCoords = { x: parseInt(parts[1], 10), y: parseInt(parts[2], 10), z: parseInt(parts[3], 10) };
      const chestCoords = { x: parseInt(parts[4], 10), y: parseInt(parts[5], 10), z: parseInt(parts[6], 10) };
      const durParam = (parts[7] || "0").toLowerCase();
      const strategy = parts[8] || inGameMissionConfig.strategy || "strip_mine";
      const direction = parts[9] || inGameMissionConfig.direction || "north";
      const size = parts[10] || inGameMissionConfig.size || "3x3";

      let durationMode = "continuous";
      let durationMinutes = 30;
      let distanceLength = 100;

      if (durParam.startsWith("dist:")) {
        durationMode = "distance";
        distanceLength = parseInt(durParam.replace("dist:", ""), 10) || 100;
      } else if (durParam.startsWith("time:")) {
        durationMode = "timed";
        durationMinutes = parseInt(durParam.replace("time:", ""), 10) || 30;
      }

      if (!swarm) swarm = new SwarmManager(config.server, addLog, () => {});
      swarm.bots.set(1, { id: 1, username: "Miner_Bot", bot, miner, safety, connected: true });

      bot.chat(`🤖🚀 Launching Synchronized Swarm Fleet Mission across parallel lanes!`);
      swarm.startSwarmMission({
        mineCoords,
        chestCoords,
        durationMode,
        durationMinutes,
        distanceLength,
        strategy,
        direction,
        size
      });
      break;
    }

    case "!swarmstop": {
      bot.chat("🛑 Stopping entire swarm fleet. All bots returning to deposit chests...");
      if (swarm) swarm.stopSwarm(`Stopped by ${sender}`);
      break;
    }

    case "!bots":
    case "!swarmstatus": {
      if (!swarm) swarm = new SwarmManager(config.server, addLog, () => {});
      swarm.bots.set(1, { id: 1, username: "Miner_Bot", bot, miner, safety, connected: true });
      const activeBots = swarm.getSwarmStatus().filter((b) => b.connected);
      bot.chat(`🤖 Active Swarm Bots (${activeBots.length}/10): ` + activeBots.map((b) => `${b.username} [${b.state}]`).join(" | "));
      break;
    }

    case "!bot": {
      // Syntax: !bot <botName/id> <subcommand...>
      if (parts.length < 3) {
        bot.chat("Usage: !bot <name/id> <!mission / !stop / !deposit / !status>");
        return;
      }
      const targetIdentifier = parts[1];
      const subCommand = parts.slice(2).join(" ");
      if (!swarm) swarm = new SwarmManager(config.server, addLog, () => {});
      swarm.bots.set(1, { id: 1, username: "Miner_Bot", bot, miner, safety, connected: true });
      swarm.executeBotCommand(targetIdentifier, sender, subCommand);
      break;
    }
  }
}

function scheduleReconnect() {
  if (isReconnecting || !config.utils["auto-reconnect"]) return;
  isReconnecting = true;

  botState.reconnectAttempts++;
  const base = config.utils["auto-reconnect-delay"] || 3000;
  const max = config.utils["max-reconnect-delay"] || 30000;
  const delay = Math.min(base * Math.pow(1.5, botState.reconnectAttempts), max) + Math.floor(Math.random() * 2000);

  addLog(`Reconnecting in ${(delay / 1000).toFixed(1)}s (Attempt #${botState.reconnectAttempts})...`, "General");

  if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
  reconnectTimeoutId = setTimeout(() => {
    isReconnecting = false;
    createMinerBot();
  }, delay);
}

process.on("uncaughtException", (err) => {
  addLog(`[FATAL] Uncaught Exception: ${err.message}`, "General");
  if (!isReconnecting) scheduleReconnect();
});

process.on("unhandledRejection", (reason) => {
  addLog(`[FATAL] Unhandled Rejection: ${reason}`, "General");
});

// START
createMinerBot();
