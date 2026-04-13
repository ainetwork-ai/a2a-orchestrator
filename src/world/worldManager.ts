import { World } from "./world";

// Singleton pattern for managing the World instance
class WorldManager {
  private static instance: WorldManager;
  private world: World | null = null;

  private constructor() {}

  static getInstance(): WorldManager {
    if (!WorldManager.instance) {
      WorldManager.instance = new WorldManager();
    }
    return WorldManager.instance;
  }

  initWorld(apiUrl: string, model: string): World {
    if (!this.world) {
      this.world = new World(apiUrl, model, "legacy", []);
    }
    return this.world;
  }

  getWorld(): World | null {
    return this.world;
  }

  resetWorld(apiUrl: string, model: string): World {
    this.world = new World(apiUrl, model, "legacy", []);
    return this.world;
  }
}

export default WorldManager;
