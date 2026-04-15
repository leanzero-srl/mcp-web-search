/**
 * LM Studio Client - Connects to local LLMs via LM Studio API
 * 
 * This client enables distributed reasoning by connecting to local LLM instances
 * running on various devices (local or remote) via the LM Studio API.
 */

import axios, { AxiosInstance } from 'axios';

/**
 * Device information including connection details
 */
export interface DeviceInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  isRemote: boolean;
  models?: string[];
}

/**
 * LLM Generation options
 */
export interface GenerateOptions {
  deviceId: string;
  modelKey: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  stream?: boolean;
}

/**
 * LLM Response structure
 */
export interface LLMResponse {
  content: string;
  tokenCount?: number;
  modelName?: string;
  deviceId: string;
  timestamp: number;
}

/**
 * Partial success result for batch operations
 */
export interface BatchResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  deviceIds?: string[];
}

/**
 * LM Studio Client for distributed LLM reasoning
 */
export class LMStudioClient {
  private devices: Map<string, DeviceInfo>;
  private clients: Map<string, AxiosInstance>;
  private defaultPort: number;

  constructor(defaultPort: number = 1234) {
    this.devices = new Map();
    this.clients = new Map();
    this.defaultPort = defaultPort;
  }

  /**
   * Register a device for LLM operations
   */
  registerDevice(device: DeviceInfo): void {
    this.devices.set(device.id, device);
    
    // Create axios instance for this device
    const baseUrl = `http://${device.host}:${device.port}`;
    const client = axios.create({
      baseURL: baseUrl,
      timeout: 60000, // 60 second timeout for LLM generation
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.clients.set(device.id, client);
  }

  /**
   * Generate content using a specific device's local LLM
   */
  async generate(options: GenerateOptions): Promise<LLMResponse> {
    const { deviceId, modelKey, prompt, maxTokens = 8000, temperature = 0.7, systemPrompt } = options;

    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found. Register it first with registerDevice()`);
    }

    const client = this.clients.get(deviceId);
    if (!client) {
      throw new Error(`No HTTP client for device ${deviceId}`);
    }

    // Build messages array
    const messages: { role: string; content: string }[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    try {
      const response = await client.post('/v1/chat/completions', {
        model: modelKey,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
        stream: options.stream ?? false,
      });

      // Validate response structure before accessing nested properties
      if (!response.data || typeof response.data !== 'object') {
        throw new Error('Invalid LM Studio response: missing data object');
      }

      const result = response.data as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number }; model?: string };

      // Check that choices is an array with at least one element
      if (!result.choices || !Array.isArray(result.choices) || result.choices.length === 0) {
        throw new Error('Invalid LM Studio response: missing or empty choices array');
      }

      const firstChoice = result.choices[0];
      if (!firstChoice.message?.content) {
        throw new Error('Invalid LM Studio response: missing message content in first choice');
      }

      return {
        content: firstChoice.message.content,
        tokenCount: result.usage?.total_tokens,
        modelName: result.model || modelKey,
        deviceId: deviceId,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error(`[LMStudioClient] Generation failed for device ${deviceId}:`, error);

      // If we have a remote device, try to detect if it's offline
      if (device.isRemote) {
        await this.checkDeviceHealth(deviceId);
      }

      throw new Error(`Failed to generate content on ${deviceId}: ${(error as Error).message}`);
    }
  }

  /**
   * Batch generate across multiple devices for parallel processing
   */
  async generateBatch(
    options: GenerateOptions[],
    maxConcurrent: number = 3
  ): Promise<LLMResponse[]> {
    const results: LLMResponse[] = [];
    let successfulCount = 0;
    let failedCount = 0;

    // Process in batches to avoid overwhelming devices
    for (let i = 0; i < options.length; i += maxConcurrent) {
      const batch = options.slice(i, i + maxConcurrent);

      try {
        const batchResults = await Promise.allSettled(
          batch.map(opt => this.generate(opt))
        );
        
        // Process each result individually to track success/failure
        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            results.push(result.value);
            successfulCount++;
          } else {
            console.error(`[LMStudioClient] Batch item failed: ${result.reason}`);
            failedCount++;
          }
        }
      } catch (error) {
        console.error('[LMStudioClient] Batch generation error:', error);
        // Count remaining items as failed
        failedCount += batch.length;
      }
    }

    // Log partial success statistics
    if (failedCount > 0) {
      console.warn(`[LMStudioClient] Batch completed with ${successfulCount} successful, ${failedCount} failed`);
    }

    return results;
  }

  /**
   * Get available models from a device
   */
  async getAvailableModels(deviceId: string): Promise<string[]> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    const client = this.clients.get(deviceId);
    if (!client) {
      throw new Error(`No HTTP client for device ${deviceId}`);
    }

    try {
      // LM Studio API endpoint for models
      const response = await client.get('/v1/models');
      
      if (response.data?.data && Array.isArray(response.data.data)) {
        return (response.data.data as Array<{ id: string }>).map((m) => m.id);
      }
      
      // Fallback - return default model keys
      return ['qwen3.5:latest', 'llama-3.2:latest', 'mistral:latest'];
    } catch {
      console.error(`[LMStudioClient] Failed to fetch models for ${deviceId}`);
      return [];
    }
  }

  /**
   * Check device health by making a simple request
   */
  async checkDeviceHealth(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return false;
    }

    const client = this.clients.get(deviceId);
    if (!client) {
      return false;
    }

    try {
      await client.get('/v1/models', { timeout: 5000 });
      return true;
    } catch {
      // Mark device as potentially offline
      console.warn(`[LMStudioClient] Device ${deviceId} may be offline`);
      return false;
    }
  }

  /**
   * Get all registered devices
   */
  getRegisteredDevices(): DeviceInfo[] {
    return Array.from(this.devices.values());
  }

  /**
   * Clear all cached clients and devices
   */
  clearCache(): void {
    this.devices.clear();
    this.clients.clear();
  }
}

// Export singleton instance
export const lmStudioClient = new LMStudioClient();
