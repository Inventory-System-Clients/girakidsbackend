import { Op } from "sequelize";
import { PedidoNotaFiscal } from "../models/index.js";
import {
  buscarNotaPorPedido,
  buscarNotasEmitidas,
  buscarFreteETransportadoraPorChave,
} from "../services/nfemailService.js";

const camposEditaveis = [
  "clienteNome",
  "numeroPedido",
  "dataPedido",
  "numeroNota",
  "dataNota",
  "tipoFrete",
  "transportadora",
  "numeroColeta",
  "teveCotacao",
  "dataCotacao",
  "numeroCotacao",
  "valorNota",
  "chaveAcessoNFe",
  "origemDados",
  "observacoes",
];

const extrairPayload = (body) => {
  const payload = {};
  for (const campo of camposEditaveis) {
    if (body[campo] !== undefined) payload[campo] = body[campo];
  }
  return payload;
};

const pedidoNotaFiscalController = {
  async criar(req, res) {
    try {
      const payload = extrairPayload(req.body);

      if (!payload.clienteNome || !String(payload.clienteNome).trim()) {
        return res.status(400).json({ error: "clienteNome é obrigatório." });
      }
      if (!payload.numeroPedido || !String(payload.numeroPedido).trim()) {
        return res.status(400).json({ error: "numeroPedido é obrigatório." });
      }

      const registro = await PedidoNotaFiscal.create({
        origemDados: "MANUAL",
        ...payload,
        usuarioId: req.usuario?.id || null,
      });

      return res.status(201).json(registro);
    } catch (error) {
      console.error("Erro ao criar pedido/nota fiscal:", error);
      return res.status(500).json({ error: "Erro ao criar pedido/nota fiscal." });
    }
  },

  async listar(req, res) {
    try {
      const { clienteNome, numeroPedido, dataInicio, dataFim, teveCotacao } =
        req.query;

      const where = {};
      if (clienteNome) where.clienteNome = { [Op.iLike]: `%${clienteNome}%` };
      if (numeroPedido) where.numeroPedido = { [Op.iLike]: `%${numeroPedido}%` };
      if (teveCotacao !== undefined) where.teveCotacao = teveCotacao === "true";

      if (dataInicio || dataFim) {
        where.dataPedido = {
          [Op.between]: [
            dataInicio || "1970-01-01",
            dataFim || new Date().toISOString().slice(0, 10),
          ],
        };
      }

      const registros = await PedidoNotaFiscal.findAll({
        where,
        order: [["dataPedido", "DESC"], ["createdAt", "DESC"]],
      });

      return res.json(registros);
    } catch (error) {
      console.error("Erro ao listar pedidos/notas fiscais:", error);
      return res
        .status(500)
        .json({ error: "Erro ao listar pedidos/notas fiscais." });
    }
  },

  async atualizar(req, res) {
    try {
      const { id } = req.params;
      const payload = extrairPayload(req.body);

      const registro = await PedidoNotaFiscal.findByPk(id);
      if (!registro) {
        return res.status(404).json({ error: "Registro não encontrado." });
      }

      await registro.update(payload);
      return res.json(registro);
    } catch (error) {
      console.error("Erro ao atualizar pedido/nota fiscal:", error);
      return res
        .status(500)
        .json({ error: "Erro ao atualizar pedido/nota fiscal." });
    }
  },

  async excluir(req, res) {
    try {
      const { id } = req.params;
      const excluidas = await PedidoNotaFiscal.destroy({ where: { id } });

      if (!excluidas) {
        return res.status(404).json({ error: "Registro não encontrado." });
      }

      return res.json({ success: true, id });
    } catch (error) {
      console.error("Erro ao excluir pedido/nota fiscal:", error);
      return res
        .status(500)
        .json({ error: "Erro ao excluir pedido/nota fiscal." });
    }
  },

  async excluirEmLote(req, res) {
    try {
      const { ids } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res
          .status(400)
          .json({ error: "Informe um array de ids para exclusão em lote." });
      }

      const idsValidos = ids
        .map((item) => String(item || "").trim())
        .filter((item) => item.length > 0);

      const excluidas = await PedidoNotaFiscal.destroy({
        where: { id: { [Op.in]: idsValidos } },
      });

      return res.json({
        success: true,
        solicitadas: idsValidos.length,
        excluidas,
      });
    } catch (error) {
      console.error("Erro ao excluir pedidos/notas fiscais em lote:", error);
      return res
        .status(500)
        .json({ error: "Erro ao excluir pedidos/notas fiscais em lote." });
    }
  },

  // Busca somente leitura das notas emitidas na NFeMail, para o usuário
  // escolher manualmente qual delas corresponde a um pedido (o campo
  // "número do pedido" costuma vir vazio direto da NFeMail, então o
  // casamento automático por numeroPedido não é confiável aqui).
  async buscarNotasNFeMail(req, res) {
    try {
      const { page, limit } = req.query;
      const notas = await buscarNotasEmitidas({
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 50,
      });
      return res.json({ notas });
    } catch (error) {
      console.error("Erro ao buscar notas na NFeMail:", error);
      return res
        .status(error.status || 500)
        .json({ error: error.message || "Erro ao buscar notas na NFeMail." });
    }
  },

  // Busca CIF/FOB e transportadora de UMA nota específica (via XML completo
  // pela chave de acesso). Chamado quando o usuário escolhe uma nota no
  // buscador, já que a listagem resumida não traz esses dois campos.
  async buscarDetalheFreteNFeMail(req, res) {
    try {
      const { chave } = req.query;
      if (!chave) {
        return res.status(400).json({ error: "chave é obrigatória." });
      }

      const detalhe = await buscarFreteETransportadoraPorChave(chave);
      return res.json(detalhe);
    } catch (error) {
      console.error("Erro ao buscar detalhe de frete na NFeMail:", error);
      return res.status(error.status || 500).json({
        error: error.message || "Erro ao buscar detalhe de frete na NFeMail.",
      });
    }
  },

  // Preenche numeroNota/dataNota/tipoFrete/transportadora/valorNota a partir
  // da NFeMail, casando pelo numeroPedido. Nunca sobrescreve numeroColeta ou
  // teveCotacao/dataCotacao, que são controle interno do time comercial.
  async sincronizarNFeMail(req, res) {
    try {
      const { numeroPedido, page, limit } = req.body || {};

      const notas = numeroPedido
        ? await buscarNotaPorPedido(numeroPedido)
        : await buscarNotasEmitidas({ page, limit });

      if (notas.length === 0) {
        return res.json({
          atualizados: 0,
          criados: 0,
          semNumeroPedido: 0,
          notasEncontradas: 0,
        });
      }

      let atualizados = 0;
      let criados = 0;
      let semNumeroPedido = 0;

      for (const nota of notas) {
        if (!nota.numeroPedido) {
          semNumeroPedido += 1;
          continue;
        }

        const existente = await PedidoNotaFiscal.findOne({
          where: { numeroPedido: nota.numeroPedido },
        });

        const dadosNota = {
          numeroNota: nota.numeroNota ?? existente?.numeroNota ?? null,
          dataNota: nota.dataNota ?? existente?.dataNota ?? null,
          tipoFrete: nota.tipoFrete ?? existente?.tipoFrete ?? null,
          transportadora:
            nota.transportadora ?? existente?.transportadora ?? null,
          valorNota: nota.valorNota ?? existente?.valorNota ?? null,
          chaveAcessoNFe:
            nota.chaveAcessoNFe ?? existente?.chaveAcessoNFe ?? null,
          origemDados: "NFEMAIL",
        };

        if (existente) {
          await existente.update(dadosNota);
          atualizados += 1;
        } else if (nota.clienteNome) {
          await PedidoNotaFiscal.create({
            clienteNome: nota.clienteNome,
            numeroPedido: nota.numeroPedido,
            usuarioId: req.usuario?.id || null,
            ...dadosNota,
          });
          criados += 1;
        }
      }

      return res.json({
        atualizados,
        criados,
        semNumeroPedido,
        notasEncontradas: notas.length,
      });
    } catch (error) {
      console.error("Erro ao sincronizar com a NFeMail:", error);
      return res
        .status(error.status || 500)
        .json({ error: error.message || "Erro ao sincronizar com a NFeMail." });
    }
  },
};

export default pedidoNotaFiscalController;
