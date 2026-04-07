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
  TECHNICAL = 'technical',           // Code, API, implementation, libraries
  DEBUGGING = 'debugging',           // "Error in...", "Why does...", "fix..."
  ACADEMIC = 'academic',             // Research papers, studies, citations
}

export interface QueryIntentDetector {
  detectIntent(query: string): Promise<QueryIntent>;
}

/**
 * Interface for an LLM-powered intent detector.
 * This allows for easy swapping of the heuristic implementation with a more advanced one.
 */
export interface LLMIntentDetector extends QueryIntentDetector {
  modelName: string;
  temperature: number;
}

/**
 * Standard Intent Detector - Uses regex and keyword patterns to classify queries.
 * This is a lightweight, fast implementation suitable for local execution.
 */
export class StandardIntentDetector implements QueryIntentDetector {
  async detectIntent(query: string): Promise<QueryIntent> {
    const lower = query.toLowerCase().trim();
    
    // 1. Navigational Intent (specific sites/domains)
    if (/site:|\/|^www\.|^example\.|\^github\.com|^stackoverflow\.com/.test(lower)) {
      return QueryIntent.NAVIGATIONAL;
    }

    // 2. Debugging Intent (errors, stack traces, fixing)
    if (/(error|exception|bug|fail|broken|debug|stack trace|not working|won't work|issue|fix|resolve)/i.test(lower)) {
      return QueryIntent.DEBUGGING;
    }

    // 3. Technical Intent (code, implementation, libraries, APIs)
    if (/(code|api|library|framework|implementation|syntax|function|class|module|package|repo|github|documentation|docs|how to use|example|snippet)/i.test(lower)) {
      return QueryIntent.TECHNICAL;
    }

    // 4. Academic Intent (research, papers, studies, science)
    if (/(research|paper|study|theory|scientific|academic|evidence|cite|citation|journal|published)/i.test(lower)) {
      return QueryIntent.ACADEMIC;
    }

    // 5. Complex Task Intent (multi-step or highly specific instructions)
    if (/(step by step|how can i|help me to|perform|run|execute|setup|configure|implement)/i.test(lower)) {
      return QueryIntent.COMPLEX_TASK;
    }
    
    // 6. Question Intent (explicitly asking for information)
    if (/[?]/.test(lower) || 
        /^(what|how|why|where|when|who|which|can|is|are|do|does|did|should|would|could)\s/.test(lower)) {
      return QueryIntent.QUESTION;
    }
    
    // 7. Commercial Intent (looking for recommendations, reviews, or best options)
    if (/^(best|top|leading|recommended|favorite|great|cheap|expensive|review|comparison|versus|vs)\b/.test(lower)) {
      return QueryIntent.COMMERCIAL;
    }
    
    // 8. Informational Intent (Default: general knowledge or temporal queries)
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
      break

    case QueryIntent.TECHNICAL:
      expansions.push(`${query} documentation`, `${query} implementation example`);
      expansions.push(`${query} library usage`, `how to use ${query}`);
      expansions.push(`${query} api reference`, `${query} tutorial`);
      break

    case QueryIntent.DEBUGGING:
      expansions.push(`${query} error`, `${query} troubleshoot`);
      expansions.push(`${query} fix`, `${query} solution`);
      expansions.push(`how to fix ${query}`, `${query} common issues`);
      break

    case QueryIntent.ACADEMIC:
      expansions.push(`${query} research paper`, `${query} study`);
      expansions.push(`${query} academic findings`, `${query} scientific explanation`);
      break
    
    case QueryIntent.QUESTION:
      expansions.push(`How can I ${query}?`, `Steps to ${query}`);
      expansions.push(`Guide for ${query}`, `${query} complete tutorial`);
      break
    
    case QueryIntent.NAVIGATIONAL:
      expansions.push(`${query} documentation`, `${query} official site`);
      expansions.push(`${query} how to use`, `${query} examples`);
      break;
  }

  return expansions;
}