import { describe, expect, it } from 'vitest';
import { dataHora, fromLocalInput, toLocalInput } from './format';

describe('formatação de datas (America/Sao_Paulo)', () => {
  it('converte UTC para horário de Brasília e volta', () => {
    const iso = '2026-11-09T15:30:00.000Z';
    expect(toLocalInput(iso)).toBe('2026-11-09T12:30');
    expect(new Date(fromLocalInput('2026-11-09T12:30')).toISOString()).toBe(iso);
  });
  it('exibe travessão para ausência de dado', () => {
    expect(dataHora(null)).toBe('—');
  });
});
