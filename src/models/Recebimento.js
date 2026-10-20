import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Entrada de mercadoria de um fornecedor. Confirmar soma o estoque e atualiza
// o custo dos produtos; estornar desfaz o estoque.
export const Recebimento = sequelize.define(
  "Recebimento",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    fornecedorId: { type: DataTypes.UUID, allowNull: false },
    documento: { type: DataTypes.STRING(100), allowNull: true },
    dataRecebimento: { type: DataTypes.DATEONLY, allowNull: false },
    observacoes: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM("CONFIRMADO", "ESTORNADO"),
      allowNull: false,
      defaultValue: "CONFIRMADO",
    },
    total: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    usuarioNome: { type: DataTypes.STRING(150), allowNull: true },
    estornadoEm: { type: DataTypes.DATE, allowNull: true },
    estornadoPor: { type: DataTypes.STRING(150), allowNull: true },
    motivoEstorno: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "recebimentos",
    timestamps: true,
  },
);

export const RecebimentoItem = sequelize.define(
  "RecebimentoItem",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    recebimentoId: { type: DataTypes.UUID, allowNull: false },
    produtoId: { type: DataTypes.UUID, allowNull: false },
    produtoNome: { type: DataTypes.STRING(200), allowNull: true },
    // Quantidade em unidades e custo por unidade.
    quantidade: { type: DataTypes.INTEGER, allowNull: false },
    custoUnitario: { type: DataTypes.DECIMAL(12, 4), allowNull: false },
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    observacao: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "recebimento_itens",
    timestamps: false,
  },
);
