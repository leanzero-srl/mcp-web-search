/**
 * Swarm Subagent - Distributed LLM Reasoning Agent
 * Executes focused reasoning tasks using local LLMs on distributed devices
 */

import { LMStudioClient, GenerateOptions } from './lm-studio-client.js';
import { deviceRegistry, DeviceInfo } from './device-registry.js';

/**
 * Type Definitions
 */
export interface Subtask {
  id: string;
  query: string;
  deviceId: string;
  modelKey?: string;
  priority?: number;
  context?: string; // Optional web search context to augment LLM
}

export interface SubtaskResult {
  id: string;
  deviceId: string;
  success: boolean;
  content?: string;
  title?: string;
  url?: string;
  digest?: {
    entities?: string[];
    claims?: string[];
    keyTerms?: string[];
  };
  fullContent?: string;
  tokenCount: number;
  durationMs?: number;
  modelName?: string;
  error?: string;
}

/**
 * Swarm Subagent class - executes focused LLM reasoning tasks
 */
export class SwarmSubagent {
  private lmStudioClient: LMStudioClient;

  constructor() {
    // Initialize LM Studio client
    this.lmStudioClient = new LMStudioClient();
    
    // Register local device
    this.registerLocalDevice();
  }

  /**
   * Register the local device with LM Studio client
   */
  private registerLocalDevice(): void {
    const hostname = typeof process !== 'undefined' && process.env 
      ? process.env.HOSTNAME || require('node:os').hostname()
      : 'localhost';

    this.lmStudioClient.registerDevice({
      id: 'device-local',
      name: 'Local Device',
      host: hostname,
      port: parseInt(process.env.LM_STUDIO_PORT || '1234', 10),
      isRemote: false
    });
  }

  /**
   * Execute a subtask using distributed LLM reasoning
   */
  async execute(subtask: Subtask, options?: {
    numResults?: number;        // Web search results for context (optional)
    includeContent?: boolean;
    maxContentLength?: number;
    temperature?: number;
    maxTokens?: number;
  }): Promise<SubtaskResult> {
    const startTime = Date.now();

    try {
      console.log(`[SwarmSubagent] Executing subtask ${subtask.id} on device ${subtask.deviceId}: "${subtask.query.substring(0, 50)}..."`);

      // Get device info
      const devices = await deviceRegistry.getDevices();
      const device = devices.find(d => d.id === subtask.deviceId);

      if (!device) {
        return {
          id: subtask.id,
          deviceId: subtask.deviceId,
          success: false,
          error: `Device ${subtask.deviceId} not found`,
          tokenCount: 0
        };
      }

      // Build the prompt with LLM reasoning instructions
      const prompt = this.buildResearchPrompt(subtask.query, subtask.context);

      // Generate options for LM Studio
      const generateOptions: GenerateOptions = {
        deviceId: subtask.deviceId,
        modelKey: subtask.modelKey || this.getDefaultModelForTier(device.tier),
        prompt: prompt,
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens ?? 8000,
      };

      // Execute LLM generation
      const response = await this.lmStudioClient.generate(generateOptions);

      const durationMs = Date.now() - startTime;

      return {
        id: subtask.id,
        deviceId: subtask.deviceId,
        success: true,
        content: response.content,
        tokenCount: response.tokenCount || Math.ceil(response.content.length / 4),
        modelName: response.modelName,
        durationMs
      };

    } catch (error) {
      const durationMs = Date.now() - startTime;

      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`[SwarmSubagent] Subtask ${subtask.id} failed on device ${subtask.deviceId}:`, error);

      return {
        id: subtask.id,
        deviceId: subtask.deviceId,
        success: false,
        error: errorMessage,
        tokenCount: 0,
        durationMs
      };
    }
  }

  /**
   * Build a research prompt for LLM reasoning
   */
  private buildResearchPrompt(query: string, context?: string): string {
    const basePrompt = `You are a research assistant conducting focused analysis.

Query: ${query}

${context ? `Additional Context from Web Search:
\`\`\`
${context}
\`\`\`
` : ''}

Instructions:
1. Analyze the query and identify key information needs
2. Provide a well-structured response with:
   - Key findings
   - Supporting evidence and reasoning
   - Any limitations or caveats
3. Use clear headings and bullet points for readability
4. If web context is provided, reference specific sources

Format your response in Markdown for clarity.`;

    return basePrompt;
  }

  /**
   * Get default model for a device tier based on hardware capabilities
   */
  private getDefaultModelForTier(tier: string): string {
    switch (tier) {
      case 'ultra':
        return 'qwen3.5:latest'; // High-end models
      case 'high':
        return 'llama-3.2:latest';
      case 'medium':
        return 'mistral:latest';
      case 'low':
      default:
        return 'gemma:latest'; // Lightweight models
    }
  }

  /**
   * Execute multiple subtasks in parallel across devices
   */
  async executeBatch(
    subtasks: Subtask[],
    options?: {
      maxConcurrent?: number;
    }
  ): Promise<SubtaskResult[]> {
    const maxConcurrent = options?.maxConcurrent ?? 3;

    // Group by device to batch requests
    const deviceSubtasks = new Map<string, Subtask[]>();

    for (const subtask of subtasks) {
      if (!deviceSubtasks.has(subtask.deviceId)) {
        deviceSubtasks.set(subtask.deviceId, []);
      }
      deviceSubtasks.get(subtask.deviceId)?.push(subtask);
    }

    // Execute batches per device
    const results: SubtaskResult[] = [];

    for (const [, tasks] of deviceSubtasks) {
      const batchResults = await Promise.all(
        tasks.map((task: Subtask) => this.execute(task, { maxTokens: 8000 }))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Close resources
   */
  async close(): Promise<void> {
    // LM Studio client handles cleanup internally
  }
}

// Export singleton instance
export const swarmSubagent = new SwarmSubagent();
