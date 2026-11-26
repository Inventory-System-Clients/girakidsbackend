import { LogAtividade } from "../models/index.js";
import * as whatsapp from "../services/whatsappService.js";
import * as campanhas from "../services/whatsappCampanhaService.js";
import { erroHttp, responderErro } from "../utils/helpers.js";

// Avisos de pedido no WhatsApp (aba só do ADMIN). Sem registrarLog com o
// corpo: ele gravaria a chave da Evolution — aqui registra só o que mudou.

export const soAdmin = (req, res, next) =>
  req.usuario?.role === "ADMIN" ? next() : res.status(403).json({ error: "Só o administrador configura os avisos no WhatsApp." });

const registrar = (req, acao, detalhes) =>
  LogAtividade.create({
    usuarioId: req.usuario?.id,
    acao,
    entidade: "WhatsApp",
    detalhes,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  }).catch((err) => console.error("Erro ao criar log:", err));

// URL pública do backend (para a Evolution chamar o webhook das respostas).
const urlPublica = (req) => process.env.PUBLIC_API_URL || process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;

export const status = async (req, res) => {
  try {
    res.json(await whatsapp.obterStatus());
  } catch (error) {
    responderErro(res, error, "Erro ao carregar os avisos de WhatsApp");
  }
};

export const salvar = async (req, res) => {
  try {
    const corpo = req.body || {};
    const config = await whatsapp.salvarConfig(corpo, req.usuario?.nome);
    const campos = Object.keys(corpo).filter((c) => c !== "apiKey" || String(corpo.apiKey || "").trim());
    registrar(req, "CONFIG_WHATSAPP", { campos, ...(corpo.ativo !== undefined ? { ativo: Boolean(corpo.ativo) } : {}) });
    res.json(config);
  } catch (error) {
    responderErro(res, error, "Erro ao salvar os avisos de WhatsApp");
  }
};

export const conectar = async (req, res) => {
  try {
    res.json(await whatsapp.conectar({ baseUrl: urlPublica(req) }));
  } catch (error) {
    responderErro(res, error, "Erro ao conectar o WhatsApp");
  }
};

export const teste = async (req, res) => {
  try {
    res.json(await whatsapp.enviarTeste(req.body?.telefone));
  } catch (error) {
    responderErro(res, error, "Erro ao enviar o teste");
  }
};

export const reenviar = async (req, res) => {
  try {
    res.json(await whatsapp.reenviar(req.params.id));
  } catch (error) {
    responderErro(res, error, "Erro ao reenviar o aviso");
  }
};

// A Evolution chama aqui a cada mensagem recebida; o token secreto vai na
// URL. Sempre 200 para ela não ficar repetindo.
export const webhook = async (req, res) => {
  try {
    if (!(await whatsapp.validarWebhookToken(req.params.token))) throw erroHttp(404, "Não encontrado.");
    await whatsapp.receberWebhook(req.body);
    res.json({ ok: true });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: "Não encontrado." });
    console.error("[whatsapp] webhook:", error.message);
    res.json({ ok: true });
  }
};

// ---------------------------------------------------------------------------
// Listas de clientes (novidades, promoções, vídeos)
// ---------------------------------------------------------------------------

const acao = (fn, mensagem) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    responderErro(res, error, mensagem);
  }
};

export const campanhasListar = acao(() => campanhas.listar(), "Erro ao carregar as listas");
export const campanhaObter = acao((req) => campanhas.obter(req.params.id), "Erro ao carregar a lista");
export const campanhaCriar = acao((req) => campanhas.salvar(req.body, req.usuario), "Erro ao salvar a lista");
export const campanhaAtualizar = acao((req) => campanhas.salvar(req.body, req.usuario, req.params.id), "Erro ao salvar a lista");
export const campanhaProgramar = acao(async (req) => {
  const r = await campanhas.programar(req.params.id, { quando: req.body?.quando || null });
  registrar(req, req.body?.quando ? "AGENDAR_LISTA_WHATSAPP" : "ENVIAR_LISTA_WHATSAPP", { campanhaId: r.id, nome: r.nome, clientes: r.clientes.length, quando: r.agendadaPara });
  return r;
}, "Erro ao programar o envio");
export const campanhaCancelar = acao(async (req) => {
  const r = await campanhas.cancelar(req.params.id);
  registrar(req, "CANCELAR_LISTA_WHATSAPP", { campanhaId: r.id, nome: r.nome });
  return r;
}, "Erro ao cancelar o envio");
export const campanhaExcluir = acao(async (req) => {
  const r = await campanhas.excluir(req.params.id);
  registrar(req, "EXCLUIR_LISTA_WHATSAPP", { campanhaId: req.params.id });
  return r;
}, "Erro ao excluir a lista");
export const campanhaDuplicar = acao((req) => campanhas.duplicar(req.params.id, req.usuario), "Erro ao duplicar a lista");
export const campanhaRecomendar = acao(
  (req) =>
    campanhas.recomendar({
      dias: req.body?.dias,
      excluir: req.body?.excluir,
      campanhaId: req.body?.campanhaId || null,
      semRepetirDias: req.body?.semRepetirDias ?? 7,
      quantidade: req.body?.quantidade,
    }),
  "Erro ao recomendar clientes",
);
export const campanhaBuscarClientes = acao((req) => campanhas.buscarClientes(req.query.q, req.query.dias), "Erro ao buscar clientes");
export const campanhaMidia = acao((req) => campanhas.salvarMidia(req.file, req.usuario), "Erro ao enviar o arquivo");
export const campanhaTextoIA = acao((req) => campanhas.gerarTextoIA(req.body || {}), "Erro ao gerar a mensagem");
