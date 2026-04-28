/**
 * MCP Web Search - PDF Extractor Module
 *
 * Provides high-fidelity PDF content extraction using multiple strategies:
 * - Direct HTTP download with pdf-parse text extraction
 * - Browser-based rendering for complex PDFs
 * - Fallback mechanisms for unreliable sources
 */

import { browserPool } from './browser-pool.js';
import { auditLogger, telemetryCollector } from './observability.js';
import { safeFetchUrl } from './utils.js';

// Cached pdf-parse dynamic import to avoid repeated module loading
let cachedPdfParseFn: ((buffer: Uint8Array) => Promise<any>) | null = null;
async function getPdfParseFn(): Promise<(buffer: Uint8Array) => Promise<any>> {
  if (!cachedPdfParseFn) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('pdf-parse');
    cachedPdfParseFn = mod.default || mod;
  }
  return cachedPdfParseFn!;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * PDF extraction configuration
 */
export interface PdfExtractionConfig {
  /** Maximum content length to extract (0 = no limit) */
  maxContentLength?: number;
  
  /** Timeout for PDF download/processing in milliseconds */
  timeout?: number;
}

/**
 * Result of PDF extraction
 */
export interface PdfExtractionResult {
  /** Extracted text content */
  text: string;
  
  /** Number of pages in the PDF */
  pageCount?: number;
  
  /** File size in bytes if available */
  fileSize?: number;
  
  /** Extraction method used ('http' or 'browser') */
  extractionMethod: 'http' | 'browser';
}

/**
 * High-fidelity PDF content extractor
 */
export class PdfExtractor {
  private readonly defaultTimeout: number = 30000; // 30 seconds

  /**
   * Extract text from a PDF URL using multiple strategies
   */
  public async extractPdfContent(url: string, config: PdfExtractionConfig = {}): Promise<PdfExtractionResult> {
    const startTime = Date.now();

    // SSRF guard: block loopback / RFC1918 / link-local / cloud-metadata targets.
    await safeFetchUrl(url);

    try {
      // Try direct HTTP download first (fastest)
      const httpResult = await this.extractWithHttp(url, config);
      
      if (httpResult && httpResult.text.trim().length > 0) {
        telemetryCollector.recordContentExtraction(Date.now() - startTime);
        
        auditLogger.log({
          timestamp: new Date().toISOString(),
          level: 'info',
          event: 'content_extraction',
          tool: 'pdf-extractor',
          query: url,
          content_length: httpResult.text.length,
          metadata: {
            extraction_method: httpResult.extractionMethod,
            page_count: httpResult.pageCount,
            duration_ms: Date.now() - startTime,
          },
        });
        
        return httpResult;
      }

      // Fallback to browser-based extraction
      const browserResult = await this.extractWithBrowser(url, config);
      
      telemetryCollector.recordContentExtraction(Date.now() - startTime);
      
      auditLogger.log({
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'content_extraction',
        tool: 'pdf-extractor',
        query: url,
        content_length: browserResult.text.length,
        metadata: {
          extraction_method: browserResult.extractionMethod,
          page_count: browserResult.pageCount,
          duration_ms: Date.now() - startTime,
        },
      });
      
      return browserResult;
    } catch (error) {
      telemetryCollector.recordContentExtraction(Date.now() - startTime);
      
      auditLogger.logToolError(
        'pdf-extractor',
        -32603, // InternalError
        `Failed to extract PDF content: ${this.getErrorDetails(error)}`,
        'PdfExtraction'
      );
      
      throw new Error(`Failed to extract PDF from ${url}: ${this.getErrorDetails(error)}`);
    }
  }

  /**
   * Extract PDF using direct HTTP request with text extraction
   */
  private async extractWithHttp(url: string, config: PdfExtractionConfig = {}): Promise<PdfExtractionResult | null> {
    const timeout = config.timeout || this.defaultTimeout;

    try {
      // Use fetch to get the PDF as an ArrayBuffer
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WebSearchMCP/1.0)',
        },
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // Extract text using pdf-parse (cached dynamic import)
      const pdfParseFn = await getPdfParseFn();
      const data = await pdfParseFn(uint8Array);

      if (!data.text || data.text.trim().length === 0) {
        return null;
      }

      return {
        text: data.text,
        pageCount: data.numpages,
        fileSize: uint8Array.length,
        extractionMethod: 'http',
      };
    } catch (error) {
      console.error(`[PdfExtractor] HTTP extraction failed for ${url}:`, error);
      return null;
    }
  }

  /**
   * Extract PDF content using browser rendering
   */
  private async extractWithBrowser(url: string, config: PdfExtractionConfig = {}): Promise<PdfExtractionResult> {
    const timeout = config.timeout || this.defaultTimeout;

    // Use getBrowserWithContextPool internally which returns a Browser
    const browser = await browserPool.getBrowser();
    const page = await browser.newPage();

    try {
      // Navigate to the PDF URL
      await page.goto(url, { waitUntil: 'networkidle', timeout });

      // Wait for PDF to load
      await page.waitForSelector('body', { timeout });

      // Extract text content from the page
      const textContent = await page.evaluate(() => {
        return document.body.innerText || '';
      });

      return {
        text: textContent,
        extractionMethod: 'browser',
      };
    } finally {
      // Only close the page, NOT the entire browser pool
      await page.close();
    }
  }

  /**
   * Get detailed error information
   */
  private getErrorDetails(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  /**
   * Check if a URL is a PDF file
   */
  public static isPdfUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return (
      lowerUrl.endsWith('.pdf') ||
      lowerUrl.includes('.pdf?') ||
      lowerUrl.includes('.pdf#')
    );
  }

  /**
   * Truncate text to maximum length
   */
  public truncateText(text: string, maxLength?: number): string {
    if (!maxLength || maxLength <= 0) {
      return text;
    }
    
    if (text.length <= maxLength) {
      return text;
    }
    
    return text.substring(0, maxLength) + '\n\n[Content truncated]';
  }
}

// ============================================================================
// Global Instance
// ============================================================================

/**
 * Default PDF extractor instance
 */
export const pdfExtractor = new PdfExtractor();