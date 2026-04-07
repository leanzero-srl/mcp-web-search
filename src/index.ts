#!/usr/bin/env node

// Redirect both console.log and console.error to stderr to prevent corruption of MCP protocol over stdout
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  process.stderr.write(`[LOG] ${message}\n`);
};

console.error = (...args) => {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  process.stderr.write(`[ERROR] ${message}\n`);
};

// Import the main McpServer class
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
import { SearchEngine } from './search-engine.js';
import { EnhancedContentExtractor } from './enhanced-content-extractor.js';
import { WebSearchToolInput, WebSearchToolOutput, SearchResult, GitHubFile, OpenAPIExtractionResult } from './types.js';
import { ProgressiveSearchEngine } from './progressive-search-engine.js';
import { isPdfUrl } from './utils.js';
import { GitHubExtractor, parseGitHubUrl } from './github-extractor.js';
import { openAPIExtractor } from './openapi-extractor.js';

// ============================================================================
// Import Phase 3 modules (Intelligence Expansion)
// ============================================================================

import { PdfExtractor, pdfExtractor } from './pdf-extractor.js';
import { semanticCache } from './semantic-cache.js';

// ============================================================================
// Import observability module
// ============================================================================

import { auditLogger, telemetryCollector } from './observability.js';

// ============================================================================
// Import enterprise guardrails module
// ============================================================================

import {
  sessionRateLimiter,
  inputValidator,
  outputLimiter,
  globalThrottler,
} from './enterprise-guardrails.js';

class WebSearchMCPServer {
  private server: McpServer;
  private searchEngine: SearchEngine;
  private contentExtractor: EnhancedContentExtractor;
  private githubExtractor?: GitHubExtractor;

  /**
   * Generate a session ID for tracking rate limits
   */
  private generateSessionId(args: unknown): string {
    // Use a simple hash of client info or timestamp for session identification
    const clientId = process.env.CLIENT_ID || 'default';
    return `${clientId}-${Date.now()}`;
  }

  /**
   * Helper function to convert errors to McpError with proper codes
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
          ERROR_CODES.InternalError,
          `Request timeout: ${error.message}`
        );
      }

      if (message.includes('not found') || message.includes('404')) {
        throw new McpError(
          ERROR_CODES.InvalidParams,
          `Resource not found: ${error.message}`
        );
      }

      if (message.includes('rate limit') || message.includes('quota')) {
        throw new McpError(
          ERROR_CODES.ResourceExhausted,
          `Rate limit exceeded: ${error.message}`
        );
      }

      if (message.includes('unauthorized') || message.includes('401') || message.includes('403')) {
        throw new McpError(
          ERROR_CODES.Unauthorized,
          `Authentication/authorization failed: ${error.message}`
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

  constructor() {
    this.server = new McpServer({
      name: 'web-search-mcp',
      version: '0.3.1',
    });

    const maxRPM = parseInt(process.env.SEARCH_ENGINE_MAX_RPM || '10', 10);
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

    this.setupTools();
    this.setupGracefulShutdown();
  }

  private setupTools(): void {
    // Register the main web search tool (primary choice for comprehensive searches)
    this.server.tool(
      'full-web-search',
      'Search the web and fetch complete page content from top results. This is the most comprehensive web search tool. It searches the web and then follows the resulting links to extract their full page content, providing the most detailed and complete information available. Use get-web-search-summaries for a lightweight alternative.',
      {
        query: z.string().describe('Search query to execute (recommended for comprehensive research)'),
        limit: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 1 || num > 10) {
            throw new Error('Invalid limit: must be a number between 1 and 10');
          }
          return num;
        }).default(5).describe('Number of results to return with full content (1-10)'),
        includeContent: z.union([z.boolean(), z.string()]).transform((val) => {
          if (typeof val === 'string') {
            return val.toLowerCase() === 'true';
          }
          return Boolean(val);
        }).default(true).describe('Whether to fetch full page content (default: true)'),
        maxContentLength: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 0) {
            throw new Error('Invalid maxContentLength: must be a non-negative number');
          }
          return num;
        }).optional().describe('Maximum characters per result content (0 = no limit). Usually not needed - content length is automatically optimized.'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: full-web-search`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          // Convert and validate arguments
          const validatedArgs = this.validateAndConvertArgs(args);
          
          // Auto-detect model types based on parameter formats
          // Llama models often send string parameters and struggle with large responses
          const isLikelyLlama = typeof args === 'object' && args !== null && (
            ('limit' in args && typeof (args as Record<string, unknown>).limit === 'string') ||
            ('includeContent' in args && typeof (args as Record<string, unknown>).includeContent === 'string')
          );
          
          // Detect models that handle large responses well (Qwen, Gemma, recent Deepseek)
          const isLikelyRobustModel = typeof args === 'object' && args !== null && (
            ('limit' in args && typeof (args as Record<string, unknown>).limit === 'number') &&
            ('includeContent' in args && typeof (args as Record<string, unknown>).includeContent === 'boolean')
          );
          
          // Only apply auto-limit if maxContentLength is not explicitly set (including 0)
          const hasExplicitMaxLength = typeof args === 'object' && args !== null && 'maxContentLength' in args;
          
          if (!hasExplicitMaxLength && isLikelyLlama) {
            console.log(`[MCP] Detected potential Llama model (string parameters), applying content length limit`);
            validatedArgs.maxContentLength = 2000; // Reasonable limit for Llama
          }
          
          // For robust models (Qwen, Gemma, recent Deepseek), remove maxContentLength if it's set to a low value
          if (isLikelyRobustModel && validatedArgs.maxContentLength && validatedArgs.maxContentLength < 5000) {
            console.log(`[MCP] Detected robust model (numeric parameters), removing unnecessary content length limit`);
            validatedArgs.maxContentLength = undefined;
          }
          
          console.log(`[MCP] Validated args:`, JSON.stringify(validatedArgs, null, 2));
          
          console.log(`[MCP] Starting web search...`);
          const result = await this.handleWebSearch(validatedArgs);
          
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
    this.server.tool(
      'get-web-search-summaries',
      'Search the web and return only the search result snippets/descriptions without following links to extract full page content. This is a lightweight alternative to full-web-search for when you only need brief search results. For comprehensive information, use full-web-search instead.',
      {
        query: z.string().describe('Search query to execute (lightweight alternative)'),
        limit: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 1 || num > 10) {
            throw new Error('Invalid limit: must be a number between 1 and 10');
          }
          return num;
        }).default(5).describe('Number of search results to return (1-10)'),
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
          const searchResponse = await this.searchEngine.search({
            query: obj.query,
            numResults: limit,
          });

          // Convert to summary format (no content extraction)
          const summaryResults = searchResponse.results.map(item => ({
            title: item.title,
            url: item.url,
            description: item.description,
            timestamp: item.timestamp,
          }));

          console.log(`[MCP] Search summaries completed, found ${summaryResults.length} results`);
          
          // Format the results as text
          let responseText = `Search summaries for "${obj.query}" with ${summaryResults.length} results:\n\n`;
          
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
    this.server.tool(
      'get-single-web-page-content',
      'Extract and return the full content from a single web page URL. This tool follows a provided URL and extracts the main page content. Useful for getting detailed content from a specific webpage without performing a search.',
      {
        url: z.string().url().describe('The URL of the web page to extract content from'),
        maxContentLength: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 0) {
            throw new Error('Invalid maxContentLength: must be a non-negative number');
          }
          return num;
        }).optional().describe('Maximum characters for the extracted content (0 = no limit, undefined = use default limit). Usually not needed - content length is automatically optimized.'),
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

          let maxContentLength: number | undefined;
          if (obj.maxContentLength !== undefined) {
            const maxLengthValue = typeof obj.maxContentLength === 'string' ? parseInt(obj.maxContentLength, 10) : obj.maxContentLength;
            if (typeof maxLengthValue !== 'number' || isNaN(maxLengthValue) || maxLengthValue < 0) {
              throw new Error('Invalid maxContentLength: must be a non-negative number');
            }
            // If maxContentLength is 0, treat it as "no limit" (undefined)
            maxContentLength = maxLengthValue === 0 ? undefined : maxLengthValue;
          }

          console.log(`[MCP] Starting single page content extraction for: ${obj.url}`);
          
           // Use existing content extractor to get page content
           const contentObj = await this.contentExtractor.extractContent({
             url: obj.url,
             maxContentLength,
           });
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
             const remainingSpace = maxContentLength - header.length - 50;
             if (content.length > remainingSpace) {
               body = `**Content (truncated):**\n${content.substring(0, Math.max(0, remainingSpace))}\n\n[Content truncated to respect limit]`;
             } else {
               body = `**Content:**\n${content}`;
             }
           } else {
             body = `**Content:**\n${content}`;
           }
           const responseText = header + body;

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

    // Register the GitHub repository content extraction tool
    this.server.tool(
      'get-github-repo-content',
      'Extract and return content from a GitHub repository. This tool fetches README.md and crawls code files (.js, .ts, .py, etc.) from the repository. Use this when you need to understand the structure and contents of a GitHub project.',
      {
        url: z.string().url().describe('The URL of the GitHub repository (e.g., https://github.com/owner/repo)'),
        maxDepth: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 0) {
            throw new Error('Invalid maxDepth: must be a non-negative number');
          }
          return num;
        }).optional().describe('Maximum directory depth to crawl (default: from environment or 3)'),
        maxFiles: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 0) {
            throw new Error('Invalid maxFiles: must be a non-negative number');
          }
          return num;
        }).optional().describe('Maximum number of files to extract content from (default: from environment or 50)'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: get-github-repo-content`);
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

          let maxDepth: number | undefined;
          if (obj.maxDepth !== undefined) {
            const maxDepthValue = typeof obj.maxDepth === 'string' ? parseInt(obj.maxDepth, 10) : obj.maxDepth;
            if (typeof maxDepthValue !== 'number' || isNaN(maxDepthValue)) {
              throw new Error('Invalid maxDepth: must be a number');
            }
            maxDepth = maxDepthValue;
          }

          let maxFiles: number | undefined;
          if (obj.maxFiles !== undefined) {
            const maxFilesValue = typeof obj.maxFiles === 'string' ? parseInt(obj.maxFiles, 10) : obj.maxFiles;
            if (typeof maxFilesValue !== 'number' || isNaN(maxFilesValue)) {
              throw new Error('Invalid maxFiles: must be a number');
            }
            maxFiles = maxFilesValue;
          }

          console.log(`[MCP] Starting GitHub repository extraction for: ${obj.url}`);
          
          // Validate we have a GitHub extractor initialized
          if (!this.githubExtractor) {
            throw new Error('GitHub extractor is not initialized. Check GITHUB_MAX_DEPTH, GITHUB_MAX_FILES environment variables.');
          }

          // Use the GitHub extractor to get repository content
          const result = await this.githubExtractor.extractGitHubContent(obj.url, { 
            maxDepth,
            maxFiles 
          });

           console.log(`[MCP] GitHub extraction completed: ${result.repositoryInfo.owner}/${result.repositoryInfo.repo} (${result.files.length} files)`);
 
           let responseText = `**Repository:** ${result.repositoryInfo.owner}/${result.repositoryInfo.repo}\n\n`;

          if (result.readme) {
            responseText += `**README.md:**\n${result.readme}\n\n`;
          } else {
            responseText += `**README.md:** No README found\n\n`;
          }

          // Add file list
          if (result.files.length > 0) {
            responseText += `**Files:**\n`;
            result.files.forEach((file, idx) => {
              responseText += `${idx + 1}. ${file.path} (${file.size || 0} bytes)\n`;
              
              // Include file content preview (first 500 chars)
              if (file.content && file.content.length > 0) {
                let contentPreview = file.content.trim();
                if (contentPreview.length > 500) {
                  contentPreview = contentPreview.substring(0, 500) + `\n\n[Content truncated at 500 characters]`;
                }
                responseText += `   Preview: ${contentPreview}\n`;
              }
            });
          } else {
            responseText += `**Files:** No files found or all files were skipped.\n`;
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
           this.handleError(error, 'get-github-repo-content');
         }
       }
     );
 
     // Register the GitHub directory listing tool
     this.server.tool(
       'get-github-directory-contents',
       'List the files and directories within a specific path of a GitHub repository. This is useful for exploring the repository structure before fetching specific file contents.',
       {
         url: z.string().url().describe('The URL of the GitHub repository (e.g., https://github.com/owner/repo)'),
         path: z.string().optional().describe('The path within the repository to list (e.g., "docs/technical")'),
         branch: z.string().optional().describe('The branch to use (e.g., "main")'),
       },
       async (args: unknown) => {
         console.log(`[MCP] Tool call received: get-github-directory-contents`);
         console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));
 
         try {
           if (typeof args !== 'object' || args === null) {
             throw new Error('Invalid arguments: args must be an object');
           }
           const obj = args as Record<string, unknown>;
 
           if (!obj.url || typeof obj.url !== 'string') {
             throw new Error('Invalid arguments: url is required and must be a string');
           }
 
           const repoInfo = parseGitHubUrl(obj.url);
           if (!repoInfo) {
             throw new Error(`Invalid GitHub URL format: ${obj.url}`);
           }
 
           const targetPath = (obj.path as string) || '';
           const branch = obj.branch as string | undefined;
 
           if (!this.githubExtractor) {
             throw new Error('GitHub extractor is not initialized.');
           }
 
           console.log(`[MCP] Fetching directory contents for ${repoInfo.owner}/${repoInfo.repo}:${targetPath}`);
           const contents = await this.githubExtractor.getContent(
             repoInfo.owner,
             repoInfo.repo,
             targetPath,
             branch
           );
 
           if (contents.length === 0) {
             return {
               content: [{ type: 'text' as const, text: `No contents found at path: ${targetPath}` }],
             };
           }
 
           let responseText = `**Directory Listing for:** ${obj.url}${targetPath ? ` (${targetPath})` : ''}\n\n`;
           
           // Separate directories and files for better presentation
           const dirs = contents.filter(item => item.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
           const files = contents.filter(item => item.type === 'file').sort((a, b) => a.name.localeCompare(b.name));
 
           if (dirs.length > 0) {
             responseText += `**Directories:**\n`;
             dirs.forEach(dir => {
               responseText += `📁 ${dir.name}/\n`;
             });
             responseText += `\n`;
           }
 
           if (files.length > 0) {
             responseText += `**Files:**\n`;
             files.forEach(file => {
               responseText += `📄 ${file.name}\n`;
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
           this.handleError(error, 'get-github-directory-contents');
         }
       }
     );
 
     // Register the OpenAPI specification extraction tool
    this.server.tool(
      'get-openapi-spec',
      'Extract and download OpenAPI/Swagger specifications from API documentation pages. This tool automatically discovers OpenAPI specs by checking HTML link tags, common URL patterns, and versioned swagger files. The spec is saved to docs/technical/openapi/ for future use without re-crawling.',
      {
        url: z.string().url().describe('The URL of the API documentation page (e.g., https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)'),
        forceRefresh: z.union([z.boolean(), z.string()]).transform((val) => {
          if (typeof val === 'string') {
            return val.toLowerCase() === 'true';
          }
          return Boolean(val);
        }).default(false).describe('Force refresh the cache and re-download the spec'),
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
          const result = await openAPIExtractor.extractOpenAPISpec(obj.url, {
            forceRefresh: forceRefresh || undefined,
          } as any);

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
          
          responseText += `\n**Note:** The full OpenAPI specification has been saved to:\`${result.downloadedFile?.localPath || 'docs/technical/openapi/' + obj.url.replace(/[^a-z0-9]/gi, '-')}.json\`\n\nYou can read this file directly for the complete API documentation without needing to re-extract it.\n`;
          
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
    this.server.tool(
      'progressive-web-search',
      'Advanced web search with automatic query expansion and multi-stage searching. This tool first tries the exact user query, then progressively expands using synonyms, related terms, and alternative phrasings if good results aren\'t found. Use this for complex research where the exact wording might not match the best sources.',
      {
        query: z.string().describe('Search query to execute (uses progressive expansion strategy)'),
        maxDepth: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 1 || num > 5) {
            throw new Error('Invalid maxDepth: must be a number between 1 and 5');
          }
          return num;
        }).default(3).describe('Maximum number of expansion stages (1-5, default: 3)'),
        limit: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 1 || num > 20) {
            throw new Error('Invalid limit: must be a number between 1 and 20');
          }
          return num;
        }).default(10).describe('Maximum number of results to return (1-20, default: 10)'),
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

          let maxDepth = 3; // default
          if (obj.maxDepth !== undefined) {
            const maxDepthValue = typeof obj.maxDepth === 'string' ? parseInt(obj.maxDepth, 10) : obj.maxDepth;
            if (typeof maxDepthValue !== 'number' || isNaN(maxDepthValue)) {
              throw new Error('Invalid maxDepth: must be a number');
            }
            maxDepth = maxDepthValue;
          }

          let limit = 10; // default
          if (obj.limit !== undefined) {
            const limitValue = typeof obj.limit === 'string' ? parseInt(obj.limit, 10) : obj.limit;
            if (typeof limitValue !== 'number' || isNaN(limitValue)) {
              throw new Error('Invalid limit: must be a number');
            }
            limit = limitValue;
          }

          console.log(`[MCP] Starting progressive web search for: "${obj.query}"`);
          console.log(`[MCP] Max depth: ${maxDepth}, Limit: ${limit}`);

          // Create progressive search engine instance
          const progressiveSearch = new ProgressiveSearchEngine([this.searchEngine], {
            maxDepth,
            minResultsPerStage: 3,
            maxTotalResults: limit,
          });

          // Perform progressive search with options object containing all parameters
          const results = await progressiveSearch.search(obj.query, {
            query: obj.query,
            maxDepth,
            maxTotalResults: limit,
          });

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
              
              if (result.fullContent && result.fullContent.trim()) {
                let content = result.fullContent;
                const maxLength = 3000; // Reasonable preview for progressive search
                if (content.length > maxLength) {
                  content = content.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} characters]`;
                }
                responseText += `\n**Content Preview:**\n${content}\n`;
              } else if (result.contentPreview && result.contentPreview.trim()) {
                let content = result.contentPreview;
                if (content.length > 1000) {
                  content = content.substring(0, 1000) + `\n\n[Content truncated at 1000 characters]`;
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
    this.server.tool(
      'get-pdf-content',
      'Extract and return text content from a PDF document. This tool uses HTTP-based extraction with browser fallback for complex PDFs. Use this when you need to extract readable text from PDF files found during web research.',
      {
        url: z.string().url().describe('The URL of the PDF file to extract content from'),
        maxContentLength: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 0) {
            throw new Error('Invalid maxContentLength: must be a non-negative number');
          }
          return num;
        }).optional().describe('Maximum characters for the extracted content (0 = no limit).'),
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

          let maxContentLength: number | undefined;
          if (obj.maxContentLength !== undefined) {
            const maxLengthValue = typeof obj.maxContentLength === 'string' ? parseInt(obj.maxContentLength, 10) : obj.maxContentLength;
            if (typeof maxLengthValue !== 'number' || isNaN(maxLengthValue) || maxLengthValue < 0) {
              throw new Error('Invalid maxContentLength: must be a non-negative number');
            }
            maxContentLength = maxLengthValue === 0 ? undefined : maxLengthValue;
          }

          console.log(`[MCP] Starting PDF content extraction from: ${obj.url}`);
          
          // Use the PDF extractor to get document content
          const result = await pdfExtractor.extractPdfContent(obj.url, {
            maxContentLength,
          });

          console.log(`[MCP] PDF extraction completed: method=${result.extractionMethod}, length=${result.text.length}`);

          // Truncate if needed
          let textContent = pdfExtractor.truncateText(result.text, maxContentLength);

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

    // Register the cached-web-search tool (search with semantic caching)
    this.server.tool(
      'cached-web-search',
      'Search the web using intelligent caching. This tool first checks if similar queries have been recently searched and returns cached results when available. Use this for repeated or related queries to save time and reduce API calls.',
      {
        query: z.string().describe('Search query to execute (uses semantic cache)'),
        limit: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 1 || num > 10) {
            throw new Error('Invalid limit: must be a number between 1 and 10');
          }
          return num;
        }).default(5).describe('Number of results to return with full content (1-10)'),
        includeContent: z.union([z.boolean(), z.string()]).transform((val) => {
          if (typeof val === 'string') {
            return val.toLowerCase() === 'true';
          }
          return Boolean(val);
        }).default(true).describe('Whether to fetch full page content (default: true)'),
        maxContentLength: z.union([z.number(), z.string()]).transform((val) => {
          const num = typeof val === 'string' ? parseInt(val, 10) : val;
          if (isNaN(num) || num < 0) {
            throw new Error('Invalid maxContentLength: must be a non-negative number');
          }
          return num;
        }).optional().describe('Maximum characters per result content (0 = no limit).'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: cached-web-search`);
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

          let limit = 5; // default
          if (obj.limit !== undefined) {
            const limitValue = typeof obj.limit === 'string' ? parseInt(obj.limit, 10) : obj.limit;
            if (typeof limitValue !== 'number' || isNaN(limitValue) || limitValue < 1 || limitValue > 10) {
              throw new Error('Invalid limit: must be a number between 1 and 10');
            }
            limit = limitValue;
          }

          let includeContent = true; // default
          if (obj.includeContent !== undefined) {
            if (typeof obj.includeContent === 'string') {
              includeContent = obj.includeContent.toLowerCase() === 'true';
            } else {
              includeContent = Boolean(obj.includeContent);
            }
          }

          let maxContentLength: number | undefined;
          if (obj.maxContentLength !== undefined) {
            const maxLengthValue = typeof obj.maxContentLength === 'string' ? parseInt(obj.maxContentLength, 10) : obj.maxContentLength;
            if (typeof maxLengthValue !== 'number' || isNaN(maxLengthValue) || maxLengthValue < 0) {
              throw new Error('Invalid maxContentLength: must be a non-negative number');
            }
            maxContentLength = maxLengthValue === 0 ? undefined : maxLengthValue;
          }

          const query = obj.query;

          console.log(`[MCP] Checking semantic cache for: "${query}"`);

          // Check if we have cached results for this query
          const cachedEntry = semanticCache.get(query);
          
          if (cachedEntry) {
            console.log(`[MCP] Cache HIT for: "${query}"`);
            
            // Format cached results as text
            let responseText = `**Cached Results for: "${query}"**\n\n`;
            responseText += `**Cache Hit:** Yes - returned from cache\n`;
            responseText += `**Query Meaning Match:** Found similar query in cache\n\n`;

            if (Array.isArray(cachedEntry.results)) {
              cachedEntry.results.slice(0, limit).forEach((result: SearchResult, idx) => {
                responseText += `**${idx + 1}. ${result.title}**\n`;
                responseText += `URL: ${result.url}\n`;
                responseText += `Description: ${result.description}\n`;
                
                if (includeContent && result.fullContent) {
                  let content = result.fullContent;
                  if (maxContentLength && maxContentLength > 0 && content.length > maxContentLength) {
                    content = content.substring(0, maxContentLength) + `\n\n[Content truncated at ${maxContentLength} characters]`;
                  }
                  responseText += `\n**Full Content:**\n${content}\n`;
                }
                
                responseText += `\n---\n\n`;
              });
            } else {
              responseText += `No results found in cache.\n`;
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: responseText,
                },
              ],
            };
          }

          console.log(`[MCP] Cache MISS for: "${query}" - performing fresh search`);

          // Perform the actual web search
          const searchResponse = await this.searchEngine.search({
            query,
            numResults: limit * 2 + 2, // Request extra to account for PDFs
          });

          const searchResults = searchResponse.results;

          console.log(`[MCP] Search completed, found ${searchResults.length} results`);

          // Extract content from each result if requested
          let enhancedResults: SearchResult[] = [];
          if (includeContent) {
            enhancedResults = await this.contentExtractor.extractContentForResults(searchResults.slice(0, limit), limit);
          } else {
            enhancedResults = searchResults.slice(0, limit);
          }

          // Store results in cache for future similar queries
          semanticCache.set(query, enhancedResults);

          console.log(`[MCP] Results cached for: "${query}"`);

          // Format the results as text
          let responseText = `**Search Results for: "${query}"**\n\n`;
          responseText += `**Cache Hit:** No - performed fresh search\n`;
          responseText += `**Results Cached:** Yes\n\n`;

          enhancedResults.forEach((searchResult, idx) => {
            responseText += `**${idx + 1}. ${searchResult.title}**\n`;
            responseText += `URL: ${searchResult.url}\n`;
            responseText += `Description: ${searchResult.description}\n`;
            
            if (includeContent && searchResult.fullContent) {
              let content = searchResult.fullContent;
              if (maxContentLength && maxContentLength > 0 && content.length > maxContentLength) {
                content = content.substring(0, maxContentLength) + `\n\n[Content truncated at ${maxContentLength} characters]`;
              }
              responseText += `\n**Full Content:**\n${content}\n`;
            } else if (searchResult.contentPreview && searchResult.contentPreview.trim()) {
              let content = searchResult.contentPreview;
              if (maxContentLength && maxContentLength > 0 && content.length > maxContentLength) {
                content = content.substring(0, maxContentLength) + `\n\n[Content truncated at ${maxContentLength} characters]`;
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
          this.handleError(error, 'cached-web-search');
        }
      }
    );

    // Register the list cached documents tool
    this.server.tool(
      'list-cached-documents',
      'List all documents that have been crawled and saved by this MCP server. This includes OpenAPI specifications, technical documentation, and other extracted content. Use this to see what has already been downloaded and avoid re-crawling.',
      {
        category: z.union([z.string(), z.literal('all')]).default('all').describe('Filter by category (openapi, technical-md, all)'),
      },
      async (args: unknown) => {
        console.log(`[MCP] Tool call received: list-cached-documents`);
        console.log(`[MCP] Raw arguments:`, JSON.stringify(args, null, 2));

        try {
          let category = 'all'; // default
          if (typeof args === 'object' && args !== null) {
            const obj = args as Record<string, unknown>;
            if (obj.category !== undefined) {
              category = typeof obj.category === 'string' ? obj.category : 'all';
            }
          }

          console.log(`[MCP] Listing cached documents, category: ${category}`);

          // Get OpenAPI specs from cache
          const openapiSpecs = openAPIExtractor.listCachedOpenAPISpecs();
          
          // Filter by category if specified
          let results = openapiSpecs;
          if (category !== 'all' && category !== 'openapi') {
            results = [];
          }

          console.log(`[MCP] Found ${results.length} cached documents`);

          // Format the result
          let responseText = `**Cached Documents**\n\n`;
          responseText += `**Total Cached:** ${results.length}\n`;
          
          if (category === 'openapi') {
            responseText += `**Category:** OpenAPI/Swagger Specifications\n\n`;
          } else {
            responseText += `**Category:** All (OpenAPI, Technical Docs)\n\n`;
          }

          if (results.length === 0) {
            responseText += `No documents found.\n`;
          } else {
            responseText += `\n| # | Title | File Name | Domain | Downloaded |\n`;
            responseText += `|---|-------|-----------|--------|------------|\n`;
            
            results.forEach((spec, idx) => {
              const title = spec.openAPISpec.title || 'Untitled';
              const domain = spec.domain;
              const date = new Date(spec.downloadTime).toLocaleDateString();
              
              // Truncate long titles
              let displayTitle = title;
              if (displayTitle.length > 40) {
                displayTitle = title.substring(0, 37) + '...';
              }
              
              responseText += `| ${idx + 1} | ${displayTitle} | ${spec.fileName} | ${domain} | ${date} |\n`;
            });
          }

          // Add cache statistics
          const stats = openAPIExtractor.getCacheStats();
          responseText += `\n**Cache Statistics:**\n`;
          responseText += `- Total Entries: ${stats.total}\n`;
          responseText += `- Valid Entries: ${stats.valid}\n`;
          if (stats.size !== undefined) {
            responseText += `- Cache File Size: ${(stats.size / 1024).toFixed(2)} KB\n`;
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
          this.handleError(error, 'list-cached-documents');
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

    return {
      query: obj.query,
      limit,
      includeContent,
    };
  }

  private async handleWebSearch(input: WebSearchToolInput): Promise<WebSearchToolOutput> {
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
        ? await this.contentExtractor.extractContentForResults(searchResults, limit)
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

// Start the server
const server = new WebSearchMCPServer();
server.run().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error('Server error:', error.message);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});
