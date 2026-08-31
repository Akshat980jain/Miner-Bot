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
    this.addLog("[Swarm] 🌟 Sequential auto-login initiating for all 10 Miner Bots...", "Swarm");

    for (let id = 2; id <= this.maxBots; id++) {
      try {
        await this.spawnBotAndWait(id);
      } catch (err) {
        this.addLog(`[Swarm] Bot ${id} join delayed: ${err.message}. Queued for retry.`, "Swarm");
        this.enqueueReconnect(id);
      }
      await this.sleep(4500); // 4.5s safe delay to respect server connection throttle
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
          this.addLog(`[Swarm] ✅ ${username} successfully joined and spawned!`, "Swarm");

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

          // Auto-auth (register/login for Aternos cracked auth)
          const pass = "chalol78";
          setTimeout(() => {
            bot.chat(`/register ${pass} ${pass}`);
            bot.chat(`/login ${pass}`);
          }, 1000);

          // Creative mode, tool supply & auto-teleport to player so bots gather at player's location
          setTimeout(() => {
            bot.chat("/gamemode creative");
            bot.chat(`/give ${username} netherite_pickaxe 1`);
            bot.chat(`/give ${username} torch 64`);
            bot.chat(`/give ${username} chest 64`);
            bot.chat(`/give ${username} cobblestone 64`);
            // Teleport to player location so all bots are visible right beside Akshat_Jain!
            bot.chat(`/tp ${username} Akshat_Jain`);
          }, 2200);

          // Anti-AFK heartbeat
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
          this.enqueueReconnect(id);
          if (!resolved) {
            resolved = true;
            reject(new Error(`Kicked: ${reason}`));
          }
        });

        bot.on("end", () => {
          this.addLog(`[Swarm] ${username} connection ended.`, "Swarm");
          botEntry.connected = false;
          this.cleanUpBot(id);
          this.enqueueReconnect(id);
          if (!resolved) {
            resolved = true;
            reject(new Error("Connection ended"));
          }
        });

        bot.on("error", (err) => {
          this.addLog(`[Swarm] ${username} error: ${err.message}`, "Swarm");
        });

        // Fail-safe timeout for single join attempt
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error("Connection handshake timeout"));
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
      await this.sleep(4000); // 4s cooldown between reconnect attempts
      try {
        await this.spawnBotAndWait(nextId);
      } catch (err) {
        this.addLog(`[Swarm] Reconnect for Bot ${nextId} failed (${err.message}). Re-queuing...`, "Swarm");
        this.reconnectQueue.push(nextId);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Execute an individual command on a specific bot by ID (1..10) or Name (Miner_Bot_2)
   */
  executeBotCommand(targetIdentifier, sender, commandLine) {
    let targetEntry = null;
    const numId = parseInt(targetIdentifier, 10);
    if (!isNaN(numId) && this.bots.has(numId)) {
      targetEntry = this.bots.get(numId);
    } else {
      const lower = targetIdentifier.toLowerCase();
      for (const entry of this.bots.values()) {
        if (entry.username.toLowerCase() === lower || entry.username.toLowerCase().replace(/_/g, "") === lower.replace(/_/g, "")) {
          targetEntry = entry;
          break;
        }
      }
    }

    if (!targetEntry || !targetEntry.connected) {
      if (this.bots.has(1) && this.bots.get(1).bot) {
        this.bots.get(1).bot.chat(`⚠️ Bot '${targetIdentifier}' is currently reconnecting...`);
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

      bot.chat(`🚀 [${targetEntry.username}] Starting individual ${size} ${strategy} mission at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`);
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
      miner.stop(`Stopped individually by ${sender}`);
      bot.chat(`🛑 [${targetEntry.username}] Mission stopped.`);
      if (miner.currentMission && miner.currentMission.chestCoords) {
        miner.depositAndSortAllItems(miner.currentMission.chestCoords);
      }
      return true;
    } else if (trigger === "!deposit") {
      bot.chat(`📦 [${targetEntry.username}] Depositing all items to chest...`);
      if (miner.currentMission && miner.currentMission.chestCoords) {
        miner.depositAndSortAllItems(miner.currentMission.chestCoords);
      }
      return true;
    } else if (trigger === "!status" || trigger === "!stats") {
      const s = miner.stats;
      const pos = bot.entity ? bot.entity.position.floored() : { x: 0, y: 0, z: 0 };
      bot.chat(`📊 [${targetEntry.username}] State: ${miner.state} | Pos: (${pos.x}, ${pos.y}, ${pos.z}) | Blocks: ${s.totalBlocksMined} (Trips: ${s.chestTrips})`);
      return true;
    }

    return false;
  }

  /**
   * Launches a Synchronized Swarm Mission across parallel lanes
   */
  async startSwarmMission(missionConfig) {
    const activeEntries = Array.from(this.bots.values()).filter((e) => e.connected);
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
        entry.bot.chat("🛑 Swarm mission stopped. Returning to chest to deposit...");
        if (entry.miner.currentMission && entry.miner.currentMission.chestCoords) {
          entry.miner.depositAndSortAllItems(entry.miner.currentMission.chestCoords);
        }
      }
    });
    this.addLog(`[Swarm] All bots stopped: ${reason}`, "Swarm");
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
