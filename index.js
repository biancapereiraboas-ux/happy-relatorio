const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

// Lê as credenciais das variáveis de ambiente (nunca no código)
const CPF = process.env.HAPPY_CPF;
const SENHA = process.env.HAPPY_SENHA;
const API_TOKEN = process.env.API_TOKEN;

// Middleware de autenticação: bloqueia chamadas sem token
app.use((req, res, next) => {
  const token = req.headers['x-api-token'];
  if (token !== API_TOKEN) {
    return res.status(401).json({ erro: 'Token inválido' });
  }
  next();
});

// Endpoint principal — n8n vai chamar este POST /gerar-relatorio
app.post('/gerar-relatorio', async (req, res) => {
  console.log('Iniciando automação...');

  let navegador;
  try {
    // Abre o Chromium do sistema (Railway já tem instalado)
    navegador = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const pagina = await navegador.newPage();

    // P1 — Abre o portal
    await pagina.goto('https://portal.happyconsig.com.br', { waitUntil: 'networkidle' });
    console.log('Portal aberto');

    // P2 — Login
    await pagina.getByLabel('CPF').fill(CPF);
    await pagina.getByLabel('Senha').fill(SENHA);
    await pagina.getByRole('button', { name: 'Continuar' }).click();
    await pagina.waitForTimeout(3000);

    // Aguarda o menu lateral carregar
    await pagina.waitForSelector('text=Contratos', { state: 'visible', timeout: 90000 });
    console.log('Login feito, sidebar carregada');

    // Fecha popup de boas-vindas se aparecer
    await pagina.keyboard.press('Escape');
    await pagina.waitForTimeout(500);

    // Remove o popup do OneSignal (bloqueava cliques no menu)
    await pagina.evaluate(() => {
      const el = document.getElementById('onesignal-slidedown-container');
      if (el) el.style.display = 'none';
    });

    // P3 — Clica em Contratos no menu lateral
    await pagina.getByText('Contratos', { exact: true }).click();
    await pagina.waitForSelector('button:has-text("Relatórios")', { state: 'visible', timeout: 15000 });
    console.log('Página de contratos aberta');

    // P4 — Abre o modal de Relatórios
    await pagina.getByRole('button', { name: /Relatórios/ }).click();
    await pagina.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 15000 });
    console.log('Modal de relatórios aberto');

    // P5 — Seleciona o tipo "Digitação"
    // Ant Design escuta mousedown (não click comum)
    await pagina.locator('[role="dialog"] .ant-select .ant-select-selector').first().click();
    await pagina.waitForTimeout(800);

    await pagina.evaluate(() => {
      const items = document.querySelectorAll('.ant-select-item-option');
      const item = Array.from(items).find(i => i.textContent.trim() === 'Digitação');
      if (item) {
        item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });
    await pagina.waitForTimeout(500);
    console.log('Tipo "Digitação" selecionado');

    // P6 — Seleciona o período "Últimos 31 dias"
    const inputs = pagina.locator('.ant-picker-range input');
    await inputs.first().dispatchEvent('click');
    await pagina.waitForTimeout(800);

    await pagina.getByText('Últimos 31 dias').click({ force: true });
    await pagina.waitForTimeout(500);

    // Fecha o calendário (obrigatório — Ant Design deixa aberto após preset)
    await pagina.keyboard.press('Escape');
    await pagina.waitForSelector('.ant-picker-dropdown', { state: 'hidden', timeout: 5000 }).catch(() => null);
    await pagina.waitForTimeout(300);
    console.log('Período selecionado');

    // P7 — Clica em "Gerar relatório"
    await pagina.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('[role="dialog"] button'))
        .find(b => /gerar relatório/i.test(b.textContent));
      if (btn) btn.click();
    });

    // Aguarda o modal fechar (confirmação do servidor)
    const sucesso = await pagina.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 60000 })
      .then(() => true).catch(() => false);

    console.log('Automação concluída. Sucesso:', sucesso);
    res.json({ sucesso, mensagem: sucesso ? 'Relatório gerado com sucesso' : 'Modal não fechou — verifique manualmente' });

  } catch (erro) {
    console.error('Erro na automação:', erro.message);
    res.status(500).json({ sucesso: false, erro: erro.message });
  } finally {
    if (navegador) await navegador.close();
  }
});

// Healthcheck — Railway usa para saber se o serviço está vivo
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`Servidor rodando na porta ${PORTA}`));
