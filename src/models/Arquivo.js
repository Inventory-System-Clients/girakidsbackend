import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Imagens de produto, fotos da expedição e PDFs de nota fiscal ficam no
// próprio banco — funciona em qualquer hospedagem sem disco persistente ou
// serviço de storage. O frontend já comprime as imagens antes do envio.
const Arquivo = sequelize.define(
  "Arquivo",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    nome: { type: DataTypes.STRING(200), allowNull: false },
    mime: { type: DataTypes.STRING(100), allowNull: false },
    tamanho: { type: DataTypes.INTEGER, allowNull: false },
    dados: { type: DataTypes.BLOB, allowNull: false },
    enviadoPor: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "arquivos",
    timestamps: true,
    updatedAt: false,
  },
);

export default Arquivo;
