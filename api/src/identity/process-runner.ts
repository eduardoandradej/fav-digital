/**
 * Execução controlada de ferramentas MIT Kerberos/OpenLDAP: argumentos fixos, sem shell,
 * segredo apenas por stdin, limite de tempo e de saída, processo encerrado no timeout.
 */
import { spawn } from 'node:child_process';

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }

export function runFixed(
  file: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; maxOutputBytes: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    // Grupo de processos próprio: no timeout, encerra também eventuais processos filhos.
    const child = spawn(file, args, { shell: false, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });
    const killAll = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const cap = (cur: Buffer, chunk: Buffer) => {
      if (cur.length + chunk.length > opts.maxOutputBytes) {
        truncated = true;
        killAll();
        return Buffer.concat([cur, chunk.subarray(0, Math.max(0, opts.maxOutputBytes - cur.length))]);
      }
      return Buffer.concat([cur, chunk]);
    };
    child.stdout.on('data', (c: Buffer) => { out = cap(out, c); });
    child.stderr.on('data', (c: Buffer) => { err = cap(err, c); });
    const timer = setTimeout(() => { timedOut = true; killAll(); }, opts.timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.toString('utf8'), stderr: err.toString('utf8'), timedOut, truncated });
    };
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => undefined);
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}
