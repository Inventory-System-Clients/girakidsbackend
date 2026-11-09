import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { Cheque, Parceiro, Pedido, PedidoParcela } from "../models/index.js";
import { formatarNumero } from "../services/pedidoService.js";
import { arredondar, dataISO, erroHttp, hojeISO, responderErro } from "../utils/helpers.js";

const ATRIBUTOS_PEDIDO = ["id", "numero", "tipo", "clienteNome", "clienteTelefone", "statusVendas", "statusFinanceiro", "formaPagamento", "total", "createdAt", "pagoEm"];
const dataValida = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// Deixa a tabela de cheques igual aos pedidos: parcela em cheque (recebida
// ou em aberto) = um cheque; pedido em cheque sem parcela em cheque = um
// cheque do total (a equipe pode dividir em vários cheques). Cheques ainda no
// caixa acompanham o valor; o que deixou de existir no pedido some (se já foi
// enviado/devolvido, fica no histórico).
// Cheques do mesmo pedido/parcela formam um grupo.
const chaveGrupo = (c) => (c.parcelaId ? `p:${c.parcelaId}` : `o:${c.pedidoId}`);
const ondeGrupo = (c) => (c.parcelaId ? { parcelaId: c.parcelaId } : { pedidoId: c.pedidoId, parcelaId: null });

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
  const grupos = new Map();
  for (const c of existentes) {
    const k = chaveGrupo(c);
    grupos.set(k, [...(grupos.get(k) || []), c]);
  }
  for (const [k, grupo] of grupos) {
    const d = desejados.get(k);
    if (!d) {
      for (const c of grupo) if (c.ativo && c.status === "CAIXA") await c.update({ ativo: false });
      continue;
    }
    for (const c of grupo) {
      const mudancas = {};
      if (!c.ativo) mudancas.ativo = true;
      if (c.status === "CAIXA" && c.recebidoEm !== d.recebidoEm) mudancas.recebidoEm = d.recebidoEm;
      if (Object.keys(mudancas).length) await c.update(mudancas);
    }
    // Valor do pedido mudou: um cheque só acompanha; dividido, a diferença
    // vai para o último cheque ainda no caixa (se continuar positivo).
    const soma = grupo.reduce((s, c) => s + Number(c.valor), 0);
    const diferenca = arredondar(d.valor - soma);
    if (Math.abs(diferenca) > 0.009) {
      const ultimo = [...grupo].sort((a, b) => a.ordem - b.ordem).reverse().find((c) => c.status === "CAIXA");
      if (ultimo && Number(ultimo.valor) + diferenca > 0.009) await ultimo.update({ valor: arredondar(Number(ultimo.valor) + diferenca) });
    }
  }
  const novos = [...desejados.entries()].filter(([k]) => !grupos.has(k)).map(([, d]) => d);
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
    grupo: chaveGrupo(c),
    ordem: c.ordem,
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
  const cheques = await Cheque.findAll({ where: { ativo: true, ...where }, order: [["recebidoEm", "DESC"], ["pedidoId", "ASC"], ["ordem", "ASC"]] });
  const pedidos = new Map(
    (await Pedido.findAll({ where: { id: [...new Set(cheques.map((c) => c.pedidoId))] }, attributes: ATRIBUTOS_PEDIDO })).map((p) => [p.id, p]),
  );
  const lista = cheques.map((c) => serializar(c, pedidos));
  // "1/3": posição do cheque entre os do mesmo pedido.
  const porGrupo = new Map();
  for (const c of lista) porGrupo.set(c.grupo, [...(porGrupo.get(c.grupo) || []), c]);
  for (const grupo of porGrupo.values()) grupo.forEach((c, i) => Object.assign(c, { posicao: i + 1, totalGrupo: grupo.length }));
  return lista;
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

// Cheques de um pedido (ou parcela): divide o valor em vários cheques, com
// valor, bom para, nº e banco de cada um. A soma tem que dar o valor do
// pedido. Mudar valores ou a quantidade só com todos os cheques no caixa.
export const distribuir = async (req, res) => {
  try {
    const base = await Cheque.findByPk(req.params.id);
    if (!base || !base.ativo) throw erroHttp(404, "Cheque não encontrado.");
    const grupo = await Cheque.findAll({ where: { ...ondeGrupo(base), ativo: true }, order: [["ordem", "ASC"], ["createdAt", "ASC"]] });
    const total = arredondar(grupo.reduce((s, c) => s + Number(c.valor), 0));
    const linhas = Array.isArray(req.body?.cheques) ? req.body.cheques : [];
    if (linhas.length < 1 || linhas.length > 24) throw erroHttp(400, "Informe de 1 a 24 cheques.");
    const novas = linhas.map((l) => ({
      id: l.id && grupo.some((c) => c.id === l.id) ? l.id : null,
      valor: arredondar(Number(String(l.valor ?? "").replace(",", "."))),
      numero: texto(l.numero, 40),
      banco: texto(l.banco, 100),
      bomPara: dataValida(l.bomPara) ? l.bomPara : null,
    }));
    if (novas.some((l) => !(l.valor > 0))) throw erroHttp(400, "Todo cheque precisa ter valor.");
    const soma = arredondar(novas.reduce((s, l) => s + l.valor, 0));
    if (Math.abs(soma - total) > 0.009) throw erroHttp(400, `A soma dos cheques (${soma.toFixed(2).replace(".", ",")}) tem que dar ${total.toFixed(2).replace(".", ",")}.`);
    const porId = new Map(grupo.map((c) => [c.id, c]));
    const mudaValores =
      novas.length !== grupo.length ||
      novas.some((l) => !l.id || Math.abs(Number(porId.get(l.id).valor) - l.valor) > 0.009);
    const foraDoCaixa = grupo.filter((c) => c.status !== "CAIXA");
    if (mudaValores && foraDoCaixa.length) {
      throw erroHttp(400, "Há cheque deste pedido enviado ou devolvido. Para mudar valores ou a quantidade, volte esses cheques ao caixa primeiro.");
    }
    await sequelize.transaction(async (transaction) => {
      const usados = new Set(novas.filter((l) => l.id).map((l) => l.id));
      for (const c of grupo) if (!usados.has(c.id)) await c.destroy({ transaction });
      for (const [ordem, l] of novas.entries()) {
        const dados = { valor: l.valor, numero: l.numero, banco: l.banco, bomPara: l.bomPara, ordem };
        if (l.id) await porId.get(l.id).update(dados, { transaction });
        else await Cheque.create({ ...dados, pedidoId: base.pedidoId, parcelaId: base.parcelaId, recebidoEm: base.recebidoEm, observacao: null }, { transaction });
      }
    });
    res.json({ ok: true });
  } catch (error) {
    responderErro(res, error, "Erro ao dividir os cheques");
  }
};
