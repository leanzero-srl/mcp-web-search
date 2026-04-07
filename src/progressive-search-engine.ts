/**
 * Progressive Search Engine
 * Implements multi-stage progressive search with automatic expansion and deepening
 */

import { SearchEngine } from './search-engine.js';
import { SearchResult } from './types.js';
import { StandardIntentDetector, QueryIntent, generateIntentBasedExpansions } from './query-intent-detector.js';
import { SemanticExpander, HeuristicSemanticExpander } from './semantic-expander.js';

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

export interface IProgressiveSearchEngine {
  search(query: string, options?: ProgressiveSearchOptions): Promise<ProgressiveSearchResult[]>;
}

/**
 * Multi-Stage Search Engine - Orchestrates progressive search across multiple stages
 */
export class ProgressiveSearchEngine implements IProgressiveSearchEngine {
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
    
    this.semanticExpander = new SemanticExpander(new HeuristicSemanticExpander());
  }

  async search(
    query: string, 
    options: ProgressiveSearchOptions = { query }
  ): Promise<ProgressiveSearchResult[]> {
    const { query: originalQuery } = options;
    const maxDepth = options.maxDepth || 3;
    const minResultsPerStage = options.minResultsPerStage || 3;
    const maxTotalResults = options.maxTotalResults || 15;
    
    console.log(`[ProgressiveSearchEngine] Starting DEEP research for: "${originalQuery}"`);
    const startTime = Date.now();
    
    const intent = await this.intentDetector.detectIntent(originalQuery);
    const audienceRaw = this.intentDetector.detectAudience(originalQuery);
    const audience = audienceRaw ?? undefined;
    
    console.log(`[ProgressiveSearchEngine] Detected intent: ${intent}, audience: ${audience || 'none'}`);
    
    const results: ProgressiveSearchResult[] = [];
    const seenUrls = new Set<string>();

    // -------------------------------------------------------------------------
    // STAGE 1: INITIAL DISCOVERY (Literal + Expansion)
    // -------------------------------------------------------------------------
    console.log(`[ProgressiveSearchEngine] Stage 1: Initial Discovery`);
    
    // 1.1 Literal Search
    const literalResults = await this.performLiteralSearch(originalQuery);
    this.ingestResults(literalResults, 1, originalQuery, results, seenUrls);

    // 1.2 Intent-Based Expansion (Immediate relevance)
    // Optimization: Run intent and semantic expansions in parallel to save time in Stage 1
    const [intentExpansions, semanticExpansions] = await Promise.all([
      Promise.resolve(generateIntentBasedExpansions(originalQuery, intent, audience)),
      this.semanticExpander.expandQuery(originalQuery)
    ]);
    
    const initialExpansions = Array.from(new Set([...intentExpansions, ...semanticExpansions]));

    // Optimization: Run expansion searches in parallel with a concurrency limit 
    // to speed up Stage 1 without overwhelming the browser pool
    const expansionTasks = initialExpansions.slice(0, 3).map(async (expQuery) => {
      const stageResults = await this.searchWithEngine(expQuery);
      return { expQuery, stageResults };
    });

    const expansionOutcomes = await Promise.all(expansionTasks);
    for (const { expQuery, stageResults } of expansionOutcomes) {
      this.ingestResults(stageResults, 1, expQuery, results, seenUrls);
    }

    // Check if we are already done
    if (this.isSatisfied(results, minResultsPerStage, maxTotalResults)) {
      return this.sortAndLimitResults(results, options);
    }

    // -------------------------------------------------------------------------
    // STAGE 2+: DEEP RESEARCH LOOP (Decomposition + Iterative Refinement)
    // -------------------------------------------------------------------------
    for (let depth = 2; depth <= maxDepth; depth++) {
      console.log(`[ProgressiveSearchEngine] Stage ${depth}: Deepening Research Loop`);
      
      // 2.1 Topic Decomposition (The "Planner")
      const subQueries = await this.decomposeQuery(originalQuery, intent, results);
      
      if (subQueries.length === 0) {
        console.log(`[ProgressiveSearchEngine] No new sub-topics discovered, ending loop.`);
        break;
      }

      console.log(`[ProgressiveSearchEngine] Stage ${depth}: Decomposed into ${subQueries.length} sub-queries`);

      // 2.2 Parallel Execution of Sub-Queries
      const stageResults = await this.executeParallelSubQueries(subQueries, depth, results.length, maxTotalResults);
      
      // 2.3 Ingest new findings
      this.ingestResults(stageResults, depth, 'sub-topic research', results, seenUrls);

      // 2.4 Check Satisfaction (Halting Criteria)
      if (this.isSatisfied(results, minResultsPerStage, maxTotalResults)) {
        console.log(`[ProgressiveSearchEngine] Research goal met at stage ${depth}`);
        break;
      }

      // 2.5 Check for "Dead End"
      if (stageResults.length === 0) {
        console.log(`[ProgressiveSearchEngine] No new information found in this branch, trying fallback deepening`);
        const deepResults = await this.progressiveDeepening(originalQuery, depth);
        this.ingestResults(deepResults, depth, 'topic-based deepening', results, seenUrls);
      }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`[ProgressiveSearchEngine] Deep research completed in ${totalTime}ms with ${results.length} total results`);
    
    return this.sortAndLimitResults(results, options);
  }

  /**
   * Core Research Logic: Decomposes a query into specific, actionable sub-questions.
   */
  private async decomposeQuery(
    originalQuery: string, 
    intent: QueryIntent,
    currentResults: ProgressiveSearchResult[]
  ): Promise<string[]> {
    const subQueries: string[] = [];

    switch (intent) {
      case QueryIntent.COMPLEX_TASK:
        // Task Decomposition: Break into Setup, Implementation, and Troubleshooting
        subQueries.push(`how to setup and configure ${originalQuery}`);
        subQueries.push(`step by step implementation of ${originalQuery}`);
        subQueries.push(`common challenges when ${originalQuery}`);
        break;

      case QueryIntent.TECHNICAL:
        // Technical Decomposition: Architecture, API, and Examples
        subQueries.push(`${originalQuery} architecture and design patterns`);
        subQueries.push(`${originalQuery} api reference and documentation`);
        subQueries.push(`${originalQuery} code examples and best practices`);
        break;

      case QueryIntent.DEBUGGING:
        // Debugging Decomposition: Causes, Error Codes, and Fixes
        subQueries.push(`${originalQuery} common error codes and causes`);
        subQueries.push(`how to troubleshoot ${originalQuery}`);
        subQueries.push(`${originalQuery} troubleshooting guide and solutions`);
        break;

      case QueryIntent.ACADEMIC:
        // Academic Decomposition: Theories, Studies, and Recent Findings
        subQueries.push(`${originalQuery} academic research and studies`);
        subQueries.push(`${originalQuery} theoretical framework and literature review`);
        subQueries.push(`recent scientific advancements in ${originalQuery}`);
        break;

      default:
        // For Informational/Commercial/etc, we perform "Dimension Expansion"
        const semanticExpansions = await this.semanticExpander.expandQuery(originalQuery);
        subQueries.push(...semanticExpansions.slice(0, 3));
        break;
    }

    // Add "Contradiction/Comparison" queries to resolve ambiguity (Research-grade)
    // This helps prevent "echo chamber" results in a single search stage
    if (currentResults.length > 0) {
      subQueries.push(`${originalQuery} pros and cons`);
      subQueries.push(`${originalQuery} vs alternative approaches`);
      subQueries.push(`critical analysis of ${originalQuery}`);
    }

    // Filter duplicates and limit
    return Array.from(new Set(subQueries)).slice(0, 6);
  }

  /**
   * Executes multiple sub-queries in parallel to accelerate research
   */
  private async executeParallelSubQueries(
    queries: string[],
    depth: number,
    currentResultCount: number,
    maxTotal: number
  ): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];
    const concurrencyLimit = 3;
    const subQueryTimeout = 20000; // 20s timeout per sub-query to prevent hanging

    console.log(`[ProgressiveSearchEngine] Executing parallel sub-queries (Total: ${queries.length}, Concurrency: ${concurrencyLimit})`);

    // We process queries in batches to respect concurrency and not overwhelm the browser pool
    for (let i = 0; i < queries.length; i += concurrencyLimit) {
      const batch = queries.slice(i, i + concurrencyLimit);
      console.log(`[ProgressiveSearchEngine] Processing batch ${Math.floor(i / concurrencyLimit) + 1} (${batch.length} queries)`);

      const tasks = batch.map(async (q) => {
        try {
          // Implement a timeout for each individual sub-query
          const result = await Promise.race([
            this.searchWithEngine(q),
            new Promise<SearchResult[]>((_, reject) => 
              setTimeout(() => reject(new Error(`Sub-query timeout for: ${q}`)), subQueryTimeout)
            )
          ]);
          return result;
        } catch (e) {
          console.warn(`[ProgressiveSearchEngine] Sub-query failed or timed out: ${q}. Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
          return [] as SearchResult[];
        }
      });

      const outcomes = await Promise.all(tasks);
      allResults.push(...outcomes.flat());

      // If we've reached the max results needed, stop early
      if (allResults.length >= maxTotal) {
        break;
      }
    }

    return allResults;
  }

  private ingestResults(
    newResults: SearchResult[],
    stage: number,
    queryUsed: string,
    targetList: ProgressiveSearchResult[],
    seenUrls: Set<string>
  ): void {
    for (const res of newResults) {
      if (!seenUrls.has(res.url)) {
        seenUrls.add(res.url);
        targetList.push({
          ...res,
          stage,
          queryUsed,
          relevanceScore: this.calculateRelevance(res, queryUsed)
        });
      }
    }
  }

  private isSatisfied(results: ProgressiveSearchResult[], min: number, max: number): boolean {
    const goodResults = results.filter(r => r.relevanceScore > 0.6).length;
    return goodResults >= min || results.length >= max;
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
    // Since ProgressiveSearchEngine is initialized with an array of SearchEngine instances,
    // we should attempt to use them. However, each SearchEngine instance itself 
    // handles parallel/fallback logic. 
    
    // We'll try the first engine. If it fails, we'll try the next one in the list.
    for (const engine of this.searchEngines) {
      try {
        const result = await engine.search({
          query,
          numResults: 10
        });
        if (result.results && result.results.length > 0) {
          return result.results;
        }
      } catch (error) {
        console.warn(`[ProgressiveSearchEngine] Engine search failed for "${query}":`, error);
      }
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