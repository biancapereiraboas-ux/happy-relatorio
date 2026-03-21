// cancelamentos.js — Robô de Cancelamentos Amigoz v2
// Le:    Cancelamento IS - N8N onde Banco = AMIGOZ e Cancelamento Banco IS NULL e Protocolo preenchido
// Faz:   Auth via API direta → busca último status de cada proposta → de-para de motivos
//        Se código desconhecido: abre portal via Playwright, descobre nome na aba Status
// Grava: Cancelamento Banco = "Consultado Amigoz"
//        Historico Fases    = "Nome Legível | Observação"
// v2: auto-descoberta de códigos via UI (igual ao Happy)

require('dotenv').config();
const { chromium }     = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs               = require('fs');
const path             = require('path');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPA_URL, SUPA_KEY);

// Credenciais Amigoz — vêm do .env (local) ou GitHub Secrets (Actions)
const CPF_AMIGOZ_LOGIN = process.env.AMIGOZ_CPF_LOGIN; // com pontuação — para o portal
const CPF_AMIGOZ_API   = process.env.AMIGOZ_CPF_API;   // sem pontuação — para a API
const SENHA_AMIGOZ     = process.env.AMIGOZ_SENHA;
const CORBAN_ID        = Number(process.env.AMIGOZ_CORBAN_ID) || 19;

const WEBHOOK_CONCLUSAO = 'https://n8n.appempresta.com.br/webhook/Fluxo-Cancelamento-Finalizado-Amigoz';

const TABELA        = 'Cancelamento IS - N8N';
const COL_PROTOCOLO = 'Protocolo';
const COL_BANCO     = 'Banco';
const COL_MOTIVO    = 'Cancelamento Banco';
const COL_HISTORICO = 'Historico Fases';

// MODO TESTE: true = busca só 5 e NÃO salva no Supabase
const MODO_TESTE = false;

// ----- LOG -----
const LOG_PATH = path.join(__dirname, 'cancelamentos-log.txt');
function log(msg) {
  const linha = '[' + new Date().toLocaleString('pt-BR') + '] ' + msg;
  console.log(linha);
  try { fs.appendFileSync(LOG_PATH, linha + '\n'); } catch(e) {}
}

// ----- DE-PARA DE MOTIVOS -----
// Mapeia código numérico (campo "nome" da API) → nome legível
// Populado automaticamente via descricao_front (quando disponível) ou via UI (descoberta)
const DEPARA_PATH = path.join(__dirname, 'depara-motivos.json');
let depara = {};
try { depara = JSON.parse(fs.readFileSync(DEPARA_PATH, 'utf8')); } catch(e) {}

// codigosNovos: { codigo: true } — marcador de quais códigos não estão no depara
// propostasComCodigos: { codigo: { protocolo, statusArr } } — guarda uma referência
//   para cada código novo, usada depois na auto-descoberta via UI
const codigosNovos        = {};
const propostasComCodigos = {};

// Registros do Supabase que foram salvos com "(Motivo XX)" — para re-atualizar após descoberta
// { codigo: [{ id, obs }] }
const registrosParaReprocessar = {};

function traduzirMotivo(codigo, descFront, protocolo, statusArr) {
  const chave = String(codigo);

  // 1. Já está no depara → usa
  if (depara[chave]) return depara[chave];

  // 2. API forneceu descricao_front → usa e salva no depara automaticamente
  if (descFront && descFront.trim()) {
    depara[chave] = descFront.trim();
    salvarDepara();
    log('     [Auto-depara via API] ' + chave + ' -> "' + depara[chave] + '"');
    return depara[chave];
  }

  // 3. Código desconhecido → placeholder, agenda para descoberta via UI
  codigosNovos[chave] = true;
  if (!propostasComCodigos[chave]) {
    propostasComCodigos[chave] = { protocolo, statusArr: JSON.parse(JSON.stringify(statusArr)) };
  }
  return '(Motivo ' + chave + ')';
}

function salvarDepara() {
  const ordenado = Object.fromEntries(
    Object.entries(depara).sort((a, b) => Number(a[0]) - Number(b[0]))
  );
  fs.writeFileSync(DEPARA_PATH, JSON.stringify(ordenado, null, 2), 'utf8');
}

// ----- PAUSA -----
function pausa(min, max) {
  return new Promise(r => setTimeout(r, min + Math.floor(Math.random() * (max - min))));
}

// ----- AUTH VIA API DIRETA -----
let bearerToken          = null;
let identificadorUsuario = null;

async function autenticar() {
  log('[Auth] Autenticando na API Amigoz...');

  const r1 = await fetch('https://backoffice.amigozconsig.com.br/api/auth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: CPF_AMIGOZ_API, password: SENHA_AMIGOZ })
  });
  const d1 = await r1.json();
  if (!d1.access) throw new Error('Login API falhou: ' + JSON.stringify(d1).substring(0, 200));

  const r2 = await fetch('https://backoffice.amigozconsig.com.br/api/auth/select-corban/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + d1.access },
    body: JSON.stringify({ id: CORBAN_ID })
  });
  const d2 = await r2.json();
  if (!d2.access) throw new Error('Select-corban falhou: ' + JSON.stringify(d2).substring(0, 200));
  bearerToken = d2.access;

  const r3 = await fetch('https://backoffice.amigozconsig.com.br/api/auth/permissoes-usuario/', {
    headers: { 'Authorization': 'Bearer ' + bearerToken }
  });
  const d3 = await r3.json();
  if (!d3.unique_id) throw new Error('Permissoes falhou: ' + JSON.stringify(d3).substring(0, 200));
  identificadorUsuario = d3.unique_id;

  log('[Auth] OK. Usuário: ' + d3.name);
}

// ----- CONSULTA PROPOSTA VIA API -----
async function consultarProposta(numero) {
  const headers = {
    'Authorization': 'Bearer ' + bearerToken,
    'Content-Type': 'application/json'
  };

  const r1 = await fetch('https://backoffice.amigozconsig.com.br/api/contratos/listar-contratos/', {
    method: 'POST', headers,
    body: JSON.stringify({
      page: 1, contrato: String(numero), cpf: '', cliente: '',
      tipo_produto: '', status: '', identificador_usuario: identificadorUsuario,
      items_per_page: 10, ordem: ''
    })
  });

  if (r1.status === 401) return { erro: '401' };
  if (!r1.ok) return { erro: 'listar HTTP ' + r1.status };

  const ld = await r1.json();
  const lista = ld.contratos || [];
  if (lista.length === 0) return { erro: 'nao encontrado' };

  const tokenContrato = lista[0].token_contrato;
  if (!tokenContrato) return { erro: 'sem token_contrato' };

  const r2 = await fetch('https://backoffice.amigozconsig.com.br/api/contratos/detalhe-contratos/', {
    method: 'POST', headers,
    body: JSON.stringify({ token_contrato: tokenContrato })
  });

  if (r2.status === 401) return { erro: '401' };
  if (!r2.ok) return { erro: 'detalhe HTTP ' + r2.status };

  const det = await r2.json();
  return { statusArr: det.status || [] };
}

// ----- PARSEAR NOMES DE STATUS DA UI DO AMIGOZ -----
// Recebe o texto bruto da aba Status e devolve array com os nomes dos status
// Lógica: pula labels (Observação:, Fase inicial:, Fase final:), datas e horários
function parsearStatusUI(texto) {
  const linhas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const nomes  = [];
  let dentroStatus = false;

  for (const linha of linhas) {
    // Começa a capturar depois de encontrar a aba "Status"
    if (linha === 'Status') { dentroStatus = true; continue; }
    if (!dentroStatus) continue;

    // Fim do conteúdo (botões do rodapé da modal)
    if (linha.toLowerCase().includes('cancelar') && linha.toLowerCase().includes('proposta')) break;
    if (linha.toLowerCase() === 'fechar') break;

    // Linhas de metadado — pula
    if (linha.startsWith('Observação:'))   continue;
    if (linha.startsWith('Observacao:'))   continue;
    if (linha.startsWith('Fase inicial:')) continue;
    if (linha.startsWith('Fase final:'))   continue;
    if (linha.startsWith('Criado por:'))   continue;
    if (/^\d{2}\/\d{2}\/\d{4}/.test(linha)) continue; // datas
    if (/^\d{2}:\d{2}/.test(linha))          continue; // horas
    if (linha === '-') continue;
    if (linha === 'Observação' || linha === 'Fase inicial' || linha === 'Fase final') continue;

    // O que sobra é nome de status
    nomes.push(linha);
  }

  return nomes;
}

// ----- AUTO-DESCOBERTA DE NOMES VIA UI -----
// Abre o portal Amigoz, navega até contratos com códigos desconhecidos,
// lê os nomes na aba Status e cruza com os códigos da API por índice
async function descobrirNomesMotivos() {
  const novosKeys = Object.keys(codigosNovos);
  if (novosKeys.length === 0) return;

  log('');
  log('[Auto-descoberta] ' + novosKeys.length + ' código(s) novo(s): ' + novosKeys.join(', '));
  log('[Auto-descoberta] Abrindo portal Amigoz para descobrir nomes...');

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Login no portal
    log('[Auto-descoberta] Fazendo login no portal...');
    await page.goto('https://amigozconsig.com.br/login', { waitUntil: 'networkidle' });
    await pausa(800, 1200);
    await page.getByLabel('CPF').fill(CPF_AMIGOZ_LOGIN);
    await pausa(400, 700);
    await page.getByLabel('Senha').fill(SENHA_AMIGOZ);
    await pausa(400, 700);
    await page.getByRole('button', { name: /entrar|continuar/i }).click();

    await Promise.race([
      page.waitForSelector('text=Contratos', { state: 'visible', timeout: 60000 }),
      page.waitForSelector('text=Serviços',  { state: 'visible', timeout: 60000 }),
    ]).catch(() => {});
    await pausa(1500, 2000);
    log('[Auto-descoberta] Login no portal OK!');

    // Agrupa códigos por proposta (uma visita por proposta pode descobrir múltiplos códigos)
    const propostasNecessarias = {};
    for (const codigo of novosKeys) {
      if (!propostasComCodigos[codigo]) continue;
      const num = String(propostasComCodigos[codigo].protocolo);
      if (!propostasNecessarias[num]) propostasNecessarias[num] = [];
      propostasNecessarias[num].push(codigo);
    }

    for (const [numero, codigos] of Object.entries(propostasNecessarias)) {
      log('[Auto-descoberta] -> Proposta ' + numero + ' (códigos: ' + codigos.join(', ') + ')');
      try {
        // Navega para a página de Contratos
        await page.goto('https://amigozconsig.com.br/contratos?page=1', { waitUntil: 'networkidle' });
        await pausa(800, 1200);

        // Preenche o número do contrato e pesquisa
        await page.locator('input').first().fill(String(numero));
        await pausa(500, 800);
        await page.getByRole('button', { name: /pesquisar/i }).click();
        await page.waitForLoadState('networkidle', { timeout: 15000 });
        await page.waitForSelector('tr.ant-table-row', { state: 'visible', timeout: 15000 });
        await pausa(600, 1000);

        // Clica na primeira linha para abrir a modal
        await page.locator('tr.ant-table-row').first().click();
        await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 15000 });
        await pausa(800, 1200);

        // Clica na aba Status
        await page.getByRole('tab', { name: 'Status' }).click();
        await pausa(1500, 2500);

        // Lê o texto renderizado
        const textoModal = await page.locator('[role="dialog"]').evaluate(el => el.innerText);
        const nomesUI    = parsearStatusUI(textoModal);

        // Cruza por índice com os códigos da API
        const fasesAPI = propostasComCodigos[codigos[0]].statusArr;
        log('[Auto-descoberta] UI: ' + nomesUI.length + ' nome(s) | API: ' + fasesAPI.length + ' código(s)');

        if (nomesUI.length > 0 && fasesAPI.length === nomesUI.length) {
          for (let i = 0; i < fasesAPI.length; i++) {
            const cod = String(fasesAPI[i].nome);
            if (codigosNovos[cod] && nomesUI[i]) {
              depara[cod] = nomesUI[i];
              delete codigosNovos[cod];
              log('     ' + cod + ' -> "' + nomesUI[i] + '"');
            }
          }
          salvarDepara();
        } else {
          log('[Auto-descoberta] Contagem diverge — pulando. UI nomes: ' + JSON.stringify(nomesUI).substring(0, 200));
        }

        // Fecha modal
        await page.keyboard.press('Escape');
        await pausa(500, 800);

      } catch(e) {
        log('[Auto-descoberta] Erro na proposta ' + numero + ': ' + e.message);
      }

      await pausa(1500, 3000);
    }

  } catch(e) {
    log('[Auto-descoberta] Erro geral: ' + e.message);
  } finally {
    if (browser) await browser.close();
  }

  // Reporta os que ainda não foram descobertos
  const naoDescobertos = Object.keys(codigosNovos);
  if (naoDescobertos.length > 0) {
    log('[Auto-descoberta] Não descobertos (adicionar manualmente ao depara-motivos.json): ' + naoDescobertos.join(', '));
  }
}

// ----- RE-ATUALIZA SUPABASE com nomes descobertos -----
// Após a descoberta, re-salva os registros que tinham "(Motivo XX)"
async function reprocessarRegistros() {
  const codigos = Object.keys(registrosParaReprocessar);
  if (codigos.length === 0) return;

  log('[Reprocessar] Atualizando ' + codigos.length + ' código(s) com nomes descobertos...');

  for (const codigo of codigos) {
    const nomeNovo = depara[String(codigo)];
    if (!nomeNovo) continue; // ainda não foi descoberto

    const registros = registrosParaReprocessar[codigo];
    for (const reg of registros) {
      const historicoAtualizado = reg.historico.replace('(Motivo ' + codigo + ')', nomeNovo);
      if (MODO_TESTE) {
        log('     [TESTE] Reprocessaria id ' + reg.id + ': ' + historicoAtualizado);
        continue;
      }
      const { error } = await supabase.from(TABELA)
        .update({ [COL_HISTORICO]: historicoAtualizado })
        .eq('id', reg.id);
      if (error) log('     ERRO re-save id ' + reg.id + ': ' + error.message);
      else log('     Re-salvo id ' + reg.id + ': ' + historicoAtualizado);
    }
  }
}

// ----- SUPABASE -----
async function buscarPropostas() {
  log('[Supabase] Buscando propostas pendentes...');
  let query = supabase.from(TABELA).select('*')
    .eq(COL_BANCO, 'AMIGOZ')
    .eq(COL_MOTIVO, 'Validar no banco')
    .not(COL_PROTOCOLO, 'is', null);
  if (MODO_TESTE) query = query.limit(5);
  const { data, error } = await query;
  if (error) throw new Error('Supabase leitura: ' + error.message);
  log('[Supabase] ' + data.length + ' proposta(s).' + (MODO_TESTE ? ' [MODO TESTE]' : ''));
  return data;
}

async function atualizarProposta(id, motivo, historico) {
  if (MODO_TESTE) { log('     [TESTE] NÃO salvo.'); return; }
  const { error } = await supabase.from(TABELA)
    .update({ [COL_MOTIVO]: motivo, [COL_HISTORICO]: historico })
    .eq('id', id);
  if (error) log('[Supabase] Erro id ' + id + ': ' + error.message);
}

// ----- ROBÔ PRINCIPAL -----
async function rodarRobo() {
  log('');
  log('==============================================');
  log('  Robô Cancelamentos - Amigoz v2');
  log('==============================================');

  const inicio    = Date.now();
  const propostas = await buscarPropostas();
  if (propostas.length === 0) { log('Nenhuma proposta pendente!'); return; }

  await autenticar();

  let ok = 0, semStatus = 0, erros = 0, errosConsecutivos = 0;
  log('[Loop] Processando ' + propostas.length + ' proposta(s)...');

  for (const row of propostas) {
    const numero = row[COL_PROTOCOLO];
    log('  -> [AMIGOZ] ' + numero + '...');

    try {
      let resultado = await consultarProposta(numero);

      // Sessão expirou → re-autentica e retenta
      if (resultado.erro === '401') {
        errosConsecutivos++;
        if (errosConsecutivos >= 2) {
          log('  [Re-auth] Sessão expirou. Re-autenticando...');
          await autenticar();
          errosConsecutivos = 0;
          resultado = await consultarProposta(numero);
        }
      } else {
        errosConsecutivos = 0;
      }

      if (resultado.erro) {
        log('     ERRO: ' + resultado.erro);
        erros++;
        // Se não foi encontrado na API, marca no Supabase para não repetir nas próximas execuções
        if (resultado.erro === 'nao encontrado') {
          await atualizarProposta(row.id, 'Não encontrado no Amigoz', '');
        }
        continue;
      }

      errosConsecutivos = 0;
      const { statusArr } = resultado;

      if (!statusArr || statusArr.length === 0) {
        await atualizarProposta(row.id, 'Sem historico Amigoz', '');
        log('     Sem histórico.');
        semStatus++;
        continue;
      }

      // Pega ÚLTIMO status
      const ultimo       = statusArr[statusArr.length - 1];
      const codigoMotivo = String(ultimo.nome);
      const descFront    = ultimo.descricao_front || null;
      const nomeMotivo   = traduzirMotivo(codigoMotivo, descFront, numero, statusArr);
      const obsRaw       = (ultimo.descricao_mesa || '').trim();
      const obs          = (obsRaw && obsRaw !== '-') ? obsRaw : '';
      const historico    = nomeMotivo + (obs ? ' | ' + obs : '');

      // Se saiu como placeholder, registra para re-processar após descoberta
      if (nomeMotivo.startsWith('(Motivo ')) {
        if (!registrosParaReprocessar[codigoMotivo]) registrosParaReprocessar[codigoMotivo] = [];
        registrosParaReprocessar[codigoMotivo].push({ id: row.id, historico });
      }

      await atualizarProposta(row.id, 'Consultado Amigoz', historico);
      log('     OK — "' + nomeMotivo + '"' + (obs ? ' | obs: sim' : ''));
      ok++;

    } catch(e) {
      log('     ERRO: ' + e.message);
      erros++;
    }

    await pausa(800, 2000);

    const processadas = ok + semStatus + erros;
    if (processadas > 0 && processadas % 50 === 0) {
      log('  [Pausa longa] ' + processadas + ' processadas — aguardando 30s...');
      await pausa(30000, 35000);
    }
  }

  // AUTO-DESCOBERTA: navega pelo portal para descobrir nomes dos códigos desconhecidos
  if (Object.keys(codigosNovos).length > 0) {
    log('');
    log('[Auto-descoberta] Iniciando descoberta de ' + Object.keys(codigosNovos).length + ' código(s)...');
    await descobrirNomesMotivos();

    // Re-atualiza os registros que foram salvos com placeholder
    await reprocessarRegistros();
  }

  const duracaoMin = Math.round((Date.now() - inicio) / 60000);
  const resumo = { ok, semHistorico: semStatus, erros, duracaoMinutos: duracaoMin, data: new Date().toISOString() };

  log('');
  log('==============================================');
  log('  Concluído em ' + duracaoMin + ' min!');
  log('  OK Atualizados:  ' + ok);
  log('  Sem histórico:   ' + semStatus);
  log('  Erros:           ' + erros);
  log('==============================================');

  if (WEBHOOK_CONCLUSAO) {
    try {
      await fetch(WEBHOOK_CONCLUSAO, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resumo)
      });
    } catch(e) {}
  }
}

rodarRobo().catch(e => {
  log('[ERRO GERAL] ' + e.message);
  process.exit(1);
});
