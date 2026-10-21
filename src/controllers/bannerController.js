import { sequelize } from "../database/connection.js";
import { Banner } from "../models/index.js";
import { erroHttp, responderErro } from "../utils/helpers.js";

const ORDEM = [["ordem", "ASC"], ["createdAt", "ASC"]];

const dados = (corpo) => {
  const imagemUrl = String(corpo.imagemUrl || "").trim();
  if (!imagemUrl) throw erroHttp(400, "A imagem do banner é obrigatória.");
  // Destino do botão: categoria, busca, produto ou nenhum (catálogo).
  const destino = corpo.destino || (corpo.categoria ? "categoria" : corpo.busca ? "busca" : corpo.produtoId ? "produto" : "nenhum");
  return {
    imagemUrl,
    imagemMobileUrl: String(corpo.imagemMobileUrl || "").trim() || null,
    alt: String(corpo.alt || "").trim().slice(0, 200) || null,
    textoBotao: String(corpo.textoBotao || "").trim().slice(0, 60) || null,
    categoria: destino === "categoria" ? String(corpo.categoria || "").trim() || null : null,
    busca: destino === "busca" ? String(corpo.busca || "").trim() || null : null,
    produtoId: destino === "produto" ? corpo.produtoId || null : null,
    ativo: corpo.ativo !== false,
  };
};

// Público: banners ativos do carrossel do catálogo.
export const listarAtivos = async (req, res) => {
  try {
    res.json(await Banner.findAll({ where: { ativo: true }, order: ORDEM }));
  } catch (error) {
    responderErro(res, error, "Erro ao listar banners");
  }
};

export const listarTodos = async (req, res) => {
  try {
    res.json(await Banner.findAll({ order: ORDEM }));
  } catch (error) {
    responderErro(res, error, "Erro ao listar banners");
  }
};

export const criar = async (req, res) => {
  try {
    const maior = (await Banner.max("ordem")) ?? -1;
    res.status(201).json(await Banner.create({ ...dados(req.body || {}), ordem: maior + 1 }));
  } catch (error) {
    responderErro(res, error, "Erro ao criar banner");
  }
};

export const atualizar = async (req, res) => {
  try {
    const banner = await Banner.findByPk(req.params.id);
    if (!banner) throw erroHttp(404, "Banner não encontrado.");
    await banner.update(dados({ ...banner.toJSON(), ...req.body }));
    res.json(banner);
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar banner");
  }
};

export const excluir = async (req, res) => {
  try {
    const removidos = await Banner.destroy({ where: { id: req.params.id } });
    if (!removidos) throw erroHttp(404, "Banner não encontrado.");
    res.json({ message: "Banner excluído." });
  } catch (error) {
    responderErro(res, error, "Erro ao excluir banner");
  }
};

// Recebe os ids na ordem desejada.
export const reordenar = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    await sequelize.transaction(async (transaction) => {
      for (const [ordem, id] of ids.entries()) {
        await Banner.update({ ordem }, { where: { id }, transaction });
      }
    });
    res.json(await Banner.findAll({ order: ORDEM }));
  } catch (error) {
    responderErro(res, error, "Erro ao reordenar banners");
  }
};
