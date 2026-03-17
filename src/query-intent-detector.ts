/**
 * Query Intent Detector
 * Detects the type of query to apply appropriate expansion strategies
 */

export enum QueryIntent {
  INFORMATIONAL = 'informational',   // "What is X", "Explain Y"
  COMMERCIAL = 'commercial',         // "Best X", "Buy X"  
  NAVIGATIONAL = 'navigational',     // "site:example.com X"
  QUESTION = 'question',             // Questions ending with ?
  COMPLEX_TASK = 'complex_task',     // Multi-step requests
}

export interface QueryIntentDetector {
  detectIntent(query: string): Promise<QueryIntent>;
}

/**
 * Standard Intent Detector - Uses regex and keyword patterns to classify queries
 */
export class StandardIntentDetector implements QueryIntentDetector {
  async detectIntent(query: string): Promise<QueryIntent> {
    const lower = query.toLowerCase().trim();
    
    // Check for question patterns (explicit questions)
    if (/[?]/.test(lower) || 
        /^what is/.test(lower) || 
        /^what are/.test(lower) ||
        /^how to/.test(lower) ||
        /^how do/.test(lower)) {
      return QueryIntent.QUESTION;
    }
    
    // Check for commercial intent (recommendations)
    if (/^(best|top|leading|recommended|favorite|great)/i.test(lower)) {
      return QueryIntent.COMMERCIAL;
    }
    
    // Check for navigational intent (specific sites)
    if (/site:|\/|^www\.|^example\./.test(lower)) {
      return QueryIntent.NAVIGATIONAL;
    }
    
    // Check for temporal queries (contains years/numbers)
    if (/\b(20\d{2})\b/.test(query) || /\b(19\d{2})\b/.test(query)) {
      return QueryIntent.INFORMATIONAL; // Temporal queries are informational
    }
    
    // Check for "for me" or audience-specific intent
    if (/(for me|for beginner|for advanced|for professionals)/i.test(lower)) {
      return QueryIntent.INFORMATIONAL;
    }
    
    // Default: informational
    return QueryIntent.INFORMATIONAL;
  }

  /**
   * Detects the target audience from a query
   */
  detectAudience(query: string): 'beginner' | 'intermediate' | 'advanced' | null {
    const lower = query.toLowerCase();
    
    if (/(beginner|beginners|for beginners)/i.test(lower)) return 'beginner';
    if (/(intermediate|medium)/i.test(lower)) return 'intermediate';
    if (/(advanced|expert|professional)/i.test(lower)) return 'advanced';
    
    return null;
  }

  /**
   * Detects if a query is about finding something vs. understanding
   */
  detectTaskType(query: string): 'find' | 'understand' | 'compare' {
    const lower = query.toLowerCase();

    // Find tasks (looking for specific items)
    if (/^(best|top|great|favorite)/i.test(lower) || 
        /buy|purchase|download/i.test(lower)) {
      return 'find';
    }

    // Compare tasks
    if (/compare|vs|versus|instead of/i.test(lower)) {
      return 'compare';
    }

    // Default to understanding
    return 'understand';
  }
}

/**
 * Intent-based expansion generator - creates related queries based on intent
 */
export function generateIntentBasedExpansions(
  query: string, 
  intent: QueryIntent,
  audience?: 'beginner' | 'intermediate' | 'advanced'
): string[] {
  const expansions: string[] = [];

  switch (intent) {
    case QueryIntent.COMMERCIAL:
      expansions.push(`${query} reviews`, `${query} comparison 2024`);
      expansions.push(`top ${query}`, `best practices for ${query}`);
      break;
      
    case QueryIntent.INFORMATIONAL:
      if (audience === 'beginner') {
        expansions.push(`${query} for beginners`, `${query} beginner friendly`);
        expansions.push(`introduction to ${query}`, `${query} basics`);
      } else if (audience === 'advanced') {
        expansions.push(`${query} advanced`, `${query} deep dive`);
        expansions.push(`${query} implementation details`, `advanced ${query}`);
      }
      expansions.push(`${query} explained`, `What is ${query}`);
      expansions.push(`${query} tutorial`, `${query} guide`);
      break;

    case QueryIntent.QUESTION:
      expansions.push(`How can I ${query}?`, `Steps to ${query}`);
      expansions.push(`Guide for ${query}`, `${query} complete tutorial`);
      break;

    case QueryIntent.NAVIGATIONAL:
      expansions.push(`${query} documentation`, `${query} official site`);
      expansions.push(`${query} how to use`, `${query} examples`);
      break;
  }

  return expansions;
}