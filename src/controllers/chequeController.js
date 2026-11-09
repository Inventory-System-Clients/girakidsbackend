import { Op } from "sequelize";
import { Cheque, Parceiro, Pedido, PedidoParcela } from "../models/index.js";
import { formatarNumero } from "../services/pedidoService.js";
import { arredondar, dataISO, erroHttp, hojeISO, responderErro } from "../utils/helpers.js";

const ATRIBUTOS_PEDIDO = ["id", "numero", "tipo", "clienteNome", "clienteTelefone", "statusVendas", "statusFinanceiro", "formaPagamento", "total", "createdAt", "pagoEm"];
const dataValida = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// Deixa a tabela de cheques igual aos pedidos: parcela em cheque (recebida
// ou em aberto) = um cheque; pedido em cheque sem parcela em cheque = um
// cheque do total. Cheque ainda no caixa acompanha o valor; o que deixou de
// existir no pedido some (se já foi enviado/devolvido, fica no histórico).
const sincronizarAgora = async () => {
  const [parcelas, pedidosCheque, existentes] = await Promise.all([
    PedidoParcela.findAll({
      where: { [Op.or]: [{ status: "RECEBIDA", metodoRecebido: "CHEQUE" }, { status: "ABERTA", metodoPrevisto: "CHEQUE" }] },
      include: [{ model: Pedido, as: "pedido", attributes: ATRIBUTOS_PEDIDO }],
    }),
    Pedido.findAll({ where: { tipo: "PEDIDO", formaPagamento: "CHEQUE", statusVendas: { [Op.ne]: "CANCELADO" } }, attributes: ATRIBUTOS_PEDIDO }),
    Cheque.findAll(),
  ]);
  const desejados = new Map();
  const pedidosComParcela = new Set();
  for (const p of parcelas) {
    if (!p.pedido || p.pedido.tipo !== "PEDIDO" || p.pedido.statusVendas === "CANCELADO") continue;
    pedidosComParcela.add(p.pedidoId);
    desejados.set(`p:${p.id}`, { pedidoId: p.pedidoId, parcelaId: p.id, valor: Number(p.valor), recebidoEm: p.recebidaEm || p.vencimento || dataISO(p.pedido.createdAt), bomPara: p.vencimento || null });
  }
  for (const pedido of pedidosCheque) {
    if (pedidosComParcela.has(pedido.id)) continue;
    desejados.set(`o:${pedido.id}`, { pedidoId: pedido.id, parcelaId: null, valor: Number(pedido.total), recebidoEm: dataISO(pedido.pagoEm || pedido.createdAt), bomPara: null });
  }
  const chave = (c) => (c.parcelaId ? `p:${c.parcelaId}` : `o:${c.pedidoId}`);
  const vistos = new Set();
  for (const c of existentes) {
    const k = chave(c);
    const d = desejados.get(k);
    vistos.add(k);
    if (!d) {
      if (c.ativo && c.status === "CAIXA") await c.update({ ativo: false });
      continue;
    }
    const mudancas = {};
    if (!c.ativo) mudancas.ativo = true;
    if (c.status === "CAIXA" && Math.abs(Number(c.valor) - d.valor) > 0.009) mudancas.valor = d.valor;
    if (c.status === "CAIXA" && c.recebidoEm !== d.recebidoEm) mudancas.recebidoEm = d.recebidoEm;
    if (Object.keys(mudancas).length) await c.update(mudancas);
  }
  const novos = [...desejados.entries()].filter(([k]) => !vistos.has(k)).map(([, d]) => d);
  if (novos.length) await Cheque.bulkCreate(novos);
};

// Uma sincronização por vez (duas telas abrindo juntas não duplicam cheques).
let sincronizando = null;
const sincronizar = () => {
  if (!sincronizando) sincronizando = sincronizarAgora().finally(() => (sincronizando = null));
  return sincronizando;
};

const serializar = (c, pedidos) => {
  const p = pedidos.get(c.pedidoId);
  return {
    id: c.id,
    pedidoId: c.pedidoId,
    parcelaId: c.parcelaId,
    valor: Number(c.valor),
    recebidoEm: c.recebidoEm,
    numero: c.numero,
    banco: c.banco,
    bomPara: c.bomPara,
    status: c.status,
    fornecedorId: c.fornecedorId,
    fornecedorNome: c.fornecedorNome,
    enviadoEm: c.enviadoEm,
    enviadoPor: c.enviadoPor,
    devolvidoEm: c.devolvidoEm,
    devolvidoPor: c.devolvidoPor,
    motivoDevolucao: c.motivoDevolucao,
    observacao: c.observacao,
    pedidoNumero: p?.numero ?? null,
    pedidoNumeroFormatado: p ? formatarNumero(p) : null,
    clienteNome: p?.clienteNome || "—",
    clienteTelefone: p?.clienteTelefone || null,
    pedidoPago: p?.statusFinanceiro === "PAGO",
  };
};

const resumir = (lista) => {
  const soma = (f) => arredondar(lista.filter(f).reduce((s, c) => s + c.valor, 0));
  const porFornecedor = new Map();
  for (const c of lista.filter((x) => x.status === "ENVIADO")) {
    const nome = c.fornecedorNome || "—";
    const g = porFornecedor.get(nome) || { nome, valor: 0, quantidade: 0 };
    g.valor = arredondar(g.valor + c.valor);
    g.quantidade += 1;
    porFornecedor.set(nome, g);
  }
  return {
    total: soma((c) => c.status !== "DEVOLVIDO"),
    quantidade: lista.filter((c) => c.status !== "DEVOLVIDO").length,
    caixa: soma((c) => c.status === "CAIXA"),
    qtdCaixa: lista.filter((c) => c.status === "CAIXA").length,
    enviados: soma((c) => c.status === "ENVIADO"),
    qtdEnviados: lista.filter((c) => c.status === "ENVIADO").length,
    devolvidos: soma((c) => c.status === "DEVOLVIDO"),
    qtdDevolvidos: lista.filter((c) => c.status === "DEVOLVIDO").length,
    porFornecedor: [...porFornecedor.values()].sort((a, b) => b.valor - a.valor),
  };
};

const carregarLista = async (where) => {
  await sincronizar();
  const cheques = await Cheque.findAll({ where: { ativo: true, ...where }, order: [["recebidoEm", "DESC"], ["createdAt", "DESC"]] });
  const pedidos = new Map(
    (await Pedido.findAll({ where: { id: [...new Set(cheques.map((c) => c.pedidoId))] }, attributes: ATRIBUTOS_PEDIDO })).map((p) => [p.id, p]),
  );
  return cheques.map((c) => serializar(c, pedidos));
};

// Todos os cheques (com os totais de caixa, enviados e devolvidos).
export const listar = async (req, res) => {
  try {
    let lista = await carregarLista({});
    const busca = String(req.query.busca || "").trim().toLowerCase();
    const resumo = resumir(lista);
    if (req.query.status) lista = lista.filter((c) => c.status === req.query.status);
    if (busca) {
      lista = lista.filter((c) =>
        [c.clienteNome, c.numero, c.banco, c.fornecedorNome, String(c.pedidoNumero)].some((v) => String(v || "").toLowerCase().includes(busca)),
      );
    }
    res.json({ cheques: lista, resumo });
  } catch (error) {
    responderErro(res, error, "Erro ao listar cheques");
  }
};

// Recebidos no período (pela data de recebimento do cheque).
export const periodo = async (req, res) => {
  try {
    const hoje = hojeISO();
    const inicio = dataValida(req.query.inicio) ? req.query.inicio : `${hoje.slice(0, 8)}01`;
    const fim = dataValida(req.query.fim) ? req.query.fim : hoje;
    const lista = await carregarLista({ recebidoEm: { [Op.between]: [inicio, fim] } });
    res.json({ inicio, fim, cheques: lista, resumo: resumir(lista) });
  } catch (error) {
    responderErro(res, error, "Erro ao listar cheques do período");
  }
};

const texto = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

// Dados do cheque: número, banco, bom para e observação.
export const atualizar = async (req, res) => {
  try {
    const cheque = await Cheque.findByPk(req.params.id);
    if (!cheque) throw erroHttp(404, "Cheque não encontrado.");
    const b = req.body || {};
    const dados = {};
    if (b.numero !== undefined) dados.numero = texto(b.numero, 40);
    if (b.banco !== undefined) dados.banco = texto(b.banco, 100);
    if (b.observacao !== undefined) dados.observacao = texto(b.observacao, 2000);
    if (b.bomPara !== undefined) dados.bomPara = dataValida(b.bomPara) ? b.bomPara : null;
    await cheque.update(dados);
    res.json({ ok: true });
  } catch (error) {
    responderErro(res, error, "Erro ao salvar o cheque");
  }
};

// Muda o status: ENVIADO (para um fornecedor), CAIXA (voltou para nós /
// desfazer) ou DEVOLVIDO (cheque voltou; falar com o cliente).
export const alterarStatus = async (req, res) => {
  try {
    const cheque = await Cheque.findByPk(req.params.id);
    if (!cheque || !cheque.ativo) throw erroHttp(404, "Cheque não encontrado.");
    const { status, fornecedorId, data, motivo } = req.body || {};
    const dia = dataValida(data) ? data : hojeISO();
    if (status === "ENVIADO") {
      const fornecedor = await Parceiro.findByPk(fornecedorId);
      if (!fornecedor) throw erroHttp(400, "Escolha o fornecedor.");
      await cheque.update({ status, fornecedorId: fornecedor.id, fornecedorNome: fornecedor.nome, enviadoEm: dia, enviadoPor: req.usuario.nome, devolvidoEm: null, devolvidoPor: null, motivoDevolucao: null });
    } else if (status === "CAIXA") {
      await cheque.update({ status, fornecedorId: null, fornecedorNome: null, enviadoEm: null, enviadoPor: null, devolvidoEm: null, devolvidoPor: null, motivoDevolucao: null });
    } else if (status === "DEVOLVIDO") {
      // Mantém para quem tinha sido enviado (o fornecedor devolveu).
      await cheque.update({ status, devolvidoEm: dia, devolvidoPor: req.usuario.nome, motivoDevolucao: texto(motivo, 2000) });
    } else {
      throw erroHttp(400, "Status inválido.");
    }
    res.json({ ok: true });
  } catch (error) {
    responderErro(res, error, "Erro ao alterar o cheque");
  }
};
