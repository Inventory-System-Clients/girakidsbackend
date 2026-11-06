import { Arquivo } from "../models/index.js";
import { cloudinaryConfigurado, enviarImagemCloudinary } from "../services/cloudinaryService.js";
import { erroHttp, responderErro } from "../utils/helpers.js";

const TIPOS_PERMITIDOS = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/;
const PASTAS = new Set(["produtos", "expedicao", "notas"]);

// O tipo informado pelo navegador precisa bater com os primeiros bytes do
// arquivo (um HTML renomeado para .pdf não passa).
const conteudoConfere = (buffer, mime) => {
  const b = buffer || Buffer.alloc(0);
  const ini = (...bytes) => bytes.every((x, i) => b[i] === x);
  if (mime === "application/pdf") return b.subarray(0, 1024).includes(Buffer.from("%PDF-"));
  if (mime === "image/png") return ini(0x89, 0x50, 0x4e, 0x47);
  if (mime === "image/jpeg" || mime === "image/jpg") return ini(0xff, 0xd8, 0xff);
  if (mime === "image/gif") return ini(0x47, 0x49, 0x46, 0x38);
  if (mime === "image/webp") return ini(0x52, 0x49, 0x46, 0x46) && b.subarray(8, 12).toString() === "WEBP";
  return false;
};

// Imagens vão para o Cloudinary quando configurado; PDFs (e imagens sem
// Cloudinary) ficam no próprio banco.
export const enviar = async (req, res) => {
  try {
    if (!req.file) throw erroHttp(400, "Nenhum arquivo enviado.");
    if (!TIPOS_PERMITIDOS.test(req.file.mimetype) || !conteudoConfere(req.file.buffer, req.file.mimetype)) {
      throw erroHttp(400, "Envie uma imagem (PNG, JPG, WEBP) ou PDF.");
    }

    if (req.file.mimetype.startsWith("image/") && cloudinaryConfigurado()) {
      const pasta = PASTAS.has(req.body?.pasta) ? req.body.pasta : "produtos";
      const url = await enviarImagemCloudinary({
        buffer: req.file.buffer,
        mime: req.file.mimetype,
        pasta,
      });
      return res.status(201).json({ url, origem: "cloudinary" });
    }

    const arquivo = await Arquivo.create({
      nome: req.file.originalname.slice(0, 200),
      mime: req.file.mimetype,
      tamanho: req.file.size,
      dados: req.file.buffer,
      enviadoPor: req.usuario?.nome || null,
    });
    const base = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}/api`).replace(/\/$/, "");
    res.status(201).json({ id: arquivo.id, url: `${base}/arquivos/${arquivo.id}`, origem: "banco" });
  } catch (error) {
    responderErro(res, error, "Erro ao enviar arquivo");
  }
};

export const servir = async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) return res.status(404).end();
    const arquivo = await Arquivo.findByPk(req.params.id);
    if (!arquivo) return res.status(404).end();
    res.set("Content-Type", arquivo.mime);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(arquivo.dados);
  } catch (error) {
    responderErro(res, error, "Erro ao abrir arquivo");
  }
};
