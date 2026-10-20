import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Histórico de alterações de custo e de preço de venda de um produto.
const HistoricoPreco = sequelize.define(
  "HistoricoPreco",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    produtoId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    campo: {
      type: DataTypes.ENUM("CUSTO", "VENDA"),
      allowNull: false,
    },
    valorAnterior: { type: DataTypes.DECIMAL(12, 4), allowNull: true },
    valorNovo: { type: DataTypes.DECIMAL(12, 4), allowNull: true },
    // EDICAO (cadastro do produto) ou RECEBIMENTO (entrada de fornecedor).
    origem: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: "EDICAO",
    },
    usuarioNome: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "historico_precos",
    timestamps: true,
    updatedAt: false,
    indexes: [{ fields: ["produtoId"] }],
  },
);

export default HistoricoPreco;
