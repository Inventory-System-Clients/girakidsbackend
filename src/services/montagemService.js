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

// Cápsulas por unidade em itens: o produto precisa de TODOS os itens (e), e
// dentro de um item qualquer opção serve (ou). Ex.: Pokemon 1 pol = um item
// com as opções "branca" ou "vermelha". Formato salvo:
//   [{ opcoes: [{ produtoId, quantidade }] }]
// O formato antigo [{ produtoId, quantidade }] vira um item de uma opção.
export const gruposDe = (produto) =>
  (Array.isArray(produto.capsulas) ? produto.capsulas : [])
    .map((g) =>
      (Array.isArray(g?.opcoes) ? g.opcoes : [g])
        .filter((o) => o?.produtoId && Number(o.quantidade) > 0)
        .map((o) => ({ produtoId: o.produtoId, quantidade: Number(o.quantidade) })),
    )
    .filter((opcoes) => opcoes.length)
    .map((opcoes) => ({ opcoes }));

export const idsCapsulas = (produto) => gruposDe(produto).flatMap((g) => g.opcoes.map((o) => o.produtoId));

// Quantas unidades um item atende com o estoque informado (somando as opções).
export const capacidadeGrupo = (grupo, estoque) =>
  grupo.opcoes.reduce((soma, o) => soma + Math.floor(Math.max(0, estoque(o.produtoId)) / o.quantidade), 0);

// Escolhe de quais opções sai o necessário para `unidades` (a opção com mais
// estoque primeiro). Devolve [{ produtoId, quantidade }] em cápsulas.
export const distribuirGrupo = (grupo, unidades, estoque) => {
  const usos = [];
  let falta = unidades;
  const ordem = [...grupo.opcoes].sort((a, b) => Math.floor(estoque(b.produtoId) / b.quantidade) - Math.floor(estoque(a.produtoId) / a.quantidade));
  for (const o of ordem) {
    if (falta <= 0) break;
    const u = Math.min(falta, Math.floor(Math.max(0, estoque(o.produtoId)) / o.quantidade));
    if (u > 0) {
      usos.push({ produtoId: o.produtoId, quantidade: u * o.quantidade });
      falta -= u;
    }
  }
  return usos;
};

// Brinquedos soltos do produto (estoque do produto vinculado ou saldo interno).
const soltoDe = (produto, porId) =>
  produto.produtoSoltoId ? positivo(porId.get(produto.produtoSoltoId)?.estoque) : positivo(produto.estoqueSemCapsula);

// Distribui cápsulas e brinquedos soltos entre os produtos (maior prioridade
// primeiro; empate por nome). Puro: não grava nada.
export const calcularMontagem = (controlados, porId) => {
  const restante = new Map([...porId].map(([id, p]) => [id, positivo(p.estoque)]));
  const livre = (id) => restante.get(id) ?? 0;
  const ordem = [...controlados].sort(
    (a, b) => inteiro(b.prioridadeMontagem) - inteiro(a.prioridadeMontagem) || String(a.nome).localeCompare(String(b.nome)),
  );
  const resultado = new Map();
  for (const p of ordem) {
    const solto = soltoDe(p, porId);
    const soltoLivre = p.produtoSoltoId ? livre(p.produtoSoltoId) : solto;
    const grupos = gruposDe(p);
    // Quanto falta de cada item para montar todos os soltos.
    const faltas = grupos.map((g) => ({ opcoes: g.opcoes, falta: Math.max(0, solto - capacidadeGrupo(g, livre)) }));
    let podeMontar = soltoLivre;
    for (const g of grupos) podeMontar = Math.min(podeMontar, capacidadeGrupo(g, livre));
    podeMontar = Math.max(0, podeMontar);
    for (const g of grupos) {
      for (const uso of distribuirGrupo(g, podeMontar, livre)) restante.set(uso.produtoId, livre(uso.produtoId) - uso.quantidade);
    }
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
      faltas,
    });
  }
  return resultado;
};

const carregarInsumos = async (controlados, transaction) => {
  const ids = new Set();
  for (const p of controlados) {
    idsCapsulas(p).forEach((id) => ids.add(id));
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
    const estoque = (id) => positivo(porId.get(id)?.estoque);
    const grupos = gruposDe(produto);
    let usar = Math.min(falta, soltoDe(produto, porId));
    for (const g of grupos) usar = Math.min(usar, capacidadeGrupo(g, estoque));
    if (usar > 0) {
      const ctx = { motivo: `${motivo} (montar ${usar} un. de ${produto.nome})`, usuario, pedido, transaction, origem: "RECEBIMENTOS" };
      await mexerSolto(produto, -usar, ctx);
      for (const g of grupos) {
        for (const uso of distribuirGrupo(g, usar, estoque)) {
          const capsula = porId.get(uso.produtoId);
          if (capsula) await mexerEstoque(capsula, -uso.quantidade, ctx);
        }
      }
      falta -= usar;
    }
    // Vendido além do que existe (encomenda): fica devendo no montado.
    if (falta > 0) await produto.update({ estoqueMontado: montado - falta }, { transaction });
  }
};

// Painel da aba Recebimentos: produtos com montagem, cápsulas e o que comprar.
// "faltas" junta, por item (cápsula ou alternativas), quanto falta para montar
// todos os brinquedos sem cápsula.
export const painelMontagem = async () => {
  const controlados = await Produto.findAll({ where: { controlaMontagem: true }, order: [["nome", "ASC"]] });
  const porId = await carregarInsumos(controlados, undefined);
  const capsulasMarcadas = await Produto.findAll({ where: { ehCapsula: true } });
  capsulasMarcadas.forEach((c) => porId.set(c.id, c));
  const calculo = calcularMontagem(controlados, porId);
  const nomeDe = (id) => porId.get(id)?.nome || "Cápsula removida";

  const usos = new Map();
  const faltas = new Map();
  const produtos = controlados.map((p) => {
    const r = calculo.get(p.id);
    const capsulas = r.faltas.map((f) => {
      for (const o of f.opcoes) {
        const lista = usos.get(o.produtoId) || [];
        lista.push({ id: p.id, nome: p.nome, alternativa: f.opcoes.length > 1 });
        usos.set(o.produtoId, lista);
      }
      if (f.falta > 0) {
        const chave = f.opcoes.map((o) => o.produtoId).sort().join("|");
        const atual = faltas.get(chave) || {
          chave,
          nome: f.opcoes.map((o) => nomeDe(o.produtoId)).join(" ou "),
          opcoes: f.opcoes.map((o) => {
            const c = porId.get(o.produtoId);
            return { id: o.produtoId, nome: nomeDe(o.produtoId), sku: c?.sku, imagemUrl: c?.imagemUrl, fornecedorPreferencialId: c?.fornecedorPreferencialId, quantidade: o.quantidade };
          }),
          falta: 0,
          produtos: [],
        };
        atual.falta += f.falta * f.opcoes[0].quantidade;
        atual.produtos.push({ id: p.id, nome: p.nome, unidades: f.falta });
        faltas.set(chave, atual);
      }
      return {
        falta: f.falta,
        opcoes: f.opcoes.map((o) => ({ produtoId: o.produtoId, quantidade: o.quantidade, nome: nomeDe(o.produtoId), estoque: inteiro(porId.get(o.produtoId)?.estoque) })),
      };
    });
    const solto = p.produtoSoltoId ? porId.get(p.produtoSoltoId) : null;
    const { faltas: _f, ...resto } = r;
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
      ...resto,
    };
  });

  const listaFaltas = [...faltas.values()].sort((a, b) => b.falta - a.falta);
  const capsulas = [...porId.values()]
    .filter((c) => c.ehCapsula || usos.has(c.id))
    .filter((c) => !controlados.some((p) => p.produtoSoltoId === c.id) || c.ehCapsula)
    .map((c) => {
      const minhas = listaFaltas.filter((f) => f.opcoes.some((o) => o.id === c.id));
      return {
        id: c.id,
        nome: c.nome,
        sku: c.sku,
        imagemUrl: c.imagemUrl,
        arquivado: c.arquivado,
        fornecedorPreferencialId: c.fornecedorPreferencialId,
        estoque: inteiro(c.estoque),
        // Falta só desta cápsula (itens sem alternativa); com alternativas a
        // falta aparece em "faltas", pelo conjunto.
        falta: minhas.filter((f) => f.opcoes.length === 1).reduce((s, f) => s + f.falta, 0),
        faltaEmAlternativas: minhas.filter((f) => f.opcoes.length > 1).map((f) => ({ nome: f.nome, falta: f.falta })),
        produtos: usos.get(c.id) || [],
      };
    })
    .sort((a, b) => b.falta - a.falta || a.nome.localeCompare(b.nome));

  return { produtos, capsulas, faltas: listaFaltas };
};
