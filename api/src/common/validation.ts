import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw badRequest('DADOS_INVALIDOS', 'Dados inválidos.', r.error.issues.map((i) => ({ campo: i.path.join('.'), problema: i.message })));
  }
  return r.data;
}

export const uuid = z.uuid();
export const text = (max = 500) => z.string().trim().min(1).max(max);
export const optText = (max = 500) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
export const isoDateTime = z.iso.datetime({ offset: true });
