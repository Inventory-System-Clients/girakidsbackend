import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { Pedido, PedidoParcela, AlertaPagamento } from "../models/index.js";
import { obterProvedor, provedorAtivo, provedorMaquininha, statusPagamentos } from "../services/pagamentos/index.js";
import { configPagamentos } from "../services/pagamentos/config.js";
import { baixarEstoquePedido } from "../services/estoqueService.js";
import { INCLUDE_COMPLETO, serializarPedido } from "../services/pedidoService.js";
import { arredondar, erroHttp, hojeISO, responderErro } from "../utils/helpers.js";

export const status = (req, res) => res.json(statusPagamentos());

// Confirma um pedido pago pelo banco: registra o recebimento, quita e libera
// para a expedição (mesmo efeito do "Confirmar pagamento" do Time Financeiro).
const confirmarPagamentoOnline = async (pedido, valorPago, origem) =>
  sequelize.transaction(async (transaction) => {
    const atual = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO, transaction });
    if (atual.statusFinanceiro === "PAGO") return;
    const sistema = { nome: origem, email: null };
    await PedidoParcela.create(
      {
        pedidoId: atual.id,
        numero: Math.max(0, ...atual.parcelas.map((p) => p.numero)) + 1,
        valor: valorPago,
        metodoPrevisto: atual.formaPagamento,
        metodoRecebido: atual.formaPagamento,
        vencimento: hojeISO(),
        recebidaEm: hojeISO(),
        status: "RECEBIDA",
        usuarioNome: origem,
      },
      { transaction },
    );
    if (atual.statusVendas === "AGUARDANDO") {
      await baixarEstoquePedido(atual, sistema, transaction);
    }
    await atual.update(
      {
        statusFinanceiro: "PAGO",
        pagoEm: new Date(),
        pagoPor: origem,
        ...(atual.statusVendas === "AGUARDANDO"
          ? { statusVendas: "LIBERADO", liberadoEm: new Date(), liberadoPor: `${origem} (banco)` }
          : {}),
      },
      { transaction },
    );
  });

const alertar = (dados) => AlertaPagamento.create(dados).catch((e) => console.error(e));

// Aplica o resultado de um retorno/consulta do banco ao pedido. Valor
// diferente do pedido não confirma: vira alerta para o financeiro.
const aplicarResultado = async (pedido, resultado, provedor, bruto = null) => {
  if (resultado.status === "PAGO") {
    if (pedido.statusFinanceiro === "PAGO") return;
    const esperado = arredondar(Number(pedido.total));
    const pago = arredondar(Number(resultado.valorPago ?? esperado));
    if (Math.abs(pago - esperado) > 0.01) {
      const jaAlertado = await AlertaPagamento.count({ where: { pedidoId: pedido.id, motivo: "valor_divergente", status: "ATIVO" } });
      if (!jaAlertado) {
        await alertar({
          pedidoId: pedido.id,
          pedidoNumero: String(pedido.numero),
          provedor: provedor.nome,
          severidade: "warning",
          motivo: "valor_divergente",
          mensagem: `Valor pago diferente do pedido ${pedido.numero}`,
          valorEsperado: esperado,
          valorRecebido: pago,
          detalhes: bruto,
        });
      }
      return;
    }
    await confirmarPagamentoOnline(pedido, pago, provedor.rotulo || provedor.nome);
  } else if (["RECUSADO", "EXPIRADO"].includes(resultado.status)) {
    const tipo = `PAGAMENTO_${resultado.status}`;
    const historico = pedido.historico || [];
    if (historico.at(-1)?.tipo !== tipo) {
      await pedido.update({ historico: [...historico, { tipo, por: provedor.rotulo || provedor.nome, em: new Date().toISOString() }] });
    }
  }
};

// Webhook do banco: POST /api/pagamentos/webhook/:provedor
// O corpo recebido nunca é confiado: o provedor relê a cobrança na API dele.
export const webhook = async (req, res) => {
  const provedor = obterProvedor(req.params.provedor);
  if (!provedor) return res.status(404).json({ error: "Provedor desconhecido." });

  let evento;
  try {
    evento = await provedor.interpretarWebhook(req);
  } catch (error) {
    console.error(`[Pagamentos] Webhook ${provedor.nome} recusado:`, error.message);
    return res.status(400).json({ error: "Webhook inválido." });
  }
  if (!evento || evento.ignorar) return res.json({ ok: true });

  try {
    const ehUuid = /^[0-9a-f-]{36}$/i.test(String(evento.pedidoId || ""));
    const pedido = await Pedido.findOne({
      where: ehUuid ? { id: evento.pedidoId } : { pagamentoReferencia: evento.referencia },
      include: INCLUDE_COMPLETO,
    });
    if (!pedido) {
      if (evento.status === "PAGO") {
        await alertar({
          provedor: provedor.nome,
          severidade: "critical",
          motivo: "pedido_nao_encontrado",
          mensagem: `Pagamento confirmado pelo ${provedor.rotulo || provedor.nome} (${evento.referencia || evento.eventoId}) sem pedido correspondente`,
          valorRecebido: evento.valorPago ?? null,
          detalhes: evento.bruto,
        });
      }
      return res.json({ ok: true });
    }
    await aplicarResultado(pedido, evento, provedor, evento.bruto);
    res.json({ ok: true });
  } catch (error) {
    await alertar({
      provedor: provedor.nome,
      severidade: "critical",
      motivo: "falha_processamento",
      mensagem: `Falha ao processar retorno de pagamento: ${error.message}`,
      detalhes: evento?.bruto || null,
    });
    responderErro(res, error, "Erro ao processar webhook");
  }
};

const verificarAcesso = (req, pedido) => {
  if (!pedido) throw erroHttp(404, "Pedido não encontrado.");
  if (req.usuario.role === "CLIENTE" && pedido.clienteId !== req.usuario.id) throw erroHttp(403, "Este pedido não pertence à sua conta.");
  if (req.usuario.role === "SHOWROOM" && pedido.criadoPorId !== req.usuario.id) throw erroHttp(403, "Este pedido não foi tirado neste showroom.");
};

// "Atualizar status" na tela de pagamento: consulta o banco direto.
export const consultar = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, { include: INCLUDE_COMPLETO });
    verificarAcesso(req, pedido);
    const provedor = obterProvedor(pedido.pagamentoProvedor);
    if (provedor && pedido.pagamentoReferencia && pedido.statusFinanceiro !== "PAGO") {
      const resultado = await provedor.consultarCobranca(pedido.pagamentoReferencia, pedido);
      await aplicarResultado(pedido, resultado, provedor);
    }
    const atualizado = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO });
    res.json(serializarPedido(atualizado));
  } catch (error) {
    responderErro(res, error, "Erro ao consultar pagamento");
  }
};

// Gera de novo a cobrança online (PIX expirado ou falha ao criar no pedido).
export const gerarCobranca = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, { include: INCLUDE_COMPLETO });
    verificarAcesso(req, pedido);
    if (pedido.statusVendas === "CANCELADO") throw erroHttp(400, "Pedido cancelado.");
    if (pedido.statusFinanceiro === "PAGO") throw erroHttp(400, "Pedido já está pago.");
    if (!["PIX_ONLINE", "CREDITO_ONLINE", "DEBITO_ONLINE"].includes(pedido.formaPagamento)) throw erroHttp(400, "Este pedido não é de pagamento online.");
    const provedor = provedorAtivo();
    if (!provedor) throw erroHttp(400, "Pagamento online indisponível no momento.");
    const cobranca = await provedor.criarCobranca({ pedido, metodo: pedido.formaPagamento, parcelas: pedido.parcelasCartao });
    await pedido.update({
      pagamentoProvedor: provedor.nome,
      pagamentoReferencia: cobranca.referencia,
      pagamentoLink: cobranca.link || null,
      pagamentoQrCode: cobranca.qrCode || cobranca.copiaECola || null,
      pagamentoExpiraEm: cobranca.expiraEm || null,
    });
    const atualizado = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO });
    res.json(serializarPedido(atualizado));
  } catch (error) {
    responderErro(res, error, "Erro ao gerar a cobrança");
  }
};

// Conciliação automática: cobranças em aberto das últimas 48 h são
// consultadas no banco (cobre quem fechou a tela e bancos sem webhook).
let conciliando = false;
export const conciliarPendentes = async () => {
  if (conciliando) return;
  conciliando = true;
  try {
    const pedidos = await Pedido.findAll({
      where: {
        statusFinanceiro: "AGUARDANDO_PAGAMENTO",
        statusVendas: { [Op.ne]: "CANCELADO" },
        pagamentoReferencia: { [Op.ne]: null },
        pagamentoProvedor: { [Op.ne]: null },
        updatedAt: { [Op.gte]: new Date(Date.now() - 48 * 3600 * 1000) },
      },
      include: INCLUDE_COMPLETO,
      limit: 50,
    });
    for (const pedido of pedidos) {
      const provedor = obterProvedor(pedido.pagamentoProvedor);
      if (!provedor?.configurado?.()) continue;
      try {
        await aplicarResultado(pedido, await provedor.consultarCobranca(pedido.pagamentoReferencia, pedido), provedor);
      } catch (error) {
        console.warn(`[Pagamentos] Conciliação do pedido ${pedido.numero} falhou:`, error.message);
      }
    }
  } finally {
    conciliando = false;
  }
};

export const iniciarConciliacao = () => {
  const t = setInterval(() => conciliarPendentes().catch((e) => console.warn("[Pagamentos] Conciliação:", e.message)), 60_000);
  t.unref?.();
};

// Equipe: envia a cobrança do pedido para uma maquininha.
export const cobrarNaMaquininha = async (req, res) => {
  try {
    const provedor = provedorMaquininha();
    if (!provedor) throw erroHttp(400, "Nenhum banco de maquininha configurado na aba Pagamentos.");
    const maquininha = configPagamentos().maquininhas.find((m) => m.id === req.body?.maquininhaId && m.ativa !== false);
    if (!maquininha) throw erroHttp(400, "Escolha uma maquininha cadastrada.");
    if (maquininha.provedor !== provedor.nome) throw erroHttp(400, `Esta maquininha é ${maquininha.provedor}; o banco de maquininha ativo é ${provedor.rotulo}.`);
    const pedido = await Pedido.findByPk(req.params.id, { include: INCLUDE_COMPLETO });
    verificarAcesso(req, pedido);
    if (pedido.statusVendas === "CANCELADO") throw erroHttp(400, "Pedido cancelado.");
    if (pedido.statusFinanceiro === "PAGO") throw erroHttp(400, "Pedido já está pago.");
    // Cobrança anterior ainda aberta em maquininha: tira da tela antes.
    const anterior = obterProvedor(pedido.pagamentoProvedor);
    if (anterior?.cancelarMaquininha && /^(point|reader|stone):/.test(pedido.pagamentoReferencia || "")) {
      await anterior.cancelarMaquininha(pedido.pagamentoReferencia).catch(() => {});
    }
    const { referencia } = await provedor.cobrarMaquininha({ pedido, maquininha });
    await pedido.update({
      pagamentoProvedor: provedor.nome,
      pagamentoReferencia: referencia,
      historico: [...(pedido.historico || []), { tipo: "COBRANCA_MAQUININHA", maquininha: maquininha.nome, por: req.usuario.nome, em: new Date().toISOString() }],
    });
    const atualizado = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO });
    res.json(serializarPedido(atualizado));
  } catch (error) {
    responderErro(res, error, "Erro ao enviar para a maquininha");
  }
};

export const cancelarNaMaquininha = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, { include: INCLUDE_COMPLETO });
    verificarAcesso(req, pedido);
    const provedor = obterProvedor(pedido.pagamentoProvedor);
    if (provedor?.cancelarMaquininha && pedido.pagamentoReferencia) await provedor.cancelarMaquininha(pedido.pagamentoReferencia);
    if (/^(point|reader|stone):/.test(pedido.pagamentoReferencia || "") && pedido.statusFinanceiro !== "PAGO") {
      await pedido.update({ pagamentoReferencia: null, pagamentoProvedor: null });
    }
    const atualizado = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO });
    res.json(serializarPedido(atualizado));
  } catch (error) {
    responderErro(res, error, "Erro ao cancelar a cobrança na maquininha");
  }
};
