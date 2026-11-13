import { Op } from "sequelize";
import { CorreiosPostagem, Usuario, Pedido, PedidoItem } from "../models/index.js";
import { resumirCarga, volumesSugeridos } from "../services/freteService.js";
import {
  baixarPdfsPostagemApi,
  cotarServicosApi,
  criarPostagemApi,
  statusApiCorreios,
} from "../services/correiosApiService.js";
import { METODOS_ENVIO } from "../utils/formasPagamento.js";
import { aprenderCaixa, esquecerCaixa } from "../services/caixasAprendidasService.js";
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
    origem: postagem.origem,
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
    const original = await obterPedido(req.params.id);
    const pedido = detalhar(original);
    const postagens = await buscarPostagensDosPedidos([pedido.id]);
    // Itens do pedido e caixas sugeridas pela Calculadora de Pedidos (para
    // montar a caixa e cotar sem voltar ao Time de Vendas).
    const itens = await PedidoItem.findAll({ where: { pedidoId: original.id }, order: [["nome", "ASC"]] });
    let volumes = [];
    let calculados = [];
    let aprendida = null;
    try {
      const carga = await resumirCarga(itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade })));
      volumes = await volumesSugeridos(carga);
      if (carga.aprendida) {
        calculados = await volumesSugeridos(carga, { usarAprendida: false });
        const { volumes: _v, pedidoId: _p, ...info } = carga.aprendida;
        aprendida = { ...info, mesmoPedido: carga.aprendida.pedidoId === original.id };
      }
    } catch (erro) {
      console.warn("[Correios] Volumes sugeridos:", erro.message);
    }
    res.json({
      ...pedido,
      postagem: postagens.get(pedido.id) || null,
      itens: itens.map((i) => ({
        id: i.id,
        nome: i.nome,
        sku: i.sku,
        categoria: i.categoria,
        imagemUrl: i.imagemUrl,
        quantidade: i.quantidade,
        unidadesPacote: i.unidadesPacote || 1,
        pesoGramas: i.pesoGramas != null ? Number(i.pesoGramas) : null,
      })),
      volumesSugeridos: volumes,
      // Caixa aprendida de uma postagem anterior com o mesmo conteúdo.
      caixaAprendida: aprendida,
      volumesCalculados: calculados,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao abrir o pedido");
  }
};

// Cotação e postagem vão direto na API oficial dos Correios.
// Remove uma caixa aprendida errada (volta para a conta da calculadora).
export const esquecerCaixaAprendida = async (req, res) => {
  try {
    const assinatura = String(req.body?.assinatura || "");
    if (!assinatura) return res.status(400).json({ error: "Informe a caixa." });
    const removida = await esquecerCaixa(assinatura);
    res.json({ removida });
  } catch (error) {
    responderErro(res, error, "Erro ao esquecer a caixa");
  }
};

export const apiStatus = async (req, res) => {
  try {
    res.json(await statusApiCorreios());
  } catch (error) {
    responderErro(res, error, "Erro ao consultar a API dos Correios");
  }
};

export const cotar = async (req, res) => {
  try {
    const resultado = await cotarServicosApi(req.body || {});
    res.json(resultado);
  } catch (error) {
    const validacao = /inválido|Informe|Peso deve/.test(error.message || "");
    if (validacao) return res.status(400).json({ error: error.message });
    responderErro(res, error, "Erro ao cotar nos Correios");
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
        error: "Este pedido já foi postado.",
        postagem: existentes.get(pedidoId),
      });
    }

    // Número e cliente vêm do banco, não do navegador.
    const pedido = await obterPedido(pedidoId);

    const resultado = await criarPostagemApi({
      destinatario,
      carga,
      servicoId,
      observacao: `PEDIDO GIRA KIDS ${pedido.numero}`,
      valorDeclarado: Number(pedido.subtotal || pedido.total || 0),
    });

    const postagem = await CorreiosPostagem.create({
      pedidoId: pedido.id,
      numeroPedido: String(pedido.numero),
      cliente: pedido.clienteNome,
      vippIdConhecimento: resultado.idConhecimento,
      origem: "API",
      etiqueta: resultado.etiqueta || null,
      servico: resultado.servico.nome,
      valorFrete: resultado.servico.valor || null,
      usuarioId: req.usuario.id,
    });
    if (resultado.etiqueta) {
      await pedido.update({ codigoRastreio: resultado.etiqueta });
    }
    // A caixa postada vira a sugestão para pedidos com o mesmo conteúdo.
    try {
      const itens = await PedidoItem.findAll({ where: { pedidoId: pedido.id } });
      const conteudo = await resumirCarga(itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade })));
      await aprenderCaixa({
        assinatura: conteudo.assinatura,
        descricao: conteudo.descricao,
        pedidoId: pedido.id,
        pedidoNumero: pedido.numero,
        carga,
        usuarioNome: req.usuario?.nome,
      });
    } catch (erro) {
      console.warn("[Correios] Aprender caixa:", erro.message);
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
    responderErro(res, error, "Erro ao criar a postagem");
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
    if (postagem.origem !== "API") {
      return res.status(400).json({ error: "Esta postagem foi feita pelo VIPP, que foi desligado. Os PDFs dela não estão mais disponíveis aqui." });
    }
    res.json(await baixarPdfsPostagemApi(postagem.vippIdConhecimento, postagem.etiqueta));
  } catch (error) {
    responderErro(res, error, "Erro ao baixar os PDFs");
  }
};
