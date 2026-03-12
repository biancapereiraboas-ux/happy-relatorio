const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CPF   = process.env.HAPPY_CPF;
const SENHA = process.env.HAPPY_SENHA;
const API_TOKEN = process.env.API_TOKEN;

// URL do webhook no n8n para alertar sobre QR/selfie
const WEBHOOK_ALERTA_QR = 'https://n8n.appempresta.com.br/webhook/happy-qr-alerta';

// Chama o webhook de alerta quando QR/selfie é detectado
async function alertarQR() {
  try {
    const response = await fetch(WEBHOOK_ALERTA_QR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo: 'QR Code detectado no login', data: new Date().toISOString() })
    });
    console.log(`[ALERTA] Webhook QR chamado — status: ${response.status}`);
  } catch (e) {
    console.error(`[ALERTA] Erro ao chamar webhook QR:`, e.message);
  }
}

// Função principal do Playwright — roda em background (sem await)
async function gerarRelatorio() {
  console.log(`[${new Date().toISOString()}] Iniciando geração de relatório...`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    // P1 — Abrir portal
    console.log(`[P1] Abrindo portal...`);
    await page.goto('https://portal.happyconsig.com.br', { waitUntil: 'networkidle' });
    console.log(`[P1] Portal aberto.`);

    // P2 — Login
    console.log(`[P2] Fazendo login...`);
    await page.getByLabel('CPF').fill(CPF);
    await page.getByLabel('Senha').fill(SENHA);
    await page.getByRole('button', { name: 'Continuar' }).click();
    console.log(`[P2] Botão Continuar clicado.`);
    await page.waitForTimeout(3000);
    console.log(`[P2] URL após login: ${page.url()}`);

    // Aguarda sidebar OU tela de QR/selfie (limite de 30 acessos)
    // Promise.race: o que resolver primeiro vence
    const loginResult = await Promise.race([
      page.waitForSelector('text=Contratos', { state: 'visible', timeout: 90000 }).then(() => 'ok'),
      page.waitForSelector('canvas', { state: 'visible', timeout: 90000 }).then(() => 'qr'), // QR code é um <canvas>
    ]).catch(() => 'timeout');

    if (loginResult !== 'ok') {
      // Confirma pelo texto da página se é realmente QR/selfie
      const textoPage = await page.evaluate(() => document.body.innerText.toLowerCase());
      const isQR = textoPage.includes('qr') || textoPage.includes('selfie') || textoPage.includes('verifica');
      console.log(`[P2] Login não completou normalmente (resultado: ${loginResult}, QR detectado: ${isQR})`);
      if (isQR) {
        console.log(`[P2] Tela de QR/Selfie detectada! Enviando alerta para o Teams...`);
        await alertarQR();
      }
      return; // encerra sem gerar relatório
    }
    console.log(`[P2] Sidebar carregado.`);

    // Fecha popup de boas-vindas
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    console.log(`[P2] Popup fechado (se havia).`);

    // Remove OneSignal (bloqueava cliques no sidebar)
    await page.evaluate(() => {
      const el = document.getElementById('onesignal-slidedown-container');
      if (el) el.style.display = 'none';
    });
    await page.waitForTimeout(300);
    console.log(`[P2] OneSignal removido (se havia).`);

    // P3 — Navegar para Contratos
    console.log(`[P3] Clicando em Contratos...`);
    await page.getByText('Contratos', { exact: true }).click();
    await page.waitForSelector('button:has-text("Relatórios")', { state: 'visible', timeout: 15000 });
    console.log(`[P3] Contratos aberto. URL: ${page.url()}`);

    // P4 — Abrir modal Relatórios
    console.log(`[P4] Clicando em Relatórios...`);
    await page.getByRole('button', { name: /Relatórios/ }).click();
    await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 15000 });
    console.log(`[P4] Modal aberto.`);

    // P5 — Selecionar tipo Digitação
    console.log(`[P5] Selecionando tipo Digitação...`);
    await page.locator('[role="dialog"] .ant-select .ant-select-selector').first().click();
    await page.waitForTimeout(800);
    const opcoes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ant-select-item-option')).map(o => o.textContent.trim())
    );
    console.log(`[P5] Opções disponíveis: ${JSON.stringify(opcoes)}`);
    await page.evaluate(() => {
      const items = document.querySelectorAll('.ant-select-item-option');
      const item = Array.from(items).find(i => i.textContent.trim() === 'Digitação');
      if (item) {
        item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });
    await page.waitForTimeout(500);
    const valorSelecionado = await page.locator('[role="dialog"] .ant-select-selection-item').textContent().catch(() => 'vazio');
    console.log(`[P5] Valor selecionado: "${valorSelecionado}"`);

    // P6 — Selecionar período "Últimos 31 dias"
    console.log(`[P6] Abrindo calendário...`);
    const inputs = page.locator('.ant-picker-range input');
    await inputs.first().dispatchEvent('click');
    await page.waitForTimeout(800);
    console.log(`[P6] Clicando em "Últimos 31 dias"...`);
    await page.getByText('Últimos 31 dias').click({ force: true });
    await page.waitForTimeout(500);
    // Fecha o calendário (obrigatório — Ant Design mantém aberto após preset)
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ant-picker-dropdown', { state: 'hidden', timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(300);
    const v1 = await inputs.first().inputValue().catch(() => 'erro');
    const v2 = await inputs.last().inputValue().catch(() => 'erro');
    console.log(`[P6] Valores: "${v1}" | "${v2}"`);
    console.log(`[P6] Período selecionado.`);

    // P7 — Clicar em "Gerar relatório"
    console.log(`[P7] Clicando em Gerar relatório...`);
    const botoesModal = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="dialog"] button')).map(b => b.textContent.trim())
    );
    console.log(`[P7] Botões no modal: ${JSON.stringify(botoesModal)}`);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('[role="dialog"] button'))
        .find(b => /gerar relatório/i.test(b.textContent));
      if (btn) btn.click();
    });

    await page.waitForTimeout(3000);
    const conteudoModal = await page.locator('[role="dialog"]').textContent().catch(() => null);
    console.log(`[P7] Conteúdo modal após clique: "${conteudoModal?.replace(/\s+/g, ' ').trim().substring(0, 300)}"`);

    const modalFechou = await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 60000 })
      .then(() => true).catch(() => false);
    console.log(`[P7] Modal fechou: ${modalFechou}`);

    if (modalFechou) {
      const confirmacao = await page.locator('.ant-message, .ant-notification').textContent().catch(() => null);
      console.log(`[P7] Confirmação: "${confirmacao}"`);
    }

    console.log(`[${new Date().toISOString()}] Relatório solicitado com sucesso!`);

  } catch (erro) {
    console.error(`[${new Date().toISOString()}] Erro no Playwright:`, erro.message);
  } finally {
    if (browser) await browser.close();
  }
}

// Middleware de autenticação
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const token = req.headers['x-api-token'];
  if (token !== API_TOKEN) return res.status(401).json({ erro: 'Token inválido' });
  next();
});

// Consulta o status de uma proposta específica no portal Happy
// Recebe o número do contrato, retorna todas as fases da aba Status
async function consultarProposta(numero) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    // Login
    await page.goto('https://portal.happyconsig.com.br', { waitUntil: 'networkidle' });
    await page.getByLabel('CPF').fill(CPF);
    await page.getByLabel('Senha').fill(SENHA);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.waitForTimeout(3000);

    // Verifica QR/selfie
    const loginResult = await Promise.race([
      page.waitForSelector('text=Contratos', { state: 'visible', timeout: 90000 }).then(() => 'ok'),
      page.waitForSelector('canvas', { state: 'visible', timeout: 90000 }).then(() => 'qr'),
    ]).catch(() => 'timeout');

    if (loginResult !== 'ok') {
      const textoPage = await page.evaluate(() => document.body.innerText.toLowerCase());
      const isQR = textoPage.includes('qr') || textoPage.includes('selfie') || textoPage.includes('verifica');
      if (isQR) await alertarQR();
      return { erro: 'Login não completou — QR/selfie detectado ou timeout' };
    }

    // Remove popup OneSignal
    await page.evaluate(() => {
      const el = document.getElementById('onesignal-slidedown-container');
      if (el) el.style.display = 'none';
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Navega para Contratos
    await page.getByText('Contratos', { exact: true }).click();
    await page.waitForSelector('button:has-text("Relatórios")', { state: 'visible', timeout: 15000 });

    // Preenche o número do contrato e pesquisa
    // Usa o primeiro input da página (campo "Número do Contrato")
    await page.locator('input').first().fill(String(numero));
    await page.getByRole('button', { name: /Pesquisar/ }).click();
    await page.waitForTimeout(2000);

    // Clica no número azul do resultado (link com o número da proposta)
    await page.getByRole('link', { name: String(numero) }).first().click();
    await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(500);

    // Clica na aba Status — acha por nome, não por posição (resolve o "botão que muda de lugar")
    await page.getByRole('tab', { name: 'Status' }).click();
    await page.waitForTimeout(1000);

    // Lê todo o texto do modal — você processa o de-para no n8n
    const conteudo = await page.locator('[role="dialog"]').evaluate(el => el.innerText);

    console.log(`[CONSULTA] Proposta ${numero} lida com sucesso.`);
    return { numero, conteudo };

  } catch (e) {
    console.error(`[CONSULTA] Erro ao consultar proposta ${numero}:`, e.message);
    return { erro: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

// Rota de teste: GET /consultar-proposta?numero=1800368
// Resposta síncrona — pode demorar ~30-40s (login + navegação)
app.get('/consultar-proposta', async (req, res) => {
  const { numero } = req.query;
  if (!numero) return res.status(400).json({ erro: 'Parâmetro obrigatório: numero' });
  const resultado = await consultarProposta(numero);
  res.json(resultado);
});

// Rota principal — responde 202 imediatamente, Playwright roda em background
app.post('/gerar-relatorio', (req, res) => {
  res.status(202).json({ sucesso: true, mensagem: 'Solicitação recebida. Relatório sendo gerado em background.' });
  gerarRelatorio(); // sem await — não bloqueia
});

// Healthcheck
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`[Happy API] Rodando na porta ${PORT}`));
