const TZ = 'America/Sao_Paulo';
export function dataHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}
/** Converte ISO (UTC) para o valor de <input type="datetime-local"> no fuso de apresentação. */
export function toLocalInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`;
}
/** Valor de datetime-local (horário de Brasília) → ISO com offset. America/Sao_Paulo não adota horário de verão desde 2019. */
export function fromLocalInput(v: string): string { return `${v}:00-03:00`; }

export const STATUS: Record<string, string> = {
  rascunho: 'Rascunho', sob_custodia: 'Sob custódia', em_transito: 'Em trânsito', recebido_com_ocorrencia: 'Recebido com ocorrência',
  em_processamento: 'Em processamento', armazenado: 'Armazenado', encerrado: 'Encerrado na SEPOL',
};
export const FISICO: Record<string, string> = {
  lacrado: 'Lacrado', aberto: 'Recipiente ABERTO', sem_lacre_grande_porte: 'Grande porte (etiquetado)', consumido_parcial: 'Consumido parcialmente', consumido_total: 'Consumido integralmente',
};
export const MOV_STATUS: Record<string, string> = {
  em_transito: 'Em trânsito', recebido: 'Recebido', recebido_com_ressalva: 'Recebido com ressalva', recusado: 'Recusado', cancelado: 'Cancelado',
};
