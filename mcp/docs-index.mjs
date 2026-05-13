import { readFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import MiniSearch from 'minisearch';

const debounce = (fn, ms) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), ms);
  };
};

const getProjectRoot = () => {
  try {
    if (typeof import.meta?.url === 'string') {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      return resolve(__dirname, '..');
    }
  } catch (e) {
    // Ignore error and fallback
  }
  // Fallback for environments where import.meta.url is undefined (e.g. bundled CJS)
  // or if fileURLToPath fails.
  return process.cwd();
};

const PROJECT_ROOT = getProjectRoot();

export class DocsIndex {
  constructor({
    rootDir = PROJECT_ROOT,
    contentDir = join(PROJECT_ROOT, 'content'),
  } = {}) {
    this.rootDir = resolve(rootDir);
    this.contentDir = resolve(contentDir);
    this.files = []; // List of relative paths
    this.cache = new Map(); // path -> full content
    this.chunks = []; // Array of chunk objects { id, title, content, path, category }
    this.miniSearch = new MiniSearch({
      fields: ['title', 'content', 'category'], // fields to index for full-text search
      storeFields: ['title', 'content', 'path', 'category'], // fields to return with search results
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
    this.isReady = false;
    this.watcher = null;
    this.debouncedBuild = debounce(() => {
      console.error('File change detected, rebuilding index...');
      this.build().catch(err => console.error('Error rebuilding index:', err));
    }, 500);
  }

  async build() {
    const fullPaths = await this.collectMarkdownFiles(this.contentDir);
    this.files = fullPaths.map(file => relative(this.rootDir, file).split(sep).join('/'));

    const newCache = new Map();
    const newChunks = [];
    const newMiniSearch = new MiniSearch({
      fields: ['title', 'content', 'category'],
      storeFields: ['title', 'content', 'path', 'category'],
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });

    for (const file of this.files) {
      const fullPath = resolve(this.rootDir, file);
      const content = await readFile(fullPath, 'utf8');
      newCache.set(file, content);

      const fileChunks = this.chunkMarkdown(file, content, newChunks.length);
      newChunks.push(...fileChunks);
    }

    newMiniSearch.addAll(newChunks);

    this.cache = newCache;
    this.chunks = newChunks;
    this.miniSearch = newMiniSearch;
    this.isReady = true;

    if (!this.watcher) {
      try {
        this.watcher = watch(this.contentDir, { recursive: true }, (eventType, filename) => {
          if (filename && filename.endsWith('.md')) {
            this.debouncedBuild();
          }
        });
      } catch (err) {
        console.error('Failed to start file watcher:', err);
      }
    }

    console.error(`Index built with ${this.files.length} files and ${this.chunks.length} chunks.`);
  }

  async collectMarkdownFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async entry => {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          return this.collectMarkdownFiles(fullPath);
        }

        if (entry.isFile() && entry.name.endsWith('.md')) {
          return [fullPath];
        }

        return [];
      }),
    );

    return files.flat();
  }

  chunkMarkdown(path, text, startId = 0) {
    const fileTitle = this.titleFromMarkdown(path, text);
    // Determine category from path
    // content/fundamentals/pipes.md -> fundamentals
    // content/controllers.md -> core
    const pathParts = path.split('/');
    let category = 'core';
    if (pathParts.length > 2 && pathParts[0] === 'content') {
      category = pathParts[1];
    }

    // Split by ##, ###, or #### headers
    const sections = text.split(/^(?=(?:##|###|####)\s+)/m);
    const chunks = [];

    let currentId = startId;

    sections.forEach((section, index) => {
      const trimmedSection = section.trim();
      if (!trimmedSection) return;

      const lines = trimmedSection.split('\n');
      let title = fileTitle;

      // Check if this section starts with a header (##, ###, or ####)
      const headerMatch = lines[0].match(/^(?:##|###|####)\s+(.+)$/);
      if (headerMatch) {
        title = `${fileTitle} > ${headerMatch[1].trim()}`;
      }

      chunks.push({
        id: `chunk-${currentId++}`,
        title,
        content: trimmedSection,
        path,
        category,
      });
    });

    return chunks;
  }

  titleFromMarkdown(path, text) {
    const heading = text.match(/^#\s+(.+)$/m);

    if (heading) {
      return heading[1].trim();
    }

    return path
      .replace(/^content\//, '')
      .replace(/\.md$/, '')
      .split('/')
      .pop()
      .replace(/-/g, ' ');
  }

  async listMarkdownFiles() {
    if (!this.isReady) {
      await this.build();
    }
    return this.files.sort((a, b) => a.localeCompare(b));
  }

  async readDocFile(requestedPath) {
    if (this.cache.has(requestedPath)) {
      return this.cache.get(requestedPath);
    }
    // Fallback to disk if cache miss (though build() should have filled it)
    const fullPath = this.resolveContentMarkdownPath(requestedPath);
    const content = await readFile(fullPath, 'utf8');
    this.cache.set(requestedPath, content);
    return content;
  }

  resolveContentMarkdownPath(requestedPath) {
    const normalizedPath = normalize(requestedPath);
    const fullPath = resolve(this.rootDir, normalizedPath);
    const relativeToContent = relative(this.contentDir, fullPath);
    const insideContent =
      relativeToContent && !relativeToContent.startsWith('..') && !relativeToContent.startsWith(sep);

    if (!insideContent || !fullPath.endsWith('.md')) {
      throw new Error('Only content markdown files can be read');
    }

    return fullPath;
  }

  async searchDocs(query, { limit = 10, category: filterCategory } = {}) {
    if (!this.isReady) {
      await this.build();
    }

    const searchOptions = {
      fuzzy: 0.2,
      prefix: true,
      boost: { title: 2 },
    };

    if (filterCategory) {
      searchOptions.filter = (result) => result.category === filterCategory;
    }

    const results = this.miniSearch.search(query, searchOptions);
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);

    return results.slice(0, limit).map(result => {
      const rawContent = result.content ?? '';
      const snippet = this.extractSnippet(rawContent, queryTerms);
      return {
        path: result.path,
        title: result.title,
        category: result.category,
        score: result.score,
        snippet,
        url: `https://docs.nestjs.com/${result.path.replace(/^content\//, '').replace(/\.md$/, '')}`,
      };
    });
  }

  async extractCodeExamples({ path: requestedPath, language: filterLanguage } = {}) {
    if (!this.isReady) {
      await this.build();
    }

    let chunksToProcess = this.chunks;
    if (requestedPath) {
      chunksToProcess = this.chunks.filter(c => c.path === requestedPath);
    }

    const examples = [];
    const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/g;

    for (const chunk of chunksToProcess) {
      let match;
      while ((match = codeBlockRegex.exec(chunk.content)) !== null) {
        const language = match[1];
        const fullContent = match[2];
        const sections = fullContent.split('@@switch');
        
        let sharedFilename = null;
        const firstSectionFilenameMatch = sections[0].match(/^@@filename\(([^)]+)\)\n/);
        if (firstSectionFilenameMatch) {
          sharedFilename = firstSectionFilenameMatch[1];
        }

        sections.forEach((section, index) => {
          let filename = sharedFilename;
          let code = section.trim();
          
          if (index === 0 && sharedFilename) {
            code = code.replace(/^@@filename\(([^)]+)\)\n/, '').trim();
          } else {
            const sectionFilenameMatch = code.match(/^@@filename\(([^)]+)\)\n/);
            if (sectionFilenameMatch) {
              filename = sectionFilenameMatch[1];
              code = code.replace(/^@@filename\(([^)]+)\)\n/, '').trim();
            }
          }
          
          let finalLang = language;
          if (sections.length > 1) {
            if (index === 0) finalLang = 'typescript';
            if (index === 1) finalLang = 'javascript';
          }

          if (!filterLanguage || finalLang.toLowerCase() === filterLanguage.toLowerCase()) {
            examples.push({
              path: chunk.path,
              context: chunk.title,
              language: finalLang,
              filename,
              code,
            });
          }
        });
      }
    }

    return examples;
  }

  async getTopics() {
    if (!this.isReady) {
      await this.build();
    }

    const topics = {};
    for (const file of this.files) {
      const pathParts = file.split('/');
      let category = 'core';
      if (pathParts.length > 2 && pathParts[0] === 'content') {
        category = pathParts[1];
      }
      
      if (!topics[category]) {
        topics[category] = {
          category,
          files: [],
        };
      }
      
      topics[category].files.push({
        path: file,
        title: this.titleFromMarkdown(file, this.cache.get(file) || ''),
      });
    }

    return Object.values(topics).sort((a, b) => a.category.localeCompare(b.category));
  }

  async getRelatedDocs(path, { limit = 5 } = {}) {
    if (!this.isReady) {
      await this.build();
    }

    const content = this.cache.get(path);
    if (!content) {
      throw new Error(`Document not found: ${path}`);
    }

    const title = this.titleFromMarkdown(path, content);
    // Search for documents similar to the title, but exclude the current document
    const results = this.miniSearch.search(title, {
      boost: { title: 2 },
      filter: (result) => result.path !== path,
    });

    // Also include documents in the same category
    const pathParts = path.split('/');
    let category = 'core';
    if (pathParts.length > 2 && pathParts[0] === 'content') {
      category = pathParts[1];
    }

    const sameCategoryFiles = this.files
      .filter(f => f !== path)
      .filter(f => {
        const parts = f.split('/');
        let cat = 'core';
        if (parts.length > 2 && parts[0] === 'content') {
          cat = parts[1];
        }
        return cat === category;
      })
      .slice(0, 3); // Limit to 3 from same category

    const related = results.slice(0, limit).map(result => ({
      path: result.path,
      title: result.title,
      score: result.score,
      url: `https://docs.nestjs.com/${result.path.replace(/^content\//, '').replace(/\.md$/, '')}`,
    }));

    // Merge and deduplicate
    const seenPaths = new Set(related.map(r => r.path));
    for (const file of sameCategoryFiles) {
      if (!seenPaths.has(file)) {
        related.push({
          path: file,
          title: this.titleFromMarkdown(file, this.cache.get(file) || ''),
          url: `https://docs.nestjs.com/${file.replace(/^content\//, '').replace(/\.md$/, '')}`,
        });
        seenPaths.add(file);
      }
    }

    return related.slice(0, limit);
  }

  async getMigrationGuide({ section: sectionTitle } = {}) {
    if (!this.isReady) {
      await this.build();
    }

    const migrationDoc = 'content/migration.md';
    const content = this.cache.get(migrationDoc);
    if (!content) {
      throw new Error(`Migration guide not found: ${migrationDoc}`);
    }

    if (!sectionTitle) {
      return content;
    }

    // Split by headers and find the matching section
    const sections = content.split(/^(?=(?:###|####)\s+)/m);
    const matchingSection = sections.find(s => 
      s.toLowerCase().includes(sectionTitle.toLowerCase()) && 
      /^(?:###|####)\s+/.test(s)
    );

    return matchingSection || `Section "${sectionTitle}" not found in migration guide.`;
  }

  async getVersionInfo() {
    if (!this.isReady) {
      await this.build();
    }

    const migrationDoc = 'content/migration.md';
    const content = this.cache.get(migrationDoc);
    if (!content) {
      return { latestVersion: 'unknown', description: 'Migration guide not found.' };
    }

    // Try to extract version from the first paragraph
    // Example: "This article offers a comprehensive guide for migrating from NestJS version 10 to version 11."
    const versionMatch = content.match(/version\s+(\d+)\s+to\s+version\s+(\d+)/i);
    const latestVersion = versionMatch ? versionMatch[2] : 'unknown';
    const previousVersion = versionMatch ? versionMatch[1] : 'unknown';

    return {
      latestVersion,
      previousVersion,
      title: this.titleFromMarkdown(migrationDoc, content),
      summary: content.split('\n').filter(line => line.trim() && !line.startsWith('#')).slice(0, 3).join('\n'),
    };
  }

  extractSnippet(text, queryTerms) {
    const maxLen = 400;
    const textLower = text.toLowerCase();

    let bestIdx = -1;
    for (const term of queryTerms) {
      const idx = textLower.indexOf(term);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
      }
    }

    let start = 0;
    let end = Math.min(text.length, maxLen);

    if (bestIdx !== -1) {
      const contextStart = Math.max(0, bestIdx - 80);
      const contextEnd = Math.min(text.length, bestIdx + maxLen - 130);
      start = contextStart;
      end = contextEnd;

      if (start > 0) {
        const ws = text.indexOf(' ', start);
        if (ws !== -1 && ws < start + 20) start = ws + 1;
      }
      if (end < text.length) {
        const ws = text.lastIndexOf(' ', end);
        if (ws !== -1 && ws > end - 20) end = ws;
      }
    }

    let snippet = text.slice(start, end).replace(/\n+/g, ' ').trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';
    return snippet;
  }
}

// Factory function for backward compatibility with existing server.mjs
export function createDocsIndex(options) {
  return new DocsIndex(options);
}

export async function listMarkdownFiles(index) {
  return index.listMarkdownFiles();
}

export async function readDocFile(index, path) {
  return index.readDocFile(path);
}

export async function searchDocs(index, query, options) {
  return index.searchDocs(query, options);
}

export async function extractCodeExamples(index, options) {
  return index.extractCodeExamples(options);
}

export async function getTopics(index) {
  return index.getTopics();
}

export async function getRelatedDocs(index, path, options) {
  return index.getRelatedDocs(path, options);
}

export async function getMigrationGuide(index, options) {
  return index.getMigrationGuide(options);
}

export async function getVersionInfo(index) {
  return index.getVersionInfo();
}
