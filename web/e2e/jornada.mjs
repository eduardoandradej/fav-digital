// Jornada E2E no navegador (Playwright): login → 3 cards → abrir FAV → preencher → confirmar coleta → enviar;
// outra conta recebe. Uso: BASE=http://localhost:8080 node web/e2e/jornada.mjs [diretório-de-capturas]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // instalado globalmente ou via NODE_PATH
const BASE = process.env.BASE ?? 'http://localhost:8080';
const OUT = process.argv[2] ?? '.';
const SENHA = 'Sintetica#2026';
const browser = await chromium.launch();
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

async function login(id) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/login');
  await p.getByLabel('ID funcional').fill(id);
  await p.getByLabel('Senha institucional').fill(SENHA);
  await p.getByRole('button', { name: 'Entrar' }).click();
  await p.getByRole('heading', { name: /Olá/ }).waitFor();
  return p;
}
async function selectByText(loc, re) {
  const opts = await loc.locator('option').allTextContents();
  const i = opts.findIndex((t) => re.test(t));
  if (i < 0) throw new Error('opção não encontrada: ' + re);
  await loc.selectOption({ index: i });
}
const ok = (c, m) => { if (!c) throw new Error('FALHOU: ' + m); console.log('ok -', m); };

const ana = await login('1000001');
await ana.locator('.card').nth(2).waitFor();
ok(await ana.locator('.card').count() === 3, 'página inicial com três cards');
await shot(ana, '01-inicio');
await ana.goto(BASE + '/favs/nova');
await ana.getByRole('button', { name: 'Abrir rascunho' }).click();
await ana.getByRole('heading', { name: /rascunho RASC-/ }).waitFor();
await ana.getByRole('button', { name: 'Preencher' }).first().click();
const lacre = 'E2E' + Date.now().toString().slice(-6);
await ana.getByLabel(/Nº 1º lacre/).fill(lacre);
await ana.getByLabel('Responsável pela coleta — tipo').selectOption('servidor');
await ana.getByLabel(/Buscar servidor/).first().fill('1000001');
await ana.waitForTimeout(500);
await selectByText(ana.getByLabel('Responsável pela coleta e acondicionamento (servidor)'), /Ana Souza.*ID/);
await ana.getByLabel(/Data\/hora da coleta/).fill(new Date(Date.now() - 3 * 3600e3 - 3 * 3600e3).toISOString().slice(0, 16));
await ana.getByLabel('Endereço do local de crime').fill('Rua Sintética, 10');
await ana.getByLabel('Tipo do vestígio').fill('Projétil');
await ana.getByLabel('Descrição do vestígio').fill('Projétil deformado (sintético)');
await ana.getByLabel(/mesmo da coleta/).check();
await ana.getByRole('button', { name: 'Salvar' }).click();
await ana.getByText('Dados salvos').waitFor();
await ana.getByRole('button', { name: 'autoria' }).first().click();
await ana.locator('.autoria').first().waitFor();
ok(/Preenchido por/.test(await ana.locator('.autoria').first().innerText()), 'autoria por campo sob demanda');
await shot(ana, '02-ficha-rascunho');
await ana.getByRole('button', { name: 'Confirmar coleta' }).click();
await ana.getByRole('button', { name: 'Revisar resumo' }).click();
await ana.locator('.resumo').waitFor();
ok(/gerado/.test(await ana.locator('.resumo').innerText()), 'resumo do ato antes da confirmação');
await ana.getByRole('button', { name: 'Confirmar e registrar' }).click();
await ana.getByRole('heading', { name: new RegExp(`Nº FAV: ${lacre}/`) }).waitFor();
ok(true, 'coleta confirmada e nº gerado');
await ana.getByRole('button', { name: 'Registrar envio' }).click();
await ana.getByRole('dialog').waitFor();
await selectByText(ana.getByLabel('Unidade de destino'), /ICCE/);
await ana.getByLabel('Local de envio').fill('Cartório DP-001');
await ana.getByRole('button', { name: 'Revisar resumo' }).click();
await shot(ana, '03-resumo-envio');
await ana.getByRole('button', { name: 'Confirmar e registrar' }).click();
await ana.getByText(/EM TRÂNSITO/).waitFor();
ok(true, 'envio registrado — em trânsito');

const carla = await login('1000003');
await carla.getByRole('link', { name: /Encaminhamentos/ }).click();
await carla.getByRole('link', { name: 'Abrir ficha' }).first().click();
await carla.getByRole('button', { name: 'Confirmar recebimento' }).click();
await carla.getByRole('dialog').waitFor();
await carla.getByLabel('Local de entrega').fill('Recepção ICCE');
await carla.getByLabel(/lacre observado/).fill(lacre);
await carla.getByRole('button', { name: 'Revisar resumo' }).click();
await carla.getByRole('button', { name: 'Confirmar e registrar' }).click();
await carla.getByText('Carla Mendes (sintética)').first().waitFor();
await carla.getByRole('tab', { name: 'Movimentações' }).click();
await shot(carla, '04-movimentacoes');
await carla.getByRole('tab', { name: 'Linha do tempo' }).click();
await carla.getByText(/Recebimento da movimentação nº 1 confirmado/).waitFor();
ok(true, 'recebimento por outra conta e linha do tempo');
await shot(carla, '05-linha-do-tempo');
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mp = await mobile.newPage();
await mp.goto(BASE + '/login');
await shot(mp, '06-login-celular');
await browser.close();
console.log('jornada concluída');
