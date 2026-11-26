import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../database/connection.js";
import { Arquivo, Usuario, WhatsappCampanha, WhatsappCampanhaEnvio, WhatsappOptOut } from "../models/index.js";
import { erroHttp } from "../utils/helpers.js";
import { contem } from "../utils/busca.js";
import { agendar, atualizarStatusCampanha, chaveTelefone, lerConfig, normalizarTelefone, preencherTexto } from "./whatsappService.js";

// Listas pequenas de clientes para novidades, promoções e vídeos no WhatsApp.
// - até 20 clientes por lista (disparo grande chama atenção do WhatsApp);
// - recomendação: quem mais FAZ pedidos no período (quantidade, não valor);
// - "outra lista": recomenda clientes que ainda não estão nesta lista nem
//   foram sugeridos antes;
// - a IA escreve a mensagem a partir do produto e da foto/vídeo;
// - envio na hora ou agendado, pela mesma fila dos avisos (um por vez, com
//   pausa variada entre as mensagens).

export const MAX_CLIENTES = 20;
const TEXTO_MAX = 1000;
export const RODAPE_CAMPANHA = "_Para não receber mais nossas novidades por aqui, responda SAIR._";

const STATUS_EDITAVEL = ["RASCUNHO", "AGENDADA", "ENVIANDO", "CONCLUIDA"];

const MIDIAS = {
  "image/jpeg": "IMAGEM",
  "image/jpg": "IMAGEM",
  "image/png": "IMAGEM",
  "image/webp": "IMAGEM",
  "video/mp4": "VIDEO",
  "video/3gpp": "VIDEO",
  "video/quicktime": "VIDEO",
};
export const MIDIA_MAX_BYTES = 16 * 1024 * 1024; // limite de vídeo do WhatsApp

// Confere os primeiros bytes (arquivo renomeado não passa).
const conteudoConfere = (b, mime) => {
  const ini = (...bytes) => bytes.every((x, i) => b[i] === x);
  if (mime === "image/png") return ini(0x89, 0x50, 0x4e, 0x47);
  if (mime === "image/jpeg" || mime === "image/jpg") return ini(0xff, 0xd8, 0xff);
  if (mime === "image/webp") return ini(0x52, 0x49, 0x46, 0x46) && b.subarray(8, 12).toString() === "WEBP";
  // MP4 / MOV / 3GP: caixa "ftyp" (ou "moov"/"wide" em MOV antigo) no byte 4.
  return ["ftyp", "moov", "wide", "mdat", "free"].includes(b.subarray(4, 8).toString());
};

// Pessoa física: primeiro nome. Empresa (CNPJ): nome completo.
const nomeParaMensagem = (cliente) => {
  const nome = String(cliente?.nome || "").trim();
  if (!nome) return "";
  if (cliente.documentoTipo === "CNPJ") return nome;
  const primeiro = nome.split(/\s+/)[0];
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
};

export const textoFinal = (modelo, cliente) => `${preencherTexto(modelo, { nome: nomeParaMensagem(cliente) })}\n\n${RODAPE_CAMPANHA}`;

const chavesSairam = async () => new Set((await WhatsappOptOut.findAll({ attributes: ["chave"] })).map((o) => o.chave));

// ---------------------------------------------------------------------------
// Recomendação e busca de clientes
// ---------------------------------------------------------------------------

// Quem mais fez pedidos no período (quantidade). Fica de fora: quem já está
// na lista/foi sugerido (excluir), quem pediu SAIR, quem está sem celular e,
// por padrão, quem recebeu mensagem de lista nos últimos dias.
export const recomendar = async ({ dias = 90, excluir = [], campanhaId = null, semRepetirDias = 7, quantidade = MAX_CLIENTES } = {}) => {
  const periodo = Math.min(730, Math.max(7, Number(dias) || 90));
  const limite = Math.min(MAX_CLIENTES, Math.max(1, Number(quantidade) || MAX_CLIENTES));
  const desde = new Date(Date.now() - periodo * 24 * 60 * 60 * 1000);
  const uuid = /^[0-9a-f-]{36}$/i;
  const fora = new Set((Array.isArray(excluir) ? excluir : []).filter((id) => uuid.test(String(id))));
  if (campanhaId && uuid.test(campanhaId)) {
    const envios = await WhatsappCampanhaEnvio.findAll({ where: { campanhaId }, attributes: ["usuarioId"] });
    envios.forEach((e) => fora.add(e.usuarioId));
  }
  const repetir = Number(semRepetirDias);
  if (repetir > 0) {
    const recentes = await WhatsappCampanhaEnvio.findAll({
      where: { status: "ENVIADO", enviadoEm: { [Op.gte]: new Date(Date.now() - repetir * 24 * 60 * 60 * 1000) } },
      attributes: ["usuarioId"],
    });
    recentes.forEach((e) => fora.add(e.usuarioId));
  }

  const linhas = await sequelize.query(
    `SELECT u.id, u.nome, u.telefone, u."documentoTipo", COUNT(p.id)::int AS pedidos, MAX(p."createdAt") AS "ultimoPedido"
       FROM usuarios u
       JOIN pedidos p ON p."clienteId" = u.id
      WHERE u.role = 'CLIENTE' AND u.ativo = true AND u."whatsappAvisos" IS NOT FALSE
        AND u.telefone IS NOT NULL AND u.telefone <> ''
        AND p.tipo = 'PEDIDO' AND p."statusVendas" <> 'CANCELADO' AND p."createdAt" >= :desde
        ${fora.size ? "AND u.id NOT IN (:fora)" : ""}
      GROUP BY u.id
      ORDER BY pedidos DESC, "ultimoPedido" DESC
      LIMIT 200`,
    { replacements: { desde, fora: [...fora] }, type: QueryTypes.SELECT },
  );

  const sairam = await chavesSairam();
  const telefones = new Set();
  const lista = [];
  for (const l of linhas) {
    const chave = chaveTelefone(l.telefone);
    if (!chave || sairam.has(chave) || telefones.has(chave)) continue;
    telefones.add(chave);
    lista.push({ usuarioId: l.id, nome: l.nome, telefone: normalizarTelefone(l.telefone), pedidos: l.pedidos, ultimoPedido: l.ultimoPedido });
    if (lista.length >= limite) break;
  }
  return { periodoDias: periodo, clientes: lista };
};

// Busca manual para incluir alguém na lista (nome, e-mail ou celular).
export const buscarClientes = async (termo, dias = 90) => {
  const t = String(termo || "").trim();
  if (t.length < 2) return [];
  const digitos = t.replace(/\D/g, "");
  const where = {
    role: "CLIENTE",
    ativo: true,
    [Op.or]: [contem("nome", t), contem("email", t), ...(digitos.length >= 4 ? [{ telefone: { [Op.like]: `%${digitos}%` } }] : [])],
  };
  const usuarios = await Usuario.findAll({ where, attributes: ["id", "nome", "telefone", "whatsappAvisos"], limit: 15, order: [["nome", "ASC"]] });
  if (!usuarios.length) return [];
  const desde = new Date(Date.now() - Math.min(730, Math.max(7, Number(dias) || 90)) * 24 * 60 * 60 * 1000);
  const contagem = await sequelize.query(
    `SELECT "clienteId", COUNT(*)::int AS pedidos FROM pedidos
      WHERE "clienteId" IN (:ids) AND tipo = 'PEDIDO' AND "statusVendas" <> 'CANCELADO' AND "createdAt" >= :desde
      GROUP BY "clienteId"`,
    { replacements: { ids: usuarios.map((u) => u.id), desde }, type: QueryTypes.SELECT },
  );
  const pedidos = Object.fromEntries(contagem.map((c) => [c.clienteId, c.pedidos]));
  const sairam = await chavesSairam();
  return usuarios.map((u) => {
    const telefone = normalizarTelefone(u.telefone);
    const saiu = u.whatsappAvisos === false || (telefone && sairam.has(chaveTelefone(telefone)));
    return { usuarioId: u.id, nome: u.nome, telefone, pedidos: pedidos[u.id] || 0, bloqueio: !telefone ? "Sem celular válido" : saiu ? "Pediu para não receber" : null };
  });
};

// ---------------------------------------------------------------------------
// Listas
// ---------------------------------------------------------------------------

const resumoEnvios = async (ids) => {
  if (!ids.length) return {};
  const linhas = await WhatsappCampanhaEnvio.findAll({
    where: { campanhaId: ids },
    attributes: ["campanhaId", "status", [sequelize.fn("COUNT", sequelize.col("id")), "total"]],
    group: ["campanhaId", "status"],
    raw: true,
  });
  const resumo = {};
  for (const l of linhas) {
    resumo[l.campanhaId] ||= {};
    resumo[l.campanhaId][l.status] = Number(l.total);
  }
  return resumo;
};

const serializar = (c, envios = null, resumo = {}) => ({
  id: c.id,
  nome: c.nome,
  produtoNome: c.produtoNome,
  detalhes: c.detalhes,
  texto: c.texto,
  midiaArquivoId: c.midiaArquivoId,
  midiaTipo: c.midiaTipo,
  midiaNome: c.midiaNome,
  clientes: c.clientes || [],
  status: c.status,
  agendadaPara: c.agendadaPara,
  concluidaEm: c.concluidaEm,
  criadoPor: c.criadoPor,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  resumo: resumo[c.id] || {},
  ...(envios ? { envios: envios.map((e) => ({ id: e.id, usuarioId: e.usuarioId, clienteNome: e.clienteNome, telefone: e.telefone, status: e.status, erro: e.erro, enviadoEm: e.enviadoEm, programadoPara: e.programadoPara })) } : {}),
});

export const listar = async () => {
  const campanhas = await WhatsappCampanha.findAll({ order: [["updatedAt", "DESC"]], limit: 60 });
  const resumo = await resumoEnvios(campanhas.map((c) => c.id));
  return campanhas.map((c) => serializar(c, null, resumo));
};

export const obter = async (id) => {
  const c = await WhatsappCampanha.findByPk(id);
  if (!c) throw erroHttp(404, "Lista não encontrada.");
  const envios = await WhatsappCampanhaEnvio.findAll({ where: { campanhaId: id }, order: [["ordem", "ASC"]] });
  return serializar(c, envios, await resumoEnvios([id]));
};

// Recarrega nome e celular do cadastro (o navegador só manda os ids).
const carregarClientes = async (clientes) => {
  if (!Array.isArray(clientes)) throw erroHttp(400, "Lista de clientes inválida.");
  const ids = [...new Set(clientes.map((c) => String(c?.usuarioId || c?.id || "")).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (ids.length > MAX_CLIENTES) throw erroHttp(400, `Cada lista pode ter no máximo ${MAX_CLIENTES} clientes.`);
  if (!ids.length) return [];
  const usuarios = await Usuario.findAll({ where: { id: ids, role: "CLIENTE" }, attributes: ["id", "nome", "telefone", "documentoTipo"] });
  const porId = Object.fromEntries(usuarios.map((u) => [u.id, u]));
  const pedidosInformados = Object.fromEntries(clientes.map((c) => [String(c?.usuarioId || c?.id), Number(c?.pedidos) || 0]));
  return ids
    .filter((id) => porId[id])
    .map((id) => ({ usuarioId: id, nome: porId[id].nome, telefone: normalizarTelefone(porId[id].telefone), documentoTipo: porId[id].documentoTipo || null, pedidos: pedidosInformados[id] || 0 }));
};

const validarMidia = async (midiaArquivoId) => {
  if (!midiaArquivoId) return null;
  const arquivo = await Arquivo.findByPk(midiaArquivoId, { attributes: ["id", "mime", "nome"] });
  if (!arquivo || !MIDIAS[arquivo.mime]) throw erroHttp(400, "Imagem ou vídeo não encontrado. Envie o arquivo de novo.");
  return { midiaArquivoId: arquivo.id, midiaTipo: MIDIAS[arquivo.mime], midiaNome: arquivo.nome };
};

// Deixa as mensagens pendentes iguais à lista: tira quem saiu, atualiza o
// texto e coloca na fila quem entrou (lista já agendada ou enviando).
const sincronizarEnvios = async (campanha, transaction) => {
  const envios = await WhatsappCampanhaEnvio.findAll({ where: { campanhaId: campanha.id }, transaction });
  const naLista = new Map((campanha.clientes || []).map((c) => [c.usuarioId, c]));
  const quando = new Date(Math.max(Date.now(), new Date(campanha.agendadaPara || Date.now()).getTime()));
  for (const e of envios) {
    if (e.status !== "FILA") continue;
    const cliente = naLista.get(e.usuarioId);
    if (!cliente) await e.destroy({ transaction });
    else await e.update({ texto: textoFinal(campanha.texto, cliente), programadoPara: quando }, { transaction });
  }
  const jaTem = new Set(envios.map((e) => e.usuarioId));
  const sairam = await chavesSairam();
  let ordem = envios.reduce((m, e) => Math.max(m, e.ordem), 0);
  let novos = 0;
  for (const cliente of campanha.clientes || []) {
    if (jaTem.has(cliente.usuarioId)) continue;
    ordem += 1;
    const telefone = normalizarTelefone(cliente.telefone);
    const saiu = telefone && sairam.has(chaveTelefone(telefone));
    await WhatsappCampanhaEnvio.create(
      {
        campanhaId: campanha.id,
        usuarioId: cliente.usuarioId,
        clienteNome: cliente.nome,
        telefone: telefone || String(cliente.telefone || "-").slice(0, 20),
        texto: textoFinal(campanha.texto, cliente),
        programadoPara: quando,
        ordem,
        status: !telefone || saiu ? "DESCARTADA" : "FILA",
        erro: !telefone ? "Sem celular válido no cadastro." : saiu ? "Cliente pediu para não receber mensagens." : null,
      },
      { transaction },
    );
    if (telefone && !saiu) novos += 1;
  }
  return novos;
};

export const salvar = async (payload = {}, usuario, id = null) => {
  const nome = String(payload.nome || "").trim().slice(0, 120);
  const texto = String(payload.texto ?? "").trim();
  if (texto.length > TEXTO_MAX) throw erroHttp(400, `A mensagem pode ter no máximo ${TEXTO_MAX} caracteres.`);
  const clientes = await carregarClientes(payload.clientes || []);
  const midia = payload.midiaArquivoId ? await validarMidia(payload.midiaArquivoId) : { midiaArquivoId: null, midiaTipo: null, midiaNome: null };
  const dados = {
    nome: nome || `Lista ${new Date().toLocaleDateString("pt-BR")}`,
    produtoNome: String(payload.produtoNome || "").trim().slice(0, 200) || null,
    detalhes: String(payload.detalhes || "").trim().slice(0, 2000) || null,
    texto,
    clientes,
    ...midia,
  };

  let reabriu = 0;
  const campanha = await sequelize.transaction(async (transaction) => {
    if (!id) return WhatsappCampanha.create({ ...dados, criadoPor: usuario?.nome || null }, { transaction });
    const atual = await WhatsappCampanha.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!atual) throw erroHttp(404, "Lista não encontrada.");
    if (!STATUS_EDITAVEL.includes(atual.status)) throw erroHttp(400, "Lista cancelada não pode ser alterada. Duplique-a para enviar de novo.");
    if (atual.status !== "RASCUNHO" && !texto) throw erroHttp(400, "Escreva a mensagem.");
    await atual.update(dados, { transaction });
    if (atual.status !== "RASCUNHO") {
      reabriu = await sincronizarEnvios(atual, transaction);
      // Cliente novo numa lista já concluída: volta a enviar.
      if (reabriu && atual.status === "CONCLUIDA") await atual.update({ status: "ENVIANDO", concluidaEm: null }, { transaction });
    }
    return atual;
  });
  if (campanha.status !== "RASCUNHO") {
    await atualizarStatusCampanha(campanha.id);
    agendar(1500);
  }
  return obter(campanha.id);
};

// Enviar agora (quando vazio) ou agendar para uma data/hora.
export const programar = async (id, { quando } = {}) => {
  const config = await lerConfig();
  if (!config.evolutionUrl || !config.apiKey || !config.instancia) throw erroHttp(400, "Configure e conecte o WhatsApp (Evolution API) antes de enviar.");
  let data = new Date();
  if (quando) {
    data = new Date(quando);
    if (Number.isNaN(data.getTime())) throw erroHttp(400, "Data de agendamento inválida.");
    if (data.getTime() < Date.now() - 60 * 1000) throw erroHttp(400, "Escolha um horário no futuro.");
    if (data.getTime() > Date.now() + 60 * 24 * 60 * 60 * 1000) throw erroHttp(400, "Agende para no máximo 60 dias.");
  }
  await sequelize.transaction(async (transaction) => {
    const campanha = await WhatsappCampanha.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!campanha) throw erroHttp(404, "Lista não encontrada.");
    if (!["RASCUNHO", "AGENDADA"].includes(campanha.status)) throw erroHttp(400, "Esta lista já foi enviada.");
    if (!String(campanha.texto || "").trim()) throw erroHttp(400, "Escreva (ou gere com a IA) a mensagem antes de enviar.");
    if (!(campanha.clientes || []).length) throw erroHttp(400, "Coloque pelo menos um cliente na lista.");
    await campanha.update({ status: "AGENDADA", agendadaPara: data }, { transaction });
    await sincronizarEnvios(campanha, transaction);
  });
  await atualizarStatusCampanha(id);
  agendar(Math.max(1000, Math.min(5 * 60 * 1000, data.getTime() - Date.now())));
  return obter(id);
};

// Para o que ainda não saiu (o que já foi enviado fica no histórico).
export const cancelar = async (id) => {
  const campanha = await WhatsappCampanha.findByPk(id);
  if (!campanha) throw erroHttp(404, "Lista não encontrada.");
  if (campanha.status === "RASCUNHO") throw erroHttp(400, "A lista ainda não foi programada.");
  await WhatsappCampanhaEnvio.update({ status: "DESCARTADA", erro: "Envio cancelado." }, { where: { campanhaId: id, status: "FILA" } });
  const enviados = await WhatsappCampanhaEnvio.count({ where: { campanhaId: id, status: "ENVIADO" } });
  await campanha.update(enviados ? { status: "CANCELADA", concluidaEm: new Date() } : { status: "RASCUNHO", agendadaPara: null });
  if (!enviados) await WhatsappCampanhaEnvio.destroy({ where: { campanhaId: id } });
  return obter(id);
};

export const excluir = async (id) => {
  const campanha = await WhatsappCampanha.findByPk(id);
  if (!campanha) throw erroHttp(404, "Lista não encontrada.");
  const pendentes = await WhatsappCampanhaEnvio.count({ where: { campanhaId: id, status: { [Op.in]: ["FILA", "ENVIANDO"] } } });
  if (pendentes) throw erroHttp(400, "Cancele o envio antes de excluir a lista.");
  await WhatsappCampanhaEnvio.destroy({ where: { campanhaId: id } });
  await campanha.destroy();
  return { ok: true };
};

// Mesma mensagem e mídia, sem clientes (para mandar a outra lista).
export const duplicar = async (id, usuario) => {
  const c = await WhatsappCampanha.findByPk(id);
  if (!c) throw erroHttp(404, "Lista não encontrada.");
  const nova = await WhatsappCampanha.create({
    nome: `${c.nome} (nova lista)`.slice(0, 120),
    produtoNome: c.produtoNome,
    detalhes: c.detalhes,
    texto: c.texto,
    midiaArquivoId: c.midiaArquivoId,
    midiaTipo: c.midiaTipo,
    midiaNome: c.midiaNome,
    clientes: [],
    criadoPor: usuario?.nome || null,
  });
  return obter(nova.id);
};

// ---------------------------------------------------------------------------
// Mídia (imagem ou vídeo)
// ---------------------------------------------------------------------------

export const salvarMidia = async (arquivo, usuario) => {
  if (!arquivo) throw erroHttp(400, "Nenhum arquivo enviado.");
  const tipo = MIDIAS[arquivo.mimetype];
  if (!tipo || !conteudoConfere(arquivo.buffer, arquivo.mimetype)) throw erroHttp(400, "Envie uma imagem (JPG, PNG, WEBP) ou um vídeo MP4.");
  if (arquivo.size > MIDIA_MAX_BYTES) throw erroHttp(400, "O WhatsApp aceita arquivos de até 16 MB.");
  const salvo = await Arquivo.create({
    nome: String(arquivo.originalname || (tipo === "VIDEO" ? "video.mp4" : "imagem.jpg")).slice(0, 200),
    mime: arquivo.mimetype === "image/jpg" ? "image/jpeg" : arquivo.mimetype,
    tamanho: arquivo.size,
    dados: arquivo.buffer,
    enviadoPor: usuario?.nome || null,
  });
  return { midiaArquivoId: salvo.id, midiaTipo: tipo, midiaNome: salvo.nome };
};

// ---------------------------------------------------------------------------
// IA: mensagem pronta
// ---------------------------------------------------------------------------

const OBJETIVOS = {
  NOVIDADE: "apresentar um produto novo que acabou de chegar",
  PROMOCAO: "divulgar uma promoção / desconto especial",
  REPOSICAO: "avisar que um produto procurado voltou ao estoque",
  VIDEO: "mostrar o produto em vídeo e despertar vontade de comprar",
  OUTRO: "chamar o cliente para conferir as novidades da loja",
};

export const gerarTextoIA = async ({ produtoNome, detalhes, objetivo, imagem, midiaTipo } = {}) => {
  if (!process.env.OPENAI_API_KEY) throw erroHttp(503, "Configure OPENAI_API_KEY no backend para gerar a mensagem com IA.");
  const produto = String(produtoNome || "").trim().slice(0, 200);
  const extra = String(detalhes || "").trim().slice(0, 1500);
  if (!produto && !extra && !imagem) throw erroHttp(400, "Informe o nome do produto (ou envie a foto/vídeo) para a IA escrever.");
  const foto = typeof imagem === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imagem) && imagem.length < 1_500_000 ? imagem : null;

  const instrucoes = [
    "Você escreve mensagens de WhatsApp da Gira Kids, loja de brinquedos para máquinas de grua (bolinhas, cápsulas, pelúcias, peças), para clientes fiéis que compram com frequência (lojistas e operadores de máquinas).",
    `Objetivo: ${OBJETIVOS[objetivo] || OBJETIVOS.NOVIDADE}.`,
    "Tom: carinhoso, próximo e entusiasmado; chamativo e persuasivo para gerar vontade de comprar agora; mostre gratidão e fidelidade (o cliente é especial e recebe em primeira mão).",
    "Comece com uma saudação usando exatamente {nome} (ex.: \"Oi, {nome}! 💛\"). Não escreva outro nome.",
    "Português do Brasil, frases curtas, 3 a 5 parágrafos curtos, no máximo 600 caracteres. Use alguns emojis (sem exagero) e *negrito* do WhatsApp no nome do produto.",
    "Termine com uma chamada para ação clara (responder esta mensagem, garantir o seu, fazer o pedido).",
    "Use só as informações dadas: não invente preço, desconto, prazo, quantidade ou características que não foram informadas.",
    midiaTipo === "VIDEO" ? "A mensagem vai como legenda de um vídeo do produto: convide a assistir." : foto ? "A mensagem vai como legenda da foto do produto." : "",
    "Não inclua aviso de descadastro (o sistema acrescenta). Responda só com o texto da mensagem.",
  ]
    .filter(Boolean)
    .join("\n");

  const conteudo = [{ type: "input_text", text: `Produto: ${produto || "(veja a imagem)"}\nInformações: ${extra || "(nenhuma)"}` }];
  if (foto) conteudo.push({ type: "input_image", image_url: foto });

  const resposta = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL_CAMPANHA || process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: instrucoes,
      input: [{ role: "user", content: conteudo }],
      temperature: 0.9,
      max_output_tokens: 600,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw erroHttp(502, payload?.error?.message || "A IA não respondeu.");
  const texto = (
    payload.output_text ||
    (payload.output || [])
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("")
  ).trim();
  if (!texto) throw erroHttp(502, "A IA não devolveu a mensagem. Tente de novo.");
  // Garante o {nome} na saudação (o envio troca pelo nome de cada cliente).
  const comNome = /\{nome\}/i.test(texto) ? texto : `Oi, {nome}! 💛\n\n${texto}`;
  return { texto: comNome.slice(0, TEXTO_MAX) };
};
