import * as cheerio from 'cheerio';

// Content quality result interface
export interface ContentQualityResult {
  content: string;
  score: number;        // 0-1 quality score
  isValid: boolean;     // Passes minimum threshold
  wordCount: number;
}

// Configuration for content quality assessment
export interface QualityAssessmentConfig {
  minContentLength: number;
  relevanceThreshold: number;
  enableKeywordScoring: boolean;
}

// Default configuration
const DEFAULT_CONFIG: QualityAssessmentConfig = {
  minContentLength: 200,
  relevanceThreshold: 0.3,
  enableKeywordScoring: true,
};

/**
 * Scans HTML and dynamically selects the best content selector for a page
 */
export function getBestContentSelector(html: string): string {
  const $ = cheerio.load(html);
  
  // Priority selectors for main content (in order of preference)
  const contentSelectors = [
    'article',
    'main',
    '[role="main"]',
    '.content',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.story-content',
    '.news-content',
    '.main-content',
    '.page-content',
    '.text-content',
    '.body-content',
    '.copy',
    '.text',
    '.body',
  ];
  
  for (const selector of contentSelectors) {
    const $element = $(selector).first();
    if ($element.length > 0) {
      // Check if this element has substantial content
      const textContent = $element.text().trim();
      if (textContent.length > 100) {
        return selector;
      }
    }
  }
  
  // If no specific content area found, use body
  return 'body';
}

/**
 * Assesses the quality of extracted content
 */
export function scoreContentQuality(
  content: string,
  query?: string,
  config: Partial<QualityAssessmentConfig> = {}
): ContentQualityResult {
  const effectiveConfig = { ...DEFAULT_CONFIG, ...config };
  
  // Clean up content
  const cleanedContent = cleanText(content);
  const wordCount = getWordCount(cleanedContent);
  
  // Calculate quality score components
  let score = 0;
  const reasons = [];
  
  // 1. Length check (40% weight)
  if (cleanedContent.length >= effectiveConfig.minContentLength) {
    score += 0.4;
    reasons.push(`Length OK (${cleanedContent.length} chars >= ${effectiveConfig.minContentLength})`);
  } else {
    reasons.push(`Too short (${cleanedContent.length} chars < ${effectiveConfig.minContentLength})`);
  }
  
  // 2. Text complexity (30% weight)
  const avgWordLength = wordCount > 0 ? cleanedContent.length / wordCount : 0;
  if (avgWordLength >= 4 && avgWordLength <= 8) {
    score += 0.3; // Optimal range for readable content
    reasons.push(`Good word complexity (avg ${avgWordLength.toFixed(1)} chars/word)`);
  } else if (avgWordLength > 0) {
    score += 0.15;
    reasons.push(`Avg word length: ${avgWordLength.toFixed(1)} chars`);
  }
  
  // 3. Sentence structure (15% weight)
  const sentences = cleanedContent.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length >= 2) {
    score += 0.15;
    reasons.push(`Multiple sentences (${sentences.length})`);
  } else if (sentences.length === 1) {
    score += 0.05;
    reasons.push(`Single sentence detected`);
  }
  
  // 4. Structural integrity (15% weight)
  // Check for presence of multiple headings or lists which indicate structured information
  const hasHeadings = /#{1,6}\s/.test(cleanedContent) || /^[A-Z][^.!?]*\n/.test(cleanedContent);
  const hasLists = /^\s*[*+-]\s+/.test(cleanedContent) || /^\d+\.\s+/.test(cleanedContent);
  
  if (hasHeadings && hasLists) {
    score += 0.15;
    reasons.push(`High structural signal (headings + lists)`);
  } else if (hasHeadings || hasLists) {
    score += 0.07;
    reasons.push(`Moderate structural signal`);
  }

  // 5. Signal vs Noise (15% weight)
  // Higher score for technical/formal content, lower for heavy marketing/adjective usage
  const marketingJargon = /\b(amazing|unbelievable|revolutionary|game-changer|limited time|click here|buy now|best ever|must have|unbeatable)\b/gi;
  const technicalTerms = /\b(implementation|architecture|protocol|framework|specification|concurrency|optimization|asynchronous|parameter|instance|metadata|configuration)\b/gi;
  
  const jargonMatches = (cleanedContent.match(marketingJargon) || []).length;
  const techMatches = (cleanedContent.match(technicalTerms) || []).length;
  
  if (techMatches > jargonMatches) {
    score += 0.15;
    reasons.push(`High information density (technical signal)`);
  } else if (jargonMatches > techMatches * 2) {
    score -= 0.1; // Penalty for excessive marketing fluff
    reasons.push(`High noise detected (marketing jargon)`);
  }
  
  // 6. Keyword relevance (10% weight, optional)
  if (effectiveConfig.enableKeywordScoring && query && wordCount > 5) {
    const queryKeywords = extractKeywords(query);
    const contentLower = cleanedContent.toLowerCase();
    
    let keywordMatches = 0;
    for (const keyword of queryKeywords) {
      if (contentLower.includes(keyword)) {
        keywordMatches++;
      }
    }
    
    const relevanceRatio = keywordMatches / Math.max(1, queryKeywords.length);
    score += 0.1 * relevanceRatio;
    reasons.push(`Relevance: ${keywordMatches}/${queryKeywords.length} keywords found`);
  }
  
  // Cap score at 1.0
  score = Math.min(1.0, score);
  
  // Determine validity based on minimum content length and reasonable quality threshold
  const isValid = cleanedContent.length >= effectiveConfig.minContentLength && score >= 0.2;
  
  return {
    content: cleanedContent,
    score,
    isValid,
    wordCount,
  };
}

/**
 * Validates if extracted content meets minimum quality standards
 */
export function validateContentQuality(
  content: string,
  query?: string,
  config: Partial<QualityAssessmentConfig> = {}
): { isValid: boolean; result: ContentQualityResult } {
  const result = scoreContentQuality(content, query, config);
  return {
    isValid: result.isValid,
    result,
  };
}

/**
 * Extracts keywords from a search query
 */
export function extractKeywords(query: string): string[] {
  // Common stop words to exclude
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have',
    'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who',
    'whom', 'whose', 'where', 'when', 'why', 'how', 'all', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just'
  ]);
  
  // Extract words, convert to lowercase, filter stop words
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  return words;
}

/**
 * Cleans text content by removing excessive whitespace and unwanted patterns
 */
export function cleanText(text: string): string {
  // Remove excessive whitespace
  let cleaned = text.replace(/\s+/g, ' ');
  
  // Remove data URLs (base64 images)
  cleaned = cleaned.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '');
  
  // Remove image URLs
  cleaned = cleaned.replace(
    /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|tiff)(\?[^\s]*)?/gi,
    ''
  );
  
  // Remove image file extensions
  cleaned = cleaned.replace(/\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|tiff)/gi, '');
  
  // Remove image-related words
  cleaned = cleaned.replace(
    /image|img|photo|picture|gallery|slideshow|carousel/gi,
    ''
  );
  
  // Remove common non-content patterns
  cleaned = cleaned.replace(
    /cookie|privacy|terms|conditions|disclaimer|legal|copyright|all rights reserved/gi,
    ''
  );
  
  // Remove excessive line breaks
  cleaned = cleaned.replace(/\n\s*\n/g, '\n');
  cleaned = cleaned.replace(/\r\n/g, '\n');
  cleaned = cleaned.replace(/\r/g, '\n');
  
  // Trim whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

/**
 * Counts words in text content
 */
export function getWordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(word => word.length > 0);
  return words.length;
}

/**
 * Gets a quality threshold recommendation based on content length
 */
export function getQualityThresholdForLength(length: number): number {
  if (length < 100) return 0.1;
  if (length < 200) return 0.2;
  if (length < 500) return 0.3;
  if (length < 1000) return 0.4;
  return 0.5;
}