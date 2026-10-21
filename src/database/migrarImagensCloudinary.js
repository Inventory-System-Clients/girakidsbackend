// Copia para o Cloudinary as imagens de produto que ainda estão fora dele
// (ex.: Firebase Storage da loja antiga ou arquivos salvos no banco) e troca
// as URLs nos produtos e nos itens de pedido.
//
// Uso: npm run imagens:cloudinary   (precisa de CLOUDINARY_URL no .env)
// Pode rodar de novo: imagens já no Cloudinary são ignoradas.
import crypto from "crypto";
import { sequelize } from "./connection.js";
import { sincronizarBanco } from "./migrate.js";
import { Produto, PedidoItem } from "../models/index.js";
import {
  cloudinaryConfigurado,
  ehUrlCloudinary,
  enviarImagemCloudinary,
} from "../services/cloudinaryService.js";

const migrar = async () => {
  if (!cloudinaryConfigurado()) {
    throw new Error("Configure CLOUDINARY_URL antes de migrar as imagens.");
  }
  await sincronizarBanco();

  const trocadas = new Map();
  const converter = async (url) => {
    if (!url || ehUrlCloudinary(url)) return url;
    if (trocadas.has(url)) return trocadas.get(url);
    try {
      const publicId = `legado-${crypto.createHash("sha1").update(url).digest("hex").slice(0, 24)}`;
      const nova = await enviarImagemCloudinary({ url, pasta: "produtos", publicId });
      trocadas.set(url, nova);
      return nova;
    } catch (erro) {
      console.warn(`  ⚠️  ${url.slice(0, 80)}… ${erro.message}`);
      trocadas.set(url, url);
      return url;
    }
  };

  const produtos = await Produto.findAll();
  let alterados = 0;
  for (const [indice, produto] of produtos.entries()) {
    const imagens = [];
    for (const url of produto.imagens?.length ? produto.imagens : [produto.imagemUrl].filter(Boolean)) {
      imagens.push(await converter(url));
    }
    const semEstoque = await converter(produto.imagemSemEstoqueUrl);
    const mudou =
      JSON.stringify(imagens) !== JSON.stringify(produto.imagens) || semEstoque !== produto.imagemSemEstoqueUrl;
    if (mudou) {
      await produto.update({ imagens, imagemUrl: imagens[0] || null, imagemSemEstoqueUrl: semEstoque || null });
      alterados += 1;
    }
    if ((indice + 1) % 25 === 0) console.log(`   ... ${indice + 1}/${produtos.length} produtos`);
  }

  // Itens de pedido guardam a imagem do momento da compra.
  for (const [antiga, nova] of trocadas) {
    if (antiga !== nova) await PedidoItem.update({ imagemUrl: nova }, { where: { imagemUrl: antiga } });
  }

  const falhas = [...trocadas].filter(([a, n]) => a === n).length;
  console.log(`✅ ${alterados} produtos atualizados, ${trocadas.size - falhas} imagens copiadas, ${falhas} falhas.`);
};

migrar()
  .then(() => sequelize.close())
  .catch((error) => {
    console.error("❌", error.message);
    process.exit(1);
  });
