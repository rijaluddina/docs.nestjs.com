import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createDocsIndex,
  listMarkdownFiles,
  readDocFile,
  searchDocs,
  extractCodeExamples,
  getTopics,
} from './docs-index.mjs';

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'nestjs-docs-mcp-'));
  const contentDir = join(rootDir, 'content');

  await mkdir(join(contentDir, 'fundamentals'), { recursive: true });
  await writeFile(
    join(contentDir, 'controllers.md'),
    '# Controllers\n\nControllers route incoming requests.\n\n```typescript\n@@filename(cats.controller)\nexport class CatsController {}\n@@switch\nexport class CatsController {}\n```',
  );
  await writeFile(
    join(contentDir, 'fundamentals', 'dependency-injection.md'),
    '# Dependency Injection\n\nProviders can be injected into classes.',
  );
  await writeFile(join(rootDir, 'README.md'), '# Not indexed');

  return createDocsIndex({ rootDir, contentDir });
}

describe('NestJS docs MCP index', () => {
  it('lists markdown files under content with relative paths', async () => {
    const index = await createFixture();

    await expect(listMarkdownFiles(index)).resolves.toEqual([
      'content/controllers.md',
      'content/fundamentals/dependency-injection.md',
    ]);
  });

  it('searches documentation case-insensitively', async () => {
    const index = await createFixture();

    await expect(searchDocs(index, 'PROVIDERS')).resolves.toEqual([
      expect.objectContaining({
        path: 'content/fundamentals/dependency-injection.md',
        title: 'Dependency Injection',
      }),
    ]);
  });

  it('reads only markdown files from content', async () => {
    const index = await createFixture();

    await expect(readDocFile(index, 'content/controllers.md')).resolves.toContain(
      'Controllers route incoming requests.',
    );
    await expect(readDocFile(index, 'README.md')).rejects.toThrow(
      'Only content markdown files can be read',
    );
  });

  it('filters search by category', async () => {
    const index = await createFixture();

    const results = await searchDocs(index, 'Controllers', { category: 'core' });
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('core');

    const emptyResults = await searchDocs(index, 'Controllers', { category: 'fundamentals' });
    expect(emptyResults).toHaveLength(0);
  });

  it('extracts code examples', async () => {
    const index = await createFixture();

    const examples = await extractCodeExamples(index, { path: 'content/controllers.md' });
    expect(examples).toHaveLength(2);
    expect(examples[0]).toEqual(expect.objectContaining({
      language: 'typescript',
      filename: 'cats.controller',
    }));
    expect(examples[1]).toEqual(expect.objectContaining({
      language: 'javascript',
    }));
  });

  it('gets topics hierarchy', async () => {
    const index = await createFixture();

    const topics = await getTopics(index);
    expect(topics).toHaveLength(2);
    expect(topics.map(t => t.category)).toEqual(['core', 'fundamentals']);
  });
});
