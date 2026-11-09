/** Inspeção simples de PDFs gerados pelo pdf-lib: descomprime streams e procura texto (hex WinAnsi). */
import { inflateSync } from 'node:zlib';

function streams(buf: Buffer): string {
  const raw = buf.toString('latin1');
  let out = raw;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try { out += inflateSync(buf.subarray(start, end)).toString('latin1'); } catch { /* não comprimido */ }
    re.lastIndex = end + 'endstream'.length;
  }
  return out;
}

export function pdfHasText(buf: Buffer, text: string): boolean {
  const s = streams(buf);
  const hex = Buffer.from(text, 'latin1').toString('hex').toUpperCase();
  return s.includes(hex) || s.includes(text) || s.toUpperCase().includes(hex);
}

export function pdfPages(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
}
