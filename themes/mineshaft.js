/**
 * ⛏️ Classic Western Timber Mineshaft Theme
 * Stripped Oak Log support archways with Oak Fences, realistic dirt/cobble trackbed, central rail line, and hanging lanterns.
 */
module.exports = {
  name: "mineshaft",
  description: "Classic Western Timber Mineshaft",

  async buildSlice(bot, foot, lateralVec, distanceCovered, bounds = { minX: -2, maxX: 2, minY: 0, maxY: 4 }) {
    const { minX, maxX, minY, maxY } = bounds;
    const isFrameInterval = (distanceCovered % 4 === 0);
    const isLightInterval = (distanceCovered % 6 === 0);

    const f1 = foot.plus(lateralVec.scaled(minX)).offset(0, minY - 1, 0).floored();
    const f2 = foot.plus(lateralVec.scaled(maxX)).offset(0, minY - 1, 0).floored();
    const lw1 = foot.plus(lateralVec.scaled(minX - 1)).offset(0, minY, 0).floored();
    const lw2 = foot.plus(lateralVec.scaled(minX - 1)).offset(0, maxY, 0).floored();
    const rw1 = foot.plus(lateralVec.scaled(maxX + 1)).offset(0, minY, 0).floored();
    const rw2 = foot.plus(lateralVec.scaled(maxX + 1)).offset(0, maxY, 0).floored();
    const c1 = foot.plus(lateralVec.scaled(minX)).offset(0, maxY + 1, 0).floored();
    const c2 = foot.plus(lateralVec.scaled(maxX)).offset(0, maxY + 1, 0).floored();

    // 1. Floor: Natural Cobblestone & Gravel Trackbed
    bot.chat(`/fill ${f1.x} ${f1.y} ${f1.z} ${f2.x} ${f2.y} ${f2.z} cobblestone`);

    // 2. Walls: Oak Log Timber Framing on intervals, otherwise Oak Planks
    const wallBlock = isFrameInterval ? "oak_log" : "oak_planks";
    bot.chat(`/fill ${lw1.x} ${lw1.y} ${lw1.z} ${lw2.x} ${lw2.y} ${lw2.z} ${wallBlock}`);
    bot.chat(`/fill ${rw1.x} ${rw1.y} ${rw1.z} ${rw2.x} ${rw2.y} ${rw2.z} ${wallBlock}`);

    // 3. Ceiling: Oak Crossbeam Arch on intervals
    const ceilBlock = isFrameInterval ? "oak_log" : "oak_planks";
    bot.chat(`/fill ${c1.x} ${c1.y} ${c1.z} ${c2.x} ${c2.y} ${c2.z} ${ceilBlock}`);

    // 4. Central Rail Track
    const railPos = foot.offset(0, minY, 0).floored();
    bot.chat(`/setblock ${railPos.x} ${railPos.y} ${railPos.z} rail`);

    // 5. Hanging Mine Lantern
    if (isLightInterval) {
      const lanternPos = foot.offset(0, maxY, 0).floored();
      bot.chat(`/setblock ${lanternPos.x} ${lanternPos.y} ${lanternPos.z} lantern[hanging=true]`);
    }
  }
};
