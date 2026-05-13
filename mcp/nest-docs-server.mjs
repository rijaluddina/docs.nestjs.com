import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';

import {
  createDocsIndex,
  listMarkdownFiles,
  readDocFile,
  searchDocs,
  extractCodeExamples,
  getTopics,
  getRelatedDocs,
  getMigrationGuide,
  getVersionInfo,
} from './docs-index.mjs';
import { executeVfsCommand } from './vfs-executor.mjs';

const index = createDocsIndex();

let indexPromise = null;
function getIndex() {
  if (!indexPromise) {
    indexPromise = index.build().then(() => index);
  }
  return indexPromise;
}

function jsonText(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function text(value) {
  return {
    content: [
      {
        type: 'text',
        text: value,
      },
    ],
  };
}

async function createNestDocsMcpServer() {
  const server = new McpServer({
    name: 'nestjs-docs',
    version: '1.0.0',
  });

  const idx = await getIndex();

  server.registerResource(
    'nestjs-docs-index',
    'nestjs-docs://index',
    {
      title: 'NestJS Docs Index',
      description: 'List of available markdown files in the NestJS documentation.',
      mimeType: 'application/json',
    },
    async uri => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await listMarkdownFiles(idx), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    'list_docs',
    {
      title: 'List NestJS Docs',
      description: 'List markdown documentation files available in this repository.',
      inputSchema: {},
    },
    async () => jsonText(await listMarkdownFiles(idx)),
  );

  server.registerTool(
    'get_topics',
    {
      title: 'Get NestJS Topics',
      description: 'List all major topics (categories) and their associated documentation pages.',
      inputSchema: {},
    },
    async () => jsonText(await getTopics(idx)),
  );

  server.registerTool(
    'search_docs',
    {
      title: 'Search NestJS Docs',
      description: 'Search NestJS documentation markdown files by text. Supports category filtering.',
      inputSchema: {
        query: z.string().min(1).describe('Text to search for.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum number of matches.'),
        category: z.string().optional().describe('Filter by category (e.g., fundamentals, graphql, microservices, core).'),
      },
    },
    async ({ query, limit, category }) => jsonText(await searchDocs(idx, query, { limit, category })),
  );

  server.registerTool(
    'read_doc',
    {
      title: 'Read NestJS Doc',
      description: 'Read one NestJS documentation markdown file by path, for example content/controllers.md.',
      inputSchema: {
        path: z.string().min(1).describe('A content/**/*.md path returned by list_docs or search_docs.'),
      },
    },
    async ({ path }) => {
      try {
        const content = await readDocFile(idx, path);
        return text(content);
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error reading doc: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_related_docs',
    {
      title: 'Get Related NestJS Docs',
      description: 'Suggest related documentation pages based on a specific doc path.',
      inputSchema: {
        path: z.string().min(1).describe('The path of the current document (e.g., content/controllers.md).'),
        limit: z.number().int().min(1).max(10).optional().describe('Maximum number of suggestions.'),
      },
    },
    async ({ path, limit }) => {
      try {
        const related = await getRelatedDocs(idx, path, { limit });
        return jsonText(related);
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error getting related docs: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_migration_guide',
    {
      title: 'Get NestJS Migration Guide',
      description: 'Get the latest migration guide or a specific section from it.',
      inputSchema: {
        section: z.string().optional().describe('Filter by specific section title (e.g., "Express v5", "Fastify v5").'),
      },
    },
    async ({ section }) => {
      try {
        const guide = await getMigrationGuide(idx, { section });
        return text(guide);
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_version_info',
    {
      title: 'Get NestJS Version Info',
      description: 'Get information about the latest NestJS version and migration status.',
      inputSchema: {},
    },
    async () => {
      try {
        const info = await getVersionInfo(idx);
        return jsonText(info);
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'extract_code_examples',
    {
      title: 'Extract NestJS Code Examples',
      description: 'Extract and filter code snippets from documentation. Supports filtering by language (ts, js) and path.',
      inputSchema: {
        path: z.string().optional().describe('Filter by specific document path (e.g., content/controllers.md).'),
        language: z.enum(['typescript', 'javascript', 'ts', 'js']).optional().describe('Filter by code language.'),
      },
    },
    async ({ path, language }) => {
      // Normalize language input
      let lang = language;
      if (lang === 'ts') lang = 'typescript';
      if (lang === 'js') lang = 'javascript';

      try {
        const examples = await extractCodeExamples(idx, { path, language: lang });
        return jsonText(examples);
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error extracting code examples: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'query_docs_filesystem',
    {
      title: 'Query NestJS Docs Filesystem',
      description: 'Run read-only shell commands in the docs filesystem (root: content/). Supported: ls, stat, cat, head, tail, grep, rg, sed, awk, cut, sort, uniq, wc. Built-in: tree, find. Operators: ;, |, >, <, & are allowed. Each sub-command is validated. Output truncated to 5000 chars.',
      inputSchema: {
        command: z.string().min(1).describe('The command to run (e.g., "ls -R", "grep -r NestJS .").'),
      },
    },
    async ({ command }) => {
      try {
        const output = await executeVfsCommand(command, idx.contentDir);
        return jsonText(output);
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

export { createNestDocsMcpServer };
