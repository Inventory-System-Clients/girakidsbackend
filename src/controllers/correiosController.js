import { Op } from "sequelize";
import { CorreiosPostagem, Usuario, Pedido } from "../models/index.js";
import {
  cotarServicosVipp,
  criarPostagemVipp,
  baixarPdfsPostagemVipp,
} from "../services/vippService.js";
import { METODOS_ENVIO } from "../utils/formasPagamento.js";
import { fimDoDia, inicioDoDia } from "../utils/helpers.js";
import { contem } from "../utils/busca.js";

// Aba Comercial → Correios. No AgarraMais os pedidos vinham da loja antiga
// (girakids-loja.krionoficial.com.br); aqui vêm direto do banco da própria
// loja Gira Kids.

const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;
const MAXIMO_PEDIDOS = 300;

// Pedidos sendo gravados agora — evita duas gravações simultâneas do mesmo
// pedido (duplo clique / duas abas).
const gravacoesEmAndamento = new Set();

const formatarCep = (cep) => {
  const digitos = String(cep || "").replace(/\D/g, "");
  return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : digitos;
};

const STATUS_PEDIDO = (pedido) => {
  if (pedido.statusVendas === "CANCELADO") return "CANCELADO";
  if (pedido.statusExpedicao === "EXPEDIDO") return "EXPEDIDO";
  if (pedido.statusFinanceiro === "PAGO") return "PAGO";
  return pedido.statusVendas === "LIBERADO" ? "LIBERADO" : "AGUARDANDO";
};

const resumoPedido = (pedido) => ({
  id: pedido.id,
  numero: pedido.numero,
  cliente: pedido.clienteNome || "-",
  data: pedido.createdAt,
  cidade: pedido.cidade || "",
  uf: pedido.estado || "",
  cep: formatarCep(pedido.cep),
  metodoEnvio: pedido.metodoEnvio || "",
  metodoEnvioNome: METODOS_ENVIO[pedido.metodoEnvio] || pedido.metodoEnvio || "-",
  pesoGramas: Number(pedido.pesoTotalGramas || 0),
  total: Number(pedido.total || 0),
  status: STATUS_PEDIDO(pedido),
});

const detalhar = (pedido) => ({
  ...resumoPedido(pedido),
  prazoEntregaDias: pedido.prazoEntregaDias || null,
  enderecoOriginal: [pedido.rua, pedido.numeroEndereco, pedido.complemento].filter(Boolean).join(", "),
  observacoes: pedido.observacoes || "",
  destinatario: {
    nome: pedido.clienteNome || "",
    cep: formatarCep(pedido.cep),
    logradouro: pedido.rua || "",
    numero: pedido.numeroEndereco || "S/N",
    complemento: pedido.complemento || "",
    bairro: pedido.bairro || "",
    cidade: pedido.cidade || "",
    uf: String(pedido.estado || "").toUpperCase().slice(0, 2),
    telefone: pedido.clienteTelefone || "",
    email: pedido.clienteEmail || "",
    documento: String(pedido.documento || "").replace(/\D/g, ""),
  },
});

const obterPedido = async (id) => {
  const pedido = await Pedido.findOne({ where: { id, tipo: "PEDIDO" } });
  if (!pedido) {
    const erro = new Error("Pedido não encontrado.");
    erro.status = 404;
    throw erro;
  }
  return pedido;
};

const resumoPostagem = (postagem) =>
  postagem && {
    id: postagem.id,
    etiqueta: postagem.etiqueta,
    servico: postagem.servico,
    valorFrete: postagem.valorFrete != null ? Number(postagem.valorFrete) : null,
    vippIdConhecimento: postagem.vippIdConhecimento,
    criadoEm: postagem.createdAt,
    criadoPor: postagem.usuario?.nome || null,
  };

const buscarPostagensDosPedidos = async (pedidoIds) => {
  if (!pedidoIds.length) return new Map();
  const postagens = await CorreiosPostagem.findAll({
    where: { pedidoId: { [Op.in]: pedidoIds } },
    include: [{ model: Usuario, as: "usuario", attributes: ["nome"] }],
    order: [["createdAt", "DESC"]],
  });
  const mapa = new Map();
  postagens.forEach((postagem) => {
    if (!mapa.has(postagem.pedidoId)) {
      mapa.set(postagem.pedidoId, resumoPostagem(postagem));
    }
  });
  return mapa;
};

const responderErro = (res, error, mensagemPadrao) => {
  console.error(`[Correios] ${mensagemPadrao}:`, error);
  const configuracao = /^Configure /.test(error.message || "");
  res.status(error.status || (configuracao ? 500 : 502)).json({
    error: error.message || mensagemPadrao,
  });
};

export const buscarPedidos = async (req, res) => {
  try {
    const nome = String(req.query.nome || "").trim().slice(0, 100);
    const { inicio, fim } = req.query;

    if (!FORMATO_DATA.test(String(inicio)) || !FORMATO_DATA.test(String(fim))) {
      return res.status(400).json({ error: "Informe o período (de / até)." });
    }
    if (inicio > fim) {
      return res.status(400).json({ error: "A data inicial é maior que a final." });
    }

    const where = {
      tipo: "PEDIDO",
      statusVendas: { [Op.ne]: "CANCELADO" },
      createdAt: { [Op.between]: [inicioDoDia(inicio), fimDoDia(fim)] },
    };
    if (nome) {
      where[Op.or] = [
        contem("Pedido.clienteNome", nome),
        ...(/^\d+$/.test(nome) ? [{ numero: Number(nome) }] : []),
      ];
    }
    const encontrados = await Pedido.findAll({
      where,
      order: [["numero", "DESC"]],
      limit: MAXIMO_PEDIDOS + 1,
    });
    const temMais = encontrados.length > MAXIMO_PEDIDOS;
    const pedidos = encontrados.slice(0, MAXIMO_PEDIDOS).map(resumoPedido);
    const postagens = await buscarPostagensDosPedidos(pedidos.map((p) => p.id));

    res.json({
      pedidos: pedidos.map((pedido) => ({
        ...pedido,
        postagem: postagens.get(pedido.id) || null,
      })),
      temMais,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao buscar pedidos");
  }
};

export const detalharPedido = async (req, res) => {
  try {
    const pedido = detalhar(await obterPedido(req.params.id));
    const postagens = await buscarPostagensDosPedidos([pedido.id]);
    res.json({ ...pedido, postagem: postagens.get(pedido.id) || null });
  } catch (error) {
    responderErro(res, error, "Erro ao abrir o pedido");
  }
};

export const cotar = async (req, res) => {
  try {
    const resultado = await cotarServicosVipp(req.body || {});
    res.json(resultado);
  } catch (error) {
    const validacao = /inválido|Informe|Peso deve/.test(error.message || "");
    if (validacao) return res.status(400).json({ error: error.message });
    responderErro(res, error, "Erro ao cotar no VIPP");
  }
};

export const criarPostagem = async (req, res) => {
  const { pedidoId, destinatario, carga, servicoId, forcar } = req.body || {};

  if (!pedidoId || !destinatario || !carga || !servicoId) {
    return res.status(400).json({ error: "Dados da postagem incompletos." });
  }
  if (gravacoesEmAndamento.has(pedidoId)) {
    return res
      .status(409)
      .json({ error: "Este pedido já está sendo gravado. Aguarde." });
  }

  gravacoesEmAndamento.add(pedidoId);
  try {
    const existentes = await buscarPostagensDosPedidos([pedidoId]);
    if (existentes.has(pedidoId) && forcar !== true) {
      return res.status(409).json({
        error: "Este pedido já foi postado no VIPP.",
        postagem: existentes.get(pedidoId),
      });
    }

    // Número e cliente vêm do banco, não do navegador.
    const pedido = await obterPedido(pedidoId);

    const resultado = await criarPostagemVipp({
      destinatario,
      carga,
      servicoId,
      observacao: `PEDIDO GIRA KIDS ${pedido.numero}`,
    });

    const postagem = await CorreiosPostagem.create({
      pedidoId: pedido.id,
      numeroPedido: String(pedido.numero),
      cliente: pedido.clienteNome,
      vippIdConhecimento: resultado.idConhecimento,
      etiqueta: resultado.etiqueta || null,
      servico: resultado.servico.nome,
      valorFrete: resultado.servico.valor || null,
      usuarioId: req.usuario.id,
    });
    if (resultado.etiqueta) {
      await pedido.update({ codigoRastreio: resultado.etiqueta });
    }

    res.status(201).json({
      postagemId: postagem.id,
      etiqueta: resultado.etiqueta,
      servico: resultado.servico,
      arquivos: resultado.arquivos,
      errosPdf: resultado.errosPdf,
    });
  } catch (error) {
    const validacao = /^Preencha|inválido|Informe|Peso deve|não está disponível|indisponível/.test(
      error.message || "",
    );
    if (validacao) return res.status(400).json({ error: error.message });
    responderErro(res, error, "Erro ao criar a postagem no VIPP");
  } finally {
    gravacoesEmAndamento.delete(pedidoId);
  }
};

export const baixarPdfs = async (req, res) => {
  try {
    const postagem = await CorreiosPostagem.findByPk(req.params.id);
    if (!postagem) {
      return res.status(404).json({ error: "Postagem não encontrada." });
    }
    const { arquivos } = await baixarPdfsPostagemVipp(postagem.vippIdConhecimento);
    res.json({
      arquivos: arquivos.map((arquivo) => ({
        ...arquivo,
        nome: arquivo.nome.replace(
          postagem.vippIdConhecimento,
          postagem.etiqueta || postagem.vippIdConhecimento,
        ),
      })),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao baixar os PDFs no VIPP");
  }
};
