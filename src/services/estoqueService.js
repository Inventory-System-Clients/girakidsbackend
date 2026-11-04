import { Produto, MovimentacaoEstoque } from "../models/index.js";
import { erroHttp } from "../utils/helpers.js";
import { afetaMontagem, aplicarNosSaldos, recalcularMontagem } from "./montagemService.js";

// Registra a mudança de estoque de um produto (em unidades) e a auditoria.
// Produtos com montagem em cápsula também atualizam os saldos de montagem, e
// mexer em cápsula/brinquedo solto recalcula o estoque dos produtos montados.
export const movimentar = async ({
  produto,
  delta,
  tipo,
  motivo,
  pedido = null,
  usuario = null,
  transaction,
  origem = null,
}) => {
  // Outro movimento da mesma operação pode ter mexido neste produto (ex.:
  // cápsula consumida na montagem de um item anterior do pedido).
  await produto.reload({ transaction });
  const anterior = Number(produto.estoque || 0);
  const nova = anterior + delta;
  if (produto.controlaMontagem) await aplicarNosSaldos(produto, delta, { motivo, usuario, pedido, transaction });
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
      origem,
    },
    { transaction },
  );
  if (await afetaMontagem(produto, transaction)) {
    await recalcularMontagem({ transaction, usuario });
    await produto.reload({ transaction });
    return Number(produto.estoque);
  }
  return nova;
};

// Unidades que cada item consome por produto (produto composto consome os
// componentes, não ele mesmo). "liberado": algum item foi lançado sem estoque
// por um admin e pode deixar o estoque negativo.
const consumoDoPedido = async (itens, transaction) => {
  const ids = [...new Set(itens.map((item) => item.produtoId).filter(Boolean))];
  const produtos = await Produto.findAll({ where: { id: ids }, transaction });
  const porId = new Map(produtos.map((p) => [p.id, p]));
  const consumo = new Map();
  const somar = (produtoId, unidades, sobEncomenda, liberado) => {
    const atual = consumo.get(produtoId) || { unidades: 0, sobEncomenda: false, liberado: false };
    atual.unidades += unidades;
    atual.sobEncomenda = atual.sobEncomenda || sobEncomenda;
    atual.liberado = atual.liberado || liberado;
    consumo.set(produtoId, atual);
  };

  for (const item of itens) {
    const produto = porId.get(item.produtoId);
    if (!produto) continue;
    const unidades = Number(item.quantidade) * Number(item.unidadesPacote || 1);
    const sobEncomenda = produto.modoVenda === "ENCOMENDA";
    const liberado = Boolean(item.liberadoSemEstoque);
    if (produto.tipo === "COMPOSTO" && produto.componentes?.length) {
      for (const componente of produto.componentes) {
        somar(componente.produtoId, unidades * Number(componente.quantidade || 1), sobEncomenda, liberado);
      }
    } else {
      somar(produto.id, unidades, sobEncomenda, liberado);
    }
  }
  return consumo;
};

// Confere se há estoque para os itens (por encomenda ou liberado sem estoque
// pelo admin não precisa) e lança 409
// listando o que falta. Devolve o consumo e os produtos lidos.
export const verificarEstoque = async (itens, transaction, { travar = false } = {}) => {
  const consumo = await consumoDoPedido(itens, transaction);
  const produtos = await Produto.findAll({
    where: { id: [...consumo.keys()] },
    transaction,
    lock: travar && transaction ? transaction.LOCK.UPDATE : undefined,
  });

  const faltando = produtos.filter((produto) => {
    const { unidades, sobEncomenda, liberado } = consumo.get(produto.id);
    return !sobEncomenda && !liberado && Number(produto.estoque) < unidades;
  });
  if (faltando.length) {
    const erro = erroHttp(
      409,
      `Estoque insuficiente: ${faltando
        .map((p) => `${p.nome} (disponível ${Math.max(0, Number(p.estoque))} un.)`)
        .join(", ")}`,
    );
    erro.semEstoque = true;
    throw erro;
  }
  return { consumo, produtos };
};

// Reserva (baixa) o estoque do pedido — feito ao liberar para expedição.
export const baixarEstoquePedido = async (pedido, usuario, transaction) => {
  if (pedido.estoqueBaixado) return;
  const { consumo, produtos } = await verificarEstoque(pedido.itens, transaction, { travar: true });

  for (const produto of produtos) {
    const { unidades, sobEncomenda } = consumo.get(produto.id);
    // Por encomenda: baixa só o que existe; o restante vai para a fila.
    // Liberado sem estoque baixa tudo e o estoque fica negativo: a próxima
    // entrada desconta o que ficou devendo.
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
