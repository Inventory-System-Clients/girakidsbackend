import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Controle de pedidos e notas fiscais do time comercial. Os campos de nota
// (numeroNota, dataNota, tipoFrete, transportadora, valorNota) podem ser
// preenchidos manualmente ou completados via sincronização com a NFeMail
// (ver src/services/nfemailService.js); origemDados indica a última fonte
// que preencheu esses campos.
const PedidoNotaFiscal = sequelize.define(
  "PedidoNotaFiscal",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    clienteNome: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    numeroPedido: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    dataPedido: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    numeroNota: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    dataNota: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    tipoFrete: {
      type: DataTypes.ENUM("CIF", "FOB"),
      allowNull: true,
    },
    transportadora: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    numeroColeta: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    teveCotacao: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    dataCotacao: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    numeroCotacao: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    valorNota: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    chaveAcessoNFe: {
      type: DataTypes.STRING(60),
      allowNull: true,
    },
    origemDados: {
      type: DataTypes.ENUM("MANUAL", "NFEMAIL"),
      allowNull: false,
      defaultValue: "MANUAL",
    },
    observacoes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    usuarioId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: "usuarios",
        key: "id",
      },
    },
  },
  {
    tableName: "pedidos_notas_fiscais",
    timestamps: true,
  },
);

export default PedidoNotaFiscal;
