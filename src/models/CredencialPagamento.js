import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Credenciais de cada banco/gateway (aba Pagamentos), sempre cifradas
// (utils/cofreCredenciais.js). Uma linha por provedor.
const CredencialPagamento = sequelize.define(
  "CredencialPagamento",
  {
    provedor: { type: DataTypes.STRING(40), primaryKey: true },
    dadosCifrados: { type: DataTypes.TEXT, allowNull: false },
    // Só para o painel (nunca o valor): campos preenchidos e máscaras.
    resumo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    validadoEm: { type: DataTypes.DATE, allowNull: true },
    atualizadoPor: { type: DataTypes.STRING(150), allowNull: true },
  },
  { tableName: "credenciais_pagamento", timestamps: true },
);

export default CredencialPagamento;
