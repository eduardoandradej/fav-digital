// Gera o diretório SINTÉTICO usado pelo provedor simulado (dev/test). Nenhum dado real.
// Uso: node seed/gerar-diretorio.mjs > seed/diretorio-sintetico.json
import { createHash, scryptSync } from 'node:crypto';

const SENHA = 'Sintetica#2026';
const GRUPO = 'CN=FAV-Servidores-PCERJ,OU=Grupos,DC=sintetico,DC=invalid';
const guid = (s) => {
  const h = createHash('sha256').update('guid:' + s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const hash = (login) => {
  const salt = createHash('sha256').update('salt:' + login).digest('hex').slice(0, 16);
  return ['scrypt', salt, scryptSync(SENHA, salt, 32).toString('hex')].join('$');
};
const conta = (login, nome, unidade, cargo, extra = {}) => ({
  guid: guid(extra.guidSeed ?? login), login, functionalId: login, displayName: nome, unitCode: unidade, jobTitle: cargo,
  memberOf: extra.elegivel === false ? [] : [GRUPO], disabled: !!extra.disabled, passwordHash: hash(login),
  ...(extra.foraDoEscopo ? { foraDoEscopo: true } : {}),
});

const accounts = [
  conta('1000001', 'Ana Souza (sintética)', 'DP-001', 'Inspetora de Polícia'),
  conta('1000002', 'Bruno Lima (sintético)', 'DP-001', 'Oficial de Cartório'),
  conta('1000003', 'Carla Mendes (sintética)', 'ICCE', 'Perita Criminal'),
  conta('1000004', 'Diego Rocha (sintético)', 'CCV', 'Inspetor de Polícia'),
  conta('1000005', 'Elisa Prado (sintética)', 'DP-001', 'Delegada de Polícia'),
  conta('1000006', 'Fábio Nunes (sintético, sem vínculo elegível)', 'DP-001', 'Colaborador', { elegivel: false }),
  conta('1000007', 'Gabriel Torres (sintético)', 'DGTIT', 'Analista de TI'),
  conta('1000008', 'Helena Dias (sintética)', 'ICCE', 'Perita Criminal'),
  conta('1000009', 'Ivo Campos (sintético, desativado)', 'DP-002', 'Inspetor de Polícia', { disabled: true }),
  conta('0000010', 'Joana Zero (sintética)', 'DP-002', 'Inspetora de Polícia'),
  conta('1000011', 'Kátia Fora (sintética, fora do escopo)', 'EXTERNO', 'Terceirizada', { foraDoEscopo: true }),
  conta('1000012', 'Lucas Alves (sintético)', 'CCV', 'Oficial de Cartório'),
];

console.log(JSON.stringify({
  aviso: 'DIRETÓRIO SINTÉTICO — somente desenvolvimento/teste. Senha de todas as contas: ' + SENHA,
  grupoElegivel: GRUPO,
  accounts,
}, null, 2));
