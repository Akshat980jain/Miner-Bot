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

    // Tools & Food & Chests: Keep on bot
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
      name.includes("golden_apple") ||
      name.includes("chest")
    ) {
      return 0; // Essential gear (Keep on bot)
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
   * Resolves block to realistic survival drop item
   */
  getDroppedItemName(blockName) {
    if (!blockName) return "cobblestone";
    const name = blockName.toLowerCase();

    // Ores -> Drops
    if (name.includes("diamond_ore")) return "diamond";
    if (name.includes("ancient_debris")) return "ancient_debris";
    if (name.includes("netherite")) return "netherite_scrap";
    if (name.includes("emerald_ore")) return "emerald";
    if (name.includes("iron_ore")) return "raw_iron";
    if (name.includes("gold_ore")) return "raw_gold";
    if (name.includes("copper_ore")) return "raw_copper";
    if (name.includes("coal_ore")) return "coal";
    if (name.includes("lapis_ore")) return "lapis_lazuli";
    if (name.includes("redstone_ore")) return "redstone";
    if (name.includes("quartz_ore")) return "quartz";

    // Stone & Substrates
    if (name === "stone") return "cobblestone";
    if (name === "deepslate") return "cobbled_deepslate";
    if (name === "grass_block" || name === "dirt_path" || name === "farmland") return "dirt";
    if (name === "gravel") return "gravel";
    if (name === "sand") return "sand";
    if (name === "tuff") return "tuff";
    if (name === "granite") return "granite";
    if (name === "diorite") return "diorite";
    if (name === "andesite") return "andesite";

    return name;
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
        const blkName = targetBlock.name;
        await this.bot.dig(targetBlock);
        this.recordMinedBlock(blkName);

        const dropItem = this.getDroppedItemName(blkName);
        if (dropItem) {
          if (!this.collectedDrops) this.collectedDrops = {};
          this.collectedDrops[dropItem] = (this.collectedDrops[dropItem] || 0) + 1;
        }

        await this.sleep(40);
        return true;
      }
    } catch (e) {
      addLog(`[Digging Note] ${e.message}`, "Miner");
      return false;
    }
    return false;
  }

  /**
   * Auto-bridges a solid 5x5 floor platform across chasms, ravines, and air gaps
   */
  async ensureFloorBridge(nextFoot, minX = -2, maxX = 2, lateralVec = new Vec3(1, 0, 0)) {
    const floorY = nextFoot.y - 1;
    let gapFound = false;

    // Check if any air, void, water, or lava exists within the 5x5 region beneath the bot
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const checkPos = new Vec3(nextFoot.x + dx, floorY, nextFoot.z + dz);
        const blk = this.bot.blockAt(checkPos);
        if (!blk || blk.name === "air" || blk.name.includes("air") || blk.name.includes("water") || blk.name.includes("lava")) {
          gapFound = true;
          break;
        }
      }
      if (gapFound) break;
    }

    if (!gapFound) return;

    addLog(`[Auto-Bridge] Void/Ravine detected. Constructing 5x5 solid foundation beneath (${nextFoot.x}, ${floorY}, ${nextFoot.z})...`, "Safety");

    // Construct the solid 5x5 cobblestone foundation platform
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (this.shouldStop) break;
        const floorPos = new Vec3(nextFoot.x + dx, floorY, nextFoot.z + dz);
        const floorBlock = this.bot.blockAt(floorPos);

        if (!floorBlock || floorBlock.name === "air" || floorBlock.name.includes("air") || floorBlock.name.includes("water") || floorBlock.name.includes("lava")) {
          this.bot.chat(`/setblock ${floorPos.x} ${floorPos.y} ${floorPos.z} cobblestone`);
          await this.sleep(30);
        }
      }
    }
  }

  /**
   * Scans and seals any fluid (lava/water) breaches along the excavated tunnel perimeter
   */
  async sealFluidHazards(nextFoot, minX = -1, maxX = 1, minY = 0, maxY = 2, lateralVec = new Vec3(1, 0, 0)) {
    const checks = [];
    // Check perimeter boundary around the slice (floor, ceiling, walls, front)
    for (let dy = minY - 1; dy <= maxY + 1; dy++) {
      for (let dx = minX - 1; dx <= maxX + 1; dx++) {
        if (dx === minX - 1 || dx === maxX + 1 || dy === minY - 1 || dy === maxY + 1) {
          const targetPos = nextFoot.plus(lateralVec.scaled(dx)).offset(0, dy, 0);
          const blk = this.bot.blockAt(targetPos);
          if (blk && (blk.name.includes("lava") || blk.name.includes("water"))) {
            checks.push(targetPos);
          }
        }
      }
    }

    if (checks.length > 0) {
      addLog(`[Fluid Barrier] Detected ${checks.length} fluid breaches. Sealing with cobblestone...`, "Safety");
      for (const pos of checks) {
        if (this.shouldStop) break;
        this.bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} cobblestone`);
        await this.sleep(30);
      }
    }
  }

  /**
   * Constructs finished architectural highway lining (Stone Brick Floor/Walls, Smooth Stone Ceiling, Sea Lanterns)
   */
  async constructHighwaySlice(nextFoot, minX = -2, maxX = 2, minY = 0, maxY = 4, lateralVec = new Vec3(1, 0, 0), distanceCovered = 0) {
    const isLightInterval = (distanceCovered % 6 === 0);

    // 1. Floor: Stone Bricks (at minY - 1)
    for (let dx = minX; dx <= maxX; dx++) {
      if (this.shouldStop) break;
      const floorPos = nextFoot.plus(lateralVec.scaled(dx)).offset(0, minY - 1, 0);
      const floorBlk = this.bot.blockAt(floorPos);
      if (!floorBlk || floorBlk.name !== "stone_bricks") {
        this.bot.chat(`/setblock ${floorPos.x} ${floorPos.y} ${floorPos.z} stone_bricks`);
        await this.sleep(20);
      }
    }

    // 2. Left & Right Walls: Stone Bricks (at minX - 1 and maxX + 1)
    for (let dy = minY; dy <= maxY; dy++) {
      if (this.shouldStop) break;
      const leftPos = nextFoot.plus(lateralVec.scaled(minX - 1)).offset(0, dy, 0);
      const rightPos = nextFoot.plus(lateralVec.scaled(maxX + 1)).offset(0, dy, 0);

      const leftBlk = this.bot.blockAt(leftPos);
      if (!leftBlk || leftBlk.name !== "stone_bricks") {
        this.bot.chat(`/setblock ${leftPos.x} ${leftPos.y} ${leftPos.z} stone_bricks`);
        await this.sleep(20);
      }

      const rightBlk = this.bot.blockAt(rightPos);
      if (!rightBlk || rightBlk.name !== "stone_bricks") {
        this.bot.chat(`/setblock ${rightPos.x} ${rightPos.y} ${rightPos.z} stone_bricks`);
        await this.sleep(20);
      }
    }

    // 3. Ceiling: Smooth Stone (at maxY + 1) with embedded Sea Lanterns
    for (let dx = minX; dx <= maxX; dx++) {
      if (this.shouldStop) break;
      const ceilPos = nextFoot.plus(lateralVec.scaled(dx)).offset(0, maxY + 1, 0);
      const ceilBlk = this.bot.blockAt(ceilPos);

      // Center ceiling light
      if (isLightInterval && dx === 0) {
        if (!ceilBlk || ceilBlk.name !== "sea_lantern") {
          this.bot.chat(`/setblock ${ceilPos.x} ${ceilPos.y} ${ceilPos.z} sea_lantern`);
          await this.sleep(20);
        }
      } else {
        if (!ceilBlk || ceilBlk.name !== "smooth_stone") {
          this.bot.chat(`/setblock ${ceilPos.x} ${ceilPos.y} ${ceilPos.z} smooth_stone`);
          await this.sleep(20);
        }
      }
    }
  }

  /**
   * Automatically places a chest at coordinates if none exists, or equips a chest if needed
   */
  async ensureAndPlaceChest(chestVec) {
    let chestBlock = this.bot.blockAt(chestVec);
    if (chestBlock && chestBlock.name.includes("chest")) {
      return chestBlock;
    }

    addLog(`[Auto-Chest] No chest found at ${chestVec}. Deploying chest automatically...`, "Inventory");

    // Ensure bot has chests in inventory
    const chestItem = this.bot.inventory.items().find((i) => i.name.includes("chest"));
    if (!chestItem) {
      this.bot.chat(`/give ${this.bot.username} chest 64`);
      await this.sleep(300);
    }

    try {
      // Check support block beneath
      const belowVec = chestVec.offset(0, -1, 0);
      let belowBlock = this.bot.blockAt(belowVec);
      if (!belowBlock || belowBlock.name === "air" || belowBlock.name.includes("air")) {
        this.bot.chat(`/setblock ${belowVec.x} ${belowVec.y} ${belowVec.z} cobblestone`);
        await this.sleep(150);
      }

      // If existing block at chest position is obstacle (dirt, stone), dig it first
      if (chestBlock && chestBlock.name !== "air" && !chestBlock.name.includes("air")) {
        await this.breakAndCollectBlock(chestBlock);
      }

      // Place Chest
      const cItem = this.bot.inventory.items().find((i) => i.name === "chest" || i.name.includes("chest"));
      if (cItem) {
        await this.bot.equip(cItem, "hand");
        belowBlock = this.bot.blockAt(belowVec);
        if (belowBlock) {
          try {
            await this.bot.placeBlock(belowBlock, new Vec3(0, 1, 0));
            await this.sleep(250);
          } catch (_) {}
        }
      }

      chestBlock = this.bot.blockAt(chestVec);
      if (!chestBlock || !chestBlock.name.includes("chest")) {
        this.bot.chat(`/setblock ${chestVec.x} ${chestVec.y} ${chestVec.z} chest`);
        await this.sleep(200);
        chestBlock = this.bot.blockAt(chestVec);
      }

      addLog(`[Auto-Chest] Chest successfully deployed at (${chestVec.x}, ${chestVec.y}, ${chestVec.z})!`, "Inventory");
      return chestBlock;
    } catch (e) {
      addLog(`[Auto-Chest] Placement fallback: ${e.message}. Using setblock...`, "Inventory");
      this.bot.chat(`/setblock ${chestVec.x} ${chestVec.y} ${chestVec.z} chest`);
      await this.sleep(200);
      return this.bot.blockAt(chestVec);
    }
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
      const dist = this.bot.entity ? this.bot.entity.position.distanceTo(chestVec) : 999;
      if (dist > 3) {
        this.bot.chat(`/tp ${this.bot.username} ${chestCoords.x} ${chestCoords.y} ${chestCoords.z}`);
        await this.sleep(600);
      } else {
        try {
          await this.bot.pathfinder.goto(new GoalNear(chestVec.x, chestVec.y, chestVec.z, 2));
        } catch (_) {}
      }

      this.state = "DEPOSITING_SORTING";
      let chestBlock = await this.ensureAndPlaceChest(chestVec);

      if (!chestBlock || !chestBlock.name.includes("chest")) {
        addLog(`[Chest Error] Could not find or deploy chest at (${chestVec.x}, ${chestVec.y}, ${chestVec.z})!`, "Inventory");
        return false;
      }

      // Batch deliver collected mined blocks directly into inventory in 1 quick batch
      if (this.collectedDrops) {
        for (const [itemName, count] of Object.entries(this.collectedDrops)) {
          if (count > 0) {
            this.bot.chat(`/give ${this.bot.username} ${itemName} ${count}`);
            await this.sleep(150);
          }
        }
        this.collectedDrops = {};
      }

      addLog("[Chest] Opening container and sorting all items...", "Inventory");
      let container = await this.bot.openContainer(chestBlock);

      // Get all deposit-eligible items (Tier >= 1) sorted by category priority
      const itemsToDeposit = this.bot.inventory
        .items()
        .filter((item) => this.getItemSortTier(item) > 0)
        .sort((a, b) => this.getItemSortTier(a) - this.getItemSortTier(b));

      let depositedCount = 0;
      for (const item of itemsToDeposit) {
        if (!this.bot || !this.bot.entity) break;
        try {
          await container.deposit(item.type, null, item.count);
          depositedCount += item.count;
          await this.sleep(60);
        } catch (depositErr) {
          if (depositErr.message && depositErr.message.includes("full")) {
            addLog("[Chest Warning] Chest is full! Auto-expanding storage with adjacent chest...", "Inventory");
            try { container.close(); } catch (_) {}

            // Auto-expand: place second chest on adjacent block
            const adjacentOffsets = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
            for (const off of adjacentOffsets) {
              const adjVec = chestVec.plus(off);
              const adjBlock = this.bot.blockAt(adjVec);
              if (adjBlock && (adjBlock.name === "air" || !adjBlock.name.includes("chest"))) {
                await this.ensureAndPlaceChest(adjVec);
                chestBlock = this.bot.blockAt(adjVec);
                if (chestBlock && chestBlock.name.includes("chest")) {
                  container = await this.bot.openContainer(chestBlock);
                  break;
                }
              }
            }
          }
        }
      }

      try { container.close(); } catch (_) {}
      this.stats.chestTrips++;
      addLog(`[Chest] Successfully deposited and sorted ${depositedCount} items. (Trip #${this.stats.chestTrips})`, "Inventory");
      return true;
    } catch (err) {
      addLog(`[Chest Error] Deposit hitch: ${err.message}`, "Inventory");
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

    const startBlocksMined = this.stats.totalBlocksMined;
    const targetBlocks = distanceLength || 100;

    if (durationMode === "timed") {
      this.missionEndTime = Date.now() + durationMinutes * 60 * 1000;
      addLog(`[Mission] Launched Timed Mission (${durationMinutes} mins, ${size}) at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`, "Miner");
    } else if (durationMode === "distance") {
      this.missionEndTime = 0;
      addLog(`[Mission] Launched Target Block Mission (${targetBlocks} blocks, ${size}) at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`, "Miner");
    } else {
      this.missionEndTime = 0;
      addLog(`[Mission] Launched 24/7 Continuous Mission (${size}) at (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})`, "Miner");
    }

    // Step 1: Navigate to Mining Site
    this.state = "TRAVELING_TO_MINE";
    const mineVec = new Vec3(mineCoords.x, mineCoords.y, mineCoords.z);
    const dist = this.bot.entity ? this.bot.entity.position.distanceTo(mineVec) : 999;

    addLog(`[Navigation] Positioning ${this.bot.username} at Mine Coordinates (${mineCoords.x}, ${mineCoords.y}, ${mineCoords.z})...`, "Miner");
    if (dist > 3) {
      this.bot.chat(`/tp ${this.bot.username} ${mineCoords.x} ${mineCoords.y} ${mineCoords.z}`);
      await this.sleep(600);
    } else {
      try {
        await this.bot.pathfinder.goto(new GoalNear(mineVec.x, mineVec.y, mineVec.z, 2));
      } catch (_) {}
    }
    addLog(`[Navigation] Reached mining destination. Starting excavation...`, "Miner");

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
        this.bot.chat(`⏳ Mission timer of ${durationMinutes} minutes completed! Returning to deposit...`);
        addLog("[Mission] Timer expired! Concluding mining mission.", "Miner");
        break;
      }

      // Check Exact Block Count Limit
      const currentMinedCount = this.stats.totalBlocksMined - startBlocksMined;
      if (durationMode === "distance" && currentMinedCount >= targetBlocks) {
        this.bot.chat(`🎯 Target limit of ${targetBlocks} blocks reached (${currentMinedCount} blocks mined)! Returning to chest to deposit everything...`);
        addLog(`[Mission] Target block limit of ${targetBlocks} reached (${currentMinedCount} blocks mined)!`, "Miner");
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
      if (strategy === "strip_mine" || strategy === "highway_builder" || strategy === "highway") {
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
        } else if (size === "5x5" || strategy.includes("highway")) {
          minX = -2; maxX = 2; minY = 0; maxY = 4;
        }

        // Dig out full cross-section slice
        for (let dy = maxY; dy >= minY; dy--) {
          for (let dx = minX; dx <= maxX; dx++) {
            if (this.shouldStop) break;
            const currentMined = this.stats.totalBlocksMined - startBlocksMined;
            if (durationMode === "distance" && currentMined >= targetBlocks) {
              break;
            }

            const targetPos = nextFoot.plus(lateralVec.scaled(dx)).offset(0, dy, 0);
            const blk = this.bot.blockAt(targetPos);
            if (blk && blk.name !== "air" && !blk.name.includes("air")) {
              await this.breakAndCollectBlock(blk);
              const updatedMined = this.stats.totalBlocksMined - startBlocksMined;
              if (updatedMined % 25 === 0 && durationMode === "distance") {
                this.bot.chat(`⛏️ Progress: ${updatedMined} / ${targetBlocks} blocks mined`);
              }
            }
          }
          const currentMined = this.stats.totalBlocksMined - startBlocksMined;
          if (durationMode === "distance" && currentMined >= targetBlocks) {
            break;
          }
        }

        const currentMined = this.stats.totalBlocksMined - startBlocksMined;
        if (durationMode === "distance" && currentMined >= targetBlocks) {
          this.bot.chat(`🎯 Target limit of ${targetBlocks} blocks reached (${currentMined} blocks mined)! Returning to chest to deposit...`);
          break;
        }

        // Auto-Seal any lava or water breaches around the slice
        await this.sealFluidHazards(nextFoot, minX, maxX, minY, maxY, lateralVec);

        // If Highway Builder mode, construct architectural lining (stone bricks, smooth stone, sea lanterns)
        if (strategy.includes("highway")) {
          await this.constructHighwaySlice(nextFoot, minX, maxX, minY, maxY, lateralVec, distanceCovered);
        } else {
          // Standard Mining: Auto-bridge foundation & place torches
          await this.ensureFloorBridge(nextFoot, minX, maxX, lateralVec);
          if (distanceCovered % 8 === 0) {
            await this.placeTorch(this.bot.entity.position.floored());
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
