/**
 * Research Plan Manager - Orchestrates distributed research across devices
 *
 * This manager:
 * 1. Decomposes complex queries into focused subtasks
 * 2. Assigns subtasks to devices (load-aware routing)
 * 3. Executes research in parallel using ResearchPlanAgent
 * 4. Builds a tiny index (not full synthesis) for the orchestrator
 */

import crypto from 'crypto';

import { deviceRegistry, DeviceInfo } from './services/device-registry.js';
import { loadTracker } from './services/load-tracker.js';
import {
  detectQueryComplexity,
  decomposeQuery,
} from './utils/query-complexity-detector.js';
import { researchPlanAgent, ResearchPlanResult } from './research-plan-agent.js';

/**
 * Summary of a single subtask for the plan index
 */
export interface SubtaskSummary {
  id: string;
  query: string;
  deviceId: string;
  filePath?: string;
  wordCount?: number;
  qualityScore?: number;
  success: boolean;
  error?: string;
}

/**
 * Subtask type for research plan
 */
export interface PlanSubtask {
  id: string;
  query: string;
  deviceId: string;
  priority?: number;
}

/**
 * Research file summary (what gets indexed)
 */
export interface FileSummary {
  path: string;
  wordCount: number;
  qualityScore: number;
  entitiesFound: string[];
  claimsFound: string[];
  keyTermsFound: string[];
}

/**
 * Tiny index returned to orchestrator (NOT full synthesis!)
 */
export interface ResearchPlanIndex {
  planId: string;
  query: string;
  originalPromptHash: string;
  subtasks: SubtaskSummary[];
  files: FileSummary[];
  devicesUsed: string[];
  summary: {
    totalFiles: number;
    totalWords: number;
    estimatedTokens: number; // Just the index size, not full content
    coverage?: string;
  };
  nextSteps: string[];
}

/**
 * Research Plan Manager class
 */
export class ResearchPlanManager {
  private agent: typeof researchPlanAgent;

  constructor() {
    this.agent = researchPlanAgent;
  }

  /**
   * Create a distributed research plan and execute it
   */
  async createPlan(
    query: string,
    options?: {
      maxDevices?: number;
      saveToFile?: boolean;
      originalPromptHash?: string;
      originalPromptPreview?: string;
    }
  ): Promise<ResearchPlanIndex> {
    const {
      maxDevices = 3,
      saveToFile = true,
      originalPromptHash = '',
      originalPromptPreview = '',
    } = options || {};

    console.log(`[ResearchPlanManager] Creating plan for query: "${query.substring(0, 60)}..."`);

    // Step 1: Detect if query needs decomposition
    const analysis = detectQueryComplexity(query);

    // Step 2: Decompose query into subtasks
    let rawSubtasks: { id: string; query: string }[] = [];
    if (analysis.hasParallelIndicators && analysis.type === 'complex') {
      rawSubtasks = decomposeQuery(query);
      console.log(`[ResearchPlanManager] Decomposed into ${rawSubtasks.length} subtasks`);
    } else {
      // Single subtask for simple queries
      rawSubtasks = [{ id: 'task-1', query }];
      console.log(`[ResearchPlanManager] Simple query, single subtask created`);
    }

    // Convert to PlanSubtask format with deviceId placeholder
    const subtasks: PlanSubtask[] = rawSubtasks.map((st, idx) => ({
      id: st.id,
      query: st.query,
      deviceId: `device-${idx + 1}`, // Will be assigned later
    }));

    // Step 3: Discover available devices
    const devices = await this.getEligibleDevices(maxDevices);
    console.log(`[ResearchPlanManager] Available devices for plan: ${devices.length}`);

    if (devices.length === 0) {
      throw new Error('No eligible devices available for research');
    }

    // Step 4: Assign subtasks to devices (load-aware)
    const assignments = this.assignSubtasksToDevices(subtasks, devices);

    // Step 5: Execute all subtasks in parallel
    console.log(`[ResearchPlanManager] Executing ${assignments.length} subtasks in parallel`);
    const results = await Promise.allSettled(
      assignments.map((assignment) =>
        this.agent.executeSubtask(assignment, {
          planId: originalPromptHash || this.generatePlanId(query),
          originalPromptHash: originalPromptHash || this.hashText(originalPromptPreview || query),
          originalPromptPreview: originalPromptPreview || query,
          saveToFile,
        })
      )
    );

    // Step 6: Build the tiny index (not full synthesis!)
    const planIndex = this.buildPlanIndex(
      results as Array<PromiseSettledResult<ResearchPlanResult>>,
      assignments,
      query,
      originalPromptHash || this.hashText(originalPromptPreview || query)
    );

    console.log(`[ResearchPlanManager] Plan completed with ${planIndex.files.length} files`);

    return planIndex;
  }

  /**
   * Get eligible devices for research
   */
  private async getEligibleDevices(maxCount: number): Promise<DeviceInfo[]> {
    const allDevices = await deviceRegistry.getOnlineDevices();

    // Filter by load (can handle more requests)
    const eligibleDevices: DeviceInfo[] = [];

    for (const device of allDevices) {
      if (eligibleDevices.length >= maxCount) break;

      const canHandle = await loadTracker.canHandleRequest(device.id);
      if (canHandle) {
        eligibleDevices.push(device);
      }
    }

    return eligibleDevices;
  }

  /**
   * Assign subtasks to devices using load-aware routing
   */
  private assignSubtasksToDevices(
    subtasks: PlanSubtask[],
    devices: DeviceInfo[]
  ): PlanSubtask[] {
    const assignments: PlanSubtask[] = [];

    for (let i = 0; i < subtasks.length; i++) {
      const subtask = subtasks[i];
      const deviceIndex = i % devices.length;
      const device = devices[deviceIndex];

      // Increment load for this device
      loadTracker.incrementRequest(device.id).catch(() => {});

      assignments.push({
        id: subtask.id,
        query: subtask.query,
        deviceId: device.id,
        priority: i + 1,
      });
    }

    return assignments;
  }

  /**
   * Build a tiny index (metadata only, not full content)
   */
  private buildPlanIndex(
    results: Array<PromiseSettledResult<ResearchPlanResult>>,
    assignments: PlanSubtask[],
    query: string,
    originalPromptHash: string
  ): ResearchPlanIndex {
    const subtasks: SubtaskSummary[] = [];
    const files: FileSummary[] = [];

    let totalWords = 0;
    const devicesUsed = new Set<string>();

    // Process results and build summary
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const assignment = assignments[i];

      // Skip rejected results
      if (result.status === 'rejected') continue;

      const subtaskResult = result.value;
      if (!subtaskResult) continue;

      subtasks.push({
        id: subtaskResult.subtaskId,
        query: assignment?.query || '',
        deviceId: subtaskResult.deviceId,
        filePath: subtaskResult.filePath,
        wordCount: subtaskResult.wordCount,
        qualityScore: subtaskResult.qualityScore,
        success: subtaskResult.success,
        error: subtaskResult.error,
      });

      if (subtaskResult.filePath && subtaskResult.wordCount) {
        totalWords += subtaskResult.wordCount;
        devicesUsed.add(subtaskResult.deviceId);

        files.push({
          path: subtaskResult.filePath,
          wordCount: subtaskResult.wordCount,
          qualityScore: subtaskResult.qualityScore || 0,
          entitiesFound: subtaskResult.digest?.entities || [],
          claimsFound: subtaskResult.digest?.claims || [],
          keyTermsFound: subtaskResult.digest?.keyTerms || [],
        });
      }
    }

    // Calculate coverage estimate
    let coverage = 'unknown';
    if (files.length > 0) {
      const totalSubtasks = subtasks.length;
      const completedFiles = files.filter((f) => f.qualityScore >= 70).length;
      coverage = `${Math.round((completedFiles / totalSubtasks) * 100)}%`;
    }

    // Estimate index size (just metadata, not full content)
    const estimatedTokens = Math.ceil(
      JSON.stringify({ subtasks, files }).length / 4
    );

    // Generate next steps based on results
    const nextSteps = this.generateNextSteps(subtasks, query);

    return {
      planId: originalPromptHash.substring(0, 12),
      query,
      originalPromptHash,
      subtasks,
      files,
      devicesUsed: Array.from(devicesUsed),
      summary: {
        totalFiles: files.length,
        totalWords,
        estimatedTokens,
        coverage,
      },
      nextSteps,
    };
  }

  /**
   * Generate suggested next steps based on research gaps
   */
  private generateNextSteps(
    subtasks: SubtaskSummary[],
    originalQuery: string
  ): string[] {
    const nextSteps: string[] = [];

    // Check for failed subtasks
    const failedSubtasks = subtasks.filter((s) => !s.success);
    if (failedSubtasks.length > 0) {
      nextSteps.push(
        `Review failed subtasks: ${failedSubtasks.map((s) => s.id).join(', ')}`
      );
    }

    // Check for low-quality results
    const lowQuality = subtasks.filter((s) => s.qualityScore && s.qualityScore < 60);
    if (lowQuality.length > 0) {
      nextSteps.push(
        `Enrich low-quality research: ${lowQuality.map((s) => s.id).join(', ')}`
      );
    }

    // General suggestions based on query type
    const lowerQuery = originalQuery.toLowerCase();
    if (lowerQuery.includes('compare') || lowerQuery.includes('vs')) {
      nextSteps.push('Create comparison table across all researched options');
    }
    if (lowerQuery.includes('tutorial') || lowerQuery.includes('how to')) {
      nextSteps.push('Organize results into step-by-step guide format');
    }
    if (!lowerQuery.includes('summary') && !lowerQuery.includes('review')) {
      nextSteps.push('Summarize key findings for quick reference');
    }

    // Default next step
    if (nextSteps.length === 0) {
      nextSteps.push('Review research files and verify completeness against original query');
    }

    return nextSteps;
  }

  /**
   * Generate a plan ID from query hash
   */
  private generatePlanId(query: string): string {
    const timestamp = new Date().toISOString().substring(0, 10).replace(/-/g, '');
    const hash = this.hashText(query).substring(0, 6);
    return `plan-${timestamp}-${hash}`;
  }

  /**
   * Hash a string (SHA-256)
   */
  private hashText(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Get research output directory
   */
  getOutputDirectory(): string {
    return this.agent.getOutputDirectory();
  }
}

// Export singleton instance
export const researchPlanManager = new ResearchPlanManager();
