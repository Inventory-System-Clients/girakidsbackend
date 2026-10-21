import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Custo pós-venda de um pedido já finalizado (reenvio, avaria, troca, frete
// extra...). Entra como custo do pedido na receita líquida do Time Financeiro.
export const CATEGORIAS_CUSTO = {
  REENVIO: "Reenvio",
  AVARIA: "Avaria / produto danificado",
  TROCA: "Troca",
  FRETE_EXTRA: "Frete extra",
  ERRO_SEPARACAO: "Erro de separação",
  BRINDE: "Brinde / compensação",
  OUTRO: "Outro",
};

const PedidoCustoExtra = sequelize.define(
  "PedidoCustoExtra",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    pedidoId: { type: DataTypes.UUID, allowNull: false },
    categoria: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: "OUTRO",
    },
    descricao: { type: DataTypes.TEXT, allowNull: false },
    valor: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    data: { type: DataTypes.DATEONLY, allowNull: false },
    usuarioNome: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "pedido_custos_extras",
    timestamps: true,
    indexes: [{ fields: ["pedidoId"] }, { fields: ["data"] }],
  },
);

export default PedidoCustoExtra;
