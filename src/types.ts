export interface ResearchDigest {
  entities: string[];
  claims: string[];
  keyTerms: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  fullContent: string;
  contentPreview: string;
  wordCount: number;
  timestamp: string;
  fetchStatus: 'success' | 'error' | 'timeout';
  error?: string;
  digest?: ResearchDigest;
}

export interface SearchOptions {
  query: string;
  numResults?: number;
  timeout?: number;
}

export interface ContentExtractionOptions {
  url: string;
  timeout?: number;
  maxContentLength?: number;
  sessionId?: string;
}

export interface WebSearchToolInput {
  query: string;
  limit?: number;
  includeContent?: boolean;
  maxContentLength?: number;
}

export interface WebSearchToolOutput {
  results: SearchResult[];
  total_results: number;
  search_time_ms: number;
  query: string;
  status?: string;
}

// Search result with metadata about which search engine was used
export interface SearchResultWithMetadata {
  results: SearchResult[];
  engine: string;
  qualityScore?: number;
  total_results?: number;
}

// GitHub-related types
export interface GitHubFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  content?: string;
  encoding?: string;
  url?: string;
}

export interface GitHubCrawlOptions {
  maxDepth?: number;
  maxFiles?: number;
  includeCodeOnly?: boolean;
  timeout?: number;
}

// OpenAPI/Technical Document Extraction Types

export enum TechnicalDocType {
  OPENAPI_JSON = 'openapi-json',
  OPENAPI_YAML = 'openapi-yaml',
  SWAGGER_JSON = 'swagger-json',
  SWAGGER_YAML = 'swagger-yaml',
  API_DOCS = 'api-docs',
  REST_API = 'rest-api',
  TECHNICAL_MD = 'technical-md',
  TECHNICAL_PDF = 'technical-pdf',
}

/**
 * One operation (method + path) extracted from an OpenAPI/Swagger `paths`
 * object. The lightweight index of these is what get-openapi-spec returns by
 * default, so the model gets a usable map of the API without the full spec
 * (which is saved to disk and paged via read-cached-document).
 */
export interface OpenAPIEndpoint {
  method: string;   // upper-case HTTP verb, e.g. "GET"
  path: string;     // raw path key, e.g. "/pets/{id}"
  summary: string;  // summary || operationId || ''
  tags: string[];   // [] if none
}

export interface OpenAPISpecInfo {
  url: string;
  title?: string;
  version?: string;
  description?: string;
  basePath?: string;
  docType: TechnicalDocType;
  size?: number;
  timestamp: string;
  /** Endpoint index built from the spec's `paths`. Empty on a warm-cache hit
   *  (the spec isn't re-parsed); callers can lazily rebuild from the saved file. */
  endpoints?: OpenAPIEndpoint[];
  endpointCount?: number;
}

export interface DownloadedOpenAPI {
  id: string;
  originalUrl: string;
  localPath: string;
  fileName: string;
  openAPISpec: OpenAPISpecInfo;
  downloadTime: string;
  domain: string;
  path: string;
  keywords?: string[];
}

export interface CrawlCacheEntry {
  url: string;
  timestamp: string;
  expiresAt: string;
  contentHash: string;
  docType?: TechnicalDocType;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenAPIExtractionOptions {
  url?: string;
  downloadDir?: string;
  maxContentLength?: number;
  timeout?: number;
  forceRefresh?: boolean;
}

export interface OpenAPIExtractionResult {
  success: boolean;
  url: string;
  openAPISpec?: OpenAPISpecInfo;
  downloadedFile?: DownloadedOpenAPI;
  error?: string;
  detectedType?: TechnicalDocType;
}