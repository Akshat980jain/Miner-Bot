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
    this.maxBots = 10;
  }

  getBotName(id) {
    if (id === 1) return "Miner_Bot";
    return `Miner_Bot_${id}`;
  }

  /**
   * Spawn a specific bot by ID (1..10)
   */
  async spawnBot(id) {
    if (id < 1 || id > this.maxBots) {
      this.addLog(`[Swarm] Bot ID must be between 1 and ${this.maxBots}`, "Swarm");
      return null;
    }

    if (this.bots.has(id) && this.bots.get(id).connected) {
      this.addLog(`[Swarm] Bot ${id} is already spawned and connected.`, "Swarm");
      return this.bots.get(id);
    }

    const username = this.getBotName(id);
    const host = this.serverConfig.ip || config.server.ip;
    const port = parseInt(this.serverConfig.port || config.server.port, 10);
    const version = this.serverConfig.version || config.server.version || "1.21.4";

    this.addLog(`[Swarm] Connecting ${username} to ${host}:${port}...`, "Swarm");

    try {
      const bot = mineflayer.createBot({
        host: host,
        port: port,
        username: username,
        version: version,
        auth: "offline",
        checkTimeoutInterval: 120000
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
        this.addLog(`[Swarm] ✅ ${username} spawned successfully in world!`, "Swarm");

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
        }, 1200);

        // Creative mode & tool supply
        setTimeout(() => {
          bot.chat("/gamemode creative");
          bot.chat(`/give ${username} netherite_pickaxe 1`);
          bot.chat(`/give ${username} torch 64`);
          bot.chat(`/give ${username} chest 64`);
          bot.chat(`/give ${username} cobblestone 64`);
          bot.chat(`🤖 ${username} ready for mining operations!`);
        }, 2200);

        this.broadcastState();
      });

      bot.on("chat", (sender, message) => {
        this.handleBotChat(id, sender, message);
      });

      bot.on("kicked", (reason) => {
        this.addLog(`[Swarm] ${username} was kicked: ${reason}`, "Swarm");
        botEntry.connected = false;
        this.broadcastState();
      });

      bot.on("end", () => {
        this.addLog(`[Swarm] ${username} disconnected.`, "Swarm");
        botEntry.connected = false;
        this.broadcastState();
      });

      bot.on("error", (err) => {
        this.addLog(`[Swarm] ${username} error: ${err.message}`, "Swarm");
      });

      return botEntry;
    } catch (e) {
      this.addLog(`[Swarm] Failed to create ${username}: ${e.message}`, "Swarm");
      return null;
    }
  }

  /**
   * Spawns a fleet of bots (up to count, max 10)
   */
  async spawnSwarm(count = 3) {
    const targetCount = Math.min(Math.max(count, 1), this.maxBots);
    this.addLog(`[Swarm] Spawning Swarm Fleet up to ${targetCount} Bots...`, "Swarm");

    // Bot 1 is primary; spawn bots 2 through targetCount
    for (let id = 2; id <= targetCount; id++) {
      await this.spawnBot(id);
      await this.sleep(1500); // 1.5s delay between joins for server stability
    }
  }

  /**
   * Disconnects a specific bot
   */
  despawnBot(id) {
    if (this.bots.has(id)) {
      const entry = this.bots.get(id);
      if (entry.miner) entry.miner.stop("Despawning");
      if (entry.bot) {
        try { entry.bot.quit(); } catch (_) {}
      }
      this.bots.delete(id);
      this.addLog(`[Swarm] Despawned bot ${id}`, "Swarm");
      this.broadcastState();
    }
  }

  /**
   * Disconnects all swarm bots except Bot 1
   */
  despawnSwarm(keepPrimary = true) {
    for (const [id, entry] of this.bots.entries()) {
      if (keepPrimary && id === 1) continue;
      this.despawnBot(id);
    }
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

    // Calculate spacing width per lane based on tunnel size
    let laneSpacing = 4; // 3x3 tunnel + 1 dividing wall
    if (size === "1x2") laneSpacing = 3;
    else if (size === "4x4") laneSpacing = 5;
    else if (size === "5x5") laneSpacing = 6;

    // Lateral direction vector
    const dir = direction.toLowerCase();
    let lateralVec = new Vec3(1, 0, 0); // East/West lateral offset for North/South
    if (dir === "east" || dir === "west") {
      lateralVec = new Vec3(0, 0, 1); // North/South lateral offset for East/West
    }

    this.addLog(`[Swarm] 🚀 Launching Synchronized Swarm Mission for ${activeEntries.length} Bots (${size} ${strategy} ${direction.toUpperCase()})...`, "Swarm");

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

  /**
   * Handle incoming chat commands targeting specific bots or swarm
   */
  handleBotChat(botId, sender, message) {
    if (!message.startsWith("!")) return;
    const parts = message.trim().split(" ");
    const trigger = parts[0].toLowerCase();

    if (trigger === "!spawn") {
      const count = parseInt(parts[1], 10) || 3;
      this.spawnSwarm(count);
    } else if (trigger === "!despawn") {
      const id = parseInt(parts[1], 10);
      if (!isNaN(id)) this.despawnBot(id);
      else this.despawnSwarm(true);
    } else if (trigger === "!swarmstop") {
      this.stopSwarm(`Stopped by ${sender}`);
    }
  }

  /**
   * Get telemetry of all bots
   */
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
