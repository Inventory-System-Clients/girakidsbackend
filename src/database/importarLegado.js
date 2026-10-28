// Importa os dados exportados da loja antiga (Firebase) para o banco novo.
//
// Uso: npm run import:legado -- <pasta-com-os-json>
// A pasta deve conter products.json, users.json, suppliers.json,
// carriers.json, orders.json, quotes.json e stock_movements.json (gerados pelo
// script de exportação). Registros já importados (mesmo legadoId) são
// ignorados, então dá pra rodar de novo com uma exportação mais nova.
//
// Senhas não saem do Firebase: os usuários importados recebem uma senha
// aleatória e "trocarSenha" — o admin redefine pelo Gerenciar Usuários (ou o
// usuário usa a senha definida em LEGADO_SENHA_PADRAO, se informada).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { sequelize } from "./connection.js";
import { sincronizarBanco } from "./migrate.js";
import {
  Categoria,
  MovimentacaoEstoque,
  Parceiro,
  Pedido,
  PedidoItem,
  PedidoParcela,
  Produto,
  Usuario,
} from "../models/index.js";
import {
  dadosParceiro,
  dadosPedido,
  dadosProduto,
  dadosUsuario,
  data,
  emailValido,
  itensPedido,
  numerico,
  parcelaPaga,
  situacaoPedido,
} from "../services/legado/mapeamento.js";

const pasta = process.argv[2] || process.env.GIRAKIDS_EXPORT_DIR;
if (!pasta || !fs.existsSync(pasta)) {
  console.error("Informe a pasta com os JSON exportados: npm run import:legado -- <pasta>");
  process.exit(1);
}
const ler = (nome, padrao = []) => {
  const arquivo = path.join(pasta, `${nome}.json`);
  return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, "utf8")) : padrao;
};

const importar = async () => {
  await sincronizarBanco();

  // Parceiros -----------------------------------------------------------------
  const parceiroPorLegado = new Map(
    (await Parceiro.findAll({ attributes: ["id", "legadoId"] })).map((p) => [p.legadoId, p.id]),
  );
  const parceiros = [
    ...ler("suppliers").map((p) => ({ ...p, tipo: "FORNECEDOR" })),
    ...ler("carriers").map((p) => ({ ...p, tipo: "TRANSPORTADORA" })),
  ];
  for (const p of parceiros) {
    if (parceiroPorLegado.has(p.id)) continue;
    const novo = await Parceiro.create(dadosParceiro(p, p.tipo));
    parceiroPorLegado.set(p.id, novo.id);
  }
  console.log(`🤝 Parceiros: ${parceiroPorLegado.size}`);

  // Categorias e produtos -------------------------------------------------------
  const { items: produtosLegado = [], categories = [] } = ler("products", {});
  const nomesCategorias = new Set([...categories, ...produtosLegado.map((p) => p.item_category)].filter(Boolean));
  for (const nome of nomesCategorias) {
    await Categoria.findOrCreate({ where: { nome }, defaults: { nome } });
  }

  const produtoPorLegado = new Map(
    (await Produto.findAll({ attributes: ["id", "legadoId"] })).map((p) => [p.legadoId, p.id]),
  );
  const legadoPorId = new Map(produtosLegado.map((p) => [p.id, p]));
  const novosProdutos = [];
  for (const p of produtosLegado) {
    if (produtoPorLegado.has(p.id)) continue;
    const id = crypto.randomUUID();
    produtoPorLegado.set(p.id, id);
    novosProdutos.push({ id, ...dadosProduto(p, parceiroPorLegado) });
  }
  await Produto.bulkCreate(novosProdutos);
  console.log(`📦 Produtos: ${produtoPorLegado.size} (${novosProdutos.length} novos)`);

  // Usuários ------------------------------------------------------------------
  const usuarioPorEmail = new Map(
    (await Usuario.findAll({ attributes: ["id", "email"] })).map((u) => [u.email, u.id]),
  );
  let usuariosNovos = 0;
  for (const u of ler("users")) {
    const dados = dadosUsuario(u);
    if (!dados.email || usuarioPorEmail.has(dados.email) || !emailValido(dados.email)) continue;
    const novo = await Usuario.create(dados);
    usuarioPorEmail.set(dados.email, novo.id);
    usuariosNovos += 1;
  }
  console.log(`👥 Usuários: ${usuarioPorEmail.size} (${usuariosNovos} novos)`);

  // Pedidos e orçamentos ----------------------------------------------------------
  const pedidoPorLegado = new Map(
    (await Pedido.findAll({ attributes: ["id", "legadoId", "tipo", "numero"] })).map((p) => [`${p.tipo}:${p.legadoId}`, p]),
  );
  const numerosUsados = new Set([...pedidoPorLegado.values()].map((p) => `${p.tipo}:${p.numero}`));

  const importarPedidos = async (lista, tipo) => {
    let novos = 0;
    // Pedidos antigos com código não numérico (ex.: GK-110326-006) recebem
    // números abaixo do menor pedido numérico, do mais novo para o mais
    // antigo, e guardam o código original para exibição e busca.
    const menor = Math.min(...lista.filter(numerico).map((o) => Number(o.order_sequence || o.id)), 100000);
    const numeroAntigo = new Map();
    let proximo = menor - 1;
    for (const o of [...lista].filter((x) => !numerico(x)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
      while (numerosUsados.has(`${tipo}:${proximo}`)) proximo -= 1;
      numeroAntigo.set(o.id, proximo);
      proximo -= 1;
    }
    for (const o of lista) {
      const chave = `${tipo}:${o.id}`;
      if (pedidoPorLegado.has(chave)) continue;
      const numero = numerico(o) ? Number(o.order_sequence || o.id) : numeroAntigo.get(o.id);
      if (!Number.isFinite(numero) || !numero || numerosUsados.has(`${tipo}:${numero}`)) {
        console.warn(`  ⚠️  ${tipo} ${o.id} sem número válido — ignorado`);
        continue;
      }
      numerosUsados.add(`${tipo}:${numero}`);

      const { pago } = situacaoPedido(o);
      const pedido = await sequelize.transaction(async (transaction) => {
        const novo = await Pedido.create(
          dadosPedido(o, {
            tipo,
            numero,
            codigoLegado: numerico(o) ? null : String(o.id).slice(0, 30),
            clienteId: usuarioPorEmail.get(String(o.customer_email || "").toLowerCase()) || null,
            transportadoraId: parceiroPorLegado.get(o.carrier_id) || null,
          }),
          { transaction },
        );
        await PedidoItem.bulkCreate(itensPedido(o, novo.id, { legadoPorId, produtoPorLegado }), { transaction });
        if (pago && Number(novo.total) > 0) await PedidoParcela.create(parcelaPaga(o, novo), { transaction });
        return novo;
      });
      pedidoPorLegado.set(chave, pedido);
      novos += 1;
      if (novos % 250 === 0) console.log(`   ... ${novos} ${tipo.toLowerCase()}s`);
    }
    return novos;
  };

  const orcamentos = ler("quotes");
  console.log(`🧾 Orçamentos novos: ${await importarPedidos(orcamentos, "ORCAMENTO")}`);
  const pedidosLegado = ler("orders");
  console.log(`🛒 Pedidos novos: ${await importarPedidos(pedidosLegado, "PEDIDO")}`);

  // Vínculo orçamento → pedido gerado.
  for (const o of pedidosLegado.filter((x) => x.source_quote_id)) {
    const pedido = pedidoPorLegado.get(`PEDIDO:${o.id}`);
    const orcamento = pedidoPorLegado.get(`ORCAMENTO:${o.source_quote_id}`);
    if (!pedido || !orcamento) continue;
    await Pedido.update({ orcamentoOrigemId: orcamento.id, orcamentoOrigemNumero: orcamento.numero }, { where: { id: pedido.id } });
    await Pedido.update({ pedidoGeradoId: pedido.id, pedidoGeradoNumero: pedido.numero }, { where: { id: orcamento.id } });
  }

  // Movimentações de estoque ------------------------------------------------------
  if ((await MovimentacaoEstoque.count()) === 0) {
    const movimentos = ler("stock_movements").map((m) => ({
      produtoId: produtoPorLegado.get(m.stockItemId) || null,
      produtoNome: m.productName || null,
      produtoSku: m.productSku || null,
      tipo: ["ENTRADA", "SAIDA", "AJUSTE"].includes(m.type) ? m.type : "AJUSTE",
      quantidade: Math.abs(Math.round(Number(m.quantity || 0))),
      quantidadeAnterior: m.previousQuantity ?? null,
      quantidadeNova: m.newQuantity ?? null,
      motivo: m.reason || null,
      pedidoId: m.orderId ? pedidoPorLegado.get(`PEDIDO:${m.orderId}`)?.id || null : null,
      pedidoNumero: m.orderNumber ? String(m.orderNumber) : m.orderId ? String(m.orderId) : null,
      clienteNome: m.customerName || null,
      clienteEmail: m.customerEmail || null,
      usuarioNome: m.userName || null,
      usuarioEmail: m.createdBy || null,
      createdAt: data(m.createdAt) || new Date(),
    }));
    for (let i = 0; i < movimentos.length; i += 1000) {
      await MovimentacaoEstoque.bulkCreate(movimentos.slice(i, i + 1000));
    }
    console.log(`📊 Movimentações de estoque: ${movimentos.length}`);
  }

  console.log("✅ Importação concluída.");
};

importar()
  .then(() => sequelize.close())
  .catch((error) => {
    console.error("❌ Erro na importação:", error);
    process.exit(1);
  });
