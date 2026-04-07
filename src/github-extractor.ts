import axios from 'axios';
import { GitHubFile } from './types.js';

/**
 * GitHub Repository Extractor
 * 
 * This module provides functionality to crawl GitHub repositories and extract:
 * - README.md content
 * - Code file contents (.js, .ts, .py, .java, .go, etc.)
 * - Directory structure information
 */

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

  constructor(options?: { timeout?: number; maxDepth?: number; maxFiles?: number; includeCodeOnly?: boolean }) {
    this.timeout = options?.timeout ?? 10000;
    this.maxDepth = options?.maxDepth ?? 3;
    this.maxFiles = options?.maxFiles ?? 50;
    this.includeCodeOnly = options?.includeCodeOnly ?? true;
    this.githubToken = process.env.GITHUB_TOKEN;
    
    console.log(`[GitHubExtractor] Initialized with timeout=${this.timeout}ms, maxDepth=${this.maxDepth}, maxFiles=${this.maxFiles}${this.githubToken ? ', with token' : ''}`);
  }

  /**
   * Get repository metadata
   */
  async getRepositoryInfo(owner: string, repo: string): Promise<{ defaultBranch: string; description?: string }> {
    const url = `${this.apiUrl}/repos/${owner}/${repo}`;
    
    try {
      console.log(`[GitHubExtractor] Fetching repository info for ${owner}/${repo}`);
      
      const response = await axios.get(url, {
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
      
      const response = await axios.get(url, {
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
      
      const response = await axios.get(url, {
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
      
      const response = await axios.get(url, {
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
    await this.crawlDirectory(owner, repo, '', 0, branch, files);
    
    return {
      owner,
      repo,
      defaultBranch: branch || 'main',
      files
    };
  }

  /**
   * Helper method for recursive directory crawling
   */
  private async crawlDirectory(
    owner: string,
    repo: string,
    currentPath: string,
    depth: number,
    branch?: string,
    accumulatedFiles: GitHubFile[] = []
  ): Promise<GitHubFile[]> {
    // Check limits
    if (depth > this.maxDepth) return accumulatedFiles;
    if (accumulatedFiles.length >= this.maxFiles && this.includeCodeOnly) return accumulatedFiles;

    try {
      const contents = await this.getContent(owner, repo, currentPath, branch);
      
      for (const item of contents) {
        if (item.type === 'dir') {
          // Recursively crawl directories
          await this.crawlDirectory(owner, repo, item.path, depth + 1, branch, accumulatedFiles);
        } else if (item.type === 'file') {
          // Check if we should include this file
          if (!this.includeCodeOnly || this.isCodeFile(item.name)) {
            try {
              const content = await this.getFileContent(owner, repo, item.path, branch);
              accumulatedFiles.push({
                ...item,
                content,
                size: content.length
              });
              
              console.log(`[GitHubExtractor] Added file: ${item.path} (${content.length} chars)`);
              
              if (accumulatedFiles.length >= this.maxFiles) return accumulatedFiles;
            } catch (fileError) {
              console.warn(`[GitHubExtractor] Failed to fetch ${item.path}:`, fileError);
            }
          }
        }
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
   * Get GitHub API headers
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Web-Search-MCP',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    if (this.githubToken) {
      headers['Authorization'] = `token ${this.githubToken}`;
    }

    return headers;
  }

  /**
   * Get error message from axios error
   */
  private getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 403) {
        return 'Rate limit exceeded or access denied';
      }
      if (error.response?.status === 404) {
        return 'Repository or file not found';
      }
      if (error.code === 'ECONNABORTED') {
        return 'Request timeout';
      }
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
