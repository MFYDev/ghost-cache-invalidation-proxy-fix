import fetch from 'node-fetch';
import type { MiddlewareConfig, InvalidationData } from './types.js';

export class WebhookManager {
  private cachePurgeTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceTime = 10000; // 10 seconds

  constructor(private readonly config: MiddlewareConfig) {}

  async debouncePurgeCache(pattern: string): Promise<void> {
    if (this.cachePurgeTimeout) {
      clearTimeout(this.cachePurgeTimeout);
    }
    
    this.cachePurgeTimeout = setTimeout(async () => {
      try {
        await this.triggerWebhook(pattern);
      } catch (error) {
        console.error('Failed to trigger webhook:', error);
      }
    }, this.debounceTime);
  }

  private async triggerWebhook(pattern: string): Promise<void> {
    const startTime = performance.now();
    
    try {
      const invalidationData = this.parseInvalidationPattern(pattern);
      await this.sendWebhookRequest(invalidationData);
      
      const endTime = performance.now();
      console.log(`✅ Webhook triggered successfully in ${(endTime - startTime).toFixed(0)}ms`);
    } catch (error) {
      console.error('❌ Webhook trigger failed:', error);
      throw error;
    }
  }

  private parseInvalidationPattern(pattern: string): InvalidationData {
    // Ghost uses the pattern "/$/" to indicate a full site purge
    // It also uses "/*" for full site purge
    const purgeAll = pattern === '/$/' || pattern === '/*';
    
    // For specific URLs, Ghost sends patterns like:
    // - "/post-permalink" - Single post
    // - "/, /page/*, /rss" - Multiple pages
    // - "/page/*" - Wildcard paths
    const urls = purgeAll
      ? [`${this.config.ghostPublicUrl}/*`] // Use public URL for purge all pattern
      : pattern.split(',').map(url => `${this.config.ghostPublicUrl}${url.trim()}`); // Prepend public URL to each path
    
    // From Ghost documentation, common patterns include:
    // - "/" - Home page
    // - "/page/*" - Paginated pages 
    // - "/rss" - RSS feed
    // - "/post-permalink" - Specific post URL
    
    return {
      urls,
      purgeAll,
      pattern,
      timestamp: new Date().toISOString()
    };
  }

  private async sendWebhookRequest(data: InvalidationData): Promise<void> {
    const { webhook } = this.config;
    
    // Process the body template
    const body = this.processTemplate(webhook.bodyTemplate, data);
    
    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.processHeaderTemplates(webhook.headers || {}, webhook.secret)
    };

    // Log details if debug mode is enabled
    if (this.config.debug) {
      console.log('🐛 [Webhook Debug] Sending request:');
      console.log(`   URL: ${webhook.url}`);
      console.log(`   Method: ${webhook.method}`);
      const headersString = JSON.stringify(headers, null, 2);
      console.log(`   Headers: ${headersString}`);
      console.log(`   Body: ${body}`);

      // Construct equivalent curl command for debugging
      let curlCommand = `curl --request ${webhook.method} \\\n     --url '${webhook.url}'`;
      for (const [key, value] of Object.entries(headers)) {
        curlCommand += ` \\\n     --header '${key}: ${value}'`;
      }
      if (body && webhook.method !== 'GET' && webhook.method !== 'HEAD') {
        // Escape single quotes in the body for the curl command
        const escapedBody = body.replace(/'/g, "'\\''");
        curlCommand += ` \\\n     --data '${escapedBody}'`;
      }
      console.log('🐛 [Webhook Debug] Equivalent curl command:');
      console.log(curlCommand);
    }

    // Retry logic
    for (let attempt = 1; attempt <= webhook.retryCount; attempt++) {
      try {
        const response = await fetch(webhook.url, {
          method: webhook.method,
          headers,
          body
        });

        if (!response.ok) {
          const errorText = await response.text();
          if (this.config.debug) {
            console.log(`🐛 [Webhook Debug] Received error response:`);
            console.log(`   Status: ${response.status} ${response.statusText}`);
            console.log(`   Headers: ${JSON.stringify(response.headers.raw(), null, 2)}`); // Log raw headers
            console.log(`   Body: ${errorText}`);
          }
          throw new Error(`HTTP error ${response.status}: ${errorText}`);
        }
        
        return; // Success
      } catch (error) {
        if (attempt === webhook.retryCount) {
          throw error; // Last attempt failed
        }
        
        console.warn(`Webhook attempt ${attempt} failed, retrying in ${webhook.retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, webhook.retryDelay));
      }
    }
  }

  private processTemplate(template: string, data: InvalidationData): string {
    return template
      .replace(/\${urls}/g, JSON.stringify(data.urls))
      .replace(/\${purgeAll}/g, JSON.stringify(data.purgeAll))
      .replace(/\${timestamp}/g, JSON.stringify(data.timestamp).replace(/^"|"$/g, ''))
      .replace(/\${pattern}/g, JSON.stringify(data.pattern));
  }

  private processHeaderTemplates(
    headers: Record<string, string>,
    secret?: string
  ): Record<string, string> {
    const processedHeaders: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(headers)) {
      processedHeaders[key] = value.replace(/\${secret}/g, secret || '');
    }
    
    return processedHeaders;
  }
} 