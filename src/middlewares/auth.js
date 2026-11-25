import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Usuario, LogAtividade } from "../models/index.js";

// Selo da senha atual dentro do token: trocar (ou resetar) a senha derruba
// todas as sessões abertas com a senha antiga.
// Com 2FA ativo, o selo inclui a data de ativação: ativar/resetar o 2FA
// derruba as sessões anteriores (quem não usa 2FA não é afetado).
export const seloSenha = (usuario) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(`sessao:${usuario.id}:${usuario.senha}${usuario.mfaAtivo ? `:mfa:${new Date(usuario.mfaAtivadoEm || 0).getTime()}` : ""}`)
    .digest("base64url")
    .slice(0, 22);

// Sessão de administrador dura menos (12 h): token vazado vale pouco tempo.
export const gerarToken = (usuario) =>
  jwt.sign({ id: usuario.id, role: usuario.role, sv: seloSenha(usuario) }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: usuario.role === "ADMIN" ? process.env.JWT_EXPIRES_IN_ADMIN || "12h" : process.env.JWT_EXPIRES_IN || "7d",
  });

// Desafio curto entre senha certa e código do 2FA (não é sessão: só serve
// para /auth/login/mfa).
export const gerarDesafioMfa = (usuario) =>
  jwt.sign({ id: usuario.id, fin: "mfa", sv: seloSenha(usuario) }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "5m" });

export const lerDesafioMfa = async (desafio) => {
  const dados = jwt.verify(String(desafio || ""), process.env.JWT_SECRET, { algorithms: ["HS256"] });
  if (dados.fin !== "mfa") throw new Error("Desafio inválido.");
  const usuario = await Usuario.findByPk(dados.id);
  if (!usuario || !usuario.ativo) throw new Error("Usuário inválido.");
  const esperado = seloSenha(usuario);
  const sv = String(dados.sv || "");
  if (sv.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sv), Buffer.from(esperado))) throw new Error("Desafio expirado.");
  return usuario;
};

// 2FA obrigatório para ADMIN. MFA_ADMIN_OBRIGATORIO=false desliga a
// exigência (só para emergência/rollback).
export const mfaObrigatorio = (usuario) =>
  usuario?.role === "ADMIN" && !usuario.mfaAtivo && process.env.MFA_ADMIN_OBRIGATORIO !== "false";
// Admin sem 2FA só usa o necessário para configurá-lo.
const ROTAS_SEM_MFA = [/\/auth\/perfil$/, /\/auth\/senha$/, /\/auth\/mfa(\/|$)/];
const adminSemMfaForaDaConfig = (req, usuario) =>
  mfaObrigatorio(usuario) && !ROTAS_SEM_MFA.some((r) => r.test(String(req.originalUrl || "").split("?")[0]));

const lerUsuarioDoToken = async (req) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  // Desafio do 2FA (ou qualquer token com finalidade) nunca vale como sessão.
  if (decoded.fin) return null;
  const usuario = await Usuario.findByPk(decoded.id);
  if (!usuario || !usuario.ativo) return null;
  const sv = String(decoded.sv || "");
  const esperado = seloSenha(usuario);
  if (sv.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sv), Buffer.from(esperado))) return null;
  return usuario;
};

// Login de fornecedor só usa o portal dele e o básico da conta (perfil e
// senha); qualquer outra rota é negada.
const ROTAS_FORNECEDOR = [/\/portal-fornecedor(\/|$)/, /\/auth\/perfil$/, /\/auth\/senha$/];
const fornecedorForaDoPortal = (req, usuario) =>
  usuario?.role === "FORNECEDOR" && !ROTAS_FORNECEDOR.some((r) => r.test(String(req.originalUrl || "").split("?")[0]));

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
    if (fornecedorForaDoPortal(req, usuario)) {
      return res.status(403).json({ error: "Acesso restrito ao portal do fornecedor." });
    }
    if (adminSemMfaForaDaConfig(req, usuario)) {
      return res.status(403).json({ error: "Ative a verificação em duas etapas no seu perfil para continuar.", configurarMfa: true });
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
    if (fornecedorForaDoPortal(req, req.usuario)) req.usuario = null;
    // Admin sem 2FA navega o catálogo como visitante (sem dados internos).
    if (req.usuario && adminSemMfaForaDaConfig(req, req.usuario)) req.usuario = null;
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

// Como exigirPermissao, mas também libera o totem do showroom.
export const exigirPermissaoOuShowroom = (...permissoes) => (req, res, next) => {
  if (req.usuario?.role === "SHOWROOM") return next();
  return exigirPermissao(...permissoes)(req, res, next);
};

export const exigirInterno = (req, res, next) => {
  if (!["ADMIN", "FUNCIONARIO"].includes(req.usuario?.role)) {
    return res.status(403).json({ error: "Acesso restrito à equipe." });
  }
  next();
};

export const exigirAdmin = (req, res, next) => {
  if (req.usuario?.role !== "ADMIN") {
    return res.status(403).json({ error: "Acesso restrito aos administradores." });
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

// Log nunca guarda segredos: senhas, códigos de 2FA, tokens, chaves de API.
const CAMPO_SECRETO = /senha|password|codigo$|desafio|token|secret|segredo|apikey|api_key|accesstoken|chave|credenc|certificado/i;
const semSenha = (corpo) => {
  if (!corpo || typeof corpo !== "object") return corpo;
  if (Array.isArray(corpo)) return corpo.map(semSenha);
  return Object.fromEntries(
    Object.entries(corpo).map(([k, v]) => [k, CAMPO_SECRETO.test(k) ? "[oculto]" : v && typeof v === "object" ? semSenha(v) : v]),
  );
};
