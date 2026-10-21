import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Banners promocionais do topo do catálogo (como na Prime Plush): arte
// pronta + botão que leva a uma categoria, uma busca ou um produto.
const Banner = sequelize.define(
  "Banner",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    imagemUrl: { type: DataTypes.TEXT, allowNull: false },
    // Arte opcional para celular (proporção mais alta).
    imagemMobileUrl: { type: DataTypes.TEXT, allowNull: true },
    alt: { type: DataTypes.STRING(200), allowNull: true },
    textoBotao: { type: DataTypes.STRING(60), allowNull: true },
    categoria: { type: DataTypes.STRING(100), allowNull: true },
    busca: { type: DataTypes.STRING(150), allowNull: true },
    produtoId: { type: DataTypes.UUID, allowNull: true },
    ordem: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "banners",
    timestamps: true,
  },
);

export default Banner;
