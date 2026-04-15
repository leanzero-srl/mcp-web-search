/**
 * Device Registry - LM Link Multi-Device Orchestration
 * Discovers and tracks all LM Studio devices connected via LM Link/Tailscale mesh VPN.
 */

import os from 'node:os';
import { URL } from 'url';

/**
 * Type Definitions
 */
export interface DeviceInfo {
  id: string;                    // Tailscale node ID or hostname
  name: string;                  // Human-readable device name
  status: 'online' | 'offline';  // Device health status
  tier: 'low' | 'medium' | 'high' | 'ultra';
  
  // Hardware info (from Node.js OS module)
  ramGB: number;
  cpuCores: number;
  cpuModel?: string;
  cpuSpeedMHz?: number[];
  gpuAvailable: boolean;
  gpuInfo?: GPUInfo;
  
  // LM Studio specific
  port: number;
  models: string[];              // Model keys available on this device
  
  load: LoadState;
}

export interface GPUInfo {
  vendor?: string;
  renderer?: string;
  videoMemoryMB?: number;
}

export interface LoadState {
  activeRequests: number;
  totalToday: number;
  cooldownUntil: Date | null;
}

/**
 * Device Registry class for managing LM Link connected devices
 */
export class DeviceRegistry {
  private _devices: Map<string, DeviceInfo> = new Map();
  private _lastDiscovery: number = 0;
  private readonly DISCOVERY_INTERVAL_MS: number;

  constructor() {
    this.DISCOVERY_INTERVAL_MS = parseInt(
      process.env.DEVICE_DISCOVERY_INTERVAL_MS || '30000',
      10
    );
    
    // Check for GPU availability (browser-only, so default to false in Node.js)
    const gpuAvailable = typeof navigator !== 'undefined' && 
                        'gpu' in navigator;
    
    this._localHardware = {
      ramGB: this.getSystemRAM(),
      cpuCores: this.getCPUCoreCount(),
      cpuModel: this.getCPUModel(),
      cpuSpeedMHz: this.getCPU_SPEEDS(),
      gpuAvailable: gpuAvailable,
    };
  }

  // Cache local hardware info
  private _localHardware: {
    ramGB: number;
    cpuCores: number;
    cpuModel?: string;
    cpuSpeedMHz?: number[];
    gpuAvailable: boolean;
  };

  /**
   * Discover all devices connected via LM Link
   */
  async discoverDevices(): Promise<DeviceInfo[]> {
    const now = Date.now();

    // Use cached results if within discovery interval
    if (now - this._lastDiscovery < this.DISCOVERY_INTERVAL_MS && this._devices.size > 0) {
      return Array.from(this._devices.values());
    }

    try {
      const devices: DeviceInfo[] = [];

      // Add local device (always available)
      devices.push({
        id: 'device-local',
        name: this.getHostname() || 'Local Device',
        status: 'online',
        tier: this.detectTier(),
        ramGB: this._localHardware.ramGB,
        cpuCores: this._localHardware.cpuCores,
        cpuModel: this._localHardware.cpuModel,
        cpuSpeedMHz: this._localHardware.cpuSpeedMHz,
        gpuAvailable: this._localHardware.gpuAvailable,
        port: 1234, // Default LM Studio port
        models: [],
        load: { activeRequests: 0, totalToday: 0, cooldownUntil: null }
      });

      // Check for remote devices via environment variable (for testing)
      const remoteDevices = process.env.LM_LINK_REMOTE_DEVICES;
      if (remoteDevices) {
        const deviceIds = remoteDevices.split(',').map(d => d.trim());

        for (const deviceId of deviceIds) {
          // Validate hostname/IP format
          try {
            this.validateRemoteDeviceId(deviceId);
            
            devices.push({
              id: deviceId,
              name: `Remote Device (${deviceId})`,
              status: 'online',
              tier: this.detectTier(),
              ramGB: 16, // Default - should be updated via API call in production
              cpuCores: 8,
              gpuAvailable: false,
              port: 1234,
              models: [],
              load: { activeRequests: 0, totalToday: 0, cooldownUntil: null }
            });
          } catch (error) {
            console.warn(`[DeviceRegistry] Invalid remote device ID "${deviceId}": ${error}`);
          }
        }
      }

      // Update cache
      for (const device of devices) {
        this._devices.set(device.id, device);
      }

      this._lastDiscovery = now;

    } catch (error) {
      console.error('[DeviceRegistry] Discovery failed:', error);
    }

    return Array.from(this._devices.values());
  }

  /**
   * Get all devices
   */
  async getDevices(): Promise<DeviceInfo[]> {
    await this.discoverDevices();
    return Array.from(this._devices.values());
  }

  /**
   * Get online devices only
   */
  async getOnlineDevices(): Promise<DeviceInfo[]> {
    const devices = await this.getDevices();
    return devices.filter(d => d.status === 'online');
  }

  /**
   * Filter devices by tier
   */
  async getDevicesByTier(tier: 'low' | 'medium' | 'high' | 'ultra'): Promise<DeviceInfo[]> {
    const onlineDevices = await this.getOnlineDevices();
    return onlineDevices.filter(d => d.tier === tier);
  }

  /**
   * Get optimal number of devices for a query based on complexity
   */
  async getOptimalDeviceCount(query: string): Promise<number> {
    const onlineDevices = await this.getOnlineDevices();

    if (onlineDevices.length < 2) {
      return Math.min(onlineDevices.length, 1);
    }

    // Word count analysis
    const words = query.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    // Determine based on complexity and available devices
    let maxDevices: number;

    if (wordCount < 30) {
      maxDevices = 2;
    } else if (wordCount < 60) {
      maxDevices = 3;
    } else if (wordCount < 100) {
      maxDevices = 4;
    } else {
      // Complex queries can use more devices
      const highTierDevices = onlineDevices.filter(d => d.tier === 'high' || d.tier === 'ultra').length;
      maxDevices = Math.max(highTierDevices, 3);
    }

    return Math.min(maxDevices, onlineDevices.length);
  }

  /**
   * Detect device tier based on system resources
   */
  private detectTier(): 'low' | 'medium' | 'high' | 'ultra' {
    const ramGB = this._localHardware.ramGB;

    if (ramGB < 8) return 'low';
    if (ramGB < 16) return 'medium';
    if (ramGB < 32) return 'high';
    return 'ultra';
  }

  /**
   * Get system RAM in GB
   */
  private getSystemRAM(): number {
    try {
      const totalMem = os.totalmem(); // Returns bytes
      return Math.round(totalMem / (1024 * 1024 * 1024));
    } catch {
      return 16; // Default fallback
    }
  }

  /**
   * Get CPU core count using Node.js os.cpus()
   */
  private getCPUCoreCount(): number {
    try {
      const cpus = os.cpus();
      return cpus.length;
    } catch {
      return 4; // Default fallback
    }
  }

  /**
   * Get CPU model information
   */
  private getCPUModel(): string | undefined {
    try {
      const cpus = os.cpus();
      if (cpus.length > 0 && cpus[0].model) {
        return cpus[0].model;
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  /**
   * Get CPU speeds in MHz
   */
  private getCPU_SPEEDS(): number[] | undefined {
    try {
      const cpus = os.cpus();
      return cpus.map(cpu => cpu.speed);
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  /**
   * Get hostname for device naming
   */
  private getHostname(): string | null {
    try {
      return os.hostname();
    } catch {
      return null;
    }
  }

  /**
   * Validate remote device ID (hostname or IP address format)
   */
  private validateRemoteDeviceId(deviceId: string): void {
    if (!deviceId || deviceId.length === 0) {
      throw new Error('Empty device ID');
    }

    // Check for valid hostname pattern (domain or hostname)
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    // Check for valid IPv4 address
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    // Check for valid IPv6 address (simplified)
    const ipv6Regex = /^[0-9a-fA-F:]+$/;

    if (!hostnameRegex.test(deviceId) && !ipv4Regex.test(deviceId) && !ipv6Regex.test(deviceId)) {
      throw new Error(`Invalid hostname or IP format: "${deviceId}"`);
    }

    // Validate IPv4 octets
    if (ipv4Regex.test(deviceId)) {
      const octets = deviceId.split('.');
      for (const octet of octets) {
        const num = parseInt(octet, 10);
        if (isNaN(num) || num < 0 || num > 255) {
          throw new Error(`Invalid IPv4 address: "${deviceId}"`);
        }
      }
    }

    // Check for potentially malicious patterns
    const suspiciousPatterns = ['..', '///', '://'];
    for (const pattern of suspiciousPatterns) {
      if (deviceId.includes(pattern)) {
        throw new Error(`Suspicious device ID containing "${pattern}": "${deviceId}"`);
      }
    }

    // If it contains a colon, validate as URL
    if (deviceId.includes(':')) {
      try {
        // Try to parse as URL (host:port format)
        const url = new URL(`http://${deviceId}`);
        const port = parseInt(url.port, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid port in device ID: "${deviceId}"`);
        }
      } catch {
        // If it's not a valid URL format but contains colon, reject it
        throw new Error(`Device ID with colon must be valid host:port format: "${deviceId}"`);
      }
    }
  }

  /**
   * Update device load state
   */
  updateLoad(deviceId: string, activeRequests: number, totalToday: number): void {
    const device = this._devices.get(deviceId);
    if (device) {
      device.load.activeRequests = activeRequests;
      device.load.totalToday = totalToday;
      this._devices.set(deviceId, device);
    }
  }

  /**
   * Clear all cached devices
   */
  clearCache(): void {
    this._devices.clear();
    this._lastDiscovery = 0;
  }
}

// Export singleton instance
export const deviceRegistry = new DeviceRegistry();
