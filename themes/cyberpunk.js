/**
 * 🌌 Cyberpunk & Sci-Fi Neon Corridor Theme
 * High-contrast Black Concrete bunker shell with Polished Basalt columns and Cyan/Magenta neon glow runners.
 */
module.exports = {
  name: "cyberpunk",
  description: "Cyberpunk / Sci-Fi Neon Corridor",

  async buildSlice(bot, foot, lateralVec, distanceCovered, bounds = { minX: -2, maxX: 2, minY: 0, maxY: 4 }) {
    const { minX, maxX, minY, maxY } = bounds;
    const isColumnInterval = (distanceCovered % 4 === 0);
    const isLightInterval = (distanceCovered % 6 === 0);

    const f1 = foot.plus(lateralVec.scaled(minX)).offset(0, minY - 1, 0).floored();
    const f2 = foot.plus(lateralVec.scaled(maxX)).offset(0, minY - 1, 0).floored();
    const lw1 = foot.plus(lateralVec.scaled(minX - 1)).offset(0, minY, 0).floored();
    const lw2 = foot.plus(lateralVec.scaled(minX - 1)).offset(0, maxY, 0).floored();
    const rw1 = foot.plus(lateralVec.scaled(maxX + 1)).offset(0, minY, 0).floored();
    const rw2 = foot.plus(lateralVec.scaled(maxX + 1)).offset(0, maxY, 0).floored();
    const c1 = foot.plus(lateralVec.scaled(minX)).offset(0, maxY + 1, 0).floored();
    const c2 = foot.plus(lateralVec.scaled(maxX)).offset(0, maxY + 1, 0).floored();

    // 1. Floor: Reinforced Obsidian
    bot.chat(`/fill ${f1.x} ${f1.y} ${f1.z} ${f2.x} ${f2.y} ${f2.z} obsidian`);

    // 2. Walls: Polished Basalt support columns every 4 blocks, otherwise Black Concrete
    const wallBlock = isColumnInterval ? "polished_basalt" : "black_concrete";
    bot.chat(`/fill ${lw1.x} ${lw1.y} ${lw1.z} ${lw2.x} ${lw2.y} ${lw2.z} ${wallBlock}`);
    bot.chat(`/fill ${rw1.x} ${rw1.y} ${rw1.z} ${rw2.x} ${rw2.y} ${rw2.z} ${wallBlock}`);

    // 3. Ceiling: Magenta Stained Glass center runner over Smooth Quartz
    const ceilBlock = isLightInterval ? "magenta_stained_glass" : "smooth_quartz";
    bot.chat(`/fill ${c1.x} ${c1.y} ${c1.z} ${c2.x} ${c2.y} ${c2.z} ${ceilBlock}`);

    // 4. Floor Neon Light Track: Cyan Stained Glass
    const glowFoot = foot.offset(0, minY - 1, 0).floored();
    bot.chat(`/setblock ${glowFoot.x} ${glowFoot.y} ${glowFoot.z} cyan_stained_glass`);
  }
};
