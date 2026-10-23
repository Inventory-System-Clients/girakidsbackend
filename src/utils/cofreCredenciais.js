import crypto from "crypto";

// Cofre das credenciais de pagamento (aba Pagamentos).
// - AES-256-GCM: sigilo + autenticação (alterar o texto cifrado no banco faz
//   a leitura falhar em vez de devolver um valor trocado).
// - A chave NÃO fica no banco: vem de CREDENCIAIS_SECRET (ou, na falta dela,
//   é derivada do JWT_SECRET com um rótulo próprio). Quem só tiver acesso ao
//   banco não consegue ler nem forjar credenciais.
// - O nome do provedor entra como dado autenticado (AAD): não dá para copiar
//   a credencial cifrada de um banco para outro.
// - A API nunca devolve o valor em texto; o painel mostra só uma máscara.

const VERSAO = "v1";

const chave = () => {
  const base = process.env.CREDENCIAIS_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error("Defina CREDENCIAIS_SECRET (ou JWT_SECRET) no ambiente do backend.");
  return crypto.createHash("sha256").update(`girakids-credenciais-pagamento:${base}`).digest();
};

export const usaChavePropria = () => Boolean(process.env.CREDENCIAIS_SECRET && process.env.CREDENCIAIS_SECRET.length >= 32);

export const cifrarCredenciais = (provedor, dados) => {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv("aes-256-gcm", chave(), iv);
  cifra.setAAD(Buffer.from(`${VERSAO}:${provedor}`));
  const conteudo = Buffer.concat([cifra.update(JSON.stringify(dados), "utf8"), cifra.final()]);
  return [VERSAO, iv.toString("base64url"), cifra.getAuthTag().toString("base64url"), conteudo.toString("base64url")].join(".");
};

export const decifrarCredenciais = (provedor, valor) => {
  const [versao, iv, tag, conteudo] = String(valor || "").split(".");
  if (versao !== VERSAO) throw new Error("Formato de credencial desconhecido.");
  const decifra = crypto.createDecipheriv("aes-256-gcm", chave(), Buffer.from(iv, "base64url"));
  decifra.setAAD(Buffer.from(`${VERSAO}:${provedor}`));
  decifra.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decifra.update(Buffer.from(conteudo, "base64url")), decifra.final()]).toString("utf8"));
};

export const mascarar = (valor) => {
  const texto = String(valor || "");
  if (!texto) return "";
  if (texto.length <= 10) return "••••••";
  return `${texto.slice(0, 6)}…${texto.slice(-4)}`;
};
