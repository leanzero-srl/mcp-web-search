/**
 * Semantic Expander
 * Expands queries using synonym databases and semantic alternatives
 */

export interface SemanticExpansionConfig {
  maxExpandedQueries: number;      // How many variations to generate
  minResultThreshold: number;      // Min results before expanding further
}

// Pre-loaded synonym database (can be from various sources)
const SYNONYM_DB: Record<string, string[]> = {
  'ai': ['artificial intelligence', 'machine learning', 'intelligent systems'],
  'tools': ['software applications', 'platforms', 'utilities', 'systems'],
  'best': ['top-rated', 'leading', 'recommended', 'highest rated'],
  'how to': ['guide for', 'tutorial about', 'learn how to'],
  'fix': ['repair', 'resolve', 'correct', 'solve'],
  'create': ['build', 'develop', 'make', 'produce'],
  'improve': ['enhance', 'optimize', 'refine', 'upgrade'],
  'guide': ['tutorial', 'handbook', 'manual', 'instructions'],
  'programming': ['coding', 'development', 'software development'],
  'code': ['source code', 'scripts', 'programs'],
  'library': ['package', 'module', 'repository', 'collection'],
  'tutorial': ['guide', 'lesson', 'course', 'walkthrough'],
  'explained': ['understood', 'clarified', 'broken down', 'simplified'],
};

// Thesaurus for semantic enrichment  
const THEASURUS: Record<string, string[]> = {
  'good': ['excellent', 'outstanding', 'superior', 'exceptional'],
  'useful': ['practical', 'beneficial', 'valuable', 'helpful'],
  'best': ['top', 'leading', 'premier', 'foremost'],
  'easy': ['simple', 'straightforward', 'clear', 'accessible'],
  'difficult': ['challenging', 'complex', 'hard', 'complicated'],
};

/**
 * Semantic Expander - Generates query variations using synonyms and semantic alternatives
 */
export class SemanticExpander {
  constructor(private config: SemanticExpansionConfig = { maxExpandedQueries: 5, minResultThreshold: 3 }) {}

  /**
   * Expand a query into multiple related queries
   */
  async expandQuery(query: string): Promise<string[]> {
    const expanded = new Set<string>();
    expanded.add(query); // Original query always included

    // 1. Synonym expansion for each word
    const synonymExpansions = this.expandBySynonyms(query);
    synonymExpansions.forEach(exp => expanded.add(exp));

    // 2. Phrase variation generation  
    const phraseVariations = this.generatePhraseVariations(query);
    phraseVariations.forEach(variant => expanded.add(variant));

    // 3. Semantic enrichment (thesaurus-based)
    const enriched = this.enrichWithThesaurus(query);
    enriched.forEach(enr => expanded.add(enr));

    // Return top N queries by relevance scoring
    return Array.from(expanded).slice(0, this.config.maxExpandedQueries);
  }

  /**
   * Generate synonyms for each word in the query
   */
  private expandBySynonyms(query: string): string[] {
    const words = query.split(/\s+/);
    const replacements: string[] = [];

    for (const word of words) {
      // Skip short words and common words
      if (word.length < 3 || ['the', 'and', 'for', 'with', 'about'].includes(word.toLowerCase())) {
        continue;
      }

      const synonyms = this.findSynonyms(word);
      
      for (const synonym of synonyms) {
        const replacement = query.replace(new RegExp(`\\b${this.escapeRegExp(word)}\\b`, 'i'), synonym);
        if (replacement !== query && !replacements.includes(replacement)) {
          replacements.push(replacement);
        }
      }
    }

    return replacements;
  }

  /**
   * Add semantic enrichment using thesaurus
   */
  private enrichWithThesaurus(query: string): string[] {
    const enriched: string[] = [];
    const words = query.split(/\s+/);

    for (const word of words) {
      if (word.length < 4) continue;
      
      const alternatives = this.findAlternatives(word);
      
      for (const alt of alternatives) {
        const replacement = query.replace(new RegExp(`\\b${this.escapeRegExp(word)}\\b`, 'i'), alt);
        if (replacement !== query && !enriched.includes(replacement)) {
          enriched.push(replacement);
        }
      }
    }

    return enriched;
  }

  /**
   * Generate phrase variations using different connectors and formats
   */
  private generatePhraseVariations(query: string): string[] {
    const words = query.split(/\s+/);
    if (words.length === 0) return [];

    const firstWord = words[0];
    
    return [
      // Convert to question format
      `How can I ${firstWord}?`,
      `What is the best way to ${firstWord}?`,
      
      // Add instructional prefix  
      `Best ways to ${query}`,
      `Top methods for ${query}`,
      
      // Use different connectors
      `${query} guide`,
      `${query} tutorial`,
      `${query} explained`,
      
      // Add context phrases
      `Complete guide to ${firstWord}`,
      `How-to guide for ${firstWord}`,
    ];
  }

  /**
   * Find synonyms for a word from the synonym database
   */
  protected findSynonyms(word: string): string[] {
    const lower = word.toLowerCase();
    
    // Check synonym database first (exact match)
    if (SYNONYM_DB[lower]) {
      return SYNONYM_DB[lower];
    }

    // Try partial match for longer words
    const keys = Object.keys(SYNONYM_DB);
    for (const key of keys) {
      if (key.length > 3 && lower.includes(key)) {
        return SYNONYM_DB[key];
      }
    }

    return [];
  }

  /**
   * Find semantic alternatives from thesaurus
   */
  protected findAlternatives(word: string): string[] {
    const lower = word.toLowerCase();
    
    // Check thesaurus for semantic alternatives
    if (THEASURUS[lower]) {
      return THEASURUS[lower];
    }

    return [];
  }

  /**
   * Escape special regex characters in a string
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

