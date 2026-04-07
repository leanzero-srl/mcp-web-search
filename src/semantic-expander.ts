/**
 * Semantic Expander
 * Expands queries using synonym databases and semantic alternatives
 */

export interface SemanticExpansionConfig {
  maxExpandedQueries: number;      // How many variations to generate
  minResultThreshold: number;      // Min results before expanding further
}

/**
 * Interface for a semantic expansion engine.
 * This allows for swapping the heuristic engine with an LLM or embedding-based engine.
 */
export interface SemanticExpansionEngine {
  expand(query: string): Promise<string[]>;
}

// Pre-loaded synonym database for the heuristic implementation
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

const THEASURUS: Record<string, string[]> = {
  'good': ['excellent', 'outstanding', 'superior', 'exceptional'],
  'useful': ['practical', 'beneficial', 'valuable', 'helpful'],
  'best': ['top', 'leading', 'premier', 'foremost'],
  'easy': ['simple', 'straightforward', 'clear', 'accessible'],
  'difficult': ['challenging', 'complex', 'hard', 'complicated'],
};

/**
 * Heuristic Semantic Expander - Generates query variations using synonyms and semantic alternatives
 */
export class HeuristicSemanticExpander implements SemanticExpansionEngine {
  constructor(private config: SemanticExpansionConfig = { maxExpandedQueries: 5, minResultThreshold: 3 }) {}

  /**
   * Expand a query into multiple related queries
   */
  async expand(query: string): Promise<string[]> {
    const expanded = new Set<string>();
    expanded.add(query);

    // 1. Synonym expansion
    const synonymExpansions = this.expandBySynonyms(query);
    synonymExpansions.forEach(exp => expanded.add(exp));

    // 2. Phrase variation generation  
    const phraseVariations = this.generatePhraseVariations(query);
    phraseVariations.forEach(variant => expanded.add(variant));

    // 3. Semantic enrichment (thesaurus-based)
    const enriched = this.enrichWithThesaurus(query);
    enriched.forEach(enr => expanded.add(enr));

    return Array.from(expanded).slice(0, this.config.maxExpandedQueries);
  }

  private expandBySynonyms(query: string): string[] {
    const words = query.split(/\s+/);
    const replacements: string[] = [];

    for (const word of words) {
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

  private generatePhraseVariations(query: string): string[] {
    const words = query.split(/\s+/);
    if (words.length === 0) return [];
    const firstWord = words[0];
    
    const variations = [
      `How can I ${query}?`,
      `What is the best way to ${query}?`,
      `Best ways to ${query}`,
      `Top methods for ${query}`,
      `${query} guide`,
      `${query} tutorial`,
      `${query} explained`,
      `Complete guide to ${firstWord}`,
      `How-to guide for ${firstWord}`,
      `Detailed analysis of ${query}`,
      `Understanding ${query}`,
      `Exploring ${query}`,
      `Step-by-step instructions for ${query}`,
      `Comprehensive overview of ${query}`,
      `Latest updates on ${query}`,
    ];

    return variations;
  }

  protected findSynonyms(word: string): string[] {
    const lower = word.toLowerCase();
    if (SYNONYM_DB[lower]) return SYNONYM_DB[lower];
    const keys = Object.keys(SYNONYM_DB);
    for (const key of keys) {
      if (key.length > 3 && lower.includes(key)) return SYNONYM_DB[key];
    }
    return [];
  }

  protected findAlternatives(word: string): string[] {
    const lower = word.toLowerCase();
    if (THEASURUS[lower]) return THEASURUS[lower];
    return [];
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

/**
 * Main Semantic Expander - Acts as a facade for the underlying expansion engine
 */
export class SemanticExpander {
  private engine: SemanticExpansionEngine;

  constructor(engine?: SemanticExpansionEngine) {
    this.engine = engine || new HeuristicSemanticExpander();
  }

  async expandQuery(query: string): Promise<string[]> {
    if (!this.engine) {
      throw new Error("SemanticExpander error: engine is undefined");
    }

    if (typeof this.engine.expand !== 'function') {
      const engineType = typeof this.engine;
      const constructorName = this.engine.constructor ? this.engine.constructor.name : 'unknown';
      const keys = Object.keys(this.engine);
      throw new Error(
        `SemanticExpander engine error: expected function 'expand', but got '${engineType}' from constructor '${constructorName}'. Available keys: [${keys.join(', ')}]`
      );
    }
    return this.engine.expand(query);
  }
}

