import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { Pedido, PedidoItem } from "../models/index.js";
import { INCLUDE_COMPLETO, serializarPedido } from "../services/pedidoService.js";
import { erroHttp, responderErro } from "../utils/helpers.js";

// Abas: INICIAR (liberado, montagem não iniciada), MONTAGEM, TODOS.
export const listar = async (req, res) => {
  try {
    const aba = req.query.aba || "INICIAR";
    const where = { tipo: "PEDIDO", statusVendas: "LIBERADO" };
    if (aba === "INICIAR") where.statusExpedicao = "NAO_INICIADO";
    if (aba === "MONTAGEM") where.statusExpedicao = "MONTAGEM";
    if (req.query.expedicao) where.statusExpedicao = { [Op.in]: req.query.expedicao.split(",") };

    const busca = String(req.query.busca || "").trim();
    if (busca.length >= 2) {
      where[Op.or] = [
        { clienteNome: { [Op.iLike]: `%${busca}%` } },
        ...(/^\d+$/.test(busca) ? [{ numero: Number(busca) }] : []),
      ];
    }

    const limite = Math.min(Number(req.query.limite) || 30, 200);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const { rows, count } = await Pedido.findAndCountAll({
      where,
      include: INCLUDE_COMPLETO,
      distinct: true,
      order: [["liberadoEm", "DESC"], ["numero", "DESC"]],
      limit: limite,
      offset: (pagina - 1) * limite,
    });
    const pendentes = await Pedido.count({
      where: { tipo: "PEDIDO", statusVendas: "LIBERADO", statusExpedicao: { [Op.ne]: "EXPEDIDO" } },
    });
    res.json({
      itens: rows.map((p) => serializarPedido(p, { completo: false })),
      total: count,
      pagina,
      paginas: Math.max(1, Math.ceil(count / limite)),
      pendentes,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao listar expedição");
  }
};

const carregarLiberado = async (id, transaction) => {
  const pedido = await Pedido.findByPk(id, { include: INCLUDE_COMPLETO, transaction });
  if (!pedido) throw erroHttp(404, "Pedido não encontrado.");
  if (pedido.statusVendas !== "LIBERADO") throw erroHttp(400, "Pedido não liberado para expedição.");
  return pedido;
};

// Marca/desmarca um item do checklist de montagem. O primeiro item marcado
// coloca o pedido em "Montagem Pedido".
export const marcarItem = async (req, res) => {
  try {
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarLiberado(req.params.id, transaction);
      if (pedido.statusExpedicao === "EXPEDIDO") throw erroHttp(400, "Pedido já expedido.");
      const item = pedido.itens.find((i) => i.id === req.params.itemId);
      if (!item) throw erroHttp(404, "Item não encontrado.");
      const conferido = Boolean(req.body?.conferido);
      await item.update(
        {
          conferido,
          conferidoEm: conferido ? new Date() : null,
          conferidoPor: conferido ? req.usuario.nome : null,
        },
        { transaction },
      );
      if (pedido.statusExpedicao === "NAO_INICIADO") {
        await pedido.update({ statusExpedicao: "MONTAGEM" }, { transaction });
      }
    });
    res.json(serializarPedido(await carregarLiberado(req.params.id)));
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar item");
  }
};

export const salvarObservacoes = async (req, res) => {
  try {
    const pedido = await carregarLiberado(req.params.id);
    await pedido.update({ observacoesExpedicao: req.body?.observacoes || null });
    res.json(serializarPedido(pedido));
  } catch (error) {
    responderErro(res, error, "Erro ao salvar observações");
  }
};

export const desfazerChecklist = async (req, res) => {
  try {
    await sequelize.transaction(async (transaction) => {
      const pedido = await carregarLiberado(req.params.id, transaction);
      await PedidoItem.update(
        { conferido: false, conferidoEm: null, conferidoPor: null },
        { where: { pedidoId: pedido.id }, transaction },
      );
      await pedido.update(
        { statusExpedicao: "NAO_INICIADO", expedidoEm: null, expedidoPor: null },
        { transaction },
      );
    });
    res.json(serializarPedido(await carregarLiberado(req.params.id)));
  } catch (error) {
    responderErro(res, error, "Erro ao desfazer checklist");
  }
};

export const expedir = async (req, res) => {
  try {
    const pedido = await carregarLiberado(req.params.id);
    if (pedido.statusExpedicao === "EXPEDIDO") throw erroHttp(400, "Pedido já expedido.");
    if (!pedido.itens.every((i) => i.conferido)) {
      throw erroHttp(400, "Confira todos os itens no checklist antes de expedir.");
    }
    await pedido.update({
      statusExpedicao: "EXPEDIDO",
      expedidoEm: new Date(),
      expedidoPor: req.usuario.nome,
      imagemExpedicaoUrl: req.body?.imagemUrl || pedido.imagemExpedicaoUrl,
      observacoesExpedicao: req.body?.observacoes ?? pedido.observacoesExpedicao,
    });
    res.json(serializarPedido(await carregarLiberado(req.params.id)));
  } catch (error) {
    responderErro(res, error, "Erro ao expedir pedido");
  }
};
