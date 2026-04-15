/**
 * Load Tracker - LM Link Multi-Device Orchestration
 * Tracks request timing and enforces concurrency limits per device
 */

import { deviceRegistry } from './device-registry.js';

/**
 * Type Definitions
 */
export interface LoadState {
  deviceId: string;
  modelKey?: string;
  activeRequests: number;
  lastRequestStart: string | null;
  cooldownUntil: string | null;
  totalToday: number;
}

export interface LoadLimitConfig {
  maxConcurrent: number;
  cooldownMs: number;
}

/**
 * Load Tracker class for managing request concurrency
 */
export class LoadTracker {
  private _loadState: Map<string, LoadState> = new Map();
  private readonly MAX_CONCURRENT_DEFAULT: number;
  private readonly COOLDOWN_MS: number;

  constructor() {
    this.MAX_CONCURRENT_DEFAULT = parseInt(
      process.env.DEFAULT_DEVICE_CONCURRENT_LIMIT || '2',
      10
    );
    this.COOLDOWN_MS = parseInt(
      process.env.DEVICE_COOLDOWN_MS || '1000',
      10
    );
  }

  /**
   * Get current load state for a device
   */
  async getLoadState(deviceId: string): Promise<LoadState> {
    await this.ensureDeviceState(deviceId);
    
    const state = this._loadState.get(deviceId);
    if (!state) {
      return {
        deviceId,
        activeRequests: 0,
        lastRequestStart: null,
        cooldownUntil: null,
        totalToday: 0
      };
    }
    
    // Check if cooldown has expired
    if (state.cooldownUntil && new Date(state.cooldownUntil) < new Date()) {
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      state.cooldownUntil = null;
      this._loadState.set(deviceId, state);
    }
    
    return state;
  }

  /**
   * Increment active requests for a device
   */
  async incrementRequest(deviceId: string): Promise<boolean> {
    await this.ensureDeviceState(deviceId);
    
    const state = this._loadState.get(deviceId);
    if (!state) return false;

    // Check if we're at capacity
    if (state.activeRequests >= this.MAX_CONCURRENT_DEFAULT) {
      console.log(`[LoadTracker] Device ${deviceId} at capacity (${state.activeRequests}/${this.MAX_CONCURRENT_DEFAULT})`);
      return false;
    }

    state.activeRequests++;
    state.lastRequestStart = new Date().toISOString();
    this._loadState.set(deviceId, state);
    
    // Update device registry
    deviceRegistry.updateLoad(deviceId, state.activeRequests, state.totalToday);
    
    console.log(`[LoadTracker] Device ${deviceId}: +1 request (active: ${state.activeRequests})`);
    return true;
  }

  /**
   * Decrement active requests for a device
   */
  async decrementRequest(deviceId: string): Promise<void> {
    await this.ensureDeviceState(deviceId);
    
    const state = this._loadState.get(deviceId);
    if (!state) return;

    state.activeRequests = Math.max(0, state.activeRequests - 1);
    state.totalToday++;
    state.cooldownUntil = new Date(Date.now() + this.COOLDOWN_MS).toISOString();
    
    this._loadState.set(deviceId, state);
    
    // Update device registry
    deviceRegistry.updateLoad(deviceId, state.activeRequests, state.totalToday);
    
    console.log(`[LoadTracker] Device ${deviceId}: -1 request (active: ${state.activeRequests})`);
  }

  /**
   * Check if a device can handle more requests
   */
  async canHandleRequest(deviceId: string): Promise<boolean> {
    const state = await this.getLoadState(deviceId);
    
    // Check cooldown
    if (state.cooldownUntil && new Date(state.cooldownUntil) > new Date()) {
      return false;
    }
    
    return state.activeRequests < this.MAX_CONCURRENT_DEFAULT;
  }

  /**
   * Get least loaded device from available devices
   */
  async getLeastLoadedDevice(deviceIds: string[]): Promise<string | null> {
    let bestDevice: string | null = null;
    let minLoad = Infinity;

    for (const deviceId of deviceIds) {
      if (!await this.canHandleRequest(deviceId)) continue;
      
      const state = await this.getLoadState(deviceId);
      const loadScore = state.activeRequests / this.MAX_CONCURRENT_DEFAULT;
      
      // Lower load score is better
      if (loadScore < minLoad) {
        minLoad = loadScore;
        bestDevice = deviceId;
      }
    }

    return bestDevice;
  }

  /**
   * Ensure device has a load state entry
   */
  private async ensureDeviceState(deviceId: string): Promise<void> {
    if (!this._loadState.has(deviceId)) {
      this._loadState.set(deviceId, {
        deviceId,
        activeRequests: 0,
        lastRequestStart: null,
        cooldownUntil: null,
        totalToday: 0
      });
    }
  }

  /**
   * Clear load state for all devices
   */
  clearAll(): void {
    this._loadState.clear();
  }

  /**
   * Get all load states
   */
  getAllStates(): LoadState[] {
    return Array.from(this._loadState.values());
  }
}

// Export singleton instance
export const loadTracker = new LoadTracker();