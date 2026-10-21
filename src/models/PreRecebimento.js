import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Recebimento de compra (aba Recebimentos). Começa como pré-recebimento: o
// fornecedor informa pelo link quanto vai trazer e a equipe confere na chegada.
// Recebimento direto (sem link) já nasce RECEBIDO.
export const PreRecebimento = sequelize.define(
  "PreRecebimento",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    numero: { type: DataTypes.INTEGER, allowNull: false },
    fornecedorId: { type: DataTypes.UUID, allowNull: true },
    fornecedorNome: { type: DataTypes.STRING(200), allowNull: true },
    // AGUARDANDO_FORNECEDOR, FORNECEDOR_RESPONDEU, RECEBIDO, RECEBIDO_PARCIAL,
    // CANCELADO, ESTORNADO
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "AGUARDANDO_FORNECEDOR" },
    direto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    previsaoEntrega: { type: DataTypes.DATEONLY, allowNull: true },
    observacao: { type: DataTypes.TEXT, allowNull: true },
    // Gerado a partir do que faltou em outro recebimento.
    origemId: { type: DataTypes.UUID, allowNull: true },
    origemNumero: { type: DataTypes.INTEGER, allowNull: true },

    // Link do fornecedor: só o hash (para achar) e uma cópia cifrada (para a
    // equipe copiar de novo). O token em texto nunca fica no banco.
    tokenHash: { type: DataTypes.STRING(64), allowNull: true },
    tokenCifrado: { type: DataTypes.TEXT, allowNull: true },
    linkExpiraEm: { type: DataTypes.DATE, allowNull: true },
    linkAcessadoEm: { type: DataTypes.DATE, allowNull: true },

    // Resposta do fornecedor.
    respondidoEm: { type: DataTypes.DATE, allowNull: true },
    respondidoPor: { type: DataTypes.STRING(150), allowNull: true },
    previsaoFornecedor: { type: DataTypes.DATEONLY, allowNull: true },
    observacaoFornecedor: { type: DataTypes.TEXT, allowNull: true },
    respostaVista: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    recebidoEm: { type: DataTypes.DATE, allowNull: true },
    recebidoPor: { type: DataTypes.STRING(150), allowNull: true },

    // Divergência na conferência (faltou mercadoria): NENHUMA, ABERTA, RESOLVIDA.
    divergenciaStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "NENHUMA" },
    divergenciaDescricao: { type: DataTypes.TEXT, allowNull: true },
    divergenciaSolucao: { type: DataTypes.STRING(30), allowNull: true },
    divergenciaDetalhe: { type: DataTypes.TEXT, allowNull: true },
    divergenciaPrazo: { type: DataTypes.DATEONLY, allowNull: true },
    divergenciaResolvidaEm: { type: DataTypes.DATE, allowNull: true },
    divergenciaResolvidaPor: { type: DataTypes.STRING(150), allowNull: true },
    divergenciaResolucao: { type: DataTypes.TEXT, allowNull: true },

    canceladoEm: { type: DataTypes.DATE, allowNull: true },
    canceladoPor: { type: DataTypes.STRING(150), allowNull: true },
    motivoCancelamento: { type: DataTypes.TEXT, allowNull: true },
    criadoPor: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "pre_recebimentos",
    timestamps: true,
    indexes: [{ fields: ["status"] }, { fields: ["fornecedorId"] }, { fields: ["numero"] }, { unique: true, fields: ["tokenHash"], name: "pre_recebimentos_token_hash" }],
  },
);

export const PreRecebimentoItem = sequelize.define(
  "PreRecebimentoItem",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    preRecebimentoId: { type: DataTypes.UUID, allowNull: false },
    produtoId: { type: DataTypes.UUID, allowNull: false },
    produtoNome: { type: DataTypes.STRING(200), allowNull: true },
    produtoSku: { type: DataTypes.STRING(50), allowNull: true },
    imagemUrl: { type: DataTypes.TEXT, allowNull: true },
    // Para onde vai a mercadoria: SEM_CAPSULA (brinquedo solto, aguarda
    // montagem), CAPSULA (cápsula vazia) ou PRONTO (pronto para venda).
    destino: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PRONTO" },
    quantidadeSolicitada: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    quantidadeFornecedor: { type: DataTypes.INTEGER, allowNull: true },
    observacaoFornecedor: { type: DataTypes.TEXT, allowNull: true },
    quantidadeRecebida: { type: DataTypes.INTEGER, allowNull: true },
    custoUnitario: { type: DataTypes.DECIMAL(12, 4), allowNull: true },
  },
  {
    tableName: "pre_recebimento_itens",
    timestamps: false,
    indexes: [{ fields: ["preRecebimentoId"] }, { fields: ["produtoId"] }],
  },
);

// Lote enviado para montagem (fechar as cápsulas com os brinquedos). Os
// brinquedos e as cápsulas já saíram dos saldos; concluir passa para "montado".
export const OrdemMontagem = sequelize.define(
  "OrdemMontagem",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    produtoId: { type: DataTypes.UUID, allowNull: false },
    produtoNome: { type: DataTypes.STRING(200), allowNull: true },
    quantidade: { type: DataTypes.INTEGER, allowNull: false },
    quantidadeConcluida: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    quantidadeCancelada: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Cápsulas consumidas: [{ produtoId, nome, quantidade }]
    capsulas: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    // EM_MONTAGEM, CONCLUIDA, CANCELADA
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "EM_MONTAGEM" },
    observacao: { type: DataTypes.TEXT, allowNull: true },
    enviadoPor: { type: DataTypes.STRING(150), allowNull: true },
    concluidaEm: { type: DataTypes.DATE, allowNull: true },
    concluidaPor: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "ordens_montagem",
    timestamps: true,
    indexes: [{ fields: ["status"] }, { fields: ["produtoId"] }],
  },
);
