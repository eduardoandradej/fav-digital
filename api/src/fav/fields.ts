/**
 * Catálogo de campos da FAV (Informações Gerais) — fonte única para validação, permissão por papel,
 * etapa de obrigatoriedade e rótulo exibido na tela/PDF. Ver docs/matriz-requisitos-fav.md.
 */
import { z } from 'zod';
import type { Role } from '../authz/roles.js';

export type Section = 'coleta' | 'vestigio' | 'pericia' | 'guarda';

export interface FieldDef {
  label: string;
  section: Section;
  roles: Role[];
  schema: z.ZodType;
  /** referência a validar no banco */
  ref?: 'identity' | 'intervener' | 'unit';
  /** regra documental de origem */
  rule: string;
}

const t = (max: number) => z.string().trim().min(1).max(max).nullable();
const COLETA_ROLES: Role[] = ['ORIGEM_COLETA', 'REGISTRO_UNIDADE'];
const VESTIGIO_ROLES: Role[] = ['REGISTRO_UNIDADE', 'ORIGEM_COLETA'];

export const NATUREZAS = ['criminal', 'medico_legal', 'papiloscopico', 'dna'] as const;

export const FAV_FIELDS: Record<string, FieldDef> = {
  coleta_responsavel_kind: { label: 'Responsável pela coleta — tipo', section: 'coleta', roles: COLETA_ROLES, schema: z.enum(['servidor', 'externo']).nullable(), rule: 'R-IG-01' },
  coleta_responsavel_identity_id: { label: 'Responsável pela coleta e acondicionamento (servidor)', section: 'coleta', roles: COLETA_ROLES, schema: z.uuid().nullable(), ref: 'identity', rule: 'R-IG-01' },
  coleta_responsavel_intervener_id: { label: 'Responsável pela coleta e acondicionamento (externo)', section: 'coleta', roles: COLETA_ROLES, schema: z.uuid().nullable(), ref: 'intervener', rule: 'R-IG-01' },
  coleta_data_hora: { label: 'Data/hora da coleta', section: 'coleta', roles: COLETA_ROLES, schema: z.iso.datetime({ offset: true }).nullable(), rule: 'R-IG-03' },
  coleta_endereco: { label: 'Endereço do local de crime', section: 'coleta', roles: COLETA_ROLES, schema: t(500), rule: 'R-IG-04' },
  coleta_geo_lat: { label: 'Geolocalização — latitude', section: 'coleta', roles: COLETA_ROLES, schema: z.number().min(-90).max(90).nullable(), rule: 'R-IG-04' },
  coleta_geo_lon: { label: 'Geolocalização — longitude', section: 'coleta', roles: COLETA_ROLES, schema: z.number().min(-180).max(180).nullable(), rule: 'R-IG-04' },
  vestigio_tipo: { label: 'Tipo do vestígio', section: 'coleta', roles: COLETA_ROLES, schema: t(200), rule: 'R-IG-05' },
  vestigio_descricao: { label: 'Descrição do vestígio', section: 'coleta', roles: COLETA_ROLES, schema: t(4000), rule: 'R-IG-05' },
  vestigio_localizacao: { label: 'Localização do vestígio no local de crime', section: 'coleta', roles: COLETA_ROLES, schema: t(1000), rule: 'R-IG-06' },
  preservacao_mesmo_coletor: { label: 'Preservação do local: mesmo da coleta', section: 'coleta', roles: COLETA_ROLES, schema: z.boolean().nullable(), rule: 'R-IG-07' },
  preservacao_kind: { label: 'Responsável pela preservação — tipo', section: 'coleta', roles: COLETA_ROLES, schema: z.enum(['servidor', 'externo']).nullable(), rule: 'R-IG-07' },
  preservacao_identity_id: { label: 'Responsável pela preservação (servidor)', section: 'coleta', roles: COLETA_ROLES, schema: z.uuid().nullable(), ref: 'identity', rule: 'R-IG-07' },
  preservacao_intervener_id: { label: 'Responsável pela preservação (externo)', section: 'coleta', roles: COLETA_ROLES, schema: z.uuid().nullable(), ref: 'intervener', rule: 'R-IG-07' },
  documentacao_pericial_ref: { label: 'Referência à documentação de reconhecimento/isolamento/fixação', section: 'coleta', roles: COLETA_ROLES, schema: t(500), rule: 'R-CPP-158B' },

  natureza_exame: { label: 'Natureza do exame', section: 'vestigio', roles: VESTIGIO_ROLES, schema: z.array(z.enum(NATUREZAS)).max(4).nullable(), rule: 'R-DV-01' },
  requisicao: { label: 'Nº da requisição', section: 'vestigio', roles: VESTIGIO_ROLES, schema: t(60), rule: 'R-DV-02' },
  procedimento: { label: 'Nº do procedimento', section: 'vestigio', roles: VESTIGIO_ROLES, schema: t(60), rule: 'R-DV-03' },
  unidade_pj_id: { label: 'Unidade de polícia judiciária', section: 'vestigio', roles: VESTIGIO_ROLES, schema: z.uuid().nullable(), ref: 'unit', rule: 'R-DV-04' },
  sco_primeiro_lacre_ref: { label: 'Referência do 1º lacre na observação do SCO (declaração do operador)', section: 'vestigio', roles: ['REGISTRO_UNIDADE'], schema: t(200), rule: 'R-INS-06' },
  sco_primeiro_lacre_conferido: { label: 'Conferência do 1º lacre no SCO (declaração do operador)', section: 'vestigio', roles: ['REGISTRO_UNIDADE'], schema: z.boolean().nullable(), rule: 'R-INS-06' },

  laudo_numero: { label: 'Nº do laudo', section: 'pericia', roles: ['PERICIA'], schema: t(60), rule: 'R-INS-07' },
  amostragem_classe: { label: 'Em caso de amostragem, esta FAV pertence a', section: 'pericia', roles: ['PERICIA'], schema: z.enum(['prova', 'contraprova', 'aliquota', 'contrapericia']).nullable(), rule: 'R-INS-08' },

  guarda_unidade_id: { label: 'Unidade administrativa de guarda da FAV', section: 'guarda', roles: ['ENCERRAMENTO', 'REGISTRO_UNIDADE'], schema: z.uuid().nullable(), ref: 'unit', rule: 'R-INS-20' },
  sco_anexacao_ref: { label: 'Protocolo/referência da anexação no SCO (Procedimento/CI)', section: 'guarda', roles: ['ENCERRAMENTO', 'REGISTRO_UNIDADE'], schema: t(200), rule: 'R-INS-20' },
};

/** Campo virtual: número do 1º lacre (entidade `seal`, ordinal 1). */
export const PRIMEIRO_LACRE = 'primeiro_lacre_numero';

export const SECTION_LABELS: Record<Section, string> = {
  coleta: 'Dados da Coleta e 1º Lacre',
  vestigio: 'Dados do Vestígio',
  pericia: 'Dados do Vestígio (exclusivo da perícia)',
  guarda: 'Guarda documental',
};
