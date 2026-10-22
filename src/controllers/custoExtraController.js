import { Op } from "sequelize";
import { Pedido, PedidoCustoExtra } from "../models/index.js";
import { CATEGORIAS_CUSTO } from "../models/PedidoCustoExtra.js";
import { arredondar, erroHttp, hojeISO, numero, responderErro } from "../utils/helpers.js";
import { contem } from "../utils/busca.js";

export const categorias = (req, res) => res.json(CATEGORIAS_CUSTO);

// Aba "Custos pós-venda": todos os custos extras do período.
export const listar = async (req, res) => {
  try {
    const where = {};
    if (req.query.inicio || req.query.fim) {
      where.data = {
        ...(req.query.inicio ? { [Op.gte]: req.query.inicio } : {}),
        ...(req.query.fim ? { [Op.lte]: req.query.fim } : {}),
      };
    }
    if (req.query.categoria) where.categoria = { [Op.in]: String(req.query.categoria).split(",") };
    const busca = String(req.query.busca || "").trim();
    const wherePedido = {};
    if (busca) {
      wherePedido[Op.or] = [
        contem("pedido.clienteNome", busca),
        ...(/^\d+$/.test(busca) ? [{ numero: Number(busca) }] : []),
      ];
    }
    const custos = await PedidoCustoExtra.findAll({
      where,
      include: [{
        model: Pedido,
        as: "pedido",
        attributes: ["id", "numero", "codigoLegado", "clienteNome", "total", "createdAt", "statusExpedicao"],
        where: wherePedido,
      }],
      order: [["data", "DESC"], ["createdAt", "DESC"]],
      limit: 500,
    });
    const total = arredondar(custos.reduce((s, c) => s + Number(c.valor), 0));
    const porCategoria = {};
    for (const c of custos) porCategoria[c.categoria] = arredondar((porCategoria[c.categoria] || 0) + Number(c.valor));
    res.json({
      itens: custos.map((c) => ({ ...c.toJSON(), valor: Number(c.valor) })),
      total,
      porCategoria,
      pedidos: new Set(custos.map((c) => c.pedidoId)).size,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao listar custos pós-venda");
  }
};

const localizarPedido = async ({ pedidoId, numeroPedido }) => {
  const pedido = pedidoId
    ? await Pedido.findByPk(pedidoId)
    : await Pedido.findOne({
        where: {
          tipo: "PEDIDO",
          [Op.or]: [
            ...(/^\d+$/.test(String(numeroPedido)) ? [{ numero: Number(numeroPedido) }] : []),
            { codigoLegado: String(numeroPedido || "") },
          ],
        },
      });
  if (!pedido || pedido.tipo !== "PEDIDO") throw erroHttp(404, "Pedido não encontrado.");
  return pedido;
};

export const criar = async (req, res) => {
  try {
    const { categoria, descricao, valor, data } = req.body || {};
    const pedido = await localizarPedido(req.body || {});
    if (pedido.statusVendas === "CANCELADO") throw erroHttp(400, "Pedido cancelado.");
    const valorNum = arredondar(numero(valor));
    if (valorNum <= 0) throw erroHttp(400, "Informe o valor do custo.");
    if (!String(descricao || "").trim()) throw erroHttp(400, "Descreva o motivo do custo.");
    const custo = await PedidoCustoExtra.create({
      pedidoId: pedido.id,
      categoria: CATEGORIAS_CUSTO[categoria] ? categoria : "OUTRO",
      descricao: String(descricao).trim(),
      valor: valorNum,
      data: /^\d{4}-\d{2}-\d{2}$/.test(String(data)) ? data : hojeISO(),
      usuarioNome: req.usuario.nome,
    });
    res.status(201).json({ ...custo.toJSON(), valor: valorNum, pedido: { id: pedido.id, numero: pedido.numero, clienteNome: pedido.clienteNome } });
  } catch (error) {
    responderErro(res, error, "Erro ao registrar custo");
  }
};

export const excluir = async (req, res) => {
  try {
    const removidos = await PedidoCustoExtra.destroy({ where: { id: req.params.id } });
    if (!removidos) throw erroHttp(404, "Custo não encontrado.");
    res.json({ message: "Custo removido." });
  } catch (error) {
    responderErro(res, error, "Erro ao remover custo");
  }
};

// Soma dos custos extras por pedido (para o dashboard).
export const somaPorPedido = async (pedidoIds) => {
  if (!pedidoIds.length) return new Map();
  const linhas = await PedidoCustoExtra.findAll({
    where: { pedidoId: { [Op.in]: pedidoIds } },
    attributes: ["pedidoId", "valor"],
    raw: true,
  });
  const mapa = new Map();
  for (const l of linhas) mapa.set(l.pedidoId, (mapa.get(l.pedidoId) || 0) + Number(l.valor));
  return mapa;
};

