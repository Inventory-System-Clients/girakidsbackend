import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Cheques recebidos dos clientes (Financeiro → Cheques). Cada parcela paga
// (ou a pagar) em cheque vira um cheque; pedido em cheque sem parcela vira um
// cheque do total. Status: CAIXA (está conosco), ENVIADO (usado para pagar um
// fornecedor) ou DEVOLVIDO (voltou; falar com o cliente).
const Cheque = sequelize.define(
  "Cheque",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    pedidoId: { type: DataTypes.UUID, allowNull: false },
    parcelaId: { type: DataTypes.UUID, allowNull: true },
    valor: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    recebidoEm: { type: DataTypes.DATEONLY, allowNull: true },
    numero: { type: DataTypes.STRING(40), allowNull: true },
    banco: { type: DataTypes.STRING(100), allowNull: true },
    bomPara: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "CAIXA" },
    fornecedorId: { type: DataTypes.UUID, allowNull: true },
    fornecedorNome: { type: DataTypes.STRING(200), allowNull: true },
    enviadoEm: { type: DataTypes.DATEONLY, allowNull: true },
    enviadoPor: { type: DataTypes.STRING(150), allowNull: true },
    devolvidoEm: { type: DataTypes.DATEONLY, allowNull: true },
    devolvidoPor: { type: DataTypes.STRING(150), allowNull: true },
    motivoDevolucao: { type: DataTypes.TEXT, allowNull: true },
    observacao: { type: DataTypes.TEXT, allowNull: true },
    // Parcela/pedido deixou de ser em cheque (cancelado, trocou a forma) e o
    // cheque ainda estava no caixa: some da lista.
    ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "cheques",
    timestamps: true,
    indexes: [{ fields: ["pedidoId"] }, { fields: ["parcelaId"] }, { fields: ["status"] }, { fields: ["recebidoEm"] }],
  },
);

export default Cheque;
