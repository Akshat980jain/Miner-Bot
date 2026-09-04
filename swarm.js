const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const autoeat = require("mineflayer-auto-eat").plugin;
const toolPlugin = require("mineflayer-tool").plugin;
const collectBlockPlugin = require("mineflayer-collectblock").plugin;
const { Vec3 } = require("vec3");
const Miner = require("./miner");
const Safety = require("./safety");
const config = require("./settings.json");

class SwarmManager {
  constructor(serverConfig, addLogCallback, broadcastStateCallback) {
    this.serverConfig = serverConfig || config.server;
    this.addLog = addLogCallback || console.log;
    this.broadcastState = broadcastStateCallback || (() => {});
    this.bots = new Map(); // id (1..10) -> { bot, miner, safety, id, username, connected, connecting, reconnectAttempts }
    this.heartbeatTimers = new Map();
    this.reconnectQueue = [];
    this.isProcessingQueue = false;
    this.maxBots = 10;
    this.targetBots = (config.swarm && config.swarm.targetCount) ? config.swarm.targetCount : 10;
    this.supervisorInterval = null;
    this.isSupervisorRunning = false;
    this.staggerDelay = (config.swarm && config.swarm.staggerJoinDelay) ? config.swarm.staggerJoinDelay : 6000;
    this.authPassword = (config.swarm && config.swarm.autoAuthPassword) || (config.utils && config.utils["auto-auth"] && config.utils["auto-auth"].password) || "chalol78";
  }

  registerPrimaryBot(bot, miner, safety) {
    this.bots.set(1, {
      id: 1,
      username: (config.bot && config.bot.username) || "Miner_Bot",
      bot,
      miner,
      safety,
      connected: true,
      connecting: false,
      reconnectAttempts: 0
    });

    // Start 24/7 fleet supervisor watchdog
    this.startSupervisor();
  }

  getBotName(id) {
    if (id === 1) return (config.bot && config.bot.username) || "Miner_Bot";
    return `Miner_Bot_${id}`;
  }

  /**
   * Continuous 24/7 Fleet Supervisor Watchdog.
   * Periodically checks all bots 1..targetBots and recovers any dropped bots.
   */
  startSupervisor() {
    if (this.isSupervisorRunning) return;
    this.isSupervisorRunning = true;

    this.addLog("[Swarm Supervisor] 🛡️ 24/7 Fleet Watchdog started. Target fleet size: " + this.targetBots + " bots.", "Swarm");

    // Immediately trigger fleet spawn
    this.ensureAllBotsAlive();

    // Check fleet state every 12 seconds
    this.supervisorInterval = setInterval(() => {
      this.ensureAllBotsAlive();
    }, 12000);
  }

  stopSupervisor() {
    if (this.supervisorInterval) {
      clearInterval(this.supervisorInterval);
      this.supervisorInterval = null;
    }
    this.isSupervisorRunning = false;
  }

  /**
   * Reconciles fleet desired state: queues any offline bots for connection
   */
  ensureAllBotsAlive() {
    if (config.swarm && config.swarm.enabled === false) return;

    for (let id = 2; id <= this.targetBots; id++) {
      const entry = this.bots.get(id);
      const isConnected = entry && entry.connected && entry.bot && entry.bot.entity;
      const isConnecting = entry && entry.connecting;
      const isInQueue = this.reconnectQueue.includes(id);

      if (!isConnected && !isConnecting && !isInQueue) {
        this.enqueueReconnect(id, 1000);
      }
    }
  }

  /**
   * Spawns or scales the fleet up to the requested count (1..10)
   */
  async spawnSwarm(count = 10) {
    this.targetBots = Math.min(Math.max(parseInt(count, 10) || 10, 1), this.maxBots);
    this.addLog(`[Swarm] Adjusting fleet target to ${this.targetBots} bots...`, "Swarm");
    this.startSupervisor();
    this.ensureAllBotsAlive();
  }

  /**
   * Despawns a single swarm bot
   */
  despawnBot(id) {
    if (id <= 1 || id > this.maxBots) return;

    // Remove from reconnect queue
    const qIndex = this.reconnectQueue.indexOf(id);
    if (qIndex !== -1) {
      this.reconnectQueue.splice(qIndex, 1);
    }

    this.cleanUpBot(id);

    if (this.bots.has(id)) {
      const entry = this.bots.get(id);
      if (entry.bot) {
        try { entry.bot.quit("Despawned by command"); } catch (_) {}
      }
      this.bots.delete(id);
    }

    this.addLog(`[Swarm] Bot ${id} despawned cleanly.`, "Swarm");
    this.broadcastState();
  }

  /**
   * Despawns all extra swarm bots (keeps primary Bot 1 alive)
   */
  despawnSwarm(keepPrimary = true) {
    this.reconnectQueue = [];
    const startId = keepPrimary ? 2 : 1;
    for (let id = startId; id <= this.maxBots; id++) {
      this.despawnBot(id);
    }
    this.targetBots = keepPrimary ? 1 : 0;
    this.addLog(`[Swarm] All swarm worker bots despawned. Primary bot preserved.`, "Swarm");
  }

  /**
   * Connect all 10 bots sequentially
   */
  async startAllBots() {
    this.spawnSwarm(this.maxBots);
  }

  /**
   * Spawns a bot and awaits spawn handshake with timeout and error handling
   */
  spawnBotAndWait(id) {
    return new Promise((resolve, reject) => {
      let entry = this.bots.get(id);
      if (entry && entry.connected && entry.bot && entry.bot.entity) {
        return resolve(entry);
      }

      const username = this.getBotName(id);
      const host = this.serverConfig.ip || config.server.ip;
      const port = parseInt(this.serverConfig.port || config.server.port, 10);
      const version = this.serverConfig.version || config.server.version || "1.21.4";

      if (!entry) {
        entry = {
          id,
          username,
          bot: null,
          miner: null,
          safety: null,
          connected: false,
          connecting: true,
          reconnectAttempts: 0
        };
        this.bots.set(id, entry);
      } else {
        entry.connecting = true;
        entry.connected = false;
      }

      this.addLog(`[Swarm] 🔌 Connecting ${username} (${id}/10) to ${host}:${port}...`, "Swarm");

      let resolved = false;

      try {
        const bot = mineflayer.createBot({
          host: host,
          port: port,
          username: username,
          version: version,
          auth: "offline",
          checkTimeoutInterval: 120000,
          hideErrors: false
        });

        entry.bot = bot;

        if (bot._client) {
          bot._client.on("error", (err) => {
            this.addLog(`[Swarm] Socket notice (${username}): ${err.message}`, "Swarm");
          });
        }

        bot.loadPlugin(pathfinder);
        bot.loadPlugin(autoeat);
        bot.loadPlugin(toolPlugin);
        bot.loadPlugin(collectBlockPlugin);

        const safety = new Safety(bot, config);
        const miner = new Miner(bot, config, safety);

        entry.miner = miner;
        entry.safety = safety;

        // Smart Dual-Auth Chat Listener (handles /register and /login prompts)
        const handleAuthMessage = (msg) => {
          const text = (typeof msg === "string" ? msg : msg.toString()).toLowerCase();
          if (text.includes("/register") || text.includes("register with") || text.includes("register password")) {
            setTimeout(() => {
              try { bot.chat(`/register ${this.authPassword} ${this.authPassword}`); } catch (_) {}
            }, 800);
          } else if (text.includes("/login") || text.includes("please login") || text.includes("use /login")) {
            setTimeout(() => {
              try { bot.chat(`/login ${this.authPassword}`); } catch (_) {}
            }, 800);
          }
        };

        bot.on("message", handleAuthMessage);

        bot.once("spawn", () => {
          entry.connected = true;
          entry.connecting = false;
          entry.reconnectAttempts = 0;
          this.addLog(`[Swarm] ✅ ${username} spawned successfully into world!`, "Swarm");

          // Pathfinder movements initialization
          try {
            const mcData = require("minecraft-data")(bot.version);
            const defaultMove = new Movements(bot, mcData);
            defaultMove.allowFreeMotion = true;
            defaultMove.canDig = true;
            defaultMove.allow1by1towers = false;
            bot.pathfinder.setMovements(defaultMove);
          } catch (_) {}

          safety.init();

          // Dual-Action Auto-Auth sequence:
          // 1. Send /register in case bot is new
          // 2. Send /login in case bot is already registered
          setTimeout(() => {
            try {
              bot.chat(`/register ${this.authPassword} ${this.authPassword}`);
            } catch (_) {}
          }, 1200);

          setTimeout(() => {
            try {
              bot.chat(`/login ${this.authPassword}`);
            } catch (_) {}
          }, 2600);

          // Creative mode if server allows
          if (config.server?.tryCreative !== false) {
            setTimeout(() => {
              try { bot.chat("/gamemode creative"); } catch (_) {}
            }, 4500);
          }

          // 24/7 Anti-AFK Routine (Arm swing + Micro-rotation + Periodic sneak)
          if (this.heartbeatTimers.has(id)) clearInterval(this.heartbeatTimers.get(id));
          let afkTick = 0;
          const hb = setInterval(() => {
            if (bot && entry.connected && bot.entity) {
              try {
                afkTick++;
                bot.swingArm();
                // Micro-rotation prevents idle camera kicks
                const currentYaw = bot.entity.yaw;
                const currentPitch = bot.entity.pitch;
                const offset = (afkTick % 2 === 0 ? 0.05 : -0.05);
                bot.look(currentYaw + offset, currentPitch, true).catch(() => {});

                // Sneak pulse every 60s
                if (afkTick % 3 === 0) {
                  bot.setControlState("sneak", true);
                  setTimeout(() => {
                    try { bot.setControlState("sneak", false); } catch (_) {}
                  }, 1000);
                }
              } catch (_) {}
            }
          }, 20000);
          this.heartbeatTimers.set(id, hb);

          this.broadcastState();

          if (!resolved) {
            resolved = true;
            resolve(entry);
          }
        });

        bot.on("kicked", (reason) => {
          const reasonStr = typeof reason === "object" ? JSON.stringify(reason) : String(reason);
          this.addLog(`[Swarm] ⚠️ ${username} was kicked: ${reasonStr}`, "Swarm");
          entry.connected = false;
          entry.connecting = false;
          this.cleanUpBot(id);

          // Auto-reconnect on kick
          this.enqueueReconnect(id, 8000);

          if (!resolved) {
            resolved = true;
            reject(new Error(`Kicked: ${reasonStr}`));
          }
        });

        bot.on("end", () => {
          this.addLog(`[Swarm] 🔌 ${username} connection ended. Scheduling auto-reconnect...`, "Swarm");
          entry.connected = false;
          entry.connecting = false;
          this.cleanUpBot(id);

          // Auto-reconnect on disconnect
          this.enqueueReconnect(id, 5000);

          if (!resolved) {
            resolved = true;
            reject(new Error("Connection ended"));
          }
        });

        bot.on("error", (err) => {
          this.addLog(`[Swarm] ${username} handled notice: ${err.message}`, "Swarm");
        });

        // Fail-safe timeout for join attempt
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            entry.connecting = false;
            this.cleanUpBot(id);
            this.enqueueReconnect(id, 6000);
            reject(new Error("Connection handshake timed out (25s)"));
          }
        }, 25000);

      } catch (e) {
        entry.connecting = false;
        if (!resolved) {
          resolved = true;
          this.enqueueReconnect(id, 6000);
          reject(e);
        }
      }
    });
  }

  /**
   * Cleans up listeners and heartbeats for a bot
   */
  cleanUpBot(id) {
    if (this.heartbeatTimers.has(id)) {
      clearInterval(this.heartbeatTimers.get(id));
      this.heartbeatTimers.delete(id);
    }
    if (this.bots.has(id)) {
      const entry = this.bots.get(id);
      entry.connected = false;
      if (entry.bot) {
        try { entry.bot.removeAllListeners(); } catch (_) {}
      }
    }
    this.broadcastState();
  }

  /**
   * Enqueue a bot into the sequential reconnect queue
   */
  enqueueReconnect(id, delay = 0) {
    if (id <= 1 || id > this.targetBots) return;
    if (this.reconnectQueue.includes(id)) return;

    const entry = this.bots.get(id);
    if (entry && entry.connected) return;

    if (delay > 0) {
      setTimeout(() => {
        if (!this.reconnectQueue.includes(id)) {
          this.reconnectQueue.push(id);
          this.processReconnectQueue();
        }
      }, delay);
    } else {
      this.reconnectQueue.push(id);
      this.processReconnectQueue();
    }
  }

  /**
   * Processes the reconnect queue sequentially with safe anti-throttle delay
   */
  async processReconnectQueue() {
    if (this.isProcessingQueue || this.reconnectQueue.length === 0) return;
    this.isProcessingQueue = true;

    while (this.reconnectQueue.length > 0) {
      const nextId = this.reconnectQueue.shift();
      const entry = this.bots.get(nextId);

      // Check if already connected
      if (entry && entry.connected && entry.bot && entry.bot.entity) {
        continue;
      }

      // Safe delay between joins to satisfy server connection-throttle
      await this.sleep(this.staggerDelay);

      try {
        await this.spawnBotAndWait(nextId);
      } catch (err) {
        const attempts = (entry ? entry.reconnectAttempts : 0) + 1;
        if (entry) entry.reconnectAttempts = attempts;

        const backoff = Math.min(this.staggerDelay * Math.min(attempts, 4), 30000);
        this.addLog(`[Swarm] Reconnect for Bot ${nextId} failed (${err.message}). Retrying in ${(backoff / 1000).toFixed(0)}s (Attempt #${attempts})...`, "Swarm");
        this.enqueueReconnect(nextId, backoff);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Execute an individual command on ANY bot (1..10)
   */
  async executeBotCommand(targetIdentifier, sender, commandLine) {
    let targetEntry = null;
    let targetId = null;

    // Resolve target bot ID (1..10)
    let parsedNum = parseInt(targetIdentifier, 10);
    if (isNaN(parsedNum)) {
      const match = targetIdentifier.match(/(\d+)/);
      if (match) {
        parsedNum = parseInt(match[1], 10);
      } else if (targetIdentifier.toLowerCase().includes("miner_bot") || targetIdentifier.toLowerCase() === "minerbot") {
        parsedNum = 1;
      }
    }

    if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= 10) {
      targetId = parsedNum;
      if (this.bots.has(targetId)) {
        targetEntry = this.bots.get(targetId);
      }
    }

    // Auto-Spawn on demand if bot is offline
    if ((!targetEntry || !targetEntry.connected) && targetId && targetId >= 2) {
      const pBot = this.bots.get(1);
      if (pBot && pBot.bot) {
        pBot.bot.chat(`🤖 Spawning Miner_Bot_${targetId} to execute mission...`);
      }
      try {
        await this.spawnBotAndWait(targetId);
        targetEntry = this.bots.get(targetId);
      } catch (err) {
        this.addLog(`[Swarm] Auto-spawn for Bot ${targetId} failed: ${err.message}`, "Swarm");
      }
    }

    if (!targetEntry || !targetEntry.connected) {
      const pBot = this.bots.get(1);
      if (pBot && pBot.bot) {
        pBot.bot.chat(`⚠️ Bot '${targetIdentifier}' is not connected yet. Please retry in a few seconds.`);
      }
      return false;
    }

    const { bot, miner } = targetEntry;
    const parts = commandLine.trim().split(/\s+/);
    const trigger = parts[0].toLowerCase();

    if (trigger === "!mission") {
      if (parts.length < 7) {
        bot.chat("Usage: !mission <mineX> <mineY> <mineZ> <chestX> <chestY> <chestZ> [dur] [strat] [dir] [size]");
        return true;
      }
      const mineCoords = { x: parseInt(parts[1], 10), y: parseInt(parts[2], 10), z: parseInt(parts[3], 10) };
      const chestCoords = { x: parseInt(parts[4], 10), y: parseInt(parts[5], 10), z: parseInt(parts[6], 10) };
      const durParam = (parts[7] || "0").toLowerCase();
      const strategy = parts[8] || "strip_mine";
      const direction = parts[9] || "north";
      const size = parts[10] || "3x3";

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

      const speedParam = parts.find((p) => p.toLowerCase().startsWith("speed:"))?.replace(/speed:/i, "") || "1x";
      const targetYParam = parts.find((p) => p.toLowerCase().startsWith("targety:") || p.toLowerCase().startsWith("depth:"))?.replace(/targety:|depth:/i, "");
      const targetY = (targetYParam !== undefined && targetYParam !== "") ? parseInt(targetYParam, 10) : null;

      const yLabel = targetY !== null ? ` | 🎯 Target Y: ${targetY}` : "";
      bot.chat(`🚀 [${targetEntry.username}] Starting ${size} mission (⚡Speed: ${speedParam.toUpperCase()}${yLabel}) at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`);
      miner.startAutonomousMission({
        mineCoords,
        chestCoords,
        durationMode,
        durationMinutes,
        distanceLength,
        strategy,
        direction,
        size,
        speed: speedParam,
        targetY
      }).catch((err) => {
        console.error(`[SWARM FATAL] ${targetEntry.username}:`, err);
        bot.chat(`❌ [${targetEntry.username}] Mission crashed: ${err.message}`);
      });
      return true;
    } else if (trigger === "!stop" || trigger === "!abort") {
      miner.stop(`Stopped by ${sender}`);
      bot.chat(`🛑 [${targetEntry.username}] Stopped.`);
      if (miner.currentMission && miner.currentMission.chestCoords) {
        miner.depositAndSortAllItems(miner.currentMission.chestCoords);
      }
      return true;
    } else if (trigger === "!deposit") {
      if (miner.currentMission && miner.currentMission.chestCoords) {
        miner.depositAndSortAllItems(miner.currentMission.chestCoords);
      }
      return true;
    } else if (trigger === "!status" || trigger === "!stats") {
      const s = miner.stats;
      const pos = bot.entity ? bot.entity.position.floored() : { x: 0, y: 0, z: 0 };
      bot.chat(`📊 [${targetEntry.username}] State: ${miner.state} | Pos: (${pos.x}, ${pos.y}, ${pos.z}) | Mined: ${s.totalBlocksMined}`);
      return true;
    }

    return false;
  }

  /**
   * Universal Stop All Active Fleet Bots
   */
  stopAllBots(sender = "Player") {
    let stoppedCount = 0;
    for (const [id, entry] of this.bots.entries()) {
      if (entry && entry.miner) {
        try {
          entry.miner.stop(`Universal stop by ${sender}`);
          stoppedCount++;
        } catch (_) {}
      }
    }

    const pBot = this.bots.get(1);
    if (pBot && pBot.bot && typeof pBot.bot.chat === "function") {
      pBot.bot.chat(`🛑 [Fleet Manager] Stopped all ${stoppedCount} fleet bots.`);
    }
    this.addLog(`[Swarm] Universal Stop triggered by ${sender}. ${stoppedCount} bots stopped.`, "Swarm");
  }

  /**
   * Launches a Synchronized Swarm Mission across parallel lanes
   */
  async startSwarmMission(missionConfig) {
    const activeEntries = Array.from(this.bots.values())
      .filter((e) => e.connected && e.bot && e.miner)
      .sort((a, b) => a.id - b.id);

    if (activeEntries.length === 0) {
      this.addLog("[Swarm] No connected bots available to launch swarm mission!", "Swarm");
      return;
    }

    const {
      mineCoords,
      chestCoords,
      durationMode = "continuous",
      durationMinutes = 30,
      distanceLength = 100,
      strategy = "strip_mine",
      direction = "north",
      size = "3x3"
    } = missionConfig;

    let laneSpacing = 4;
    if (size === "1x2") laneSpacing = 3;
    else if (size === "4x4") laneSpacing = 5;
    else if (size === "5x5") laneSpacing = 6;

    const dir = direction.toLowerCase();
    let lateralVec = new Vec3(1, 0, 0);
    if (dir === "east" || dir === "west") {
      lateralVec = new Vec3(0, 0, 1);
    }

    this.addLog(`[Swarm] 🚀 Launching Swarm Mission for ${activeEntries.length} Bots (${size} ${strategy} ${direction.toUpperCase()})...`, "Swarm");

    activeEntries.forEach((entry, idx) => {
      const laneOffset = idx * laneSpacing;
      const botMineCoords = {
        x: mineCoords.x + (lateralVec.x * laneOffset),
        y: mineCoords.y,
        z: mineCoords.z + (lateralVec.z * laneOffset)
      };

      const botChestCoords = {
        x: chestCoords.x + (lateralVec.x * laneOffset),
        y: chestCoords.y,
        z: chestCoords.z + (lateralVec.z * laneOffset)
      };

      entry.bot.chat(`🚀 [Lane ${idx + 1}] Starting ${size} mission at (${botMineCoords.x}, ${botMineCoords.y}, ${botMineCoords.z})`);

      entry.miner.startAutonomousMission({
        mineCoords: botMineCoords,
        chestCoords: botChestCoords,
        durationMode,
        durationMinutes,
        distanceLength,
        strategy,
        direction,
        size
      });
    });
  }

  /**
   * Stop all swarm bots
   */
  stopSwarm(reason = "User requested swarm stop") {
    this.bots.forEach((entry) => {
      if (entry.connected && entry.miner) {
        entry.miner.stop(reason);
        if (entry.miner.currentMission && entry.miner.currentMission.chestCoords) {
          entry.miner.depositAndSortAllItems(entry.miner.currentMission.chestCoords);
        }
      }
    });
    this.addLog(`[Swarm] All bots stopped: ${reason}`, "Swarm");
  }

  handleBotChat(botId, sender, message) {
    if (!message.startsWith("!")) return;
    const parts = message.trim().split(" ");
    const trigger = parts[0].toLowerCase();

    if (trigger === "!swarmstop") {
      this.stopSwarm(`Stopped by ${sender}`);
    }
  }

  getSwarmStatus() {
    const list = [];
    for (let id = 1; id <= this.maxBots; id++) {
      const entry = this.bots.get(id);
      const pos = entry && entry.bot && entry.bot.entity ? entry.bot.entity.position.floored() : null;
      list.push({
        id,
        username: entry ? entry.username : this.getBotName(id),
        connected: entry ? entry.connected : false,
        connecting: entry ? entry.connecting : false,
        state: entry && entry.miner ? entry.miner.state : (entry && entry.connected ? "IDLE" : "OFFLINE"),
        pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
        health: entry && entry.bot ? entry.bot.health : 0,
        food: entry && entry.bot ? entry.bot.food : 0,
        stats: entry && entry.miner ? entry.miner.stats : {}
      });
    }
    return list;
  }

  sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }
}

module.exports = SwarmManager;
