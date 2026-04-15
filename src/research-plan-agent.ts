/**
 * Research Plan Agent - Distributed Research Execution
 *
 * Each agent executes a single subtask:
 * 1. Reads existing research files (if any)
 * 2. Conducts web search on the subtask query
 * 3. Enriches with LLM reasoning via LM Studio
 * 4. Saves results to markdown file in docs/research-output/
 */

import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

/**
 * Generate a short UUID-like identifier
 */
function generateShortId(): string {
  return Math.random().toString(36).substring(2, 15);
}

import { SwarmSubagent } from './services/swarm-subagent.js';
import { ResearchDigest, SearchResult } from './types.js';
import { buildResearchPrompt, ResearchContext } from './utils/prompt-builder.js';
import { ProgressiveSearchEngine } from './progressive-search-engine.js';
import { SearchEngine } from './search-engine.js';

/**
 * Subtask for research plan execution
 */
export interface PlanSubtask {
  id: string;
  query: string;
  deviceId: string;
  priority?: number;
}

/**
 * Result of a single subtask execution
 */
export interface ResearchPlanResult {
  subtaskId: string;
  deviceId: string;
  success: boolean;
  filePath?: string;
  wordCount?: number;
  qualityScore?: number;
  digest?: ResearchDigest;
  content?: string;
  error?: string;
}

/**
 * Research plan metadata for markdown files
 */
export interface ResearchFileMetadata {
  planId: string;
  subtaskId: string;
  originalPromptHash: string;
  originalPromptPreview: string;
  query: string;
  deviceId: string;
  timestamp: string;
  wordCount: number;
  qualityScore: number;
  entities: string[];
  claims: string[];
  keyTerms: string[];
}

/**
 * Research Plan Agent class
 */
export class ResearchPlanAgent {
  private swarmSubagent: SwarmSubagent;
  private researchOutputDir: string;
  private searchEngine?: ProgressiveSearchEngine;

  constructor() {
    this.swarmSubagent = new SwarmSubagent();

    // Set research output directory (relative to project root)
    const projectRoot = process.cwd();
    this.researchOutputDir = path.join(projectRoot, 'docs', 'research-output');

    // Ensure directory exists
    if (!fs.existsSync(this.researchOutputDir)) {
      fs.mkdirSync(this.researchOutputDir, { recursive: true });
      console.log(`[ResearchPlanAgent] Created research output directory: ${this.researchOutputDir}`);
    }

    // Initialize search engine for web searches (uses Serper by default)
    this.searchEngine = new ProgressiveSearchEngine([new SearchEngine()]);
  }

  /**
   * Execute a single subtask
   */
  async executeSubtask(
    subtask: PlanSubtask,
    options?: {
      planId?: string;
      originalPromptHash?: string;
      originalPromptPreview?: string;
      existingContext?: string; // Read from existing .md files
      saveToFile?: boolean;
    }
  ): Promise<ResearchPlanResult> {
    const {
      planId = 'default',
      originalPromptHash = '',
      originalPromptPreview = '',
      saveToFile = true,
    } = options || {};

    console.log(`[ResearchPlanAgent] Executing subtask ${subtask.id} on device ${subtask.deviceId}`);

    try {
      const startTime = Date.now();

      // Step 1: Read existing research files if context is provided
      let context = options?.existingContext;
      if (context === undefined) {
        // Try to read existing files with same planId prefix
        context = await this.readExistingFiles(planId);
      }

      // Step 2: Build web search context from existing research
      const webSearchContext: ResearchContext = {
        webSearchResults: context,
        constraints: [],
        userPreferences: {},
      };

      // Step 3: Conduct web search on the subtask query
      console.log(`[ResearchPlanAgent] Web searching for: "${subtask.query.substring(0, 50)}..."`);
      const searchResults = await this.webSearch(subtask.query);

      // Combine existing context with new search results
      const combinedContext = this.combineContexts(context, searchResults);
      webSearchContext.webSearchResults = combinedContext;

      // Step 4: Enrich with LLM reasoning on the specified device
      console.log(`[ResearchPlanAgent] Running LLM reasoning on ${subtask.deviceId}`);
      const enrichedContent = await this.lmStudioReasoning(
        subtask.query,
        webSearchContext,
        subtask.deviceId
      );

      // Calculate metrics
      const wordCount = this.countWords(enrichedContent);
      const qualityScore = this.calculateQualityScore(enrichedContent, searchResults);
      const digest = this.extractDigest(enrichedContent);

      // Step 5: Save to markdown file if requested
      let filePath: string | undefined;
      if (saveToFile) {
        filePath = await this.saveToMarkdown({
          planId,
          subtaskId: subtask.id,
          originalPromptHash,
          originalPromptPreview,
          query: subtask.query,
          deviceId: subtask.deviceId,
          content: enrichedContent,
          wordCount,
          qualityScore,
          digest,
        });
      }

      const durationMs = Date.now() - startTime;

      console.log(
        `[ResearchPlanAgent] Subtask ${subtask.id} completed in ${durationMs}ms, ` +
        `saved to ${filePath || 'memory'}, quality: ${qualityScore}`
      );

      return {
        subtaskId: subtask.id,
        deviceId: subtask.deviceId,
        success: true,
        filePath,
        wordCount,
        qualityScore,
        digest,
        content: enrichedContent,
      };
    } catch (error) {
      console.error(`[ResearchPlanAgent] Subtask ${subtask.id} failed:`, error);

      return {
        subtaskId: subtask.id,
        deviceId: subtask.deviceId,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Read existing research files for a plan
   */
  private async readExistingFiles(planId: string): Promise<string> {
    try {
      const files = fs.readdirSync(this.researchOutputDir);
      const planFiles = files.filter((f) => f.startsWith(`research-${planId}`));

      if (planFiles.length === 0) return '';

      // Read and combine all relevant files
      const contents: string[] = [];
      for (const file of planFiles) {
        const fullPath = path.join(this.researchOutputDir, file);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          contents.push(content);
        } catch {
          // Skip unreadable files
        }
      }

      return contents.join('\n\n---\n\n');
    } catch (error) {
      console.warn(`[ResearchPlanAgent] Failed to read existing files for plan ${planId}:`, error);
      return '';
    }
  }

  /**
   * Conduct web search on a query using Serper API via ProgressiveSearchEngine
   */
  private async webSearch(query: string): Promise<SearchResult[]> {
    console.log(`[ResearchPlanAgent] Using Serper to search for: "${query.substring(0, 50)}..."`);
    
    if (!this.searchEngine) {
      console.error('[ResearchPlanAgent] Search engine not initialized');
      return [];
    }

    try {
      // Use the existing search engine which defaults to Serper
      const results = await this.searchEngine?.search(query, { query, maxDepth: 1, minResultsPerStage: 5 });
      console.log(`[ResearchPlanAgent] Serper returned ${results ? results.length : 0} results`);
      return results || [];
    } catch (error) {
      console.error('[ResearchPlanAgent] Web search failed:', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  /**
   * Combine existing context with new search results
   */
  private combineContexts(existing: string | undefined, newResults: SearchResult[]): string {
    const parts: string[] = [];

    if (existing && existing.trim()) {
      parts.push(`EXISTING RESEARCH CONTEXT:\n${existing}`);
    }

    if (newResults.length > 0) {
      parts.push(`NEW SEARCH RESULTS:\n`);
      newResults.forEach((result, idx) => {
        parts.push(`\n[${idx + 1}] ${result.title}\nURL: ${result.url}\nContent preview:\n${result.contentPreview}`);
      });
    }

    return parts.join('\n\n');
  }

  /**
   * Run LLM reasoning on a device
   */
  private async lmStudioReasoning(
    query: string,
    context: ResearchContext,
    deviceId: string
  ): Promise<string> {
    // Build prompt with structured instructions
    const prompt = buildResearchPrompt(query, {
      type: 'analysis',
      context,
      maxWords: 2500,
      includeExamples: true,
      tone: 'professional',
    });

    // Execute via swarm subagent (which uses LM Studio)
    const result = await this.swarmSubagent.execute(
      {
        id: `llm-${generateShortId()}`,
        query: prompt,
        deviceId,
      },
      { maxTokens: 4096 }
    );

    return result.content || '';
  }

  /**
   * Save research content to markdown file
   */
  private async saveToMarkdown(data: {
    planId: string;
    subtaskId: string;
    originalPromptHash: string;
    originalPromptPreview: string;
    query: string;
    deviceId: string;
    content: string;
    wordCount: number;
    qualityScore: number;
    digest?: ResearchDigest;
  }): Promise<string> {
    const { planId, subtaskId, content, wordCount, qualityScore, digest } = data;

    // Generate unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeQuery = data.query.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const fileName = `research-${planId}-${subtaskId}-${timestamp}-${safeQuery.substring(0, 50)}.md`;
    const filePath = path.join(this.researchOutputDir, fileName);

    // Build markdown with metadata frontmatter
    const metadata: ResearchFileMetadata = {
      planId,
      subtaskId,
      originalPromptHash: data.originalPromptHash || this.hashText(data.originalPromptPreview),
      originalPromptPreview: data.originalPromptPreview,
      query: data.query,
      deviceId: data.deviceId,
      timestamp: new Date().toISOString(),
      wordCount,
      qualityScore,
      entities: digest?.entities || [],
      claims: digest?.claims || [],
      keyTerms: digest?.keyTerms || [],
    };

    const markdown = this.formatMarkdown(metadata, content);

    // Write file
    fs.writeFileSync(filePath, markdown, 'utf-8');

    return filePath;
  }

  /**
   * Format markdown content with frontmatter
   */
  private formatMarkdown(metadata: ResearchFileMetadata, content: string): string {
    const frontmatter = `---
planId: ${metadata.planId}
subtaskId: ${metadata.subtaskId}
originalPromptHash: ${metadata.originalPromptHash}
originalPromptPreview: "${metadata.originalPromptPreview.replace(/"/g, '\\"')}"
query: ${metadata.query}
deviceId: ${metadata.deviceId}
timestamp: ${metadata.timestamp}
wordCount: ${metadata.wordCount}
qualityScore: ${metadata.qualityScore}
entities: [${metadata.entities.map((e) => `"${e}"`).join(', ')}]
claims: [${metadata.claims.map((c) => `"${c}"`).join(', ')}]
keyTerms: [${metadata.keyTerms.map((k) => `"${k}"`).join(', ')}]
---

# Research Result: ${metadata.query}

**Plan ID:** ${metadata.planId}
**Subtask ID:** ${metadata.subtaskId}
**Device:** ${metadata.deviceId}
**Timestamp:** ${metadata.timestamp}
**Word Count:** ${metadata.wordCount}
**Quality Score:** ${metadata.qualityScore}/100

---

${content}

---

## Metadata
- Plan: ${metadata.planId}
- Subtask: ${metadata.subtaskId}
- Query: ${metadata.query}
- Device: ${metadata.deviceId}
- Quality: ${metadata.qualityScore}/100
`;
    return frontmatter;
  }

  /**
   * Calculate word count
   */
  private countWords(text: string): number {
    return text.split(/\s+/).filter((w) => w.length > 0).length;
  }

  /**
   * Check if LLM cited web search results (enforcement verification)
   */
  private checkWebCitations(content: string, searchResults: SearchResult[]): { hasCitations: boolean; citationCount: number } {
    // Look for citation patterns like [1], [2], etc.
    const bracketCitationRegex = /\[(\d+)\]/g;
    const bracketMatches = content.match(bracketCitationRegex) || [];
    
    // Look for URL references in text
    const urlRegex = /https?:\/\/[^\s<>"')]+/g;
    const urlMatches = content.match(urlRegex) || [];
    
    // Check if URLs match search results
    const resultUrls = searchResults.map(r => r.url);
    const matchedCitations = urlMatches.filter(url => 
      resultUrls.some(resultUrl => url.includes(new URL(resultUrl).hostname))
    );

    const citationCount = bracketMatches.length + matchedCitations.length;
    
    return {
      hasCitations: citationCount > 0,
      citationCount
    };
  }

  /**
   * Calculate quality score (0-100)
   */
  private calculateQualityScore(
    content: string,
    searchResults: SearchResult[]
  ): number {
    let score = 50; // Base score

    // Length score (up to +20 points)
    const wordCount = this.countWords(content);
    if (wordCount > 300) score += 10;
    if (wordCount > 800) score += 10;

    // Search results relevance (up to +20 points)
    if (searchResults.length > 0) {
      score += Math.min(10, searchResults.length * 3);
    }

    // Web citation enforcement (up to +20 points - NOW REQUIRED)
    const { hasCitations, citationCount } = this.checkWebCitations(content, searchResults);
    if (!hasCitations && searchResults.length > 0) {
      score -= 15; // Penalty for not citing web sources
    } else if (citationCount >= 3 && searchResults.length > 0) {
      score += Math.min(10, citationCount); // Bonus for thorough citation
    }

    // Structure quality (up to +10 points)
    const hasHeadings = content.includes('# ') || content.includes('## ');
    const hasParagraphs = content.includes('\n\n');
    if (hasHeadings) score += 5;
    if (hasParagraphs) score += 5;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Extract digest from content
   */
  private extractDigest(content: string): ResearchDigest {
    // Simple extraction for now - in production, use NLP models
    const words = content.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];

    // Get top keywords (excluding common words)
    const stopWords = new Set([
      'the',
      'and',
      'for',
      'with',
      'this',
      'that',
      'from',
      'have',
      'been',
      'will',
      'can',
      'your',
      'are',
      'was',
      'it',
      'its',
    ]);

    const counts: Record<string, number> = {};
    for (const word of words) {
      if (!stopWords.has(word)) {
        counts[word] = (counts[word] || 0) + 1;
      }
    }

    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const entities = sorted.slice(0, 5).map(([w]) => w);
    const claims: string[] = []; // Would need NLP for claim extraction
    const keyTerms = sorted.slice(5, 10).map(([w]) => w);

    return {
      entities,
      claims,
      keyTerms,
    };
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
    return this.researchOutputDir;
  }
}

// Export singleton instance
export const researchPlanAgent = new ResearchPlanAgent();
