// Tradução dos registros da loja antiga (Krion/Firebase) para o banco novo.
// Usado pela importação de arquivos (npm run import:legado) e pela
// sincronização contínua (sincronizacaoLegadoService).
import crypto from "crypto";
import { separarEndereco } from "../../utils/endereco.js";
import { arredondar, somenteDigitos } from "../../utils/helpers.js";

export const data = (valor) => (valor ? new Date(valor) : null);
export const iso = (valor) => (valor ? new Date(valor).toISOString().slice(0, 10) : null);

export const FORMA_PAGAMENTO = (metodo, checkout) => {
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

export const METODO_ENVIO = {
  RETIRAR_LOCAL: "RETIRAR_LOCAL",
  PAC: "PAC",
  SEDEX: "SEDEX",
  TRANSPORTADORA_PARCEIRA: "TRANSPORTADORA",
};

export const ROLE = { ADMIN: "ADMIN", EMPLOYEE: "FUNCIONARIO", CUSTOMER: "CLIENTE" };

export const emailValido = (email) => /^\S+@\S+\.\S+$/.test(email);

// Parceiros ------------------------------------------------------------------

export const dadosParceiro = (p, tipo) => ({
  tipo,
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

// Produtos -------------------------------------------------------------------

export const custoLegado = (p) => (p.missingCost || p.cost_price == null ? null : Number(p.cost_price));
export const estoqueLegado = (p) => Math.round(Number(p.stock_quantity || 0));

export const dadosProduto = (p, parceiroPorLegado = new Map()) => ({
  sku: String(p.sku || p.id),
  nome: p.item_name || "Sem nome",
  descricao: p.item_description || null,
  categoria: p.item_category || null,
  tipo: p.product_type === "COMPOSTO" ? "COMPOSTO" : "SIMPLES",
  modoVenda: p.selling_mode === "ON_DEMAND" ? "ENCOMENDA" : "PADRAO",
  precoVenda: Number(p.item_price || 0),
  custo: custoLegado(p),
  unidadesPacote: Number(p.package_units || 1),
  pesoPacoteGramas: Math.round(Number(p.package_weight || 0)),
  tipoEmbalagem: p.packing_type || null,
  estoque: estoqueLegado(p),
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

// Usuários -------------------------------------------------------------------

// Senhas não saem do Firebase: o usuário recebe uma senha aleatória (ou a de
// LEGADO_SENHA_PADRAO) e "trocarSenha"; o admin redefine pelo Gerenciar Usuários.
export const dadosUsuario = (u) => {
  const email = String(u.email || u.id || "").trim().toLowerCase();
  const role = ROLE[u.role] || "CLIENTE";
  return {
    nome: u.full_name || email,
    email,
    senha: process.env.LEGADO_SENHA_PADRAO || crypto.randomBytes(12).toString("base64url"),
    trocarSenha: true,
    role,
    permissoes: role === "FUNCIONARIO" ? ["CHECKOUT", "VENDAS", "EXPEDICAO", "PRODUTOS", "ORCAMENTOS"] : [],
    outrosPagamentos: Boolean(u.cashPaymentEnabled),
    credito: Number(u.customerCreditBalance || 0),
    legadoId: u.id,
    createdAt: data(u.created_at) || new Date(),
  };
};

// Pedidos e orçamentos ---------------------------------------------------------

// Pedido antigo com código não numérico (ex.: GK-110326-006).
export const numerico = (o) => /^\d+$/.test(String(o.order_sequence || o.id));
export const numeroLegado = (o) => (numerico(o) ? Number(o.order_sequence || o.id) : null);

export const situacaoPedido = (o) => {
  const cancelado = o.status === "CANCELADO" || o.sales_status === "CANCELADO";
  // Pedidos do fluxo antigo (sem sales_status) não tinham trilha financeira:
  // "pagamento confirmado/enviado/NF gerada" já era pago.
  const pago =
    !cancelado &&
    Boolean(
      o.paid_at ||
        o.financial_pending_status === "SETTLED" ||
        (!o.sales_status && ["PAGAMENTO CONFIRMADO", "ENVIADO", "NF GERADA"].includes(o.status)),
    );
  const liberado = o.sales_status === "LIBERADO" || (!o.sales_status && ["ENVIADO", "PAGAMENTO CONFIRMADO", "NF GERADA"].includes(o.status));
  const expedicao = { shipped: "EXPEDIDO", assembling: "MONTAGEM", separating: "MONTAGEM" }[o.logistics_status_effective] || "NAO_INICIADO";
  return { cancelado, pago, liberado, expedicao };
};

// Campos do pedido que mudam com o andamento lá no sistema antigo (pagamento,
// liberação, expedição, nota, cancelamento). A sincronização compara esta
// assinatura para saber se precisa atualizar.
export const assinaturaPedido = (o) =>
  crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        o.status,
        o.sales_status,
        o.logistics_status_effective,
        o.paid_at,
        o.financial_pending_status,
        o.financial_pending_amount,
        o.stock_reduced,
        o.invoice_number,
        o.invoice_pdf_url,
        o.carrier_id,
        o.shipped_at,
        o.logistics_image_url,
        o.cancelled_reason,
      ]),
    )
    .digest("hex");

const observacoes = (o) =>
  typeof o.observations === "string"
    ? o.observations
    : o.observations
      ? Object.values(o.observations).filter((v) => typeof v === "string" && v.trim()).join(" | ")
      : null;

// Andamento (o que a sincronização atualiza num pedido que já existe).
export const andamentoPedido = (o, { transportadoraId = null } = {}) => {
  const { cancelado, pago, liberado, expedicao } = situacaoPedido(o);
  return {
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
    canceladoEm: cancelado ? data(o.cancelled_at || o.updated_at || new Date()) : null,
    motivoCancelamento: cancelado ? o.cancelled_reason || null : null,
  };
};

export const dadosPedido = (o, { tipo, numero, codigoLegado = null, clienteId = null, transportadoraId = null }) => {
  const endereco = separarEndereco(o.delivery_address);
  const documento = somenteDigitos(o.document_number);
  return {
    tipo,
    numero,
    clienteId,
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
    observacoes: observacoes(o),
    subtotal: Number(o.subtotal || 0),
    desconto: Number(o.subtotal_discount || 0),
    taxas: Number(o.fees || 0),
    total: Number(o.total_amount || 0),
    formaPagamento: FORMA_PAGAMENTO(o.payment_method, o.getnet_checkout_method),
    parcelasCartao: o.credit_option ? Number(String(o.credit_option).replace(/\D/g, "")) || null : null,
    ...andamentoPedido(o, { transportadoraId }),
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
    codigoLegado,
    createdAt: data(o.created_at) || new Date(),
  };
};

// legadoPorId: cadastro do produto no sistema antigo (pedidos antigos não
// guardavam a "foto" do produto).
export const itensPedido = (o, pedidoId, { legadoPorId, produtoPorLegado }) => {
  const { expedicao } = situacaoPedido(o);
  const checklist = new Map((o.checklist_items || []).map((c) => [c.product_id, c]));
  return (o.order_items || []).map((item) => {
    const conferencia = checklist.get(item.product_id);
    const cadastro = legadoPorId.get(item.product_id) || {};
    const unidades = Number(item.package_units_snapshot || cadastro.package_units || 1);
    const quantidade = Number(item.quantity || 0);
    const precoUnitario = Number(item.unit_price ?? cadastro.item_price ?? 0);
    return {
      pedidoId,
      produtoId: produtoPorLegado.get(item.product_id) || null,
      nome: item.product_name_snapshot || cadastro.item_name || conferencia?.product_name || "Produto",
      sku: cadastro.sku || null,
      categoria: item.product_category_snapshot || cadastro.item_category || null,
      imagemUrl: conferencia?.product_image || null,
      unidadesPacote: unidades,
      quantidade,
      precoUnitario,
      custoUnitario: cadastro.id ? custoLegado(cadastro) : null,
      total: arredondar(Number(item.line_total_snapshot ?? quantidade * precoUnitario * unidades)),
      pesoGramas: Math.round(quantidade * Number(cadastro.package_weight || 0)),
      sobEncomenda: Boolean(item.on_demand_snapshot),
      conferido: expedicao === "EXPEDIDO" || Boolean(conferencia?.checked),
      conferidoEm: data(conferencia?.checked_at),
      conferidoPor: conferencia?.checked_by || null,
    };
  });
};

// Pedido pago no sistema antigo vira uma parcela já recebida.
export const parcelaPaga = (o, pedido) => ({
  pedidoId: pedido.id,
  numero: 1,
  valor: arredondar(Number(pedido.total)),
  metodoPrevisto: pedido.formaPagamento,
  metodoRecebido: pedido.formaPagamento,
  vencimento: iso(o.paid_at || o.created_at),
  recebidaEm: iso(o.paid_at || o.financial_pending_settled_at || o.created_at),
  status: "RECEBIDA",
  usuarioNome: pedido.pagoPor || "Importação",
});
