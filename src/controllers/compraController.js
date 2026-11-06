import { Op } from "sequelize";
import { PreRecebimento, PreRecebimentoItem, Usuario } from "../models/index.js";
import { serializar } from "./recebimentoController.js";
import { arredondar, erroHttp, numero, responderErro } from "../utils/helpers.js";
import { contem } from "../utils/busca.js";

// Financeiro → Setor de compras. Todo recebimento conferido (mercadoria já no
// estoque) fica "a pagar" aqui até alguém registrar quem comprou, como e quando
// pagou; daí vira uma compra finalizada, com filtros e gráficos.

export const FORMAS_COMPRA = {
  PIX: "PIX",
  BOLETO: "Boleto",
  CARTAO_CREDITO: "Cartão de crédito",
  CARTAO_DEBITO: "Cartão de débito",
  TRANSFERENCIA: "Transferência / TED",
  DINHEIRO: "Dinheiro",
  OUTRO: "Outro",
};

const INCLUDE = [{ model: PreRecebimentoItem, as: "itens" }];
const texto = (v, max = 2000) => (v == null ? null : String(v).trim().slice(0, max) || null);
const lista = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const dataValida = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// Valor das mercadorias pelo custo informado no recebimento.
const valorDosItens = (pre) =>
  arredondar((pre.itens || []).reduce((s, i) => s + Number(i.custoUnitario || 0) * Number(i.quantidadeRecebida ?? i.quantidadeSolicitada ?? 0), 0));

const resumo = (pre) => {
  const dados = serializar(pre);
  return {
    ...dados,
    valorItens: valorDosItens(pre),
    compraValor: pre.compraValor != null ? Number(pre.compraValor) : null,
  };
};

// Recebimentos conferidos esperando o registro do pagamento.
export const pendentes = async (req, res) => {
  try {
    const aPagar = await PreRecebimento.findAll({
      where: { compraStatus: "PENDENTE" },
      include: INCLUDE,
      order: [["recebidoEm", "DESC"]],
      limit: 300,
    });
    res.json(aPagar.map(resumo));
  } catch (error) {
    responderErro(res, error, "Erro ao listar compras a pagar");
  }
};

// Registra (ou corrige) o pagamento da compra: quem comprou, forma, data e valor.
export const registrar = async (req, res) => {
  try {
    const corpo = req.body || {};
    const pre = await PreRecebimento.findByPk(req.params.id, { include: INCLUDE });
    if (!pre || !pre.compraStatus) throw erroHttp(404, "Compra não encontrada.");
    const compradoPor = texto(corpo.compradoPor, 150);
    if (!compradoPor) throw erroHttp(400, "Informe quem comprou.");
    if (!FORMAS_COMPRA[corpo.formaPagamento]) throw erroHttp(400, "Escolha a forma de pagamento.");
    if (!dataValida(corpo.pagoEm)) throw erroHttp(400, "Informe a data do pagamento.");
    const valor = arredondar(numero(corpo.valor));
    if (!(valor > 0)) throw erroHttp(400, "Informe o valor pago.");
    const parcelas = Math.min(48, Math.max(1, Math.round(Number(corpo.parcelas) || 1)));
    await pre.update({
      compraStatus: "FINALIZADA",
      compradoPor,
      compraFormaPagamento: corpo.formaPagamento,
      compraParcelas: parcelas,
      compraPagoEm: corpo.pagoEm,
      compraValor: valor,
      compraObservacao: texto(corpo.observacao),
      compraRegistradaPor: req.usuario.nome,
      compraRegistradaEm: new Date(),
    });
    res.json(resumo(pre));
  } catch (error) {
    responderErro(res, error, "Erro ao registrar a compra");
  }
};

// Volta uma compra finalizada para "a pagar" (registro feito por engano).
export const reabrir = async (req, res) => {
  try {
    const pre = await PreRecebimento.findByPk(req.params.id, { include: INCLUDE });
    if (!pre || pre.compraStatus !== "FINALIZADA") throw erroHttp(404, "Compra finalizada não encontrada.");
    await pre.update({
      compraStatus: "PENDENTE",
      compradoPor: null,
      compraFormaPagamento: null,
      compraParcelas: null,
      compraPagoEm: null,
      compraValor: null,
      compraObservacao: null,
      compraRegistradaPor: null,
      compraRegistradaEm: null,
    });
    res.json(resumo(pre));
  } catch (error) {
    responderErro(res, error, "Erro ao reabrir a compra");
  }
};

// Opções dos filtros e do formulário: equipe, fornecedores e formas.
export const opcoes = async (req, res) => {
  try {
    const [equipe, usados] = await Promise.all([
      Usuario.findAll({ where: { role: ["ADMIN", "FUNCIONARIO"], ativo: true }, attributes: ["nome"], order: [["nome", "ASC"]] }),
      PreRecebimento.findAll({
        where: { compraStatus: { [Op.ne]: null } },
        attributes: ["compradoPor", "fornecedorNome"],
        raw: true,
      }),
    ]);
    const unicos = (valores) => [...new Set(valores.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    res.json({
      formas: Object.entries(FORMAS_COMPRA).map(([valor, nome]) => ({ valor, nome })),
      compradores: unicos([...equipe.map((u) => u.nome), ...usados.map((u) => u.compradoPor)]),
      fornecedores: unicos(usados.map((u) => u.fornecedorNome)),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar opções de compras");
  }
};

// Compras finalizadas com filtros (quem pagou, valor, forma, fornecedor,
// produto, período do pagamento) e os agrupamentos para os gráficos.
export const finalizadas = async (req, res) => {
  try {
    const q = req.query;
    const where = { compraStatus: "FINALIZADA" };
    const e = [];
    if (dataValida(q.inicio)) e.push({ compraPagoEm: { [Op.gte]: q.inicio } });
    if (dataValida(q.fim)) e.push({ compraPagoEm: { [Op.lte]: q.fim } });
    if (lista(q.compradores).length) e.push({ compradoPor: lista(q.compradores) });
    if (lista(q.formas).length) e.push({ compraFormaPagamento: lista(q.formas) });
    if (lista(q.fornecedores).length) e.push({ fornecedorNome: lista(q.fornecedores) });
    if (numero(q.valorMin) > 0) e.push({ compraValor: { [Op.gte]: numero(q.valorMin) } });
    if (numero(q.valorMax) > 0) e.push({ compraValor: { [Op.lte]: numero(q.valorMax) } });
    const produto = String(q.produto || "").trim();
    if (produto) {
      const ids = await PreRecebimentoItem.findAll({
        where: { [Op.or]: [contem("produtoNome", produto), { produtoSku: { [Op.iLike]: `%${produto}%` } }] },
        attributes: ["preRecebimentoId"],
        raw: true,
      });
      e.push({ id: [...new Set(ids.map((i) => i.preRecebimentoId))] });
    }
    if (e.length) where[Op.and] = e;
    const compras = await PreRecebimento.findAll({ where, include: INCLUDE, order: [["compraPagoEm", "DESC"], ["numero", "DESC"]], limit: 2000 });
    const registros = compras.map(resumo);

    // Totais e gráficos sem os recebimentos estornados (a mercadoria voltou).
    const validas = registros.filter((r) => r.status !== "ESTORNADO");
    const somar = (chave) => {
      const mapa = new Map();
      for (const r of validas) {
        const k = chave(r) || "—";
        const g = mapa.get(k) || { nome: k, valor: 0, compras: 0 };
        g.valor = arredondar(g.valor + r.compraValor);
        g.compras += 1;
        mapa.set(k, g);
      }
      return [...mapa.values()].sort((a, b) => b.valor - a.valor);
    };

    // Produtos: o valor pago é dividido pelos itens na proporção do custo
    // informado (sem custo, pela quantidade).
    const produtos = new Map();
    for (const r of validas) {
      const itens = r.itens || [];
      const pesoCusto = itens.reduce((s, i) => s + (i.custoUnitario || 0) * (i.quantidadeRecebida ?? 0), 0);
      const pesoQtd = itens.reduce((s, i) => s + (i.quantidadeRecebida ?? 0), 0);
      for (const i of itens) {
        const qtdItem = i.quantidadeRecebida ?? 0;
        const parte = pesoCusto > 0 ? ((i.custoUnitario || 0) * qtdItem) / pesoCusto : pesoQtd > 0 ? qtdItem / pesoQtd : 0;
        const g = produtos.get(i.produtoId) || { produtoId: i.produtoId, nome: i.produtoNome, sku: i.produtoSku, quantidade: 0, valor: 0, compras: 0 };
        g.quantidade += qtdItem;
        g.valor = arredondar(g.valor + r.compraValor * parte);
        g.compras += 1;
        produtos.set(i.produtoId, g);
      }
    }

    // Linha do tempo: por dia (até 62 dias) ou por mês.
    const datas = validas.map((r) => r.compraPagoEm).sort();
    const dias = datas.length ? (new Date(datas.at(-1)) - new Date(datas[0])) / 86_400_000 : 0;
    const porMes = dias > 62;
    const tempo = new Map();
    for (const r of validas) {
      const k = porMes ? r.compraPagoEm.slice(0, 7) : r.compraPagoEm;
      const g = tempo.get(k) || { periodo: k, valor: 0, compras: 0 };
      g.valor = arredondar(g.valor + r.compraValor);
      g.compras += 1;
      tempo.set(k, g);
    }

    const total = arredondar(validas.reduce((s, r) => s + r.compraValor, 0));
    res.json({
      registros,
      resumo: {
        total,
        compras: validas.length,
        ticketMedio: validas.length ? arredondar(total / validas.length) : 0,
        fornecedores: new Set(validas.map((r) => r.fornecedorNome || "—")).size,
        unidades: validas.reduce((s, r) => s + (r.totais?.recebido || 0), 0),
      },
      agrupamento: porMes ? "mes" : "dia",
      linhaDoTempo: [...tempo.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)),
      porForma: somar((r) => FORMAS_COMPRA[r.compraFormaPagamento] || r.compraFormaPagamento),
      porComprador: somar((r) => r.compradoPor),
      porFornecedor: somar((r) => r.fornecedorNome),
      porProduto: [...produtos.values()].sort((a, b) => b.valor - a.valor),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao listar compras");
  }
};
