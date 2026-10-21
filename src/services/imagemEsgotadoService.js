import crypto from "crypto";
import { Op } from "sequelize";
import { Produto } from "../models/index.js";

// Descobre se a "imagem de esgotado" de um produto é só uma cópia da imagem
// em estoque (mesmo arquivo em outro endereço — comum nos produtos vindos da
// loja antiga). Nesse caso o catálogo mostra a foto em preto e branco.

const hashDaImagem = async (url) => {
  const resposta = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return crypto.createHash("md5").update(Buffer.from(await resposta.arrayBuffer())).digest("hex");
};

const chavePar = (p) => `${p.imagemUrl || ""}|${p.imagemSemEstoqueUrl || ""}`;

// Verifica um produto (só baixa as imagens se o par mudou desde a última vez).
export const verificarImagemEsgotado = async (produto) => {
  const chave = chavePar(produto);
  if (produto.imagemEsgotadoVerificada === chave) return produto.imagemEsgotadoIgual;
  let igual = false;
  if (produto.imagemUrl && produto.imagemSemEstoqueUrl) {
    igual =
      produto.imagemUrl === produto.imagemSemEstoqueUrl ||
      (await hashDaImagem(produto.imagemUrl)) === (await hashDaImagem(produto.imagemSemEstoqueUrl));
  }
  await produto.update({ imagemEsgotadoIgual: igual, imagemEsgotadoVerificada: chave }, { silent: true });
  return igual;
};

// Roda em segundo plano depois que o servidor sobe: verifica os produtos com
// imagem de esgotado ainda não conferida.
export const verificarPendentes = async () => {
  const produtos = await Produto.findAll({
    where: { imagemSemEstoqueUrl: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: "" }] } },
  });
  let verificados = 0;
  for (const produto of produtos) {
    if (produto.imagemEsgotadoVerificada === chavePar(produto)) continue;
    try {
      await verificarImagemEsgotado(produto);
      verificados += 1;
    } catch (erro) {
      console.warn(`[imagens] Não foi possível comparar as imagens de ${produto.nome}: ${erro.message}`);
    }
  }
  if (verificados) console.log(`🖼️  Imagens de esgotado conferidas em ${verificados} produtos.`);
};
