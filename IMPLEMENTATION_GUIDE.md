# Implementation Guide: Advanced Web Search with Progressive Query Expansion

## Overview

This guide outlines a strategy for improving web search effectiveness through progressive query expansion and iterative refinement techniques. The approach moves beyond simple keyword matching to understand user intent, semantic relationships, and progressively deepen the search as needed.

## Core Philosophy

The goal is to create a **progressive, multi-stage search strategy** that:
1. First tries the immediate realm of what the user explicitly asked (literal interpretation)
2. If results are poor, expands using synonyms and related terms
3. Progresses deeper into the topic if needed (iterative deepening)
4. Uses word play and semantic understanding to find alternative formulations

## Search Strategy Architecture

### Stage 1: Literal/Immediate Realm Search
Start with exactly what the user provided - no modifications.

```typescript
const literalSearch = async (query: string): Promise<SearchResult[]> => {
  // Search with the exact query provided by user
  return await searchEngine.search({
    query: query, // Exact, no modifications
    numResults: 10
  });
};

// Example: User asks "best AI tools"
// Stage 1 searches for: "best AI tools"
```

**Key Characteristics:**
- No keyword modifications
- No synonym expansion
- Plain, direct search
- Fast execution (baseline measurement)

### Stage 2: Synonym & Semantic Expansion
If Stage 1 yields poor results, expand the query using multiple techniques.

```typescript
const semanticExpansion = async (query: string): Promise<string[]> => {
  const expandedQueries: string[] = [];

  // Technique 1: Synonym expansion
  const synonyms = await generateSynonyms(query);
  synonyms.forEach(syn => expandedQueries.push(`${query} ${syn}`));

  // Technique 2: Related concept expansion
  const relatedConcepts = await findRelatedConcepts(query);
  relatedConcepts.forEach(concept => expandedQueries.push(`${query} ${concept}`));

  // Technique 3: Semantic rephrasing
  const semanticVariants = await generateSemanticVariants(query);
  semanticVariants.forEach(variant => expandedQueries.push(variant));

  // Technique 4: Intent-based expansion based on query type
  const intent = detectQueryIntent(query);
  if (intent === 'informational') {
    expandedQueries.push(`${query} guide`, `${query} tutorial`, `${query} explained`);
  } else if (intent === 'commercial') {
    expandedQueries.push(`${query} best`, `${query} reviews`, `${query} comparison`);
  }

  return expandedQueries;
};

const expandedSearch = async (query: string): Promise<SearchResult[]> => {
  const expandedQueries = await semanticExpansion(query);
  
  // Parallel search across all expanded queries
  const results: SearchResult[] = [];
  
  for (const expandedQuery of expandedQueries) {
    const searchResults = await searchEngine.search({
      query: expandedQuery,
      numResults: 5 // Smaller limit for expanded queries
    });
    
    // Filter out results already found in Stage 1 (by URL)
    const newResults = searchResults.results.filter(
      r => !results.some(existing => existing.url === r.url)
    );
    
    results.push(...newResults);
  }

  return results;
};
```

**Expansion Techniques:**

#### 2.1 Synonym Generation
Generate synonyms for key terms in the query:

```typescript
// For query "best AI tools"
const synonyms = [
  (tools, applications, systems, software),           // Synonyms for "tools"
  (intelligent systems, machine learning platforms)    // Synonyms for "AI"
];

// Result: "best AI applications", "intelligent systems best tools"
```

#### 2.2 Semantic Rephrasing
Create alternative formulations:

```typescript
// Input: "best AI tools"
const semanticVariants = [
  "top-rated artificial intelligence software",
  "leading machine learning platforms 2024",
  "recommended intelligent systems for professionals"
];
```

#### 2.3 Query Type Detection & Expansion
Detect intent and add type-specific keywords:

```typescript
// Detect query types (regex or simple keyword detection)

function detectQueryIntent(query: string): QueryIntent {
  const lower = query.toLowerCase();
  
  if (/[0-9]{4,}|\d{4}/.test(query)) {
    return 'temporal' as const; // Contains year/number
  }
  
  if (/(best|top|leading|recommended|favorite)/i.test(lower)) {
    return 'recommendation' as const; // Recommendation/commercial intent
  }
  
  if (/(how to|explain|what is|guide|tutorial)/i.test(lower)) {
    return 'informational' as const; // Information-seeking intent
  }
  
  if (/(for me|for beginner|for advanced)/i.test(lower)) {
    return 'targeted' as const; // Target audience
  }
  
  return 'general' as const;
}

// Expansion based on intent:
if (intent === 'recommendation') {
  return [`${query} best`, `${query} top rated`, `${query} reviews`];
} else if (intent === 'informational') {
  return [`${query} explained`, `${query} guide`, `${query} tutorial`];
} else if (intent === 'targeted') {
  const audience = detectAudience(query); // beginner, intermediate, expert
  return [`${query} for ${audience}`, `${query} beginner friendly`];
}
```

### Stage 3: Progressive Deepening
If expansion doesn't find enough quality results, dive deeper into the topic.

```typescript
const progressiveDeepening = async (query: string, depth: number = 2): Promise<SearchResult[]> => {
  const results: SearchResult[] = [];
  
  // Depth 1: Basic search with the query
  const baseResults = await literalSearch(query);
  results.push(...baseResults.filter(r => r.relevanceScore > 0.5)); // Quality threshold
  
  if (results.length >= MINIMUM_RESULTS) {
    return results; // Success, don't go deeper
  }
  
  // Depth 2: Explore related topics and drill down
  
  const relatedTopics = await extractRelatedTopics(query);
  
  for (const topic of relatedTopics) {
    const deepSearch = await searchEngine.search({
      query: `${query} ${topic}`, // Progressive deepening
      numResults: 5
    });
    
    results.push(...deepSearch.results.filter(
      r => !results.some(existing => existing.url === r.url) && 
           r.relevanceScore > 0.3 // Lower threshold for deeper searches
    ));
    
    if (results.length >= MINIMUM_RESULTS) {
      break; // Success threshold met
    }
  }
  
  // Depth 3: Alternative perspectives or adjacent concepts
  if (results.length < MINIMUM_RESULTS) {
    const alternatives = await generateAlternativePerspectives(query);
    
    for (const alt of alternatives) {
      const altResults = await searchEngine.search({
        query: alt,
        numResults: 3
      });
      
      results.push(...altResults.results.filter(
        r => !results.some(existing => existing.url === r.url)
      ));
    }
  }
  
  return results;
};
```

**Deepening Strategies:**

#### 3.1 Topic Decomposition
Break the query into subtopics:

```typescript
// Input: "machine learning for image classification"
const relatedTopics = [
  "convolutional neural networks",    // CNNs - core technique
  "image preprocessing methods",     // Pre-processing
  "model evaluation metrics",        // Evaluation
  "transfer learning images",        // Advanced technique
  "computer vision applications"     // Applications
];

// Progressive searches:
// "machine learning for image classification CNN"
// "image classification preprocessing techniques"
```

#### 3.2 Perspective Variation
Search from different angles:

```typescript
const alternativePerspectives = (query: string) => {
  const perspectives = [
    // Academic vs. practical angle
    `${query} case study`,
    `${query} real-world examples`,
    
    // Time-based (latest developments)
    `${query} 2024`,
    `${query} latest trends`,
    
    // Location/region specific
    `${query} United States`,
    `${query} Europe`,
    
    // Tool/technology specific
    `${query} Python`,
    `${query} TensorFlow implementation`
  ];
  
  return perspectives;
};
```

#### 3.3 Word Play & Semantic Variations
Use clever variations to find alternative formulations:

```typescript
const wordPlayExpansion = (query: string) => {
  const words = query.split(' ');
  
  return [
    // Synonym swapping for each word
    ...swapSynonymsInQuery(query),
    
    // Phrase variations using different connectors
    ...generatePhraseVariations(query, [
      'how to', 'ways to', 'methods for', 
      'guide to', 'learn about'
    ]),
    
    // Question format transformation
    ...transformToQuestion(query)
  ];
};

// Examples:
// "best AI tools" → 
// - "top-rated artificial intelligence software" (synonym swap)
// - "How to find best AI tools" (phrase variation)
// - "What are the best AI tools?" (question format)

// For a more interesting example:
// Input: "recipe chicken eggs"
// Expands to:
// - "best recipes using chicken and eggs" (adding verbs)
// - "chicken egg dish ideas" (rephrasing)
// - "How to cook chicken with eggs" (adding verb phrase)
// - "What can I make with chicken and eggs?" (question format)

// Input: "fix disk errors"
// Expands to:
// - "corrupt disk repair tools Windows/Linux" (adding related terms)
// - "scanning hard drive for issues" (paraphrasing)
// - "How to repair corrupted files on disk" (adding question context)
```

### Stage 4: Query Synthesis & Multi-Step Search
Combine insights from multiple searches into a cohesive result.

```typescript
const multiStepSearch = async (
  originalQuery: string,
  stage1Results: SearchResult[],
  stage2Results: SearchResult[]
): Promise<SearchResult[]> => {
  const allResults = [...stage1Results, ...stage2Results];
  
  if (allResults.length === 0) {
    return []; // No results found at all
  }
  
  // Synthesize content from multiple search stages
  const groupedResults = groupBySource(allResults);
  
  // Try to extract insights from each source type
  const synthesis = await generateSynthesis({
    originalQuery,
    directResults: groupedResults.directStage1,
    expandedResults: groupedResults.expandedStage2,
    deepenedResults: groupedResults.deep3
  });
  
  // Return synthesized result that combines the best of all searches
  return [{
    ...synthesis,
    title: `Multi-Step Search: ${originalQuery}`,
    url: 'synthesized-result', // Or link to primary source
    description: synthesis.summary,
    content: synthesis.fullContent, // Combined from all stages
    tags: ['synthesized', 'multi-step']
  }];
};

function groupBySource(results: SearchResult[]) {
  return {
    directStage1: results.filter(r => r.source === 'stage1-literal'),
    expandedStage2: results.filter(r => r.source === 'stage2-expanded'),
    deep3: results.filter(r => r.source === 'stage3-deepened')
  };
}

async function generateSynthesis(input: SynthesisInput): Promise<SynthesisResult> {
  // Analyze all results for common themes, contradictions, consensus
  
  const analysis = await analyzeSearchResults({
    queries: input.originalQuery,
    results: [...input.directResults, ...input.expandedResults, ...input.deep3]
  });
  
  return {
    summary: generateCoherentSummary(analysis),
    fullContent: combineFullContents(input.directResults, input.expandedResults, input.deep3),
    sources: [...input.directResults.map(r => r.url), 
              ...input.expandedResults.map(r => r.url)],
    consensusPoints: analysis.consensus,
    conflictingViews: analysis.conflicts
  };
}

interface SynthesisInput {
  originalQuery: string;
  directResults: SearchResult[];
  expandedResults: SearchResult[];
  deep3Results: SearchResult[];
}

interface SynthesisResult {
  title: string;
  url: string;
  description: string;
  content: string;
  sources: string[]; // All URLs used in synthesis
}

interface SearchAnalysis {
  consensus: string[]; // Points agreed upon across sources
  conflicts: { topic: string; viewpoints: string[] }; // Where sources disagree
  patterns: PatternMatch[]; // Related topics found across stages
}

interface PatternMatch {
  topic: string; // E.g., "pricing", "features", "performance"
  findings: { source1: string; finding1: string };
}
```

## Implementation Architecture

### Component 1: QueryIntentDetector
Detects the type of query to apply appropriate expansion strategies.

```typescript
// src/query-intent-detector.ts

export enum QueryIntent {
  INFORMATIONAL,   // "What is X", "Explain Y"
  COMMERCIAL,      // "Best X", "Buy X"  
  NAVIGATIONAL,    // "site:example.com X"
  QUESTION,        // Questions ending with ?
  COMPLEX_TASK,    // Multi-step requests
}

export interface QueryIntentDetector {
  detectIntent(query: string): Promise<QueryIntent>;
}

export class StandardIntentDetector implements QueryIntentDetector {
  async detectIntent(query: string): Promise<QueryIntent> {
    const lower = query.toLowerCase().trim();
    
    // Check for question patterns
    if (/[?!.]/.test(lower) || /^what .+ is$/.test(lower) ||/^how to .+$/.test(lower)) {
      return QueryIntent.QUESTION;
    }
    
    // Check for commercial intent (recommendations)
    if (/^(best|top|leading|recommended|rated)/i.test(lower)) {
      return QueryIntent.COMMERCIAL;
    }
    
    // Check for navigational intent (specific sites)
    if (/site:|\/|^www\.|^example\./.i.test(lower)) {
      return QueryIntent.NAVIGATIONAL;
    }
    
    // Default: informational
    return QueryIntent.INFORMATIONAL;
  }
}
```

### Component 2: Synonym & Semantic Expander
Expands queries using synonym databases and semantic alternatives.

```typescript
// src/semantic-expander.ts

export interface SemanticExpansionConfig {
  maxExpandedQueries: number;      // How many variations to generate
  minResultThreshold: number;      // Min results before expanding further
}

export interface SemanticExpander {
  expandQuery(
    query: string, 
    intent?: QueryIntent
  ): Promise<string[]>;
}

// Pre-loaded synonym database (can be from various sources)
const SYNONYM_DB: Record<string, string[]> = {
  'ai': ['artificial intelligence', 'machine learning', 'intelligent systems'],
  'tools': ['software applications', 'platforms', 'utilities', 'systems'],
  'best': ['top-rated', 'leading', 'recommended', 'highest rated'],
  'how to': ['guide for', 'tutorial about', 'learn how to'],
  'fix': ['repair', 'resolve', 'correct', 'solve'],
  // ... extensive synonym database
};

// Thesaurus for semantic enrichment  
const THEASURUS: Record<string, string[]> = {
  'good': ['excellent', 'outstanding', 'superior', 'exceptional'],
  'useful': ['practical', 'beneficial', 'valuable', 'helpful'],
  // ... more semantic mappings
};

export class SemanticExpander implements SemanticExpander {
  constructor(private config: SemanticExpansionConfig) {}

  async expandQuery(query: string, intent?: QueryIntent): Promise<string[]> {
    const expanded = new Set<string>();
    expanded.add(query); // Original query always included

    // 1. Synonym expansion for each word
    const expandedBySynonyms = await this.expandBySynonyms(query, expanded);

    // 2. Semantic enrichment based on intent
    if (intent) {
      const enriched = await this.enrichByIntent(query, intent);
      expandedBySynonyms.push(...enriched);
    }

    // 3. Phrase variation generation  
    const variations = await this.generatePhraseVariations(query);
    expandedBySynonyms.push(...variations);

    // Return top N queries by relevance scoring
    return this.rankAndReturn(expandedBySynonyms, expanded);
  }

  private async expandBySynonyms(
    query: string, 
    expanded: Set<string>
  ): Promise<string[]> {
    const words = query.split(/\s+/);
    const replacements: string[] = [];

    for (const word of words) {
      const synonyms = this.findSynonyms(word.toLowerCase());
      
      for (const synonym of synonyms) {
        const replacement = query.replace(word, synonym);
        if (replacement !== query && !expanded.has(replacement)) {
          expanded.add(replacement);
          replacements.push(replacement);
        }
      }
    }

    return replacements;
  }

  private async enrichByIntent(query: string, intent: QueryIntent): Promise<string[]> {
    const enriched = [];

    switch (intent) {
      case QueryIntent.COMMERCIAL:
        enriched.push(
          `${query} reviews`,
          `${query} comparison 2024`,  
          `top ${query}`,
          `best practices for ${query}`
        );
        break;
        
      case QueryIntent.INFORMATIONAL:
        enriched.push(
          `${query} explained`,
          `What is ${query}`,
          `${query} tutorial`,
          `${query} for beginners`
        );
        break;

      case QueryIntent.COMPLEX_TASK:
        enriched.push(
          `steps to ${query}`,
          `${query} complete guide`,
          `${query} how-to`
        );
        break;
    }

    return enriched.filter(q => !expanded.has(q));
  }

  private async generatePhraseVariations(query: string): Promise<string[]> {
    const synonyms = this.findSynonyms([...query]);
    
    return [
      // Convert to question format
      `How can I ${query.split(' ')[0]}?`,
      // Add instructional prefix  
      `Best ways to ${query.split(' ')[0]}`,
      // Use different conjunctions
    ];
  }

  private rankAndReturn(queries: string[], limit: number): string[] {
    // Rank queries by predicted relevance to original intent
    // Return top N
    
    return queries.slice(0, limit);
  }

  private findSynonyms(word: string): string[] {
    const lower = word.toLowerCase();
    
    // Check synonym database
    if (SYNONYM_DB[lower]) {
      return SYNONYM_DB[lower];
    }

    // Check thesaurus for semantic alternatives
    if (THEASURUS[lower]) {
      return THEASURUS[lower];
    }

    // Return empty if no synonyms found
    return [];
  }

  private findSynonyms(words: string[]): string {
    // Combine synonyms for multiple words
    const allSynonyms = [];
    
    words.forEach(word => {
      const synonyms = this.findSynonyms(word);
      allSynonyms.push(...synonyms);
    });

    return allSynonyms;
  }
}
```

### Component 3: Progressive Search Engine
Orchestrates multi-stage search with automatic progression.

```typescript
// src/progressive-search-engine.ts

export interface ProgressiveSearchOptions {
  query: string;
  maxDepth: number;           // How deep to go (1 = literal only, 3+ = multi-stage)
  minResultsPerStage: number; // Must find X results before expanding
  maxTotalResults: number;    // Cap total results returned
}

export interface ProgressiveSearchResult {
  title: string;
  url: string;
  description: string;
  stage: number;             // Which search stage this came from
  queryUsed: string;         // What query was used to find this result
  relevanceScore: number;    // Relevance score (0-1)
}

export interface ProgressiveSearchEngine {
  search(
    query: string, 
    options?: ProgressiveSearchOptions
  ): Promise<ProgressiveSearchResult[]>;
}

export class MultiStageSearchEngine implements ProgressiveSearchEngine {
  constructor(private searchEngines: SearchEngine[]) {}

  async search(
    query: string, 
    options: ProgressiveSearchOptions = { maxDepth: 3 }
  ): Promise<ProgressiveSearchResult[]> {
    const results: ProgressiveSearchResult[] = [];
    
    // Stage 1: Literal search (immediate realm)
    const stage1Results = await this.performLiteralSearch(query);
    
    // Check if we have enough results to stop here
    const goodResults = stage1Results.filter(r => r.relevanceScore > 0.7);
    
    if (goodResults.length >= options.minResultsPerStage && 
        goodResults.length <= options.maxTotalResults) {
      return goodResults; // Success! Return only high-quality results from Stage 1
    }

    // Need to expand - proceed to deeper stages
    
    let currentQuery = query;
    
    for (let depth = 2; depth <= options.maxDepth; depth++) {
      // Expand current query using semantic expansion
      const expandedQueries = await this.semanticExpander.expandQuery(
        currentQuery
      );

      // Search with expanded queries in parallel (or sequentially if needed)
      for (const expandedQuery of expandedQueries) {
        const stageResults = await this.searchWithEngine(expandedQuery);
        
        // Filter out results already found in previous stages (by URL)
        const newResults = stageResults.results.filter(
          r => !results.some(existing => existing.url === r.url)
        );

        results.push(
          ...newResults.map(r => ({
            ...r,
            stage: depth,
            queryUsed: expandedQuery
          }))
        );

        // Check if we've reached our limit
        if (results.length >= options.maxTotalResults) {
          break; // Done!
        }

        // Check if we have enough good results to stop expanding at this depth
        const goodExpanded = newResults.filter(r => r.relevanceScore > 0.5);
        if (goodExpanded.length >= options.minResultsPerStage) {
          break; // Found enough good results, don't go deeper
        }

        currentQuery = expandedQuery; // Use the best expanded query for next iteration
      }

      if (results.length >= options.maxTotalResults) {
        break; // Reached global limit
      }

      if (depth === options.maxDepth) {
        break; // Max depth reached
      }
    }

    return results;
  }

  private async performLiteralSearch(query: string): Promise<ProgressiveSearchResult[]> {
    const results = [];

    // Try all search engines in parallel first (fast path)
    try {
      const engine = this.searchEngines[0]; // Primary (fastest)
      const rawResults = await engine.search({ query, numResults: 15 });

      results.push(
        ...rawResults.results.map((r, i) => ({
          title: r.title,
          url: r.url,
          description: r.description || '',
          stage: 1,
          queryUsed: query,
          relevanceScore: this.calculateRelevance(r.title, r.description, query)
        }))
      );
    } catch (error) {
      console.error('Primary engine failed:', error);

      // Fallback to other engines if primary fails
      for (let i = 1; i < this.searchEngines.length && results.length < 20; i++) {
        try {
          const engine = this.searchEngines[i];
          const rawResults = await engine.search({ query, numResults: 10 });

          results.push(
            ...rawResults.results.map((r, j) => ({
              title: r.title,
              url: r.url, 
              description: r.description || '',
              stage: 1,
              queryUsed: query,
              relevanceScore: this.calculateRelevance(r.title, r.description, query)
            }))
          );
        } catch (engineError) {
          console.error('Engine fallback failed:', engineError);
        }
      }
    }

    return results;
  }

  private async searchWithEngine(query: string): Promise<SearchResult[]> {
    // Search using primary engine (or fallback)
    return this.searchEngines[0].search({ query, numResults: 10 });
  }

  private calculateRelevance(
    title: string, 
    description: string, 
    query: string
  ): number {
    const lowerTitle = title.toLowerCase();
    const lowerDescription = description.toLowerCase();
    const lowerQuery = query.toLowerCase();

    // Count matches in title and description
    let score = 0;
    
    const words = query.split(/\s+/);
    words.forEach(word => {
      if (lowerTitle.includes(word) || lowerDescription.includes(word)) {
        score++;
      }
    });

    // Normalize to 0-1 range (max possible score)
    const maxScore = words.length;
    return Math.max(0, score / maxScore);
  }
}
```

### Component 4: Query Synthesizer
Combines results from multiple search stages into a coherent response.

```typescript
// src/query-synthesizer.ts

export interface SynthesisInput {
  originalQuery: string;
  stage1Results: SearchResult[];     // Literal search results
  stage2Results: SearchResult[];     // Expanded query results  
  stage3Results?: SearchResult[];    // Deepened search results (optional)
}

export interface SynthesisResult {
  title: string;
  url: string; // Primary or synthesized URL
  description: string;              // Coherent summary of findings
  content: string;                  // Combined full content
  sources: string[];                // All URLs used
  synthesisMetadata: {
    stagesUsed: number;
    totalSources: number;
    keyInsights: string[];
  };
}

export class QuerySynthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const { originalQuery, stage1Results, stage2Results } = input;

    // Check if we have no results at all
    const allResults = [stage1Results, stage2Results].flat();
    
    if (allResults.length === 0) {
      throw new Error('No search results found. Try a different query.');
    }

    // If only Stage 1 has results, use them directly
    if (stage2Results.length === 0) {
      return this.createDirectResult(stage1Results); // "Litler" result
    }

    // Multi-stage synthesis: combine results from all stages
    
    // Group by topic/theme
    const grouped = this.groupByTopic([...stage1Results, ...stage2Results]);

    // Find consensus points (topics where multiple sources agree)
    const consensusPoints = this.findConsensus(grouped);

    // Generate a coherent narrative that weaves together results
    const synthesis = await this.generateCoherentNarrative({
      originalQuery,
      consensusPoints,
      allResults
    });

    return {
      title: `Comprehensive Search: ${originalQuery}`,
      url: 'synthesized-result', // Or link to most authoritative source
      description: synthesis.overview,
      content: synthesis.narrative,
      sources: [...new Set(
        allResults.map(r => r.url)
      )],
      synthesisMetadata: {
        stagesUsed: input.stage3Results ? 3 : 2,
        totalSources: allResults.length,
        keyInsights: consensusPoints.map(cp => cp.insight)
      }
    };
  }

  private createDirectResult(results: SearchResult[]): SynthesisResult {
    return {
      title: 'Search Results',
      url: results[0]?.url || '',
      description: `Found ${results.length} results for your query`,
      content: this.formatResultsAsText(results),
      sources: results.map(r => r.url),
      synthesisMetadata: {
        stagesUsed: 1,
        totalSources: results.length,
        keyInsights: []
      }
    };
  }

  private async groupByTopic(results: SearchResult[]): Promise<TopicGroup[]> {
    // Use clustering or semantic similarity to group results by topic
    const topics = await this.extractTopics(results);
    
    return topics.map(topic => ({
      topic,
      results: results.filter(r => r.isRelatedToTopic(topic))
    }));
  }

  private async findConsensus(groupedTopics: TopicGroup[]): Promise<ConsensusPoint[]> {
    const consensusPoints = [];

    for (const group of groupedTopics) {
      if (group.results.length >= 2) { // Need at least 2 sources for consensus
        const commonPoints = this.findCommonGround(group.results);

        if (commonPoints.length > 0) {
          consensusPoints.push({
            topic: group.topic,
            insights: commonPoints
          });
        }
      }
    }

    return consensusPoints;
  }

  private async generateCoherentNarrative(input: NarrativeInput): Promise<NarrativeOutput> {
    // Build a coherent story from multiple sources
    const sections = this.createNarrativeSections(input);

    let narrative = '';
    
    // Introduction
    narrative += `## Overview of ${input.originalQuery}\n\n`;
    narrative += `${this.summarizeConsensus(input.consensusPoints)}\n\n`;

    // Detailed sections for each topic
    for (const section of sections) {
      narrative += `### ${section.topic}\n\n`;
      narrative += `${section.content}\n\n`;
    }

    // Sources section
    const sourceCount = input.allResults.length;
    narrative += `\n\n---\n\n` + `**Sources:** ${sourceCount} different web pages synthesized into this response.\n`;

    return {
      overview: `This comprehensive search for "${input.originalQuery}" synthesized information from ${sourceCount} sources ` +
                `across multiple search stages, providing a cohesive view of the topic.`,
      narrative: narrative.trim()
    };
  }

  private formatResultsAsText(results: SearchResult[]): string {
    let text = `Search completed for "${results[0]?.queryUsed || ''}" with ${results.length} results:\n\n`;

    results.forEach((result, idx) => {
      text += `**${idx + 1}. ${result.title}**\n`;
      text += `URL: ${result.url}\n`;
      text += `Description: ${result.description}`;
      
      if (result.content) {
        text += `\n\n**Full Content:**\n${result.content}`;
      }

      text += `\n\n---\n\n`;
    });

    return text;
  }
}

interface TopicGroup {
  topic: string;
  results: SearchResult[];
}

interface ConsensusPoint {
  topic: string; // E.g., "pricing", "performance"
  insight: string; // Agreed-upon finding from multiple sources
}

interface NarrativeInput {
  originalQuery: string;
  consensusPoints: ConsensusPoint[];
  allResults: SearchResult[];
}

interface NarrativeOutput {
  overview: string;
  narrative: string;
}
```

## Usage Examples with Progressive Search

### Example 1: Ambiguous Query - "Spring"
```json
{
  "name": "full-web-search",
  "arguments": {
    "query": "Spring"
  }
}
```

**Execution Flow:**
1. **Stage 1 (Literal):** Search "Spring" → Returns mixed results (season, Java framework, coil spring)
2. **Stage 2 (Expansion):** Semantic expansion adds: "Spring season weather", "Spring Java framework tutorial"
3. **Stage 3 (Deepening):** If still no clear winner, search "Spring Framework documentation", "What is Spring Java?"
4. **Result:** User sees comprehensive results covering all meanings, or asks for clarification

### Example 2: Vague Intent - "fix disk errors"
```json
{
  "name": "full-web-search", 
  "arguments": {
    "query": "fix disk errors"
  }
}
```

**Execution Flow:**
1. **Stage 1 (Literal):** Search "fix disk errors" → May return minimal relevant results
2. **Stage 2 (Expansion):** Expands to: "repair disk errors Windows", "corrupt hard drive fix Linux", "scanning disk for bad sectors"
3. **Stage 3 (Deepening):** Searches: "chkdsk command guide", "S.M.A.R.T. disk monitoring tools"
4. **Synthesis:** Combines all results into: "Complete Guide to Fixing Disk Errors Across Windows and Linux Systems"

### Example 3: Informational Query - "machine learning image classification"
```json
{
  "name": "full-web-search",
  "arguments": {
    "query": "machine learning image classification"
  }
}
```

**Execution Flow:**
1. **Stage 1 (Literal):** Search "machine learning image classification" → Returns good foundational content
2. **Stage 1 (Expansion):** Expands to: "CNN neural networks tutorial", "image preprocessing techniques"
3. **Stage 2 (Deepening):** If needed, searches: "deep learning applications computer vision"
4. **Synthesis:** Creates cohesive narrative covering fundamentals, techniques, and advanced topics

## Configuration Options

### Environment Variables
```bash
# Progressive Search Configuration
MAX_SEARCH_DEPTH=3              # How many stages of expansion/deepening (1-5)
MIN_RESULTS_PER_STAGE=3         # Min results to consider previous stage "successful"
MAX_TOTAL_RESULTS=15            # Cap on total results across all stages (default: 10)
ENABLE_SEMANTIC_EXPANSION=true  # Enable synonym/semantic query expansion
EXPANDED_QUERY_LIMIT=5          # Max expanded queries to try per stage

# Relevance Scoring
RELEVANCE_THRESHOLD=0.5         # Score threshold for "good" results (0-1)
RELEVANCE_WEIGHT=0.8            # Weight of relevance score in final ranking

# Synthesis Options  
ENABLE_SYNTHESIS=true           # Combine multi-stage results into narrative
SYNTHESIS_MIN_STAGES=2          # Min stages needed before synthesis kicks in

# Query Expansion
SYNONYM_DB_PATH=~/synonyms.txt  # Path to custom synonym database  
THEASURUS_ENABLED=true          # Enable thesaurus-based expansion
EXPANSION_PRIORITY=semantic,phrase,literal  # Priority order for expansions
```

## Performance Considerations

### Parallel Execution Strategy
- All search engines in Stage 1 run **in parallel** (Promise.race pattern)
- Expanded queries in subsequent stages can also run **in parallel** up to a concurrency limit
- This keeps latency low even with multi-stage search

### Results Caching (Optional Enhancement)
```typescript
// Cache URLs across stages to avoid duplicate results
const urlCache = new Set<string>();

function isDuplicate(url: string): boolean {
  if (urlCache.has(url)) return true;
  urlCache.add(url);
  return false;
}

// Before adding a result:
if (!isDuplicate(result.url)) {
  results.push(result);
}

// Optionally, save cache to file for faster subsequent searches on same query
```

### Query Reuse Prevention
- Track URLs across all stages to prevent returning the same result multiple times
- Deduplicate results by URL before returning

## Advanced Features (Optional Extensions)

### 1. User Feedback Loop
```typescript
interface UserFeedback {
  rating: number;     // 1-5 stars on result quality
  preferredStage: number; // Which search stage they liked best
  additionalQuery?: string; // What they wanted to see but didn't
}

// After returning results, ask: "Was this helpful? If not, how can I improve?"
// Use feedback to refine expansion for future searches
```

### 2. Context Tracking
- Remember previous search queries in the same session
- Use context to inform expansion: "How do X and Y relate?" → search both X, Y, and their intersection

### 3. Topic-Aware Expansion
```typescript
// Learn/track topics that frequently need expansion for a user/account
const topicExpansionMap = new Map<string, string[]>();

// If "Python programming" needs expansion to "Python coding tutorial",
// remember this for future similar queries
```

## Summary: The Progressive Search Strategy

The key advance over traditional web search is this multi-stage approach:

| Stage | What it does | When to use |
|-------|--------------|-------------|
| 1. Literal | Search exactly what user typed | **Always** (baseline) |
| 2. Semantic Expansion | Try synonyms, rephrasings based on query intent | If Stage 1 has < MIN_RESULTS_PER_STAGE |
| 3. Progressive Deepening | Dig deeper into the topic with "X for beginners", "X advanced guide" | If Stage 2 still needs help |
| Synthesis (optional) | Combine all results into a coherent narrative | If multiple stages were needed |

### Key Benefits:
1. **Respects user's original intent** (literal search first)  
2. **Adaptive** - only expands if needed
3. **Comprehensive yet efficient** - tries more than user gives, but stops when success
4. **Handles ambiguity gracefully** - if "Spring" means season, flower, or Java framework, find content for all
5. **Creates added value through synthesis** - combines findings into a cohesive answer

### Word Play & Semantic Understanding:
The approach naturally incorporates word play by:
- Finding synonyms for ambiguous terms (Spring → seasons, Java framework, coil springs)  
- Rephrasing queries in different ways (statement → question → command)
- Adding related words naturally (fix disk errors → corrupt files, scan for issues, bad sectors)

This implementation strategy will make your MCP server significantly more effective at handling the varied ways users express their search intent, while still respecting their original query and only expanding when it helps find better results.