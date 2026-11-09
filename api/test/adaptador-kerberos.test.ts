/**
 * Adaptador Kerberos/GSSAPI com executáveis FALSOS (sem rede institucional): argumentos fixos, senha só por stdin,
 * cache exclusivo por tentativa e removido em falha, timeout, concorrência, LDIF/GUID e escape RFC 4515.
 * A validação real (KDC/DC) é feita em homologação — ver docs/homologacao.md.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { KerberosLdapProvider } from '../src/identity/kerberos-ldap.provider.js';
import { escapeLdapFilterValue, guidFromBytes, parseLdif } from '../src/identity/directory.js';

let dir: string;
let ccDir: string;
const GUID_BYTES = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

async function script(name: string, body: string) {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

function provider(kinit: string, ldap: string, timeoutMs = 3000) {
  Object.assign(process.env, { FAV_PROFILE: 'test', AUTH_PROVIDER: 'kerberos-ldap' });
  const cfg = loadConfig();
  cfg.auth.kerberos = { ...cfg.auth.kerberos, kinitPath: kinit, ldapsearchPath: ldap, ccacheDir: ccDir, timeoutMs, realm: 'SINTETICO.INVALID' };
  return new KerberosLdapProvider(cfg.auth);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fav-krb-'));
  ccDir = join(dir, 'cc');
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe('adaptador Kerberos/LDAP', () => {
  test('fluxo de sucesso: senha por stdin, argumentos fixos, GSSAPI com minssf, cache removido', async () => {
    const log = join(dir, 'log-ok');
    const kinit = await script('kinit-ok', `read pw; echo "ARGS:$*" >> ${log}; echo "PW:$pw" >> ${log}; echo "CC:$KRB5CCNAME" >> ${log}; : > "\${KRB5CCNAME#FILE:}"; exit 0`);
    const b64 = GUID_BYTES.toString('base64');
    const ldap = await script('ldap-ok', `echo "LARGS:$*" >> ${log}; printf 'dn: CN=Ana,OU=U,DC=s\\nobjectGUID:: ${b64}\\nsAMAccountName: 1000001\\ndisplayName: Ana\\ndepartment: DP-001\\ntitle: Inspetora\\nmemberOf: CN=G\\nuserAccountControl: 512\\n\\n'`);
    const r = await provider(kinit, ldap).authenticate('1000001', 'segredo do teste');
    assert.equal(r.outcome, 'success');
    if (r.outcome === 'success') {
      assert.equal(r.entry.guid, '33221100-5544-7766-8899-aabbccddeeff');
      assert.equal(r.entry.unitCode, 'DP-001');
    }
    const l = await readFile(log, 'utf8');
    assert.match(l, /ARGS:-c FILE:.+ 1000001@SINTETICO\.INVALID/);
    assert.match(l, /PW:segredo do teste/, 'senha chega somente por stdin');
    assert.doesNotMatch(l.split('\n').filter((x) => x.startsWith('ARGS') || x.startsWith('LARGS')).join(), /segredo/, 'senha nunca em argumentos');
    assert.match(l, /LARGS:.*-Y GSSAPI -O minssf=128 .*\(sAMAccountName=1000001\)/);
    assert.deepEqual(await readdir(ccDir), [], 'cache de tickets eliminado');
  });

  test('rejeição do KDC é "rejected"; KDC inacessível é "unavailable"; cache removido em falha', async () => {
    const bad = await script('kinit-bad', `read pw; echo "kinit: Preauthentication failed while getting initial credentials" >&2; exit 1`);
    const down = await script('kinit-down', `read pw; echo "kinit: Cannot contact any KDC for realm" >&2; exit 1`);
    const ldap = await script('ldap-never', 'exit 99');
    assert.equal((await provider(bad, ldap).authenticate('1000001', 'x')).outcome, 'rejected');
    const r = await provider(down, ldap).authenticate('1000001', 'x');
    assert.equal(r.outcome, 'unavailable');
    if (r.outcome === 'unavailable') assert.doesNotMatch(r.diagnostic, /KDC for realm/, 'diagnóstico sanitizado');
    assert.deepEqual(await readdir(ccDir), []);
  });

  test('timeout encerra o processo e é tratado como indisponibilidade', async () => {
    const slow = await script('kinit-slow', 'sleep 5');
    const t0 = Date.now();
    const r = await provider(slow, slow, 300).authenticate('1000001', 'x');
    assert.equal(r.outcome, 'unavailable');
    assert.ok(Date.now() - t0 < 2500);
  });

  test('nenhuma ou mais de uma entrada no LDAP é rejeitada (correspondência única)', async () => {
    const kinit = await script('kinit-ok2', 'read pw; exit 0');
    const none = await script('ldap-none', 'exit 0');
    const b64 = GUID_BYTES.toString('base64');
    const two = await script('ldap-two', `printf 'dn: a\\nobjectGUID:: ${b64}\\nsAMAccountName: 1000001\\ndisplayName: A\\n\\ndn: b\\nobjectGUID:: ${b64}\\nsAMAccountName: 1000001\\ndisplayName: B\\n\\n'`);
    assert.deepEqual(await provider(kinit, none).authenticate('1000001', 'x'), { outcome: 'rejected', reason: 'nao_encontrado' });
    assert.deepEqual(await provider(kinit, two).authenticate('1000001', 'x'), { outcome: 'rejected', reason: 'ambiguo' });
  });

  test('tentativas concorrentes usam caches exclusivos', async () => {
    const log = join(dir, 'log-cc');
    const kinit = await script('kinit-cc', `read pw; echo "$KRB5CCNAME" >> ${log}; sleep 0.2; exit 1`);
    await Promise.all(Array.from({ length: 6 }, () => provider(kinit, kinit).authenticate('1000001', 'x')));
    const caches = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(new Set(caches).size, 6);
    assert.deepEqual(await readdir(ccDir), []);
  });

  test('perfil institucional recusa provedor simulado e cookie inseguro', () => {
    Object.assign(process.env, { FAV_PROFILE: 'homologacao', AUTH_PROVIDER: 'simulated' });
    assert.throws(() => loadConfig(), /provedor simulado recusado/);
    Object.assign(process.env, { AUTH_PROVIDER: 'kerberos-ldap', SESSION_COOKIE_SECURE: 'false' });
    assert.throws(() => loadConfig(), /SESSION_COOKIE_SECURE/);
    Object.assign(process.env, { FAV_PROFILE: 'test', AUTH_PROVIDER: 'simulated', SESSION_COOKIE_SECURE: '' });
  });
});

describe('utilitários LDAP', () => {
  test('escape RFC 4515 contra injeção no filtro', () => {
    assert.equal(escapeLdapFilterValue('a*)(uid=*'), 'a\\2a\\29\\28uid=\\2a');
    assert.equal(escapeLdapFilterValue('x\\y\u0000'), 'x\\5cy\\00');
  });
  test('objectGUID binário → forma canônica', () => {
    assert.equal(guidFromBytes(GUID_BYTES), '33221100-5544-7766-8899-aabbccddeeff');
  });
  test('LDIF com linhas continuadas e base64', () => {
    const r = parseLdif('dn: CN=x\ndisplayName:: ' + Buffer.from('João').toString('base64') + '\ndescription: linha\n  continuada\n');
    assert.equal(r[0]['displayname'][0].toString(), 'João');
    assert.equal(r[0]['description'][0].toString(), 'linha continuada');
  });
});
