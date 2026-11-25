import crypto from "crypto";
import { authenticator } from "otplib";
import { cifrarCredenciais, decifrarCredenciais } from "./cofreCredenciais.js";

// Verificação em duas etapas (2FA) por app autenticador (TOTP, RFC 6238):
// Google Authenticator, Microsoft Authenticator, Authy etc.
// - O segredo fica cifrado (AES-256-GCM do cofre de credenciais), amarrado ao
//   id do usuário: copiado para outra conta, não decifra.
// - Aceita o código atual e o vizinho (±30 s de relógio), e nunca o mesmo
//   código duas vezes (anti-replay).
// - Códigos de recuperação: aleatórios, de uso único, guardados só em hash.

authenticator.options = { window: 1, step: 30, digits: 6 };

const EMISSOR = "Gira Kids";
const rotulo = (usuarioId) => `mfa:${usuarioId}`;

export const novoSegredo = () => authenticator.generateSecret(20);

export const cifrarSegredo = (usuarioId, segredo) => cifrarCredenciais(rotulo(usuarioId), { segredo });
export const decifrarSegredo = (usuarioId, cifrado) => decifrarCredenciais(rotulo(usuarioId), cifrado).segredo;

export const urlAutenticador = (email, segredo) => authenticator.keyuri(email, EMISSOR, segredo);

const passoAtual = () => Math.floor(Date.now() / 1000 / 30);

// Confere o código de 6 dígitos. Devolve o passo de tempo usado (para gravar
// e impedir reuso) ou null se inválido/já usado.
export const conferirCodigo = (segredo, codigo, ultimoPasso = 0) => {
  const token = String(codigo || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return null;
  const delta = authenticator.checkDelta(token, segredo);
  if (delta === null) return null;
  const passo = passoAtual() + delta;
  if (passo <= Number(ultimoPasso || 0)) return null;
  return passo;
};

const hashCodigo = (codigo) =>
  crypto.createHash("sha256").update(`girakids-mfa-recuperacao:${String(codigo).toUpperCase().replace(/[^A-Z0-9]/g, "")}`).digest("hex");

// 8 códigos XXXX-XXXX (40 bits cada). Devolve os códigos (mostrar uma vez) e
// os hashes (guardar).
export const gerarCodigosRecuperacao = () => {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codigos = Array.from({ length: 8 }, () => {
    const bytes = crypto.randomBytes(8);
    const t = Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join("");
    return `${t.slice(0, 4)}-${t.slice(4)}`;
  });
  return { codigos, hashes: codigos.map(hashCodigo) };
};

// Código de recuperação: devolve a lista sem ele (consumido) ou null.
export const consumirCodigoRecuperacao = (hashes, codigo) => {
  const alvo = hashCodigo(codigo);
  const lista = Array.isArray(hashes) ? hashes : [];
  const achou = lista.some((h) => h.length === alvo.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(alvo)));
  return achou ? lista.filter((h) => h !== alvo) : null;
};
