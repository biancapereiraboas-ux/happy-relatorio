// verificar-averbacao-c6.js — Robô C6: verifica se propostas "Saldo aprovado" foram averbadas
// Faz: Supabase (funil_c6) → filtra Status = "Saldo aprovado" e M. Pago vazio
//      → C6 portal → busca proposta em Andamento; se não achar, tenta Canceladas e Integradas
//      → lê coluna ATIVIDADE: em branco = averbou → grava Status/Motivo/M.Pago no Supabase
//      → se ainda "EM AVERBAÇÃO" → ignora
// Roda: GitHub Actions (seg-sex 9h BRT) ou node verificar-averbacao-c6.js localmente

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

const LOGIN    = process.env.C6_LOGIN;
const SENHA    = process.env.C6_SENHA;
const HEADED   = process.env.HEADED === '1';
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

// Sessão salva: GitHub Actions passa via env C6_SESSION (base64)
// Local: lê session-c6.json direto se existir
function carregarSessao() {
  // GitHub Actions: decodifica base64 da env
  if (process.env.C6_SESSION) {
    const json = Buffer.from(process.env.C6_SESSION, 'base64').toString('utf-8');
    fs.writeFileSync('/tmp/session-c6.json', json);
    return '/tmp/session-c6.json';
  }
  // Local: usa arquivo direto
  if (fs.existsSync('session-c6.json')) return 'session-c6.json';
  return null;
}

const URL_BASE           = 'https://c6.c6consig.com.br/WebAutorizador/';
const URL_ANDAMENTO      = 'https://c6.c6consig.com.br/WebAutorizador/MenuWeb/Esteira/AprovacaoConsulta/UI.AprovacaoConsultaAnd.aspx';
const URL_CANC_INTEGRADAS = 'https://c6.c6consig.com.br/WebAutorizador/MenuWeb/Esteira/AprovacaoConsulta/UI.AprovacaoConsultaCanInt.aspx';

const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function log(msg) {
  console.log('[' + new Date().toLocaleString('pt-BR') + '] ' + msg);
}

// Formata o mês atual no padrão Abr/26, Mai/26, etc.
function mesAtual() {
  const hoje = new Date();
  return MESES_PT[hoje.getMonth()] + '/' + String(hoje.getFullYear()).slice(-2);
}

// ─── SUPABASE ─────────────────────────────────────────────────────────────────

// Busca propostas com Status = 'Saldo aprovado' e M. Pago ainda vazio
// Status 'Saldo aprovado' = banco pagou mas ainda não confirmou averbação
async function buscarPropostas() {
  const resp = await fetch(
    SUPA_URL + '/rest/v1/funil_c6?select=*&Status=eq.Saldo%20aprovado',
    {
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
      },
    }
  );

  if (!resp.ok) {
    throw new Error('Supabase GET falhou: ' + resp.status + ' ' + await resp.text());
  }

  const rows = await resp.json();

  // Filtra em JS as que ainda não têm M. Pago (campo com espaço — mais seguro filtrar aqui)
  return rows.filter(r => !r['M. Pago']);
}

// Grava Status, Motivo e M. Pago no Supabase quando averbação confirmada
async function salvarAverbacao(proposta, mPago) {
  const resp = await fetch(
    SUPA_URL + '/rest/v1/funil_c6?proposta=eq.' + proposta,
    {
      method: 'PATCH',
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        'Status':                   'Pago ao Cliente',
        'Motivo Reprova/Pendencia': 'Pago ao Cliente',
        'M. Pago':                  mPago,
      }),
    }
  );

  if (!resp.ok) {
    throw new Error('Supabase PATCH falhou: ' + resp.status + ' ' + await resp.text());
  }
}

// ─── C6 — VERIFICAÇÃO DE AVERBAÇÃO ───────────────────────────────────────────

// Pesquisa a proposta em uma esteira específica e retorna o texto da coluna ATIVIDADE
// Retorna: string com valor da ATIVIDADE | null se não encontrou a proposta
async function pesquisarNaEsteira(page, proposta, urlEsteira, fiSession) {
  // FISession só appenda se não estiver vazio — com sessão salva cookies bastam
  const urlFinal = fiSession ? urlEsteira + '?FISession=' + fiSession : urlEsteira;
  await page.goto(urlFinal, {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await page.waitForLoadState('networkidle').catch(() => {});

  // Se redirecionou pra login, sessão expirou
  if (page.url().toLowerCase().includes('login')) {
    throw new Error('Sessão expirada durante navegação — rode SALVAR-SESSAO.bat para renovar');
  }
  await page.waitForTimeout(2000);

  // Debug: verifica se há frames (portais ASP.NET às vezes usam iframes)
  const qtdFrames = page.frames().length;
  if (qtdFrames > 1) log('[debug] ' + qtdFrames + ' frames detectados na página');

  // Tenta localizar o select — se não achar em 5s, tira screenshot pra diagnóstico
  const temSelect = await page.locator('select').first().isVisible({ timeout: 5000 }).catch(() => false);
  if (!temSelect) {
    await page.screenshot({ path: 'screenshot-esteira-debug.png' });
    log('[debug] Select não encontrado — screenshot salvo em screenshot-esteira-debug.png');
    log('[debug] URL atual: ' + page.url());
    return null; // página não carregou o formulário, tenta próxima esteira
  }

  await page.locator('select').first().selectOption({ label: 'Nr. Proposta' });
  await page.waitForTimeout(1000);

  await page.locator('input[type="text"]').last().fill(proposta);
  await page.waitForTimeout(1000);

  await page.locator('input[value="Pesquisar"], #btnPesquisar_txt, a:has-text("Pesquisar")').first().click();
  await page.waitForTimeout(4000);

  // Verifica se a proposta apareceu
  const linkProposta = page.locator('a').filter({ hasText: proposta }).first();
  if (!await linkProposta.count()) return null;

  // Lê coluna ATIVIDADE da linha da proposta
  return await page.evaluate((numProposta) => {
    const tabela = document.querySelector('[id*="grdConsulta"]') ||
      Array.from(document.querySelectorAll('table')).find(t =>
        t.innerText.includes('PROPOSTA') && t.innerText.includes('ATIVIDADE')
      );
    if (!tabela) return null;

    const linhas = Array.from(tabela.querySelectorAll('tr'));
    if (linhas.length < 2) return null;

    const cabecalhos = Array.from(linhas[0].querySelectorAll('td, th')).map(c =>
      c.innerText.trim().toUpperCase()
    );
    const idxAtividade = cabecalhos.indexOf('ATIVIDADE');
    const idxProposta  = cabecalhos.findIndex(c => c.includes('PROPOSTA'));
    if (idxAtividade === -1 || idxProposta === -1) return null;

    for (let i = 1; i < linhas.length; i++) {
      const cels = Array.from(linhas[i].querySelectorAll('td'));
      if (!cels[idxProposta]) continue;
      if ((cels[idxProposta].innerText || '').trim().includes(numProposta)) {
        return (cels[idxAtividade] ? cels[idxAtividade].innerText.trim() : '');
      }
    }
    return null;
  }, proposta);
}

// Tenta Andamento primeiro; se não achar, tenta Canceladas e Integradas
// Retorna: true (averbou) | false (ainda em averbação) | null (não encontrou em nenhuma)
async function verificarAverbacao(page, proposta, fiSession) {
  log('[' + proposta + '] Verificando averbação...');

  // 1ª tentativa: Andamento
  let atividade = await pesquisarNaEsteira(page, proposta, URL_ANDAMENTO, fiSession);

  if (atividade === null) {
    log('[' + proposta + '] Não achei em Andamento — tentando Canceladas e Integradas...');
    atividade = await pesquisarNaEsteira(page, proposta, URL_CANC_INTEGRADAS, fiSession);
  }

  if (atividade === null) {
    log('[' + proposta + '] ⚠  Proposta não encontrada em nenhuma esteira.');
    return null;
  }

  const atividadeNorm = atividade.toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (atividadeNorm === 'EM AVERBACAO') {
    log('[' + proposta + '] ⏳ Ainda em averbação.');
    return false;
  }

  if (atividadeNorm === '' || atividade === '') {
    log('[' + proposta + '] ✓ AVERBOU! ATIVIDADE em branco.');
    return true;
  }

  // Outro valor = ainda aguardando (ex: "AGUARDA AVERB PORT")
  log('[' + proposta + '] ⏳ Ainda aguardando: "' + atividade + '"');
  return false;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function rodar() {
  log('=== Verificar Averbação C6 — Iniciando ===');

  // 1. Busca propostas pendentes no Supabase
  log('[0] Consultando Supabase (funil_c6)...');
  const propostas = await buscarPropostas();

  if (propostas.length === 0) {
    log('[0] Nenhuma proposta pendente de averbação. ✓');
    return;
  }

  log('[0] ' + propostas.length + ' proposta(s): ' + propostas.map(p => p.proposta).join(', '));

  // 2. Verifica se tem sessão salva
  const sessaoPath = carregarSessao();
  log('[0] Sessão: ' + (sessaoPath ? 'encontrada (' + sessaoPath + ')' : 'não encontrada — vai fazer login'));

  const browser = await chromium.launch({
    headless: !HEADED,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--disable-default-apps',
    ],
  });

  // Carrega sessão salva se disponível — pula login e Cloudflare
  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
  };
  if (sessaoPath) contextOptions.storageState = sessaoPath;

  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  page.on('dialog', async dialog => {
    const msg = dialog.message();
    if (msg.includes('autenticado') || msg.includes('desconectar') || msg.includes('esta\u00e7\u00e3o')) {
      log('[!] Desconectando sess\u00e3o anterior...');
      await dialog.accept().catch(() => {});
    } else {
      await dialog.dismiss().catch(() => {});
    }
  });

  await page.route('http://localhost/**', route => route.abort());
  await page.route('ws://localhost/**',   route => route.abort());

  const resultados = { averbadas: 0, pendentes: 0, erros: 0 };
  let fiSession = '';

  try {
    if (sessaoPath) {
      // 3a. Com sessão — navega pela URL base para pegar FISession
      // (necessário: o portal ASP.NET precisa do FISession para renderizar os formulários)
      log('[1] Carregando sessão salva — navegando pela URL base para obter FISession...');
      await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.screenshot({ path: 'screenshot-login-c6.png' });
      log('[1] URL atual: ' + page.url());

      // Verifica se sessão ainda é válida
      const url = page.url();
      if (!url.includes('WebAutorizador') || url.includes('Login')) {
        throw new Error('Sess\u00e3o expirada — rode SALVAR-SESSAO.bat para renovar');
      }

      // Extrai FISession — tenta em 3 lugares diferentes
      fiSession = new URL(page.url()).searchParams.get('FISession') || '';

      if (!fiSession) {
        // Links de menu da página autenticada contêm FISession (ex: href="...?FISession=abc123")
        fiSession = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="FISession"]'));
          if (links.length > 0) {
            const m = (links[0].href || '').match(/FISession=([a-zA-Z0-9]+)/);
            return m ? m[1] : '';
          }
          // Tenta também em hidden inputs e scripts inline
          const input = document.querySelector('input[name="FISession"], input[id="FISession"]');
          if (input) return input.value;
          const scriptMatch = document.body.innerHTML.match(/FISession[=\\"]+([a-zA-Z0-9]{8,})/);
          return scriptMatch ? scriptMatch[1] : '';
        });
      }

      log('[1] Sessão OK! FISession: ' + (fiSession || '(vazio — página pode não ter links com FISession)'));
      if (!fiSession) {
        log('[1] AVISO: sem FISession — esteiras podem não renderizar. Verifique screenshot-login-c6.png');
      }

    } else {
      // 3b. Sem sessão — faz login normal
      log('[1] Abrindo portal C6...');
      await page.goto(URL_BASE, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'screenshot-login-c6.png' });
      log('[1] URL atual: ' + page.url());

      await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: 30000 });
      await page.waitForTimeout(1000);

      log('[2] Fazendo login...');
      const campoUsuario = page.locator('input[name*="Usuario"], input[id*="Usuario"], input[type="text"]').first();
      await campoUsuario.click();
      await campoUsuario.pressSequentially(LOGIN, { delay: 80 });
      await page.waitForTimeout(500);

      const campoSenha = page.locator('input[name*="Senha"], input[id*="Senha"], input[type="password"]').first();
      await campoSenha.click();
      await campoSenha.pressSequentially(SENHA, { delay: 80 });
      await page.waitForTimeout(400);

      await page.getByText('Entrar').first().click();
      await page.waitForURL('**/WebAutorizador/**', { timeout: 30000 });
      await page.waitForLoadState('networkidle').catch(() => {});

      fiSession = new URL(page.url()).searchParams.get('FISession') || '';
      log('[2] Login OK! FISession: ' + fiSession);
    }

    // 4. Verifica cada proposta
    const mPago = mesAtual(); // ex: Abr/26

    for (const row of propostas) {
      const proposta = String(row.proposta);
      try {
        const averbou = await verificarAverbacao(page, proposta, fiSession);

        if (averbou === true) {
          await salvarAverbacao(proposta, mPago);
          log('[' + proposta + '] ✓ Salvo — Status: Pago ao Cliente | M. Pago: ' + mPago);
          resultados.averbadas++;
        } else if (averbou === false) {
          resultados.pendentes++;
        } else {
          resultados.erros++;
        }

      } catch (e) {
        log('[' + proposta + '] ✗ ERRO: ' + e.message);
        resultados.erros++;
      }

      // Pausa anti-bot entre propostas
      await page.waitForTimeout(2000 + Math.random() * 2000);
    }

  } finally {
    await browser.close();
  }

  log('=== Conclu\u00eddo! ✓ Averbadas: ' + resultados.averbadas +
      ' | Ainda pendentes: ' + resultados.pendentes +
      ' | Erros: ' + resultados.erros + ' ===');
}

rodar().catch(e => {
  log('[ERRO GERAL] ' + e.message);
  process.exit(1);
});
