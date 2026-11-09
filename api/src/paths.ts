import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Localiza um arquivo/diretório do repositório subindo a partir do módulo compilado (dist/ ou dist-test/). */
export function findUp(rel: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, rel);
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  return join(process.cwd(), rel);
}
