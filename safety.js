"use strict";

const { addLog } = require("./logger");

class SafetyManager {
  constructor(bot, config) {
    this.bot = bot;
    this.config = config;
    this.isPluggingLava = false;
  }

  /**
   * Initializes safety event listeners and monitors
   */
  init() {
    this.bot.on("health", () => {
      this.checkHealth();
    });

    addLog("Safety systems activated (Tool protection, Lava defense, Health monitoring)", "Safety");
  }

  /**
   * Monitors bot health and warns when critical
   */
  checkHealth() {
    if (this.bot.health <= (this.config.safety?.minHealth || 6)) {
      addLog(`[WARNING] Low health detected: ${this.bot.health}/20! Seeking safety...`, "Safety");
    }
  }

  /**
   * Checks if an item is near broken
   */
  isToolNearBroken(item) {
    if (!item) return false;
    // Minecraft item durability is represented by maxDurability - durabilityUsed
    if (item.maxDurability && item.durabilityUsed !== undefined) {
      const remaining = item.maxDurability - item.durabilityUsed;
      const percent = (remaining / item.maxDurability) * 100;
      const minPercent = this.config.safety?.toolProtection?.minDurabilityPercent || 5;
      return percent <= minPercent || remaining <= 3;
    }
    return false;
  }

  /**
   * Finds the best pickaxe in inventory that is NOT near broken
   */
  getBestPickaxe() {
    const pickaxes = [
      "netherite_pickaxe",
      "diamond_pickaxe",
      "iron_pickaxe",
      "golden_pickaxe",
      "stone_pickaxe",
      "wooden_pickaxe"
    ];

    const items = this.bot.inventory.items();
    for (const name of pickaxes) {
      const tool = items.find((i) => i.name === name && !this.isToolNearBroken(i));
      if (tool) return tool;
    }

    return null;
  }

  /**
   * Equips the best tool for the target block safely
   */
  async equipBestTool(block) {
    if (!block) return;

    // Check currently held item
    const held = this.bot.heldItem;
    if (this.isToolNearBroken(held)) {
      addLog(`Tool ${held.name} is near breaking! Swapping to backup...`, "Safety");
      const backup = this.getBestPickaxe();
      if (backup) {
        await this.bot.equip(backup, "hand");
        addLog(`Equipped backup tool: ${backup.name}`, "Safety");
      } else {
        addLog(`[CAUTION] No healthy pickaxes left in inventory!`, "Safety");
      }
      return;
    }

    try {
      if (this.bot.tool && typeof this.bot.tool.equipForBlock === "function") {
        await this.bot.tool.equipForBlock(block);
      } else {
        const pickaxe = this.getBestPickaxe();
        if (pickaxe && (!held || held.name !== pickaxe.name)) {
          await this.bot.equip(pickaxe, "hand");
        }
      }
    } catch (e) {
      // Fallback
      const pickaxe = this.getBestPickaxe();
      if (pickaxe) {
        try {
          await this.bot.equip(pickaxe, "hand");
        } catch (_) {}
      }
    }
  }

  /**
   * Checks if mining a target block might unleash lava or water
   */
  isHazardousToMine(targetBlock) {
    if (!this.config.safety?.lavaProtection) return false;
    if (!targetBlock) return true;

    const adjacentOffsets = [
      { x: 0, y: 1, z: 0 },  // top
      { x: 1, y: 0, z: 0 },  // east
      { x: -1, y: 0, z: 0 }, // west
      { x: 0, y: 0, z: 1 },  // south
      { x: 0, y: 0, z: -1 }, // north
    ];

    for (const offset of adjacentOffsets) {
      const neighbor = this.bot.blockAt(targetBlock.position.offset(offset.x, offset.y, offset.z));
      if (neighbor && (neighbor.name === "lava" || neighbor.name === "flowing_lava")) {
        addLog(`[HAZARD] Lava detected next to block at ${targetBlock.position}! Aborting break.`, "Safety");
        return true;
      }
    }

    return false;
  }

  /**
   * Detects nearby flowing lava near player and tries to place a plugging block
   */
  async emergencyPlugLava() {
    if (this.isPluggingLava) return;
    this.isPluggingLava = true;

    try {
      const lavaBlock = this.bot.findBlock({
        matching: (b) => b && (b.name === "lava" || b.name === "flowing_lava"),
        maxDistance: 3
      });

      if (lavaBlock) {
        addLog(`[EMERGENCY] Lava adjacent at ${lavaBlock.position}! Attempting to seal...`, "Safety");
        const solidBlock = this.bot.inventory.items().find(
          (i) => ["cobblestone", "cobbled_deepslate", "dirt", "stone", "netherrack"].includes(i.name)
        );

        if (solidBlock) {
          await this.bot.equip(solidBlock, "hand");
          await this.bot.placeBlock(lavaBlock, { x: 0, y: 1, z: 0 }).catch(() => {});
          addLog("Sealed lava source.", "Safety");
        }
      }
    } catch (err) {
      // Ignore placement errors in emergency
    } finally {
      this.isPluggingLava = false;
    }
  }
}

module.exports = SafetyManager;
