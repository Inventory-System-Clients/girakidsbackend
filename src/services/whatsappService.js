import crypto from "crypto";
import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { Pedido, Usuario, WhatsappMensagem, WhatsappOptOut } from "../models/index.js";
import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";
import { cifrarCredenciais, decifrarCredenciais } from "../utils/cofreCredenciais.js";
import { ENDERECO_LOJA_PADRAO } from "../utils/formasPagamento.js";
import { erroHttp } from "../utils/helpers.js";

// Avisos de pedido no WhatsApp pela Evolution API (mesma base do GrupoGK e do
// Dubob). Os avisos entram numa fila gravada no banco e saem um por vez, com
// pausa variada entre eles para não parecer disparo em massa. O pedido nunca
// depende do WhatsApp: se a Evolution cair, a fila só espera.
//
// Etapas:
//   CRIADO     pedido finalizado (pelo cliente ou pela equipe para ele)
//   PRONTO     expedição concluiu a montagem (texto de retirada ou de envio)
//   A_CAMINHO  pedido expedido: coletado pela transportadora / postado
// O cliente responde SAIR e para de receber; VOLTAR liga de novo.

const CHAVE_CONFIG = "whatsappAvisos";
const PROVEDOR_COFRE = "whatsapp-evolution";

export const ETAPAS = ["CRIADO", "PRONTO", "A_CAMINHO"];
const INTERVALO_PADRAO = 15;
const INTERVALO_MINIMO = 8;
const MAX_TENTATIVAS = 3;
// Aviso preso na fila além disso não sai mais (chegaria fora de hora).
const VALIDADE_HORAS = 12;
const TEXTO_MAX = 1000;

const PALAVRAS_SAIR = [
  "SAIR",
  "PARAR",
  "STOP",
  "CANCELAR",
  "DESCADASTRAR",
  "NAO QUERO",
  "NAO QUERO MAIS",
  "NAO QUERO RECEBER",
  "NAO QUERO MAIS RECEBER",
  "NAO QUERO MAIS RECEBER AVISOS",
  "NAO ENVIE MAIS",
  "NAO MANDE MAIS",
];
const PALAVRAS_VOLTAR = ["VOLTAR", "ATIVAR", "QUERO RECEBER", "RECEBER AVISOS"];

export const RODAPE = "_Mensagem automática da Gira Kids. Para não receber mais estes avisos, responda SAIR._";

// Variáveis: {nome}, {pedido}, {envio}, {rastreio}, {endereco}
export const TEXTOS_PADRAO = {
  CRIADO:
    "Olá, {nome}! 💛\n\n" +
    "Recebemos o seu pedido *{pedido}* aqui na Gira Kids. Muito obrigado pela confiança e pela preferência! 🎡\n\n" +
    "Nossa equipe já vai cuidar de tudo com carinho, e avisamos por aqui assim que ele estiver pronto.",
  PRONTO_RETIRADA:
    "Oi, {nome}! 🎉\n\n" +
    "Seu pedido *{pedido}* está prontinho e já pode ser retirado na nossa loja:\n📍 {endereco}\n\n" +
    "Estamos te esperando! Obrigado por comprar com a Gira Kids 💛",
  PRONTO_ENVIO:
    "Oi, {nome}! 🎉\n\n" +
    "Seu pedido *{pedido}* está pronto e foi embalado com todo o cuidado. Ele será enviado {envio}, e avisamos por aqui assim que estiver a caminho.\n\n" +
    "Obrigado por comprar com a Gira Kids 💛",
  A_CAMINHO:
    "Oi, {nome}! 🚚\n\n" +
    "Boa notícia: seu pedido *{pedido}* já está a caminho! Ele saiu {envio}.\n" +
    "Código de rastreio: *{rastreio}*\n\n" +
    "Qualquer dúvida, é só chamar a gente. Obrigado pela parceria! 💛",
};
const CHAVES_TEXTO = Object.keys(TEXTOS_PADRAO);

let processando = false;
let timer = null;
let pausa = null;

// ---------------------------------------------------------------------------
// Telefone
// ---------------------------------------------------------------------------

// 55 + DDD + número; null se não der para usar.
export const normalizarTelefone = (telefone) => {
  let digitos = String(telefone || "").replace(/\D/g, "").replace(/^0+/, "");
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  return /^55\d{10,11}$/.test(digitos) ? digitos : null;
};

// Mesma chave com ou sem o 9º dígito do celular (55 + DDD + 8 últimos).
export const chaveTelefone = (telefone) => {
  const numero = normalizarTelefone(telefone);
  return numero ? `${numero.slice(0, 4)}${numero.slice(-8)}` : null;
};

const mesmoTelefoneSql = (coluna, chave) =>
  sequelize.where(sequelize.fn("regexp_replace", sequelize.col(coluna), "\\D", "", "g"), { [Op.like]: `%${chave.slice(-8)}` });

const usuariosDoTelefone = async (chave) => {
  const candidatos = await Usuario.findAll({ where: mesmoTelefoneSql("telefone", chave), attributes: ["id", "telefone"] });
  return candidatos.filter((u) => chaveTelefone(u.telefone) === chave);
};

// ---------------------------------------------------------------------------
// Configuração (chave da Evolution criptografada no cofre)
// ---------------------------------------------------------------------------

const lerConfig = async () => {
  const salvo = (await lerConfiguracao(CHAVE_CONFIG)) || {};
  let apiKey = null;
  if (salvo.apiKeyCifrada) {
    try {
      apiKey = decifrarCredenciais(PROVEDOR_COFRE, salvo.apiKeyCifrada).apiKey;
    } catch {
      apiKey = null;
    }
  }
  return {
    ativo: Boolean(salvo.ativo),
    evolutionUrl: salvo.evolutionUrl || null,
    instancia: salvo.instancia || null,
    apiKey,
    apiKeyCifrada: salvo.apiKeyCifrada || null,
    intervaloSegundos: Number(salvo.intervaloSegundos) || INTERVALO_PADRAO,
    etapas: Array.isArray(salvo.etapas) ? salvo.etapas.filter((e) => ETAPAS.includes(e)) : [...ETAPAS],
    textos: { ...TEXTOS_PADRAO, ...(salvo.textos || {}) },
    webhookToken: salvo.webhookToken || null,
    atualizadoPor: salvo.atualizadoPor || null,
    atualizadoEm: salvo.atualizadoEm || null,
  };
};

const gravarConfig = async (config, usuarioNome) => {
  const { apiKey: _apiKey, ...resto } = config;
  await salvarConfiguracao(CHAVE_CONFIG, { ...resto, atualizadoPor: usuarioNome || null, atualizadoEm: new Date().toISOString() });
};

// Para a tela do admin: a chave nunca volta, nem em parte.
export const obterConfig = async () => {
  const c = await lerConfig();
  return {
    ativo: c.ativo,
    evolutionUrl: c.evolutionUrl,
    instancia: c.instancia,
    apiKeyConfigurada: Boolean(c.apiKey),
    intervaloSegundos: c.intervaloSegundos,
    etapas: c.etapas,
    textos: c.textos,
    textosPadrao: TEXTOS_PADRAO,
    rodape: RODAPE,
    atualizadoPor: c.atualizadoPor,
    atualizadoEm: c.atualizadoEm,
  };
};

export const salvarConfig = async (payload = {}, usuarioNome) => {
  const atual = await lerConfig();
  const novo = { ...atual };

  if (payload.evolutionUrl !== undefined) {
    const url = String(payload.evolutionUrl || "").trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw erroHttp(400, "A URL da Evolution API deve começar com https://");
    novo.evolutionUrl = url || null;
  }
  if (payload.instancia !== undefined) {
    const instancia = String(payload.instancia || "").trim();
    if (instancia && !/^[\w.-]{1,60}$/.test(instancia)) throw erroHttp(400, "Nome da instância: use letras, números, ponto, hífen ou _.");
    novo.instancia = instancia || null;
  }
  if (payload.apiKey !== undefined && String(payload.apiKey).trim()) {
    novo.apiKey = String(payload.apiKey).trim();
    novo.apiKeyCifrada = cifrarCredenciais(PROVEDOR_COFRE, { apiKey: novo.apiKey });
  }
  if (payload.intervaloSegundos !== undefined) {
    const segundos = Number(payload.intervaloSegundos);
    if (!Number.isInteger(segundos) || segundos < INTERVALO_MINIMO || segundos > 600) {
      throw erroHttp(400, `O intervalo entre mensagens deve ficar entre ${INTERVALO_MINIMO} e 600 segundos.`);
    }
    novo.intervaloSegundos = segundos;
  }
  if (payload.etapas !== undefined) {
    if (!Array.isArray(payload.etapas) || payload.etapas.some((e) => !ETAPAS.includes(e))) throw erroHttp(400, "Etapas inválidas.");
    novo.etapas = [...new Set(payload.etapas)];
  }
  if (payload.textos !== undefined) {
    if (!payload.textos || typeof payload.textos !== "object") throw erroHttp(400, "Textos inválidos.");
    const textos = { ...atual.textos };
    for (const chave of CHAVES_TEXTO) {
      if (payload.textos[chave] === undefined) continue;
      const texto = String(payload.textos[chave] ?? "").trim();
      if (texto.length > TEXTO_MAX) throw erroHttp(400, `Cada mensagem pode ter no máximo ${TEXTO_MAX} caracteres.`);
      // Vazio volta para o texto padrão.
      textos[chave] = texto || TEXTOS_PADRAO[chave];
    }
    novo.textos = textos;
  }
  if (payload.ativo !== undefined) novo.ativo = Boolean(payload.ativo);

  if (novo.ativo && (!novo.evolutionUrl || !novo.apiKey || !novo.instancia)) {
    throw erroHttp(400, "Preencha URL, chave e instância da Evolution API antes de ligar os avisos.");
  }

  await gravarConfig(novo, usuarioNome);
  agendar(1000);
  return obterConfig();
};

// ---------------------------------------------------------------------------
// Evolution API
// ---------------------------------------------------------------------------

const evolution = async (config, caminho, { method = "GET", body } = {}) => {
  if (!config?.evolutionUrl || !config?.apiKey) throw erroHttp(400, "Configure a URL e a chave da Evolution API.");
  let resposta;
  try {
    resposta = await fetch(`${config.evolutionUrl}${caminho}`, {
      method,
      headers: { apikey: config.apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw erroHttp(502, `Não foi possível falar com a Evolution API: ${error.message}`);
  }
  const texto = await resposta.text();
  let dados = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = { message: texto };
  }
  if (!resposta.ok) {
    const bruto = dados?.response?.message ?? dados?.message ?? dados?.error ?? resposta.statusText;
    const detalhe = Array.isArray(bruto) ? bruto.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("; ") : String(bruto);
    const semWhatsapp = /"exists":\s*false/.test(detalhe);
    const erro = erroHttp(
      resposta.status === 404 ? 404 : 502,
      resposta.status === 401 || resposta.status === 403
        ? "A Evolution API recusou a chave (apikey). Confira a configuração."
        : semWhatsapp
          ? "Este número não tem WhatsApp."
          : `Evolution API respondeu ${resposta.status}: ${detalhe}`,
    );
    erro.httpStatus = resposta.status;
    erro.semWhatsapp = semWhatsapp;
    throw erro;
  }
  return dados;
};

const estadoConexao = async (config) => {
  const r = await evolution(config, `/instance/connectionState/${encodeURIComponent(config.instancia)}`);
  return r?.instance?.state || r?.state || "unknown";
};

export const obterConexao = async () => {
  const config = await lerConfig();
  if (!config.evolutionUrl || !config.apiKey || !config.instancia) return { configurado: false, estado: null };
  try {
    return { configurado: true, estado: await estadoConexao(config) };
  } catch (error) {
    // Instância ainda não criada não é erro: ela é criada ao conectar.
    if (error.httpStatus === 404) return { configurado: true, estado: "inexistente" };
    return { configurado: true, estado: "erro", erro: error.message };
  }
};

// Webhook que recebe as respostas dos clientes (para o SAIR). O token
// secreto vai na URL; sem ele a rota responde 404.
const configurarWebhook = async (config, baseUrl) => {
  if (!baseUrl) return;
  try {
    let token = config.webhookToken;
    if (!token) {
      token = crypto.randomBytes(24).toString("hex");
      const salvo = (await lerConfiguracao(CHAVE_CONFIG)) || {};
      await salvarConfiguracao(CHAVE_CONFIG, { ...salvo, webhookToken: token });
    }
    await evolution(config, `/webhook/set/${encodeURIComponent(config.instancia)}`, {
      method: "POST",
      body: {
        webhook: {
          enabled: true,
          // Aceita a base com ou sem "/api" no fim.
          url: `${baseUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api/whatsapp/webhook/${token}`,
          byEvents: false,
          base64: false,
          events: ["MESSAGES_UPSERT"],
        },
      },
    });
  } catch (error) {
    // Sem webhook só o SAIR não funciona; os avisos continuam.
    console.error("[whatsapp] webhook:", error.message);
  }
};

// QR Code para conectar o número; cria a instância se precisar e liga o
// webhook das respostas.
export const conectar = async ({ baseUrl } = {}) => {
  const config = await lerConfig();
  if (!config.evolutionUrl || !config.apiKey || !config.instancia) {
    throw erroHttp(400, "Salve URL, chave e instância da Evolution API antes de conectar.");
  }
  const estado = await estadoConexao(config).catch((error) => {
    if (error.httpStatus === 404) return "inexistente";
    throw error;
  });

  let r = null;
  if (estado === "inexistente") {
    r = await evolution(config, "/instance/create", {
      method: "POST",
      body: { instanceName: config.instancia, integration: "WHATSAPP-BAILEYS", qrcode: true },
    });
    r = r?.qrcode || r;
  }
  await configurarWebhook(await lerConfig(), baseUrl);
  if (estado === "open") return { estado, qrBase64: null, pairingCode: null };
  if (!r) r = await evolution(config, `/instance/connect/${encodeURIComponent(config.instancia)}`);

  const base64 = r?.base64 || null;
  return {
    estado: "connecting",
    qrBase64: base64 && !base64.startsWith("data:") ? `data:image/png;base64,${base64}` : base64,
    pairingCode: r?.pairingCode || null,
  };
};

// Confere se o número tem WhatsApp e devolve o número exato que o WhatsApp
// usa (com ou sem o 9º dígito). null = não tem WhatsApp. Se a consulta
// falhar, tenta enviar para o número como está.
const numeroNoWhatsapp = async (config, numero) => {
  try {
    const r = await evolution(config, `/chat/whatsappNumbers/${encodeURIComponent(config.instancia)}`, {
      method: "POST",
      body: { numbers: [numero] },
    });
    const item = Array.isArray(r) ? r[0] : null;
    if (!item) return numero;
    if (item.exists === false) return null;
    return String(item.jid || item.number || numero).split("@")[0] || numero;
  } catch (error) {
    if (error.semWhatsapp) return null;
    return numero;
  }
};

const enviarTexto = (config, numero, texto) =>
  evolution(config, `/message/sendText/${encodeURIComponent(config.instancia)}`, {
    method: "POST",
    body: { number: numero, text: texto, delay: 1200 },
  });

export const enviarTeste = async (telefone) => {
  const numero = normalizarTelefone(telefone);
  if (!numero) throw erroHttp(400, "Celular inválido. Use DDD + número.");
  const config = await lerConfig();
  const destino = await numeroNoWhatsapp(config, numero);
  if (!destino) throw erroHttp(400, "Este número não tem WhatsApp.");
  await enviarTexto(config, destino, "Teste da Gira Kids: os avisos de pedido no WhatsApp estão funcionando. 💛");
  return { enviado: true, numero: destino };
};

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

// Pessoa física: primeiro nome. Empresa (CNPJ): nome completo.
const nomeDoCliente = (pedido) => {
  const nome = String(pedido.cliente?.nome || pedido.clienteNome || "").trim();
  if (!nome) return "";
  const tipo = pedido.cliente?.documentoTipo || pedido.documentoTipo;
  if (tipo === "CNPJ") return nome;
  const primeiro = nome.split(/\s+/)[0];
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
};

const descreverEnvio = (pedido) => {
  switch (pedido.metodoEnvio) {
    case "PAC":
      return "pelos Correios (PAC)";
    case "SEDEX":
      return "pelos Correios (SEDEX)";
    case "TRANSPORTADORA":
      return pedido.transportadoraNome ? `pela transportadora ${pedido.transportadoraNome}` : "pela transportadora";
    default:
      return "";
  }
};

// Troca as variáveis; quando falta o dado, tira o trecho sem deixar buraco
// ("Olá, {nome}!" vira "Olá!", a linha do {rastreio} some).
export const preencherTexto = (modelo, valores) => {
  let texto = String(modelo || "");
  for (const [chave, valor] of Object.entries(valores)) {
    const marca = new RegExp(`\\{${chave}\\}`, "gi");
    if (valor) {
      texto = texto.replace(marca, valor);
    } else if (chave === "rastreio" || chave === "endereco") {
      const naLinha = new RegExp(`\\{${chave}\\}`, "i");
      texto = texto
        .split("\n")
        .filter((linha) => !naLinha.test(linha))
        .join("\n");
    } else {
      texto = texto.replace(new RegExp(`[,\\s]*\\{${chave}\\}`, "gi"), "");
    }
  }
  return texto.replace(/\n{3,}/g, "\n\n").trim();
};

const chaveDoTexto = (etapa, pedido) =>
  etapa === "PRONTO" ? (pedido.metodoEnvio === "RETIRAR_LOCAL" ? "PRONTO_RETIRADA" : "PRONTO_ENVIO") : etapa;

export const montarMensagem = (etapa, pedido, textos = TEXTOS_PADRAO, endereco = ENDERECO_LOJA_PADRAO) => {
  const chave = chaveDoTexto(etapa, pedido);
  const texto = preencherTexto(textos[chave] || TEXTOS_PADRAO[chave], {
    nome: nomeDoCliente(pedido),
    pedido: `#${pedido.numero}`,
    envio: descreverEnvio(pedido),
    rastreio: pedido.codigoRastreio || "",
    endereco,
  });
  return `${texto}\n\n${RODAPE}`;
};

// ---------------------------------------------------------------------------
// Opt-out (SAIR / VOLTAR)
// ---------------------------------------------------------------------------

export const telefoneSaiu = async (telefone) => {
  const chave = chaveTelefone(telefone);
  return chave ? Boolean(await WhatsappOptOut.findByPk(chave)) : false;
};

const sairDosAvisos = async (telefone, origem) => {
  const chave = chaveTelefone(telefone);
  if (!chave) return;
  await WhatsappOptOut.upsert({ chave, telefone: normalizarTelefone(telefone), origem });
  const usuarios = await usuariosDoTelefone(chave);
  if (usuarios.length) await Usuario.update({ whatsappAvisos: false }, { where: { id: usuarios.map((u) => u.id) } });
  // O que ainda estava na fila para esse número não sai mais.
  const naFila = await WhatsappMensagem.findAll({ where: { status: "FILA", [Op.and]: [mesmoTelefoneSql("telefone", chave)] } });
  for (const m of naFila.filter((x) => chaveTelefone(x.telefone) === chave)) {
    await m.update({ status: "DESCARTADA", erro: "Cliente pediu para não receber avisos." });
  }
};

const voltarAosAvisos = async (telefone) => {
  const chave = chaveTelefone(telefone);
  if (!chave) return;
  await WhatsappOptOut.destroy({ where: { chave } });
  const usuarios = await usuariosDoTelefone(chave);
  if (usuarios.length) await Usuario.update({ whatsappAvisos: true }, { where: { id: usuarios.map((u) => u.id) } });
};

// Admin (cadastro do cliente) ou o próprio cliente (perfil) liga/desliga.
export const definirAvisosCliente = async (usuario, ativo) => {
  await usuario.update({ whatsappAvisos: Boolean(ativo) });
  if (!usuario.telefone) return;
  if (ativo) await voltarAosAvisos(usuario.telefone);
  else await sairDosAvisos(usuario.telefone, "CADASTRO");
};

const normalizarResposta = (texto) =>
  String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Número de quem respondeu. Em contas novas o WhatsApp manda um "@lid" no
// lugar do número; aí o número real vem em remoteJidAlt/senderPn.
const telefoneDoRemetente = (data) => {
  const candidatos = [data?.key?.remoteJid, data?.key?.remoteJidAlt, data?.key?.senderPn, data?.senderPn, data?.key?.participant];
  for (const jid of candidatos) {
    const texto = String(jid || "");
    if (!texto || texto.endsWith("@g.us") || texto.endsWith("@lid") || texto.endsWith("@broadcast")) continue;
    const numero = normalizarTelefone(texto.split("@")[0].split(":")[0]);
    if (numero) return numero;
  }
  return null;
};

export const validarWebhookToken = async (token) => {
  const salvo = (await lerConfiguracao(CHAVE_CONFIG))?.webhookToken;
  const recebido = String(token || "");
  if (!salvo || recebido.length !== salvo.length) return false;
  return crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(salvo));
};

// Resposta do cliente. Só vale para quem já recebeu um aviso nosso (conversa
// normal com a loja no mesmo número não dispara nada).
export const receberWebhook = async (body) => {
  const lista = Array.isArray(body?.data) ? body.data : [body?.data];
  const resultados = [];
  for (const data of lista) {
    if (!data || data.key?.fromMe) continue;
    const texto = normalizarResposta(
      data.message?.conversation ?? data.message?.extendedTextMessage?.text ?? data.message?.buttonsResponseMessage?.selectedDisplayText ?? "",
    );
    const sair = PALAVRAS_SAIR.includes(texto);
    const voltar = PALAVRAS_VOLTAR.includes(texto);
    if (!sair && !voltar) continue;
    const telefone = telefoneDoRemetente(data);
    if (!telefone) continue;
    const chave = chaveTelefone(telefone);
    const recebeuAviso = (await WhatsappMensagem.findAll({ where: { status: "ENVIADO", [Op.and]: [mesmoTelefoneSql("telefone", chave)] }, attributes: ["telefone"], limit: 20 })).some(
      (m) => chaveTelefone(m.telefone) === chave,
    );
    if (!recebeuAviso) continue;

    const config = await lerConfig();
    if (sair) {
      await sairDosAvisos(telefone, "WHATSAPP");
      resultados.push({ optOut: telefone });
      enviarTexto(config, telefone, "Pronto! Você não vai mais receber os avisos automáticos de pedido da Gira Kids. Se mudar de ideia, é só responder VOLTAR. 💛").catch((error) =>
        console.error("[whatsapp] confirmação SAIR:", error.message),
      );
    } else {
      await voltarAosAvisos(telefone);
      resultados.push({ optIn: telefone });
      enviarTexto(config, telefone, "Combinado! Você volta a receber por aqui os avisos dos seus pedidos na Gira Kids. 💛").catch((error) =>
        console.error("[whatsapp] confirmação VOLTAR:", error.message),
      );
    }
  }
  return resultados;
};

// ---------------------------------------------------------------------------
// Eventos do pedido → fila
// ---------------------------------------------------------------------------

// Nunca lança erro: o WhatsApp não pode atrapalhar o pedido.
export const avisarPedido = async (pedidoId, etapa) => {
  try {
    if (!ETAPAS.includes(etapa) || !pedidoId) return null;
    const config = await lerConfig();
    if (!config.ativo || !config.etapas.includes(etapa)) return null;

    const pedido = await Pedido.findByPk(pedidoId, { include: [{ model: Usuario, as: "cliente", attributes: ["id", "nome", "telefone", "documentoTipo", "whatsappAvisos"] }] });
    if (!pedido || pedido.tipo !== "PEDIDO" || pedido.statusVendas === "CANCELADO") return null;
    // Retirada não tem "a caminho": quando expede, o cliente já está com ele.
    if (etapa === "A_CAMINHO" && (!pedido.metodoEnvio || pedido.metodoEnvio === "RETIRAR_LOCAL")) return null;
    if (pedido.cliente && pedido.cliente.whatsappAvisos === false) return null;

    const telefone = normalizarTelefone(pedido.cliente?.telefone) || normalizarTelefone(pedido.clienteTelefone);
    if (!telefone || (await telefoneSaiu(telefone))) return null;

    const endereco = (await lerConfiguracao("enderecoLoja")) || ENDERECO_LOJA_PADRAO;
    const [, criado] = await WhatsappMensagem.findOrCreate({
      where: { pedidoId: pedido.id, etapa },
      defaults: {
        pedidoNumero: pedido.numero,
        clienteNome: pedido.clienteNome,
        telefone,
        texto: montarMensagem(etapa, pedido, config.textos, endereco),
      },
    });
    if (criado) agendar(1000);
    return criado ? etapa : null;
  } catch (error) {
    console.error("[whatsapp] aviso do pedido:", error.message);
    return null;
  }
};

// Montagem desfeita: o "pronto" pode sair de novo quando concluir outra vez.
export const esquecerAviso = async (pedidoId, etapa) => {
  try {
    await WhatsappMensagem.destroy({ where: { pedidoId, etapa, status: { [Op.in]: ["FILA", "ERRO", "DESCARTADA"] } } });
  } catch (error) {
    console.error("[whatsapp] esquecer aviso:", error.message);
  }
};

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

export const obterStatus = async () => {
  const desde = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [config, conexao, naFila, enviadas, erros, recentes, sairam] = await Promise.all([
    obterConfig(),
    obterConexao(),
    WhatsappMensagem.count({ where: { status: { [Op.in]: ["FILA", "ENVIANDO"] } } }),
    WhatsappMensagem.count({ where: { status: "ENVIADO", enviadoEm: { [Op.gte]: desde } } }),
    WhatsappMensagem.count({ where: { status: "ERRO", updatedAt: { [Op.gte]: desde } } }),
    WhatsappMensagem.findAll({
      order: [["updatedAt", "DESC"]],
      limit: 30,
      attributes: ["id", "pedidoId", "pedidoNumero", "clienteNome", "etapa", "telefone", "status", "erro", "enviadoEm", "createdAt", "updatedAt"],
    }),
    WhatsappOptOut.count(),
  ]);
  return { config, conexao, fila: { naFila, enviadas24h: enviadas, erros24h: erros, pausa, recentes, sairam } };
};

export const reenviar = async (id) => {
  const m = await WhatsappMensagem.findByPk(id);
  if (!m) throw erroHttp(404, "Aviso não encontrado.");
  if (!["ERRO", "DESCARTADA"].includes(m.status)) throw erroHttp(400, "Só dá para reenviar avisos com erro ou descartados.");
  if (await telefoneSaiu(m.telefone)) throw erroHttp(400, "Este cliente pediu para não receber avisos.");
  // Volta para a fila com a data de agora (senão seria descartado por antigo).
  await m.update({ status: "FILA", erro: null, tentativas: 0 });
  await sequelize.query(`UPDATE whatsapp_mensagens SET "createdAt" = NOW() WHERE id = :id`, { replacements: { id: m.id } });
  agendar(500);
  return { reenviado: true };
};

// Um envio por vez; se o número estiver desconectado, espera 1 minuto.
export const processarFila = async () => {
  if (processando) return;
  processando = true;
  timer = null;
  let proximaEm = null;
  try {
    const config = await lerConfig();
    if (!config.ativo || !config.evolutionUrl || !config.apiKey || !config.instancia) {
      pausa = null;
      return;
    }
    const aviso = await WhatsappMensagem.findOne({ where: { status: "FILA" }, order: [["createdAt", "ASC"]] });
    if (!aviso) {
      pausa = null;
      return;
    }
    if (Date.now() - new Date(aviso.createdAt).getTime() > VALIDADE_HORAS * 60 * 60 * 1000) {
      await aviso.update({ status: "DESCARTADA", erro: `Ficou mais de ${VALIDADE_HORAS}h na fila (não enviado atrasado).` });
      proximaEm = 500;
      return;
    }

    let estado;
    try {
      estado = await estadoConexao(config);
    } catch (error) {
      estado = error.message;
    }
    if (estado !== "open") {
      pausa =
        estado === "close" || estado === "connecting"
          ? "WhatsApp desconectado. Conecte o número na tela Avisos no WhatsApp."
          : `Evolution API indisponível: ${estado}`;
      proximaEm = 60 * 1000;
      return;
    }
    pausa = null;

    // Reserva (só se ainda estiver na fila).
    const [reservadas] = await WhatsappMensagem.update(
      { status: "ENVIANDO", tentativas: aviso.tentativas + 1 },
      { where: { id: aviso.id, status: "FILA" } },
    );
    if (!reservadas) {
      proximaEm = 500;
      return;
    }

    try {
      if (await telefoneSaiu(aviso.telefone)) {
        await aviso.update({ status: "DESCARTADA", erro: "Cliente pediu para não receber avisos." });
        proximaEm = 500;
        return;
      }
      const destino = await numeroNoWhatsapp(config, aviso.telefone);
      if (!destino) {
        await aviso.update({ status: "ERRO", erro: "Este número não tem WhatsApp." });
      } else {
        await enviarTexto(config, destino, aviso.texto);
        await aviso.update({ status: "ENVIADO", enviadoEm: new Date(), erro: null, telefone: destino });
      }
    } catch (error) {
      const tentativas = aviso.tentativas + 1;
      const tentarDeNovo = !error.semWhatsapp && tentativas < MAX_TENTATIVAS;
      await aviso.update({ status: tentarDeNovo ? "FILA" : "ERRO", erro: String(error.message).slice(0, 500) });
      console.error(`[whatsapp] pedido ${aviso.pedidoNumero}:`, error.message);
    }
    // Pausa variada (±30%) para não parecer disparo automático.
    const base = Math.max(INTERVALO_MINIMO, config.intervaloSegundos) * 1000;
    proximaEm = Math.round(base * (0.7 + Math.random() * 0.6));
  } catch (error) {
    console.error("[whatsapp] fila:", error.message);
    proximaEm = 60 * 1000;
  } finally {
    processando = false;
    if (proximaEm !== null) agendar(proximaEm);
  }
};

function agendar(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    processarFila().catch((error) => console.error("[whatsapp] fila:", error.message));
  }, ms);
  timer.unref?.();
}

// Ao subir o servidor: o que ficou "enviando" volta para a fila.
export const iniciarFila = async () => {
  try {
    await WhatsappMensagem.update({ status: "FILA" }, { where: { status: "ENVIANDO" } });
  } catch (error) {
    console.error("[whatsapp] iniciar:", error.message);
    return;
  }
  agendar(15 * 1000);
};
