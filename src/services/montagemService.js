import { Produto, MovimentacaoEstoque } from "../models/index.js";
import { erroHttp } from "../utils/helpers.js";

// Montagem em cápsula (aba Recebimentos).
//
// Produto com controlaMontagem tem três saldos:
//   montado       — já fechado na cápsula;
//   em montagem   — enviado para montar (brinquedo e cápsulas já separados);
//   sem cápsula   — brinquedo solto (estoqueSemCapsula ou o estoque do
//                   produtoSoltoId), aguardando cápsulas/montagem.
// O estoque do catálogo é montado + em montagem + o que dá para montar com os
// brinquedos soltos e as cápsulas livres. As cápsulas continuam vendáveis:
// vender cápsula diminui o que dá para montar (e o estoque do produto).

const inteiro = (v) => Math.trunc(Number(v) || 0);
const positivo = (v) => Math.max(0, inteiro(v));

export const capsulasDe = (produto) =>
  (Array.isArray(produto.capsulas) ? produto.capsulas : []).filter((c) => c?.produtoId && Number(c.quantidade) > 0);

// Brinquedos soltos do produto (estoque do produto vinculado ou saldo interno).
const soltoDe = (produto, porId) =>
  produto.produtoSoltoId ? positivo(porId.get(produto.produtoSoltoId)?.estoque) : positivo(produto.estoqueSemCapsula);

// Distribui cápsulas e brinquedos soltos entre os produtos (maior prioridade
// primeiro; empate por nome). Puro: não grava nada.
export const calcularMontagem = (controlados, porId) => {
  const restante = new Map([...porId].map(([id, p]) => [id, positivo(p.estoque)]));
  const ordem = [...controlados].sort(
    (a, b) => inteiro(b.prioridadeMontagem) - inteiro(a.prioridadeMontagem) || String(a.nome).localeCompare(String(b.nome)),
  );
  const resultado = new Map();
  for (const p of ordem) {
    const solto = soltoDe(p, porId);
    const soltoLivre = p.produtoSoltoId ? restante.get(p.produtoSoltoId) ?? 0 : solto;
    let podeMontar = soltoLivre;
    for (const c of capsulasDe(p)) {
      podeMontar = Math.min(podeMontar, Math.floor((restante.get(c.produtoId) ?? 0) / Number(c.quantidade)));
    }
    podeMontar = Math.max(0, podeMontar);
    for (const c of capsulasDe(p)) restante.set(c.produtoId, (restante.get(c.produtoId) ?? 0) - podeMontar * Number(c.quantidade));
    if (p.produtoSoltoId) restante.set(p.produtoSoltoId, soltoLivre - podeMontar);
    const montado = inteiro(p.estoqueMontado);
    const emMontagem = inteiro(p.estoqueEmMontagem);
    resultado.set(p.id, {
      solto,
      podeMontar,
      pendente: Math.max(0, solto - podeMontar),
      montado,
      emMontagem,
      disponivel: montado + emMontagem + podeMontar,
    });
  }
  return resultado;
};

const carregarInsumos = async (controlados, transaction) => {
  const ids = new Set();
  for (const p of controlados) {
    capsulasDe(p).forEach((c) => ids.add(c.produtoId));
    if (p.produtoSoltoId) ids.add(p.produtoSoltoId);
  }
  const insumos = ids.size ? await Produto.findAll({ where: { id: [...ids] }, transaction }) : [];
  return new Map(insumos.map((p) => [p.id, p]));
};

// Registro de auditoria sem efeitos colaterais.
export const registrarMovimento = (dados, transaction) =>
  MovimentacaoEstoque.create(
    {
      produtoId: dados.produto.id,
      produtoNome: dados.produto.nome,
      produtoSku: dados.produto.sku,
      tipo: dados.tipo,
      quantidade: Math.abs(dados.anterior - dados.nova),
      quantidadeAnterior: dados.anterior,
      quantidadeNova: dados.nova,
      motivo: dados.motivo,
      saldo: dados.saldo || null,
      origem: dados.origem || null,
      pedidoId: dados.pedido?.id || null,
      pedidoNumero: dados.pedido ? String(dados.pedido.numero) : null,
      clienteNome: dados.pedido?.clienteNome || null,
      usuarioNome: dados.usuario?.nome || null,
      usuarioEmail: dados.usuario?.email || null,
    },
    { transaction },
  );

// Muda o estoque (catálogo) de um insumo — cápsula ou produto "sem caps" —
// sem disparar o recálculo (quem chama recalcula no fim).
export const mexerEstoque = async (produto, delta, { motivo, usuario, pedido, origem, transaction, tipo }) => {
  if (!delta) return;
  const anterior = inteiro(produto.estoque);
  const nova = anterior + delta;
  await produto.update({ estoque: nova }, { transaction });
  await registrarMovimento({ produto, anterior, nova, tipo: tipo || (delta > 0 ? "ENTRADA" : "SAIDA"), motivo, usuario, pedido, origem }, transaction);
};

// Muda um saldo interno (MONTADO, EM_MONTAGEM, SEM_CAPSULA) com auditoria.
const CAMPO_SALDO = { MONTADO: "estoqueMontado", EM_MONTAGEM: "estoqueEmMontagem", SEM_CAPSULA: "estoqueSemCapsula" };
export const mexerSaldo = async (produto, saldo, delta, { motivo, usuario, origem, transaction, tipo }) => {
  if (!delta) return;
  const campo = CAMPO_SALDO[saldo];
  const anterior = inteiro(produto[campo]);
  const nova = anterior + delta;
  await produto.update({ [campo]: nova }, { transaction });
  await registrarMovimento({ produto, anterior, nova, saldo, tipo: tipo || (delta > 0 ? "ENTRADA" : "SAIDA"), motivo, usuario, origem }, transaction);
};

// Brinquedo solto: entra/sai do produto vinculado ou do saldo interno.
export const mexerSolto = async (produto, delta, ctx) => {
  if (!delta) return;
  if (produto.produtoSoltoId) {
    const solto = await Produto.findByPk(produto.produtoSoltoId, { transaction: ctx.transaction });
    if (!solto) throw erroHttp(400, `O produto sem cápsula vinculado a ${produto.nome} não existe mais.`);
    await mexerEstoque(solto, delta, ctx);
  } else {
    await mexerSaldo(produto, "SEM_CAPSULA", delta, ctx);
  }
};

// Recalcula o estoque do catálogo de todos os produtos com montagem.
export const recalcularMontagem = async ({ transaction, usuario } = {}) => {
  const controlados = await Produto.findAll({ where: { controlaMontagem: true }, transaction });
  if (!controlados.length) return;
  const porId = await carregarInsumos(controlados, transaction);
  const calculo = calcularMontagem(controlados, porId);
  for (const p of controlados) {
    const { disponivel } = calculo.get(p.id);
    const anterior = inteiro(p.estoque);
    if (disponivel === anterior) continue;
    await p.update({ estoque: disponivel }, { transaction });
    await registrarMovimento(
      {
        produto: p,
        anterior,
        nova: disponivel,
        tipo: "AJUSTE",
        motivo: "Recálculo automático da montagem (brinquedos sem cápsula × cápsulas disponíveis)",
        usuario,
        origem: "RECEBIMENTOS",
      },
      transaction,
    );
  }
};

// O movimento deste produto mexe na conta da montagem?
export const afetaMontagem = async (produto, transaction) =>
  produto.controlaMontagem ||
  produto.ehCapsula ||
  (await Produto.count({ where: { produtoSoltoId: produto.id, controlaMontagem: true }, transaction })) > 0;

// Venda/ajuste no estoque de um produto com montagem: entrada vira "montado";
// saída consome montado → em montagem → brinquedo solto + cápsulas (que serão
// montados para atender a venda).
export const aplicarNosSaldos = async (produto, delta, { motivo, usuario, pedido, transaction }) => {
  if (delta >= 0) {
    await produto.update({ estoqueMontado: inteiro(produto.estoqueMontado) + delta }, { transaction });
    return;
  }
  let falta = -delta;
  let montado = inteiro(produto.estoqueMontado);
  let emMontagem = inteiro(produto.estoqueEmMontagem);
  const m = Math.min(falta, Math.max(0, montado));
  montado -= m;
  falta -= m;
  const e = Math.min(falta, Math.max(0, emMontagem));
  emMontagem -= e;
  falta -= e;
  await produto.update({ estoqueMontado: montado, estoqueEmMontagem: emMontagem }, { transaction });

  if (falta > 0) {
    const porId = await carregarInsumos([produto], transaction);
    let usar = Math.min(falta, soltoDe(produto, porId));
    for (const c of capsulasDe(produto)) usar = Math.min(usar, Math.floor(positivo(porId.get(c.produtoId)?.estoque) / Number(c.quantidade)));
    if (usar > 0) {
      const ctx = { motivo: `${motivo} (montar ${usar} un. de ${produto.nome})`, usuario, pedido, transaction, origem: "RECEBIMENTOS" };
      await mexerSolto(produto, -usar, ctx);
      for (const c of capsulasDe(produto)) {
        const capsula = porId.get(c.produtoId);
        if (capsula) await mexerEstoque(capsula, -usar * Number(c.quantidade), ctx);
      }
      falta -= usar;
    }
    // Vendido além do que existe (encomenda): fica devendo no montado.
    if (falta > 0) await produto.update({ estoqueMontado: montado - falta }, { transaction });
  }
};

// Painel da aba Recebimentos: produtos com montagem e necessidade de cápsulas.
export const painelMontagem = async () => {
  const controlados = await Produto.findAll({ where: { controlaMontagem: true }, order: [["nome", "ASC"]] });
  const porId = await carregarInsumos(controlados, undefined);
  const capsulasMarcadas = await Produto.findAll({ where: { ehCapsula: true } });
  capsulasMarcadas.forEach((c) => porId.set(c.id, c));
  const calculo = calcularMontagem(controlados, porId);

  const necessidade = new Map();
  const produtos = controlados.map((p) => {
    const r = calculo.get(p.id);
    const capsulas = capsulasDe(p).map((c) => {
      const capsula = porId.get(c.produtoId);
      const precisa = r.solto * Number(c.quantidade);
      const atual = necessidade.get(c.produtoId) || { precisa: 0, produtos: [] };
      atual.precisa += precisa;
      if (precisa > 0) atual.produtos.push({ id: p.id, nome: p.nome, unidades: r.solto, precisa });
      necessidade.set(c.produtoId, atual);
      return { produtoId: c.produtoId, quantidade: Number(c.quantidade), nome: capsula?.nome || "Cápsula removida", estoque: inteiro(capsula?.estoque) };
    });
    const solto = p.produtoSoltoId ? porId.get(p.produtoSoltoId) : null;
    return {
      id: p.id,
      nome: p.nome,
      sku: p.sku,
      imagemUrl: p.imagemUrl,
      categoria: p.categoria,
      arquivado: p.arquivado,
      estoque: inteiro(p.estoque),
      prioridadeMontagem: inteiro(p.prioridadeMontagem),
      produtoSolto: solto ? { id: solto.id, nome: solto.nome, sku: solto.sku } : null,
      capsulas,
      ...r,
    };
  });

  const capsulas = [...porId.values()]
    .filter((c) => c.ehCapsula || necessidade.has(c.id))
    .filter((c) => !controlados.some((p) => p.produtoSoltoId === c.id) || c.ehCapsula)
    .map((c) => {
      const n = necessidade.get(c.id) || { precisa: 0, produtos: [] };
      const estoque = inteiro(c.estoque);
      return {
        id: c.id,
        nome: c.nome,
        sku: c.sku,
        imagemUrl: c.imagemUrl,
        arquivado: c.arquivado,
        fornecedorPreferencialId: c.fornecedorPreferencialId,
        estoque,
        precisa: n.precisa,
        falta: Math.max(0, n.precisa - estoque),
        produtos: n.produtos,
      };
    })
    .sort((a, b) => b.falta - a.falta || a.nome.localeCompare(b.nome));

  return { produtos, capsulas };
};
