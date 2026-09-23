import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export type BenchmarkMetadata = { archived?: boolean; reason?: string; projectId?: string };
export function benchmarkMetadata(dir: string): BenchmarkMetadata {
  const path = join(dir, 'catalog.json');
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || (value.archived !== undefined && typeof value.archived !== 'boolean')) throw new Error('invalid_benchmark_catalog');
  return value;
}
export function benchmarkCatalog(root: string) {
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => ({ capability: d.name, ...benchmarkMetadata(join(root,d.name)) })) : [];
}
