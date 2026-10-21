import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
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
  montarFiltroPedidos,
  montarItens,
  serializarPedido,
  totalRecebido,
} from "../services/pedidoService.js";
import {
  baixarEstoquePedido,
  devolverEstoquePedido,
} from "../services/estoqueService.js";
import { cotarFrete } from "../services/freteService.js";
import { statusPagamentos } from "../services/pagamentos/index.js";
import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";
import { FORMAS_PAGAMENTO } from "../utils/formasPagamento.js";
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
      order: [["numero", "DESC"]],
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
    const pedidos = await Pedido.findAll({
      where: { clienteId: req.usuario.id, tipo: "PEDIDO" },
      include: INCLUDE_COMPLETO,
      order: [["createdAt", "DESC"]],
      limit: Math.min(Number(req.query.limite) || 20, 100),
      offset: Number(req.query.offset) || 0,
    });
    res.json(pedidos.map((p) => serializarPedido(p, { completo: false })));
  } catch (error) {
    responderErro(res, error, "Erro ao listar seus pedidos");
  }
};

export const obter = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, { include: [...INCLUDE_COMPLETO, INCLUDE_CLIENTE] });
    if (!pedido) throw erroHttp(404, "Pedido não encontrado.");
    if (!ehInterno(req.usuario) && pedido.clienteId !== req.usuario.id) {
      return res.status(403).json({ error: "Este pedido não pertence à sua conta." });
    }
    const dados = serializarPedido(pedido);
    if (!ehInterno(req.usuario)) delete dados.cliente;
    if (pedido.transportadoraId) {
      const transportadora = await Parceiro.findByPk(pedido.transportadoraId);
      dados.transportadora = transportadora?.toJSON() || null;
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
    if (!ehInterno(req.usuario)) where.clienteId = req.usuario.id;
    const pedido = await Pedido.findOne({ where, include: INCLUDE_COMPLETO, order: [["tipo", "ASC"]] });
    if (!pedido) return res.status(404).json({ error: "Não foi possível encontrar um pedido com este código." });
    res.json(serializarPedido(pedido));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar pedido");
  }
};

export const contadores = async (req, res) => {
  try {
    const [aguardandoLiberacao, aguardandoExpedicao, alertas] = await Promise.all([
      Pedido.count({ where: { tipo: "PEDIDO", statusVendas: "AGUARDANDO" } }),
      Pedido.count({
        where: { tipo: "PEDIDO", statusVendas: "LIBERADO", statusExpedicao: { [Op.ne]: "EXPEDIDO" } },
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
    const formas = Object.entries(FORMAS_PAGAMENTO)
      .filter(([, cfg]) => interno || !cfg.admin)
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
    res.json({
      formas,
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
    res.json(await cotarFrete(req.body || {}));
  } catch (error) {
    responderErro(res, error, "Erro ao calcular frete");
  }
};

export const criar = async (req, res) => {
  try {
    const pedido = await criarPedido(req.body || {}, req.usuario, "PEDIDO");
    res.locals.entityId = pedido.id;
    res.status(201).json(serializarPedido(pedido));
  } catch (error) {
    responderErro(res, error, "Erro ao criar pedido");
  }
};

export const criarOrcamento = async (req, res) => {
  try {
    const pedido = await criarPedido(req.body || {}, req.usuario, "ORCAMENTO");
    res.locals.entityId = pedido.id;
    res.status(201).json(serializarPedido(pedido));
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
      })),
      metodoEnvio: orcamento.metodoEnvio,
      desconto: orcamento.desconto,
      freteAdicional: orcamento.freteAdicional,
      formaPagamento: orcamento.formaPagamento,
      parcelasCartao: orcamento.parcelasCartao,
      composicaoPagamento: orcamento.composicaoPagamento,
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
    const motivo = String(req.body?.motivo || "").trim();
    if (!motivo) throw erroHttp(400, "Informe o motivo do cancelamento.");
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
        const itens = await montarItens(corpo.itens, req.usuario, transaction);
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
      await pedido.update(atualizacao, { transaction });
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
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarParaAlterar(req.params.id, transaction);
      garantirNaoCancelado(pedido);
      const { taxas, total } = await calcularTotais({
        subtotal: Number(pedido.subtotal),
        desconto: Number(pedido.desconto),
        frete: Number(pedido.frete),
        freteAdicional: Number(pedido.freteAdicional),
        creditoUsado: Number(pedido.creditoUsado),
        formaPagamento,
        parcelasCartao,
      });
      if (formaPagamento === "MESCLA") {
        const linhas = (composicaoPagamento || []).filter((l) => numero(l.valor) > 0);
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
            valor: numero(linha.valor),
            metodoPrevisto: linha.metodo,
            vencimento: linha.vencimento || hojeISO(),
            usuarioNome: req.usuario.nome,
          })),
          { transaction },
        );
      }
      await pedido.update(
        {
          formaPagamento,
          parcelasCartao: parcelasCartao || null,
          composicaoPagamento: formaPagamento === "MESCLA" ? composicaoPagamento : null,
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
    });
    await responderPedido(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao alterar forma de pagamento");
  }
};

export const alterarTransportadora = async (req, res) => {
  try {
    const pedido = await carregar(req.params.id);
    const { transportadoraId, observacoes } = req.body || {};
    let nome = null;
    if (transportadoraId) {
      const transportadora = await Parceiro.findByPk(transportadoraId);
      if (!transportadora) throw erroHttp(404, "Transportadora não encontrada.");
      nome = transportadora.nome;
    }
    await pedido.update({
      transportadoraId: transportadoraId || null,
      transportadoraNome: nome,
      transportadoraObs: observacoes || null,
    });
    await responderPedido(res, pedido.id);
  } catch (error) {
    responderErro(res, error, "Erro ao alterar transportadora");
  }
};

export const atualizarNotaFiscal = async (req, res) => {
  try {
    const pedido = await carregar(req.params.id);
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
