/**
 * 🏛️ Master Theme Registry & Dispatcher
 * Manages all architectural themes and staircase builders with coordinate sanitization and error boundaries.
 */
const castle = require("./castle");
const ocean = require("./ocean");
const cyberpunk = require("./cyberpunk");
const subway = require("./subway");
const mineshaft = require("./mineshaft");
const nether = require("./nether");
const highway = require("./highway");
const staircase = require("./staircase");

const themes = {
  castle,
  dungeon: castle,
  ocean,
  aquarium: ocean,
  glass: ocean,
  cyberpunk,
  cyber: cyberpunk,
  neon: cyberpunk,
  subway,
  railway: subway,
  mineshaft,
  mine: mineshaft,
  shaft: mineshaft,
  nether,
  vault: nether,
  nether_vault: nether,
  highway,
  highway_builder: highway
};

module.exports = {
  themes,
  staircase,

  /**
   * Resolves theme name to its dedicated module
   */
  getTheme(name = "highway") {
    const raw = (name || "highway").toLowerCase().replace(/_up|_down/g, "");
    for (const [key, module] of Object.entries(themes)) {
      if (raw.includes(key)) return module;
    }
    return highway;
  },

  /**
   * Dispatches slice construction to the appropriate theme builder
   */
  async buildThemeSlice(bot, themeName, foot, lateralVec, distanceCovered, bounds) {
    const themeModule = this.getTheme(themeName);
    try {
      await themeModule.buildSlice(bot, foot.floored(), lateralVec, distanceCovered, bounds);
    } catch (err) {
      console.error(`[Theme Error] Failed building slice for ${themeName}:`, err.message);
    }
  },

  /**
   * Dispatches staircase step placement
   */
  async buildStairStep(bot, stepPos, slope, direction, themeName) {
    try {
      await staircase.placeStep(bot, stepPos.floored(), slope, direction, themeName);
    } catch (err) {
      console.error(`[Staircase Error] Failed building stair step:`, err.message);
    }
  }
};
