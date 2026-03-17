/**
 * Progressive Search Engine
 * Implements multi-stage progressive search with automatic expansion and deepening
 */

import { SearchEngine } from './search-engine.js';
import { SearchResult } from './types.js';
import { StandardIntentDetector, QueryIntent, generateIntentBasedExpansions } from './query-intent-detector.js';
import { SemanticExpander } from './semantic-expander.js';

export interface ProgressiveSearchOptions {
  query: string;
  maxDepth?: number;           // How many stages of expansion/deepening (1-5)
  minResultsPerStage?: number; // Min results to consider previous stage "successful"
  maxTotalResults?: number;    // Cap total results returned
}

export interface ProgressiveSearchResult extends SearchResult {
  stage: number;             // Which search stage this came from
  queryUsed: string;         // What query was used to find this result
  relevanceScore: number;    // Relevance score (0-1)
}

export interface ProgressiveSearchEngine {
  search(query: string, options?: ProgressiveSearchOptions): Promise<ProgressiveSearchResult[]>;
}

/**
 * Multi-Stage Search Engine - Orchestrates progressive search across multiple stages
 */
export class ProgressiveSearchEngine implements ProgressiveSearchEngine {
  private readonly intentDetector = new StandardIntentDetector();
  private readonly semanticExpander: SemanticExpander;

  constructor(
    private searchEngines: SearchEngine[],
    config?: Partial<{
      maxDepth: number;
      minResultsPerStage: number;
      maxTotalResults: number;
      expandSingleWordQueries: boolean;
    }>
  ) {
    const defaults = {
      maxDepth: 3,
      minResultsPerStage: 3,
      maxTotalResults: 15,
      expandSingleWordQueries: true,
    };
    
    this.semanticExpander = new SemanticExpander({
      maxExpandedQueries: 5,
      minResultThreshold: defaults.minResultsPerStage
    });
  }

  async search(
    query: string, 
    options: ProgressiveSearchOptions = { query }
  ): Promise<ProgressiveSearchResult[]> {
    const { query: originalQuery } = options;
    
    console.log(`[ProgressiveSearchEngine] Starting progressive search for: "${originalQuery}"`);
    const startTime = Date.now();
    
    // Detect intent and audience for appropriate expansion
    const intent = await this.intentDetector.detectIntent(originalQuery);
    const audienceRaw = this.intentDetector.detectAudience(originalQuery);
    const audience = audienceRaw ?? undefined;
    
    console.log(`[ProgressiveSearchEngine] Detected intent: ${intent}, audience: ${audience || 'none'}`);
    
    const results: ProgressiveSearchResult[] = [];
    const seenUrls = new Set<string>();
    
    // Stage 1: Literal search (immediate realm) - ALWAYS runs first
    console.log(`[ProgressiveSearchEngine] Stage 1: Literal search with original query`);
    const stage1Results = await this.performLiteralSearch(originalQuery);
    
    // Filter and score results
    const scoredStage1 = stage1Results.map(r => ({
      ...r,
      stage: 1,
      queryUsed: originalQuery,
      relevanceScore: this.calculateRelevance(r, originalQuery)
    } as ProgressiveSearchResult));
    
    // Check if Stage 1 was successful (enough good results)
    const goodStage1Results = scoredStage1.filter(r => r.relevanceScore > 0.7);
    
    console.log(`[ProgressiveSearchEngine] Stage 1: Found ${stage1Results.length} results, ${goodStage1Results.length} with high relevance`);
    
    // Add Stage 1 results
    for (const result of scoredStage1) {
      if (!seenUrls.has(result.url)) {
        seenUrls.add(result.url);
        results.push(result);
      }
    }
    
    // Check if we have enough good results to stop here
    if (goodStage1Results.length >= (options.minResultsPerStage || 3) && 
        results.length >= (options.maxTotalResults || 15)) {
      console.log(`[ProgressiveSearchEngine] Stage 1 was successful, returning early`);
      return this.sortAndLimitResults(results, options);
    }
    
    // Need to expand - proceed to deeper stages
    let currentQuery = originalQuery;
    
    for (let depth = 2; depth <= (options.maxDepth || 3); depth++) {
      console.log(`[ProgressiveSearchEngine] Stage ${depth}: Expanding query and searching`);
      
      // Get intent-based expansions
      const intentExpansions = generateIntentBasedExpansions(currentQuery, intent, audience);
      
      // Get semantic expansions (synonyms, rephrasings)
      const semanticExpansions = await this.semanticExpander.expandQuery(currentQuery);
      
      // Combine and deduplicate expansions
      const allExpandedQueries = Array.from(new Set([
        currentQuery, // Always include original query
        ...intentExpansions,
        ...semanticExpansions.filter(q => q !== currentQuery)
      ]));
      
      console.log(`[ProgressiveSearchEngine] Stage ${depth}: Generated ${allExpandedQueries.length} expanded queries`);
      
      let foundNewResults = false;
      
      // Search with each expanded query (up to limit)
      for (const expandedQuery of allExpandedQueries.slice(0, 3)) { // Limit per stage
        if (results.length >= (options.maxTotalResults || 15)) {
          break;
        }
        
        try {
          const stageResults = await this.searchWithEngine(expandedQuery);
          
          // Filter out duplicates and score new results
          for (const result of stageResults) {
            if (!seenUrls.has(result.url)) {
              seenUrls.add(result.url);
              results.push({
                ...result,
                stage: depth,
                queryUsed: expandedQuery,
                relevanceScore: this.calculateRelevance(result, expandedQuery)
              });
              foundNewResults = true;
            }
          }
          
          console.log(`[ProgressiveSearchEngine] Stage ${depth}: Query "${expandedQuery}" returned ${stageResults.length} results`);
        } catch (error) {
          console.warn(`[ProgressiveSearchEngine] Stage ${depth}: Search with "${expandedQuery}" failed:`, error);
        }
      }
      
      // Check if we have enough good results to stop expanding at this depth
      const totalGoodResults = results.filter(r => r.relevanceScore > 0.5).length;
      
      console.log(`[ProgressiveSearchEngine] Stage ${depth}: Total results: ${results.length}, Good: ${totalGoodResults}`);
      
      if (foundNewResults && totalGoodResults >= (options.minResultsPerStage || 3)) {
        console.log(`[ProgressiveSearchEngine] Found enough good results, stopping expansion`);
        break;
      }
      
      if (!foundNewResults) {
        // Try progressive deepening with related topics
        console.log(`[ProgressiveSearchEngine] No new results found, trying topic-based deepening`);
        
        const deepResults = await this.progressiveDeepening(originalQuery, depth);
        
        for (const result of deepResults) {
          if (!seenUrls.has(result.url)) {
            seenUrls.add(result.url);
            results.push({
              ...result,
              stage: depth,
              queryUsed: `${originalQuery} related`,
              relevanceScore: this.calculateRelevance(result, originalQuery)
            });
          }
        }
        
        console.log(`[ProgressiveSearchEngine] Deepening returned ${deepResults.length} additional results`);
      }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`[ProgressiveSearchEngine] Progressive search completed in ${totalTime}ms with ${results.length} total results`);
    
    return this.sortAndLimitResults(results, options);
  }

  /**
   * Stage 1: Literal search using the original query
   */
  private async performLiteralSearch(query: string): Promise<SearchResult[]> {
    console.log(`[ProgressiveSearchEngine] Performing literal search for: "${query}"`);
    
    // Try primary engine first (fastest)
    try {
      const primaryEngine = this.searchEngines[0];
      if (primaryEngine) {
        const result = await primaryEngine.search({
          query,
          numResults: 15
        });
        
        console.log(`[ProgressiveSearchEngine] Primary engine returned ${result.results.length} results`);
        return result.results;
      }
    } catch (error) {
      console.warn(`[ProgressiveSearchEngine] Primary engine failed, trying fallbacks:`, error);
    }
    
    // Fallback to other engines
    for (let i = 1; i < this.searchEngines.length; i++) {
      try {
        const engine = this.searchEngines[i];
        if (engine) {
          const result = await engine.search({
            query,
            numResults: 10
          });
          
          console.log(`[ProgressiveSearchEngine] Fallback engine ${i} returned ${result.results.length} results`);
          return result.results;
        }
      } catch (error) {
        console.warn(`[ProgressiveSearchEngine] Engine ${i} failed:`, error);
      }
    }
    
    return [];
  }

  /**
   * Search with a specific engine
   */
  private async searchWithEngine(query: string): Promise<SearchResult[]> {
    try {
      const primaryEngine = this.searchEngines[0];
      if (primaryEngine) {
        const result = await primaryEngine.search({
          query,
          numResults: 10
        });
        return result.results;
      }
    } catch (error) {
      console.warn(`[ProgressiveSearchEngine] Search failed for "${query}":`, error);
    }
    
    return [];
  }

  /**
   * Progressive deepening - searches related topics when direct expansion fails
   */
  private async progressiveDeepening(
    originalQuery: string,
    depth: number
  ): Promise<SearchResult[]> {
    const relatedTopics = await this.extractRelatedTopics(originalQuery);
    
    console.log(`[ProgressiveSearchEngine] Deepening at stage ${depth}: Found ${relatedTopics.length} related topics`);
    
    for (const topic of relatedTopics.slice(0, 3)) { // Limit topics
      try {
        const deepResults = await this.searchWithEngine(`${originalQuery} ${topic}`);
        
        if (deepResults.length > 0) {
          return deepResults;
        }
      } catch (error) {
        console.warn(`[ProgressiveSearchEngine] Deep search for "${topic}" failed:`, error);
      }
    }
    
    return [];
  }

  /**
   * Extract related topics from the query
   */
  private async extractRelatedTopics(query: string): Promise<string[]> {
    const words = query.split(/\s+/).filter(w => w.length > 3);
    
    if (words.length === 0) return ['guide', 'tutorial'];
    
    // For single-word queries, add common context words
    if (words.length === 1) {
      return [`${query} tutorial`, `${query} guide`, `best ${query}`];
    }
    
    // For multi-word queries, extract key concepts
    const topics = [];
    
    // First word + related terms
    if (words[0]) {
      topics.push(`${words[0]} guide`);
      topics.push(`introduction to ${words[0]}`);
    }
    
    // Last word + related terms  
    if (words.length > 1 && words[words.length - 1]) {
      topics.push(`${words[words.length - 1]} examples`);
      topics.push(`advanced ${words[words.length - 1]}`);
    }
    
    return Array.from(new Set(topics)).slice(0, 5);
  }

  /**
   * Calculate relevance score for a result
   */
  private calculateRelevance(
    result: SearchResult,
    query: string
  ): number {
    const lowerTitle = result.title.toLowerCase();
    const lowerDesc = result.description.toLowerCase();
    const lowerQuery = query.toLowerCase();

    // Extract keywords from query (ignore common words)
    const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with']);
    const queryKeywords = lowerQuery.split(/\s+/).filter(w => w.length > 2 && !commonWords.has(w));

    if (queryKeywords.length === 0) return 0.5;

    let score = 0;
    
    // Check keyword matches in title, description
    for (const keyword of queryKeywords) {
      if (lowerTitle.includes(keyword)) score += 0.3;
      else if (lowerDesc.includes(keyword)) score += 0.15;
    }
    
    // Bonus for exact phrase match in title
    if (lowerTitle.includes(lowerQuery)) score += 0.2;
    
    return Math.min(1.0, score);
  }

  /**
   * Sort and limit results
   */
  private sortAndLimitResults(
    results: ProgressiveSearchResult[],
    options?: ProgressiveSearchOptions
  ): ProgressiveSearchResult[] {
    // Sort by relevance (highest first), then by stage (earlier stages first for equal scores)
    const sorted = results.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      return a.stage - b.stage; // Earlier stages preferred
    });
    
    // Limit to maxTotalResults
    const limit = options?.maxTotalResults || 15;
    return sorted.slice(0, limit);
  }
}