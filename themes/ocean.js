/**
 * 🌊 Glass Aquarium & Ocean Dome Theme
 * 360° transparent hydro-dome with Dark Prismarine support ribs and luminescent Sea Lantern runners.
 */
module.exports = {
  name: "ocean",
  description: "Glass Aquarium & Ocean Dome",

  async buildSlice(bot, foot, lateralVec, distanceCovered, bounds = { minX: -2, maxX: 2, minY: 0, maxY: 4 }) {
    const { minX, maxX, minY, maxY } = bounds;
    const isRibInterval = (distanceCovered % 5 === 0);

    const f1 = foot.plus(lateralVec.scaled(minX)).offset(0, minY - 1, 0).floored();
    const f2 = foot.plus(lateralVec.scaled(maxX)).offset(0, minY - 1, 0).floored();
    const lw1 = foot.plus(lateralVec.scaled(minX - 1)).offset(0, minY, 0).floored();
    const lw2 = foot.plus(lateralVec.scaled(minX - 1)).offset(0, maxY, 0).floored();
    const rw1 = foot.plus(lateralVec.scaled(maxX + 1)).offset(0, minY, 0).floored();
    const rw2 = foot.plus(lateralVec.scaled(maxX + 1)).offset(0, maxY, 0).floored();
    const c1 = foot.plus(lateralVec.scaled(minX)).offset(0, maxY + 1, 0).floored();
    const c2 = foot.plus(lateralVec.scaled(maxX)).offset(0, maxY + 1, 0).floored();

    // 1. Floor: Prismarine Bricks
    bot.chat(`/fill ${f1.x} ${f1.y} ${f1.z} ${f2.x} ${f2.y} ${f2.z} prismarine_bricks`);

    // 2. Walls: Dark Prismarine ribs every 5 blocks, otherwise clear Glass
    const wallBlock = isRibInterval ? "dark_prismarine" : "glass";
    bot.chat(`/fill ${lw1.x} ${lw1.y} ${lw1.z} ${lw2.x} ${lw2.y} ${lw2.z} ${wallBlock}`);
    bot.chat(`/fill ${rw1.x} ${rw1.y} ${rw1.z} ${rw2.x} ${rw2.y} ${rw2.z} ${wallBlock}`);

    // 3. Ceiling Dome: Dark Prismarine rib or clear Glass
    const ceilBlock = isRibInterval ? "dark_prismarine" : "glass";
    bot.chat(`/fill ${c1.x} ${c1.y} ${c1.z} ${c2.x} ${c2.y} ${c2.z} ${ceilBlock}`);

    // 4. Luminescent Floor Glow Runner
    if (isRibInterval) {
      const seaLight = foot.offset(0, minY - 1, 0).floored();
      bot.chat(`/setblock ${seaLight.x} ${seaLight.y} ${seaLight.z} sea_lantern`);
    }
  }
};
