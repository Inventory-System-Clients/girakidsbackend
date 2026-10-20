import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Categoria do catálogo. "visivel" oculta a categoria inteira do catálogo
// público (aba Gerenciar Produtos → Categorias).
const Categoria = sequelize.define(
  "Categoria",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    nome: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    visivel: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: "categorias",
    timestamps: true,
  },
);

export default Categoria;
