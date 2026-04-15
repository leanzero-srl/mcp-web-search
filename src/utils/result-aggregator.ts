/**
 * Result Aggregator - Swarm Orchestration
 * Combines subtask results into a unified synthesis (~15k token budget)
 */

/**
 * Type Definitions
 */
export interface SubtaskResult {
  id: string;
  deviceId: string;
  query?: string;
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
  error?: string;
}

export interface AggregatedResult {
  content: string;
  tokenCount: number;
  wordCount: number;
  readingTime: string;
  subtasksCompleted: number;
  subtasksFailed: number;
  devicesUsed: string[];
  resultsByDevice: Record<string, SubtaskResult[]>;
}

/**
 * Aggregate results from multiple subagents
 */
export function aggregateResults(results: SubtaskResult[]): AggregatedResult {
  // Separate successful and failed results
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  // Group by device
  const resultsByDevice: Record<string, SubtaskResult[]> = {};
  for (const result of successful) {
    if (!resultsByDevice[result.deviceId]) {
      resultsByDevice[result.deviceId] = [];
    }
    resultsByDevice[result.deviceId].push(result);
  }

  // Calculate token count
  let totalTokens = 0;
  for (const result of successful) {
    totalTokens += result.tokenCount || estimateTokens(result.content || '');
  }

  // Build aggregated content
  const content = buildAggregatedContent(successful);

  return {
    content,
    tokenCount: totalTokens,
    wordCount: countWords(content),
    readingTime: calculateReadingTime(content),
    subtasksCompleted: successful.length,
    subtasksFailed: failed.length,
    devicesUsed: Object.keys(resultsByDevice),
    resultsByDevice
  };
}

/**
 * Build aggregated content from subtask results
 */
function buildAggregatedContent(results: SubtaskResult[]): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Research Synthesis Report\n`);
  sections.push(`**Generated:** ${new Date().toISOString()}\n`);
  sections.push(`**Total Sources:** ${results.length}\n\n`);

  // Summary section
  if (results.length > 0) {
    sections.push(`## Summary\n\n`);
    const summary = generateSummary(results);
    if (summary) {
      sections.push(summary);
    }
    sections.push(`\n---\n\n`);
  }

  // Results by device/group
  const groupedResults = groupByDevice(results);

  for (const [deviceId, deviceResults] of Object.entries(groupedResults)) {
    if (deviceResults.length === 0) continue;

    sections.push(`## Device: ${deviceId}\n\n`);

    for (const result of deviceResults) {
      if (!result.content || !result.content.trim()) continue;

      sections.push(`### ${result.title || 'Research Result'}\n\n`);
      
      // Add URL if available
      if (result.url) {
        sections.push(`**Source:** ${result.url}\n\n`);
      }

      // Add digest if available
      const entities = result.digest?.entities;
      const claims = result.digest?.claims;
      
      if (entities && entities.length > 0) {
        sections.push(`**Entities:** ${entities.join(', ')}\n\n`);
      }
      
      if (claims && claims.length > 0) {
        sections.push(`**Key Claims:** ${claims.join(' | ')}\n\n`);
      }

      // Add content with truncation
      const maxContentLength = process.env.SWARM_RESULT_BUDGET 
        ? parseInt(process.env.SWARM_RESULT_BUDGET, 10)
        : 15000;

      let content = result.content;
      if (result.fullContent && result.fullContent.length > maxContentLength) {
        content = result.fullContent.substring(0, maxContentLength);
        sections.push(`**Content:**\n${content}\n\n[Content truncated to respect budget]`);
      } else {
        sections.push(`**Content:**\n${content}\n`);
      }

      sections.push(`\n---\n\n`);
    }
  }

  // Failed results section
  if (results.length > 0) {
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      sections.push(`## Failed Results\n\n`);
      
      for (const result of failed) {
        sections.push(`- **${result.id}**: ${result.error || 'Unknown error'}\n`);
      }
      
      sections.push(`\n---\n\n`);
    }
  }

  // Footer
  sections.push(`## End of Report\n`);

  return sections.join('\n');
}

/**
 * Generate a summary from multiple results
 */
function generateSummary(results: SubtaskResult[]): string | null {
  if (results.length === 0) return null;

  const content = results.map(r => r.content).filter(Boolean).join('\n\n');

  // Extract key themes/keywords from all results
  const keywords = extractKeywords(content, 5);
  
  let summary = `This research synthesis covers ${results.length} sources. Key findings include:\n\n`;

  if (keywords.length > 0) {
    summary += `- **Key Themes:** ${keywords.join(', ')}\n`;
  }

  // Add result count per device
  const devices = new Set(results.map(r => r.deviceId));
  summary += `\n- **Devices Used:** ${devices.size}\n`;

  return summary;
}

/**
 * Extract top keywords from text
 */
function extractKeywords(text: string, maxCount: number = 5): string[] {
  if (!text) return [];

  // Simple keyword extraction - in production this would use NLP
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  
  // Count word frequencies
  const counts: Record<string, number> = {};
  for (const word of words) {
    if (!['the', 'and', 'for', 'with', 'this', 'that', 'from'].includes(word)) {
      counts[word] = (counts[word] || 0) + 1;
    }
  }

  // Sort by frequency
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCount);

  return sorted.map(([word]) => word);
}

/**
 * Group results by device ID
 */
function groupByDevice(results: SubtaskResult[]): Record<string, SubtaskResult[]> {
  const groups: Record<string, SubtaskResult[]> = {};
  
  for (const result of results) {
    if (!groups[result.deviceId]) {
      groups[result.deviceId] = [];
    }
    groups[result.deviceId].push(result);
  }

  return groups;
}

/**
 * Estimate token count from text
 */
export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English
  const charsPerToken = 4;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Count words in text
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Calculate reading time
 */
function calculateReadingTime(content: string): string {
  const words = countWords(content);
  const minutes = Math.ceil(words / 200); // 200 WPM average
  return `${minutes} min read`;
}

/**
 * Check if result fits within token budget
 */
export function fitsInBudget(result: SubtaskResult, remainingBudget: number): boolean {
  return (result.tokenCount || estimateTokens(result.content || '')) <= remainingBudget;
}

/**
 * Truncate result content to fit budget
 */
export function truncateResult(result: SubtaskResult, maxBytes: number): SubtaskResult {
  if (!result.content) return result;

  const contentBytes = new TextEncoder().encode(result.content).length;
  
  if (contentBytes <= maxBytes) {
    return result;
  }

  // Truncate content
  let truncated = result.content.substring(0, maxBytes);
  
  // Try to truncate at a sentence boundary
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > truncated.length * 0.8) {
    truncated = truncated.substring(0, lastPeriod + 1);
  }

  return {
    ...result,
    content: truncated + '\n\n[Content truncated]'
  };
}