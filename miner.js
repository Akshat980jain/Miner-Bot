"use strict";

const { Vec3 } = require("vec3");
const { goals } = require("mineflayer-pathfinder");
const { GoalBlock, GoalNear, GoalGetToBlock } = goals;
const { addLog } = require("./logger");

class MinerManager {
  constructor(bot, config, safety) {
    this.bot = bot;
    this.config = config;
    this.safety = safety;
    this.state = "IDLE"; // IDLE, TRAVELING_TO_MINE, MINING, RETURNING_TO_CHEST, DEPOSITING_SORTING, PAUSED
    this.shouldStop = false;

    // Mission configuration
    this.currentMission = null;
    this.missionStartTime = 0;
    this.missionEndTime = 0;
    this.resumeMiningPos = null;

    // Statistics tracker
    this.stats = {
      diamonds: 0,
      iron: 0,
      gold: 0,
      ancientDebris: 0,
      coal: 0,
      lapis: 0,
      redstone: 0,
      copper: 0,
      stone: 0,
      deepslate: 0,
      wood: 0,
      totalBlocksMined: 0,
      chestTrips: 0,
      startTime: Date.now()
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Stop current mining operation and mission
   */
  stop(reason = "User requested stop") {
    this.shouldStop = true;
    this.state = "IDLE";
    this.currentMission = null;
    if (this.bot.pathfinder) {
      try {
        this.bot.pathfinder.stop();
        this.bot.pathfinder.setGoal(null);
      } catch (_) {}
    }
    addLog(`[Mission] Stopped: ${reason}`, "Miner");
  }

  /**
   * Categorizes items into sorting tiers for chest organization
   */
  getItemSortTier(item) {
    if (!item) return 99;
    const name = item.name.toLowerCase();

    // Tools & Food: Keep on bot
    if (
      name.includes("pickaxe") ||
      name.includes("axe") ||
      name.includes("shovel") ||
      name.includes("sword") ||
      name.includes("torch") ||
      name.includes("bread") ||
      name.includes("cooked_") ||
      name.includes("steak") ||
      name.includes("porkchop") ||
      name.includes("golden_apple")
    ) {
      return 0; // Essential gear
    }

    // Tier 1: Precious & Ores
    if (
      name.includes("diamond") ||
      name.includes("ancient_debris") ||
      name.includes("netherite") ||
      name.includes("emerald") ||
      name.includes("gold") ||
      name.includes("iron") ||
      name.includes("raw_")
    ) {
      return 1;
    }

    // Tier 2: Minerals & Energy
    if (
      name.includes("redstone") ||
      name.includes("lapis") ||
      name.includes("coal") ||
      name.includes("copper") ||
      name.includes("quartz") ||
      name.includes("amethyst")
    ) {
      return 2;
    }

    // Tier 3: Wood & Forestry
    if (
      name.includes("_log") ||
      name.includes("_wood") ||
      name.includes("_planks") ||
      name.includes("sapling") ||
      name.includes("apple")
    ) {
      return 3;
    }

    // Tier 4: Excavation & Building Blocks (Stone, Deepslate, etc.)
    return 4;
  }

  /**
   * Records stats for all mined blocks
   */
  recordMinedBlock(blockName) {
    this.stats.totalBlocksMined++;
    const name = blockName.toLowerCase();

    if (name.includes("diamond")) this.stats.diamonds++;
    else if (name.includes("ancient_debris")) this.stats.ancientDebris++;
    else if (name.includes("iron")) this.stats.iron++;
    else if (name.includes("gold")) this.stats.gold++;
    else if (name.includes("coal")) this.stats.coal++;
    else if (name.includes("lapis")) this.stats.lapis++;
    else if (name.includes("redstone")) this.stats.redstone++;
    else if (name.includes("copper")) this.stats.copper++;
    else if (name.includes("deepslate")) this.stats.deepslate++;
    else if (name.includes("stone") || name.includes("cobble")) this.stats.stone++;
    else if (name.includes("log") || name.includes("wood")) this.stats.wood++;
  }

  /**
   * Checks if inventory is full (less than 3 free slots)
   */
  isInventoryFull() {
    return this.bot.inventory.emptySlotCount() <= 2;
  }

  /**
   * Universal Block Breaker & Drop Collector
   */
  /**
   * Universal Block Breaker & Drop Collector
   */
  async breakAndCollectBlock(targetBlock) {
    if (!targetBlock || targetBlock.name === "air" || targetBlock.name.includes("air") || targetBlock.name.includes("water") || targetBlock.name.includes("lava") || targetBlock.name === "bedrock") {
      return false;
    }

    if (this.safety.isHazardousToMine(targetBlock)) {
      addLog(`[Safety] Skipping hazardous block at ${targetBlock.position}`, "Safety");
      return false;
    }

    try {
      await this.safety.equipBestTool(targetBlock);
      await this.bot.lookAt(targetBlock.position.offset(0.5, 0.5, 0.5));

      if (this.bot.canDigBlock(targetBlock)) {
        await this.bot.dig(targetBlock);
        this.recordMinedBlock(targetBlock.name);
        await this.sleep(80);
        return true;
      }
    } catch (e) {
      addLog(`[Digging Note] ${e.message}`, "Miner");
      return false;
    }
    return false;
  }

  /**
   * DEPOSIT & SORT ALL COLLECTED ITEMS INTO CHEST
   */
  async depositAndSortAllItems(chestCoords) {
    if (!chestCoords || chestCoords.x === undefined) {
      addLog("[Chest] No deposit chest coordinates provided!", "Inventory");
      return false;
    }

    this.state = "RETURNING_TO_CHEST";
    addLog(`[Navigation] Returning to Chest at (${chestCoords.x}, ${chestCoords.y}, ${chestCoords.z})...`, "Inventory");

    try {
      const chestVec = new Vec3(chestCoords.x, chestCoords.y, chestCoords.z);
      await this.bot.pathfinder.goto(new GoalNear(chestVec.x, chestVec.y, chestVec.z, 2));

      this.state = "DEPOSITING_SORTING";
      const chestBlock = this.bot.blockAt(chestVec);

      if (!chestBlock || !chestBlock.name.includes("chest")) {
        addLog(`[Chest Error] Block at (${chestVec.x}, ${chestVec.y}, ${chestVec.z}) is not a chest! (${chestBlock?.name})`, "Inventory");
        return false;
      }

      addLog("[Chest] Opening container and sorting all items...", "Inventory");
      const container = await this.bot.openContainer(chestBlock);

      // Get all deposit-eligible items (Tier >= 1) sorted by category priority
      const itemsToDeposit = this.bot.inventory
        .items()
        .filter((item) => this.getItemSortTier(item) > 0)
        .sort((a, b) => this.getItemSortTier(a) - this.getItemSortTier(b));

      let depositedCount = 0;
      for (const item of itemsToDeposit) {
        if (this.shouldStop) break;
        try {
          await container.deposit(item.type, null, item.count);
          depositedCount += item.count;
          await this.sleep(80);
        } catch (depositErr) {
          if (depositErr.message && depositErr.message.includes("full")) {
            addLog("[Chest Warning] Chest is completely full!", "Inventory");
            break;
          }
        }
      }

      container.close();
      this.stats.chestTrips++;
      addLog(`[Chest] Successfully deposited and sorted ${depositedCount} items. (Trip #${this.stats.chestTrips})`, "Inventory");
      return true;
    } catch (err) {
      addLog(`[Chest Error] Deposit failed: ${err.message}`, "Inventory");
      return false;
    }
  }

  /**
   * AUTONOMOUS MISSION CONTROLLER
   */
  async startAutonomousMission(missionConfig) {
    if (this.state !== "IDLE" && !this.shouldStop) {
      addLog(`[Mission] Interrupting previous state (${this.state}) to launch new mission...`, "Miner");
      this.stop("Starting new mission");
      await this.sleep(300);
    }

    this.shouldStop = false;
    this.state = "IDLE";
    this.currentMission = missionConfig;
    this.missionStartTime = Date.now();

    const {
      mineCoords,
      chestCoords,
      durationMode = "continuous",
      durationMinutes = 30,
      distanceLength = 50,
      strategy = "strip_mine",
      direction = "north",
      size = "3x3"
    } = missionConfig;

    if (durationMode === "timed") {
      this.missionEndTime = Date.now() + durationMinutes * 60 * 1000;
      addLog(`[Mission] Launched Timed Mission (${durationMinutes} mins, ${size}) at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`, "Miner");
    } else if (durationMode === "distance") {
      this.missionEndTime = 0;
      addLog(`[Mission] Launched Distance Mission (${distanceLength} blocks, ${size}) at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`, "Miner");
    } else {
      this.missionEndTime = 0;
      addLog(`[Mission] Launched 24/7 Continuous Mission (${size}) at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`, "Miner");
    }

    // Step 1: Navigate to Mining Site
    this.state = "TRAVELING_TO_MINE";
    addLog(`[Navigation] Traveling to Mine Coordinates (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})...`, "Miner");

    try {
      const mineVec = new Vec3(mineCoords.x, mineCoords.y, mineCoords.z);
      await this.bot.pathfinder.goto(new GoalNear(mineVec.x, mineVec.y, mineVec.z, 2));
      addLog("[Navigation] Reached mining destination. Starting excavation...", "Miner");
    } catch (navErr) {
      addLog(`[Navigation] Starting excavation from current position.`, "Miner");
    }

    // Step 2: Main Autonomous Mining Loop
    this.state = "MINING";
    let distanceCovered = 0;
    const dirMap = {
      north: new Vec3(0, 0, -1),
      south: new Vec3(0, 0, 1),
      east: new Vec3(1, 0, 0),
      west: new Vec3(-1, 0, 0)
    };
    const stepVec = dirMap[direction.toLowerCase()] || dirMap.north;

    while (!this.shouldStop) {
      // Check Time Limit
      if (durationMode === "timed" && Date.now() >= this.missionEndTime) {
        addLog("[Mission] Timer expired! Concluding mining mission.", "Miner");
        break;
      }

      // Check Distance Limit
      if (durationMode === "distance" && distanceCovered >= distanceLength) {
        addLog(`[Mission] Target distance of ${distanceLength} blocks reached!`, "Miner");
        break;
      }

      // Check Inventory Capacity -> Trigger Auto-Deposit Trip
      if (this.isInventoryFull()) {
        addLog("[Inventory Full] Capacity reached! Pausing mining to deposit loot...", "Inventory");
        this.resumeMiningPos = this.bot.entity.position.floored();

        await this.depositAndSortAllItems(chestCoords);

        if (this.shouldStop) break;

        // Path back to where we left off
        this.state = "TRAVELING_TO_MINE";
        addLog(`[Navigation] Returning to mining front at ${this.resumeMiningPos}...`, "Miner");
        try {
          await this.bot.pathfinder.goto(new GoalNear(this.resumeMiningPos.x, this.resumeMiningPos.y, this.resumeMiningPos.z, 1));
        } catch (_) {}
        this.state = "MINING";
      }

      // Execute Mining Step based on Strategy
      if (strategy === "strip_mine") {
        const currentPos = this.bot.entity.position.floored();
        const nextFoot = currentPos.plus(stepVec);

        // Lateral Vector perpendicular to movement direction
        let lateralVec = new Vec3(1, 0, 0);
        if (direction.toLowerCase() === "east" || direction.toLowerCase() === "west") {
          lateralVec = new Vec3(0, 0, 1);
        }

        // Determine slice bounds for 1x2, 3x3, 4x4, 5x5
        let minX = 0, maxX = 0, minY = 0, maxY = 1;
        if (size === "3x3") {
          minX = -1; maxX = 1; minY = 0; maxY = 2;
        } else if (size === "4x4") {
          minX = -1; maxX = 2; minY = 0; maxY = 3;
        } else if (size === "5x5") {
          minX = -2; maxX = 2; minY = 0; maxY = 4;
        }

        // Dig out full cross-section slice
        for (let dy = maxY; dy >= minY; dy--) {
          for (let dx = minX; dx <= maxX; dx++) {
            if (this.shouldStop) break;
            const targetPos = nextFoot.plus(lateralVec.scaled(dx)).offset(0, dy, 0);
            const blk = this.bot.blockAt(targetPos);
            if (blk && blk.name !== "air" && !blk.name.includes("air")) {
              await this.breakAndCollectBlock(blk);
            }
          }
        }

        // Step forward
        try {
          await this.bot.lookAt(nextFoot.offset(0.5, 0.5, 0.5));
          await this.bot.pathfinder.goto(new GoalNear(nextFoot.x, nextFoot.y, nextFoot.z, 0));
        } catch (_) {
          this.bot.setControlState("forward", true);
          await this.sleep(300);
          this.bot.setControlState("forward", false);
        }

        distanceCovered++;

        // Place torch every 8 blocks
        if (distanceCovered % 8 === 0) {
          await this.placeTorch(this.bot.entity.position.floored());
        }
      } else if (strategy === "ore_hunter") {
        const targetBlocks = this.bot.findBlocks({
          matching: (b) => b && (b.name.includes("ore") || b.name.includes("debris") || b.name.includes("raw_")),
          maxDistance: 32,
          count: 5
        });

        if (targetBlocks.length > 0) {
          const target = this.bot.blockAt(targetBlocks[0]);
          if (target) await this.breakAndCollectBlock(target);
        } else {
          const currentPos = this.bot.entity.position.floored();
          const nextPos = currentPos.plus(stepVec);
          await this.breakAndCollectBlock(this.bot.blockAt(nextPos.offset(0, 1, 0)));
          await this.breakAndCollectBlock(this.bot.blockAt(nextPos));
          try {
            await this.bot.pathfinder.goto(new GoalNear(nextPos.x, nextPos.y, nextPos.z, 0));
          } catch (_) {}
        }
      } else if (strategy === "tree_chopper") {
        const logs = this.bot.findBlocks({
          matching: (b) => b && (b.name.includes("_log") || b.name.includes("_wood")),
          maxDistance: 24,
          count: 5
        });

        if (logs.length > 0) {
          const logBlk = this.bot.blockAt(logs[0]);
          if (logBlk) await this.breakAndCollectBlock(logBlk);
        } else {
          addLog("[Tree Chopper] No more trees in immediate area.", "Miner");
          break;
        }
      }

      await this.sleep(150);
    }

    // Step 3: Final Return & Deposit All Mined Items
    addLog("[Mission] Mission complete. Returning to chest to sort and deposit all items...", "Miner");
    await this.depositAndSortAllItems(chestCoords);

    this.state = "IDLE";
    this.currentMission = null;
    addLog("[Mission] 🎯 Mission successfully finished. Bot is now resting at base.", "Miner");
  }

  /**
   * Harvest surrounding exposed ores and mineral blocks
   */
  async harvestSurroundingBlocks(centerPos) {
    const offsets = [
      new Vec3(0, 2, 0),
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(1, 1, 0),
      new Vec3(-1, 1, 0),
      new Vec3(0, 1, 1),
      new Vec3(0, 1, -1)
    ];

    for (const off of offsets) {
      if (this.shouldStop || this.isInventoryFull()) break;
      const bPos = centerPos.plus(off);
      const blk = this.bot.blockAt(bPos);

      if (blk && (blk.name.includes("ore") || blk.name.includes("debris") || blk.name.includes("raw_"))) {
        await this.breakAndCollectBlock(blk);
      }
    }
  }

  /**
   * Places torch on floor or adjacent wall
   */
  async placeTorch(pos) {
    const torchItem = this.bot.inventory.items().find((i) => i.name === "torch" || i.name === "soul_torch");
    if (!torchItem) return;

    const floor = this.bot.blockAt(pos.offset(0, -1, 0));
    if (floor && floor.name !== "air") {
      try {
        await this.bot.equip(torchItem, "hand");
        await this.bot.placeBlock(floor, new Vec3(0, 1, 0));
      } catch (_) {}
    }
  }
}

module.exports = MinerManager;
