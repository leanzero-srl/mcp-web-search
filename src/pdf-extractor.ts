/**
 * MCP Web Search - PDF Extractor Module
 *
 * Provides high-fidelity PDF content extraction using multiple strategies:
 * - Direct HTTP download with pdf-parse text extraction
 * - Browser-based rendering for complex PDFs
 * - Fallback mechanisms for unreliable sources
 */

import axios from 'axios';
import { browserPool } from './browser-pool.js';
import { auditLogger, telemetryCollector } from './observability.js';
import { safeFetchUrl, getAxiosHttpAgentConfig, SSRF_BLOCK_MARKER } from './utils.js';

// pdf-parse v2 exposes a `PDFParse` CLASS (not a default function as in v1).
// Usage: `new PDFParse({ data: bytes }).getText()` -> { pages, text, total }.
// Cache the class to avoid repeated dynamic imports.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedPDFParse: any = null;
async function getPDFParseClass(): Promise<any> {
  if (!cachedPDFParse) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('pdf-parse');
    cachedPDFParse = mod.PDFParse || (mod.default && mod.default.PDFParse);
    if (typeof cachedPDFParse !== 'function') {
      throw new Error('pdf-parse: PDFParse class not found in module exports');
    }
  }
  return cachedPDFParse;
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
      // Download via the SSRF-guarded axios agents (NOT global fetch/undici,
      // which ignores our agents and follows redirects — a redirect from a
      // public URL to http://127.0.0.1:PORT would otherwise be fetched).
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout,
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024,
        validateStatus: (status: number) => status < 400,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WebSearchMCP/1.0)',
        },
        ...getAxiosHttpAgentConfig(),
      });

      const uint8Array = new Uint8Array(response.data);
      // Read the size BEFORE parsing: pdf-parse v2 hands the buffer to pdf.js,
      // which transfers (detaches) it, so uint8Array.length reads 0 afterwards
      // and every response said "File Size: 0 bytes".
      const fileSize = uint8Array.length;

      // Extract text using pdf-parse v2 (PDFParse class).
      const PDFParse = await getPDFParseClass();
      const parser = new PDFParse({ data: uint8Array });
      let data;
      try {
        data = await parser.getText();
      } finally {
        try { await parser.destroy?.(); } catch { /* best-effort cleanup */ }
      }

      if (!data.text || data.text.trim().length === 0) {
        return null;
      }

      return {
        text: data.text,
        pageCount: data.total,
        fileSize,
        extractionMethod: 'http',
      };
    } catch (error) {
      // An SSRF refusal (initial URL or a redirect hop to a private address)
      // must NOT degrade into a browser fetch of the same URL — the headless
      // browser follows server redirects we cannot intercept. Re-throw so the
      // caller aborts instead of falling back.
      if (error instanceof Error && error.message.includes(SSRF_BLOCK_MARKER)) {
        throw error;
      }
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
   * Truncate text to a maximum length.
   *
   * Semantics: `undefined`, `0`, and negative `maxLength` all mean "no limit"
   * and return the text unchanged. This matches the tool layer, which maps a
   * caller-supplied `maxContentLength` of 0 to "no truncation". Only a positive
   * `maxLength` shorter than the text actually truncates (with a marker).
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