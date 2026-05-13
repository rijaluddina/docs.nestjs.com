import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { executeVfsCommand } from './vfs-executor.mjs';

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'nestjs-docs-vfs-'));
  const contentDir = join(rootDir, 'content');

  await mkdir(join(contentDir, 'recipes'), { recursive: true });
  await writeFile(join(contentDir, 'recipes', 'passport.md'), 'AuthGuard\nJwtStrategy\npassport-jwt\n');

  return contentDir;
}

describe('NestJS docs VFS executor', () => {
  it('returns structured output for allowed commands', async () => {
    const contentDir = await createFixture();

    await expect(
      executeVfsCommand('rg -n "AuthGuard|JwtStrategy|passport-jwt" recipes | head -20', contentDir),
    ).resolves.toMatchObject({
      exit: 0,
      stderr: '',
    });
  });

  it('preserves pipe characters inside quoted regexes', async () => {
    const contentDir = await createFixture();

    const result = await executeVfsCommand(
      'rg -n "AuthGuard|JwtStrategy|passport-jwt" recipes | head -20',
      contentDir,
    );

    expect(result.stdout).toContain('recipes/passport.md:1:AuthGuard');
  });

  it('tree shows correct indentation for subdirectories', async () => {
    const contentDir = await createFixture();
    const result = await executeVfsCommand('tree recipes', contentDir);
    expect(result.stdout).toContain('recipes\n└── passport.md');
  });

  it('find supports -size filtering', async () => {
    const contentDir = await createFixture();
    await writeFile(join(contentDir, 'large.txt'), 'A'.repeat(1024));
    
    const result = await executeVfsCommand('find . -size +500c', contentDir);
    expect(result.stdout).toContain('./large.txt');
    expect(result.stdout).not.toContain('./recipes/passport.md');
  });

  it('find supports -newer comparison', async () => {
    const contentDir = await createFixture();
    const { utimes } = await import('node:fs/promises');
    
    await writeFile(join(contentDir, 'ref.txt'), 'reference');
    await writeFile(join(contentDir, 'new.txt'), 'new');
    
    const now = Date.now();
    await utimes(join(contentDir, 'ref.txt'), new Date(now - 10000), new Date(now - 10000));
    await utimes(join(contentDir, 'new.txt'), new Date(now), new Date(now));
    
    const result = await executeVfsCommand('find . -newer ref.txt', contentDir);
    expect(result.stdout).toContain('./new.txt');
    expect(result.stdout).not.toContain('./ref.txt');
  });

  it('find supports -maxdepth filtering', async () => {
    const contentDir = await createFixture();
    await mkdir(join(contentDir, 'a', 'b'), { recursive: true });
    await writeFile(join(contentDir, 'a', 'b', 'c.md'), 'test');
    
    const result = await executeVfsCommand('find . -maxdepth 1', contentDir);
    expect(result.stdout).toContain('./a');
    expect(result.stdout).not.toContain('./a/b');
    expect(result.stdout).not.toContain('./a/b/c.md');
  });
});
