/**
 * 📐 Universal Dual-Direction Staircase Engine (Stairs Down & Stairs Up)
 * Places orientation-aware stairs matching any architectural theme with solid sub-floor bridging.
 */
module.exports = {
  name: "staircase",
  description: "Universal Dual-Direction Staircase Engine",

  getStairBlockForTheme(theme = "highway") {
    const t = (theme || "").toLowerCase();
    if (t.includes("subway") || t.includes("rail")) return "deepslate_tile_stairs";
    if (t.includes("castle") || t.includes("dungeon")) return "stone_brick_stairs";
    if (t.includes("cyber") || t.includes("neon")) return "quartz_stairs";
    if (t.includes("nether") || t.includes("vault")) return "polished_blackstone_brick_stairs";
    if (t.includes("mine") || t.includes("shaft")) return "oak_stairs";
    if (t.includes("ocean") || t.includes("aquarium")) return "prismarine_brick_stairs";
    return "stone_brick_stairs";
  },

  async placeStep(bot, stepPos, slope = "down", direction = "north", theme = "highway") {
    const stairBlock = this.getStairBlockForTheme(theme);
    const dirMap = { north: "south", south: "north", east: "west", west: "east" };
    const facing = slope === "down" ? (dirMap[direction.toLowerCase()] || "south") : (direction.toLowerCase() || "north");
    const sp = stepPos.floored();

    // 1. Place Stair Block with facing direction
    bot.chat(`/setblock ${sp.x} ${sp.y} ${sp.z} ${stairBlock}[facing=${facing}]`);

    // 2. Solid Foundation Block Beneath Stair
    const under = sp.offset(0, -1, 0);
    bot.chat(`/setblock ${under.x} ${under.y} ${under.z} cobblestone`);
  }
};
