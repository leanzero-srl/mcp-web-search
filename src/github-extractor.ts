import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import pLimit from 'p-limit';
import { getAxiosHttpAgentConfig } from './utils.js';
import { GitHubFile } from './types.js';
import { requestContext } from './request-context.js';

// Extend AxiosRequestConfig to include the _retry flag for type-safe rate-limit handling
declare module 'axios' {
  interface InternalAxiosRequestConfig {
    _retry?: boolean;
  }
}

/**
 * GitHub Repository Extractor
 *
 * This module provides functionality to crawl GitHub repositories and extract:
 * - README.md content
 * - Code file contents (.js, .ts, .py, .java, .go, etc.)
 * - Directory structure information
 */

// Create axios instance with token masking interceptor
function createGitHubAxiosClient(githubToken?: string) {
  const client = axios.create({
    timeout: 10000,
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Web-Search-MCP',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    ...getAxiosHttpAgentConfig(),
  });

  // Request interceptor to mask token in logs
  client.interceptors.request.use((config) => {
    if (githubToken && config.headers?.Authorization) {
      const originalValue = String(config.headers.Authorization);
      // Mask the token value while keeping the structure visible for debugging
      config.headers.Authorization = `token ***${originalValue.slice(-8)}***`;
    }
    return config;
  });

  // Response interceptor to mask tokens and handle rate limiting
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;

      // Handle GitHub rate limiting (403 with Retry-After)
      if (error.response?.status === 403 && !originalRequest._retry) {
        originalRequest._retry = true;
        const retryAfter = error.response.headers['retry-after'];

        if (retryAfter) {
          const parsedSeconds = parseInt(retryAfter, 10);
          let waitTime: number;

          if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
            // Retry-After as seconds
            waitTime = Math.min(parsedSeconds * 1000, 30000);
          } else {
            // Try parsing as HTTP-date
            const date = new Date(retryAfter);
            if (!isNaN(date.getTime())) {
              waitTime = Math.max(0, Math.min(date.getTime() - Date.now(), 30000));
            } else {
              // Fallback to default
              waitTime = 10000;
            }
          }
          console.log(`[GitHubExtractor] Rate limited, waiting ${waitTime}ms (Retry-After: ${retryAfter})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          // Check if it's an auth/scopes issue (403 without Retry-After) vs rate limit
          const message = error.response?.data?.message?.toLowerCase() || '';
          if (message.includes('rate limit')) {
            // Rate limited without header — use shorter backoff for tests
            const waitTime = 10000;
            console.log(`[GitHubExtractor] Rate limited (no Retry-After), waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            // Auth/scopes issue — don't retry, just pass through
            console.warn(`[GitHubExtractor] 403 (not rate limited): ${message}`);
            return Promise.reject(error);
          }
        }

        // Retry the original request
        return client(originalRequest);
      }

      // Mask token in error message
      if (error.message && githubToken) {
        error.message = error.message.replace(githubToken, '***token-masked***');
      }
      return Promise.reject(error);
    }
  );

  return client;
}

export interface GitHubRepository {
  owner: string;
  repo: string;
  defaultBranch: string;
  files: GitHubFile[];
  readmeContent?: string;
}

export interface GitHubCrawlOptions {
  maxDepth?: number;
  maxFiles?: number;
  includeCodeOnly?: boolean;
  timeout?: number;
}

/**
 * Extracts repository information from a GitHub URL
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string; path?: string } | null {
  try {
    const urlObj = new URL(url);
    
    // Match github.com/owner/repo or github.com/owner/repo/path
    const match = urlObj.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        path: match[3] || undefined
      };
    }
    
    // Also try github.com/owner/repo/tree/branch/path format
    const treeMatch = urlObj.pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/[^/]+(\/.*)?$/);
    if (treeMatch) {
      return {
        owner: treeMatch[1],
        repo: treeMatch[2],
        path: treeMatch[3] ? treeMatch[3].substring(1) : undefined
      };
    }
    
    // Try raw.githubusercontent.com format
    const rawMatch = urlObj.hostname.includes('raw.githubusercontent.com');
    if (rawMatch) {
      const match = urlObj.pathname.match(/^\/([^/]+)\/([^/]+)\/[^/]+\/(.*)$/);
      if (match) {
        return {
          owner: match[1],
          repo: match[2],
          path: match[3]
        };
      }
    }
    
    return null;
  } catch (error) {
    console.error(`[GitHubExtractor] Error parsing URL ${url}:`, error);
    return null;
  }
}

/**
 * GitHub API Client for repository crawling
 */
export class GitHubExtractor {
  private readonly apiUrl = 'https://api.github.com';
  private readonly timeout: number;
  private maxDepth: number;
  private readonly githubToken?: string;
  private maxFiles: number;
  private includeCodeOnly: boolean;
  private axiosClient: ReturnType<typeof createGitHubAxiosClient>;

  constructor(options?: { timeout?: number; maxDepth?: number; maxFiles?: number; includeCodeOnly?: boolean }) {
    this.timeout = options?.timeout ?? 10000;
    this.maxDepth = options?.maxDepth ?? 3;
    this.maxFiles = options?.maxFiles ?? 50;
    this.includeCodeOnly = options?.includeCodeOnly ?? true;
    this.githubToken = process.env.GITHUB_TOKEN;

    // Create axios client with token masking
    this.axiosClient = createGitHubAxiosClient(this.githubToken);

    console.log(`[GitHubExtractor] Initialized with timeout=${this.timeout}ms, maxDepth=${this.maxDepth}, maxFiles=${this.maxFiles}${this.githubToken ? ', with token (masked)' : ''}`);
  }

  /**
   * Get repository metadata
   */
  async getRepositoryInfo(owner: string, repo: string): Promise<{ defaultBranch: string; description?: string }> {
    const url = `${this.apiUrl}/repos/${owner}/${repo}`;

    try {
      console.log(`[GitHubExtractor] Fetching repository info for ${owner}/${repo}`);

      const response = await this.get(url, {
        headers: this.getHeaders(),
        timeout: this.timeout,
      });

      return {
        defaultBranch: response.data.default_branch || 'main',
        description: response.data.description
      };
    } catch (error) {
      console.error(`[GitHubExtractor] Failed to get repo info for ${owner}/${repo}:`, error);
      throw new Error(`Failed to fetch repository info: ${this.getErrorMessage(error)}`);
    }
  }

  /**
   * Get README.md content from a repository
   */
  async getReadme(owner: string, repo: string, branch?: string): Promise<string> {
    const url = `${this.apiUrl}/repos/${owner}/${repo}/readme`;
    const params = branch ? { ref: branch } : {};

    try {
      console.log(`[GitHubExtractor] Fetching README for ${owner}/${repo}`);

      const response = await this.get(url, {
        headers: this.getHeaders(),
        params,
        timeout: this.timeout,
      });

      // Decode base64 content
      const content = Buffer.from(response.data.content, 'base64').toString('utf8');
      console.log(`[GitHubExtractor] Successfully fetched README (${content.length} chars)`);

      return content;
    } catch (error) {
      console.error(`[GitHubExtractor] Failed to get README for ${owner}/${repo}:`, error);
      // Return empty string if README doesn't exist
      return '';
    }
  }

  /**
   * Get contents of a directory or file
   */
  async getContent(owner: string, repo: string, path: string = '', branch?: string): Promise<GitHubFile[]> {
    const url = `${this.apiUrl}/repos/${owner}/${repo}/contents/${path}`;
    const params = branch ? { ref: branch } : {};

    try {
      console.log(`[GitHubExtractor] Fetching contents for ${owner}/${repo}:${path}`);

      const response = await this.get(url, {
        headers: this.getHeaders(),
        params,
        timeout: this.timeout,
      });

      return Array.isArray(response.data) 
        ? response.data.map(item => ({
            name: item.name,
            path: item.path,
            type: item.type as 'file' | 'dir',
            size: item.size,
            url: item.url,
            encoding: item.encoding
          }))
        : [{
            name: response.data.name,
            path: response.data.path,
            type: response.data.type as 'file' | 'dir',
            size: response.data.size,
            url: response.data.url,
            encoding: response.data.encoding
          }];
    } catch (error) {
      console.error(`[GitHubExtractor] Failed to get contents for ${owner}/${repo}:${path}:`, error);
      throw new Error(`Failed to fetch contents: ${this.getErrorMessage(error)}`);
    }
  }

  /**
   * Get file content (for files, not directories)
   */
  async getFileContent(owner: string, repo: string, path: string, branch?: string): Promise<string> {
    const url = `${this.apiUrl}/repos/${owner}/${repo}/contents/${path}`;
    const params = branch ? { ref: branch } : {};

    try {
      console.log(`[GitHubExtractor] Fetching file content for ${owner}/${repo}:${path}`);

      const response = await this.get(url, {
        headers: this.getHeaders(),
        params,
        timeout: this.timeout,
      });

      // Decode base64 content
      const content = Buffer.from(response.data.content, 'base64').toString('utf8');
      return content;
    } catch (error) {
      console.error(`[GitHubExtractor] Failed to get file content for ${owner}/${repo}:${path}:`, error);
      throw new Error(`Failed to fetch file content: ${this.getErrorMessage(error)}`);
    }
  }

  /**
   * Recursively crawl repository structure
   */
  async crawlRepository(owner: string, repo: string, branch?: string): Promise<GitHubRepository> {
    const files: GitHubFile[] = [];

    // Use a helper method instead of inline function to properly access 'this'
    // Initialize with an empty Set to track processed paths and prevent duplicates
    await this.crawlDirectory(owner, repo, '', 0, branch, files, new Set<string>());

    return {
      owner,
      repo,
      defaultBranch: branch || 'main',
      files
    };
  }

  /**
   * Helper method for recursive directory crawling with parallel file fetching
   */
  private async crawlDirectory(
    owner: string,
    repo: string,
    currentPath: string,
    depth: number,
    branch?: string,
    accumulatedFiles: GitHubFile[] = [],
    processedPaths: Set<string> = new Set()
  ): Promise<GitHubFile[]> {
    // Check limits
    if (depth > this.maxDepth) return accumulatedFiles;
    if (accumulatedFiles.length >= this.maxFiles && this.includeCodeOnly) return accumulatedFiles;

    try {
      const contents = await this.getContent(owner, repo, currentPath, branch);

      // Separate directories and files
      const dirs = contents.filter(item => item.type === 'dir');
      const files = contents.filter(item => item.type === 'file');

      // Fetch files in parallel with concurrency limit
      const limit = pLimit(5);
      const filePromises: Promise<void>[] = [];

      for (const item of files) {
        // Check file limit before queuing more work
        if (accumulatedFiles.length >= this.maxFiles && this.includeCodeOnly) break;

        // Skip if already processed or not a code file
        if (processedPaths.has(item.path)) continue;
        if (this.includeCodeOnly && !this.isCodeFile(item.name)) continue;

        filePromises.push(
          limit(async () => {
            try {
              const content = await this.getFileContent(owner, repo, item.path, branch);

              // Check limit again inside worker to prevent overshooting maxFiles due to parallel execution
              if (this.includeCodeOnly && accumulatedFiles.length >= this.maxFiles) return;

              processedPaths.add(item.path);
              accumulatedFiles.push({
                ...item,
                content,
                size: content.length,
              });

              console.log(`[GitHubExtractor] Added file: ${item.path} (${content.length} chars)`);
            } catch (fileError) {
              console.warn(`[GitHubExtractor] Failed to fetch ${item.path}:`, fileError);
            }
          })
        );
      }

      // Wait for all file fetches to complete
      await Promise.all(filePromises);

      // Recursively crawl directories (sequential to maintain depth tracking)
      for (const dir of dirs) {
        await this.crawlDirectory(owner, repo, dir.path, depth + 1, branch, accumulatedFiles, processedPaths);
        if (accumulatedFiles.length >= this.maxFiles && this.includeCodeOnly) break;
      }
    } catch (error) {
      console.error(`[GitHubExtractor] Error crawling ${currentPath}:`, error);
    }

    return accumulatedFiles;
  }

  /**
   * Check if a file is a code file
   */
  private isCodeFile(filename: string): boolean {
    const codeExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.rb',
      '.php', '.cs', '.cpp', '.c', '.h', '.hpp', '.swift', '.kt', '.scala',
      '.sh', '.bash', '.yml', '.yaml', '.json', '.xml', '.html', '.css',
      '.scss', '.sass', '.less', '.sql', '.md', '.rst', '.txt'
    ];
    
    return codeExtensions.some(ext => filename.toLowerCase().endsWith(ext));
  }

  /**
   * Get GitHub API headers (deprecated, now handled by axios interceptor)
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Web-Search-MCP',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    // Prefer the per-request token (HTTP callers bring their own); fall back to
    // the process env (stdio callers set GITHUB_TOKEN in their mcp.json env).
    const token = requestContext.getStore()?.githubToken || this.githubToken;
    if (token) {
      // Token masking is now handled by axios interceptor
      headers['Authorization'] = `token ${token}`;
    }

    return headers;
  }

  /**
   * Mask GitHub token for safe logging
   */
  private maskToken(token: string): string {
    if (!token || token.length <= 8) {
      return '***';
    }
    const prefix = token.slice(0, 4);
    const suffix = token.slice(-4);
    return `${prefix}...${suffix}`;
  }

  /**
   * Execute a GET request with axios client (uses interceptor for token masking)
   */
  private async get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.axiosClient.get(url, config);
  }

  /**
   * Get error message from axios error
   */
  private getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return error.message || `HTTP ${error.response?.status || 'unknown'}`;
    }
    return error instanceof Error ? error.message : 'Unknown error';
  }

  /**
   * Extract content from a GitHub URL (public method)
   */
  async extractGitHubContent(
    url: string,
    options?: GitHubCrawlOptions
  ): Promise<{ repositoryInfo: { owner: string; repo: string; defaultBranch: string }; readme?: string; files: GitHubFile[] }> {
    // Parse the URL to get owner and repo
    const repoInfo = parseGitHubUrl(url);
    if (!repoInfo) {
      throw new Error(`Invalid GitHub URL format: ${url}`);
    }

    console.log(`[GitHubExtractor] Extracting content from ${repoInfo.owner}/${repoInfo.repo}`);

    // Get repository info (default branch)
    const repoMetadata = await this.getRepositoryInfo(repoInfo.owner, repoInfo.repo);
    
    // Get README.md
    const readme = await this.getReadme(repoInfo.owner, repoInfo.repo, repoMetadata.defaultBranch);

    // Crawl the repository with provided options
    const crawlOptions: GitHubCrawlOptions = {
      ...options,
      maxDepth: options?.maxDepth ?? this.maxDepth,
      maxFiles: options?.maxFiles ?? this.maxFiles,
      includeCodeOnly: options?.includeCodeOnly ?? this.includeCodeOnly
    };

    // Create a temporary extractor with the provided options for crawling
    const tempExtractor = new GitHubExtractor(crawlOptions);
    const repo = await tempExtractor.crawlRepository(repoInfo.owner, repoInfo.repo, repoMetadata.defaultBranch);

    return {
      repositoryInfo: {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        defaultBranch: repoMetadata.defaultBranch
      },
      readme,
      files: repo.files
    };
  }
}
