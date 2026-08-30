# ⛏️ Minecraft Miner Bot & Mission Control

An autonomous, 24/7 production-ready Minecraft Miner Bot built with Node.js and Mineflayer. Designed for multiplayer servers (Aternos, PaperMC, Spigot, Fabric, VPS, LAN).

---

## ✨ Features

- 📍 **Interactive Mission Control UI**: Set exact **Mining Site Coordinates** and **Deposit Chest Coordinates** directly in your browser with 1-click position buttons.
- 📦 **Universal Item Collector (No Exclusions)**: Collects 100% of broken blocks, ores, minerals, wood, and drops and brings them all back.
- 🗂️ **Automated Chest Sorting**: Organizes items into prioritized tiers (Precious Ores ➔ Minerals ➔ Wood ➔ Building Blocks) and merges stacks neatly into the chest.
- 🔄 **Autonomous Round-Trip Engine**:
  1. Navigates to mining coordinates.
  2. Mines continuously.
  3. When inventory reaches capacity, automatically pauses, returns to base chest, deposits and sorts all items, and returns back to the mining site to resume!
  4. Returns and idles upon mission completion.
- ⏳ **Flexible Mining Duration**:
  - ♾️ **Continuous (24/7 Infinite Auto-Loop)**
  - ⏱️ **Timed Duration** (15m, 30m, 1h, 2h, custom)
  - 📏 **Distance / Volume Limit** (e.g. 100 blocks forward)
- 🛡️ **Tool & Durability Protection**: Auto-swaps pickaxes before they break (<5% durability).
- 🍖 **Auto-Eat**: Automatically feeds the bot when hunger drops below 14.

---

## 🎮 How to Control the Bot

### 1. Through the Browser Dashboard (Recommended):
Open **`http://localhost:5000`** in your browser:
* Click **"🚀 Mission Control"**
* Set Mining Coordinates & Chest Coordinates (or click **"📌 Use Current Bot Position"**)
* Select Strategy (`Strip Mine 1x2`, `Ore Hunter`, `Tree Chopper`)
* Select Duration (`Continuous 24/7`, `30 Mins`, `1 Hour`, or `100 Blocks`)
* Click **"🚀 Launch Autonomous Mission"**

### 2. In-Game Chat Commands:
| Command | Description | Example |
| :--- | :--- | :--- |
| `!mission <mineX> <mineY> <mineZ> <chestX> <chestY> <chestZ> [minutes]` | Launch full coordinate mining mission with chest deposit | `!mission 100 -58 200 0 64 0 45` |
| `!stop` | Abort mission and idle | `!stop` |
| `!deposit` | Walk to configured home chest and deposit all items | `!deposit` |
| `!coords` | Print bot's current coordinates | `!coords` |
| `!stats` | Print total mined ores and blocks | `!stats` |
| `!follow` | Follow commanding player | `!follow` |

---

## 🚀 How to Run

```bash
cd "e:\Minecraft Bots\Minecraft Miner bot"
npm install
npm start
```
