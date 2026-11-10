import { PRIMEIRO_PEDIDO_EXPEDICAO } from "./expedicaoController.js";
import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { contem } from "../utils/busca.js";
import {
  Pedido,
  PedidoItem,
  PedidoParcela,
  Parceiro,
  Usuario,
  AlertaPagamento,
} from "../models/index.js";
import {
  INCLUDE_COMPLETO,
  calcularTotais,
  criarPedido,
  ehInterno,
  ehShowroom,
  formatarNumero,
  gerarBoletosDoPedido,
  lerBoletoConfig,
  montarFiltroPedidos,
  montarItens,
  resolverTransportadora,
  serializarPedido,
  textoCurto,
  totalRecebido,
} from "../services/pedidoService.js";
import {
  baixarEstoquePedido,
  devolverEstoquePedido,
  verificarEstoque,
} from "../services/estoqueService.js";
import { cotarFrete } from "../services/freteService.js";
import { statusPagamentos } from "../services/pagamentos/index.js";
import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";
import { rastrearObjetoApi } from "../services/correiosApiService.js";
import { assinar, assinaturaConfere } from "../utils/linkSeguro.js";
import { bancoValido } from "./bancoController.js";
import { ENDERECO_LOJA_PADRAO, FORMAS_PAGAMENTO, FORMAS_SHOWROOM } from "../utils/formasPagamento.js";
import {
  arredondar,
  erroHttp,
  hojeISO,
  numero,
  responderErro,
} from "../utils/helpers.js";

// Etiquetas e observação comercial do cliente cadastrado.
const INCLUDE_CLIENTE = { model: Usuario, as: "cliente", attributes: ["id", "etiquetas", "observacaoComercial", "telefone"] };

const carregar = async (id, transaction) => {
  const pedido = await Pedido.findByPk(id, {
    include: INCLUDE_COMPLETO,
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!pedido) throw erroHttp(404, "Pedido não encontrado.");
  return pedido;
};

// FOR UPDATE não pode ter LEFT JOIN no Postgres: trava a linha e recarrega.
const carregarParaAlterar = async (id, transaction) => {
  const travado = await Pedido.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!travado) throw erroHttp(404, "Pedido não encontrado.");
  return Pedido.findByPk(id, { include: INCLUDE_COMPLETO, transaction });
};

const evento = (pedido, usuario, tipo, dados = {}) => [
  ...(pedido.historico || []),
  { tipo, ...dados, por: usuario.nome, em: new Date().toISOString() },
];

const garantirNaoCancelado = (pedido) => {
  if (pedido.statusVendas === "CANCELADO") throw erroHttp(400, "Pedido cancelado.");
};

// Equipe que lida com pedidos vê qualquer pedido; outros funcionários
// (ex.: só Produtos ou Recebimentos) e clientes veem só os próprios.
const veTodosPedidos = (usuario) =>
  ehInterno(usuario) && usuario.temPermissao("VENDAS", "FINANCEIRO", "EXPEDICAO", "CHECKOUT", "ORCAMENTOS", "COMERCIAL");

const responderPedido = async (res, id, status = 200) => {
  const pedido = await carregar(id);
  res.status(status).json(serializarPedido(pedido));
};

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export const listar = async (req, res) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 30, 500);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const where = montarFiltroPedidos(req.query);

    const { rows, count } = await Pedido.findAndCountAll({
      where,
      include: [...INCLUDE_COMPLETO, INCLUDE_CLIENTE],
      distinct: true,
      // Mais recente primeiro pela data: os "-ANT" têm número 900000+ e
      // ficariam sempre no topo se ordenasse pelo número.
      order: [["createdAt", "DESC"], ["numero", "DESC"]],
      limit: limite,
      offset: (pagina - 1) * limite,
    });

    res.json({
      itens: rows.map((p) => serializarPedido(p, { completo: false })),
      total: count,
      pagina,
      paginas: Math.max(1, Math.ceil(count / limite)),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao listar pedidos");
  }
};

export const meusPedidos = async (req, res) => {
  try {
    // Em andamento: ainda não enviado. Concluídos: finalizados pela expedição
    // (enviados/retirados) ou cancelados.
    const situacao = {
      andamento: { statusVendas: { [Op.ne]: "CANCELADO" }, statusExpedicao: { [Op.ne]: "EXPEDIDO" } },
      concluidos: { [Op.or]: [{ statusExpedicao: "EXPEDIDO" }, { statusVendas: "CANCELADO" }] },
    }[req.query.situacao] || {};
    const pedidos = await Pedido.findAll({
      where: { clienteId: req.usuario.id, tipo: "PEDIDO", ...situacao },
      include: INCLUDE_COMPLETO,
      order: [["createdAt", "DESC"]],
      limit: Math.min(Number(req.query.limite) || 20, 100),
      offset: Number(req.query.offset) || 0,
    });
    res.json(pedidos.map((p) => serializarPedido(p, { completo: false, usuario: req.usuario })));
  } catch (error) {
    responderErro(res, error, "Erro ao listar seus pedidos");
  }
};

// ---------------------------------------------------------------------------
// Acompanhamento do pedido (cliente) e link público assinado
// ---------------------------------------------------------------------------

const FINALIDADE_ACOMPANHAMENTO = "acompanhamento-pedido";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Só o necessário para acompanhar: sem valores, endereço, documento ou
// telefone (o link pode ser repassado).
const dadosAcompanhamento = (pedido) => ({
  id: pedido.id,
  numeroFormatado: formatarNumero(pedido),
  createdAt: pedido.createdAt,
  clienteNome: String(pedido.clienteNome || "").split(" ")[0],
  clienteId: pedido.clienteId,
  formaPagamento: pedido.formaPagamento,
  statusFinanceiro: pedido.statusFinanceiro,
  pagoEm: pedido.pagoEm,
  statusVendas: pedido.statusVendas,
  liberadoEm: pedido.liberadoEm,
  statusExpedicao: pedido.statusExpedicao,
  montagemConcluidaEm: pedido.montagemConcluidaEm,
  expedidoEm: pedido.expedidoEm,
  canceladoEm: pedido.canceladoEm,
  metodoEnvio: pedido.metodoEnvio,
  transportadoraNome: pedido.transportadoraNome,
  codigoRastreio: pedido.codigoRastreio,
  quantidadeItens: (pedido.itens || []).length,
  itens: (pedido.itens || []).map((i) => ({ id: i.id, nome: i.nome, quantidade: i.quantidade, imagemUrl: i.imagemUrl || i.produto?.imagemUrl || null })),
});

const pedidoDoLink = async (req) => {
  const { id, assinatura } = req.params;
  if (!UUID.test(id) || !assinaturaConfere(FINALIDADE_ACOMPANHAMENTO, id, assinatura)) throw erroHttp(404, "Link de acompanhamento inválido.");
  const pedido = await Pedido.findByPk(id, { include: INCLUDE_COMPLETO });
  if (!pedido || pedido.tipo !== "PEDIDO") throw erroHttp(404, "Pedido não encontrado.");
  return pedido;
};

const rastrear = async (pedido) => {
  if (!pedido.codigoRastreio) throw erroHttp(404, "Este pedido ainda não tem código de rastreio.");
  try {
    return await rastrearObjetoApi(pedido.codigoRastreio);
  } catch (error) {
    if (error.status === 400 && /inválido/.test(error.message)) throw error;
    console.warn(`[Rastreio] Pedido ${pedido.numero}:`, error.message);
    return { codigo: pedido.codigoRastreio, eventos: [], indisponivel: true };
  }
};

// Equipe: link para enviar ao cliente.
export const linkAcompanhamento = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, { attributes: ["id", "tipo"] });
    if (!pedido || pedido.tipo !== "PEDIDO") throw erroHttp(404, "Pedido não encontrado.");
    res.json({ caminho: `/acompanhamento/${pedido.id}/${assinar(FINALIDADE_ACOMPANHAMENTO, pedido.id)}` });
  } catch (error) {
    responderErro(res, error, "Erro ao gerar o link de acompanhamento");
  }
};

// Público (com o link assinado).
export const acompanhamentoPublico = async (req, res) => {
  try {
    res.json(dadosAcompanhamento(await pedidoDoLink(req)));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar o pedido");
  }
};

export const rastreioPublico = async (req, res) => {
  try {
    res.json(await rastrear(await pedidoDoLink(req)));
  } catch (error) {
    responderErro(res, error, "Erro ao consultar o rastreio");
  }
};

// Cliente logado (dono do pedido) ou equipe.
export const rastreio = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id);
    if (!pedido) throw erroHttp(404, "Pedido não encontrado.");
    if (ehInterno(req.usuario) ? !veTodosPedidos(req.usuario) : pedido.clienteId !== req.usuario.id) {
      return res.status(403).json({ error: "Este pedido não pertence à sua conta." });
    }
    res.json(await rastrear(pedido));
  } catch (error) {
    responderErro(res, error, "Erro ao consultar o rastreio");
  }
};

export const obter = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, { include: [...INCLUDE_COMPLETO, INCLUDE_CLIENTE] });
    if (!pedido) throw erroHttp(404, "Pedido não encontrado.");
    if (ehInterno(req.usuario) ? !veTodosPedidos(req.usuario) : pedido.clienteId !== req.usuario.id && !(ehShowroom(req.usuario) && pedido.criadoPorId === req.usuario.id)) {
      return res.status(403).json({ error: "Este pedido não pertence à sua conta." });
    }
    const dados = serializarPedido(pedido, { usuario: req.usuario });
    if (pedido.transportadoraId) {
      const transportadora = await Parceiro.findByPk(pedido.transportadoraId);
      // Cliente vê só o contato público da transportadora.
      const t = transportadora?.toJSON() || null;
      dados.transportadora = t && !ehInterno(req.usuario) ? { id: t.id, nome: t.nome, telefone: t.telefone || null, site: t.site || null } : t;
    }
    res.json(dados);
  } catch (error) {
    responderErro(res, error, "Erro ao abrir pedido");
  }
};

// "Carregar Pedido" no checkout / orçamentos: busca pelo número.
export const obterPorCodigo = async (req, res) => {
  try {
    const codigo = String(req.params.codigo || "").trim();
    const tipo = codigo.length <= 4 && codigo.startsWith("0") ? "ORCAMENTO" : req.query.tipo;
    const where = { numero: Number(codigo) };
    if (tipo) where.tipo = tipo;
    if (!veTodosPedidos(req.usuario)) where.clienteId = req.usuario.id;
    const pedido = await Pedido.findOne({ where, include: INCLUDE_COMPLETO, order: [["tipo", "ASC"]] });
    if (!pedido) return res.status(404).json({ error: "Não foi possível encontrar um pedido com este código." });
    res.json(serializarPedido(pedido, { usuario: req.usuario }));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar pedido");
  }
};

// "Carregar Pedido" pelo nome do cliente (ou número): lista curta para
// escolher. Cliente só vê os próprios pedidos.
export const buscarParaCarregar = async (req, res) => {
  try {
    const busca = String(req.query.busca || "").trim();
    if (busca.length < 2) return res.json([]);
    const ou = [contem("Pedido.clienteNome", busca), { codigoLegado: { [Op.iLike]: `%${busca}%` } }];
    if (/^\d+$/.test(busca)) ou.push({ numero: Number(busca) });
    const where = { [Op.or]: ou };
    if (!veTodosPedidos(req.usuario)) where.clienteId = req.usuario.id;
    const pedidos = await Pedido.findAll({
      where,
      include: [{ model: PedidoItem, as: "itens", attributes: ["id"] }],
      order: [["createdAt", "DESC"]],
      limit: 15,
    });
    res.json(
      pedidos.map((p) => ({
        id: p.id,
        tipo: p.tipo,
        numeroFormatado: formatarNumero(p),
        clienteNome: p.clienteNome,
        total: Number(p.total),
        createdAt: p.createdAt,
        statusVendas: p.statusVendas,
        quantidadeItens: p.itens.length,
      })),
    );
  } catch (error) {
    responderErro(res, error, "Erro ao buscar pedidos");
  }
};

export const contadores = async (req, res) => {
  try {
    const [aguardandoLiberacao, aguardandoExpedicao, alertas] = await Promise.all([
      Pedido.count({ where: { tipo: "PEDIDO", statusVendas: "AGUARDANDO" } }),
      Pedido.count({
        where: { tipo: "PEDIDO", statusVendas: "LIBERADO", statusExpedicao: { [Op.ne]: "EXPEDIDO" }, numero: { [Op.gte]: PRIMEIRO_PEDIDO_EXPEDICAO } },
      }),
      AlertaPagamento.count({ where: { status: "ATIVO" } }),
    ]);
    res.json({ aguardandoLiberacao, aguardandoExpedicao, alertasPagamento: alertas });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar contadores");
  }
};

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export const opcoesCheckout = async (req, res) => {
  try {
    const pagamentos = statusPagamentos();
    const cartoesHabilitados = await lerConfiguracao("cartoesOnlineHabilitados", true);
    const interno = ehInterno(req.usuario);
    const showroom = ehShowroom(req.usuario);
    const formas = Object.entries(FORMAS_PAGAMENTO)
      .filter(([codigo, cfg]) => interno || !cfg.admin || (showroom && FORMAS_SHOWROOM.includes(codigo)))
      .filter(([, cfg]) => interno || !cfg.outros || req.usuario?.outrosPagamentos)
      .map(([codigo, cfg]) => ({
        codigo,
        ...cfg,
        disponivel:
          !cfg.online ||
          (pagamentos.habilitado &&
            pagamentos.metodos.includes(codigo) &&
            (codigo === "PIX_ONLINE" || cartoesHabilitados)),
      }));
    // Cliente: "Combinar com o comercial" (transportadora, retirada ou sem
    // pagamento online configurado).
    if (!interno) {
      formas.push({
        codigo: "A_DEFINIR",
        nome: "Combinar com o comercial",
        taxa: 0,
        combinar: true,
        disponivel: true,
        somenteEnvios: pagamentos.habilitado ? ["RETIRAR_LOCAL", "TRANSPORTADORA"] : null,
      });
    }
    res.json({
      formas,
      enderecoLoja: await lerConfiguracao("enderecoLoja", ENDERECO_LOJA_PADRAO),
      pagamentosOnline: pagamentos,
      cartoesOnlineHabilitados: cartoesHabilitados,
      taxasCartao: await lerConfiguracao("taxasCartao", null),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar opções do checkout");
  }
};

export const cotar = async (req, res) => {
  try {
    const corpo = req.body || {};
    // Volumes/peso da Braspress digitados à mão: só ADMIN.
    res.json(await cotarFrete({ ...corpo, braspressAjuste: req.usuario?.role === "ADMIN" ? corpo.braspressAjuste : null }));
  } catch (error) {
    responderErro(res, error, "Erro ao calcular frete");
  }
};

// Pedido amarelo reaberto no carrinho: o checkout manda tudo de novo e o
// mesmo pedido é atualizado.
export const reabrir = async (req, res) => {
  try {
    const pedido = await criarPedido(req.body || {}, req.usuario, "PEDIDO", { reabrirId: req.params.id });
    res.locals.entityId = pedido.id;
    res.json({ ...serializarPedido(pedido, { usuario: req.usuario }), clienteCadastro: pedido.clienteCadastro || null });
  } catch (error) {
    responderErro(res, error, "Erro ao reabrir pedido");
  }
};

export const criar = async (req, res) => {
  try {
    const pedido = await criarPedido(req.body || {}, req.usuario, "PEDIDO");
    res.locals.entityId = pedido.id;
    res.status(201).json({ ...serializarPedido(pedido, { usuario: req.usuario }), clienteCadastro: pedido.clienteCadastro || null });
  } catch (error) {
    responderErro(res, error, "Erro ao criar pedido");
  }
};

export const criarOrcamento = async (req, res) => {
  try {
    const pedido = await criarPedido(req.body || {}, req.usuario, "ORCAMENTO");
    res.locals.entityId = pedido.id;
    res.status(201).json({ ...serializarPedido(pedido, { usuario: req.usuario }), clienteCadastro: pedido.clienteCadastro || null });
  } catch (error) {
    responderErro(res, error, "Erro ao criar orçamento");
  }
};

// Orçamento → pedido (mantém itens, cliente, entrega e pagamento).
export const gerarPedidoDoOrcamento = async (req, res) => {
  try {
    const orcamento = await carregar(req.params.id);
    if (orcamento.tipo !== "ORCAMENTO") throw erroHttp(400, "Não é um orçamento.");
    if (orcamento.pedidoGeradoId) {
      return res.status(409).json({ error: "Pedido já gerado", pedidoId: orcamento.pedidoGeradoId });
    }
    const corpo = {
      clienteId: orcamento.clienteId,
      cliente: {
        nome: orcamento.clienteNome,
        email: orcamento.clienteEmail,
        telefone: orcamento.clienteTelefone,
        documento: orcamento.documento,
        cep: orcamento.cep,
        rua: orcamento.rua,
        numero: orcamento.numeroEndereco,
        complemento: orcamento.complemento,
        bairro: orcamento.bairro,
        cidade: orcamento.cidade,
        estado: orcamento.estado,
      },
      itens: orcamento.itens.map((item) => ({
        produtoId: item.produtoId,
        quantidade: item.quantidade,
        precoUnitario: item.precoUnitario,
        liberadoSemEstoque: item.liberadoSemEstoque,
      })),
      metodoEnvio: orcamento.metodoEnvio,
      transportadora: orcamento.transportadoraId ? { id: orcamento.transportadoraId, nome: orcamento.transportadoraNome } : null,
      transportadoraObs: orcamento.transportadoraObs,
      transportadoraCotacao: orcamento.transportadoraCotacao,
      transportadoraCotacaoCom: orcamento.transportadoraCotacaoCom,
      desconto: orcamento.desconto,
      freteAdicional: orcamento.freteAdicional,
      formaPagamento: orcamento.formaPagamento,
      parcelasCartao: orcamento.parcelasCartao,
      composicaoPagamento: orcamento.composicaoPagamento,
      boleto: orcamento.boletoConfig,
      observacoes: orcamento.observacoes,
      orcamentoOrigemId: orcamento.id,
    };
    const pedido = await criarPedido(corpo, req.usuario, "PEDIDO");
    await pedido.update({ orcamentoOrigemNumero: orcamento.numero });
    await orcamento.update({ pedidoGeradoId: pedido.id, pedidoGeradoNumero: pedido.numero });
    res.status(201).json(serializarPedido(await carregar(pedido.id)));
  } catch (error) {
    responderErro(res, error, "Erro ao gerar pedido");
  }
};

// ---------------------------------------------------------------------------
// Time de Vendas
// ---------------------------------------------------------------------------

// Liberar para expedição: reserva o estoque; se ainda não foi pago, abre a
// pendência financeira (recebimento manual) pelo saldo.
export const liberar = async (req, res) => {
  try {
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      if (pedido.statusVendas === "LIBERADO") throw erroHttp(400, "Pedido já liberado.");
      await baixarEstoquePedido(pedido, req.usuario, transaction);
      const agora = new Date();
      const pago = pedido.statusFinanceiro === "PAGO";
      await pedido.update(
        {
          statusVendas: "LIBERADO",
          liberadoEm: agora,
          liberadoPor: req.usuario.nome,
          observacaoLiberacao: req.body?.observacao || null,
          ...(pago
            ? {}
            : {
                pendenciaStatus: "ABERTA",
                pendenciaValor: arredondar(Number(pedido.total) - totalRecebido(pedido)),
                pendenciaAbertaEm: agora,
                pendenciaAbertaPor: req.usuario.nome,
              }),
        },
        { transaction },
      );
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao liberar pedido");
  }
};

export const cancelar = async (req, res) => {
  try {
    // Motivo opcional.
    const motivo = String(req.body?.motivo || "").trim() || "Sem motivo informado";
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      if (pedido.statusExpedicao === "EXPEDIDO") {
        throw erroHttp(400, "Pedido já expedido não pode ser cancelado.");
      }
      await devolverEstoquePedido(pedido, req.usuario, transaction);
      if (Number(pedido.creditoUsado) > 0 && pedido.clienteId) {
        const cliente = await Usuario.findByPk(pedido.clienteId, { transaction });
        if (cliente) {
          await cliente.update(
            { credito: arredondar(Number(cliente.credito) + Number(pedido.creditoUsado)) },
            { transaction },
          );
        }
      }
      await PedidoParcela.update(
        { status: "CANCELADA" },
        { where: { pedidoId: pedido.id, status: "ABERTA" }, transaction },
      );
      await pedido.update(
        {
          statusVendas: "CANCELADO",
          statusFinanceiro: "CANCELADO",
          pendenciaStatus: pedido.pendenciaStatus ? "QUITADA" : null,
          canceladoEm: new Date(),
          canceladoPor: req.usuario.nome,
          motivoCancelamento: motivo,
        },
        { transaction },
      );
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao cancelar pedido");
  }
};

// Editar pedido: itens, cliente, entrega, desconto e observações.
export const editar = async (req, res) => {
  try {
    const corpo = req.body || {};
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      if (pedido.statusExpedicao === "EXPEDIDO") throw erroHttp(400, "Pedido já expedido.");

      const atualizacao = {};
      const cliente = corpo.cliente || {};
      const mapa = {
        nome: "clienteNome", email: "clienteEmail", telefone: "clienteTelefone",
        documento: "documento", cep: "cep", rua: "rua", numero: "numeroEndereco",
        complemento: "complemento", bairro: "bairro", cidade: "cidade", estado: "estado",
      };
      for (const [campo, coluna] of Object.entries(mapa)) {
        if (cliente[campo] !== undefined) atualizacao[coluna] = cliente[campo];
      }
      if (corpo.observacoes !== undefined) atualizacao.observacoes = corpo.observacoes;
      if (corpo.metodoEnvio !== undefined) atualizacao.metodoEnvio = corpo.metodoEnvio;
      if (corpo.frete !== undefined) atualizacao.frete = numero(corpo.frete);
      if (corpo.freteAdicional !== undefined) atualizacao.freteAdicional = numero(corpo.freteAdicional);
      if (corpo.prazoEntregaDias !== undefined) atualizacao.prazoEntregaDias = corpo.prazoEntregaDias;

      let subtotal = Number(pedido.subtotal);
      if (Array.isArray(corpo.itens)) {
        const estavaBaixado = pedido.estoqueBaixado;
        if (estavaBaixado) {
          await devolverEstoquePedido(pedido, req.usuario, transaction, `Edição do pedido ${pedido.numero}`);
        }
        const manterLiberados = new Set(pedido.itens.filter((i) => i.liberadoSemEstoque).map((i) => i.produtoId));
        const entrada = corpo.itens.map((i) => ({ ...i, liberadoSemEstoque: i.liberadoSemEstoque ?? manterLiberados.has(i.produtoId) }));
        const itens = await montarItens(entrada, req.usuario, transaction, { manterLiberados });
        if (!estavaBaixado && pedido.tipo === "PEDIDO") await verificarEstoque(itens, transaction);
        await PedidoItem.destroy({ where: { pedidoId: pedido.id }, transaction });
        await PedidoItem.bulkCreate(itens.map((i) => ({ ...i, pedidoId: pedido.id })), { transaction });
        subtotal = arredondar(itens.reduce((s, i) => s + i.total, 0));
        atualizacao.subtotal = subtotal;
        atualizacao.pesoTotalGramas = itens.reduce((s, i) => s + i.pesoGramas, 0);
        if (estavaBaixado) {
          const recarregado = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO, transaction });
          await baixarEstoquePedido(recarregado, req.usuario, transaction);
        }
      }
      const desconto = corpo.desconto !== undefined ? numero(corpo.desconto) : Number(pedido.desconto);
      atualizacao.desconto = Math.min(subtotal, Math.max(0, desconto));

      const { taxas, total } = await calcularTotais({
        subtotal,
        desconto: atualizacao.desconto,
        frete: atualizacao.frete ?? Number(pedido.frete),
        freteAdicional: atualizacao.freteAdicional ?? Number(pedido.freteAdicional),
        creditoUsado: Number(pedido.creditoUsado),
        formaPagamento: pedido.formaPagamento,
        parcelasCartao: pedido.parcelasCartao,
        composicaoPagamento: pedido.composicaoPagamento,
      });
      atualizacao.taxas = taxas;
      atualizacao.total = total;
      if (pedido.pendenciaStatus === "ABERTA") {
        atualizacao.pendenciaValor = arredondar(total - totalRecebido(pedido));
      }
      atualizacao.historico = evento(pedido, req.usuario, "EDICAO", {
        totalAnterior: Number(pedido.total),
        totalNovo: total,
      });
      const totalAntes = Number(pedido.total);
      await pedido.update(atualizacao, { transaction });
      // Total mudou: os boletos em aberto são refeitos com o novo saldo.
      if (pedido.formaPagamento === "BOLETO" && pedido.boletoConfig && pedido.statusFinanceiro !== "PAGO" && Math.abs(total - totalAntes) > 0.009) {
        await gerarBoletosDoPedido(pedido, pedido.boletoConfig, req.usuario, transaction);
      }
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao editar pedido");
  }
};

export const alterarFormaPagamento = async (req, res) => {
  try {
    const { formaPagamento, parcelasCartao, composicaoPagamento, motivo } = req.body || {};
    if (!FORMAS_PAGAMENTO[formaPagamento]) throw erroHttp(400, "Forma de pagamento inválida.");
    const boletoConfig = formaPagamento === "BOLETO" ? lerBoletoConfig(req.body?.boleto) : null;
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      const { taxas, total, composicao } = await calcularTotais({
        subtotal: Number(pedido.subtotal),
        desconto: Number(pedido.desconto),
        frete: Number(pedido.frete),
        freteAdicional: Number(pedido.freteAdicional),
        creditoUsado: Number(pedido.creditoUsado),
        formaPagamento,
        parcelasCartao,
        composicaoPagamento,
      });
      if (formaPagamento === "MESCLA") {
        // Parte no cartão com a taxa dela já somada (valorCobrado).
        const linhas = composicao;
        if (!linhas.length) throw erroHttp(400, "Mescla inválida.");
        await PedidoParcela.update(
          { status: "CANCELADA" },
          { where: { pedidoId: pedido.id, status: "ABERTA" }, transaction },
        );
        const ultimo = Math.max(0, ...pedido.parcelas.map((p) => p.numero));
        await PedidoParcela.bulkCreate(
          linhas.map((linha, i) => ({
            pedidoId: pedido.id,
            numero: ultimo + i + 1,
            valor: linha.valorCobrado,
            metodoPrevisto: linha.metodo,
            vencimento: linha.vencimento || hojeISO(),
            usuarioNome: req.usuario.nome,
          })),
          { transaction },
        );
      }
      const tirarLinkRede =
        pedido.pagamentoLink && !FORMAS_PAGAMENTO[pedido.formaPagamento]?.online && !aceitaLinkRede(formaPagamento, composicao);
      await pedido.update(
        {
          formaPagamento,
          parcelasCartao: parcelasCartao || null,
          ...(tirarLinkRede ? { pagamentoLink: null, pagamentoExpiraEm: null } : {}),
          composicaoPagamento: formaPagamento === "MESCLA" ? composicao : null,
          boletoConfig,
          taxas,
          total,
          ...(pedido.pendenciaStatus === "ABERTA"
            ? { pendenciaValor: arredondar(total - totalRecebido(pedido)) }
            : {}),
          historico: evento(pedido, req.usuario, "FORMA_PAGAMENTO", {
            de: pedido.formaPagamento,
            para: formaPagamento,
            totalAnterior: Number(pedido.total),
            totalNovo: total,
            motivo: motivo || null,
          }),
        },
        { transaction },
      );
      if (boletoConfig && pedido.statusFinanceiro !== "PAGO") await gerarBoletosDoPedido(pedido, boletoConfig, req.usuario, transaction);
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao alterar forma de pagamento");
  }
};

export const alterarTransportadora = async (req, res) => {
  try {
    const pedido = await carregar(req.params.id);
    const { transportadoraId, transportadora: escolha, observacoes, cotacao, cotacaoCom } = req.body || {};
    // Aceita o id de um parceiro ou a escolha do seletor (planilha/web), que
    // é cadastrada em Parceiros se ainda não existir.
    let transportadora = null;
    if (escolha) transportadora = await resolverTransportadora(escolha, req.usuario);
    else if (transportadoraId) {
      transportadora = await Parceiro.findByPk(transportadoraId);
      if (!transportadora) throw erroHttp(404, "Transportadora não encontrada.");
    }
    await pedido.update({
      transportadoraId: transportadora?.id || null,
      transportadoraNome: transportadora?.nome || null,
      transportadoraObs: transportadora ? observacoes || null : null,
      transportadoraCotacao: transportadora ? textoCurto(cotacao, 60) : null,
      transportadoraCotacaoCom: transportadora ? textoCurto(cotacaoCom, 150) : null,
    });
    await responderPedido(res, pedido.id);
  } catch (error) {
    responderErro(res, error, "Erro ao alterar transportadora");
  }
};

export const atualizarNotaFiscal = async (req, res) => {
  try {
    const pedido = await carregar(req.params.id);
    if (req.body?.url && !/^https?:\/\//i.test(String(req.body.url))) throw erroHttp(400, "O link da nota precisa começar com https://");
    await pedido.update({
      notaFiscalNumero: req.body?.numero || null,
      notaFiscalUrl: req.body?.url || null,
    });
    await responderPedido(res, pedido.id);
  } catch (error) {
    responderErro(res, error, "Erro ao salvar nota fiscal");
  }
};

// ---------------------------------------------------------------------------
// Time Financeiro
// ---------------------------------------------------------------------------

const marcarPagoSeQuitado = async (pedido, usuario, transaction, observacao) => {
  const recarregado = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO, transaction });
  const recebido = totalRecebido(recarregado);
  if (recebido + 0.009 < Number(recarregado.total)) {
    if (recarregado.pendenciaStatus === "ABERTA") {
      await recarregado.update(
        { pendenciaValor: arredondar(Number(recarregado.total) - recebido) },
        { transaction },
      );
    }
    return;
  }
  await recarregado.update(
    {
      statusFinanceiro: "PAGO",
      pagoEm: new Date(),
      pagoPor: usuario.nome,
      ...(recarregado.pendenciaStatus === "ABERTA"
        ? {
            pendenciaStatus: "QUITADA",
            pendenciaValor: 0,
            pendenciaQuitadaEm: new Date(),
            pendenciaQuitadaPor: usuario.nome,
            observacaoQuitacao: observacao || null,
          }
        : {}),
    },
    { transaction },
  );
};

// Confirmar pagamento integral. Se o pedido ainda aguarda liberação, libera
// junto (reserva o estoque e manda para a expedição).
export const confirmarPagamento = async (req, res) => {
  try {
    const { observacao, metodo, data, liberar: liberarJunto = true } = req.body || {};
    const banco = await bancoValido(req.body?.banco);
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      if (pedido.statusFinanceiro === "PAGO") throw erroHttp(400, "Pagamento já confirmado.");

      const saldo = arredondar(Number(pedido.total) - totalRecebido(pedido));
      await PedidoParcela.update(
        { status: "CANCELADA" },
        { where: { pedidoId: pedido.id, status: "ABERTA" }, transaction },
      );
      if (saldo > 0) {
        await PedidoParcela.create(
          {
            pedidoId: pedido.id,
            numero: Math.max(0, ...pedido.parcelas.map((p) => p.numero)) + 1,
            valor: saldo,
            metodoPrevisto: pedido.formaPagamento,
            metodoRecebido: metodo || pedido.formaPagamento,
            vencimento: data || hojeISO(),
            status: "RECEBIDA",
            recebidaEm: data || hojeISO(),
            bancoRecebedor: banco,
            observacao: observacao || null,
            usuarioNome: req.usuario.nome,
          },
          { transaction },
        );
      }
      if (liberarJunto && pedido.statusVendas === "AGUARDANDO") {
        await baixarEstoquePedido(pedido, req.usuario, transaction);
        await pedido.update(
          {
            statusVendas: "LIBERADO",
            liberadoEm: new Date(),
            liberadoPor: req.usuario.nome,
            observacaoLiberacao: observacao || null,
          },
          { transaction },
        );
      }
      await marcarPagoSeQuitado(pedido, req.usuario, transaction, observacao);
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao confirmar pagamento");
  }
};

// Registrar recebimento parcial (valor pago agora).
export const registrarRecebimento = async (req, res) => {
  try {
    const { valor, metodo, data, observacao } = req.body || {};
    const valorNum = arredondar(numero(valor));
    if (valorNum <= 0) throw erroHttp(400, "Informe o valor recebido.");
    if (!metodo) throw erroHttp(400, "Selecione o método.");
    const banco = await bancoValido(req.body?.banco);
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      if (pedido.parcelas.some((p) => p.status === "ABERTA")) {
        throw erroHttp(400, "Este pedido possui parcelas em aberto. Confirme a próxima parcela no fluxo de parcelas.");
      }
      const saldo = arredondar(Number(pedido.total) - totalRecebido(pedido));
      if (valorNum > saldo + 0.009) throw erroHttp(400, "O valor não pode ultrapassar o saldo em aberto.");
      await PedidoParcela.create(
        {
          pedidoId: pedido.id,
          numero: Math.max(0, ...pedido.parcelas.map((p) => p.numero)) + 1,
          valor: valorNum,
          metodoPrevisto: metodo,
          metodoRecebido: metodo,
          vencimento: data || hojeISO(),
          status: "RECEBIDA",
          recebidaEm: data || hojeISO(),
          bancoRecebedor: banco,
          observacao: observacao || null,
          usuarioNome: req.usuario.nome,
        },
        { transaction },
      );
      await marcarPagoSeQuitado(pedido, req.usuario, transaction, observacao);
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao registrar recebimento");
  }
};

// Controle de parcelas: criar parcela em aberto.
export const adicionarParcela = async (req, res) => {
  try {
    const { valor, metodoPrevisto, vencimento, observacao } = req.body || {};
    const valorNum = arredondar(numero(valor));
    if (valorNum <= 0) throw erroHttp(400, "Informe o valor da parcela.");
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      const comprometido = pedido.parcelas
        .filter((p) => p.status !== "CANCELADA")
        .reduce((s, p) => s + Number(p.valor), 0);
      const disponivel = arredondar(Number(pedido.total) - comprometido);
      if (valorNum > disponivel + 0.009) {
        throw erroHttp(400, "O valor da parcela não pode ultrapassar o disponível para novas parcelas.");
      }
      await PedidoParcela.create(
        {
          pedidoId: pedido.id,
          numero: Math.max(0, ...pedido.parcelas.map((p) => p.numero)) + 1,
          valor: valorNum,
          metodoPrevisto: metodoPrevisto || pedido.formaPagamento,
          vencimento: vencimento || hojeISO(),
          observacao: observacao || null,
          usuarioNome: req.usuario.nome,
        },
        { transaction },
      );
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao adicionar parcela");
  }
};

// Editar, confirmar recebimento ou cancelar uma parcela.
export const atualizarParcela = async (req, res) => {
  try {
    const { acao, valor, metodoPrevisto, metodoRecebido, vencimento, recebidaEm, observacao } = req.body || {};
    const banco = req.body?.banco !== undefined ? await bancoValido(req.body.banco) : undefined;
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      const parcela = pedido.parcelas.find((p) => p.id === req.params.parcelaId);
      if (!parcela) throw erroHttp(404, "Parcela não encontrada.");
      if (parcela.status === "CANCELADA") throw erroHttp(400, "Parcela cancelada não permite alteração.");

      if (acao === "CONFIRMAR") {
        if (parcela.status === "RECEBIDA") throw erroHttp(400, "Parcela já recebida.");
        await parcela.update(
          {
            status: "RECEBIDA",
            metodoRecebido: metodoRecebido || parcela.metodoPrevisto,
            recebidaEm: recebidaEm || hojeISO(),
            bancoRecebedor: banco ?? parcela.bancoRecebedor,
            observacao: observacao ?? parcela.observacao,
            usuarioNome: req.usuario.nome,
          },
          { transaction },
        );
        await marcarPagoSeQuitado(pedido, req.usuario, transaction, observacao);
      } else if (acao === "CANCELAR") {
        if (parcela.status === "RECEBIDA") throw erroHttp(400, "Use a correção de recebimento para parcelas recebidas.");
        await parcela.update({ status: "CANCELADA" }, { transaction });
      } else {
        const novoValor = valor !== undefined ? arredondar(numero(valor)) : Number(parcela.valor);
        const outras = pedido.parcelas
          .filter((p) => p.id !== parcela.id && p.status !== "CANCELADA")
          .reduce((s, p) => s + Number(p.valor), 0);
        if (outras + novoValor > Number(pedido.total) + 0.009) {
          throw erroHttp(400, "A soma das parcelas ultrapassa o total do pedido.");
        }
        await parcela.update(
          {
            valor: novoValor,
            metodoPrevisto: metodoPrevisto ?? parcela.metodoPrevisto,
            metodoRecebido: metodoRecebido ?? parcela.metodoRecebido,
            vencimento: vencimento ?? parcela.vencimento,
            recebidaEm: recebidaEm ?? parcela.recebidaEm,
            bancoRecebedor: banco !== undefined ? banco : parcela.bancoRecebedor,
            observacao: observacao ?? parcela.observacao,
          },
          { transaction },
        );
        if (parcela.status === "RECEBIDA") {
          await pedido.update(
            { historico: evento(pedido, req.usuario, "CORRECAO_RECEBIMENTO", { parcela: parcela.numero }) },
            { transaction },
          );
          await marcarPagoSeQuitado(pedido, req.usuario, transaction, observacao);
        }
      }
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar parcela");
  }
};

// Reabre o financeiro (estorno/correção) — volta para aguardando pagamento.
export const reabrirFinanceiro = async (req, res) => {
  try {
    const motivo = String(req.body?.motivo || "").trim();
    if (!motivo) throw erroHttp(400, "Informe o motivo.");
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      await PedidoParcela.update(
        { status: "CANCELADA" },
        { where: { pedidoId: pedido.id }, transaction },
      );
      await pedido.update(
        {
          statusFinanceiro: "AGUARDANDO_PAGAMENTO",
          pagoEm: null,
          pagoPor: null,
          pendenciaStatus: pedido.statusVendas === "LIBERADO" ? "ABERTA" : null,
          pendenciaValor: pedido.statusVendas === "LIBERADO" ? Number(pedido.total) : null,
          historico: evento(pedido, req.usuario, "REABERTURA_FINANCEIRO", { motivo }),
        },
        { transaction },
      );
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao reabrir financeiro");
  }
};

// ---------------------------------------------------------------------------
// Configurações e alertas de pagamento
// ---------------------------------------------------------------------------

export const alternarCartoesOnline = async (req, res) => {
  try {
    const valor = await salvarConfiguracao("cartoesOnlineHabilitados", Boolean(req.body?.habilitado));
    res.json({ habilitado: valor });
  } catch (error) {
    responderErro(res, error, "Erro ao salvar configuração");
  }
};

export const listarAlertasPagamento = async (req, res) => {
  try {
    const status = req.query.status === "RESOLVIDO" ? "RESOLVIDO" : "ATIVO";
    const alertas = await AlertaPagamento.findAll({
      where: { status },
      order: [["createdAt", "DESC"]],
      limit: 200,
    });
    res.json(alertas);
  } catch (error) {
    responderErro(res, error, "Erro ao listar alertas");
  }
};

export const resolverAlertaPagamento = async (req, res) => {
  try {
    const alerta = await AlertaPagamento.findByPk(req.params.alertaId);
    if (!alerta) throw erroHttp(404, "Alerta não encontrado.");
    await alerta.update({ status: "RESOLVIDO", resolvidoEm: new Date(), resolvidoPor: req.usuario.nome });
    res.json(alerta);
  } catch (error) {
    responderErro(res, error, "Erro ao resolver alerta");
  }
};

// Boletos de um pedido já existente (criar ou refazer): data do primeiro e
// quantidade, de 30 em 30 dias. Os boletos em aberto são trocados pelos novos.
// ---------------------------------------------------------------------------
// Link de pagamento da Rede (gerado pela equipe no portal da Rede e colado
// aqui): o cliente vê o botão "Pagar com cartão" na tela do pedido.
// ---------------------------------------------------------------------------

const FORMAS_LINK_REDE = ["CREDITO_LINK", "LINK_PAGAMENTO"];
const HOSTS_REDE = ["userede.com.br", "rede.com.br", "itau.com.br"];

const aceitaLinkRede = (formaPagamento, composicao) =>
  FORMAS_LINK_REDE.includes(formaPagamento) ||
  (formaPagamento === "MESCLA" && (composicao || []).some((l) => FORMAS_LINK_REDE.includes(l.metodo)));

// Só https e só domínios da Rede/Itaú (mais os de REDE_LINK_HOSTS, se a Rede
// usar outro): evita que um link qualquer apareça para o cliente pagar.
const lerLinkRede = (bruto) => {
  const texto = String(bruto ?? "").trim();
  if (!texto) return null;
  let url;
  try {
    url = new URL(texto);
  } catch {
    throw erroHttp(400, "Cole o link completo gerado na Rede (começa com https://).");
  }
  if (url.protocol !== "https:" || url.username || url.password || texto.length > 1000) {
    throw erroHttp(400, "Link inválido: use o link https gerado no portal da Rede.");
  }
  const host = url.hostname.toLowerCase();
  const extras = String(process.env.REDE_LINK_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (![...HOSTS_REDE, ...extras].some((h) => host === h || host.endsWith(`.${h}`))) {
    throw erroHttp(400, `Esse link não é da Rede/Itaú (${host}). Confira se copiou o link certo.`);
  }
  return url.toString();
};

// Vencimento do link (AAAA-MM-DD, até 30 dias): vale até o fim do dia.
const lerVencimentoLink = (valor) => {
  const texto = String(valor || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) throw erroHttp(400, "Informe o vencimento do link.");
  const fim = new Date(`${texto}T23:59:59-03:00`);
  const dias = (fim - Date.now()) / 86_400_000;
  if (Number.isNaN(fim.getTime()) || dias < 0 || dias > 31) throw erroHttp(400, "Vencimento do link inválido.");
  return fim;
};

export const salvarLinkRede = async (req, res) => {
  try {
    const link = lerLinkRede(req.body?.link);
    const expiraEm = link ? lerVencimentoLink(req.body?.vencimento) : null;
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      if (link && pedido.statusFinanceiro === "PAGO") throw erroHttp(400, "Pedido já pago.");
      if (FORMAS_PAGAMENTO[pedido.formaPagamento]?.online) throw erroHttp(400, "Este pedido usa pagamento online: o link é gerado pelo banco.");
      if (link && !aceitaLinkRede(pedido.formaPagamento, pedido.composicaoPagamento)) {
        throw erroHttp(400, "Mude a forma de pagamento do pedido para Crédito link primeiro.");
      }
      await pedido.update(
        {
          pagamentoLink: link,
          pagamentoExpiraEm: expiraEm,
          historico: evento(pedido, req.usuario, link ? "LINK_REDE" : "LINK_REDE_REMOVIDO", link ? { vencimento: req.body.vencimento } : {}),
        },
        { transaction },
      );
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao salvar o link de pagamento");
  }
};

export const definirBoletos = async (req, res) => {
  try {
    const config = lerBoletoConfig(req.body);
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      if (pedido.statusFinanceiro === "PAGO") throw erroHttp(400, "Pedido já pago.");
      if (pedido.formaPagamento !== "BOLETO") throw erroHttp(400, "Mude a forma de pagamento do pedido para Boleto primeiro.");
      await gerarBoletosDoPedido(pedido, config, req.usuario, transaction);
      await pedido.update(
        { boletoConfig: config, historico: evento(pedido, req.usuario, "BOLETOS", { quantidade: config.quantidade, primeiroVencimento: config.primeiroVencimento }) },
        { transaction },
      );
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao gerar os boletos");
  }
};
