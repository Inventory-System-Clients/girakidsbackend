import crypto from "crypto";

// Upload de imagens para o Cloudinary pela API REST (upload assinado feito
// no backend — o segredo nunca vai para o navegador). Aceita CLOUDINARY_URL
// (cloudinary://API_KEY:API_SECRET@CLOUD_NAME) ou as três variáveis
// separadas.

const credenciais = () => {
  if (process.env.CLOUDINARY_URL) {
    const url = new URL(process.env.CLOUDINARY_URL);
    return {
      nuvem: url.hostname,
      chave: decodeURIComponent(url.username),
      segredo: decodeURIComponent(url.password),
    };
  }
  return {
    nuvem: process.env.CLOUDINARY_CLOUD_NAME,
    chave: process.env.CLOUDINARY_API_KEY,
    segredo: process.env.CLOUDINARY_API_SECRET,
  };
};

export const cloudinaryConfigurado = () => {
  const { nuvem, chave, segredo } = credenciais();
  return Boolean(nuvem && chave && segredo);
};

const PASTA_PADRAO = () => process.env.CLOUDINARY_PASTA || "girakids";

// Envia um Buffer (ou uma URL pública, que o Cloudinary baixa sozinho) e
// devolve a URL https da imagem.
export const enviarImagemCloudinary = async ({ buffer, mime, url, pasta = "produtos" }) => {
  const { nuvem, chave, segredo } = credenciais();
  if (!nuvem || !chave || !segredo) {
    throw new Error("Configure CLOUDINARY_URL no ambiente do backend");
  }

  const parametros = {
    folder: `${PASTA_PADRAO()}/${pasta}`,
    timestamp: Math.floor(Date.now() / 1000),
  };
  const assinatura = crypto
    .createHash("sha1")
    .update(
      Object.keys(parametros)
        .sort()
        .map((k) => `${k}=${parametros[k]}`)
        .join("&") + segredo,
    )
    .digest("hex");

  const corpo = new FormData();
  corpo.append("file", url || new Blob([buffer], { type: mime }));
  corpo.append("api_key", chave);
  corpo.append("signature", assinatura);
  Object.entries(parametros).forEach(([k, v]) => corpo.append(k, String(v)));

  const resposta = await fetch(`https://api.cloudinary.com/v1_1/${nuvem}/image/upload`, {
    method: "POST",
    body: corpo,
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || !dados.secure_url) {
    throw new Error(`Cloudinary recusou a imagem: ${dados.error?.message || resposta.status}`);
  }
  return dados.secure_url;
};

export const ehUrlCloudinary = (url) => /res\.cloudinary\.com\//.test(String(url || ""));
