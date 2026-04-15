/**
 * Query Complexity Detector - Orchestration Logic
 * Analyzes queries to determine if they should use single device or multi-device swarm
 */

/**
 * Type Definitions
 */
export interface QueryAnalysis {
  type: 'simple' | 'complex';
  wordCount: number;
  hasParallelIndicators: boolean;
  parallelIndicatorType?: string[];
  subtasksCount: number;
}

/**
 * Analyze query complexity
 * @param query - The search query to analyze
 * @returns QueryAnalysis object with type and details
 */
export function detectQueryComplexity(query: string): QueryAnalysis {
  if (!query || typeof query !== 'string') {
    return {
      type: 'simple',
      wordCount: 0,
      hasParallelIndicators: false,
      subtasksCount: 1
    };
  }

  // Clean and count words
  const words = query.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;

  // Check for parallel indicators
  const parallelIndicators = findParallelIndicators(query);

  return {
    type: wordCount >= 30 || parallelIndicators.length > 0 ? 'complex' : 'simple',
    wordCount,
    hasParallelIndicators: parallelIndicators.length > 0,
    parallelIndicatorType: parallelIndicators.length > 0 ? parallelIndicators : undefined,
    subtasksCount: Math.min(parallelIndicators.length + 1, 5)
  };
}

/**
 * Find parallel execution indicators in query
 */
export function findParallelIndicators(query: string): string[] {
  const indicators: string[] = [];
  const lowerQuery = query.toLowerCase();

  // Numbered lists (e.g., "1. First, 2. Second")
  if (/\b\d+\.\s+/.test(lowerQuery)) {
    const numberedCount = (lowerQuery.match(/\b\d+\.\s+/g) || []).length;
    indicators.push(`numbered-list:${numberedCount}`);
  }

  // "and" connectors
  const andMatches = lowerQuery.match(/\band\b/g);
  if (andMatches && andMatches.length >= 1) {
    indicators.push(`and-connectors:${andMatches.length}`);
  }

  // "or" connectors (might indicate alternatives)
  const orMatches = lowerQuery.match(/\bor\b/g);
  if (orMatches && orMatches.length >= 1) {
    indicators.push(`or-connectors:${orMatches.length}`);
  }

  // Multiple questions
  const questionCount = (lowerQuery.match(/\?\s*(?:and|then)?/g) || []).length;
  if (questionCount >= 2) {
    indicators.push(`multiple-questions:${questionCount}`);
  }

  // "Compare X and Y" patterns
  if (/compare\b.*\band\b/.test(lowerQuery)) {
    indicators.push('comparison');
  }

  // "Research A, analyze B" patterns
  if (/\bresearch\b|\banalyze\b/.test(lowerQuery) && /\band\b/.test(lowerQuery)) {
    indicators.push('multi-step-research');
  }

  return indicators;
}

/**
 * Estimate number of subtasks from query
 */
export function estimateSubtaskCount(query: string): number {
  const analysis = detectQueryComplexity(query);
  
  if (analysis.type === 'simple') {
    return 1;
  }

  // Base count on parallel indicators
  let baseCount = Math.min(analysis.subtasksCount, 5);

  // Adjust based on word count for complex queries
  if (analysis.wordCount > 100) {
    baseCount = Math.min(baseCount + 1, 6);
  }

  return baseCount;
}

/**
 * Decompose query into focused subtasks
 */
export function decomposeQuery(query: string): { id: string; query: string }[] {
  const analysis = detectQueryComplexity(query);

  if (analysis.type === 'simple') {
    return [{ id: 'task-1', query }];
  }

  // Create focused subtasks based on parallel indicators
  const subtasks: { id: string; query: string }[] = [];
  
  // Extract numbered items if present
  const numberedItems = extractNumberedItems(query);
  if (numberedItems.length > 0) {
    numberedItems.forEach((item, idx) => {
      subtasks.push({ id: `task-${idx + 1}`, query: item });
    });
    return subtasks;
  }

  // Extract questions if present
  const questions = extractQuestions(query);
  if (questions.length >= 2) {
    questions.forEach((q, idx) => {
      subtasks.push({ id: `task-${idx + 1}`, query: q });
    });
    return subtasks;
  }

  // Split by "and" connector
  const parts = splitByConnector(query, 'and');
  if (parts.length >= 2) {
    parts.forEach((part, idx) => {
      subtasks.push({ id: `task-${idx + 1}`, query: part.trim() });
    });
    return subtasks;
  }

  // Default: single synthesis task
  return [{ id: 'task-1', query }];
}

/**
 * Extract numbered list items from query
 */
function extractNumberedItems(query: string): string[] {
  const matches = query.match(/\d+\.\s*([^\n\d]+?)(?=\d+\.|\n|$)/g);
  if (!matches) return [];
  
  return matches.map(m => m.replace(/^\d+\.\s*/, '').trim());
}

/**
 * Extract questions from query
 */
function extractQuestions(query: string): string[] {
  // Split by question mark followed by "and" or end of string
  const parts = query.split(/\?\s*(?:and|then)?/i);
  
  // Filter out incomplete sentences
  return parts.filter(p => p.trim().length > 10).map(p => `${p}?`).slice(0, 4);
}

/**
 * Split query by connector
 */
function splitByConnector(query: string, connector: string): string[] {
  const regex = new RegExp(`\\b${connector}\\b`, 'gi');
  
  // Find all positions of the connector
  const parts: string[] = [];
  let lastEnd = 0;
  
  let match;
  while ((match = regex.exec(query)) !== null) {
    parts.push(query.slice(lastEnd, match.index).trim());
    lastEnd = match.index + match[0].length;
  }
  
  // Add remaining part
  if (lastEnd < query.length) {
    parts.push(query.slice(lastEnd).trim());
  }

  return parts.filter(p => p.length > 10);
}

/**
 * Check if query is suitable for swarm orchestration
 */
export function shouldUseSwarm(query: string, minDevices: number = 2): boolean {
  const analysis = detectQueryComplexity(query);
  
  // Must be complex AND have parallel indicators
  return analysis.type === 'complex' && 
         analysis.hasParallelIndicators &&
         minDevices >= 2;
}