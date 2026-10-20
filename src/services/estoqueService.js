import { Produto, MovimentacaoEstoque } from "../models/index.js";
import { erroHttp } from "../utils/helpers.js";

// Registra a mudança de estoque de um produto (em unidades) e a auditoria.
export const movimentar = async ({
  produto,
  delta,
  tipo,
  motivo,
  pedido = null,
  usuario = null,
  transaction,
}) => {
  const anterior = Number(produto.estoque || 0);
  const nova = anterior + delta;
  await produto.update({ estoque: nova }, { transaction });
  await MovimentacaoEstoque.create(
    {
      produtoId: produto.id,
      produtoNome: produto.nome,
      produtoSku: produto.sku,
      tipo,
      quantidade: Math.abs(delta),
      quantidadeAnterior: anterior,
      quantidadeNova: nova,
      motivo,
      pedidoId: pedido?.id || null,
      pedidoNumero: pedido ? String(pedido.numero) : null,
      clienteNome: pedido?.clienteNome || null,
      clienteEmail: pedido?.clienteEmail || null,
      usuarioNome: usuario?.nome || null,
      usuarioEmail: usuario?.email || null,
    },
    { transaction },
  );
  return nova;
};

// Unidades que cada item consome por produto (produto composto consome os
// componentes, não ele mesmo).
const consumoDoPedido = async (itens, transaction) => {
  const ids = [...new Set(itens.map((item) => item.produtoId).filter(Boolean))];
  const produtos = await Produto.findAll({ where: { id: ids }, transaction });
  const porId = new Map(produtos.map((p) => [p.id, p]));
  const consumo = new Map();
  const somar = (produtoId, unidades, sobEncomenda) => {
    const atual = consumo.get(produtoId) || { unidades: 0, sobEncomenda: false };
    atual.unidades += unidades;
    atual.sobEncomenda = atual.sobEncomenda || sobEncomenda;
    consumo.set(produtoId, atual);
  };

  for (const item of itens) {
    const produto = porId.get(item.produtoId);
    if (!produto) continue;
    const unidades = Number(item.quantidade) * Number(item.unidadesPacote || 1);
    const sobEncomenda = produto.modoVenda === "ENCOMENDA";
    if (produto.tipo === "COMPOSTO" && produto.componentes?.length) {
      for (const componente of produto.componentes) {
        somar(componente.produtoId, unidades * Number(componente.quantidade || 1), sobEncomenda);
      }
    } else {
      somar(produto.id, unidades, sobEncomenda);
    }
  }
  return consumo;
};

// Reserva (baixa) o estoque do pedido — feito ao liberar para expedição.
export const baixarEstoquePedido = async (pedido, usuario, transaction) => {
  if (pedido.estoqueBaixado) return;
  const consumo = await consumoDoPedido(pedido.itens, transaction);
  const produtos = await Produto.findAll({
    where: { id: [...consumo.keys()] },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });

  const faltando = produtos.filter((produto) => {
    const { unidades, sobEncomenda } = consumo.get(produto.id);
    return !sobEncomenda && Number(produto.estoque) < unidades;
  });
  if (faltando.length) {
    throw erroHttp(
      409,
      `Estoque insuficiente: ${faltando
        .map((p) => `${p.nome} (disponível ${p.estoque} un.)`)
        .join(", ")}`,
    );
  }

  for (const produto of produtos) {
    const { unidades, sobEncomenda } = consumo.get(produto.id);
    // Por encomenda: baixa só o que existe; o restante vai para a fila.
    const baixa = sobEncomenda ? Math.min(unidades, Math.max(0, Number(produto.estoque))) : unidades;
    if (!baixa) continue;
    await movimentar({
      produto,
      delta: -baixa,
      tipo: "SAIDA",
      motivo: `Venda - pedido ${pedido.numero}`,
      pedido,
      usuario,
      transaction,
    });
  }
  await pedido.update({ estoqueBaixado: true }, { transaction });
};

// Devolve o estoque reservado (cancelamento ou edição de itens).
export const devolverEstoquePedido = async (pedido, usuario, transaction, motivo) => {
  if (!pedido.estoqueBaixado) return;
  // Devolve exatamente o que saiu por este pedido (item por encomenda pode ter
  // baixado só parte).
  const movimentos = await MovimentacaoEstoque.findAll({
    where: { pedidoId: pedido.id },
    transaction,
  });
  const saldo = new Map();
  for (const mov of movimentos) {
    if (!mov.produtoId || mov.tipo === "AJUSTE") continue;
    const sinal = mov.tipo === "SAIDA" ? 1 : -1;
    saldo.set(mov.produtoId, (saldo.get(mov.produtoId) || 0) + sinal * mov.quantidade);
  }
  const produtos = await Produto.findAll({ where: { id: [...saldo.keys()] }, transaction });
  for (const produto of produtos) {
    const unidades = saldo.get(produto.id);
    if (unidades <= 0) continue;
    await movimentar({
      produto,
      delta: unidades,
      tipo: "ENTRADA",
      motivo: motivo || `Devolução - pedido ${pedido.numero} cancelado`,
      pedido,
      usuario,
      transaction,
    });
  }
  await pedido.update({ estoqueBaixado: false }, { transaction });
};
