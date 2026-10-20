import jwt from "jsonwebtoken";
import { Usuario, LogAtividade } from "../models/index.js";

const lerUsuarioDoToken = async (req) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const usuario = await Usuario.findByPk(decoded.id);
  return usuario && usuario.ativo ? usuario : null;
};

export const autenticar = async (req, res, next) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: "Token não fornecido" });
    }
    const usuario = await lerUsuarioDoToken(req);
    if (!usuario) {
      return res
        .status(401)
        .json({ error: "Usuário não encontrado ou inativo" });
    }
    req.usuario = usuario;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado" });
  }
};

// Catálogo público: identifica o usuário se houver token, sem exigir.
export const autenticarOpcional = async (req, res, next) => {
  try {
    req.usuario = await lerUsuarioDoToken(req);
  } catch {
    req.usuario = null;
  }
  next();
};

export const autorizarRole = (...rolesPermitidas) => (req, res, next) => {
  if (!rolesPermitidas.includes(req.usuario.role)) {
    return res.status(403).json({
      error: "Acesso negado. Você não tem permissão para esta ação.",
    });
  }
  next();
};

// ADMIN passa sempre; FUNCIONARIO precisa de ao menos uma das permissões.
// A aba Comercial (herdada do AgarraMais) usa a permissão COMERCIAL.
export const exigirPermissao = (...permissoes) => (req, res, next) => {
  if (!req.usuario?.temPermissao(...permissoes)) {
    return res.status(403).json({
      error: "Acesso negado. Você não tem permissão para esta tela.",
    });
  }
  next();
};

export const exigirInterno = (req, res, next) => {
  if (!["ADMIN", "FUNCIONARIO"].includes(req.usuario?.role)) {
    return res.status(403).json({ error: "Acesso restrito à equipe." });
  }
  next();
};

export const registrarLog = (acao, entidade = null) => (req, res, next) => {
  const originalSend = res.send;

  res.send = function (data) {
    res.send = originalSend;

    if (res.statusCode >= 200 && res.statusCode < 300) {
      LogAtividade.create({
        usuarioId: req.usuario?.id,
        acao,
        entidade,
        entidadeId: req.params.id || res.locals.entityId,
        detalhes: {
          method: req.method,
          path: req.path,
          body: req.method !== "GET" ? semSenha(req.body) : undefined,
          params: req.params,
          query: req.query,
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      }).catch((err) => console.error("Erro ao criar log:", err));
    }

    return res.send(data);
  };

  next();
};

const semSenha = (corpo) => {
  if (!corpo || typeof corpo !== "object") return corpo;
  const { senha, novaSenha, senhaAtual, ...resto } = corpo;
  return resto;
};
