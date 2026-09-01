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
    this.bots = new Map(); // id (1..10) -> { bot, miner, safety, id, username, connected }
    this.heartbeatTimers = new Map();
    this.reconnectQueue = [];
    this.isProcessingQueue = false;
    this.maxBots = 10;
    this.autoStartTriggered = false;
  }

  registerPrimaryBot(bot, miner, safety) {
    this.bots.set(1, {
      id: 1,
      username: "Miner_Bot",
      bot,
      miner,
      safety,
      connected: true
    });
  }

  getBotName(id) {
    if (id === 1) return "Miner_Bot";
    return `Miner_Bot_${id}`;
  }

  /**
   * Starts and maintains all 10 bots logged in 24/7 with throttle-safe sequential joins
   */
  async startAllBots() {
    if (this.autoStartTriggered) return;
    this.autoStartTriggered = true;
    this.addLog("[Swarm] 🌟 Connecting 10-bot swarm fleet sequentially with anti-spam throttle protection...", "Swarm");

    for (let id = 2; id <= this.maxBots; id++) {
      try {
        await this.spawnBotAndWait(id);
      } catch (err) {
        this.addLog(`[Swarm] Bot ${id} join delayed: ${err.message}. Queued for auto-reconnect.`, "Swarm");
        this.enqueueReconnect(id);
      }
      await this.sleep(5000); // 5s safe delay to completely prevent server connection throttling
    }
  }

  /**
   * Spawn a bot and await its spawn handshake before proceeding
   */
  spawnBotAndWait(id) {
    return new Promise((resolve, reject) => {
      if (this.bots.has(id) && this.bots.get(id).connected) {
        return resolve(this.bots.get(id));
      }

      const username = this.getBotName(id);
      const host = this.serverConfig.ip || config.server.ip;
      const port = parseInt(this.serverConfig.port || config.server.port, 10);
      const version = this.serverConfig.version || config.server.version || "1.21.4";

      this.addLog(`[Swarm] Connecting ${username} (${id}/10) to ${host}:${port}...`, "Swarm");

      let resolved = false;

      try {
        const bot = mineflayer.createBot({
          host: host,
          port: port,
          username: username,
          version: version,
          auth: "offline",
          checkTimeoutInterval: 0,
          hideErrors: true
        });

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

        const botEntry = {
          id,
          username,
          bot,
          miner,
          safety,
          connected: false
        };

        this.bots.set(id, botEntry);

        bot.once("spawn", () => {
          botEntry.connected = true;
          this.addLog(`[Swarm] ✅ ${username} spawned successfully!`, "Swarm");

          // Initialize pathfinder movements
          try {
            const mcData = require("minecraft-data")(bot.version);
            const defaultMove = new Movements(bot, mcData);
            defaultMove.allowFreeMotion = true;
            defaultMove.canDig = true;
            defaultMove.allow1by1towers = false;
            bot.pathfinder.setMovements(defaultMove);
          } catch (_) {}

          safety.init();

          // Auto-auth (login only - avoid command spam kicks)
          const pass = "chalol78";
          setTimeout(() => {
            bot.chat(`/login ${pass}`);
          }, 1500);

          setTimeout(() => {
            bot.chat("/gamemode creative");
          }, 3500);

          // Anti-AFK heartbeat (swing arm every 25s so server never kicks for AFK)
          if (this.heartbeatTimers.has(id)) clearInterval(this.heartbeatTimers.get(id));
          const hb = setInterval(() => {
            if (bot && botEntry.connected) {
              try { bot.swingArm(); } catch (_) {}
            }
          }, 25000);
          this.heartbeatTimers.set(id, hb);

          this.broadcastState();

          if (!resolved) {
            resolved = true;
            resolve(botEntry);
          }
        });

        bot.on("kicked", (reason) => {
          this.addLog(`[Swarm] ${username} was kicked: ${reason}`, "Swarm");
          botEntry.connected = false;
          this.cleanUpBot(id);
          if (!resolved) {
            resolved = true;
            reject(new Error(`Kicked: ${reason}`));
          }
        });

        bot.on("end", () => {
          this.addLog(`[Swarm] ${username} disconnected.`, "Swarm");
          botEntry.connected = false;
          this.cleanUpBot(id);
          if (!resolved) {
            resolved = true;
            reject(new Error("Connection ended"));
          }
        });

        bot.on("error", (err) => {
          this.addLog(`[Swarm] ${username} handled notice: ${err.message}`, "Swarm");
        });

        // Fail-safe timeout for single join attempt
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error("Connection timeout"));
          }
        }, 15000);

      } catch (e) {
        if (!resolved) {
          resolved = true;
          reject(e);
        }
      }
    });
  }

  /**
   * Cleans up listeners and heartbeats
   */
  cleanUpBot(id) {
    if (this.heartbeatTimers.has(id)) {
      clearInterval(this.heartbeatTimers.get(id));
      this.heartbeatTimers.delete(id);
    }
    if (this.bots.has(id)) {
      const entry = this.bots.get(id);
      if (entry.bot) {
        try { entry.bot.removeAllListeners(); } catch (_) {}
      }
    }
    this.broadcastState();
  }

  /**
   * Enqueue a bot into the sequential reconnect queue to avoid throttling
   */
  enqueueReconnect(id) {
    if (id <= 1 || id > this.maxBots) return;
    if (!this.reconnectQueue.includes(id)) {
      this.reconnectQueue.push(id);
    }
    this.processReconnectQueue();
  }

  async processReconnectQueue() {
    if (this.isProcessingQueue || this.reconnectQueue.length === 0) return;
    this.isProcessingQueue = true;

    while (this.reconnectQueue.length > 0) {
      const nextId = this.reconnectQueue.shift();
      await this.sleep(5000); // 5s cooldown between reconnect attempts to avoid throttling
      try {
        await this.spawnBotAndWait(nextId);
      } catch (err) {
        this.addLog(`[Swarm] Reconnect for Bot ${nextId} delayed. Will retry in queue...`, "Swarm");
        this.reconnectQueue.push(nextId);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Execute an individual command on ANY bot (1..10 or Miner_Bot / Miner_Bot_10) with Auto-Spawn on Demand
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

    // Auto-Spawn on demand if bot is offline or not yet created
    if ((!targetEntry || !targetEntry.connected) && targetId && targetId >= 2) {
      if (this.bots.has(1) && this.bots.get(1).bot) {
        this.bots.get(1).bot.chat(`🤖 Auto-spawning Miner_Bot_${targetId} on demand to execute mission...`);
      }
      try {
        await this.spawnBotAndWait(targetId);
        targetEntry = this.bots.get(targetId);
      } catch (err) {
        this.addLog(`[Swarm] Auto-spawn for Bot ${targetId} failed: ${err.message}`, "Swarm");
      }
    }

    if (!targetEntry || !targetEntry.connected) {
      if (this.bots.has(1) && this.bots.get(1).bot) {
        this.bots.get(1).bot.chat(`⚠️ Bot '${targetIdentifier}' is not ready yet. Please retry in 5s.`);
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

      bot.chat(`🚀 [${targetEntry.username}] Starting ${size} mission at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`);
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
    return Array.from(this.bots.values()).map((entry) => {
      const pos = entry.bot && entry.bot.entity ? entry.bot.entity.position.floored() : null;
      return {
        id: entry.id,
        username: entry.username,
        connected: entry.connected,
        state: entry.miner ? entry.miner.state : "DISCONNECTED",
        pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
        stats: entry.miner ? entry.miner.stats : {}
      };
    });
  }

  sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }
}

module.exports = SwarmManager;
