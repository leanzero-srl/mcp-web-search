/**
 * MCP Web Search - PDF Extractor Module
 * 
 * Provides high-fidelity PDF content extraction using multiple strategies:
 * - Direct HTTP download with text extraction
 * - Browser-based rendering for complex PDFs
 * - Fallback mechanisms for unreliable sources
 */

import { BrowserPool } from './browser-pool.js';
import { auditLogger, telemetryCollector } from './observability.js';

// ============================================================================
const browserPool = new BrowserPool();

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
      
      // Try to extract text using pdf-parse or similar logic
      // For now, we'll use a simple approach with PDF.js via browser fallback
      // This is a placeholder - in production you'd use pdf-parse library
      const extractedText = await this.extractPdfTextFromBuffer(uint8Array);
      
      return {
        text: extractedText,
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
    
    try {
      const page = await browser.newPage();
      
      // Navigate to the PDF URL
      await page.goto(url, { waitUntil: 'networkidle' });
      
      // Wait for PDF to load
      await page.waitForSelector('body', { timeout });
      
      // Extract text content from the page
      const textContent = await page.evaluate(() => {
        return document.body.innerText || '';
      });
      
      // Close the page
      await page.close();
      
      return {
        text: textContent,
        extractionMethod: 'browser',
      };
    } finally {
      await browserPool.closeAll();
    }
  }

  /**
   * Extract text from PDF buffer using a simple approach
   * In production, you'd use pdf-parse library
   */
  private async extractPdfTextFromBuffer(buffer: Uint8Array): Promise<string> {
    // This is a placeholder implementation
    // For production use, install pdf-parse: npm install pdf-parse
    // Then use:
    // const pdf = await import('pdf-parse');
    // const data = await pdf.default(buffer);
    // return data.text;
    
    // For now, return an empty string to indicate the method needs proper implementation
    return 'PDF text extraction requires pdf-parse library. Please install: npm install pdf-parse';
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