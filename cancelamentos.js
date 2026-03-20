// Robo de Cancelamentos - Consulta motivo real na Happy e atualiza Supabase
// Le:    Cancelamento IS - N8N  onde Banco = HAPPY e Cancelamento Banco = Validar no banco
// Faz:   Login unico -> chama API de dentro do browser -> de-para de fases
// Grava: Cancelamento Banco = 'Consultado Happy', Historico Fases = texto com nomes legiveis
// Modo:  Headless (sem janela) — notifica N8N ao terminar ou se pedir QR
// v2:    Re-login automatico quando sessao expira + auto-descoberta de codigos novos

require('dotenv').config();
const { chromium }     = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs               = require('fs');
const path             = require('path');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPA_URL, SUPA_KEY);

// Credenciais principais — vem do .env (HAPPY_CPF / HAPPY_SENHA)
const CPF    = process.env.HAPPY_CPF;
const SENHA  = process.env.HAPPY_SENHA;

// Credencial reserva — preencha no .env se quiser fallback automatico
const CPF2   = process.env.HAPPY_CPF_2;
const SENHA2 = process.env.HAPPY_SENHA_2;

// Webhook N8N para avisar quando terminar ou se pedir QR
// Deixe vazio ('') para desativar notificacoes
const WEBHOOK_CONCLUSAO        = 'https://n8n.appempresta.com.br/webhook/cancelamentos-happy-conclusao';
const WEBHOOK_QR               = 'https://n8n.appempresta.com.br/webhook/happy-qr-alerta';
const WEBHOOK_FLUXO_FINALIZADO = 'https://n8n.appempresta.com.br/webhook/Fluxo-Cancelamento-Finalizado';

const TABELA        = 'Cancelamento IS - N8N';
const COL_PROTOCOLO = 'Protocolo';
const COL_BANCO     = 'Banco';
const COL_MOTIVO    = 'Cancelamento Banco';
const COL_HISTORICO = 'Historico Fases';

// MODO TESTE: true = busca so 7 e NAO salva no Supabase
const MODO_TESTE = false;

// ----- LOG EM ARQUIVO -----
const LOG_PATH = path.join(__dirname, 'cancelamentos-log.txt');
function log(msg) {
  const linha = '[' + new Date().toLocaleString('pt-BR') + '] ' + msg;
  console.log(linha);
  try { fs.appendFileSync(LOG_PATH, linha + '\n'); } catch(e) {}
}

// ----- DE-PARA DE FASES -----
const DEPARA_PATH = path.join(__dirname, 'depara-fases.json');
let depara = {};
try { depara = JSON.parse(fs.readFileSync(DEPARA_PATH, 'utf8')); } catch(e) {}

// codigosNovos: { codigo: true } — marcador de quais codigos nao estao no depara
// propostasComCodigos: { codigo: { numero, fases } } — guarda uma proposta
//   para cada codigo novo, usada depois na auto-descoberta via UI
const codigosNovos        = {};
const propostasComCodigos = {};

// registrosParaReprocessar: { [rowId]: { id, fases } }
// Guarda registros que foram salvos com placeholder (Fase XX) para que,
// apos a auto-descoberta, possam ser re-atualizados no Supabase com os nomes reais.
// Isso elimina a necessidade de rodar descobrir-fases.js manualmente depois.
const registrosParaReprocessar = {};

// numero e fases sao passados para guardar referencia para auto-descoberta
function traduzirFase(codigo, numero, fases) {
  const chave = String(codigo);
  if (depara[chave]) return depara[chave];
  codigosNovos[chave] = true;
  // Guarda apenas a primeira proposta que apareceu com esse codigo
  if (!propostasComCodigos[chave]) {
    propostasComCodigos[chave] = { numero, fases: JSON.parse(JSON.stringify(fases)) };
  }
  return '(Fase ' + chave + ')';
}

// ----- WEBHOOKS -----
async function notificar(url, dados) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados)
    });
  } catch(e) { log('[Webhook] Falha ao notificar: ' + e.message); }
}

// ----- PAUSA HUMANA -----
function pausa(min, max) {
  return new Promise(r => setTimeout(r, min + Math.floor(Math.random() * (max - min))));
}

// ----- SUPABASE -----
async function buscarPropostas() {
  log('[Supabase] Buscando propostas pendentes...');
  let query = supabase.from(TABELA).select('*')
    .eq(COL_BANCO, 'HAPPY').eq(COL_MOTIVO, 'Validar no banco');
  if (MODO_TESTE) query = query.limit(7);
  const { data, error } = await query;
  if (error) throw new Error('Supabase leitura: ' + error.message);
  log('[Supabase] ' + data.length + ' proposta(s) encontrada(s).' + (MODO_TESTE ? ' [MODO TESTE]' : ''));
  return data;
}

async function atualizarMotivo(id, motivo, historico) {
  if (MODO_TESTE) { log('     [TESTE] Supabase NAO atualizado.'); return; }
  const { error } = await supabase.from(TABELA)
    .update({ [COL_MOTIVO]: motivo, [COL_HISTORICO]: historico })
    .eq('id', id);
  if (error) log('[Supabase] Erro ao atualizar id ' + id + ': ' + error.message);
}

// ----- TOKEN DA SESSAO (capturado via interceptacao de rede) -----
// Ficam fora do rodarRobo() para que fazerLogin() possa atualiza-los
let bearerToken        = null;
let identificadorUsuario = null;

// ----- LOGIN (reutilizavel — chamado no inicio e no re-login automatico) -----
// cpf/senha opcionais: se nao passados, usa as credenciais padrao hardcoded
// Retorna 'ok', 'qr' ou 'timeout' — quem chamou decide o que fazer
async function fazerLogin(page, cpf, senha) {
  cpf   = cpf   || CPF;
  senha = senha || SENHA;

  // Zera os tokens antes de logar para nao usar valor antigo expirado
  bearerToken          = null;
  identificadorUsuario = null;

  log('[Happy] Fazendo login...');
  await page.goto('https://portal.happyconsig.com.br', { waitUntil: 'networkidle' });
  await pausa(800, 1500);
  await page.getByLabel('CPF').fill(cpf);
  await pausa(400, 900);
  await page.getByLabel('Senha').fill(senha);
  await pausa(500, 1000);
  await page.getByRole('button', { name: 'Continuar' }).click();

  const resultado = await Promise.race([
    page.waitForSelector('text=Contratos', { state: 'visible', timeout: 90000 }).then(() => 'ok'),
    page.waitForSelector('canvas',         { state: 'visible', timeout: 90000 }).then(() => 'qr'),
  ]).catch(() => 'timeout');

  if (resultado === 'ok') {
    await pausa(1000, 1500);
    log('[Happy] Login OK! Token: ' + (bearerToken ? 'sim' : 'NAO'));
  }
  return resultado;
}

// Tenta login com a credencial padrao; se falhar, tenta a reserva (CPF2/SENHA2 do .env)
// Retorna true se logou, false se ambas falharam (ja notificou N8N se foi QR)
async function fazerLoginComFallback(page) {
  let resultado = await fazerLogin(page);

  if (resultado !== 'ok' && CPF2 && SENHA2) {
    log('[Login] Credencial 1 falhou (' + resultado + '). Tentando credencial 2...');
    resultado = await fazerLogin(page, CPF2, SENHA2);
  }

  if (resultado === 'qr') {
    log('[ATENCAO] Happy pediu QR Code em todas as credenciais — encerrando e notificando N8N.');
    await notificar(WEBHOOK_QR, { motivo: 'QR Code detectado no cancelamentos.js', data: new Date().toISOString() });
    return false;
  }
  if (resultado === 'timeout') {
    throw new Error('Login expirou nas duas credenciais. Verifique CPF/senha.');
  }
  return true;
}

// ----- CONSULTA PROPOSTA VIA API -----
// Funcao separada para poder reusar no loop principal e na retentativa apos re-login
async function consultarPropostaAPI(page, numero) {
  return await page.evaluate(async ({ numero, token, usuarioId }) => {
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    const listarResp = await fetch('https://backoffice.happyconsig.com.br/api/contratos/listar-contratos/', {
      method: 'POST', headers,
      body: JSON.stringify({ page: 1, contrato: String(numero), cpf: '', cliente: '',
        tipo_produto: '', status: '', identificador_usuario: usuarioId, items_per_page: 10, ordem: '' })
    });
    const listarData = await listarResp.json();
    if (!listarData.contracts || listarData.contracts.length === 0) return { erro: 'nao encontrado' };

    const tokenContrato = listarData.contracts[0].token_contrato
                       || listarData.contracts[0].token
                       || listarData.contracts[0].uuid;
    if (!tokenContrato) return { erro: 'token nao encontrado' };

    const detalheResp = await fetch('https://backoffice.happyconsig.com.br/api/contratos/detalhe-contratos/', {
      method: 'POST', headers,
      body: JSON.stringify({ token_contrato: tokenContrato })
    });
    const detalhe = await detalheResp.json();
    if (detalhe.Erro) return { erro: detalhe.Erro };

    return { fases: detalhe.status || [] };
  }, { numero, token: bearerToken, usuarioId: identificadorUsuario });
}

// ----- PARSEAR FASES DO INNERTEXT DA ABA STATUS -----
// Recebe o texto bruto do modal e devolve array com os nomes das fases
// Logica: pula tudo antes de "Status", descarta linhas de metadados (datas, horas,
//         "Fase inicial:", "Observacao:", "Criado por:"), para em "Cancelar proposta"
function parsearFasesUI(texto) {
  const linhas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const nomes  = [];
  let dentroStatus = false;

  for (const linha of linhas) {
    // So começa a capturar depois de encontrar a aba "Status"
    if (linha === 'Status') { dentroStatus = true; continue; }
    if (!dentroStatus) continue;

    // Fim do conteudo de fases
    if (linha.toLowerCase().includes('cancelar proposta')) break;

    // Linhas de metadado de cada fase — pula
    if (linha.startsWith('Fase inicial:')) continue;
    if (linha.startsWith('Observação:'))  continue;
    if (linha.startsWith('Criado por:'))  continue;
    if (/^\d{2}\/\d{2}\/\d{4}/.test(linha)) continue; // datas (ex: 01/03/2026)
    if (/^\d{2}:\d{2}/.test(linha))          continue; // horas (ex: 14:30)
    if (linha === '-') continue;

    // O que sobra e nome de fase
    nomes.push(linha);
  }

  return nomes;
}

// ----- AUTO-DESCOBERTA DE NOMES DE FASES -----
// Apos o loop principal, navega pela UI do portal para descobrir os nomes legiveis
// de codigos que nao estavam no depara-fases.json.
// Funciona assim:
//   1. Para cada codigo novo, ja temos salva qual proposta teve esse codigo (propostasComCodigos)
//   2. Navega no portal ate a aba Status dessa proposta
//   3. Le o innerText (nomes legiveis) e cruza com os codigos da API por posicao de indice
//   4. Salva os nomes descobertos no depara-fases.json
async function descobrirNomesFases(page) {
  const novosKeys = Object.keys(codigosNovos);
  if (novosKeys.length === 0) return;

  log('[Auto-descoberta] ' + novosKeys.length + ' codigo(s) novo(s): ' + novosKeys.join(', '));

  // Agrupa codigos por proposta para fazer apenas uma visita por proposta
  // Ex: { '1800123': ['27', '42'], '1801456': ['33'] }
  const propostasNecessarias = {};
  for (const codigo of novosKeys) {
    if (!propostasComCodigos[codigo]) continue;
    const num = String(propostasComCodigos[codigo].numero);
    if (!propostasNecessarias[num]) propostasNecessarias[num] = [];
    propostasNecessarias[num].push(codigo);
  }

  for (const [numero, codigos] of Object.entries(propostasNecessarias)) {
    log('[Auto-descoberta] -> Proposta ' + numero + ' (codigos: ' + codigos.join(', ') + ')');
    try {
      // Navega para a pagina de Contratos pelo menu lateral (evita conflito com o titulo da pagina)
      await page.locator('li.ant-menu-item:has-text("Contratos")').click();
      await page.waitForSelector('button:has-text("Relatórios")', { state: 'visible', timeout: 15000 });
      await pausa(800, 1200);

      // Pesquisa o contrato pelo numero
      await page.locator('input.ant-input:not([type="hidden"])').first().fill(String(numero));
      await pausa(500, 800);
      await page.getByRole('button', { name: /Pesquisar/ }).click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await page.waitForSelector('tr.ant-table-row', { state: 'visible', timeout: 15000 });
      await pausa(600, 1000);

      // Clica na linha para abrir o modal do contrato
      await page.locator('tr.ant-table-row td').first().click();
      await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 15000 });
      await pausa(800, 1200);

      // Clica na aba Status para ver o historico de fases
      await page.getByRole('tab', { name: 'Status' }).click();
      await pausa(1500, 2500);

      // Le o texto renderizado — aqui os nomes das fases aparecem legiveis
      const textoModal = await page.locator('[role="dialog"]').evaluate(el => el.innerText);
      const nomesUI    = parsearFasesUI(textoModal);

      // Pega as fases da API que foram salvas durante o loop principal
      const fasesAPI = propostasComCodigos[codigos[0]].fases;
      log('[Auto-descoberta] UI: ' + nomesUI.length + ' fase(s) | API: ' + fasesAPI.length + ' fase(s)');

      if (nomesUI.length > 0 && fasesAPI.length === nomesUI.length) {
        // Cruza por indice: fasesAPI[i].nome = codigo numerico, nomesUI[i] = nome legivel
        // Se a ordem estiver invertida entre UI e API, pode ajustar com nomesUI.reverse()
        for (let i = 0; i < fasesAPI.length; i++) {
          const cod = String(fasesAPI[i].nome);
          if (codigosNovos[cod] && nomesUI[i]) {
            depara[cod] = nomesUI[i];
            delete codigosNovos[cod]; // marca como descoberto
            log('     ' + cod + ' -> "' + nomesUI[i] + '"');
          }
        }
      } else {
        log('[Auto-descoberta] Contagem diverge — pulando proposta ' + numero);
      }

      // Fecha o modal
      await page.keyboard.press('Escape');
      await pausa(500, 800);

    } catch(e) {
      log('[Auto-descoberta] Erro na proposta ' + numero + ': ' + e.message);
    }

    await pausa(1500, 3000);
  }

  // Salva o depara-fases.json atualizado com os novos nomes descobertos
  // Ordena as chaves numericamente para manter o arquivo organizado
  const deparaOrdenado = Object.fromEntries(
    Object.entries(depara).sort((a, b) => Number(a[0]) - Number(b[0]))
  );
  fs.writeFileSync(DEPARA_PATH, JSON.stringify(deparaOrdenado, null, 2), 'utf8');
  log('[Auto-descoberta] depara-fases.json salvo!');

  // Codigos que nao conseguimos descobrir (adicionar manualmente depois)
  const naoDescobertos = Object.keys(codigosNovos);
  if (naoDescobertos.length > 0) {
    log('[Auto-descoberta] Nao descobertos (adicionar manualmente): ' + naoDescobertos.join(', '));
  }
}

// ----- REPROCESSAR REGISTROS COM PLACEHOLDERS -----
// Apos a auto-descoberta, alguns registros foram salvos com "(Fase XX)".
// Esta funcao re-traduz as fases com o depara atualizado e re-salva no Supabase,
// tornando o fluxo totalmente automatico (sem precisar do descobrir-fases.js manual).
async function reprocessarRegistros() {
  const ids = Object.keys(registrosParaReprocessar);
  if (ids.length === 0) return;

  log('');
  log('[Reprocessar] ' + ids.length + ' registro(s) salvos com placeholder para atualizar...');

  let atualizados = 0;
  for (const rowId of ids) {
    const { id, fases } = registrosParaReprocessar[rowId];

    // Re-monta o historico usando o depara agora atualizado com os nomes descobertos
    const linhas = fases.map(fase => {
      const nome   = depara[String(fase.nome)] || '(Fase ' + fase.nome + ')';
      const obsRaw = fase.descricao_mesa || '';
      const obs    = (obsRaw && obsRaw.trim() && obsRaw.trim() !== '-') ? obsRaw.trim() : '';
      return nome + (obs ? ' | ' + obs : '');
    });
    const novoHistorico = linhas.join('\n');

    if (!novoHistorico.includes('(Fase ')) {
      // Todos os codigos foram descobertos — salva o historico com nomes reais
      await atualizarMotivo(id, 'Consultado Happy', novoHistorico);
      log('  [Reprocessar] id ' + id + ' atualizado com nomes reais.');
      atualizados++;
    } else {
      // Ainda restam codigos nao descobertos — mantem como esta (usuario vai ver no log)
      log('  [Reprocessar] id ' + id + ' ainda tem fases nao mapeadas — mantido com placeholder.');
    }
  }

  log('[Reprocessar] ' + atualizados + ' de ' + ids.length + ' registro(s) atualizados.');
}

// ----- ROBO PRINCIPAL -----
async function rodarRobo() {
  log('');
  log('==============================================');
  log('  Robo Cancelamentos - Happy > Supabase v2');
  log('==============================================');

  const inicio   = Date.now();
  const propostas = await buscarPropostas();
  if (propostas.length === 0) { log('Nenhuma proposta pendente!'); return; }

  let browser;
  try {
    log('[Happy] Iniciando navegador (headless)...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    // Intercepta respostas de rede para capturar o token JWT e o ID do usuario.
    // Como bearerToken e identificadorUsuario sao variaveis de modulo, elas sao
    // atualizadas automaticamente tanto no login inicial quanto no re-login.
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/auth/permissoes-usuario/')) {
        try { const d = await response.json(); identificadorUsuario = d.unique_id; } catch(e) {}
      }
      if (url.includes('/api/auth/select-corban/')) {
        try { const d = await response.json(); if (d.access) bearerToken = d.access; } catch(e) {}
      }
    });

    // LOGIN INICIAL — tenta credencial 1; se falhar, tenta credencial 2
    const loginOk = await fazerLoginComFallback(page);
    if (!loginOk) return; // QR Code em todas as credenciais — N8N ja foi notificado

    let ok = 0, erro = 0, semStatus = 0;
    let errosConsecutivos = 0; // detecta quando a sessao expirou (muitos "nao encontrado" seguidos)

    log('[Loop] Processando ' + propostas.length + ' proposta(s)...');

    for (const row of propostas) {
      const numero = row[COL_PROTOCOLO];
      log('  -> Proposta ' + numero + '...');

      try {
        let resultado = await consultarPropostaAPI(page, numero);

        // Detecta sessao expirada: 3+ erros "nao encontrado" consecutivos
        // Quando o token expira, a API retorna lista vazia para todas as propostas.
        // Fazer re-login resolve o problema e tentamos a proposta novamente.
        if (resultado.erro === 'nao encontrado') {
          errosConsecutivos++;

          if (errosConsecutivos >= 3) {
            log('  [Re-login] ' + errosConsecutivos + ' erros seguidos — sessao provavelmente expirou. Re-logando...');
            const reloginOk = await fazerLoginComFallback(page);
            if (!reloginOk) return; // QR Code no re-login
            errosConsecutivos = 0;
            log('  [Re-login] Concluido. Retentando proposta ' + numero + '...');
            // Retenta com o novo token
            resultado = await consultarPropostaAPI(page, numero);
          }
        } else {
          errosConsecutivos = 0; // reseta quando ha sucesso
        }

        if (resultado.erro) {
          log('     ERRO: ' + resultado.erro);
          erro++;
        } else {
          errosConsecutivos = 0;
          const fases  = resultado.fases || [];
          const linhas = fases.map(fase => {
            // Passa numero e fases para traduzirFase poder guardar referencia
            const nome   = traduzirFase(fase.nome, numero, fases);
            const obsRaw = fase.descricao_mesa || '';
            const obs    = (obsRaw && obsRaw.trim() && obsRaw.trim() !== '-') ? obsRaw.trim() : '';
            return nome + (obs ? ' | ' + obs : '');
          });
          const textoHistorico = linhas.join('\n');

          if (!textoHistorico.trim()) {
            await atualizarMotivo(row.id, 'Sem historico Happy', '');
            log('     Sem historico.');
            semStatus++;
          } else {
            await atualizarMotivo(row.id, 'Consultado Happy', textoHistorico);
            log('     OK — ' + fases.length + ' fase(s).');
            ok++;
            // Se alguma fase ficou com placeholder, guarda para reprocessar apos a auto-descoberta
            if (textoHistorico.includes('(Fase ')) {
              registrosParaReprocessar[row.id] = { id: row.id, fases };
            }
          }
        }
      } catch (e) {
        log('     ERRO: ' + e.message);
        erro++;
      }

      // Pausa humana entre propostas: 1.5s a 4s
      await pausa(1500, 4000);

      // A cada 50 propostas, descansa 30s
      const processadas = ok + semStatus + erro;
      if (processadas > 0 && processadas % 50 === 0) {
        log('  [Pausa longa] ' + processadas + ' processadas — aguardando 30s...');
        await pausa(30000, 35000);
      }
    }

    // AUTO-DESCOBERTA: navega pela UI para mapear os codigos novos a nomes legiveis
    // e salva automaticamente no depara-fases.json
    if (Object.keys(codigosNovos).length > 0) {
      log('');
      log('[Auto-descoberta] Iniciando mapeamento de ' + Object.keys(codigosNovos).length + ' codigo(s) novo(s)...');
      await descobrirNomesFases(page);
      // Reprocessa automaticamente os registros que foram salvos com placeholder (Fase XX)
      await reprocessarRegistros();
    }

    const novosDescobertos   = Object.keys(depara).filter(k => !JSON.parse(fs.readFileSync(DEPARA_PATH, 'utf8'))[k]);
    const naoDescobertos     = Object.keys(codigosNovos);
    const duracaoMin         = Math.round((Date.now() - inicio) / 60000);
    const resumo = {
      ok, semHistorico: semStatus, erros: erro,
      duracaoMinutos: duracaoMin,
      codigosNovosDescobertos: novosDescobertos,
      codigosNaoDescobertos:   naoDescobertos,
      data: new Date().toISOString()
    };

    log('');
    log('==============================================');
    log('  Concluido em ' + duracaoMin + ' min!');
    log('  OK Atualizados: ' + ok);
    log('  Sem historico:  ' + semStatus);
    log('  Erros:          ' + erro);
    if (novosDescobertos.length > 0) log('  Fases descobertas: ' + novosDescobertos.join(', '));
    if (naoDescobertos.length   > 0) log('  Fases pendentes:   ' + naoDescobertos.join(', '));
    log('==============================================');

    await notificar(WEBHOOK_CONCLUSAO, resumo);
    await notificar(WEBHOOK_FLUXO_FINALIZADO, resumo);

  } catch (e) {
    log('[ERRO GERAL] ' + e.message);
    await notificar(WEBHOOK_CONCLUSAO, { erro: e.message, data: new Date().toISOString() });
    await notificar(WEBHOOK_FLUXO_FINALIZADO, { erro: e.message, data: new Date().toISOString() });
  } finally {
    if (browser) await browser.close();
  }
}

rodarRobo();
