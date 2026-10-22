import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import {
  Parceiro,
  Produto,
  Recebimento,
  RecebimentoItem,
  HistoricoPreco,
} from "../models/index.js";
import { movimentar } from "../services/estoqueService.js";
import { arredondar, erroHttp, hojeISO, numero, responderErro, somenteDigitos } from "../utils/helpers.js";
import { contem } from "../utils/busca.js";

// ---------------------------------------------------------------------------
// Parceiros (fornecedores e transportadoras)
// ---------------------------------------------------------------------------

export const listarParceiros = async (req, res) => {
  try {
    const where = {};
    if (req.query.tipo) where.tipo = req.query.tipo;
    if (req.query.ativos === "true") where.ativo = true;
    const busca = String(req.query.busca || "").trim();
    if (busca) {
      where[Op.or] = [
        contem("nome", busca),
        { documento: { [Op.iLike]: `%${busca}%` } },
        contem("contato", busca),
      ];
    }
    res.json(await Parceiro.findAll({ where, order: [["tipo", "DESC"], ["nome", "ASC"]] }));
  } catch (error) {
    responderErro(res, error, "Erro ao listar parceiros");
  }
};

const dadosParceiro = (corpo) => {
  const nome = String(corpo.nome || "").trim();
  if (!nome) throw erroHttp(400, "Informe o nome / razão social.");
  const documento = somenteDigitos(corpo.documento);
  return {
    nome,
    documento: documento
      ? documento.length === 14
        ? documento.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5")
        : documento.length === 11
          ? documento.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
          : corpo.documento
      : null,
    contato: corpo.contato || null,
    telefone: corpo.telefone || null,
    email: corpo.email || null,
    cidade: corpo.cidade || null,
    estado: corpo.estado ? String(corpo.estado).toUpperCase().slice(0, 2) : null,
    observacoes: corpo.observacoes || null,
    ativo: corpo.ativo !== false,
  };
};

export const criarParceiro = async (req, res) => {
  try {
    const tipo = req.body?.tipo === "TRANSPORTADORA" ? "TRANSPORTADORA" : "FORNECEDOR";
    const parceiro = await Parceiro.create({ ...dadosParceiro(req.body || {}), tipo, criadoPor: req.usuario.nome });
    res.status(201).json(parceiro);
  } catch (error) {
    responderErro(res, error, "Erro ao cadastrar parceiro");
  }
};

export const atualizarParceiro = async (req, res) => {
  try {
    const parceiro = await Parceiro.findByPk(req.params.id);
    if (!parceiro) throw erroHttp(404, "Parceiro não encontrado.");
    await parceiro.update(dadosParceiro({ ...parceiro.toJSON(), ...req.body }));
    res.json(parceiro);
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar parceiro");
  }
};

// ---------------------------------------------------------------------------
// Recebimentos
// ---------------------------------------------------------------------------

const INCLUDE_RECEBIMENTO = [
  { model: Parceiro, as: "fornecedor", attributes: ["id", "nome", "documento"] },
  { model: RecebimentoItem, as: "itens" },
];

export const resumo = async (req, res) => {
  try {
    const [total, confirmados, estornados, custo] = await Promise.all([
      Recebimento.count(),
      Recebimento.count({ where: { status: "CONFIRMADO" } }),
      Recebimento.count({ where: { status: "ESTORNADO" } }),
      Recebimento.sum("total", { where: { status: "CONFIRMADO" } }),
    ]);
    res.json({ total, confirmados, estornados, custoAcumulado: Number(custo || 0) });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar resumo");
  }
};

export const listarRecebimentos = async (req, res) => {
  try {
    const where = {};
    if (req.query.fornecedorId) where.fornecedorId = req.query.fornecedorId;
    if (req.query.status) where.status = req.query.status;
    if (req.query.inicio) where.dataRecebimento = { ...(where.dataRecebimento || {}), [Op.gte]: req.query.inicio };
    if (req.query.fim) where.dataRecebimento = { ...(where.dataRecebimento || {}), [Op.lte]: req.query.fim };
    if (req.query.produtoId) {
      const ids = await RecebimentoItem.findAll({
        where: { produtoId: req.query.produtoId },
        attributes: ["recebimentoId"],
        raw: true,
      });
      where.id = { [Op.in]: ids.map((i) => i.recebimentoId) };
    }
    const recebimentos = await Recebimento.findAll({
      where,
      include: INCLUDE_RECEBIMENTO,
      order: [["dataRecebimento", "DESC"], ["createdAt", "DESC"]],
      limit: 300,
    });
    res.json(recebimentos);
  } catch (error) {
    responderErro(res, error, "Erro ao listar recebimentos");
  }
};

// Confirma o recebimento: soma estoque, atualiza o custo do produto (sem
// mexer no preço de venda) e registra o histórico de custo.
export const criarRecebimento = async (req, res) => {
  try {
    const { fornecedorId, documento, dataRecebimento, observacoes, itens } = req.body || {};
    if (!fornecedorId) throw erroHttp(400, "Selecione um fornecedor.");
    if (!Array.isArray(itens) || !itens.length) throw erroHttp(400, "Adicione ao menos um item.");

    const recebimento = await sequelize.transaction(async (transaction) => {
      const fornecedor = await Parceiro.findByPk(fornecedorId, { transaction });
      if (!fornecedor) throw erroHttp(404, "Fornecedor não encontrado.");

      const linhas = itens.map((item, i) => {
        const quantidade = Math.round(numero(item.quantidade));
        const custoUnitario = numero(item.custoUnitario);
        if (!item.produtoId) throw erroHttp(400, `Item ${i + 1}: selecione um produto.`);
        if (quantidade < 1) throw erroHttp(400, `Item ${i + 1}: quantidade inválida.`);
        if (custoUnitario < 0) throw erroHttp(400, `Item ${i + 1}: custo inválido.`);
        return { ...item, quantidade, custoUnitario, total: arredondar(quantidade * custoUnitario) };
      });

      const novo = await Recebimento.create(
        {
          fornecedorId,
          documento: documento || null,
          dataRecebimento: dataRecebimento || hojeISO(),
          observacoes: observacoes || null,
          total: arredondar(linhas.reduce((s, l) => s + l.total, 0)),
          usuarioNome: req.usuario.nome,
        },
        { transaction },
      );

      for (const linha of linhas) {
        const produto = await Produto.findByPk(linha.produtoId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!produto) throw erroHttp(404, "Produto não encontrado.");
        await RecebimentoItem.create(
          {
            recebimentoId: novo.id,
            produtoId: produto.id,
            produtoNome: produto.nome,
            quantidade: linha.quantidade,
            custoUnitario: linha.custoUnitario,
            total: linha.total,
            observacao: linha.observacao || null,
          },
          { transaction },
        );
        await movimentar({
          produto,
          delta: linha.quantidade,
          tipo: "ENTRADA",
          motivo: `Recebimento ${fornecedor.nome}${documento ? ` - ${documento}` : ""}`,
          usuario: req.usuario,
          transaction,
        });
        if (Number(produto.custo ?? -1) !== linha.custoUnitario) {
          await HistoricoPreco.create(
            {
              produtoId: produto.id,
              campo: "CUSTO",
              valorAnterior: produto.custo,
              valorNovo: linha.custoUnitario,
              origem: "RECEBIMENTO",
              usuarioNome: req.usuario.nome,
            },
            { transaction },
          );
          await produto.update({ custo: linha.custoUnitario }, { transaction });
        }
      }
      return novo;
    });

    res.status(201).json(await Recebimento.findByPk(recebimento.id, { include: INCLUDE_RECEBIMENTO }));
  } catch (error) {
    responderErro(res, error, "Erro ao confirmar recebimento");
  }
};

export const estornarRecebimento = async (req, res) => {
  try {
    const motivo = String(req.body?.motivo || "").trim();
    if (!motivo) throw erroHttp(400, "Informe o motivo do estorno.");
    await sequelize.transaction(async (transaction) => {
      const recebimento = await Recebimento.findByPk(req.params.id, {
        include: INCLUDE_RECEBIMENTO,
        transaction,
      });
      if (!recebimento) throw erroHttp(404, "Recebimento não encontrado.");
      if (recebimento.status === "ESTORNADO") throw erroHttp(400, "Recebimento já estornado.");
      for (const item of recebimento.itens) {
        const produto = await Produto.findByPk(item.produtoId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!produto) continue;
        await movimentar({
          produto,
          delta: -item.quantidade,
          tipo: "SAIDA",
          motivo: `Estorno do recebimento ${recebimento.documento || recebimento.id.slice(0, 8)}: ${motivo}`,
          usuario: req.usuario,
          transaction,
        });
      }
      await recebimento.update(
        { status: "ESTORNADO", estornadoEm: new Date(), estornadoPor: req.usuario.nome, motivoEstorno: motivo },
        { transaction },
      );
    });
    res.json(await Recebimento.findByPk(req.params.id, { include: INCLUDE_RECEBIMENTO }));
  } catch (error) {
    responderErro(res, error, "Erro ao estornar recebimento");
  }
};

// Último custo de cada produto por fornecedor (histórico de custos).
export const ultimosCustos = async (req, res) => {
  try {
    const where = { status: "CONFIRMADO" };
    if (req.query.fornecedorId) where.fornecedorId = req.query.fornecedorId;
    const itens = await RecebimentoItem.findAll({
      include: [{ model: Recebimento, as: "recebimento", where, include: [{ model: Parceiro, as: "fornecedor", attributes: ["nome"] }] }],
      order: [[{ model: Recebimento, as: "recebimento" }, "dataRecebimento", "DESC"]],
      limit: 1000,
    });
    const vistos = new Map();
    for (const item of itens) {
      const chave = `${item.produtoId}:${item.recebimento.fornecedorId}`;
      if (!vistos.has(chave)) {
        vistos.set(chave, {
          produtoId: item.produtoId,
          produtoNome: item.produtoNome,
          fornecedor: item.recebimento.fornecedor?.nome,
          custoUnitario: Number(item.custoUnitario),
          data: item.recebimento.dataRecebimento,
        });
      }
    }
    res.json([...vistos.values()]);
  } catch (error) {
    responderErro(res, error, "Erro ao listar custos");
  }
};
