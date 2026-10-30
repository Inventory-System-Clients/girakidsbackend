import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { MovimentacaoEstoque, OrdemMontagem, Parceiro, PreRecebimento, PreRecebimentoItem, Produto } from "../models/index.js";
import { movimentar } from "../services/estoqueService.js";
import {
  capacidadeGrupo,
  distribuirGrupo,
  gruposDe,
  idsCapsulas,
  mexerEstoque,
  mexerSaldo,
  mexerSolto,
  painelMontagem,
  recalcularMontagem,
} from "../services/montagemService.js";
import { cifrar, decifrar, FORMATO_TOKEN, gerarToken, hashToken } from "../utils/linkSeguro.js";
import { erroHttp, hojeISO, numero, responderErro } from "../utils/helpers.js";
import { contem } from "../utils/busca.js";

// Aba Recebimentos: pré-recebimentos com link para o fornecedor, recebimento
// de brinquedos sem cápsula / cápsulas / produtos prontos, montagem em
// cápsula e necessidade de compra de cápsulas.

const ORIGEM = "RECEBIMENTOS";
const DESTINOS = ["SEM_CAPSULA", "CAPSULA", "PRONTO"];
const ABERTOS = ["AGUARDANDO_FORNECEDOR", "FORNECEDOR_RESPONDEU"];
const DIAS_LINK = 60;
export const SOLUCOES = {
  ENVIAR_RESTANTE: "Fornecedor vai entregar o que faltou",
  ABATER_VALOR: "Abater do valor / pagar só o recebido",
  CREDITO: "Crédito para a próxima compra",
  DEVOLVER_DINHEIRO: "Fornecedor devolve o dinheiro",
  OUTRO: "Outro (descrito abaixo)",
};

const qtd = (v) => {
  const n = Math.round(numero(v));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw erroHttp(400, "Quantidade inválida.");
  return n;
};
const texto = (v, max = 2000) => (v == null ? null : String(v).trim().slice(0, max) || null);
const dataOuNulo = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);

// ---------------------------------------------------------------------------
// Serialização
// ---------------------------------------------------------------------------

const INCLUDE = [{ model: PreRecebimentoItem, as: "itens" }];

const esperadoDoItem = (item) => (item.quantidadeFornecedor != null ? item.quantidadeFornecedor : item.quantidadeSolicitada);

export const serializar = (pre) => {
  const j = pre.toJSON ? pre.toJSON() : pre;
  const itens = (j.itens || []).map((i) => ({
    ...i,
    custoUnitario: i.custoUnitario != null ? Number(i.custoUnitario) : null,
    esperado: esperadoDoItem(i),
    faltou: i.quantidadeRecebida != null ? Math.max(0, esperadoDoItem(i) - i.quantidadeRecebida) : null,
  }));
  const token = j.tokenCifrado ? decifrar(j.tokenCifrado) : null;
  delete j.tokenHash;
  delete j.tokenCifrado;
  return {
    ...j,
    itens,
    linkToken: token && ABERTOS.includes(j.status) ? token : null,
    linkExpirado: j.linkExpiraEm ? new Date(j.linkExpiraEm) < new Date() : false,
    totais: {
      solicitado: itens.reduce((s, i) => s + i.quantidadeSolicitada, 0),
      fornecedor: itens.some((i) => i.quantidadeFornecedor != null) ? itens.reduce((s, i) => s + (i.quantidadeFornecedor ?? 0), 0) : null,
      recebido: itens.some((i) => i.quantidadeRecebida != null) ? itens.reduce((s, i) => s + (i.quantidadeRecebida ?? 0), 0) : null,
      valor: itens.reduce((s, i) => s + (i.custoUnitario || 0) * (i.quantidadeRecebida ?? esperadoDoItem(i)), 0),
    },
  };
};

const carregar = async (id, transaction) => {
  const pre = await PreRecebimento.findByPk(id, {
    include: INCLUDE,
    order: [[{ model: PreRecebimentoItem, as: "itens" }, "produtoNome", "ASC"]],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!pre) throw erroHttp(404, "Recebimento não encontrado.");
  return pre;
};

// FOR UPDATE não funciona com o LEFT JOIN dos itens; trava só o cabeçalho.
const carregarParaAlterar = async (id, transaction) => {
  const pre = await PreRecebimento.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!pre) throw erroHttp(404, "Recebimento não encontrado.");
  pre.itens = await PreRecebimentoItem.findAll({ where: { preRecebimentoId: id }, transaction });
  return pre;
};

const responder = async (res, id, extra = {}) => res.json({ ...serializar(await carregar(id)), ...extra });

// ---------------------------------------------------------------------------
// Itens e estoque
// ---------------------------------------------------------------------------

const montarItens = async (itens, transaction) => {
  const lista = (Array.isArray(itens) ? itens : []).filter((i) => i?.produtoId);
  if (!lista.length) throw erroHttp(400, "Inclua pelo menos um item.");
  if (lista.length > 300) throw erroHttp(400, "Itens demais em um recebimento.");
  const produtos = await Produto.findAll({ where: { id: [...new Set(lista.map((i) => i.produtoId))] }, transaction });
  const porId = new Map(produtos.map((p) => [p.id, p]));
  return lista.map((i) => {
    const produto = porId.get(i.produtoId);
    if (!produto) throw erroHttp(400, "Produto não encontrado em um dos itens.");
    const destino = DESTINOS.includes(i.destino) ? i.destino : produto.ehCapsula ? "CAPSULA" : "PRONTO";
    if (destino === "SEM_CAPSULA" && !produto.controlaMontagem) {
      throw erroHttp(400, `"${produto.nome}" ainda não tem montagem em cápsula configurada. Configure na aba Montagem antes de receber sem cápsula.`);
    }
    return {
      produtoId: produto.id,
      produtoNome: produto.nome,
      produtoSku: produto.sku,
      imagemUrl: produto.imagemUrl,
      destino,
      quantidadeSolicitada: qtd(i.quantidadeSolicitada ?? i.quantidade),
      custoUnitario: i.custoUnitario === "" || i.custoUnitario == null ? null : numero(i.custoUnitario),
    };
  });
};

// Soma (ou estorna, sinal -1) a mercadoria recebida nos saldos certos.
const aplicarNoEstoque = async (pre, item, quantidade, usuario, transaction, sinal = 1) => {
  if (!quantidade) return;
  const produto = await Produto.findByPk(item.produtoId, { transaction });
  if (!produto) return;
  const motivo = `${sinal > 0 ? "Recebimento" : "Estorno do recebimento"} #${pre.numero}${pre.fornecedorNome ? ` - ${pre.fornecedorNome}` : ""}`;
  const ctx = { motivo, usuario, transaction, origem: ORIGEM };
  if (item.destino === "SEM_CAPSULA" && produto.controlaMontagem) {
    await mexerSolto(produto, sinal * quantidade, ctx);
    await recalcularMontagem({ transaction, usuario });
  } else {
    await movimentar({ produto, delta: sinal * quantidade, tipo: sinal > 0 ? "ENTRADA" : "SAIDA", ...ctx });
  }
  if (sinal > 0 && item.custoUnitario != null && Number(item.custoUnitario) > 0 && item.destino !== "SEM_CAPSULA") {
    await produto.update({ custo: item.custoUnitario }, { transaction });
  }
};

const proximoNumero = async (transaction) => Number((await PreRecebimento.max("numero", { transaction })) || 0) + 1;

const novoLink = () => {
  const token = gerarToken();
  return {
    token,
    campos: {
      tokenHash: hashToken(token),
      tokenCifrado: cifrar(token),
      linkExpiraEm: new Date(Date.now() + DIAS_LINK * 86_400_000),
    },
  };
};

// ---------------------------------------------------------------------------
// Pré-recebimentos
// ---------------------------------------------------------------------------

export const listar = async (req, res) => {
  try {
    const where = {};
    const status = String(req.query.status || "").split(",").filter(Boolean);
    if (status.length) where.status = status;
    if (req.query.divergencia === "ABERTA") where.divergenciaStatus = "ABERTA";
    if (req.query.fornecedorId) where.fornecedorId = req.query.fornecedorId;
    const busca = String(req.query.busca || "").trim();
    if (busca) {
      const ids = await PreRecebimentoItem.findAll({
        where: { [Op.or]: [contem("produtoNome", busca), { produtoSku: { [Op.iLike]: `%${busca}%` } }] },
        attributes: ["preRecebimentoId"],
        raw: true,
      });
      where[Op.or] = [
        contem("PreRecebimento.fornecedorNome", busca),
        contem("PreRecebimento.observacao", busca),
        { id: ids.map((i) => i.preRecebimentoId) },
        ...(/^\d+$/.test(busca) ? [{ numero: Number(busca) }] : []),
      ];
    }
    const lista = await PreRecebimento.findAll({ where, include: INCLUDE, order: [["numero", "DESC"]], limit: 300 });
    res.json(lista.map(serializar));
  } catch (error) {
    responderErro(res, error, "Erro ao listar recebimentos");
  }
};

export const obter = async (req, res) => {
  try {
    const pre = await carregar(req.params.id);
    if (!pre.respostaVista) await pre.update({ respostaVista: true });
    res.json(serializar(pre));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar recebimento");
  }
};

// Cria pré-recebimento (com link) ou recebimento direto (direto: true — já
// entra no estoque com as quantidades informadas).
export const criar = async (req, res) => {
  try {
    const corpo = req.body || {};
    let token = null;
    const id = await sequelize.transaction(async (transaction) => {
      const fornecedor = corpo.fornecedorId ? await Parceiro.findByPk(corpo.fornecedorId, { transaction }) : null;
      if (corpo.fornecedorId && !fornecedor) throw erroHttp(400, "Fornecedor não encontrado.");
      const itens = await montarItens(corpo.itens, transaction);
      const direto = Boolean(corpo.direto);
      const link = direto ? null : novoLink();
      token = link?.token || null;
      const pre = await PreRecebimento.create(
        {
          numero: await proximoNumero(transaction),
          fornecedorId: fornecedor?.id || null,
          fornecedorNome: fornecedor?.nome || texto(corpo.fornecedorNome, 200),
          status: direto ? "RECEBIDO" : "AGUARDANDO_FORNECEDOR",
          direto,
          previsaoEntrega: dataOuNulo(corpo.previsaoEntrega),
          observacao: texto(corpo.observacao),
          origemId: corpo.origemId || null,
          origemNumero: corpo.origemNumero || null,
          criadoPor: req.usuario.nome,
          ...(link?.campos || {}),
          ...(direto ? { recebidoEm: new Date(), recebidoPor: req.usuario.nome } : {}),
        },
        { transaction },
      );
      for (const item of itens) {
        const criado = await PreRecebimentoItem.create(
          { ...item, preRecebimentoId: pre.id, quantidadeRecebida: direto ? item.quantidadeSolicitada : null },
          { transaction },
        );
        if (direto) await aplicarNoEstoque(pre, criado, criado.quantidadeRecebida, req.usuario, transaction);
      }
      return pre.id;
    });
    res.status(201);
    await responder(res, id, { linkToken: token });
  } catch (error) {
    responderErro(res, error, "Erro ao criar recebimento");
  }
};

// Edita um pré-recebimento ainda não recebido (itens, previsão, observação).
export const atualizar = async (req, res) => {
  try {
    const corpo = req.body || {};
    await sequelize.transaction(async (transaction) => {
      const pre = await carregarParaAlterar(req.params.id, transaction);
      if (!ABERTOS.includes(pre.status)) throw erroHttp(400, "Só dá para editar pré-recebimentos que ainda não chegaram.");
      const dados = {};
      if (corpo.previsaoEntrega !== undefined) dados.previsaoEntrega = dataOuNulo(corpo.previsaoEntrega);
      if (corpo.observacao !== undefined) dados.observacao = texto(corpo.observacao);
      if (corpo.fornecedorId !== undefined) {
        const fornecedor = corpo.fornecedorId ? await Parceiro.findByPk(corpo.fornecedorId, { transaction }) : null;
        dados.fornecedorId = fornecedor?.id || null;
        dados.fornecedorNome = fornecedor?.nome || null;
      }
      await pre.update(dados, { transaction });
      if (corpo.itens) {
        const itens = await montarItens(corpo.itens, transaction);
        const atuais = new Map(pre.itens.map((i) => [i.produtoId + i.destino, i]));
        const manter = new Set();
        for (const item of itens) {
          const atual = atuais.get(item.produtoId + item.destino);
          if (atual) {
            await atual.update({ quantidadeSolicitada: item.quantidadeSolicitada, custoUnitario: item.custoUnitario }, { transaction });
            manter.add(atual.id);
          } else {
            await PreRecebimentoItem.create({ ...item, preRecebimentoId: pre.id }, { transaction });
          }
        }
        for (const i of pre.itens) if (!manter.has(i.id)) await i.destroy({ transaction });
      }
    });
    await responder(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar recebimento");
  }
};

// Novo link (o anterior deixa de funcionar).
export const gerarNovoLink = async (req, res) => {
  try {
    const pre = await carregar(req.params.id);
    if (!ABERTOS.includes(pre.status)) throw erroHttp(400, "O link só existe enquanto o recebimento está em aberto.");
    const link = novoLink();
    await pre.update(link.campos);
    await responder(res, pre.id, { linkToken: link.token });
  } catch (error) {
    responderErro(res, error, "Erro ao gerar link");
  }
};

// Conferência na chegada. Faltando algo, exige o que aconteceu e como o
// fornecedor vai resolver; pode gerar um novo pré-recebimento com o restante.
export const receber = async (req, res) => {
  try {
    const corpo = req.body || {};
    let restanteId = null;
    let restanteToken = null;
    await sequelize.transaction(async (transaction) => {
      const pre = await carregarParaAlterar(req.params.id, transaction);
      if (!ABERTOS.includes(pre.status)) throw erroHttp(400, "Este recebimento já foi conferido ou cancelado.");
      const informados = new Map((corpo.itens || []).map((i) => [i.id, i]));
      const faltas = [];
      for (const item of pre.itens) {
        const info = informados.get(item.id);
        const recebida = info?.quantidadeRecebida != null && info.quantidadeRecebida !== "" ? qtd(info.quantidadeRecebida) : esperadoDoItem(item);
        await item.update({ quantidadeRecebida: recebida }, { transaction });
        const esperado = esperadoDoItem(item);
        if (recebida < esperado) faltas.push({ item, falta: esperado - recebida });
        await aplicarNoEstoque(pre, item, recebida, req.usuario, transaction);
      }

      const dados = { recebidoEm: new Date(), recebidoPor: req.usuario.nome, status: faltas.length ? "RECEBIDO_PARCIAL" : "RECEBIDO", respostaVista: true };
      if (faltas.length) {
        const d = corpo.divergencia || {};
        const descricao = texto(d.descricao);
        if (!descricao) throw erroHttp(400, "Descreva o que aconteceu com a mercadoria que faltou.");
        const solucao = SOLUCOES[d.solucao] ? d.solucao : null;
        if (!solucao) throw erroHttp(400, "Informe como o fornecedor vai resolver a falta.");
        if (solucao === "OUTRO" && !texto(d.detalhe)) throw erroHttp(400, "Descreva como o fornecedor vai resolver.");
        Object.assign(dados, {
          divergenciaStatus: "ABERTA",
          divergenciaDescricao: descricao,
          divergenciaSolucao: solucao,
          divergenciaDetalhe: texto(d.detalhe),
          divergenciaPrazo: dataOuNulo(d.prazo),
        });
        // O que faltou vira um novo pré-recebimento (com link próprio).
        if (solucao === "ENVIAR_RESTANTE" && d.gerarRestante !== false) {
          const link = novoLink();
          restanteToken = link.token;
          const novo = await PreRecebimento.create(
            {
              numero: await proximoNumero(transaction),
              fornecedorId: pre.fornecedorId,
              fornecedorNome: pre.fornecedorNome,
              previsaoEntrega: dataOuNulo(d.prazo),
              observacao: `Restante do recebimento #${pre.numero}: ${descricao}`.slice(0, 2000),
              origemId: pre.id,
              origemNumero: pre.numero,
              criadoPor: req.usuario.nome,
              ...link.campos,
            },
            { transaction },
          );
          for (const { item, falta } of faltas) {
            await PreRecebimentoItem.create(
              {
                preRecebimentoId: novo.id,
                produtoId: item.produtoId,
                produtoNome: item.produtoNome,
                produtoSku: item.produtoSku,
                imagemUrl: item.imagemUrl,
                destino: item.destino,
                quantidadeSolicitada: falta,
                custoUnitario: item.custoUnitario,
              },
              { transaction },
            );
          }
          restanteId = novo.id;
        }
      }
      await pre.update(dados, { transaction });
    });
    const pre = serializar(await carregar(req.params.id));
    res.json({ ...pre, restante: restanteId ? { ...serializar(await carregar(restanteId)), linkToken: restanteToken } : null });
  } catch (error) {
    responderErro(res, error, "Erro ao confirmar recebimento");
  }
};

export const resolverDivergencia = async (req, res) => {
  try {
    const pre = await carregar(req.params.id);
    if (pre.divergenciaStatus !== "ABERTA") throw erroHttp(400, "Não há divergência aberta neste recebimento.");
    const resolucao = texto(req.body?.resolucao);
    if (!resolucao) throw erroHttp(400, "Conte como foi resolvido.");
    await pre.update({ divergenciaStatus: "RESOLVIDA", divergenciaResolucao: resolucao, divergenciaResolvidaEm: new Date(), divergenciaResolvidaPor: req.usuario.nome });
    await responder(res, pre.id);
  } catch (error) {
    responderErro(res, error, "Erro ao resolver divergência");
  }
};

export const cancelar = async (req, res) => {
  try {
    const pre = await carregar(req.params.id);
    if (!ABERTOS.includes(pre.status)) throw erroHttp(400, "Só dá para cancelar o que ainda não foi recebido. Para desfazer um recebimento, use Estornar.");
    await pre.update({
      status: "CANCELADO",
      canceladoEm: new Date(),
      canceladoPor: req.usuario.nome,
      motivoCancelamento: texto(req.body?.motivo),
      tokenHash: null,
      tokenCifrado: null,
    });
    await responder(res, pre.id);
  } catch (error) {
    responderErro(res, error, "Erro ao cancelar");
  }
};

// Desfaz a entrada no estoque de um recebimento já conferido.
export const estornar = async (req, res) => {
  try {
    const motivo = texto(req.body?.motivo);
    if (!motivo) throw erroHttp(400, "Informe o motivo do estorno.");
    await sequelize.transaction(async (transaction) => {
      const pre = await carregarParaAlterar(req.params.id, transaction);
      if (!["RECEBIDO", "RECEBIDO_PARCIAL"].includes(pre.status)) throw erroHttp(400, "Só dá para estornar um recebimento conferido.");
      for (const item of pre.itens) await aplicarNoEstoque(pre, item, item.quantidadeRecebida || 0, req.usuario, transaction, -1);
      await pre.update(
        {
          status: "ESTORNADO",
          canceladoEm: new Date(),
          canceladoPor: req.usuario.nome,
          motivoCancelamento: motivo,
          ...(pre.divergenciaStatus === "ABERTA" ? { divergenciaStatus: "RESOLVIDA", divergenciaResolucao: "Recebimento estornado", divergenciaResolvidaEm: new Date(), divergenciaResolvidaPor: req.usuario.nome } : {}),
        },
        { transaction },
      );
    });
    await responder(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao estornar");
  }
};

// Apaga o pré-recebimento de vez (some da lista). Se já tinha entrado no
// estoque, a entrada é desfeita antes; o histórico de movimentações fica.
export const excluir = async (req, res) => {
  try {
    let numero;
    let estornado = false;
    await sequelize.transaction(async (transaction) => {
      const pre = await carregarParaAlterar(req.params.id, transaction);
      numero = pre.numero;
      if (["RECEBIDO", "RECEBIDO_PARCIAL"].includes(pre.status)) {
        for (const item of pre.itens) await aplicarNoEstoque(pre, item, item.quantidadeRecebida || 0, req.usuario, transaction, -1);
        estornado = true;
      }
      // Restantes gerados a partir dele continuam, só perdem o vínculo.
      await PreRecebimento.update({ origemId: null }, { where: { origemId: pre.id }, transaction });
      await PreRecebimentoItem.destroy({ where: { preRecebimentoId: pre.id }, transaction });
      await pre.destroy({ transaction });
    });
    res.json({ ok: true, numero, estornado });
  } catch (error) {
    responderErro(res, error, "Erro ao excluir");
  }
};

// ---------------------------------------------------------------------------
// Alertas (cabeçalho e topo da aba)
// ---------------------------------------------------------------------------

export const alertas = async (req, res) => {
  try {
    const [divergencias, respostas, atrasados, painel] = await Promise.all([
      PreRecebimento.findAll({ where: { divergenciaStatus: "ABERTA" }, include: INCLUDE, order: [["recebidoEm", "DESC"]] }),
      PreRecebimento.findAll({ where: { status: "FORNECEDOR_RESPONDEU", respostaVista: false }, order: [["respondidoEm", "DESC"]] }),
      PreRecebimento.findAll({
        where: { status: ABERTOS, [Op.or]: [{ previsaoFornecedor: { [Op.lt]: hojeISO() } }, { previsaoFornecedor: null, previsaoEntrega: { [Op.lt]: hojeISO() } }] },
        order: [["previsaoEntrega", "ASC"]],
      }),
      painelMontagem(),
    ]);
    const capsulasFaltando = painel.faltas;
    const insumosAcabando = painel.acabando;
    res.json({
      total: divergencias.length + respostas.length + capsulasFaltando.length + insumosAcabando.length,
      divergencias: divergencias.map(serializar),
      respostas: respostas.map((p) => ({ id: p.id, numero: p.numero, fornecedorNome: p.fornecedorNome, respondidoEm: p.respondidoEm })),
      atrasados: atrasados.map((p) => ({ id: p.id, numero: p.numero, fornecedorNome: p.fornecedorNome, previsao: p.previsaoFornecedor || p.previsaoEntrega })),
      capsulasFaltando,
      insumosAcabando,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar alertas");
  }
};

// ---------------------------------------------------------------------------
// Montagem em cápsula
// ---------------------------------------------------------------------------

const painelComOrdens = async (todasOrdens = false) => {
  const [painel, ordens] = await Promise.all([
    painelMontagem(),
    OrdemMontagem.findAll({ where: todasOrdens ? {} : { status: "EM_MONTAGEM" }, order: [["createdAt", "DESC"]], limit: 200 }),
  ]);
  return { ...painel, ordens };
};

export const montagem = async (req, res) => {
  try {
    res.json(await painelComOrdens(req.query.todasOrdens === "true"));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar montagem");
  }
};

// Liga/ajusta a montagem de um produto: cápsulas por unidade, produto "sem
// caps" vinculado e prioridade. Ao ligar, o estoque atual vira "montado".
export const configurarProduto = async (req, res) => {
  try {
    const corpo = req.body || {};
    await sequelize.transaction(async (transaction) => {
      const produto = await Produto.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!produto) throw erroHttp(404, "Produto não encontrado.");
      const ligar = corpo.controlaMontagem !== false;
      if (!ligar) {
        if (!produto.controlaMontagem) return;
        const fica = Number(produto.estoqueMontado) + Number(produto.estoqueEmMontagem);
        const anterior = Number(produto.estoque);
        await produto.update({ controlaMontagem: false, estoque: fica }, { transaction });
        if (fica !== anterior) {
          await MovimentacaoEstoque.create(
            {
              produtoId: produto.id,
              produtoNome: produto.nome,
              produtoSku: produto.sku,
              tipo: "AJUSTE",
              quantidade: Math.abs(fica - anterior),
              quantidadeAnterior: anterior,
              quantidadeNova: fica,
              motivo: "Montagem em cápsula desligada: estoque = montado + em montagem",
              origem: ORIGEM,
              usuarioNome: req.usuario.nome,
              usuarioEmail: req.usuario.email,
            },
            { transaction },
          );
        }
        return;
      }

      // Itens de cápsula: [{ opcoes: [{ produtoId, quantidade }] }] — todos os
      // itens são necessários; dentro de um item, qualquer opção serve.
      const grupos = gruposDe({ capsulas: Array.isArray(corpo.capsulas) ? corpo.capsulas : [] })
        .map((g) => ({
          opcoes: [...new Map(g.opcoes.filter((o) => o.produtoId !== produto.id).map((o) => [o.produtoId, { produtoId: o.produtoId, quantidade: Math.max(1, Math.round(o.quantidade)) }])).values()],
        }))
        .filter((g) => g.opcoes.length);
      const todosIds = grupos.flatMap((g) => g.opcoes.map((o) => o.produtoId));
      if (new Set(todosIds).size !== todosIds.length) throw erroHttp(400, "A mesma cápsula aparece em mais de um item. Use-a em um item só (como opção).");
      const unicas = todosIds.map((produtoId) => ({ produtoId }));
      if (unicas.length) {
        const existentes = await Produto.findAll({ where: { id: todosIds }, transaction });
        if (existentes.length !== todosIds.length) throw erroHttp(400, "Uma das cápsulas escolhidas não existe.");
        if (existentes.some((c) => c.controlaMontagem)) throw erroHttp(400, "Um produto com montagem não pode ser cápsula de outro.");
        await Produto.update({ ehCapsula: true }, { where: { id: todosIds }, transaction });
      }
      let produtoSoltoId = corpo.produtoSoltoId || null;
      if (produtoSoltoId) {
        if (produtoSoltoId === produto.id) throw erroHttp(400, "O produto sem cápsula precisa ser outro produto.");
        const solto = await Produto.findByPk(produtoSoltoId, { transaction });
        if (!solto) throw erroHttp(400, "Produto sem cápsula não encontrado.");
        if (solto.controlaMontagem || unicas.some((c) => c.produtoId === solto.id)) throw erroHttp(400, "Escolha como 'sem cápsula' um produto comum (não cápsula, sem montagem).");
      } else {
        produtoSoltoId = null;
      }
      const dados = { capsulas: grupos, produtoSoltoId, prioridadeMontagem: Math.round(numero(corpo.prioridadeMontagem)) };
      if (!produto.controlaMontagem) {
        Object.assign(dados, { controlaMontagem: true, estoqueMontado: Number(produto.estoque), estoqueEmMontagem: 0 });
      }
      // Brinquedos que estavam no saldo interno passam para o produto vinculado.
      if (produtoSoltoId && !produto.produtoSoltoId && Number(produto.estoqueSemCapsula) > 0) {
        const solto = await Produto.findByPk(produtoSoltoId, { transaction });
        await mexerEstoque(solto, Number(produto.estoqueSemCapsula), { motivo: `Brinquedos sem cápsula de ${produto.nome} vinculados a este produto`, usuario: req.usuario, transaction, origem: ORIGEM });
        dados.estoqueSemCapsula = 0;
      }
      await produto.update(dados, { transaction });
      await recalcularMontagem({ transaction, usuario: req.usuario });
    });
    res.json(await painelComOrdens());
  } catch (error) {
    responderErro(res, error, "Erro ao configurar montagem");
  }
};

// Separa brinquedos + cápsulas e manda para montagem. A partir daqui as
// cápsulas não podem mais ser vendidas.
export const enviarParaMontagem = async (req, res) => {
  try {
    const quantidade = qtd(req.body?.quantidade);
    if (!quantidade) throw erroHttp(400, "Informe a quantidade.");
    await sequelize.transaction(async (transaction) => {
      const produto = await Produto.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!produto?.controlaMontagem) throw erroHttp(400, "Produto sem montagem em cápsula configurada.");
      const solto = produto.produtoSoltoId ? await Produto.findByPk(produto.produtoSoltoId, { transaction }) : null;
      const soltos = solto ? Number(solto.estoque) : Number(produto.estoqueSemCapsula);
      if (quantidade > soltos) throw erroHttp(400, `Só há ${soltos} brinquedos sem cápsula de ${produto.nome}.`);
      // Cada item precisa cobrir a quantidade (somando as opções dele).
      const grupos = gruposDe(produto);
      const ids = idsCapsulas(produto);
      const porId = new Map((ids.length ? await Produto.findAll({ where: { id: ids }, transaction, lock: transaction.LOCK.UPDATE }) : []).map((c) => [c.id, c]));
      const estoque = (id) => Number(porId.get(id)?.estoque || 0);
      const capsulas = [];
      for (const g of grupos) {
        const capacidade = capacidadeGrupo(g, estoque);
        if (capacidade < quantidade) {
          const nomes = g.opcoes.map((o) => `${porId.get(o.produtoId)?.nome || "cápsula"} (${estoque(o.produtoId)})`).join(" ou ");
          throw erroHttp(400, `Faltam cápsulas: ${nomes} dão para ${capacidade} un., precisa de ${quantidade}.`);
        }
        for (const uso of distribuirGrupo(g, quantidade, estoque)) capsulas.push({ capsula: porId.get(uso.produtoId), precisa: uso.quantidade });
      }
      const ordem = await OrdemMontagem.create(
        {
          produtoId: produto.id,
          produtoNome: produto.nome,
          quantidade,
          capsulas: capsulas.map(({ capsula, precisa }) => ({ produtoId: capsula.id, nome: capsula.nome, quantidade: precisa })),
          observacao: texto(req.body?.observacao),
          enviadoPor: req.usuario.nome,
        },
        { transaction },
      );
      const ctx = { motivo: `Enviado para montagem (${quantidade} un. de ${produto.nome})`, usuario: req.usuario, transaction, origem: ORIGEM };
      await mexerSolto(produto, -quantidade, ctx);
      for (const { capsula, precisa } of capsulas) await mexerEstoque(capsula, -precisa, ctx);
      await mexerSaldo(produto, "EM_MONTAGEM", quantidade, ctx);
      await recalcularMontagem({ transaction, usuario: req.usuario });
      return ordem;
    });
    res.json(await painelComOrdens());
  } catch (error) {
    responderErro(res, error, "Erro ao enviar para montagem");
  }
};

// Conclui (total ou parte) ou cancela uma ordem de montagem.
const fecharOrdem = (acao) => async (req, res) => {
  try {
    await sequelize.transaction(async (transaction) => {
      const ordem = await OrdemMontagem.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!ordem || ordem.status !== "EM_MONTAGEM") throw erroHttp(400, "Ordem de montagem não está em andamento.");
      const aberto = ordem.quantidade - ordem.quantidadeConcluida - ordem.quantidadeCancelada;
      const quantidade = req.body?.quantidade != null && req.body.quantidade !== "" ? qtd(req.body.quantidade) : aberto;
      if (!quantidade || quantidade > aberto) throw erroHttp(400, `Informe de 1 a ${aberto}.`);
      const produto = await Produto.findByPk(ordem.produtoId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!produto) throw erroHttp(400, "Produto da ordem não existe mais.");
      const ctx = { usuario: req.usuario, transaction, origem: ORIGEM };
      if (acao === "concluir") {
        ctx.motivo = `Montagem concluída (${quantidade} un.)`;
        await mexerSaldo(produto, "EM_MONTAGEM", -quantidade, ctx);
        await mexerSaldo(produto, "MONTADO", quantidade, ctx);
        ordem.quantidadeConcluida += quantidade;
      } else {
        // Desfaz: brinquedos e cápsulas voltam a ficar livres.
        ctx.motivo = `Montagem cancelada (${quantidade} un.)${req.body?.motivo ? `: ${texto(req.body.motivo, 300)}` : ""}`;
        await mexerSaldo(produto, "EM_MONTAGEM", -quantidade, ctx);
        await mexerSolto(produto, quantidade, ctx);
        for (const c of ordem.capsulas || []) {
          const capsula = await Produto.findByPk(c.produtoId, { transaction });
          if (capsula) await mexerEstoque(capsula, Math.round((c.quantidade / ordem.quantidade) * quantidade), ctx);
        }
        ordem.quantidadeCancelada += quantidade;
      }
      const resta = ordem.quantidade - ordem.quantidadeConcluida - ordem.quantidadeCancelada;
      await ordem.update(
        {
          quantidadeConcluida: ordem.quantidadeConcluida,
          quantidadeCancelada: ordem.quantidadeCancelada,
          ...(resta === 0
            ? { status: ordem.quantidadeConcluida ? "CONCLUIDA" : "CANCELADA", concluidaEm: new Date(), concluidaPor: req.usuario.nome }
            : {}),
        },
        { transaction },
      );
      await recalcularMontagem({ transaction, usuario: req.usuario });
    });
    res.json(await painelComOrdens());
  } catch (error) {
    responderErro(res, error, "Erro na ordem de montagem");
  }
};
export const concluirOrdem = fecharOrdem("concluir");
export const cancelarOrdem = fecharOrdem("cancelar");

// Ajuste manual de um saldo: MONTADO, EM_MONTAGEM, SEM_CAPSULA ou ESTOQUE
// (estoque do catálogo — para cápsulas e produtos comuns).
export const ajustarSaldo = async (req, res) => {
  try {
    const saldo = String(req.body?.saldo || "ESTOQUE");
    const nova = Math.round(numero(req.body?.quantidade));
    const motivo = texto(req.body?.motivo, 500) || "sem observação";
    if (!Number.isFinite(nova) || nova < 0) throw erroHttp(400, "Quantidade inválida.");
    await sequelize.transaction(async (transaction) => {
      const produto = await Produto.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!produto) throw erroHttp(404, "Produto não encontrado.");
      const ctx = { motivo: `Ajuste manual: ${motivo}`, usuario: req.usuario, transaction, origem: ORIGEM, tipo: "AJUSTE" };
      if (saldo === "ESTOQUE") {
        if (produto.controlaMontagem) throw erroHttp(400, "O estoque deste produto é calculado pela montagem: ajuste o montado, em montagem ou sem cápsula.");
        await movimentar({ produto, delta: nova - Number(produto.estoque), tipo: "AJUSTE", motivo: ctx.motivo, usuario: req.usuario, transaction, origem: ORIGEM });
        return;
      }
      if (!produto.controlaMontagem) throw erroHttp(400, "Produto sem montagem em cápsula.");
      if (saldo === "SEM_CAPSULA") {
        const atual = produto.produtoSoltoId ? Number((await Produto.findByPk(produto.produtoSoltoId, { transaction }))?.estoque || 0) : Number(produto.estoqueSemCapsula);
        await mexerSolto(produto, nova - atual, ctx);
      } else if (saldo === "MONTADO" || saldo === "EM_MONTAGEM") {
        const campo = saldo === "MONTADO" ? "estoqueMontado" : "estoqueEmMontagem";
        await mexerSaldo(produto, saldo, nova - Number(produto[campo]), ctx);
      } else {
        throw erroHttp(400, "Saldo inválido.");
      }
      await recalcularMontagem({ transaction, usuario: req.usuario });
    });
    res.json(await painelComOrdens());
  } catch (error) {
    responderErro(res, error, "Erro ao ajustar saldo");
  }
};

// Cadastra uma cápsula nova (ex.: "Cápsula 1 pol vermelha"). Sem venda no
// catálogo, fica arquivada (só controle de estoque).
export const criarCapsula = async (req, res) => {
  try {
    const corpo = req.body || {};
    const nome = texto(corpo.nome, 200);
    if (!nome) throw erroHttp(400, "Informe o nome da cápsula.");
    const tamanho = { "1": "cap_empty_1inch", "2": "cap_empty_2inch", "105": "cap_empty_105mm" }[String(corpo.tamanho)] || null;
    const sleeve = corpo.tipoInsumo === "SLEEVE";
    const capsula = await sequelize.transaction(async (transaction) => {
      const nova = await Produto.create(
        {
          sku: texto(corpo.sku, 50) || `CAP-${Date.now().toString(36).toUpperCase()}`,
          nome,
          categoria: sleeve ? "Sleeves" : "Cápsulas",
          ehCapsula: true,
          tipoInsumo: sleeve ? "SLEEVE" : "CAPSULA",
          margemPerda: corpo.margemPerda === "" || corpo.margemPerda == null ? null : numero(corpo.margemPerda),
          avisoCompraAbaixo: corpo.avisoCompraAbaixo === "" || corpo.avisoCompraAbaixo == null ? null : Math.round(numero(corpo.avisoCompraAbaixo)),
          arquivado: !corpo.venderNoCatalogo,
          tipoEmbalagem: sleeve ? null : tamanho,
          unidadesPacote: Math.max(1, Math.round(numero(corpo.unidadesPacote) || 1)),
          precoVenda: numero(corpo.precoVenda),
          custo: corpo.custo ? numero(corpo.custo) : null,
          fornecedorPreferencialId: corpo.fornecedorId || null,
          estoque: 0,
          criadoPor: req.usuario.nome,
          atualizadoPor: req.usuario.nome,
        },
        { transaction },
      );
      const inicial = qtd(corpo.estoqueInicial || 0);
      if (inicial) await movimentar({ produto: nova, delta: inicial, tipo: "AJUSTE", motivo: "Estoque inicial da cápsula", usuario: req.usuario, transaction, origem: ORIGEM });
      return nova;
    });
    res.status(201).json(capsula);
  } catch (error) {
    responderErro(res, error, "Erro ao cadastrar cápsula");
  }
};

// Regras de compra do insumo: tipo, margem de perda e aviso de estoque baixo
// (campo vazio = padrão: sleeve 10% e aviso em 500; cápsula 0% e sem aviso).
export const configurarInsumo = async (req, res) => {
  try {
    const produto = await Produto.findByPk(req.params.id);
    if (!produto) throw erroHttp(404, "Produto não encontrado.");
    const corpo = req.body || {};
    const dados = {};
    if (corpo.tipoInsumo !== undefined) dados.tipoInsumo = ["CAPSULA", "SLEEVE"].includes(corpo.tipoInsumo) ? corpo.tipoInsumo : null;
    if (corpo.margemPerda !== undefined) {
      const m = corpo.margemPerda === "" || corpo.margemPerda == null ? null : numero(corpo.margemPerda);
      if (m != null && (m < 0 || m > 200)) throw erroHttp(400, "Margem de perda entre 0% e 200%.");
      dados.margemPerda = m;
    }
    if (corpo.avisoCompraAbaixo !== undefined) {
      const a = corpo.avisoCompraAbaixo === "" || corpo.avisoCompraAbaixo == null ? null : Math.round(numero(corpo.avisoCompraAbaixo));
      if (a != null && a < 0) throw erroHttp(400, "Aviso inválido.");
      dados.avisoCompraAbaixo = a;
    }
    await produto.update({ ...dados, ehCapsula: true });
    res.json(await painelComOrdens());
  } catch (error) {
    responderErro(res, error, "Erro ao salvar regras do insumo");
  }
};

// Marca/desmarca um produto existente como cápsula.
export const marcarCapsula = async (req, res) => {
  try {
    const produto = await Produto.findByPk(req.params.id);
    if (!produto) throw erroHttp(404, "Produto não encontrado.");
    const ehCapsula = req.body?.ehCapsula !== false;
    if (ehCapsula && produto.controlaMontagem) throw erroHttp(400, "Produto com montagem não pode ser cápsula.");
    if (!ehCapsula) {
      const usado = (await Produto.findAll({ where: { controlaMontagem: true } })).some((p) => idsCapsulas(p).includes(produto.id));
      if (usado) throw erroHttp(400, "Esta cápsula está na montagem de algum produto. Tire de lá antes.");
    }
    await produto.update({ ehCapsula });
    res.json(await painelComOrdens());
  } catch (error) {
    responderErro(res, error, "Erro ao marcar cápsula");
  }
};

// Busca de produtos para os itens (inclui arquivados: cápsulas só de controle).
export const buscarProdutos = async (req, res) => {
  try {
    const busca = String(req.query.busca || "").trim();
    const where = {};
    if (busca) where[Op.or] = [contem("nome", busca), { sku: { [Op.iLike]: `%${busca}%` } }, contem("categoria", busca)];
    if (req.query.capsulas === "true") where.ehCapsula = true;
    const produtos = await Produto.findAll({
      where,
      attributes: ["id", "nome", "sku", "categoria", "imagemUrl", "estoque", "arquivado", "ehCapsula", "controlaMontagem", "custo", "unidadesPacote"],
      order: [["arquivado", "ASC"], ["nome", "ASC"]],
      limit: 40,
    });
    res.json(produtos);
  } catch (error) {
    responderErro(res, error, "Erro ao buscar produtos");
  }
};

// Histórico de movimentos feitos pela aba (recebimentos, montagem, ajustes).
export const historico = async (req, res) => {
  try {
    const where = { origem: ORIGEM };
    if (req.query.produtoId) where.produtoId = req.query.produtoId;
    const busca = String(req.query.busca || "").trim();
    if (busca) where[Op.or] = [contem("produtoNome", busca), contem("motivo", busca)];
    res.json(await MovimentacaoEstoque.findAll({ where, order: [["createdAt", "DESC"]], limit: 300 }));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar histórico");
  }
};

// ---------------------------------------------------------------------------
// Link público do fornecedor (sem login). Só devolve o necessário para
// responder: nada de preços, ids de produto ou dados de outros recebimentos.
// ---------------------------------------------------------------------------

const preDoToken = async (req) => {
  const token = String(req.get("x-acesso-fornecedor") || "");
  const invalido = () => {
    req.registrarFalha?.();
    return erroHttp(404, "Link inválido ou expirado. Peça um novo link para a Gira Kids.");
  };
  if (!FORMATO_TOKEN.test(token)) throw invalido();
  const pre = await PreRecebimento.findOne({ where: { tokenHash: hashToken(token) }, include: INCLUDE });
  if (!pre || pre.status === "CANCELADO" || (pre.linkExpiraEm && new Date(pre.linkExpiraEm) < new Date())) throw invalido();
  return pre;
};

const visaoFornecedor = (pre) => ({
  numero: pre.numero,
  empresa: "Gira Kids",
  fornecedorNome: pre.fornecedorNome,
  previsaoEntrega: pre.previsaoEntrega,
  observacao: pre.observacao,
  aberto: ABERTOS.includes(pre.status),
  recebido: ["RECEBIDO", "RECEBIDO_PARCIAL"].includes(pre.status),
  respondidoEm: pre.respondidoEm,
  respondidoPor: pre.respondidoPor,
  previsaoFornecedor: pre.previsaoFornecedor,
  observacaoFornecedor: pre.observacaoFornecedor,
  itens: [...pre.itens]
    .sort((a, b) => String(a.produtoNome).localeCompare(String(b.produtoNome)))
    .map((i) => ({
      id: i.id,
      nome: i.produtoNome,
      sku: i.produtoSku,
      imagemUrl: i.imagemUrl,
      tipo: i.destino,
      quantidadeSolicitada: i.quantidadeSolicitada,
      quantidadeFornecedor: i.quantidadeFornecedor,
      observacao: i.observacaoFornecedor,
      quantidadeRecebida: ["RECEBIDO", "RECEBIDO_PARCIAL"].includes(pre.status) ? i.quantidadeRecebida : undefined,
    })),
});

const semCache = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

export const publicoObter = async (req, res) => {
  try {
    semCache(res);
    const pre = await preDoToken(req);
    await pre.update({ linkAcessadoEm: new Date() });
    res.json(visaoFornecedor(pre));
  } catch (error) {
    responderErro(res, error, "Erro ao abrir o link");
  }
};

export const publicoResponder = async (req, res) => {
  try {
    semCache(res);
    const pre = await preDoToken(req);
    if (!ABERTOS.includes(pre.status)) throw erroHttp(400, "Este pedido já foi recebido pela Gira Kids e não pode mais ser alterado.");
    const corpo = req.body || {};
    const respostas = new Map((Array.isArray(corpo.itens) ? corpo.itens : []).slice(0, 300).map((i) => [String(i?.id), i]));
    const responsavel = texto(corpo.responsavel, 150);
    if (!responsavel) throw erroHttp(400, "Informe seu nome.");
    await sequelize.transaction(async (transaction) => {
      for (const item of pre.itens) {
        const r = respostas.get(item.id);
        if (!r || r.quantidade === "" || r.quantidade == null) throw erroHttp(400, `Informe quanto vai entregar de "${item.produtoNome}" (0 se não for entregar).`);
        await item.update({ quantidadeFornecedor: qtd(r.quantidade), observacaoFornecedor: texto(r.observacao, 500) }, { transaction });
      }
      await pre.update(
        {
          status: "FORNECEDOR_RESPONDEU",
          respondidoEm: new Date(),
          respondidoPor: responsavel,
          previsaoFornecedor: dataOuNulo(corpo.previsaoEntrega),
          observacaoFornecedor: texto(corpo.observacao),
          respostaVista: false,
        },
        { transaction },
      );
    });
    await pre.reload({ include: INCLUDE });
    res.json(visaoFornecedor(pre));
  } catch (error) {
    responderErro(res, error, "Erro ao enviar resposta");
  }
};
