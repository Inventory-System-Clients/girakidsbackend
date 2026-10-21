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
import { separarEndereco } from "../utils/endereco.js";
import { arredondar, somenteDigitos } from "../utils/helpers.js";

const pasta = process.argv[2] || process.env.GIRAKIDS_EXPORT_DIR;
if (!pasta || !fs.existsSync(pasta)) {
  console.error("Informe a pasta com os JSON exportados: npm run import:legado -- <pasta>");
  process.exit(1);
}
const ler = (nome, padrao = []) => {
  const arquivo = path.join(pasta, `${nome}.json`);
  return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, "utf8")) : padrao;
};

const data = (valor) => (valor ? new Date(valor) : null);
const iso = (valor) => (valor ? new Date(valor).toISOString().slice(0, 10) : null);

const FORMA_PAGAMENTO = (metodo, checkout) => {
  if (metodo === "GETNET_ONLINE") {
    return { PIX: "PIX_ONLINE", CREDITO: "CREDITO_ONLINE", DEBITO: "DEBITO_ONLINE" }[checkout] || "PIX_ONLINE";
  }
  return (
    {
      PIX: "PIX_ONLINE",
      CARTAO_CREDITO: "CREDITO_ONLINE",
      CARTAO_DEBITO: "DEBITO_ONLINE",
      CARTAO_CREDITO_LINK: "CREDITO_LINK",
      REDE_ONLINE: "LINK_PAGAMENTO",
      LINK_PAGAMENTO_REDE: "LINK_PAGAMENTO",
      MAQUININHA_REDE: "MAQUININHA",
      MAQUININHA_GETNET: "MAQUININHA",
      PAGAMENTO_MISTO: "MESCLA",
      "TRANSFERENCIA BANCARIA": "TRANSFERENCIA",
    }[metodo] ||
    (["A_DEFINIR", "DINHEIRO", "PERMUTA", "BOLETO", "PIX_PRESENCIAL", "CHEQUE", "A_RECEBER"].includes(metodo)
      ? metodo
      : "A_DEFINIR")
  );
};

const METODO_ENVIO = {
  RETIRAR_LOCAL: "RETIRAR_LOCAL",
  PAC: "PAC",
  SEDEX: "SEDEX",
  TRANSPORTADORA_PARCEIRA: "TRANSPORTADORA",
};

const ROLE = { ADMIN: "ADMIN", EMPLOYEE: "FUNCIONARIO", CUSTOMER: "CLIENTE" };

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
    const novo = await Parceiro.create({
      tipo: p.tipo,
      nome: String(p.name || "").trim() || "Sem nome",
      documento: p.document || null,
      contato: p.contactName || null,
      telefone: p.phone || null,
      email: p.email || null,
      cidade: p.city || null,
      estado: p.state || null,
      observacoes: p.notes || null,
      ativo: p.isActive !== false,
      criadoPor: p.createdBy || null,
      legadoId: p.id,
      createdAt: data(p.createdAt) || new Date(),
    });
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
  const custoPorProduto = new Map();
  const legadoPorId = new Map(produtosLegado.map((p) => [p.id, p]));
  const novosProdutos = [];
  for (const p of produtosLegado) {
    const custo = p.missingCost || p.cost_price == null ? null : Number(p.cost_price);
    custoPorProduto.set(p.id, custo);
    if (produtoPorLegado.has(p.id)) continue;
    const id = crypto.randomUUID();
    produtoPorLegado.set(p.id, id);
    novosProdutos.push({
      id,
      sku: String(p.sku || p.id),
      nome: p.item_name || "Sem nome",
      descricao: p.item_description || null,
      categoria: p.item_category || null,
      tipo: p.product_type === "COMPOSTO" ? "COMPOSTO" : "SIMPLES",
      modoVenda: p.selling_mode === "ON_DEMAND" ? "ENCOMENDA" : "PADRAO",
      precoVenda: Number(p.item_price || 0),
      custo,
      unidadesPacote: Number(p.package_units || 1),
      pesoPacoteGramas: Math.round(Number(p.package_weight || 0)),
      tipoEmbalagem: p.packing_type || null,
      estoque: Math.round(Number(p.stock_quantity || 0)),
      estoqueMinimo: p.min_quantity == null ? null : Number(p.min_quantity),
      fornecedorPreferencialId: parceiroPorLegado.get(p.preferred_supplier_id) || null,
      observacoesCompra: p.purchase_notes || null,
      imagemUrl: p.instock_image_url || null,
      imagens: p.instock_image_url ? [p.instock_image_url] : [],
      imagemSemEstoqueUrl: p.outofstock_image_url || null,
      destaque: Boolean(p.catalog_featured),
      arquivado: Boolean(p.excluded),
      criadoPor: p.created_by || null,
      atualizadoPor: p.modified_by || null,
      legadoId: p.id,
      createdAt: data(p.created_date) || new Date(),
    });
  }
  await Produto.bulkCreate(novosProdutos);
  console.log(`📦 Produtos: ${produtoPorLegado.size} (${novosProdutos.length} novos)`);

  // Usuários ------------------------------------------------------------------
  const usuarioPorEmail = new Map(
    (await Usuario.findAll({ attributes: ["id", "email"] })).map((u) => [u.email, u.id]),
  );
  const senhaPadrao = process.env.LEGADO_SENHA_PADRAO;
  let usuariosNovos = 0;
  for (const u of ler("users")) {
    const email = String(u.email || u.id || "").trim().toLowerCase();
    if (!email || usuarioPorEmail.has(email) || !/^\S+@\S+\.\S+$/.test(email)) continue;
    const role = ROLE[u.role] || "CLIENTE";
    const novo = await Usuario.create({
      nome: u.full_name || email,
      email,
      senha: senhaPadrao || crypto.randomBytes(12).toString("base64url"),
      trocarSenha: true,
      role,
      permissoes: role === "FUNCIONARIO" ? ["CHECKOUT", "VENDAS", "EXPEDICAO", "PRODUTOS", "ORCAMENTOS"] : [],
      outrosPagamentos: Boolean(u.cashPaymentEnabled),
      credito: Number(u.customerCreditBalance || 0),
      legadoId: u.id,
      createdAt: data(u.created_at) || new Date(),
    });
    usuarioPorEmail.set(email, novo.id);
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
    const numerico = (o) => /^\d+$/.test(String(o.order_sequence || o.id));
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

      const cancelado = o.status === "CANCELADO" || o.sales_status === "CANCELADO";
      // Pedidos do fluxo antigo (sem sales_status) não tinham trilha
      // financeira: "pagamento confirmado/enviado/NF gerada" já era pago.
      const pago = !cancelado && Boolean(
        o.paid_at ||
          o.financial_pending_status === "SETTLED" ||
          (!o.sales_status && ["PAGAMENTO CONFIRMADO", "ENVIADO", "NF GERADA"].includes(o.status)),
      );
      const liberado = o.sales_status === "LIBERADO" || (!o.sales_status && ["ENVIADO", "PAGAMENTO CONFIRMADO", "NF GERADA"].includes(o.status));
      const expedicao = { shipped: "EXPEDIDO", assembling: "MONTAGEM", separating: "MONTAGEM" }[o.logistics_status_effective] || "NAO_INICIADO";
      const endereco = separarEndereco(o.delivery_address);
      const documento = somenteDigitos(o.document_number);
      const total = Number(o.total_amount || 0);
      const checklist = new Map((o.checklist_items || []).map((c) => [c.product_id, c]));
      const transportadoraId = parceiroPorLegado.get(o.carrier_id) || null;

      const pedido = await sequelize.transaction(async (transaction) => {
        const novo = await Pedido.create(
          {
            tipo,
            numero,
            clienteId: usuarioPorEmail.get(String(o.customer_email || "").toLowerCase()) || null,
            clienteNome: o.customer_name || "Sem nome",
            clienteEmail: o.customer_email || null,
            clienteTelefone: o.customer_phone || null,
            documentoTipo: documento.length === 14 ? "CNPJ" : documento.length === 11 ? "CPF" : null,
            documento: documento || null,
            origemCliente: o.user_type === "CUSTOMER" ? "CLIENTE" : "ADMIN",
            cep: somenteDigitos(o.delivery_cep) || null,
            rua: endereco.logradouro || null,
            numeroEndereco: endereco.numero || null,
            complemento: endereco.complemento || null,
            bairro: o.delivery_neighborhood || null,
            cidade: o.delivery_city || null,
            estado: String(o.delivery_state || "").toUpperCase().slice(0, 2) || null,
            metodoEnvio: METODO_ENVIO[o.shipping_method] || null,
            frete: Number(o.shipping_cost || 0),
            freteAdicional: Number(o.shipping_additional_cost || 0),
            prazoEntregaDias: o.shipping_delivery_days || null,
            pesoTotalGramas: Math.round(Number(o.total_weight || 0)),
            observacoes:
              typeof o.observations === "string"
                ? o.observations
                : o.observations
                  ? Object.values(o.observations).filter((v) => typeof v === "string" && v.trim()).join(" | ")
                  : null,
            subtotal: Number(o.subtotal || 0),
            desconto: Number(o.subtotal_discount || 0),
            taxas: Number(o.fees || 0),
            total,
            formaPagamento: FORMA_PAGAMENTO(o.payment_method, o.getnet_checkout_method),
            parcelasCartao: o.credit_option ? Number(String(o.credit_option).replace(/\D/g, "")) || null : null,
            statusFinanceiro: cancelado ? "CANCELADO" : pago ? "PAGO" : "AGUARDANDO_PAGAMENTO",
            pagoEm: pago ? data(o.paid_at || o.financial_pending_settled_at) : null,
            pagoPor: pago ? o.payment_confirmed_by || o.financial_pending_settled_by || null : null,
            pendenciaStatus: o.financial_pending_status === "OPEN" ? "ABERTA" : o.financial_pending_status === "SETTLED" ? "QUITADA" : null,
            pendenciaValor: o.financial_pending_amount ?? null,
            pendenciaAbertaEm: data(o.financial_pending_created_at),
            pendenciaAbertaPor: o.financial_pending_created_by || null,
            pendenciaQuitadaEm: data(o.financial_pending_settled_at),
            pendenciaQuitadaPor: o.financial_pending_settled_by || null,
            observacaoQuitacao: o.financial_pending_settlement_notes || null,
            statusVendas: cancelado ? "CANCELADO" : liberado ? "LIBERADO" : "AGUARDANDO",
            liberadoEm: data(o.sales_released_at),
            liberadoPor: o.sales_released_by_name || o.sales_released_by_email || null,
            observacaoLiberacao: o.financial_pending_notes || null,
            estoqueBaixado: Boolean(o.stock_reduced) && !cancelado,
            statusExpedicao: cancelado ? "NAO_INICIADO" : expedicao,
            expedidoEm: expedicao === "EXPEDIDO" ? data(o.shipped_at || o.updated_at || o.created_at) : null,
            expedidoPor: o.shipped_by_name || o.shipped_by_email || null,
            observacoesExpedicao: o.logistics_observations || null,
            imagemExpedicaoUrl: o.logistics_image_url || null,
            imagensExpedicao: o.logistics_image_url ? [o.logistics_image_url] : [],
            montagemConcluidaEm: expedicao === "EXPEDIDO" ? data(o.shipped_at || o.updated_at || o.created_at) : null,
            montagemConcluidaPor: expedicao === "EXPEDIDO" ? o.shipped_by_name || o.shipped_by_email || null : null,
            transportadoraId,
            transportadoraNome: o.carrier_name_snapshot || null,
            transportadoraObs: o.carrier_observations || null,
            notaFiscalNumero: o.invoice_number || null,
            notaFiscalUrl: o.invoice_pdf_url || null,
            canceladoEm: cancelado ? data(o.cancelled_at || o.updated_at) : null,
            motivoCancelamento: cancelado ? o.cancelled_reason || null : null,
            historico: (o.payment_method_changes || []).map((m) => ({
              tipo: "FORMA_PAGAMENTO",
              de: FORMA_PAGAMENTO(m.previous_payment_method),
              para: FORMA_PAGAMENTO(m.new_payment_method),
              totalAnterior: m.previous_total_amount,
              totalNovo: m.new_total_amount,
              por: m.changed_by,
              em: m.changed_at,
            })),
            criadoPorNome: o.created_by_name || null,
            criadoPorRole: o.created_by_role ? ROLE[o.created_by_role] || o.created_by_role : null,
            legadoId: String(o.id),
            codigoLegado: numerico(o) ? null : String(o.id).slice(0, 30),
            createdAt: data(o.created_at) || new Date(),
          },
          { transaction },
        );

        await PedidoItem.bulkCreate(
          (o.order_items || []).map((item) => {
            const conferencia = checklist.get(item.product_id);
            // Pedidos antigos não guardavam a "foto" do produto: usa o cadastro.
            const cadastro = legadoPorId.get(item.product_id) || {};
            const unidades = Number(item.package_units_snapshot || cadastro.package_units || 1);
            const quantidade = Number(item.quantity || 0);
            const precoUnitario = Number(item.unit_price ?? cadastro.item_price ?? 0);
            return {
              pedidoId: novo.id,
              produtoId: produtoPorLegado.get(item.product_id) || null,
              nome: item.product_name_snapshot || cadastro.item_name || conferencia?.product_name || "Produto",
              sku: cadastro.sku || null,
              categoria: item.product_category_snapshot || cadastro.item_category || null,
              imagemUrl: conferencia?.product_image || null,
              unidadesPacote: unidades,
              quantidade,
              precoUnitario,
              custoUnitario: custoPorProduto.get(item.product_id) ?? null,
              total: arredondar(Number(item.line_total_snapshot ?? quantidade * precoUnitario * unidades)),
              pesoGramas: Math.round(quantidade * Number(cadastro.package_weight || 0)),
              sobEncomenda: Boolean(item.on_demand_snapshot),
              conferido: expedicao === "EXPEDIDO" || Boolean(conferencia?.checked),
              conferidoEm: data(conferencia?.checked_at),
              conferidoPor: conferencia?.checked_by || null,
            };
          }),
          { transaction },
        );

        if (pago && total > 0) {
          await PedidoParcela.create(
            {
              pedidoId: novo.id,
              numero: 1,
              valor: arredondar(total),
              metodoPrevisto: novo.formaPagamento,
              metodoRecebido: novo.formaPagamento,
              vencimento: iso(o.paid_at || o.created_at),
              recebidaEm: iso(o.paid_at || o.financial_pending_settled_at || o.created_at),
              status: "RECEBIDA",
              usuarioNome: novo.pagoPor || "Importação",
            },
            { transaction },
          );
        }
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
