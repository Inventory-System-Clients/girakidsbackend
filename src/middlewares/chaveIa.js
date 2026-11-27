import crypto from "crypto";
import { Usuario } from "../models/index.js";

/**
 * Acesso da IA Central (ia-central) por chave de API, sem login e sem token
 * vencendo. A chave fica em IA_CENTRAL_API_KEY (Render) e vem no cabeçalho
 * X-API-Key. Quem entra com ela vira o usuário "Integração IA" (ADMIN, criado
 * na primeira chamada, com senha aleatória: ninguém faz login com ele).
 *
 * Lê qualquer rota (GET). Escrita só nas rotas que a IA já usa para vender;
 * o resto é recusado. Desativar o usuário "Integração IA" corta a chave.
 */
export const EMAIL_IA = "ia-central@integracao.girakids";

const ESCRITAS_PERMITIDAS = [
  /^\/api\/orcamentos$/, // monta orçamento
  /^\/api\/orcamentos\/[^/]+\/gerar-pedido$/, // com o sim do cliente vira pedido
  /^\/api\/checkout\/frete$/, // cota o frete (só calcula)
  /^\/api\/usuarios$/, // cria a conta do cliente
];

export const chaveIaConfere = (req) => {
  const esperado = process.env.IA_CENTRAL_API_KEY || "";
  const recebido = String(req.headers["x-api-key"] || "");
  if (esperado.length < 32 || !recebido) return false;
  const a = crypto.createHash("sha256").update(recebido).digest();
  const b = crypto.createHash("sha256").update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
};

export const escritaPermitidaIa = (req) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const caminho = String(req.originalUrl || "").split("?")[0].replace(/\/+$/, "");
  return ESCRITAS_PERMITIDAS.some((r) => r.test(caminho));
};

let cache = null;
export const usuarioIa = async () => {
  if (cache && Date.now() - cache.at < 60_000) return cache.usuario;
  const [usuario] = await Usuario.findOrCreate({
    where: { email: EMAIL_IA },
    defaults: {
      nome: "Integração IA (ia-central)",
      email: EMAIL_IA,
      senha: crypto.randomBytes(48).toString("base64url"),
      role: "ADMIN",
      ativo: true,
    },
  });
  cache = { at: Date.now(), usuario };
  return usuario;
};
