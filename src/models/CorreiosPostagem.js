import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Postagem criada no VIPP a partir de um pedido da própria loja (aba
// Comercial → Correios). Serve pra não gravar o mesmo pedido duas vezes no
// VIPP (geraria duas pré-postagens nos Correios) e pra baixar os PDFs depois.
const CorreiosPostagem = sequelize.define(
  "CorreiosPostagem",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    pedidoId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    numeroPedido: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    cliente: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    vippIdConhecimento: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    etiqueta: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    servico: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    valorFrete: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    usuarioId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    tableName: "correios_postagens",
    timestamps: true,
    indexes: [{ fields: ["pedidoId"] }],
  },
);

export default CorreiosPostagem;
