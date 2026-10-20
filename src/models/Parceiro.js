import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Fornecedores e transportadoras (aba Entradas → Parceiros).
const Parceiro = sequelize.define(
  "Parceiro",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tipo: {
      type: DataTypes.ENUM("FORNECEDOR", "TRANSPORTADORA"),
      allowNull: false,
    },
    nome: { type: DataTypes.STRING(200), allowNull: false },
    documento: { type: DataTypes.STRING(20), allowNull: true },
    contato: { type: DataTypes.STRING(150), allowNull: true },
    telefone: { type: DataTypes.STRING(30), allowNull: true },
    email: { type: DataTypes.STRING(150), allowNull: true },
    cidade: { type: DataTypes.STRING(100), allowNull: true },
    estado: { type: DataTypes.STRING(2), allowNull: true },
    observacoes: { type: DataTypes.TEXT, allowNull: true },
    ativo: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    criadoPor: { type: DataTypes.STRING(150), allowNull: true },
    legadoId: { type: DataTypes.STRING(100), allowNull: true },
  },
  {
    tableName: "parceiros",
    timestamps: true,
  },
);

export default Parceiro;
