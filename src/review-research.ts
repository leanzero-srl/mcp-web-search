/**
 * Review Research Tool - Quality Assurance for research plans
 *
 * Compares research files against the original prompt to identify:
 * - Gaps in coverage
 * - Missing requirements
 * - Inconsistencies
 * - Quality issues
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Gap found during review
 */
export interface ReviewGap {
  type: 'missing' | 'incomplete' | 'out-of-scope' | 'low-quality' | 'missing-citations' | 'insufficient-citations';
  subtaskId?: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
  suggestion: string;
}

/**
 * Review result
 */
export interface ResearchReview {
  planId: string;
  query: string;
  originalPromptHash: string;
  qualityScore: number;
  gapsFound: ReviewGap[];
  recommendations: string[];
  overallAssessment: string;
  filesReviewed: string[];
}

/**
 * Review Research class
 */
export class ReviewResearch {
  private researchOutputDir: string;

  constructor() {
    const projectRoot = process.cwd();
    this.researchOutputDir = path.join(projectRoot, 'docs', 'research-output');
  }

  /**
   * Review a research plan against the original prompt
   */
  async review(
    planId: string,
    options?: {
      compareWithPrompt?: boolean;
      originalPrompt?: string;
      minimumQualityScore?: number;
    }
  ): Promise<ResearchReview> {
    const { compareWithPrompt = true, originalPrompt = '', minimumQualityScore = 60 } =
      options || {};

    console.log(`[ReviewResearch] Reviewing plan ${planId}`);

    // Step 1: Find and load all research files for this plan
    const researchFiles = this.findResearchFiles(planId);
    if (researchFiles.length === 0) {
      return {
        planId,
        query: '',
        originalPromptHash: '',
        qualityScore: 0,
        gapsFound: [
          {
            type: 'missing',
            severity: 'high',
            description: `No research files found for plan ${planId}`,
            suggestion: 'Run the create-research-plan tool first',
          },
        ],
        recommendations: [`Run create-research-plan for plan ${planId}`],
        overallAssessment: 'No research found - run create-research-plan first',
        filesReviewed: [],
      };
    }

    // Step 2: Load original prompt from file metadata
    const { originalPromptHash, query } = this.loadPlanMetadata(planId);

    // Step 3: Review each file for quality and coverage
    const gaps: ReviewGap[] = [];
    const filesReviewed: string[] = [];

    let totalQualityScore = 0;
    let filesWithQualityData = 0;

    for (const file of researchFiles) {
      const content = fs.readFileSync(file.path, 'utf-8');
      filesReviewed.push(file.path);

      // Extract metadata from frontmatter
      const metadata = this.extractMetadata(content);
      if (metadata.qualityScore !== undefined) {
        totalQualityScore += metadata.qualityScore;
        filesWithQualityData++;
      }

      // Check for gaps
      const fileGaps = this.analyzeFileGap(
        content,
        metadata,
        originalPrompt,
        compareWithPrompt,
        minimumQualityScore
      );
      gaps.push(...fileGaps);
    }

    // Step 4: Calculate overall quality score
    const qualityScore =
      filesWithQualityData > 0 ? Math.round(totalQualityScore / filesWithQualityData) : 0;

    // Step 5: Generate recommendations
    const recommendations = this.generateRecommendations(gaps);

    // Step 6: Build overall assessment
    const overallAssessment = this.buildAssessment(qualityScore, gaps.length, filesReviewed);

    return {
      planId,
      query,
      originalPromptHash,
      qualityScore,
      gapsFound: gaps,
      recommendations,
      overallAssessment,
      filesReviewed,
    };
  }

  /**
   * Find all research files for a plan
   */
  private findResearchFiles(planId: string): Array<{ path: string; name: string }> {
    const files: Array<{ path: string; name: string }> = [];

    try {
      if (!fs.existsSync(this.researchOutputDir)) return files;

      const entries = fs.readdirSync(this.researchOutputDir);
      for (const entry of entries) {
        if (
          entry.startsWith(`research-${planId}`) &&
          entry.endsWith('.md')
        ) {
          files.push({
            path: path.join(this.researchOutputDir, entry),
            name: entry,
          });
        }
      }
    } catch (error) {
      console.error('[ReviewResearch] Failed to find research files:', error);
    }

    return files;
  }

  /**
   * Load plan metadata from any file
   */
  private loadPlanMetadata(planId: string): { originalPromptHash: string; query: string } {
    const files = this.findResearchFiles(planId);
    if (files.length === 0) {
      return { originalPromptHash: '', query: '' };
    }

    try {
      const content = fs.readFileSync(files[0].path, 'utf-8');
      const metadata = this.extractMetadata(content);
      return {
        originalPromptHash: metadata.originalPromptHash || '',
        query: metadata.query || '',
      };
    } catch {
      return { originalPromptHash: '', query: '' };
    }
  }

  /**
   * Extract metadata from markdown frontmatter
   */
  private extractMetadata(content: string): {
    planId?: string;
    subtaskId?: string;
    originalPromptHash?: string;
    originalPromptPreview?: string;
    query?: string;
    deviceId?: string;
    timestamp?: string;
    wordCount?: number;
    qualityScore?: number;
    entities?: string[];
    claims?: string[];
    keyTerms?: string[];
  } {
    // Try to parse YAML frontmatter (simplified)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return {};
    }

    interface Metadata {
      [key: string]: string | string[] | number;
    }
    
    const metadata: Metadata = {};
    const lines = frontmatterMatch[1].split('\n');

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        let value = match[2].trim();
        // Remove quotes
        value = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        metadata[match[1]] = value;
      }
    }

    // Parse array fields - need type assertion since we know values are strings after parsing
    if (metadata.entities) {
      metadata.entities = this.parseArrayField(metadata.entities as string);
    }
    if (metadata.claims) {
      metadata.claims = this.parseArrayField(metadata.claims as string);
    }
    if (metadata.keyTerms) {
      metadata.keyTerms = this.parseArrayField(metadata.keyTerms as string);
    }
    if (metadata.wordCount !== undefined) {
      metadata.wordCount = parseInt(metadata.wordCount as string, 10);
    }
    if (metadata.qualityScore !== undefined) {
      metadata.qualityScore = parseInt(metadata.qualityScore as string, 10);
    }

    return metadata;
  }

  /**
   * Parse a YAML array field
   */
  private parseArrayField(value: string): string[] {
    // Format: [item1, item2, item3]
    const match = value.match(/\[(.*)\]/);
    if (!match) return [];

    return match[1]
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, ''))
      .filter((s) => s.length > 0);
  }

  /**
   * Check if content cites web sources
   */
  private checkWebCitations(content: string): { hasCitations: boolean; citationCount: number } {
    // Look for citation patterns like [1], [2], etc.
    const bracketCitationRegex = /\[(\d+)\]/g;
    const bracketMatches = content.match(bracketCitationRegex) || [];
    
    // Look for URL references in text
    const urlRegex = /https?:\/\/[^\s<>"')]+/g;
    const urlMatches = content.match(urlRegex) || [];

    const citationCount = bracketMatches.length + urlMatches.length;
    
    return {
      hasCitations: citationCount > 0,
      citationCount
    };
  }

  /**
   * Analyze a single file for gaps
   */
  private analyzeFileGap(
    content: string,
    metadata: { qualityScore?: number; subtaskId?: string },
    originalPrompt: string,
    compareWithPrompt: boolean,
    minimumQualityScore: number
  ): ReviewGap[] {
    const gaps: ReviewGap[] = [];

    // Check quality score
    if (metadata.qualityScore !== undefined && metadata.qualityScore < minimumQualityScore) {
      gaps.push({
        type: 'low-quality',
        subtaskId: metadata.subtaskId,
        severity: metadata.qualityScore < 40 ? 'high' : 'medium',
        description: `Low quality score (${metadata.qualityScore}/100) for subtask ${metadata.subtaskId}`,
        suggestion: 'Re-run research with more specific instructions or additional context',
      });
    }

    // Check coverage against original prompt
    if (compareWithPrompt && originalPrompt) {
      const promptWords = originalPrompt.toLowerCase().split(/\s+/);
      const contentLower = content.toLowerCase();

      const missingKeywords = promptWords.filter(
        (word) => word.length > 4 && !contentLower.includes(word)
      );

      if (missingKeywords.length > 3) {
        gaps.push({
          type: 'incomplete',
          subtaskId: metadata.subtaskId,
          severity: 'medium',
          description: `Missing key concepts from original prompt: ${missingKeywords.slice(0, 5).join(', ')}`,
          suggestion: `Add coverage for: ${missingKeywords.slice(0, 3).join(', ')}`,
        });
      }
    }

    // Check web source citations (enforcement verification)
    const { hasCitations, citationCount } = this.checkWebCitations(content);
    if (!hasCitations) {
      gaps.push({
        type: 'missing-citations',
        subtaskId: metadata.subtaskId,
        severity: 'high',
        description: 'No web source citations found in response',
        suggestion: 'LLM should cite sources using [1], [2] format and include URLs directly in text'
      });
    } else if (citationCount < 3) {
      gaps.push({
        type: 'insufficient-citations',
        subtaskId: metadata.subtaskId,
        severity: 'medium',
        description: `Only ${citationCount} citation(s) found - should have at least 3`,
        suggestion: 'Add more source citations to strengthen research claims'
      });
    }

    // Check if content has proper structure
    const hasHeadings = content.includes('# ') || content.includes('## ');

    if (!hasHeadings) {
      gaps.push({
        type: 'incomplete',
        subtaskId: metadata.subtaskId,
        severity: 'low',
        description: 'Missing section headings - content may be hard to navigate',
        suggestion: 'Add H1/H2 headings to structure the research',
      });
    }

    return gaps;
  }

  /**
   * Generate recommendations based on gaps
   */
  private generateRecommendations(gaps: ReviewGap[]): string[] {
    const recommendations: Set<string> = new Set();

    for (const gap of gaps) {
      switch (gap.severity) {
        case 'high':
          if (gap.type === 'low-quality') {
            recommendations.add(`Re-run subtask ${gap.subtaskId} with improved instructions`);
          }
          break;
        case 'medium':
          if (gap.type === 'incomplete') {
            recommendations.add(`Expand coverage for: ${gap.suggestion}`);
          }
          break;
      }
    }

    // Add general recommendations
    if (gaps.some((g) => g.type === 'missing')) {
      recommendations.add('Review research plan completeness before execution');
    }

    return Array.from(recommendations);
  }

  /**
   * Build overall assessment string
   */
  private buildAssessment(
    qualityScore: number,
    gapCount: number,
    filesReviewed: string[]
  ): string {
    let assessment = '';

    if (qualityScore >= 80) {
      assessment = 'Excellent research quality - minimal gaps found';
    } else if (qualityScore >= 60) {
      assessment = 'Good research quality - some improvements recommended';
    } else if (qualityScore >= 40) {
      assessment = 'Moderate quality - significant gaps identified';
    } else {
      assessment = 'Low quality - major revisions needed';
    }

    if (gapCount > 0) {
      assessment += ` (${gapCount} gaps found)`;
    }

    return `${assessment} | ${filesReviewed.length} files reviewed`;
  }

  /**
   * Get research output directory
   */
  getOutputDirectory(): string {
    return this.researchOutputDir;
  }
}

// Export singleton instance
export const reviewResearch = new ReviewResearch();
