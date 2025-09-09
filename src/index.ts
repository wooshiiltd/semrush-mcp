#!/usr/bin/env node

import { logger, logConfigStatus } from './config.js';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  Tool,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import chalk from 'chalk';
import { z } from 'zod';
import { semrushApi, SemrushApiError } from './semrush-api.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// Define the tools that our MCP server will expose
const TOOLS: Tool[] = [
  {
    name: 'semrush_domain_overview',
    description: 'Get domain overview data including organic/paid search traffic, keywords, and rankings',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain name to analyze (e.g., "example.com")',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'semrush_domain_organic_keywords',
    description: 'Get organic keywords for a specific domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain name to analyze (e.g., "example.com")',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of keywords to return',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'semrush_domain_paid_keywords',
    description: 'Get paid keywords for a specific domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain name to analyze (e.g., "example.com")',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of keywords to return',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'semrush_competitors',
    description: 'Get competitors for a specific domain in organic search',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain name to analyze (e.g., "example.com")',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of competitors to return',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'semrush_backlinks',
    description: 'Get backlinks for a specific domain or URL',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Domain or URL to analyze backlinks for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of backlinks to return',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'semrush_backlinks_domains',
    description: 'Get referring domains for a specific domain or URL',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Domain or URL to analyze referring domains for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of referring domains to return',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'semrush_keyword_overview',
    description: 'Get overview data for a specific keyword',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to analyze',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'semrush_related_keywords',
    description: 'Get related keywords for a specific keyword',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to find related terms for',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of related keywords to return',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'semrush_keyword_overview_single_db',
    description: 'Get detailed overview data for a keyword from a specific database (10 API units per line)',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to analyze',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
      },
      required: ['keyword', 'database'],
    },
  },
  {
    name: 'semrush_batch_keyword_overview',
    description: 'Analyze up to 100 keywords at once in a specific database (10 API units per line)',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Array of keywords to analyze (max 100)',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
      },
      required: ['keywords', 'database'],
    },
  },
  {
    name: 'semrush_keyword_organic_results',
    description: 'Get domains ranking in Google\'s top 100 for a keyword (10 API units per line)',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to analyze',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
      },
      required: ['keyword', 'database'],
    },
  },
  {
    name: 'semrush_keyword_paid_results',
    description: 'Get domains in Google\'s paid search results for a keyword (20 API units per line)',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to analyze',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
      },
      required: ['keyword', 'database'],
    },
  },
  {
    name: 'semrush_keyword_ads_history',
    description: 'Get domains that bid on a keyword in the last 12 months (100 API units per line)',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to analyze',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
      },
      required: ['keyword', 'database'],
    },
  },
  {
    name: 'semrush_broad_match_keywords',
    description: 'Get broad matches and alternate search queries for a keyword (20 API units per line)',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to analyze',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
      },
      required: ['keyword', 'database'],
    },
  },
  {
    name: 'semrush_phrase_questions',
    description: 'Get question-based keywords related to a term (40 API units per line)',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to analyze',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
      },
      required: ['keyword', 'database'],
    },
  },
  {
    name: 'semrush_keyword_difficulty',
    description: 'Get difficulty index for ranking in Google\'s top 10 (50 API units per line)',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Array of keywords to analyze (max 100)',
        },
        database: {
          type: 'string',
          description: 'Database to use (e.g., "us", "uk", "ca", etc.)',
        },
      },
      required: ['keywords', 'database'],
    },
  },
  {
    name: 'semrush_traffic_summary',
    description: 'Get traffic summary data for domains (requires .Trends API access)',
    inputSchema: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Array of domains to analyze traffic for',
        },
        country: {
          type: 'string',
          description: 'Country code (e.g., "us", "uk", "ca", etc.)',
        },
      },
      required: ['domains'],
    },
  },
  {
    name: 'semrush_traffic_sources',
    description: 'Get traffic sources data for a domain (requires .Trends API access)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain to analyze traffic sources for',
        },
        country: {
          type: 'string',
          description: 'Country code (e.g., "us", "uk", "ca", etc.)',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'semrush_api_units_balance',
    description: 'Check the remaining API units balance',
    inputSchema: {
      type: 'object',
      properties: {
        check: {
          type: 'boolean',
          description: 'Set to true to check the balance',
        },
      },
      required: ['check'],
    },
  },
];

// Input validation schemas
const DomainParams = z.object({
  domain: z.string(),
  database: z.string().optional().default('us'),
  limit: z.number().optional(),
});

const TargetParams = z.object({
  target: z.string(),
  limit: z.number().optional(),
});

const KeywordParams = z.object({
  keyword: z.string(),
  database: z.string().optional().default('us'),
  limit: z.number().optional(),
});

const TrafficDomainsParams = z.object({
  domains: z.array(z.string()),
  country: z.string().optional().default('us'),
});

const TrafficDomainParams = z.object({
  domain: z.string(),
  country: z.string().optional().default('us'),
});

const CheckParams = z.object({
  check: z.boolean(),
});

// Additional schemas for batch operations
const BatchKeywordParams = z.object({
  keywords: z.array(z.string()),
  database: z.string().optional().default('us'),
});

// Helper function to handle API errors consistently
const handleApiError = (error: unknown) => {
  if (error instanceof SemrushApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}. Status: ${error.status}`,
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Unexpected error: ${(error as Error).message || 'Unknown error'}`,
      },
    ],
  };
};

// Create the MCP server
const server = new Server(
  {
    name: "semrush-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},    // We support tools
      resources: {}, // We support resources 
      prompts: {}    // We support prompts
    },
  }
);

// Set up request handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments as Record<string, any>;
  
  logger.info(`Tool called: ${toolName}`);
  
  try {
    switch (toolName) {
      case 'semrush_domain_overview': {
        const { domain, database } = DomainParams.parse(args);
        const response = await semrushApi.getDomainOverview(domain, database);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_domain_organic_keywords': {
        const { domain, database, limit } = DomainParams.parse(args);
        const response = await semrushApi.getDomainOrganicKeywords(domain, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_domain_paid_keywords': {
        const { domain, database, limit } = DomainParams.parse(args);
        const response = await semrushApi.getDomainPaidKeywords(domain, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_competitors': {
        const { domain, database, limit } = DomainParams.parse(args);
        const response = await semrushApi.getCompetitorsInOrganic(domain, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_backlinks': {
        const { target, limit } = TargetParams.parse(args);
        const response = await semrushApi.getBacklinks(target, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_backlinks_domains': {
        const { target, limit } = TargetParams.parse(args);
        const response = await semrushApi.getBacklinksDomains(target, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_keyword_overview': {
        const { keyword, database } = KeywordParams.parse(args);
        const response = await semrushApi.getKeywordOverview(keyword, database);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_related_keywords': {
        const { keyword, database, limit } = KeywordParams.parse(args);
        const response = await semrushApi.getRelatedKeywords(keyword, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_keyword_overview_single_db': {
        const { keyword, database } = KeywordParams.parse(args);
        const response = await semrushApi.getKeywordOverviewSingleDb(keyword, database);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_batch_keyword_overview': {
        const { keywords, database } = BatchKeywordParams.parse(args);
        const response = await semrushApi.getBatchKeywordOverview(keywords, database);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_keyword_organic_results': {
        const { keyword, database, limit } = KeywordParams.parse(args);
        const response = await semrushApi.getKeywordOrganicResults(keyword, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_keyword_paid_results': {
        const { keyword, database, limit } = KeywordParams.parse(args);
        const response = await semrushApi.getKeywordPaidResults(keyword, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_keyword_ads_history': {
        const { keyword, database, limit } = KeywordParams.parse(args);
        const response = await semrushApi.getKeywordAdsHistory(keyword, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_broad_match_keywords': {
        const { keyword, database, limit } = KeywordParams.parse(args);
        const response = await semrushApi.getBroadMatchKeywords(keyword, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_phrase_questions': {
        const { keyword, database, limit } = KeywordParams.parse(args);
        const response = await semrushApi.getPhraseQuestions(keyword, database, limit);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_keyword_difficulty': {
        const { keywords, database } = BatchKeywordParams.parse(args);
        const response = await semrushApi.getKeywordDifficulty(keywords, database);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_traffic_summary': {
        const { domains, country } = TrafficDomainsParams.parse(args);
        const response = await semrushApi.getTrafficSummary(domains, country);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_traffic_sources': {
        const { domain, country } = TrafficDomainParams.parse(args);
        const response = await semrushApi.getTrafficSources(domain, country);
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      case 'semrush_api_units_balance': {
        CheckParams.parse(args);
        const response = await semrushApi.getApiUnitsBalance();
        return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true
        };
    }
  } catch (error) {
    logger.error(`Error while executing tool ${toolName}: ${(error as Error).message}`);
    return handleApiError(error);
  }
});

// Start the server
async function runServer() {
  try {
    logConfigStatus();
    logger.info(chalk.green('Starting Semrush MCP Server...'));

    const app = express();
    app.use(express.json());

    // Map to store transports by session ID
    const transports = {
      streamable: {} as Record<string, StreamableHTTPServerTransport>,
      sse: {} as Record<string, SSEServerTransport>
    };

    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.streamable[sessionId]) {
        // Reuse existing transport
        transport = transports.streamable[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            // Store the transport by session ID
            transports.streamable[sessionId] = transport;
          },
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports.streamable[transport.sessionId];
          }
        };
        const server = new McpServer({
          name: "example-server",
          version: "1.0.0"
        });

        // ... set up server resources, tools, and prompts ...

        // Connect to the MCP server
        await server.connect(transport);
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    });

    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports.streamable[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      
      const transport = transports.streamable[sessionId];
      await transport.handleRequest(req, res);
    };

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', handleSessionRequest);

    // Handle DELETE requests for session termination
    app.delete('/mcp', handleSessionRequest);

    // Legacy SSE endpoint for older clients
    app.get('/sse', async (req, res) => {
      // Create SSE transport for legacy clients
      const transport = new SSEServerTransport('/messages', res);
      transports.sse[transport.sessionId] = transport;
      
      res.on("close", () => {
        delete transports.sse[transport.sessionId];
      });
      
      await server.connect(transport);
    });
    
    // Legacy message endpoint for older clients
    app.post('/messages', async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports.sse[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send('No transport found for sessionId');
      }
    });

    app.listen(3000);
    
    logger.info(chalk.green('Semrush MCP Server is running and ready to process requests'));
  } catch (error) {
    logger.error(`Failed to start server: ${(error as Error).message}`);
    process.exit(1);
  }
}

runServer().catch((error) => {
  logger.error(`Unhandled error: ${error.message}`);
  process.exit(1);
}); 