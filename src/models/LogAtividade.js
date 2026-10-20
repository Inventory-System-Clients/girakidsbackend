import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// US03 - Log de Atividades
const LogAtividade = sequelize.define(
  "LogAtividade",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    usuarioId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "usuarios",
        key: "id",
      },
    },
    acao: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: "Ex: LOGIN, CRIAR_LOJA, EDITAR_MAQUINA, REGISTRAR_MOVIMENTACAO",
    },
    entidade: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: "Ex: Usuario, Loja, Maquina, Movimentacao",
    },
    entidadeId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: "ID da entidade afetada",
    },
    detalhes: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: "Dados adicionais sobre a ação",
    },
    ipAddress: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    userAgent: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
  },
  {
    tableName: "logs_atividades",
    timestamps: true,
    updatedAt: false,
  }
);

export default LogAtividade;
