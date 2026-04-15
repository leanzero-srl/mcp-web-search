/**
 * OpenAPI & Technical Documentation Extractor
 * 
 * Detects and extracts OpenAPI/Swagger specifications from web pages.
 * Also handles general technical documentation extraction.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { CrawlCache, crawlCache } from './crawl-cache.js';
import {
  TechnicalDocType,
  OpenAPISpecInfo,
  DownloadedOpenAPI,
  OpenAPIExtractionOptions,
  OpenAPIExtractionResult,
} from './types.js';
import { cleanText, generateTimestamp, generateUUID } from './utils.js';

// Common OpenAPI/Swagger URL patterns to try
const OPENAPI_PATH_PATTERNS = [
  // Standard paths
  '/swagger.json',
  '/swagger.yaml',
  '/openapi.json',
  '/openapi.yaml',
  
  // REST API versions
  '/rest/api/latest/swagger.json',
  '/rest/api/v3/swagger.json',
  '/rest/api/v2/swagger.json',
  '/rest/api/v1/swagger.json',
  
  // Common variations
  '/v1/api-docs',
  '/v2/api-docs',
  '/api-docs/v1',
  '/api-docs/v2',
  '/apidocs/swagger.json',
  '/swagger-ui/swagger.json',
  '/docs/swagger.json',
  '/api/swagger.json',
  '/api/openapi.json',
  
  // Atlassian-style versioned
  /\/swagger-v3\.[a-zA-Z0-9._-]+\.json$/,
  
  // Generic API docs patterns
  '/apis/api-docs',
  '/api/specifications',
  '/spec/v1',
  '/spec/v2',
];

// HTML link relation types for OpenAPI discovery
const OPENAPI_LINK_RELATIONS = [
  'search',           // <link rel="search" type="application/openapi+json">
  'alternate',        // <link rel="alternate" type="application/openapi+json">
  'doc',              // <link rel="doc" type="application/openapi+json">
  'service-desc',     // <link rel="service-desc" type="application/openapi+json">
  'http://apielements.org/api/swagger', // Legacy
];

// Content types for OpenAPI discovery
const OPENAPI_CONTENT_TYPES = [
  'application/openapi+json',
  'application/vnd.oai.openapi',
  'application/x.openapi+json',
  'application/swagger+json',
  'application/yaml',
  'text/yaml',
  'application/json',
];

/**
 * Extracts domain and path from a URL
 */
function extractDomainInfo(url: string): { domain: string; path: string } {
  try {
    const urlObj = new URL(url);
    // Remove www. prefix for cleaner naming
    let domain = urlObj.hostname.replace(/^www\./, '');
    
    // Clean up TLDs and get main domain
    const parts = domain.split('.');
    if (parts.length > 1) {
      // Try to get the registrable domain
      domain = parts.slice(-2).join('.');
      // Handle country code TLDs like co.uk
      if (['com', 'org', 'net', 'io', 'ai'].includes(parts[parts.length - 1]) && 
          parts.length > 2) {
        domain = parts.slice(-3).join('.');
      }
    }
    
    return { domain, path: urlObj.pathname };
  } catch {
    return { domain: 'unknown', path: '' };
  }
}

/**
 * Generates a safe filename from a URL or title
 */
function generateFileName(
  domain: string,
  pathOrTitle: string,
  docType: TechnicalDocType = TechnicalDocType.OPENAPI_JSON
): string {
  // Clean the path/title for use in filename
  let cleanName = pathOrTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
  
  if (!cleanName) {
    cleanName = 'api-documentation';
  }
  
  // Map doc type to extension
  let ext = '.json';
  switch (docType) {
    case TechnicalDocType.OPENAPI_YAML:
    case TechnicalDocType.SWAGGER_YAML:
      ext = '.yaml';
      break;
  }
  
  return `${domain}-${cleanName}${ext}`;
}

/**
 * Detects the type of technical documentation from URL or content
 */
function detectDocType(url: string, html?: string): { type: TechnicalDocType; confidence: number } {
  const urlLower = url.toLowerCase();
  const bestType = TechnicalDocType.REST_API;
  const bestConfidence = 0.5;
  
  // Check URL patterns first (highest confidence)
  if (urlLower.includes('openapi.json') || urlLower.includes('/openapi/') || urlLower.match(/\/v\d+\/openapi/)) {
    return { type: TechnicalDocType.OPENAPI_JSON, confidence: 0.95 };
  }
  
  if (urlLower.includes('swagger.json')) {
    return { type: TechnicalDocType.SWAGGER_JSON, confidence: 0.95 };
  }
  
  if (urlLower.includes('openapi.yaml') || urlLower.includes('/swagger.yaml')) {
    return { type: TechnicalDocType.OPENAPI_YAML, confidence: 0.95 };
  }
  
  // Check for versioned swagger patterns like /swagger-v3.xxxx.json
  const versionedSwaggerMatch = url.match(/\/swagger-v\d+\.[a-zA-Z0-9._-]+\.json/);
  if (versionedSwaggerMatch) {
    return { type: TechnicalDocType.SWAGGER_JSON, confidence: 0.9 };
  }
  
  // Check HTML content for clues
  if (html) {
    const $ = cheerio.load(html);
    
    // Look for OpenAPI link tags
    for (const element of $('link').toArray()) {
      const rel = $(element).attr('rel') || '';
      const type = $(element).attr('type') || '';
      const href = $(element).attr('href') || '';
      
      if (rel.toLowerCase() === 'search' && 
          (type.includes('openapi') || type.includes('swagger'))) {
        return { type: TechnicalDocType.OPENAPI_JSON, confidence: 0.9 };
      }
      
      if (href.includes('openapi.json')) {
        return { type: TechnicalDocType.OPENAPI_JSON, confidence: 0.85 };
      }
      
      if (href.includes('swagger.json')) {
        return { type: TechnicalDocType.SWAGGER_JSON, confidence: 0.85 };
      }
    }
    
    // Check title for documentation keywords
    const title = $('title').text().toLowerCase();
    if (title.includes('openapi') || title.includes('swagger')) {
      return { type: urlLower.includes('yaml') ? TechnicalDocType.OPENAPI_YAML : TechnicalDocType.OPENAPI_JSON, confidence: 0.7 };
    }
    
    // Check for API documentation indicators
    const bodyText = $('body').text().toLowerCase();
    if (bodyText.includes('rest api') || bodyText.includes('api reference')) {
      return { type: TechnicalDocType.REST_API, confidence: 0.6 };
    }
  }
  
  return { type: bestType, confidence: bestConfidence };
}

/**
 * Tries to extract OpenAPI spec from a page by checking common patterns
 */
async function discoverOpenAPISpec(
  url: string,
  html?: string,
  maxContentLength: number = 10000000 // 10MB default
): Promise<{ url: string; type: TechnicalDocType } | null> {
  const urlObj = new URL(url);
  
  // If the URL itself looks like an OpenAPI spec, use it directly
  if (urlLowerIncludes(url, 'swagger.json') || urlLowerIncludes(url, 'openapi.json')) {
    const docType = url.toLowerCase().includes('yaml') ? TechnicalDocType.OPENAPI_YAML : TechnicalDocType.OPENAPI_JSON;
    return { url, type: docType };
  }
  
  // Try parsing HTML for OpenAPI links
  if (html) {
    try {
      const $ = cheerio.load(html);
      
      // Check all link tags for OpenAPI references
      for (const element of $('link').toArray()) {
        const rel = $(element).attr('rel') || '';
        const type = $(element).attr('type') || '';
        const href = $(element).attr('href');
        
        if (href && 
            (rel.includes('search') || rel.includes('alternate')) &&
            (type.includes('openapi') || type.includes('swagger'))) {
          
          // Resolve relative URL
          const resolvedUrl = new URL(href, urlObj.origin + urlObj.pathname).href;
          return { url: resolvedUrl, type: TechnicalDocType.OPENAPI_JSON };
        }
        
        if (href && href.match(/\/swagger-v\d+\.[a-zA-Z0-9._-]+\.json/)) {
          const resolvedUrl = new URL(href, urlObj.origin + urlObj.pathname).href;
          return { url: resolvedUrl, type: TechnicalDocType.SWAGGER_JSON };
        }
      }
      
      // Also check for script tags that might reference OpenAPI
      for (const element of $('script').toArray()) {
        const src = $(element).attr('src');
        if (src && 
            (src.includes('swagger') || src.includes('openapi')) &&
            src.match(/\.(json|yaml)$/)) {
          const resolvedUrl = new URL(src, urlObj.origin + urlObj.pathname).href;
          return { url: resolvedUrl, type: src.toLowerCase().includes('yaml') ? TechnicalDocType.OPENAPI_YAML : TechnicalDocType.OPENAPI_JSON };
        }
      }
    } catch (error) {
      console.warn('[OpenAPIExtractor] Error parsing HTML for OpenAPI links:', error);
    }
  }
  
  // Try common path patterns
  for (const pattern of OPENAPI_PATH_PATTERNS) {
    try {
      if (typeof pattern === 'string') {
        const specUrl = urlObj.origin + pattern;
        
        // Skip if pattern doesn't match URL structure
        if (!urlLowerIncludes(url, pattern)) continue;
        
        console.log(`[OpenAPIExtractor] Trying: ${specUrl}`);
        
        try {
          const response = await axios.get(specUrl, {
            timeout: 5000,
            maxContentLength,
            validateStatus: () => true,
            headers: getStandardHeaders(),
          });
          
          if (response.status === 200 && isValidOpenAPIContent(response.data)) {
            console.log(`[OpenAPIExtractor] Found OpenAPI spec at: ${specUrl}`);
            
            const type = pattern.toLowerCase().includes('yaml') 
              ? TechnicalDocType.OPENAPI_YAML 
              : TechnicalDocType.OPENAPI_JSON;
            
            return { url: specUrl, type };
          }
        } catch (error) {
          // Continue to next pattern
        }
      } else if (pattern instanceof RegExp) {
        // Handle regex patterns for versioned swagger files
        const match = url.match(pattern);
        if (match) {
          console.log(`[OpenAPIExtractor] Found versioned swagger in URL: ${url}`);
          return { url, type: TechnicalDocType.SWAGGER_JSON };
        }
      }
    } catch (error) {
      // Continue to next pattern
    }
  }
  
  return null;
}

/**
 * Helper function for case-insensitive string includes
 */
function urlLowerIncludes(url: string, search: string | RegExp): boolean {
  const urlLower = url.toLowerCase();
  if (typeof search === 'string') {
    return urlLower.includes(search);
  }
  return search.test(urlLower);
}

/**
 * Checks if content looks like valid OpenAPI/Swagger JSON
 */
function isValidOpenAPIContent(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  
  // Check for common OpenAPI fields
  const openAPISchema = data as Record<string, unknown>;
  
  // Must have either swagger or openapi field
  const hasSwagger = 'swagger' in openAPISchema && typeof openAPISchema.swagger === 'string';
  const hasOpenAPI = 'openapi' in openAPISchema && typeof openAPISchema.openapi === 'string';
  
  if (!hasSwagger && !hasOpenAPI) return false;
  
  // Should have info object
  if (!openAPISchema.info || typeof openAPISchema.info !== 'object') return false;
  
  // Info should have title and version
  const info = openAPISchema.info as Record<string, unknown>;
  if (!info.title || !info.version) return false;
  
  return true;
}

/**
 * Downloads OpenAPI spec content
 */
async function downloadOpenAPISpec(
  url: string,
  maxContentLength: number = 10000000 // 10MB default
): Promise<{ content: string; type: TechnicalDocType } | null> {
  try {
    console.log(`[OpenAPIExtractor] Downloading OpenAPI spec from: ${url}`);
    
    const response = await axios.get(url, {
      timeout: 30000,
      maxContentLength,
      validateStatus: () => true,
      headers: getStandardHeaders(),
    });
    
    if (response.status !== 200) {
      console.warn(`[OpenAPIExtractor] Failed to download: HTTP ${response.status}`);
      return null;
    }
    
    // Detect content type
    const contentType = response.headers['content-type'] || '';
    let docType: TechnicalDocType = TechnicalDocType.OPENAPI_JSON;
    
    if (contentType.includes('yaml') || url.toLowerCase().endsWith('.yaml')) {
      docType = TechnicalDocType.OPENAPI_YAML;
    } else if (url.toLowerCase().includes('swagger.json')) {
      docType = TechnicalDocType.SWAGGER_JSON;
    }
    
    const content = typeof response.data === 'string' 
      ? response.data 
      : JSON.stringify(response.data, null, 2);
    
    return { content, type: docType };
  } catch (error) {
    console.error(`[OpenAPIExtractor] Error downloading OpenAPI spec from ${url}:`, error);
    return null;
  }
}

/**
 * Extracts metadata from OpenAPI spec
 */
function extractOpenAPIMetadata(
  data: unknown,
  url: string
): { title?: string; version?: string; description?: string; basePath?: string } {
  if (!data || typeof data !== 'object') {
    return {};
  }
  
  const spec = data as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  
  // Extract from info object
  if (spec.info && typeof spec.info === 'object') {
    const info = spec.info as Record<string, unknown>;
    
    if (info.title) metadata.title = String(info.title);
    if (info.version) metadata.version = String(info.version);
    if (info.description) metadata.description = cleanText(String(info.description), 500);
  }
  
  // Extract from swagger or openapi field
  if ('swagger' in spec) {
    metadata.swaggerVersion = String(spec.swagger);
  }
  if ('openapi' in spec) {
    metadata.openapiVersion = String(spec.openapi);
  }
  
  // Extract basePath from server object
  if (spec.servers && Array.isArray(spec.servers) && spec.servers.length > 0) {
    const firstServer = spec.servers[0] as Record<string, unknown>;
    if (firstServer.url) {
      try {
        const urlObj = new URL(String(firstServer.url));
        metadata.basePath = urlObj.pathname;
      } catch {
        // Ignore
      }
    }
  }
  
  return metadata;
}

/**
 * Gets standard HTTP headers for requests
 */
function getStandardHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'application/json, application/yaml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

/**
 * Main OpenAPI Extractor class
 */
export class OpenAPIExtractor {
  private cache: CrawlCache;
  private defaultMaxContentLength: number;

  constructor(options?: { maxContentLength?: number }) {
    this.cache = crawlCache;
    this.defaultMaxContentLength = options?.maxContentLength || 10000000; // 10MB
  }

  /**
   * Extracts OpenAPI spec from a URL
   */
  async extractOpenAPISpec(
    url: string,
    options?: OpenAPIExtractionOptions | undefined
  ): Promise<OpenAPIExtractionResult> {
    console.log(`[OpenAPIExtractor] Processing URL: ${url}`);

    const maxContentLength = options?.maxContentLength || this.defaultMaxContentLength;
    const downloadDir = options?.downloadDir;

    // Validate URL format first
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      return {
        success: false,
        url,
        error: `Invalid URL format: ${url}`,
      };
    }

    // Check cache first (unless force refresh)
    if (!options?.forceRefresh) {
      const cachedEntry = this.cache.get(url);
      if (cachedEntry && cachedEntry.metadata?.localPath) {
        console.log(`[OpenAPIExtractor] Using cached result for: ${url}`);
        
        return {
          success: true,
          url,
          openAPISpec: {
            url,
            docType: (cachedEntry.docType as TechnicalDocType) || TechnicalDocType.OPENAPI_JSON,
            timestamp: cachedEntry.timestamp,
          },
          downloadedFile: {
            id: generateUUID(),
            originalUrl: url,
            localPath: String(cachedEntry.metadata.localPath),
            fileName: String(cachedEntry.metadata.fileName),
            openAPISpec: {
              url,
              docType: (cachedEntry.docType as TechnicalDocType) || TechnicalDocType.OPENAPI_JSON,
              timestamp: cachedEntry.timestamp,
            },
            downloadTime: cachedEntry.timestamp,
            domain: extractDomainInfo(url).domain,
            path: extractDomainInfo(url).path,
          },
        };
      }
    }
    
    try {
      // Step 1: Fetch the page to look for OpenAPI links
      console.log(`[OpenAPIExtractor] Fetching page: ${url}`);
      const pageResponse = await axios.get(url, {
        timeout: 10000,
        maxContentLength: 2000000, // 2MB for HTML pages
        validateStatus: () => true,
        headers: getStandardHeaders(),
      });
      
      if (pageResponse.status !== 200) {
        return {
          success: false,
          url,
          error: `Failed to fetch page: HTTP ${pageResponse.status}`,
        };
      }
      
      const html = pageResponse.data;
      
      // Step 2: Discover OpenAPI spec URL
      console.log(`[OpenAPIExtractor] Searching for OpenAPI spec in page...`);
      const discoveredSpec = await discoverOpenAPISpec(url, html, maxContentLength);
      
      if (!discoveredSpec) {
        return {
          success: false,
          url,
          error: 'No OpenAPI specification found on this page',
        };
      }
      
      console.log(`[OpenAPIExtractor] Found spec at: ${discoveredSpec.url}`);
      
      // Step 3: Download the OpenAPI spec
      const downloaded = await downloadOpenAPISpec(discoveredSpec.url, maxContentLength);
      
      if (!downloaded) {
        return {
          success: false,
          url,
          error: 'Failed to download OpenAPI specification',
        };
      }
      
      // Step 4: Parse and extract metadata
      const specData = this.parseOpenAPISpec(downloaded.content, downloaded.type);
      
      if (!specData.valid) {
        return {
          success: false,
          url,
          error: `Invalid OpenAPI specification: ${specData.error}`,
        };
      }
      
      // Step 5: Determine filename and save
      const domainInfo = extractDomainInfo(url);
      // Use a fallback file name if no fileName in options
      const fallbackName = generateFileName(
        domainInfo.domain,
        specData.metadata.title || specData.metadata.version || 'api-documentation',
        discoveredSpec.type
      );
      const fileName = fallbackName;
      
      // Save to cache
      const saved = this.cache.saveOpenAPISpec(fileName, downloaded.content);
      
      // Cache the result
      this.cache.set(url, html, {
        title: specData.metadata.title,
        docType: discoveredSpec.type,
        ttlMs: 86400000, // 24 hours
        metadata: {
          localPath: saved.path,
          fileName,
          openAPISpec: specData.metadata,
        },
      });
      
      const downloadedFile: DownloadedOpenAPI = {
        id: generateUUID(),
        originalUrl: url,
        localPath: saved.path,
        fileName,
        openAPISpec: {
          url: discoveredSpec.url,
          title: specData.metadata.title,
          version: specData.metadata.version,
          description: specData.metadata.description,
          basePath: specData.metadata.basePath,
          docType: discoveredSpec.type,
          size: saved.size,
          timestamp: generateTimestamp(),
        },
        downloadTime: generateTimestamp(),
        domain: domainInfo.domain,
        path: domainInfo.path,
      };
      
      return {
        success: true,
        url,
        openAPISpec: downloadedFile.openAPISpec,
        downloadedFile,
        detectedType: discoveredSpec.type,
      };
    } catch (error) {
      console.error(`[OpenAPIExtractor] Error extracting OpenAPI spec from ${url}:`, error);
      
      return {
        success: false,
        url,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Parses OpenAPI specification content
   */
  private parseOpenAPISpec(
    content: string,
    type: TechnicalDocType
  ): { valid: boolean; data?: unknown; metadata: Record<string, string>; error?: string } {
    try {
      let specData: unknown;
      
      if (type === TechnicalDocType.OPENAPI_YAML || type === TechnicalDocType.SWAGGER_YAML) {
        // YAML parsing would require a yaml library
        // For now, return the raw content as JSON for compatibility
        console.log('[OpenAPIExtractor] YAML content detected - returning raw content');
        specData = { rawYaml: content.substring(0, 1000) + '...' };
      } else {
        specData = JSON.parse(content);
      }
      
      const metadata = extractOpenAPIMetadata(specData, '');
      
      return {
        valid: true,
        data: specData,
        metadata,
      };
    } catch (error) {
      console.error('[OpenAPIExtractor] Error parsing OpenAPI spec:', error);
      
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Invalid specification format',
        metadata: {},
      };
    }
  }

  /**
   * Internal method that extracts OpenAPI spec - handles both regular and technical doc extraction
   */
  private async _extractOpenAPISpecInternal(
    url: string,
    options?: OpenAPIExtractionOptions | null
  ): Promise<OpenAPIExtractionResult> {
    // When options is undefined/null, pass undefined to extractOpenAPISpec
    if (options === undefined || options === null) {
      return await (this.extractOpenAPISpec as any)(url);
    }
    const result = await this.extractOpenAPISpec(url, options as any);
    return result;
  }

  /**
   * Extracts technical documentation from a page (non-OpenAPI)
   */
  async extractTechnicalDoc(
    url: string,
    options?: OpenAPIExtractionOptions
  ): Promise<OpenAPIExtractionResult> {
    // Convert undefined to null for compatibility with _extractOpenAPISpecInternal
    const normalizedOptions = options ?? null;
    const result = await this._extractOpenAPISpecInternal(url, normalizedOptions);
    
    if (!result.success && !result.openAPISpec) {
      return result;
    }
    
    // Mark as tech doc type
    if (result.detectedType === undefined) {
      result.detectedType = TechnicalDocType.TECHNICAL_MD;
    }
    
    return result;
  }

  /**
   * Lists all cached OpenAPI specifications
   */
  public listCachedOpenAPISpecs(): DownloadedOpenAPI[] {
    const cacheEntries = this.cache.getAll();
    const openapiDir = this.cache.getOpenAPIDir();
    
    const specs: DownloadedOpenAPI[] = [];
    
    for (const entry of cacheEntries) {
      if (entry.metadata?.localPath && entry.metadata.fileName) {
        // Check if file still exists
        try {
          if (this.cache.openAPIFileExists(String(entry.metadata.fileName))) {
            specs.push({
              id: generateUUID(),
              originalUrl: entry.url,
              localPath: String(entry.metadata.localPath),
              fileName: String(entry.metadata.fileName),
              openAPISpec: {
                url: entry.url,
                docType: TechnicalDocType.OPENAPI_JSON,
                timestamp: entry.timestamp,
                title: entry.title,
              },
              downloadTime: entry.timestamp,
              domain: extractDomainInfo(entry.url).domain,
              path: extractDomainInfo(entry.url).path,
            });
          }
        } catch {
          // File doesn't exist, skip
        }
      }
    }
    
    return specs;
  }

  /**
   * Gets the cache statistics
   */
  public getCacheStats() {
    return this.cache.getStats();
  }
}

// Create a singleton instance
export const openAPIExtractor = new OpenAPIExtractor();
