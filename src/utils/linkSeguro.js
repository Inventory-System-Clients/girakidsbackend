import crypto from "crypto";

// Links públicos (ex.: pré-recebimento para o fornecedor).
// - token de 256 bits aleatórios (base64url, 43 caracteres);
// - no banco fica o SHA-256 (para achar) e uma cópia cifrada com AES-256-GCM
//   (para a equipe copiar o link de novo). Vazamento só do banco não revela
//   links válidos sem a chave do servidor.

const chave = () =>
  crypto
    .createHash("sha256")
    .update(`girakids-links:${process.env.LINK_SECRET || process.env.JWT_SECRET}`)
    .digest();

export const FORMATO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

// Assinatura (HMAC-SHA256) de um texto: links que não precisam ficar no banco,
// como o de acompanhamento do pedido. Sem a chave do servidor não dá para
// montar o link de outro pedido.
export const assinar = (finalidade, texto) =>
  crypto.createHmac("sha256", chave()).update(`${finalidade}:${texto}`).digest("base64url");

export const assinaturaConfere = (finalidade, texto, assinatura) => {
  const esperada = Buffer.from(assinar(finalidade, texto));
  const recebida = Buffer.from(String(assinatura || ""));
  return esperada.length === recebida.length && crypto.timingSafeEqual(esperada, recebida);
};

export const gerarToken = () => crypto.randomBytes(32).toString("base64url");

export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export const cifrar = (texto) => {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv("aes-256-gcm", chave(), iv);
  const dados = Buffer.concat([cifra.update(String(texto), "utf8"), cifra.final()]);
  return [iv, cifra.getAuthTag(), dados].map((b) => b.toString("base64url")).join(".");
};

export const decifrar = (valor) => {
  try {
    const [iv, tag, dados] = String(valor || "").split(".").map((p) => Buffer.from(p, "base64url"));
    const decifra = crypto.createDecipheriv("aes-256-gcm", chave(), iv);
    decifra.setAuthTag(tag);
    return Buffer.concat([decifra.update(dados), decifra.final()]).toString("utf8");
  } catch {
    return null;
  }
};

// Limite de requisições por IP, em memória (uma instância na Render).
// Erros de token contam em dobro e bloqueiam o IP por um tempo.
export const limitarTaxa = ({ janelaMs = 60_000, maximo = 40, bloqueioMs = 15 * 60_000 } = {}) => {
  // Contagem própria de cada limite (login não divide contador com links).
  const janelas = new Map();
  const limpar = setInterval(() => {
    const agora = Date.now();
    for (const [ip, j] of janelas) if (j.fim < agora && (!j.bloqueadoAte || j.bloqueadoAte < agora)) janelas.delete(ip);
  }, janelaMs);
  limpar.unref?.();

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "?";
    const agora = Date.now();
    let j = janelas.get(ip);
    if (!j || j.fim < agora) {
      j = { fim: agora + janelaMs, total: 0, bloqueadoAte: j?.bloqueadoAte || 0 };
      janelas.set(ip, j);
    }
    if (j.bloqueadoAte > agora) {
      res.set("Retry-After", String(Math.ceil((j.bloqueadoAte - agora) / 1000)));
      return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." });
    }
    j.total += 1;
    if (j.total > maximo) {
      j.bloqueadoAte = agora + bloqueioMs;
      return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." });
    }
    // Token inválido pesa mais (dificulta adivinhar links).
    req.registrarFalha = () => {
      j.total += 5;
    };
    return next();
  };
};
