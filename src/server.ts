/**
 * MCP server class. Tool registrations, request handling, and graceful
 * shutdown live here. The entry point in `index.ts` installs the stdio
 * console shim and boots an instance of this class.
 *
 * Future refactor (planned): split each of the 13 tool registrations into its
 * own file under `src/tools/` and have `setupTools()` invoke a per-tool
 * `register*` function. Until then, registrations stay inline — extracting
 * the boot is the first step toward that finer-grained split.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Define MCP Error types locally (not exported from @modelcontextprotocol/sdk/server/mcp.js)
enum ERROR_CODES {
  ConnectionClosed = -32000,
  RequestTimeout = -32001,
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  ResourceExhausted = -32009,
  Unauthorized = -32008,
}

class McpError extends Error {
  readonly code: number;
  
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'McpError';
  }
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { SearchEngine } from './search-engine.js';
import { EnhancedContentExtractor } from './enhanced-content-extractor.js';
import { pdfExtractor as pdfExtractorInstance } from './pdf-extractor.js';

const pdfExtractor = pdfExtractorInstance;

import { WebSearchToolInput, WebSearchToolOutput, SearchResult } from './types.js';
import { ProgressiveSearchEngine } from './progressive-search-engine.js';
import { isPdfUrl, fetchSitemapUrls, withTimeout } from './utils.js';

// Per-tool wall-clock budgets. All sit comfortably below the Forge function
// timeout (~25 s) so the upstream user request never inherits a hung MCP call.
// Override individually via env if a deployment needs different ceilings.
const TOOL_TIMEOUTS = {
  fullWebSearch: parseInt(process.env.TOOL_TIMEOUT_FULL_SEARCH || '18000', 10),
  searchSummaries: parseInt(process.env.TOOL_TIMEOUT_SEARCH_SUMMARIES || '8000', 10),
  singlePage: parseInt(process.env.TOOL_TIMEOUT_SINGLE_PAGE || '12000', 10),
  pdf: parseInt(process.env.TOOL_TIMEOUT_PDF || '12000', 10),
  github: parseInt(process.env.TOOL_TIMEOUT_GITHUB || '18000', 10),
  openapi: parseInt(process.env.TOOL_TIMEOUT_OPENAPI || '15000', 10),
  progressive: parseInt(process.env.TOOL_TIMEOUT_PROGRESSIVE || '20000', 10),
};
import { GitHubExtractor, parseGitHubUrl } from './github-extractor.js';
import { openAPIExtractor } from './openapi-extractor.js';
import { attachClientDetect, isAgenticClient, getClientInfo } from './client-detect.js';

// ============================================================================
// Import observability module
// ============================================================================

import { auditLogger, telemetryCollector } from './observability.js';

// (Enterprise guardrails are wired into search/extract paths directly via
// their own modules — no top-level imports needed here.)

export interface WebSearchMCPServerOptions {
  /** When true, the constructor will not attach SIGINT/SIGTERM handlers.
   *  HTTP host should pass true and call `closeAll()` from its own shutdown path. */
  skipShutdownHooks?: boolean;
}

export class WebSearchMCPServer {
  private server: McpServer;
  private searchEngine: SearchEngine;
  private contentExtractor: EnhancedContentExtractor;
  private githubExtractor?: GitHubExtractor;

  /**
   * Generate a session ID (clientId). 
   * In a real MCP environment, the client should ideally provide a stable session ID.
   * For now, we use CLIENT_ID to allow some continuity if the client provides it.
   */
  private generateSessionId(): string {
    const clientId = process.env.CLIENT_ID || 'default';
    return clientId;
  }

  /**
   * Helper function to convert errors to McpError with proper codes.
   * Returns structured error format for consistent client-side handling.
   */
  private handleError(error: unknown, toolName: string): never {
    console.error(`[MCP] Error in ${toolName}:`, error);

    if (error instanceof McpError) {
      throw error;
    }

    if (error instanceof Error) {
      // Categorize common errors and map to appropriate MCP error codes
      const message = error.message.toLowerCase();

      if (message.includes('invalid') || message.includes('required')) {
        throw new McpError(
          ERROR_CODES.InvalidParams,
          `Invalid parameters: ${error.message}`
        );
      }

      if (message.includes('timeout') || message.includes('timed out')) {
        throw new McpError(
          ERROR_CODES.RequestTimeout,
          `Request timeout: ${error.message}`
        );
      }

      if (message.includes('not found') || message.includes('404')) {
        throw new McpError(
          ERROR_CODES.InvalidRequest,
          `Resource not found: ${error.message}`
        );
      }

      if (message.includes('403') || message.includes('forbidden') || message.includes('unauthorized')) {
        throw new McpError(
          ERROR_CODES.Unauthorized,
          `Access denied: ${error.message}`
        );
      }

      if (message.includes('rate limit') || message.includes('too many requests')) {
        throw new McpError(
          ERROR_CODES.ResourceExhausted,
          `Rate limited: ${error.message}`
        );
      }

      if (message.includes('network') || message.includes('connection') || message.includes('dns')) {
        throw new McpError(
          ERROR_CODES.ConnectionClosed,
          `Network error: ${error.message}`
        );
      }

      // Default to internal error for unknown issues
      throw new McpError(
        ERROR_CODES.InternalError,
        `Internal server error: ${error.message}`
      );
    }

    // Fallback for non-Error objects
    throw new McpError(
      ERROR_CODES.InternalError,
      `Unknown error occurred`
    );
  }

  constructor(opts: WebSearchMCPServerOptions = {}) {
    this.server = new McpServer({
      name: 'web-search-mcp',
      version: '0.3.1',
    });

    // Detect the client (agentic vs LM-Studio-style) at the initialize
    // handshake. Tool handlers branch on the result to decide whether to
    // return content inline or behind a file path.
    attachClientDetect(this.server);

    const maxRPM = parseInt(process.env.SEARCH_ENGINE_MAX_RPM || '50', 10);
    const resetMS = parseInt(process.env.SEARCH_ENGINE_RESET_MS || '60000', 10);
    this.searchEngine = new SearchEngine({
      maxRequestsPerMinute: maxRPM,
      resetIntervalMs: resetMS,
    });
    this.contentExtractor = new EnhancedContentExtractor();

    // Initialize GitHub extractor with defaults
    try {
      const maxDepth = parseInt(process.env.GITHUB_MAX_DEPTH || '3', 10);
      const maxFiles = parseInt(process.env.GITHUB_MAX_FILES || '50', 10);
      const timeout = parseInt(process.env.GITHUB_TIMEOUT || '10000', 10);
      
      this.githubExtractor = new GitHubExtractor({
        maxDepth: isNaN(maxDepth) ? 3 : maxDepth,
        maxFiles: isNaN(maxFiles) ? 50 : maxFiles,
        timeout: isNaN(timeout) ? 10000 : timeout
      });
      
      console.log(`[WebSearchMCPServer] GitHub extractor initialized with maxDepth=${maxDepth}, maxFiles=${maxFiles}`);
    } catch (error) {
      console.warn('[WebSearchMCPServer] Failed to initialize GitHub extractor:', error);
    }

    this.registerToolsOn(this.server);
    if (!opts.skipShutdownHooks) {
      this.setupGracefulShutdown();
    }
  }

  /**
   * Public so the HTTP host can register the same 11 tool handlers on a
   * fresh per-request McpServer. The handlers close over `this.searchEngine`,
   * `this.contentExtractor`, etc. — those instances stay process-shared.
   */
  public registerToolsOn(target: McpServer): void {
    // Register the main web search tool (primary choice for comprehensive searches)
    target.tool(
      'full-web-search',
      'Search the web and fetch complete page content from top results. This is the most comprehensive general web search tool. It searches the web and then follows resulting links to extract full page content. Use get-web-search-summaries for a lightweight alternative. For domain-specific research on known companies, consider starting with get-website-sitemap to discover available pages before filtering and extracting.',
      {
        query: z.string().describe('Search query to execute (recommended for comprehensive research)'),
        limit: z.number().optional().default(5).describe('Number of results to return with full content (1-10)'),
        includeContent: z.boolean().optional().default(true).describe('Whether to fetch full page content (default: true)'),
        maxContentLength: z.number().optional().describe('Maximum characters per result content (0 = no limit). Usually not needed - content length is automatically optimized.'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: full-web-search`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          // Convert and validate arguments
          const validatedArgs = this.validateAndConvertArgs(args);

          // Use explicit client capability hint from environment variable
          // Set MODEL_CAPABILITY=limited (for models that struggle with large responses)
          // or MODEL_CAPABILITY=full (default, for models that handle large responses well)
          const modelCapability = process.env.MODEL_CAPABILITY?.toLowerCase() || 'full';
          const isLimitedModel = modelCapability === 'limited' || modelCapability === 'low';

          // Only apply auto-limit for models explicitly marked as limited
          const hasExplicitMaxLength = typeof args === 'object' && args !== null && 'maxContentLength' in args;

          if (!hasExplicitMaxLength && isLimitedModel) {
            console.log(`[MCP] Limited model detected (MODEL_CAPABILITY=${modelCapability}), applying content length limit`);
            validatedArgs.maxContentLength = 2000;
          } else if (!hasExplicitMaxLength && !isLimitedModel) {
            console.log(`[MCP] Full capability model, no content length limit applied`);
          }
          
          console.log(`[MCP] Validated args:`, JSON.stringify(validatedArgs, null, 2));
          
           console.log(`[MCP] Starting web search...`);
           const sessionId = this.generateSessionId();
           const result = await withTimeout(
             this.handleWebSearch(validatedArgs, sessionId),
             TOOL_TIMEOUTS.fullWebSearch,
             'full-web-search',
           );

           console.log(`[MCP] Search completed, found ${result.results.length} results`);
          
          // Format the results as a comprehensive text response
          let responseText = `Search completed for "${result.query}" with ${result.total_results} results:\n\n`;
          
          // Add status line if available
          if (result.status) {
            responseText += `**Status:** ${result.status}\n\n`;
          }
          
          const maxLength = validatedArgs.maxContentLength;
          
          result.results.forEach((searchResult, idx) => {
            responseText += `**${idx + 1}. ${searchResult.title}**\n`;
            responseText += `URL: ${searchResult.url}\n`;
            responseText += `Description: ${searchResult.description}\n`;
            
            if (searchResult.digest) {
              const { entities, claims, keyTerms } = searchResult.digest;
              if (entities.length > 0 || claims.length > 0 || keyTerms.length > 0) {
                responseText += `\n**Research Digest:**\n`;
                if (entities.length > 0) responseText += `- **Entities:** ${entities.join(', ')}\n`;
                if (claims.length > 0) responseText += `- **Key Claims:** ${claims.join(' | ')}\n`;
                if (keyTerms.length > 0) responseText += `- **Key Terms:** ${keyTerms.join(', ')}\n`;
                responseText += `\n`;
              }
            }

            if (searchResult.fullContent && searchResult.fullContent.trim()) {
              let content = searchResult.fullContent;
              if (maxLength && maxLength > 0 && content.length > maxLength) {
                content = content.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} characters]`;
              }
              responseText += `\n**Full Content:**\n${content}\n`;
            } else if (searchResult.contentPreview && searchResult.contentPreview.trim()) {
              let content = searchResult.contentPreview;
              if (maxLength && maxLength > 0 && content.length > maxLength) {
                content = content.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} characters]`;
              }
              responseText += `\n**Content Preview:**\n${content}\n`;
            } else if (searchResult.fetchStatus === 'error') {
              responseText += `\n**Content Extraction Failed:** ${searchResult.error}\n`;
            }
            
            responseText += `\n---\n\n`;
          });
          
          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'full-web-search');
        }
      }
    );

    // Register the lightweight web search summaries tool (secondary choice for quick results)
    target.tool(
      'get-web-search-summaries',
      'Search the web and return only the search result snippets/descriptions without following links to extract full page content. This is a lightweight alternative to full-web-search for when you only need brief search results. For comprehensive information, use full-web-search instead.',
      {
        query: z.string().describe('Search query to execute (lightweight alternative)'),
        limit: z.number().optional().default(5).describe('Number of search results to return (1-10)'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: get-web-search-summaries`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          // Validate arguments
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;
          
          if (!obj.query || typeof obj.query !== 'string') {
            throw new Error('Invalid arguments: query is required and must be a string');
          }

          let limit = 5; // default
          if (obj.limit !== undefined) {
            const limitValue = typeof obj.limit === 'string' ? parseInt(obj.limit, 10) : obj.limit;
            if (typeof limitValue !== 'number' || isNaN(limitValue) || limitValue < 1 || limitValue > 10) {
              throw new Error('Invalid limit: must be a number between 1 and 10');
            }
            limit = limitValue;
          }

          console.log(`[MCP] Starting web search summaries...`);

          // Use existing search engine to get results with snippets
          const searchResponse = await withTimeout(
            this.searchEngine.search({
              query: obj.query,
              numResults: limit,
            }),
            TOOL_TIMEOUTS.searchSummaries,
            'get-web-search-summaries',
          );

          // Convert to summary format (no content extraction)
          const summaryResults = searchResponse.results.map(item => ({
            title: item.title,
            url: item.url,
            description: item.description,
            timestamp: item.timestamp,
          }));

          console.log(`[MCP] Search summaries completed, found ${summaryResults.length} results`);
          
          // Format: structured JSON block + human-readable text for AI-friendly parsing
          const jsonBlock = `\`\`\`json\n${JSON.stringify(summaryResults, null, 2)}\n\`\`\``;
          let responseText = `Search summaries for "${obj.query}" with ${summaryResults.length} results:\n\n${jsonBlock}\n\n`;

          summaryResults.forEach((summary, i) => {
            responseText += `**${i + 1}. ${summary.title}**\n`;
            responseText += `URL: ${summary.url}\n`;
            responseText += `Description: ${summary.description}\n`;
            responseText += `\n---\n\n`;
          });

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'get-web-search-summaries');
        }
      }
    );

    // Register the single page content extraction tool
    target.tool(
      'get-single-web-page-content',
      'Extract and return the full content from a single web page URL. This tool follows a provided URL and extracts the main page content. Useful for getting detailed content from a specific webpage without performing a search.',
      {
        url: z.string().url().describe('The URL of the web page to extract content from'),
        maxContentLength: z.number().optional().describe('Maximum characters for the extracted content (0 = no limit). Usually not needed - content length is automatically optimized.'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: get-single-web-page-content`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          // Validate arguments
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;

          if (!obj.url || typeof obj.url !== 'string') {
            throw new Error('Invalid arguments: url is required and must be a string');
          }

          const maxContentLength = (obj.maxContentLength as number | undefined) ?? undefined;

           console.log(`[MCP] Starting single page content extraction for: ${obj.url}`);

            // Use existing content extractor to get page content
            const contentObj = await withTimeout(
              this.contentExtractor.extractContent({
                url: obj.url,
                maxContentLength,
                sessionId: this.generateSessionId(),
              }),
              TOOL_TIMEOUTS.singlePage,
              'get-single-web-page-content',
            );
            const content = contentObj.content;
 
           // Get page title from URL (simple extraction)
           const urlObj = new URL(obj.url);
           const title = urlObj.hostname + urlObj.pathname;
  
           // Create content preview and word count
           // const contentPreview = content.length > 200 ? content.substring(0, 200) + '...' : content; // Unused for now
           const wordCount = content.split(/\s+/).filter((word: string) => word.length > 0).length;
  
           console.log(`[MCP] Single page content extraction completed, extracted ${content.length} characters`);
  
           // Format the result as text
           const header = `**Source:** ${obj.url} | **Title:** ${title} | **Words:** ${wordCount}\n\n`;
           let body = '';

           if (maxContentLength && maxContentLength > 0) {
             const availableForContent = maxContentLength - header.length - 50;
             if (content.length > availableForContent) {
               body = `**Content (truncated):**\n${content.substring(0, Math.max(0, availableForContent))}\n\n[Content truncated to respect limit]`;
             } else {
               body = `**Content:**\n${content}`;
             }
           } else {
             body = `**Content:**\n${content}`;
           }

           let responseText = header + body;

           // Ensure final response never exceeds maxContentLength
           if (maxContentLength && maxContentLength > 0 && responseText.length > maxContentLength) {
             responseText = responseText.substring(0, maxContentLength);
           }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: responseText,
                },
              ],
            };
          } catch (error) {
            this.handleError(error, 'get-single-web-page-content');
          }
        }
      );

    // Helper function to sanitize content (remove excessive links and noise)
    const sanitizeContent = (content: string, sourceUrl: string): string => {
      let sanitized = content;
      
      // If source is Wikipedia, apply Wikipedia-specific cleanup
      if (sourceUrl.includes('wikipedia.org')) {
        // Remove Wikipedia-style links like [1], [2], etc. at end of content
        sanitized = sanitized.replace(/\[\d+\](#cite_.*)?/g, '');
        // Remove reference numbers within text like [1]
        sanitized = sanitized.replace(/\[\d+\]/g, '');
        // Clean up excessive whitespace from removed links
        sanitized = sanitized.replace(/\n{3,}/g, '\n\n');
      }
      
      // Remove excessive newlines
      sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n');
      
      // Remove very long words that are likely noise (over 100 chars)
      const words = sanitized.split(/\s+/);
      const cleanedWords = words.filter(word => word.length <= 100);
      sanitized = cleanedWords.join(' ');
      
      return sanitized.trim();
    };

    // Helper function to calculate reading time
    const calculateReadingTime = (content: string): string => {
      const wordsPerMinute = 200;
      const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
      const minutes = Math.ceil(wordCount / wordsPerMinute);
      return `${minutes} min read`;
    };

    // Helper function to calculate content quality score
    const calculateQualityScore = (content: string, digest: { entities?: string[]; claims?: string[]; keyTerms?: string[] } | undefined): number => {
      let score = 50; // Base score
      
      // Length score (0-20 points)
      const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
      if (wordCount > 500) score += 10;
      if (wordCount > 1000) score += 5;
      if (wordCount > 2000) score += 5;
      
      // Digest quality (0-20 points)
      if (digest) {
        if (digest.entities && digest.entities.length > 0) score += Math.min(7, digest.entities.length);
        if (digest.claims && digest.claims.length > 0) score += Math.min(7, digest.claims.length);
        if (digest.keyTerms && digest.keyTerms.length > 0) score += Math.min(6, digest.keyTerms.length);
      }
      
      // Structure quality (0-10 points)
      const hasParagraphs = content.includes('\n\n');
      const hasProperLength = wordCount > 300 && wordCount < 50000;
      if (hasParagraphs) score += 5;
      if (hasProperLength) score += 5;
      
      return Math.min(100, score);
    };

    // Helper function for cleanup old research files
    const cleanupOldFiles = (outputDir: string, maxFiles: number): void => {
      if (!fs.existsSync(outputDir)) return;
      
      const files = fs.readdirSync(outputDir)
        .filter(f => f.endsWith('.md') && f.startsWith('research-'))
        .map(f => ({
          name: f,
          path: path.join(outputDir, f),
          time: fs.statSync(path.join(outputDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time); // Newest first
      
      // Remove old files if exceeding maxFiles
      if (files.length > maxFiles) {
        const filesToDelete = files.slice(maxFiles);
        filesToDelete.forEach(f => {
          fs.unlinkSync(f.path);
          console.log(`[MCP] Cleaned up old research file: ${f.name}`);
        });
      }
    };

    // Helper function to find existing research file matching the prefix
    const findExistingResearchFile = (outputDir: string, prefix?: string): string | undefined => {
      if (!fs.existsSync(outputDir)) return undefined;

      const files = fs.readdirSync(outputDir)
        .filter(f => f.endsWith('.md'));

      // Filter by prefix if provided
      const matchingFiles = prefix
        ? files.filter(f => f.startsWith(prefix) || f.includes(prefix.replace(/-$/, '')))
        : files;

      if (matchingFiles.length === 0) return undefined;

      // Sort by modification time (newest first)
      const sortedFiles = matchingFiles
        .map(f => ({
          name: f,
          path: path.join(outputDir, f),
          time: fs.statSync(path.join(outputDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      return sortedFiles[0].path;
    };

    // Helper function to render custom markdown template
    const renderTemplate = (
      template: string,
      data: {
        title: string;
        url: string;
        timestamp: string;
        wordCount: number;
        readingTime: string;
        qualityScore: number;
        entities: string[];
        claims: string[];
        keyTerms: string[];
        content: string;
      }
    ): string => {
      let result = template;

      // Replace all placeholders
      result = result.replace(/\{title\}/g, data.title);
      result = result.replace(/\{url\}/g, data.url);
      result = result.replace(/\{timestamp\}/g, data.timestamp);
      result = result.replace(/\{wordCount\}/g, String(data.wordCount));
      result = result.replace(/\{readingTime\}/g, data.readingTime);
      result = result.replace(/\{qualityScore\}/g, String(data.qualityScore));
      result = result.replace(/\{entities\}/g, data.entities.length > 0 ? data.entities.join('\n- ') : '*None detected*');
      result = result.replace(/\{claims\}/g, data.claims.length > 0 ? data.claims.join('\n- ') : '*None detected*');
      result = result.replace(/\{keyTerms\}/g, data.keyTerms.length > 0 ? data.keyTerms.join('\n- ') : '*None detected*');
      result = result.replace(/\{content\}/g, data.content);

      return result;
    };

    // Helper function to extract content with retry. Uses pRetry for jittered
    // exponential backoff so simultaneous transient failures across a batch
    // don't all retry at the same instant (the previous linear loop did).
    const extractContentWithRetry = async (url: string, sessionId: string, maxRetries: number = 3): Promise<{ content: string; digest?: { entities?: string[]; claims?: string[]; keyTerms?: string[] } }> => {
      const { default: pRetry } = await import('p-retry');
      return pRetry(
        async () => {
          const result = await this.contentExtractor.extractContent({ url, sessionId });
          if (!result.content || result.content.trim().length === 0) {
            throw new Error('Extracted content is empty');
          }
          return result;
        },
        {
          retries: Math.max(0, maxRetries - 1),
          minTimeout: 500,
          maxTimeout: 4000,
          factor: 2,
          randomize: true,
          onFailedAttempt: (err) => {
            console.log(`[MCP] Extraction attempt ${err.attemptNumber} for ${url} failed: ${err.message} (${err.retriesLeft} retries left)`);
          },
        },
      );
    };

    // Register the research and save to markdown tool
    target.tool(
      'research_and_save_to_markdown',
      'Research web pages and save their content, research digest (entities, claims, terms), and source information into structured markdown files in the /docs/research-output directory for future reference. Supports batch research, content sanitization, quality scoring, and auto-cleanup of old files.',
      {
        url: z.union([z.string().url(), z.array(z.string().url())]).describe('The URL of the web page(s) to research and save. Can be a single URL or an array of URLs for batch processing.'),
        maxContentLength: z.number().optional().describe('Maximum characters per result content (0 = no limit)'),
        maxFiles: z.number().optional().default(50).describe('Maximum number of research files to keep. Oldest files are auto-deleted when limit is reached.'),
        filenamePrefix: z.string().optional().describe('Custom prefix for the output filename (e.g., "my-research" creates "my-research-2026-01-01-...")'),
        template: z.string().optional().describe('Custom markdown template for the research file. Use placeholders: {title}, {url}, {timestamp}, {wordCount}, {readingTime}, {qualityScore}, {entities}, {claims}, {keyTerms}, {content}. If not provided, default template is used.'),
        appendToExisting: z.boolean().optional().default(false).describe('Whether to append to an existing research file instead of creating a new one. If true, will find and update the most recent file matching the filenamePrefix, or create new if none exists.'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: research_and_save_to_markdown`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;
          
          // Handle both single URL and array of URLs
          let urls: string[] = [];
          if (Array.isArray(obj.url)) {
            urls = obj.url.filter((u): u is string => typeof u === 'string' && u.length > 0);
          } else if (obj.url && typeof obj.url === 'string') {
            urls = [obj.url];
          }
          
          if (urls.length === 0) {
            throw new Error('Invalid arguments: at least one valid URL is required');
          }

          // Parse optional parameters - Zod already validates and converts types
          const maxContentLengthRaw = obj.maxContentLength as number | undefined;
          const maxContentLength = maxContentLengthRaw === 0 ? undefined : maxContentLengthRaw;

          const maxFiles = (obj.maxFiles as number) ?? 50;
          const filenamePrefix = typeof obj.filenamePrefix === 'string' ? obj.filenamePrefix : undefined;

          // Parse template parameter
          const customTemplate = typeof obj.template === 'string' && obj.template.length > 0 ? obj.template : undefined;

          // Parse appendToExisting parameter - Zod already converts to boolean
          const appendToExisting = (obj.appendToExisting as boolean) ?? false;

          console.log(`[MCP] Starting research for ${urls.length} URL(s)`);

          const sessionId = this.generateSessionId();
          const timestamp = new Date().toISOString();
          
          // Ensure directory exists
          const isCwdProjectRoot = fs.existsSync(path.join(process.cwd(), 'package.json'));
          const projectRoot = isCwdProjectRoot ? process.cwd() : path.resolve(__dirname, '..', '..');
          const outputDir = path.join(projectRoot, 'docs', 'research-output');
          
          console.log(`[MCP] Resolved output directory: ${outputDir}`);

          if (!fs.existsSync(outputDir)) {
            console.log(`[MCP] Creating directory: ${outputDir}`);
            fs.mkdirSync(outputDir, { recursive: true });
          }

          // Cleanup old files if needed
          cleanupOldFiles(outputDir, maxFiles);

          const results: Array<{ url: string; filePath: string; success: boolean; error?: string; mdContent?: string }> = [];

          // When appendToExisting is true, process URLs sequentially to avoid race conditions
          // on the shared output file. Otherwise, use parallel processing with concurrency limit (max 3).
          const pLimit = await import('p-limit');
          const concurrencyLimit = appendToExisting ? 1 : 3;
          const limit = pLimit.default(concurrencyLimit);

          if (appendToExisting) {
            console.log(`[MCP] Sequential processing enabled (appendToExisting=true) to avoid file write races`);
          }

          // Progress tracking for batch operations
          let completedCount = 0;
          const totalUrls = urls.length;

          const processingTasks = urls.map((currentUrl) =>
            limit(async () => {
              completedCount++;
              console.log(`[MCP] Processing URL ${completedCount}/${totalUrls}: ${currentUrl}`);

              try {
                // Extract content with retry
                const extractionResult = await extractContentWithRetry(currentUrl, sessionId);

                let { content } = extractionResult;
                const { digest } = extractionResult;

                if (!content || content.trim().length === 0) {
                  throw new Error('Extracted content is empty');
                }

                // Sanitize content
                content = sanitizeContent(content, currentUrl);

                // Apply content length limit if specified
                if (maxContentLength && maxContentLength > 0) {
                  if (content.length > maxContentLength) {
                    content = content.substring(0, maxContentLength) + '\n\n[Content truncated to respect limit]';
                  }
                }

                // Prepare metadata
                const urlObj = new URL(currentUrl);
                const displayTitle = `${urlObj.hostname}${urlObj.pathname.replace(/\/$/, '')}`;

                // Create slug for filename
                const dateSlug = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                const urlSlug = currentUrl.replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 50);
                const prefix = filenamePrefix ? `${filenamePrefix}-` : '';
                const filename = `${prefix}research-${dateSlug}-${urlSlug}.md`;
                const filePath = path.join(outputDir, filename);

                // Calculate metadata
                const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
                const readingTime = calculateReadingTime(content);
                const qualityScore = calculateQualityScore(content, digest);

                // Prepare digest data for template
                const entities = digest?.entities || [];
                const claims = digest?.claims || [];
                const keyTerms = digest?.keyTerms || [];

                // Build Markdown content
                let mdContent: string;

                if (customTemplate) {
                  // Use custom template
                  mdContent = renderTemplate(customTemplate, {
                    title: displayTitle,
                    url: currentUrl,
                    timestamp,
                    wordCount,
                    readingTime,
                    qualityScore,
                    entities,
                    claims,
                    keyTerms,
                    content
                  });
                } else {
                  // Use default template
                  mdContent = `# Research Report: ${displayTitle}\n\n`;
                  mdContent += `**Source URL:** ${currentUrl}\n`;
                  mdContent += `**Research Timestamp:** ${timestamp}\n`;
                  mdContent += `**Word Count:** ${wordCount}\n`;
                  mdContent += `**Reading Time:** ${readingTime}\n`;
                  mdContent += `**Quality Score:** ${qualityScore}/100\n\n`;

                  if (digest) {
                    mdContent += `## 🧠 Research Digest\n\n`;

                    mdContent += `### 🔍 Entities\n`;
                    if (digest.entities && digest.entities.length > 0) {
                      mdContent += `- ${digest.entities.join('\n- ')}\n`;
                    } else {
                      mdContent += `*None detected*\n`;
                    }
                    mdContent += '\n';

                    mdContent += `### 📢 Key Claims\n`;
                    if (digest.claims && digest.claims.length > 0) {
                      mdContent += `- ${digest.claims.join('\n- ')}\n`;
                    } else {
                      mdContent += `*None detected*\n`;
                    }
                    mdContent += '\n';

                    mdContent += `### 🔑 Key Terms\n`;
                    if (digest.keyTerms && digest.keyTerms.length > 0) {
                      mdContent += `- ${digest.keyTerms.join('\n- ')}\n`;
                    } else {
                      mdContent += `*None detected*\n`;
                    }
                  mdContent += '\n';
                }

                mdContent += `---\n\n`;
                mdContent += `## 📝 Full Content\n\n`;
                mdContent += content + '\n';
              }

              // Handle appendToExisting (note: parallel + append is best-effort due to race conditions)
              let finalFilePath = filePath;
              if (appendToExisting) {
                const existingFilePath = findExistingResearchFile(outputDir, filenamePrefix);
                if (existingFilePath) {
                  const separator = '\n\n---\n\n';
                  const existingContent = await fs.promises.readFile(existingFilePath, 'utf8');
                  await fs.promises.writeFile(existingFilePath, existingContent + separator + mdContent, 'utf8');
                  finalFilePath = existingFilePath;
                  console.log(`[MCP] Successfully appended research to existing file: ${existingFilePath}`);
                } else {
                  await fs.promises.writeFile(filePath, mdContent, 'utf8');
                  console.log(`[MCP] Successfully saved research to: ${filePath}`);
                }
              } else {
                await fs.promises.writeFile(filePath, mdContent, 'utf8');
                console.log(`[MCP] Successfully saved research to: ${filePath}`);
              }

              return { url: currentUrl, filePath: finalFilePath, success: true as const, mdContent };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error(`[MCP] Failed to process ${currentUrl}: ${errorMessage}`);
              return { url: currentUrl, filePath: '', success: false as const, error: errorMessage };
            }
          }));

          // Wait for all processing tasks to complete
          const taskResults = await Promise.allSettled(processingTasks);
          for (const settled of taskResults) {
            if (settled.status === 'fulfilled') {
              results.push(settled.value);
            } else {
              results.push({ url: '', filePath: '', success: false, error: settled.reason?.message || 'Unknown error' });
            }
          }

          // Generate response. For agentic clients (Cline / Claude Desktop /
          // Roo Code) we return only paths — they have a sibling filesystem
          // MCP and will read the markdown directly. For non-agent clients
          // (LM Studio in chat mode) the file path is unreachable, so embed
          // the markdown content inline. Per-result content is hard-capped
          // to keep total response inside MAX_OUTPUT_LENGTH.
          const successfulResults = results.filter(r => r.success);
          const failedResults = results.filter(r => !r.success);
          const agentic = isAgenticClient();

          let responseText = `Research complete! Processed ${results.length} URL(s).\n`;
          if (!agentic) {
            const info = getClientInfo();
            responseText += `*Client: ${info?.name || 'unknown'} (non-agent) — embedding content inline; file paths still listed for reference.*\n`;
          }
          responseText += '\n';

          if (successfulResults.length > 0) {
            responseText += `**✅ Successful (${successfulResults.length}):**\n`;
            successfulResults.forEach(r => {
              responseText += `- ${r.url} → \`${r.filePath}\`\n`;
            });
            responseText += '\n';

            if (!agentic) {
              const totalCap = parseInt(process.env.MAX_OUTPUT_LENGTH || '50000', 10);
              const perResultCap = Math.max(2000, Math.floor(totalCap / Math.max(1, successfulResults.length)));
              for (const r of successfulResults) {
                if (!r.mdContent) continue;
                let chunk = r.mdContent;
                if (chunk.length > perResultCap) {
                  chunk = chunk.substring(0, perResultCap) + `\n\n[Truncated at ${perResultCap} chars; full markdown saved to ${r.filePath}]`;
                }
                responseText += `\n---\n\n${chunk}\n`;
              }
              responseText += '\n';
            }
          }

          if (failedResults.length > 0) {
            responseText += `**❌ Failed (${failedResults.length}):**\n`;
            failedResults.forEach(r => {
              responseText += `- ${r.url}: ${r.error}\n`;
            });
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'research_and_save_to_markdown');
        }
      }
    );

    // Register the unified sitemap tool. Combines discovery and keyword
    // filtering — previously two separate tools (get-website-sitemap +
    // filter-sitemap-urls) that small models often chained incorrectly.
    // Optionally also extracts content from the top-N matches in one call,
    // collapsing the typical 3-step research flow into a single tool call.
    target.tool(
      'get-website-sitemap',
      'Read a website\'s sitemap.xml and (optionally) filter it by keywords. With `extractTopMatching` set, this also fetches content for the top-N matched URLs in the same call — collapsing the typical sitemap → filter → extract chain into one round-trip. Recommended first step when you have a specific domain URL and want to find high-value pages on it.',
      {
        url: z.string().url().describe('The base URL of the website (e.g., https://example.com).'),
        keywords: z.array(z.string()).optional().describe('Optional. When provided, URLs are scored by case-insensitive keyword count and only matches are returned, sorted best-first.'),
        offset: z.number().optional().default(0).describe('Starting index for pagination (default: 0).'),
        limit: z.number().optional().default(100).describe('Max URLs returned per page. Without keywords: default 100, max 500. With keywords: default 20, max 200.'),
        extractTopMatching: z.number().optional().describe('When set with `keywords`, also extract content from the top-N matched URLs and embed it in the response. Bounded 1..5.'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: get-website-sitemap`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;

          if (!obj.url || typeof obj.url !== 'string') {
            throw new Error('Invalid arguments: url is required and must be a string');
          }

          const keywordsRaw = obj.keywords;
          const keywords: string[] = Array.isArray(keywordsRaw)
            ? keywordsRaw.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
            : [];
          const filtering = keywords.length > 0;

          let offset = 0;
          if (obj.offset !== undefined) {
            const offsetVal = typeof obj.offset === 'string' ? parseInt(obj.offset, 10) : obj.offset;
            offset = typeof offsetVal === 'number' && !isNaN(offsetVal) && offsetVal >= 0 ? offsetVal : 0;
          }

          const defaultLimit = filtering ? 20 : 100;
          const maxLimit = filtering ? 200 : 500;
          let limit = defaultLimit;
          if (obj.limit !== undefined) {
            const limitVal = typeof obj.limit === 'string' ? parseInt(obj.limit, 10) : obj.limit;
            limit = typeof limitVal === 'number' && !isNaN(limitVal) && limitVal > 0 ? Math.min(limitVal, maxLimit) : defaultLimit;
          }

          // Bound extractTopMatching to a sensible window so a single call
          // can't blow the per-tool timeout budget by extracting dozens of pages.
          let extractTopMatching = 0;
          if (filtering && obj.extractTopMatching !== undefined) {
            const v = typeof obj.extractTopMatching === 'string' ? parseInt(obj.extractTopMatching, 10) : obj.extractTopMatching;
            if (typeof v === 'number' && !isNaN(v) && v > 0) {
              extractTopMatching = Math.min(5, v);
            }
          }

          console.log(`[MCP] Sitemap call for ${obj.url} (filtering=${filtering}, extractTopMatching=${extractTopMatching}, offset=${offset}, limit=${limit})`);
          const allUrls = await fetchSitemapUrls(obj.url);

          if (allUrls.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No URLs found in the sitemap for ${obj.url}. The sitemap might not exist or could be empty.`,
                },
              ],
            };
          }

          let displayedUrls: string[];
          let totalForPagination: number;
          let header: string;

          if (filtering) {
            const scored = allUrls
              .map((u) => {
                const lower = u.toLowerCase();
                const score = keywords.reduce((s, kw) => s + (lower.includes(kw.toLowerCase()) ? 1 : 0), 0);
                return { url: u, score };
              })
              .filter((x) => x.score > 0)
              .sort((a, b) => b.score - a.score);
            totalForPagination = scored.length;
            displayedUrls = scored.slice(offset, offset + limit).map((x) => x.url);
            header = `**Filtered Sitemap for ${obj.url}**\n\n**Keywords:** ${keywords.join(', ')}\n**Matches:** ${totalForPagination} of ${allUrls.length} total URLs\n`;
          } else {
            totalForPagination = allUrls.length;
            displayedUrls = allUrls.slice(offset, offset + limit);
            header = `**Sitemap for ${obj.url}**\n\n**Total URLs:** ${allUrls.length}\n`;
          }

          const totalPages = Math.max(1, Math.ceil(totalForPagination / limit));
          const currentPage = Math.floor(offset / limit) + 1;

          let responseText = header + `**Page:** ${currentPage}/${totalPages} (showing ${displayedUrls.length} URLs)\n\n**URLs:**\n`;
          displayedUrls.forEach((u, idx) => {
            responseText += `${idx + 1 + offset}. ${u}\n`;
          });

          if (currentPage < totalPages) {
            const nextOffset = offset + limit;
            responseText += `\n💡 **Next page:** Use offset=${nextOffset} to see more URLs.\n`;
          }

          if (!filtering) {
            if (allUrls.length > 100) {
              responseText += `\n⚠️ **Tip:** Re-call with a \`keywords\` array to narrow down high-value pages, or set \`extractTopMatching: 3\` to also pull content from the top matches in one shot.\n`;
            } else if (allUrls.length > 20) {
              responseText += `\nℹ️ **Tip:** Re-call with \`keywords\` to target specific sections.\n`;
            }
          }

          if (filtering && displayedUrls.length === 0 && offset === 0) {
            responseText += `\nNo URLs matched the keywords. Try broader terms or remove keywords to see the full sitemap.\n`;
          }

          // One-shot follow-up: extract content from the top N matches.
          if (filtering && extractTopMatching > 0 && displayedUrls.length > 0) {
            const targets = displayedUrls.slice(0, extractTopMatching);
            responseText += `\n---\n\n**Extracted content (top ${targets.length} match${targets.length === 1 ? '' : 'es'}):**\n`;
            const sessionId = this.generateSessionId();
            const inlineCap = parseInt(process.env.MAX_OUTPUT_LENGTH || '50000', 10);
            const perResultCap = Math.max(2000, Math.floor((inlineCap - responseText.length) / Math.max(1, targets.length)));
            for (const target of targets) {
              try {
                const extraction = await this.contentExtractor.extractContent({ url: target, sessionId });
                let chunk = extraction.content;
                if (chunk.length > perResultCap) {
                  chunk = chunk.substring(0, perResultCap) + `\n\n[Truncated at ${perResultCap} chars]`;
                }
                responseText += `\n### ${target}\n\n${chunk}\n`;
              } catch (err) {
                responseText += `\n### ${target}\n\n[Extraction failed: ${err instanceof Error ? err.message : 'unknown error'}]\n`;
              }
            }
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'get-website-sitemap');
        }
      }
    );

    // (filter-sitemap-urls was merged into get-website-sitemap. Pass a
    // `keywords` array to filter; pass `extractTopMatching` to also extract
    // content from the top matches in the same call.)

    // Register the unified GitHub repo tool. Three modes:
    //   - 'crawl' (default): README + recursive code-file crawl with previews
    //   - 'list':            single-directory listing (replaces former
    //                        get-github-directory-contents tool)
    //   - 'file':            full content of a single file at `path`
    // The `previewLength` parameter widens the per-file preview cap in
    // `crawl` mode (default 500, max 5000). Underlying extractor already
    // pulls full file content; the cap lives at the response layer.
    target.tool(
      'get-github-repo-content',
      'Inspect a GitHub repository in three modes: `crawl` (default — README + recursive code-file crawl with per-file previews), `list` (one directory listing — files and folders by name), or `file` (full content of a single file at `path`). Set `previewLength` to widen the per-file preview cap in crawl mode (default 500, max 5000). Honors GITHUB_TOKEN for authenticated 5000 req/hr quota.',
      {
        url: z.string().url().describe('GitHub repo URL, e.g. https://github.com/owner/repo'),
        mode: z.enum(['crawl', 'list', 'file']).optional().default('crawl').describe('What to return. Default: crawl.'),
        path: z.string().optional().describe('Used by `list` (directory) and `file` (single file). Empty string lists the repo root.'),
        branch: z.string().optional().describe('Branch override (defaults to repo default branch).'),
        maxDepth: z.number().optional().describe('crawl mode only. Max directory depth (default: GITHUB_MAX_DEPTH or 3).'),
        maxFiles: z.number().optional().describe('crawl mode only. Max files crawled (default: GITHUB_MAX_FILES or 50).'),
        previewLength: z.number().optional().default(500).describe('crawl mode only. Per-file preview cap in chars (default 500, max 5000).'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: get-github-repo-content`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;

          if (!obj.url || typeof obj.url !== 'string') {
            throw new Error('Invalid arguments: url is required and must be a string');
          }

          if (!this.githubExtractor) {
            throw new Error('GitHub extractor is not initialized.');
          }

          const mode = ((obj.mode as string) || 'crawl') as 'crawl' | 'list' | 'file';
          const branch = typeof obj.branch === 'string' ? obj.branch : undefined;
          const targetPath = typeof obj.path === 'string' ? obj.path : '';

          // === mode: list ===
          if (mode === 'list') {
            const repoInfo = parseGitHubUrl(obj.url);
            if (!repoInfo) throw new Error(`Invalid GitHub URL format: ${obj.url}`);

            const contents = await withTimeout(
              this.githubExtractor.getContent(repoInfo.owner, repoInfo.repo, targetPath, branch),
              TOOL_TIMEOUTS.github,
              'get-github-repo-content/list',
            );

            if (contents.length === 0) {
              return { content: [{ type: 'text' as const, text: `No contents found at path: ${targetPath || '/'}` }] };
            }

            const dirs = contents.filter((i) => i.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
            const files = contents.filter((i) => i.type === 'file').sort((a, b) => a.name.localeCompare(b.name));

            let body = `**Directory listing:** ${obj.url}${targetPath ? ` (${targetPath})` : ''}\n\n`;
            if (dirs.length) body += `**Directories:**\n` + dirs.map((d) => `📁 ${d.name}/`).join('\n') + '\n\n';
            if (files.length) body += `**Files:**\n` + files.map((f) => `📄 ${f.name}`).join('\n') + '\n';

            return { content: [{ type: 'text' as const, text: body }] };
          }

          // === mode: file ===
          if (mode === 'file') {
            if (!targetPath) {
              throw new Error('mode=file requires `path` (e.g. "src/index.ts")');
            }
            const repoInfo = parseGitHubUrl(obj.url);
            if (!repoInfo) throw new Error(`Invalid GitHub URL format: ${obj.url}`);

            const fileContent = await withTimeout(
              this.githubExtractor.getFileContent(repoInfo.owner, repoInfo.repo, targetPath, branch),
              TOOL_TIMEOUTS.github,
              'get-github-repo-content/file',
            );

            const ext = targetPath.split('.').pop() || '';
            const fence = /^(ts|tsx|js|jsx|py|java|go|rs|rb|cs|kt|swift|c|cpp|h|hpp|sh|json|yaml|yml|md|html|css)$/i.test(ext) ? ext.toLowerCase() : '';

            let body = `**File:** ${repoInfo.owner}/${repoInfo.repo}/${targetPath}${branch ? `@${branch}` : ''}\n**Bytes:** ${fileContent.length}\n\n`;
            body += `\`\`\`${fence}\n${fileContent}\n\`\`\`\n`;
            return { content: [{ type: 'text' as const, text: body }] };
          }

          // === mode: crawl (default) ===
          const maxDepth = (obj.maxDepth as number) ?? undefined;
          const maxFiles = (obj.maxFiles as number) ?? undefined;
          const previewLength = Math.min(5000, Math.max(100, (obj.previewLength as number) ?? 500));

          console.log(`[MCP] GitHub crawl for ${obj.url} (previewLength=${previewLength})`);
          const result = await withTimeout(
            this.githubExtractor.extractGitHubContent(obj.url, { maxDepth, maxFiles }),
            TOOL_TIMEOUTS.github,
            'get-github-repo-content/crawl',
          );

          let responseText = `**Repository:** ${result.repositoryInfo.owner}/${result.repositoryInfo.repo}\n\n`;
          if (result.readme) {
            responseText += `**README.md:**\n${result.readme}\n\n`;
          } else {
            responseText += `**README.md:** *(none found)*\n\n`;
          }

          if (result.files.length > 0) {
            responseText += `**Files (${result.files.length}, previewLength=${previewLength}):**\n`;
            result.files.forEach((file, idx) => {
              responseText += `${idx + 1}. ${file.path} (${file.size || 0} bytes)\n`;
              if (file.content && file.content.length > 0) {
                let preview = file.content.trim();
                if (preview.length > previewLength) {
                  preview = preview.substring(0, previewLength) + `\n\n[Truncated at ${previewLength} chars; call with mode="file" and path="${file.path}" for full content]`;
                }
                responseText += `   Preview:\n${preview}\n\n`;
              }
            });
          } else {
            responseText += `**Files:** *(none found or all skipped)*\n`;
          }

          return { content: [{ type: 'text' as const, text: responseText }] };
        } catch (error) {
          this.handleError(error, 'get-github-repo-content');
        }
      }
    );

    // (get-github-directory-contents was merged into get-github-repo-content
    // as `mode: 'list'`. The single-file-content path is exposed as
    // `mode: 'file'` with `path`. The previous extra tool only returned
    // names — small models often called it without a follow-up; folding it
    // in lets the caller pick the right depth in one decision.)
 
     // Register the OpenAPI specification extraction tool
    target.tool(
      'get-openapi-spec',
      'Extract and download OpenAPI/Swagger specifications from API documentation pages. This tool automatically discovers OpenAPI specs by checking HTML link tags, common URL patterns, and versioned swagger files. The spec is saved to docs/technical/openapi/ for future use without re-crawling.',
      {
        url: z.string().url().describe('The URL of the API documentation page (e.g., https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)'),
        forceRefresh: z.boolean().optional().default(false).describe('Force refresh the cache and re-download the spec'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: get-openapi-spec`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          // Validate arguments
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;
          
          if (!obj.url || typeof obj.url !== 'string') {
            throw new Error('Invalid arguments: url is required and must be a string');
          }

          let forceRefresh = false; // default
          if (obj.forceRefresh !== undefined) {
            const refreshValue = typeof obj.forceRefresh === 'string' ? obj.forceRefresh.toLowerCase() : obj.forceRefresh;
            forceRefresh = Boolean(refreshValue);
          }

          console.log(`[MCP] Starting OpenAPI spec extraction from: ${obj.url}`);

          // Use the OpenAPI extractor (url is already passed as first argument)
          const result = await withTimeout(
            openAPIExtractor.extractOpenAPISpec(obj.url, {
              forceRefresh: forceRefresh || undefined,
            } as any),
            TOOL_TIMEOUTS.openapi,
            'get-openapi-spec',
          );

          console.log(`[MCP] OpenAPI extraction completed: success=${result.success}`);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to extract OpenAPI specification:\n\nError: ${result.error || 'Unknown error'}`,
                },
              ],
            };
          }

          // Format the result
          let responseText = `**OpenAPI Specification Extracted Successfully!**\n\n`;
          
          if (result.downloadedFile) {
            responseText += `**Downloaded File:** ${result.downloadedFile.fileName}\n`;
            responseText += `**Local Path:** ${result.downloadedFile.localPath}\n`;
            responseText += `**Original URL:** ${result.openAPISpec?.url || obj.url}\n\n`;
          }
          
          if (result.openAPISpec) {
            responseText += `**Specification Info:**\n`;
            if (result.openAPISpec.title) responseText += `- Title: ${result.openAPISpec.title}\n`;
            if (result.openAPISpec.version) responseText += `- Version: ${result.openAPISpec.version}\n`;
            if (result.openAPISpec.description) {
              let desc = result.openAPISpec.description;
              if (desc.length > 500) desc = desc.substring(0, 500) + '...';
              responseText += `- Description: ${desc}\n`;
            }
            if (result.openAPISpec.basePath) responseText += `- Base Path: ${result.openAPISpec.basePath}\n`;
            if (result.openAPISpec.docType) responseText += `- Type: ${result.openAPISpec.docType}\n`;
            if (result.openAPISpec.size !== undefined) responseText += `- Size: ${result.openAPISpec.size} bytes\n`;
          }

          // For agentic clients (Cline / Claude Desktop / Roo Code) the path
          // is enough — they have a sibling filesystem MCP and will read it.
          // For non-agent clients (LM Studio in chat mode) the path is
          // unreachable, so embed the spec content inline up to OPENAPI_INLINE_CAP.
          if (result.downloadedFile) {
            responseText += `\n**Saved to:** \`${result.downloadedFile.localPath}\`\n`;

            if (!isAgenticClient()) {
              const inlineCap = parseInt(process.env.OPENAPI_INLINE_CAP || '50000', 10);
              try {
                const specBytes = await fs.promises.readFile(result.downloadedFile.localPath, 'utf8');
                let chunk = specBytes;
                let truncated = false;
                if (chunk.length > inlineCap) {
                  chunk = chunk.substring(0, inlineCap);
                  truncated = true;
                }
                const isYaml = result.downloadedFile.fileName.endsWith('.yaml') || result.downloadedFile.fileName.endsWith('.yml');
                responseText += `\n**Spec Content (inline for non-agent client):**\n\`\`\`${isYaml ? 'yaml' : 'json'}\n${chunk}\n\`\`\`\n`;
                if (truncated) {
                  responseText += `\n[Truncated to ${inlineCap} chars; full spec is at the path above. Re-call with \`forceRefresh: true\` and a wider \`OPENAPI_INLINE_CAP\` env if you need more.]\n`;
                }
              } catch (err) {
                responseText += `\n[Unable to embed spec inline: ${err instanceof Error ? err.message : 'read error'}]\n`;
              }
            }
          }
          
          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'get-openapi-spec');
        }
      }
    );

    // Register the progressive web search tool (advanced strategy with automatic query expansion)
    target.tool(
      'progressive-web-search',
      'Advanced web search with automatic query expansion and multi-stage searching. This tool first tries the exact user query, then progressively expands using synonyms, related terms, and alternative phrasings if good results aren\'t found. Use this for complex research where the exact wording might not match the best sources.',
      {
        query: z.string().describe('Search query to execute (uses progressive expansion strategy)'),
        maxDepth: z.number().optional().default(3).describe('Maximum number of expansion stages (1-5, default: 3)'),
        limit: z.number().optional().default(10).describe('Maximum number of results to return (1-20, default: 10)'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: progressive-web-search`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          // Validate and convert arguments
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;

          if (!obj.query || typeof obj.query !== 'string') {
            throw new Error('Invalid arguments: query is required and must be a string');
          }

          // Zod already validates and converts these to numbers
          const maxDepth = (obj.maxDepth as number) ?? 3;
          const limit = (obj.limit as number) ?? 10;

          console.log(`[MCP] Starting progressive web search for: "${obj.query}"`);
          console.log(`[MCP] Max depth: ${maxDepth}, Limit: ${limit}`);

          // Create progressive search engine instance
          const progressiveSearch = new ProgressiveSearchEngine([this.searchEngine], {
            maxDepth,
            minResultsPerStage: 3,
            maxTotalResults: limit,
          });

          // Perform progressive search with options object containing all parameters
          const results = await withTimeout(
            progressiveSearch.search(obj.query, {
              query: obj.query,
              maxDepth,
              maxTotalResults: limit,
            }),
            TOOL_TIMEOUTS.progressive,
            'progressive-web-search',
          );

          console.log(`[MCP] Progressive search completed, found ${results.length} results`);

          // Format the results as text with stage information
          let responseText = `**Progressive Web Search Results for: "${obj.query}"**\n\n`;
          responseText += `**Strategy:** Progressive expansion with automatic query rewriting\n`;
          responseText += `**Stages Used:** ${results.some(r => r.stage > 1) ? 'Multiple' : 'Single'}\n\n`;

          if (results.length === 0) {
            responseText += `No results found. The search expanded through multiple strategies but no relevant content was discovered.\n`;
          } else {
            results.forEach((result, idx) => {
              responseText += `**${idx + 1}. ${result.title}**\n`;
              responseText += `URL: ${result.url}\n`;
              responseText += `Stage: ${result.stage}\n`;
              responseText += `Query Used: "${result.queryUsed}"\n`;
              responseText += `Relevance Score: ${(result.relevanceScore * 100).toFixed(1)}%\n`;
              responseText += `Description: ${result.description}\n`;
              
              // Tunable per-result caps. Defaults match the previous
              // hard-coded values; raise via env when running on hardware
              // with a larger context budget.
              const fullCap = parseInt(process.env.PROGRESSIVE_FULL_CONTENT_CAP || '3000', 10);
              const previewCap = parseInt(process.env.PROGRESSIVE_PREVIEW_CAP || '1000', 10);
              if (result.fullContent && result.fullContent.trim()) {
                let content = result.fullContent;
                if (content.length > fullCap) {
                  content = content.substring(0, fullCap) + `\n\n[Content truncated at ${fullCap} characters]`;
                }
                responseText += `\n**Content Preview:**\n${content}\n`;
              } else if (result.contentPreview && result.contentPreview.trim()) {
                let content = result.contentPreview;
                if (content.length > previewCap) {
                  content = content.substring(0, previewCap) + `\n\n[Content truncated at ${previewCap} characters]`;
                }
                responseText += `\n**Content Preview:**\n${content}\n`;
              }

              responseText += `\n---\n\n`;
            });
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'progressive-web-search');
        }
      }
    );

    // Register the get-pdf-content tool (PDF extraction using multiple strategies)
    target.tool(
      'get-pdf-content',
      'Extract and return text content from a PDF document. This tool uses HTTP-based extraction with browser fallback for complex PDFs. Use this when you need to extract readable text from PDF files found during web research.',
      {
        url: z.string().url().describe('The URL of the PDF file to extract content from'),
        maxContentLength: z.number().optional().describe('Maximum characters for the extracted content (0 = no limit).'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: get-pdf-content`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          // Validate arguments
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;

          if (!obj.url || typeof obj.url !== 'string') {
            throw new Error('Invalid arguments: url is required and must be a string');
          }

          // Zod already validates and converts this to number
          const maxContentLengthRaw = (obj.maxContentLength as number) ?? undefined;
          const maxContentLength = maxContentLengthRaw === 0 ? undefined : maxContentLengthRaw;

          console.log(`[MCP] Starting PDF content extraction from: ${obj.url}`);

          // Use the PDF extractor to get document content
          const result = await withTimeout(
            pdfExtractor.extractPdfContent(obj.url, { maxContentLength }),
            TOOL_TIMEOUTS.pdf,
            'get-pdf-content',
          );

          console.log(`[MCP] PDF extraction completed: method=${result.extractionMethod}, length=${result.text.length}`);

          // Truncate if needed
          const textContent = pdfExtractor.truncateText(result.text, maxContentLength);

          // Format the result as text
          let responseText = `**PDF Content from: ${obj.url}**\n\n`;
          responseText += `**Extraction Method:** ${result.extractionMethod}\n`;
          if (result.pageCount !== undefined) {
            responseText += `**Pages:** ${result.pageCount}\n`;
          }
          if (result.fileSize !== undefined) {
            responseText += `**File Size:** ${result.fileSize} bytes\n`;
          }
          responseText += `\n**Content Preview:**\n${textContent}`;

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'get-pdf-content');
        }
      }
    );

    // (cached-web-search removed — the semantic cache is now wired directly
    // into full-web-search's path via the search engine, so a separate tool
    // was redundant and caused tool-selection confusion for small local
    // models. The "Status:" line in full-web-search's response surfaces the
    // engine name, which signals "semantic-cache" on cache hits.)

    // Register the list-cached-documents tool
    target.tool(
      'list-cached-documents',
      'List documents previously saved by this MCP server: OpenAPI/Swagger specs (saved by get-openapi-spec) and research markdown files (saved by research_and_save_to_markdown). Use this to see what is already on disk before re-crawling. Pair with read-cached-document to fetch a file\'s contents inline (useful for clients that lack a sibling filesystem MCP).',
      {
        category: z.enum(['all', 'openapi', 'research']).optional().default('all').describe('Filter by category: openapi (specs), research (markdown research files), or all.'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: list-cached-documents`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          const category = ((args as Record<string, unknown>).category as string) ?? 'all';

          console.log(`[MCP] Listing cached documents, category: ${category}`);

          // OpenAPI specs (only listed when category permits).
          const openapiSpecs = (category === 'all' || category === 'openapi')
            ? openAPIExtractor.listCachedOpenAPISpecs()
            : [];

          // Research markdown files. The same project-root resolution that
          // research_and_save_to_markdown uses, so we look in the same dir.
          const researchFiles: Array<{ fileName: string; localPath: string; mtime: Date; size: number }> = [];
          if (category === 'all' || category === 'research') {
            const isCwdProjectRoot = fs.existsSync(path.join(process.cwd(), 'package.json'));
            const projectRoot = isCwdProjectRoot ? process.cwd() : path.resolve(__dirname, '..', '..');
            const researchDir = path.join(projectRoot, 'docs', 'research-output');
            if (fs.existsSync(researchDir)) {
              for (const entry of fs.readdirSync(researchDir)) {
                if (!entry.endsWith('.md')) continue;
                const full = path.join(researchDir, entry);
                try {
                  const stat = fs.statSync(full);
                  researchFiles.push({ fileName: entry, localPath: full, mtime: stat.mtime, size: stat.size });
                } catch { /* unreadable entry — skip */ }
              }
              researchFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
            }
          }

          let responseText = `**Cached Documents**\n\n`;
          responseText += `**Category filter:** ${category}\n`;
          responseText += `**OpenAPI specs:** ${openapiSpecs.length}\n`;
          responseText += `**Research files:** ${researchFiles.length}\n\n`;

          if (openapiSpecs.length > 0) {
            responseText += `### OpenAPI / Swagger specs\n\n`;
            responseText += `| # | Title | File | Domain | Downloaded |\n|---|-------|------|--------|------------|\n`;
            openapiSpecs.forEach((spec, idx) => {
              const title = (spec.openAPISpec.title || 'Untitled').substring(0, 40);
              const date = new Date(spec.downloadTime).toLocaleDateString();
              responseText += `| ${idx + 1} | ${title} | ${spec.fileName} | ${spec.domain} | ${date} |\n`;
            });
            responseText += '\n';
          }

          if (researchFiles.length > 0) {
            responseText += `### Research markdown\n\n`;
            responseText += `| # | File | Size (KB) | Modified |\n|---|------|-----------|----------|\n`;
            researchFiles.forEach((f, idx) => {
              responseText += `| ${idx + 1} | ${f.fileName} | ${(f.size / 1024).toFixed(1)} | ${f.mtime.toISOString()} |\n`;
            });
            responseText += '\n';
          }

          if (openapiSpecs.length === 0 && researchFiles.length === 0) {
            responseText += `No documents found.\n`;
          }

          responseText += `\n*Use the \`read-cached-document\` tool with a file name to fetch contents inline.*\n`;

          const stats = openAPIExtractor.getCacheStats();
          responseText += `\n**OpenAPI cache stats:** total=${stats.total}, valid=${stats.valid}`;
          if (stats.size !== undefined) {
            responseText += `, file size=${(stats.size / 1024).toFixed(2)} KB`;
          }
          responseText += `\n`;

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'list-cached-documents');
        }
      }
    );

    // Register the read-cached-document tool. Companion to list-cached-documents:
    // takes a file name (as listed) and returns its content inline. Useful for
    // clients that don't have a sibling filesystem MCP — without this tool the
    // listing was a dead end for LM Studio.
    target.tool(
      'read-cached-document',
      'Return the contents of a previously-cached document by file name (as listed by list-cached-documents). Resolves the file from the OpenAPI cache directory or the research-output directory; returns text inline up to maxBytes. Refuses any name containing path separators or "..".',
      {
        fileName: z.string().min(1).describe('File name as shown by list-cached-documents (e.g. "example-com-petstore.json" or "research-2026-04-28-….md").'),
        maxBytes: z.number().optional().default(50000).describe('Maximum number of bytes to return inline (default 50000, max 200000). Larger documents are truncated with a note.'),
      },
      async (args: unknown) => {
        try {
          if (typeof args !== 'object' || args === null) {
            throw new Error('Invalid arguments: args must be an object');
          }
          const obj = args as Record<string, unknown>;
          const fileName = String(obj.fileName ?? '').trim();
          if (!fileName) {
            throw new Error('Invalid arguments: fileName is required');
          }
          // Refuse traversal attempts. Allowed names match list-cached-documents output.
          if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
            throw new Error('Invalid file name: path separators and ".." are not permitted');
          }
          const maxBytes = Math.min(200_000, Math.max(1_000, (obj.maxBytes as number) ?? 50_000));

          const isCwdProjectRoot = fs.existsSync(path.join(process.cwd(), 'package.json'));
          const projectRoot = isCwdProjectRoot ? process.cwd() : path.resolve(__dirname, '..', '..');

          // Search both well-known dirs in order: OpenAPI specs, then research output.
          const openapiDir = path.join(projectRoot, 'docs', 'technical', 'openapi');
          const researchDir = path.join(projectRoot, 'docs', 'research-output');

          const candidates = [
            { kind: 'openapi', full: path.join(openapiDir, fileName) },
            { kind: 'research', full: path.join(researchDir, fileName) },
          ];

          let found: { kind: string; full: string; size: number } | null = null;
          for (const c of candidates) {
            try {
              const st = fs.statSync(c.full);
              if (st.isFile()) {
                found = { kind: c.kind, full: c.full, size: st.size };
                break;
              }
            } catch { /* not in this dir, try next */ }
          }

          if (!found) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Document not found: ${fileName}. Use list-cached-documents to see available names.`,
                },
              ],
            };
          }

          const raw = await fs.promises.readFile(found.full, 'utf8');
          let body = raw;
          let truncated = false;
          if (body.length > maxBytes) {
            body = body.substring(0, maxBytes);
            truncated = true;
          }

          const lower = fileName.toLowerCase();
          const fence = lower.endsWith('.md') ? 'markdown'
            : lower.endsWith('.yaml') || lower.endsWith('.yml') ? 'yaml'
              : lower.endsWith('.json') ? 'json'
                : '';

          let responseText = `**Cached document:** \`${fileName}\` (${found.kind}, ${found.size} bytes)\n\n`;
          responseText += `\`\`\`${fence}\n${body}\n\`\`\`\n`;
          if (truncated) {
            responseText += `\n[Truncated to ${maxBytes} bytes; raise \`maxBytes\` (max 200000) to see more.]\n`;
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          this.handleError(error, 'read-cached-document');
        }
      }
    );
  }

  private validateAndConvertArgs(args: unknown): WebSearchToolInput {
    if (typeof args !== 'object' || args === null) {
      throw new Error('Invalid arguments: args must be an object');
    }
    const obj = args as Record<string, unknown>;
    // Ensure query is a string
    if (!obj.query || typeof obj.query !== 'string') {
      throw new Error('Invalid arguments: query is required and must be a string');
    }
    
    // Validate query is not empty (after trimming whitespace)
    const trimmedQuery = obj.query.trim();
    if (trimmedQuery === '') {
      throw new Error('Invalid arguments: query cannot be empty or whitespace only');
    }

    // Convert limit to number if it's a string
    let limit = 5; // default
    if (obj.limit !== undefined) {
      const limitValue = typeof obj.limit === 'string' ? parseInt(obj.limit, 10) : obj.limit;
      if (typeof limitValue !== 'number' || isNaN(limitValue) || limitValue < 1 || limitValue > 10) {
        throw new Error('Invalid limit: must be a number between 1 and 10');
      }
      limit = limitValue;
    }

    // Convert includeContent to boolean if it's a string
    let includeContent = true; // default
    if (obj.includeContent !== undefined) {
      if (typeof obj.includeContent === 'string') {
        includeContent = obj.includeContent.toLowerCase() === 'true';
      } else {
        includeContent = Boolean(obj.includeContent);
      }
    }

    // Convert maxContentLength to number if it's a string
    let maxContentLength: number | undefined;
    if (obj.maxContentLength !== undefined) {
      const maxLengthValue = typeof obj.maxContentLength === 'string' ? parseInt(obj.maxContentLength, 10) : obj.maxContentLength;
      if (typeof maxLengthValue !== 'number' || isNaN(maxLengthValue) || maxLengthValue < 0) {
        throw new Error('Invalid maxContentLength: must be a non-negative number');
      }
      maxContentLength = maxLengthValue === 0 ? undefined : maxLengthValue;
    }

    return {
      query: obj.query,
      limit,
      includeContent,
      maxContentLength,
    };
  }

  private async handleWebSearch(input: WebSearchToolInput, sessionId?: string): Promise<WebSearchToolOutput> {
    const startTime = Date.now();
    const { query, limit = 5, includeContent = true } = input;
    
    console.error(`[web-search-mcp] DEBUG: handleWebSearch called with limit=${limit}, includeContent=${includeContent}`);

    // Store search engine name for use in catch block
    let searchEngineName: string | undefined;

    try {
      // Request extra search results to account for potential PDF files that will be skipped
      // Request up to 2x the limit or at least 5 extra results, capped at 10 (Google's max)
      const searchLimit = includeContent ? Math.min(limit * 2 + 2, 10) : limit;
      
      console.log(`[web-search-mcp] DEBUG: Requesting ${searchLimit} search results to get ${limit} non-PDF content results`);
      
      // Perform the search
      const searchResponse = await this.searchEngine.search({
        query,
        numResults: searchLimit,
      });
      
      // Store engine name for use in catch block
      searchEngineName = searchResponse.engine;
      const searchResults = searchResponse.results;
      
      // Log search summary
      const pdfCount = searchResults.filter(result => isPdfUrl(result.url)).length;
      const followedCount = searchResults.length - pdfCount;
      console.error(`[web-search-mcp] DEBUG: Search engine: ${searchResponse.engine}; ${limit} requested/${searchResults.length} obtained; PDF: ${pdfCount}; ${followedCount} followed.`);

      // Extract content from each result if requested, with target count
      const enhancedResults = includeContent 
        ? await this.contentExtractor.extractContentForResults(searchResults, limit, input.maxContentLength, sessionId)
        : searchResults.slice(0, limit); // If not extracting content, just take the first 'limit' results
      
      // Log extraction summary with failure reasons and generate combined status
      let combinedStatus = `Search engine: ${searchResponse.engine}; ${limit} result requested/${searchResults.length} obtained; PDF: ${pdfCount}; ${followedCount} followed`;
      
      if (includeContent) {
        const successCount = enhancedResults.filter(r => r.fetchStatus === 'success').length;
        const failedResults = enhancedResults.filter(r => r.fetchStatus === 'error');
        const failedCount = failedResults.length;
        
        const failureReasons = this.categorizeFailureReasons(failedResults);
        const failureReasonText = failureReasons.length > 0 ? ` (${failureReasons.join(', ')})` : '';
        
        console.error(`[web-search-mcp] DEBUG: Links requested: ${limit}; Successfully extracted: ${successCount}; Failed: ${failedCount}${failureReasonText}; Results: ${enhancedResults.length}.`);
        
        // Add extraction info to combined status
        combinedStatus += `; Successfully extracted: ${successCount}; Failed: ${failedCount}; Results: ${enhancedResults.length}`;
      }

      const searchTime = Date.now() - startTime;

      // Record telemetry for successful search
      telemetryCollector.recordSearchSuccess(searchResponse.engine, searchTime);

      // Log success with structured audit
      auditLogger.logToolSuccess(
        'full-web-search',
        searchTime,
        enhancedResults.length,
        enhancedResults.reduce((sum, r) => sum + (r.fullContent?.length || 0), 0)
      );

      return {
        results: enhancedResults,
        total_results: enhancedResults.length,
        search_time_ms: searchTime,
        query,
        status: combinedStatus,
      };
    } catch (error) {
      // Re-throw McpError directly, otherwise convert to internal error
      if (error instanceof McpError) {
        auditLogger.logToolError('full-web-search', error.code, error.message, 'McpError');
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown web search error';
      telemetryCollector.recordSearchFailure(searchEngineName || 'unknown', Date.now() - startTime);
      auditLogger.logToolError('full-web-search', ERROR_CODES.InternalError, `Web search failed: ${message}`, 'Internal');
      throw new McpError(
        ERROR_CODES.InternalError,
        `Web search failed: ${message}`
      );
    }
  }

  private categorizeFailureReasons(failedResults: SearchResult[]): string[] {
    const reasonCounts = new Map<string, number>();
    
    failedResults.forEach(result => {
      if (result.error) {
        const category = this.categorizeError(result.error);
        reasonCounts.set(category, (reasonCounts.get(category) || 0) + 1);
      }
    });
    
    return Array.from(reasonCounts.entries()).map(([reason, count]) => 
      count > 1 ? `${reason} (${count})` : reason
    );
  }

  private categorizeError(errorMessage: string): string {
    const lowerError = errorMessage.toLowerCase();
    
    if (lowerError.includes('timeout') || lowerError.includes('timed out')) {
      return 'Timeout';
    }
    if (lowerError.includes('403') || lowerError.includes('forbidden')) {
      return 'Access denied';
    }
    if (lowerError.includes('404') || lowerError.includes('not found')) {
      return 'Not found';
    }
    if (lowerError.includes('bot') || lowerError.includes('captcha') || lowerError.includes('unusual traffic')) {
      return 'Bot detection';
    }
    if (lowerError.includes('too large') || lowerError.includes('content length') || lowerError.includes('maxcontentlength')) {
      return 'Content too long';
    }
    if (lowerError.includes('ssl') || lowerError.includes('certificate') || lowerError.includes('tls')) {
      return 'SSL error';
    }
    if (lowerError.includes('network') || lowerError.includes('connection') || lowerError.includes('econnrefused')) {
      return 'Network error';
    }
    if (lowerError.includes('dns') || lowerError.includes('hostname')) {
      return 'DNS error';
    }
    
    return 'Other error';
  }

  /**
   * Close shared resources (browser pool + search engine). Idempotent;
   * safe to call from either the SIGINT handler or an HTTP host's shutdown.
   */
  public async closeAll(): Promise<void> {
    await Promise.all([
      this.contentExtractor.closeAll(),
      this.searchEngine.closeAll(),
    ]);
  }

  private setupGracefulShutdown(): void {
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      // Don't exit on unhandled rejections, just log them
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      // Don't exit on uncaught exceptions in MCP context
    });

    // Graceful shutdown - close browsers when process exits
    process.on('SIGINT', async () => {
      console.log('Shutting down gracefully...');
      try {
        await Promise.all([
          this.contentExtractor.closeAll(),
          this.searchEngine.closeAll()
        ]);
      } catch (error) {
        console.error('Error during graceful shutdown:', error);
      }
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('Shutting down gracefully...');
      try {
        await Promise.all([
          this.contentExtractor.closeAll(),
          this.searchEngine.closeAll()
        ]);
      } catch (error) {
        console.error('Error during graceful shutdown:', error);
      }
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    console.log('Setting up MCP server...');
    const transport = new StdioServerTransport();

    console.log('Connecting to transport...');
    await this.server.connect(transport);
    console.log('Web Search MCP Server started');
    console.log('Server timestamp:', new Date().toISOString());
    console.log('Waiting for MCP messages...');
  }
}

// Boot lives in `index.ts` so the class file stays free of side effects.
