// Static guard for asset."isFavorite" (#763). The column is the OWNER's favorite, projected from the
// `asset_favorite` overlay by the triggers in src/schema/functions.ts; the overlay is the only thing Gallery
// writes. So no source file may write the column, and raw reads of it are allowed only where the query is
// pinned to the owner it projects for (listed below). Everything else resolves the caller's own favorite
// with favoriteExistsFor. A bare `isFavorite` string is not matched: it is indistinguishable from the many
// other `isFavorite` names (DTO fields, person.isFavorite, `.as('isFavorite')` aliases).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = process.cwd();
const SRC_DIR = join(SERVER_ROOT, 'src');

const RAW_COLUMN_PATTERNS = [/'asset\.isFavorite'/g, /"asset\.isFavorite"/g, /asset\."isFavorite"/g];

// file -> how many raw references it may hold, and why each is owner-scoped.
const OWNER_SCOPED_READS: Record<string, { count: number; reason: string }> = {
  'src/database.ts': {
    count: 3,
    reason:
      'columns.syncAsset (AssetSync streams only ownerId = the syncing user) and columns.workflowAssetV1 (listed twice, as upstream; workflow jobs act as the owner)',
  },
  'src/schema/functions.ts': { count: 2, reason: 'the forward projection trigger bodies' },
  'src/utils/database.ts': {
    count: 1,
    reason:
      "search V3's upstream default when AssetSearchScope.favoriteUserId is unset; Gallery always sets it for users and rejects a favourite filter from a shared link",
  },
};

const collectTsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectTsFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

// Specs may seed the column like a stock server would; migrations keep their historical bodies.
const sources = collectTsFiles(SRC_DIR)
  .map((path) => ({ path: relative(SERVER_ROOT, path).replaceAll('\\', '/'), content: readFileSync(path, 'utf8') }))
  .filter(({ path }) => !path.endsWith('.spec.ts') && !/\/schema\/migrations[^/]*\//.test(path));

const withoutComments = (content: string) =>
  content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');

const ASSET_WRITE_METHODS = new Set(['create', 'createAll', 'update', 'updateAll', 'upsert']);

/** `isFavorite` keys inside an asset write: an AssetRepository write or a Kysely asset INSERT/UPDATE. */
const findColumnWrites = (path: string, content: string) => {
  const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];
  const isAssetWrite = (node: ts.Node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }
    const method = node.expression.name.text;
    const receiver = node.expression.expression.getText(file);
    if (ASSET_WRITE_METHODS.has(method) && receiver.endsWith('assetRepository')) {
      return true;
    }
    return (method === 'set' || method === 'values') && /(updateTable|insertInto)\(\s*'asset'\s*\)/.test(receiver);
  };
  const visit = (node: ts.Node, inWrite: boolean) => {
    const write = inWrite || isAssetWrite(node);
    if (
      write &&
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      node.name.getText(file) === 'isFavorite'
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      offenders.push(`${path}:${line + 1}: ${node.getText(file)}`);
    }
    ts.forEachChild(node, (child) => visit(child, write));
  };
  visit(file, false);
  return offenders;
};

describe('asset.isFavorite gate (#763)', () => {
  it('reads the raw column only in the owner-scoped places listed here', () => {
    const counts: Record<string, number> = {};
    for (const { path, content } of sources) {
      const text = withoutComments(content);
      const count = RAW_COLUMN_PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
      if (count > 0) {
        counts[path] = count;
      }
    }
    const allowed = Object.fromEntries(Object.entries(OWNER_SCOPED_READS).map(([path, { count }]) => [path, count]));
    expect(counts).toEqual(allowed);
  });

  it('never writes the column from application code', () => {
    expect(sources.flatMap(({ path, content }) => findColumnWrites(path, content))).toEqual([]);
    // Raw SQL: only the forward projection triggers set the column.
    const rawWriters = sources.filter(({ content }) => /SET\s+"isFavorite"/.test(withoutComments(content)));
    expect(rawWriters.map(({ path }) => path)).toEqual(['src/schema/functions.ts']);
  });

  it('maps responses from the caller-resolved favorite, never the owner projection', () => {
    const mapper = readFileSync(join(SRC_DIR, 'dtos/asset-response.dto.ts'), 'utf8');
    expect(withoutComments(mapper)).not.toMatch(/entity\.isFavorite\b(?!ForUser)/);
  });

  it('detects an isFavorite key passed to an asset write', () => {
    const sample = [
      `await this.assetRepository.updateAll(ids, { isFavorite: true });`,
      `await this.assetRepository.update({ id, isFavorite });`,
      `await db.updateTable('asset').set({ isFavorite: false }).execute();`,
      `await db.insertInto('asset').values({ ...asset, isFavorite: true }).execute();`,
      `await this.assetRepository.updateAll(ids, { visibility });`,
      `await this.personRepository.update({ id, isFavorite: true });`,
    ].join('\n');
    expect(findColumnWrites('sample.ts', sample)).toHaveLength(4);
  });
});
