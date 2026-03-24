// cancelamentos-digio.js — GitHub Actions
// Fase 1: faz login no portal Digio e baixa o relatório de Propostas Cadastradas
// Salva: relatorio-digio.xlsx na pasta do runner (vira artifact do GitHub Actions)
// Fase 2 (próximo passo): parsear o Excel e enviar cancelamentos ao webhook N8N

const { chromium } = require('playwright');
const path         = require('path');
const fs           = require('fs');

// Credenciais chegam via secrets do GitHub Actions (env do workflow)
const LOGIN = process.env.DIGIO_LOGIN;
const SENHA = process.env.DIGIO_SENHA;

// No GitHub Actions não há pasta local — salva na raiz do runner
const DESTINO = path.join(process.cwd(), 'relatorio-digio.xlsx');

const URL_BASE = 'https://funcaoconsig.digio.com.br/WebAutorizador/';

function log(msg) {
  console.log('[' + new Date().toLocaleString('pt-BR') + '] ' + msg);
}

function dataFormatada(d) {
  // Retorna data no formato DD/MM/AAAA
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  return dia + '/' + mes + '/' + ano;
}

async function rodar() {
  log('=== Robô Digio — GitHub Actions ===');

  if (!LOGIN || !SENHA) {
    log('ERRO: DIGIO_LOGIN ou DIGIO_SENHA não definidos nos secrets.');
    process.exit(1);
  }

  // GitHub Actions: sempre headless (sem tela)
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context  = await browser.newContext({ acceptDownloads: true });
  const page     = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    // ----- LOGIN -----
    log('[1] Abrindo portal Digio...');
    await page.goto(URL_BASE, { waitUntil: 'networkidle' });

    log('[2] Fazendo login...');
    await page.locator('input[name*="Usuario"], input[id*="Usuario"], input[type="text"]').first().fill(LOGIN);
    await page.locator('input[name*="Senha"], input[id*="Senha"], input[type="password"]').first().fill(SENHA);
    await page.locator('input[value="Entrar"], a:has-text("Entrar"), span:has-text("Entrar")').first().click();
    await page.waitForLoadState('networkidle');

    // Extrai o FISession da URL atual
    const urlAtual  = page.url();
    const fiSession = new URL(urlAtual).searchParams.get('FISession') || '';
    log('[2] Login OK! FISession: ' + fiSession);

    // ----- NAVEGAR AO RELATÓRIO -----
    log('[3] Navegando para Propostas Cadastradas...');
    await page.goto(
      'https://funcaoconsig.digio.com.br/WebAutorizador/MenuWeb/Relatorios/PropostasCadastradas/UI.PropostasCadastradas.aspx?FISession=' + fiSession,
      { waitUntil: 'networkidle' }
    );
    log('[3] Página do relatório carregada.');

    // ----- PREENCHER FILTROS -----
    log('[4] Preenchendo filtros...');

    // Tipo de Referência = Data Cadastro
    await page.selectOption('select[id*="TipoReferencia"], select[name*="TipoReferencia"]', { label: 'Data Cadastro' });

    // Data Inicial = hoje - 31 dias | Data Final = hoje
    const hoje     = new Date();
    const inicioD  = new Date(hoje);
    inicioD.setDate(hoje.getDate() - 31);
    const dataInicio = dataFormatada(inicioD);
    const dataFim    = dataFormatada(hoje);

    await page.locator('input[id*="DataInicial"], input[name*="DataInicial"]').fill(dataInicio);
    await page.locator('input[id*="DataFinal"], input[name*="DataFinal"]').fill(dataFim);
    log('[4] Período: ' + dataInicio + ' → ' + dataFim);

    // Todas as situações
    const checkboxesSituacao = [
      'Andamento', 'Liberadas', 'Integradas', 'Reprovadas',
      'Canceladas', 'Pendentes', 'Aprovadas'
    ];
    for (const situacao of checkboxesSituacao) {
      try {
        const label = page.locator(`label:has-text("${situacao}")`);
        const cb    = page.locator(`input[type="checkbox"]`).filter({ hasText: situacao });
        if (await label.count() > 0) {
          await label.first().click();
        } else if (await cb.count() > 0) {
          await cb.first().check();
        }
      } catch(e) { log('     [aviso] Não marcou: ' + situacao); }
    }

    // Modelo Analítico + Layout Excel
    await page.selectOption('select[id*="ModeloRelatorio"], select[name*="ModeloRelatorio"]', { label: 'Analítico' }).catch(() => {});
    await page.selectOption('select[id*="Layout"], select[name*="Layout"]', { label: 'Excel' }).catch(() => {});

    log('[4] Filtros preenchidos.');

    // ----- GERAR E BAIXAR -----
    log('[5] Clicando em Gerar e aguardando download...');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120000 }),
      page.locator('input[value="Gerar"], button:has-text("Gerar")').click()
    ]);

    await download.saveAs(DESTINO);
    log('[5] Arquivo salvo em: ' + DESTINO);

    // Confirma que o arquivo existe e tem tamanho > 0
    const stats = fs.statSync(DESTINO);
    log('[5] Tamanho do arquivo: ' + stats.size + ' bytes');

    if (stats.size < 1000) {
      log('AVISO: arquivo muito pequeno — pode estar vazio ou com erro.');
      process.exit(1);
    }

  } finally {
    await browser.close();
  }

  log('=== Fase 1 concluída! Arquivo pronto para fase 2 (parse + N8N). ===');
}

rodar().catch(e => {
  log('[ERRO GERAL] ' + e.message);
  process.exit(1);
});
