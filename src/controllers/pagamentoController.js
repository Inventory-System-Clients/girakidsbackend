import { sequelize } from "../database/connection.js";
import { Pedido, PedidoParcela, AlertaPagamento } from "../models/index.js";
import { obterProvedor, statusPagamentos } from "../services/pagamentos/index.js";
import { baixarEstoquePedido } from "../services/estoqueService.js";
import { INCLUDE_COMPLETO, serializarPedido } from "../services/pedidoService.js";
import { arredondar, hojeISO, responderErro } from "../utils/helpers.js";

export const status = (req, res) => res.json(statusPagamentos());

// Confirma um pedido pago online: registra o recebimento, quita e libera
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
          ? { statusVendas: "LIBERADO", liberadoEm: new Date(), liberadoPor: `${origem} webhook` }
          : {}),
      },
      { transaction },
    );
  });

const alertar = (dados) => AlertaPagamento.create(dados).catch((e) => console.error(e));

// Webhook do banco/gateway: POST /api/pagamentos/webhook/:provedor
export const webhook = async (req, res) => {
  const provedor = obterProvedor(req.params.provedor);
  if (!provedor) return res.status(404).json({ error: "Provedor desconhecido." });

  let evento;
  try {
    evento = await provedor.interpretarWebhook(req);
  } catch (error) {
    console.error("[Pagamentos] Webhook inválido:", error.message);
    return res.status(400).json({ error: "Webhook inválido." });
  }

  try {
    const pedido = await Pedido.findOne({
      where: { pagamentoReferencia: evento.referencia },
      include: INCLUDE_COMPLETO,
    });
    if (!pedido) {
      await alertar({
        provedor: provedor.nome,
        severidade: "critical",
        motivo: "pedido_nao_encontrado",
        mensagem: `Retorno do ${provedor.nome} para a cobrança ${evento.referencia} sem pedido correspondente`,
        valorRecebido: evento.valorPago ?? null,
        detalhes: evento.bruto,
      });
      return res.json({ ok: true });
    }

    if (evento.status === "PAGO") {
      const esperado = arredondar(Number(pedido.total));
      const pago = arredondar(Number(evento.valorPago ?? esperado));
      if (Math.abs(pago - esperado) > 0.01) {
        await alertar({
          pedidoId: pedido.id,
          pedidoNumero: String(pedido.numero),
          provedor: provedor.nome,
          severidade: "warning",
          motivo: "valor_divergente",
          mensagem: `Valor pago diferente do pedido ${pedido.numero}`,
          valorEsperado: esperado,
          valorRecebido: pago,
          detalhes: evento.bruto,
        });
      } else {
        await confirmarPagamentoOnline(pedido, pago, provedor.nome);
      }
    } else if (["RECUSADO", "EXPIRADO"].includes(evento.status)) {
      await pedido.update({
        historico: [
          ...pedido.historico,
          { tipo: `PAGAMENTO_${evento.status}`, por: provedor.nome, em: new Date().toISOString() },
        ],
      });
    }
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

// "Atualizar status" na tela de pagamento: consulta o banco direto.
export const consultar = async (req, res) => {
  try {
    const pedido = await Pedido.findByPk(req.params.id, { include: INCLUDE_COMPLETO });
    if (!pedido) return res.status(404).json({ error: "Pedido não encontrado." });
    if (req.usuario.role === "CLIENTE" && pedido.clienteId !== req.usuario.id) {
      return res.status(403).json({ error: "Este pedido não pertence à sua conta." });
    }
    const provedor = obterProvedor(pedido.pagamentoProvedor);
    if (provedor && pedido.pagamentoReferencia && pedido.statusFinanceiro !== "PAGO") {
      const cobranca = await provedor.consultarCobranca(pedido.pagamentoReferencia);
      if (cobranca.status === "PAGO") {
        await confirmarPagamentoOnline(pedido, Number(cobranca.valorPago ?? pedido.total), provedor.nome);
      }
    }
    const atualizado = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO });
    res.json(serializarPedido(atualizado));
  } catch (error) {
    responderErro(res, error, "Erro ao consultar pagamento");
  }
};
