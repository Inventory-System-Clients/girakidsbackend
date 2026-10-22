import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { Pedido, PedidoItem } from "../models/index.js";
import { INCLUDE_COMPLETO, serializarPedido } from "../services/pedidoService.js";
import { erroHttp, responderErro } from "../utils/helpers.js";
import { contem } from "../utils/busca.js";

// Abas da expedição:
//   INICIAR   liberado, montagem não iniciada
//   MONTAGEM  itens sendo conferidos
//   PRONTOS   montagem concluída, aguardando expedir
//   TODOS
const FILTRO_ABA = {
  INICIAR: { statusExpedicao: "NAO_INICIADO" },
  MONTAGEM: { statusExpedicao: "MONTAGEM", montagemConcluidaEm: null },
  PRONTOS: { statusExpedicao: "MONTAGEM", montagemConcluidaEm: { [Op.ne]: null } },
  TODOS: {},
};

const BASE = { tipo: "PEDIDO", statusVendas: "LIBERADO" };

export const listar = async (req, res) => {
  try {
    const aba = FILTRO_ABA[req.query.aba] ? req.query.aba : "INICIAR";
    const where = { ...BASE, ...FILTRO_ABA[aba] };
    if (aba === "TODOS" && req.query.expedicao) {
      where.statusExpedicao = { [Op.in]: req.query.expedicao.split(",") };
    }

    const busca = String(req.query.busca || "").trim();
    if (busca.length >= 2) {
      where[Op.or] = [
        contem("Pedido.clienteNome", busca),
        { codigoLegado: { [Op.iLike]: `%${busca}%` } },
        ...(/^\d+$/.test(busca) ? [{ numero: Number(busca) }] : []),
      ];
    }

    const limite = Math.min(Number(req.query.limite) || 30, 200);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const [{ rows, count }, ...contagens] = await Promise.all([
      Pedido.findAndCountAll({
        where,
        include: INCLUDE_COMPLETO,
        distinct: true,
        order: [["liberadoEm", "DESC"], ["numero", "DESC"]],
        limit: limite,
        offset: (pagina - 1) * limite,
      }),
      ...["INICIAR", "MONTAGEM", "PRONTOS"].map((a) => Pedido.count({ where: { ...BASE, ...FILTRO_ABA[a] } })),
    ]);
    const [iniciar, montagem, prontos] = contagens;
    res.json({
      itens: rows.map((p) => serializarPedido(p, { completo: false })),
      total: count,
      pagina,
      paginas: Math.max(1, Math.ceil(count / limite)),
      contadores: { INICIAR: iniciar, MONTAGEM: montagem, PRONTOS: prontos },
      pendentes: iniciar + montagem + prontos,
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

const responder = async (res, id) => res.json(serializarPedido(await carregarLiberado(id)));

// Marca/desmarca um item da montagem. O primeiro item marcado coloca o
// pedido "Em montagem"; desmarcar reabre uma montagem já concluída.
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
      await pedido.update(
        {
          statusExpedicao: "MONTAGEM",
          ...(conferido ? {} : { montagemConcluidaEm: null, montagemConcluidaPor: null }),
        },
        { transaction },
      );
    });
    await responder(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar item");
  }
};

export const concluirMontagem = async (req, res) => {
  try {
    const pedido = await carregarLiberado(req.params.id);
    if (pedido.statusExpedicao === "EXPEDIDO") throw erroHttp(400, "Pedido já expedido.");
    if (!pedido.itens.length || !pedido.itens.every((i) => i.conferido)) {
      throw erroHttp(400, "Confira todos os itens antes de concluir a montagem.");
    }
    await pedido.update({
      statusExpedicao: "MONTAGEM",
      montagemConcluidaEm: new Date(),
      montagemConcluidaPor: req.usuario.nome,
      ...(req.body?.observacoes !== undefined ? { observacoesExpedicao: req.body.observacoes || null } : {}),
    });
    await responder(res, pedido.id);
  } catch (error) {
    responderErro(res, error, "Erro ao concluir montagem");
  }
};

export const salvarObservacoes = async (req, res) => {
  try {
    const pedido = await carregarLiberado(req.params.id);
    await pedido.update({ observacoesExpedicao: req.body?.observacoes || null });
    await responder(res, pedido.id);
  } catch (error) {
    responderErro(res, error, "Erro ao salvar observações");
  }
};

const listaUrls = (valor) =>
  Array.isArray(valor) ? valor.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 30) : undefined;

// Fotos do pedido e da transportadora (podem ser adicionadas também depois de
// expedido, ex.: foto da coleta).
export const salvarFotos = async (req, res) => {
  try {
    const pedido = await carregarLiberado(req.params.id);
    const imagensExpedicao = listaUrls(req.body?.imagensExpedicao);
    const imagensTransportadora = listaUrls(req.body?.imagensTransportadora);
    await pedido.update({
      ...(imagensExpedicao ? { imagensExpedicao, imagemExpedicaoUrl: imagensExpedicao[0] || null } : {}),
      ...(imagensTransportadora ? { imagensTransportadora } : {}),
    });
    await responder(res, pedido.id);
  } catch (error) {
    responderErro(res, error, "Erro ao salvar fotos");
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
        {
          statusExpedicao: "NAO_INICIADO",
          expedidoEm: null,
          expedidoPor: null,
          montagemConcluidaEm: null,
          montagemConcluidaPor: null,
        },
        { transaction },
      );
    });
    await responder(res, req.params.id);
  } catch (error) {
    responderErro(res, error, "Erro ao desfazer montagem");
  }
};

export const expedir = async (req, res) => {
  try {
    const pedido = await carregarLiberado(req.params.id);
    if (pedido.statusExpedicao === "EXPEDIDO") throw erroHttp(400, "Pedido já expedido.");
    if (!pedido.itens.every((i) => i.conferido)) {
      throw erroHttp(400, "Confira todos os itens na montagem antes de expedir.");
    }
    const imagensExpedicao = listaUrls(req.body?.imagensExpedicao) ?? (req.body?.imagemUrl ? [req.body.imagemUrl] : pedido.imagensExpedicao);
    const imagensTransportadora = listaUrls(req.body?.imagensTransportadora) ?? pedido.imagensTransportadora;
    const agora = new Date();
    await pedido.update({
      statusExpedicao: "EXPEDIDO",
      expedidoEm: agora,
      expedidoPor: req.usuario.nome,
      montagemConcluidaEm: pedido.montagemConcluidaEm || agora,
      montagemConcluidaPor: pedido.montagemConcluidaPor || req.usuario.nome,
      imagensExpedicao,
      imagensTransportadora,
      imagemExpedicaoUrl: imagensExpedicao[0] || null,
      observacoesExpedicao: req.body?.observacoes ?? pedido.observacoesExpedicao,
    });
    await responder(res, pedido.id);
  } catch (error) {
    responderErro(res, error, "Erro ao expedir pedido");
  }
};
