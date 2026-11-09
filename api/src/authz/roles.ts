export const ROLES = ['ORIGEM_COLETA', 'REGISTRO_UNIDADE', 'CUSTODIA', 'PERICIA', 'ENCERRAMENTO', 'AUDITOR', 'ADMIN_CONFIG'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ORIGEM_COLETA: 'Origem/coleta',
  REGISTRO_UNIDADE: 'Registro na unidade',
  CUSTODIA: 'Custódia/recebimento',
  PERICIA: 'Perícia',
  ENCERRAMENTO: 'Encerramento',
  AUDITOR: 'Auditoria (leitura)',
  ADMIN_CONFIG: 'Administração de configuração',
};

/** Papéis que permitem preencher a FAV (exigem vínculo elegível como servidor da PCERJ). */
export const FILLER_ROLES: Role[] = ['ORIGEM_COLETA', 'REGISTRO_UNIDADE', 'CUSTODIA', 'PERICIA', 'ENCERRAMENTO'];
/** Papéis que dão leitura de fichas das unidades em que estão atribuídos. */
export const READER_ROLES: Role[] = [...FILLER_ROLES, 'AUDITOR'];

export interface Actor {
  identityId: string;
  login: string;
  functionalId: string;
  displayName: string;
  jobTitle: string | null;
  eligible: boolean;
  unitId: string | null;
  unitCode: string | null;
  unitName: string | null;
  roles: Role[];                     // papéis no contexto de unidade selecionado
  assignments: { role: Role; unitId: string; unitCode: string; unitName: string }[];
  sessionHash: Buffer;
  csrf: string;
  directoryFresh: boolean;
  correlationId: string;
}
