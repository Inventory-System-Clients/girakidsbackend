import crypto from "crypto";
import { Usuario } from "../models/index.js";

/**
 * Acesso da IA Central (ia-central) por chave de API, sem login e sem token
 * vencendo. A chave fica em IA_CENTRAL_API_KEY (Render) e vem no cabeçalho
 * X-API-Key. Quem entra com ela vira o usuário "Integração IA" (ADMIN, criado
 * na primeira chamada, com senha aleatória: ninguém faz login com ele).
 *
 * Acesso total, como um ADMIN: o Maestro faz o que o Gabriel e o Leo pedirem
 * (as escritas só saem depois do "sim" deles, do lado da ia-central). Tudo
 * fica no log de atividades em nome de "Integração IA". Desativar esse
 * usuário corta a chave.
 */
export const EMAIL_IA = "ia-central@integracao.girakids";

export const chaveIaConfere = (req) => {
  const esperado = process.env.IA_CENTRAL_API_KEY || "";
  const recebido = String(req.headers["x-api-key"] || "");
  if (esperado.length < 32 || !recebido) return false;
  const a = crypto.createHash("sha256").update(recebido).digest();
  const b = crypto.createHash("sha256").update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
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
