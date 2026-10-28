import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Pedido e orçamento ficam na mesma tabela (tipo). Cada pedido anda em três
// trilhas independentes, como na loja original:
//   Time Financeiro: AGUARDANDO_PAGAMENTO → PAGO (ou CANCELADO)
//   Time Vendas:     AGUARDANDO → LIBERADO (ou CANCELADO)
//   Time Expedição:  NAO_INICIADO → MONTAGEM → EXPEDIDO
// "Atrasado" é derivado (parcela em aberto com vencimento passado).
export const Pedido = sequelize.define(
  "Pedido",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tipo: {
      type: DataTypes.ENUM("PEDIDO", "ORCAMENTO"),
      allowNull: false,
      defaultValue: "PEDIDO",
    },
    // Sequencial por tipo (pedido 63037, orçamento 0065).
    numero: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    // Cliente
    clienteId: { type: DataTypes.UUID, allowNull: true },
    clienteNome: { type: DataTypes.STRING(150), allowNull: false },
    clienteEmail: { type: DataTypes.STRING(150), allowNull: true },
    clienteTelefone: { type: DataTypes.STRING(30), allowNull: true },
    documentoTipo: { type: DataTypes.STRING(4), allowNull: true },
    documento: { type: DataTypes.STRING(20), allowNull: true },
    origemCliente: {
      type: DataTypes.ENUM("ADMIN", "CLIENTE"),
      allowNull: false,
      defaultValue: "CLIENTE",
    },

    // Entrega
    cep: { type: DataTypes.STRING(9), allowNull: true },
    rua: { type: DataTypes.STRING(150), allowNull: true },
    numeroEndereco: { type: DataTypes.STRING(20), allowNull: true },
    complemento: { type: DataTypes.STRING(100), allowNull: true },
    bairro: { type: DataTypes.STRING(100), allowNull: true },
    cidade: { type: DataTypes.STRING(100), allowNull: true },
    estado: { type: DataTypes.STRING(2), allowNull: true },
    metodoEnvio: {
      // RETIRAR_LOCAL | TRANSPORTADORA | PAC | SEDEX
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    frete: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    freteAdicional: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    prazoEntregaDias: { type: DataTypes.INTEGER, allowNull: true },
    pesoTotalGramas: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    observacoes: { type: DataTypes.TEXT, allowNull: true },

    // Valores
    subtotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    desconto: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    taxas: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    creditoUsado: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },

    // Pagamento
    formaPagamento: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: "A_DEFINIR",
    },
    parcelasCartao: { type: DataTypes.INTEGER, allowNull: true },
    // Mescla de pagamentos: [{ metodo, valor, vencimento }]
    composicaoPagamento: { type: DataTypes.JSONB, allowNull: true },
    // Integração com o banco/gateway escolhido (src/services/pagamentos).
    pagamentoProvedor: { type: DataTypes.STRING(40), allowNull: true },
    pagamentoReferencia: { type: DataTypes.STRING(150), allowNull: true },
    pagamentoLink: { type: DataTypes.TEXT, allowNull: true },
    pagamentoQrCode: { type: DataTypes.TEXT, allowNull: true },
    pagamentoExpiraEm: { type: DataTypes.DATE, allowNull: true },

    // Time Financeiro
    statusFinanceiro: {
      type: DataTypes.ENUM("AGUARDANDO_PAGAMENTO", "PAGO", "CANCELADO"),
      allowNull: false,
      defaultValue: "AGUARDANDO_PAGAMENTO",
    },
    pagoEm: { type: DataTypes.DATE, allowNull: true },
    pagoPor: { type: DataTypes.STRING(150), allowNull: true },
    // Pendência financeira aberta ao liberar um pedido ainda não pago.
    pendenciaStatus: {
      type: DataTypes.ENUM("ABERTA", "QUITADA"),
      allowNull: true,
    },
    pendenciaValor: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    pendenciaAbertaEm: { type: DataTypes.DATE, allowNull: true },
    pendenciaAbertaPor: { type: DataTypes.STRING(150), allowNull: true },
    pendenciaQuitadaEm: { type: DataTypes.DATE, allowNull: true },
    pendenciaQuitadaPor: { type: DataTypes.STRING(150), allowNull: true },
    observacaoQuitacao: { type: DataTypes.TEXT, allowNull: true },

    // Time Vendas
    statusVendas: {
      type: DataTypes.ENUM("AGUARDANDO", "LIBERADO", "CANCELADO"),
      allowNull: false,
      defaultValue: "AGUARDANDO",
    },
    liberadoEm: { type: DataTypes.DATE, allowNull: true },
    liberadoPor: { type: DataTypes.STRING(150), allowNull: true },
    observacaoLiberacao: { type: DataTypes.TEXT, allowNull: true },
    estoqueBaixado: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    // Time Expedição
    statusExpedicao: {
      type: DataTypes.ENUM("NAO_INICIADO", "MONTAGEM", "EXPEDIDO"),
      allowNull: false,
      defaultValue: "NAO_INICIADO",
    },
    expedidoEm: { type: DataTypes.DATE, allowNull: true },
    expedidoPor: { type: DataTypes.STRING(150), allowNull: true },
    observacoesExpedicao: { type: DataTypes.TEXT, allowNull: true },
    imagemExpedicaoUrl: { type: DataTypes.TEXT, allowNull: true },
    // Montagem: concluída quando todos os itens foram conferidos e a pessoa
    // confirmou "Concluir montagem".
    montagemConcluidaEm: { type: DataTypes.DATE, allowNull: true },
    montagemConcluidaPor: { type: DataTypes.STRING(150), allowNull: true },
    // Fotos do pedido embalado e da entrega/coleta na transportadora.
    imagensExpedicao: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    imagensTransportadora: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

    // Transportadora e nota fiscal
    transportadoraId: { type: DataTypes.UUID, allowNull: true },
    transportadoraNome: { type: DataTypes.STRING(200), allowNull: true },
    transportadoraObs: { type: DataTypes.TEXT, allowNull: true },
    // Cotação do frete com a transportadora (opcionais).
    transportadoraCotacao: { type: DataTypes.STRING(60), allowNull: true },
    transportadoraCotacaoCom: { type: DataTypes.STRING(150), allowNull: true },
    notaFiscalNumero: { type: DataTypes.STRING(50), allowNull: true },
    notaFiscalUrl: { type: DataTypes.TEXT, allowNull: true },
    // Etiqueta dos Correios (preenchida ao postar pela aba Comercial → Correios).
    codigoRastreio: { type: DataTypes.STRING(30), allowNull: true },

    // Cancelamento
    canceladoEm: { type: DataTypes.DATE, allowNull: true },
    canceladoPor: { type: DataTypes.STRING(150), allowNull: true },
    motivoCancelamento: { type: DataTypes.TEXT, allowNull: true },

    // Orçamento ⇄ pedido
    orcamentoOrigemId: { type: DataTypes.UUID, allowNull: true },
    orcamentoOrigemNumero: { type: DataTypes.INTEGER, allowNull: true },
    pedidoGeradoId: { type: DataTypes.UUID, allowNull: true },
    pedidoGeradoNumero: { type: DataTypes.INTEGER, allowNull: true },

    // Eventos: alterações de pagamento, correções, etc.
    historico: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    criadoPorId: { type: DataTypes.UUID, allowNull: true },
    criadoPorNome: { type: DataTypes.STRING(150), allowNull: true },
    criadoPorRole: { type: DataTypes.STRING(20), allowNull: true },
    legadoId: { type: DataTypes.STRING(100), allowNull: true },
    // Sincronização com o sistema antigo: assinatura do andamento lá (pagamento,
    // liberação, expedição...) na última leitura.
    legadoAssinatura: { type: DataTypes.STRING(40), allowNull: true },
    // Pedido feito pelo próprio cliente no site: alerta o comercial até alguém
    // marcar como visto.
    alertaComercial: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    alertaVistoEm: { type: DataTypes.DATE, allowNull: true },
    alertaVistoPor: { type: DataTypes.STRING(150), allowNull: true },
    // Código antigo não numérico (ex.: GK-110326-006), exibido no lugar do número.
    // Também usado quando o número do sistema antigo já existia aqui (ex.:
    // "63127-ANT"); o pedido fica com número interno a partir de 900000.
    codigoLegado: { type: DataTypes.STRING(30), allowNull: true },
  },
  {
    tableName: "pedidos",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["tipo", "numero"] },
      { fields: ["createdAt"] },
      { fields: ["legadoId"] },
      { fields: ["expedidoEm"] },
      { fields: ["clienteId"] },
    ],
  },
);

export const PedidoItem = sequelize.define(
  "PedidoItem",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    pedidoId: { type: DataTypes.UUID, allowNull: false },
    produtoId: { type: DataTypes.UUID, allowNull: true },
    // Fotografia do produto no momento do pedido.
    nome: { type: DataTypes.STRING(200), allowNull: false },
    sku: { type: DataTypes.STRING(50), allowNull: true },
    categoria: { type: DataTypes.STRING(100), allowNull: true },
    imagemUrl: { type: DataTypes.TEXT, allowNull: true },
    unidadesPacote: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    // Quantidade em pacotes; preço por unidade.
    quantidade: { type: DataTypes.INTEGER, allowNull: false },
    precoUnitario: { type: DataTypes.DECIMAL(12, 4), allowNull: false },
    custoUnitario: { type: DataTypes.DECIMAL(12, 4), allowNull: true },
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    pesoGramas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sobEncomenda: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Checklist de montagem
    conferido: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    conferidoEm: { type: DataTypes.DATE, allowNull: true },
    conferidoPor: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "pedido_itens",
    timestamps: false,
    indexes: [{ fields: ["pedidoId"] }, { fields: ["produtoId"] }],
  },
);

// Recebimentos/parcelas do Time Financeiro (controle de parcelas, mescla de
// pagamentos e recebimentos manuais).
export const PedidoParcela = sequelize.define(
  "PedidoParcela",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    pedidoId: { type: DataTypes.UUID, allowNull: false },
    numero: { type: DataTypes.INTEGER, allowNull: false },
    valor: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    metodoPrevisto: { type: DataTypes.STRING(30), allowNull: true },
    metodoRecebido: { type: DataTypes.STRING(30), allowNull: true },
    vencimento: { type: DataTypes.DATEONLY, allowNull: true },
    status: {
      type: DataTypes.ENUM("ABERTA", "RECEBIDA", "CANCELADA"),
      allowNull: false,
      defaultValue: "ABERTA",
    },
    recebidaEm: { type: DataTypes.DATEONLY, allowNull: true },
    observacao: { type: DataTypes.TEXT, allowNull: true },
    usuarioNome: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "pedido_parcelas",
    timestamps: true,
    indexes: [{ fields: ["pedidoId"] }],
  },
);
