import { Arquivo } from "../models/index.js";
import { erroHttp, responderErro } from "../utils/helpers.js";

const TIPOS_PERMITIDOS = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/;

export const enviar = async (req, res) => {
  try {
    if (!req.file) throw erroHttp(400, "Nenhum arquivo enviado.");
    if (!TIPOS_PERMITIDOS.test(req.file.mimetype)) {
      throw erroHttp(400, "Envie uma imagem (PNG, JPG, WEBP) ou PDF.");
    }
    const arquivo = await Arquivo.create({
      nome: req.file.originalname.slice(0, 200),
      mime: req.file.mimetype,
      tamanho: req.file.size,
      dados: req.file.buffer,
      enviadoPor: req.usuario?.nome || null,
    });
    const base = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}/api`).replace(/\/$/, "");
    res.status(201).json({ id: arquivo.id, url: `${base}/arquivos/${arquivo.id}` });
  } catch (error) {
    responderErro(res, error, "Erro ao enviar arquivo");
  }
};

export const servir = async (req, res) => {
  try {
    const arquivo = await Arquivo.findByPk(req.params.id);
    if (!arquivo) return res.status(404).end();
    res.set("Content-Type", arquivo.mime);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(arquivo.dados);
  } catch (error) {
    responderErro(res, error, "Erro ao abrir arquivo");
  }
};
