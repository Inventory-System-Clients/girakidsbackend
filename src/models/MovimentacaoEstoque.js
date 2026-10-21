import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Auditoria de estoque: toda entrada (recebimento, cancelamento), saída
// (venda liberada) e ajuste manual fica registrada com antes → depois.
const MovimentacaoEstoque = sequelize.define(
  "MovimentacaoEstoque",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    produtoId: { type: DataTypes.UUID, allowNull: true },
    produtoNome: { type: DataTypes.STRING(200), allowNull: true },
    produtoSku: { type: DataTypes.STRING(50), allowNull: true },
    tipo: {
      type: DataTypes.ENUM("ENTRADA", "SAIDA", "AJUSTE"),
      allowNull: false,
    },
    quantidade: { type: DataTypes.INTEGER, allowNull: false },
    quantidadeAnterior: { type: DataTypes.INTEGER, allowNull: true },
    quantidadeNova: { type: DataTypes.INTEGER, allowNull: true },
    motivo: { type: DataTypes.TEXT, allowNull: true },
    pedidoId: { type: DataTypes.UUID, allowNull: true },
    pedidoNumero: { type: DataTypes.STRING(50), allowNull: true },
    clienteNome: { type: DataTypes.STRING(150), allowNull: true },
    clienteEmail: { type: DataTypes.STRING(150), allowNull: true },
    usuarioNome: { type: DataTypes.STRING(150), allowNull: true },
    // Saldo alterado quando não é o estoque do catálogo: MONTADO, EM_MONTAGEM
    // ou SEM_CAPSULA (produtos com montagem em cápsula).
    saldo: { type: DataTypes.STRING(20), allowNull: true },
    // Tela que gerou o movimento (ex.: RECEBIMENTOS).
    origem: { type: DataTypes.STRING(30), allowNull: true },
    usuarioEmail: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "movimentacoes_estoque",
    timestamps: true,
    updatedAt: false,
    indexes: [{ fields: ["produtoId"] }, { fields: ["createdAt"] }],
  },
);

export default MovimentacaoEstoque;
