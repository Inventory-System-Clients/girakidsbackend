import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Configurações gerais em chave/valor (metas mensais, cartões online
// habilitados, taxas por forma de pagamento...).
export const Configuracao = sequelize.define(
  "Configuracao",
  {
    chave: {
      type: DataTypes.STRING(100),
      primaryKey: true,
    },
    valor: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "configuracoes",
    timestamps: true,
  },
);

// Alertas de conciliação de pagamento online (retorno do banco/gateway que
// precisa de revisão antes de confirmar o pedido).
export const AlertaPagamento = sequelize.define(
  "AlertaPagamento",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    pedidoId: { type: DataTypes.UUID, allowNull: true },
    pedidoNumero: { type: DataTypes.STRING(50), allowNull: true },
    provedor: { type: DataTypes.STRING(40), allowNull: true },
    severidade: {
      type: DataTypes.ENUM("info", "warning", "critical"),
      allowNull: false,
      defaultValue: "warning",
    },
    motivo: { type: DataTypes.STRING(60), allowNull: false },
    mensagem: { type: DataTypes.TEXT, allowNull: false },
    valorEsperado: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    valorRecebido: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    detalhes: { type: DataTypes.JSONB, allowNull: true },
    status: {
      type: DataTypes.ENUM("ATIVO", "RESOLVIDO"),
      allowNull: false,
      defaultValue: "ATIVO",
    },
    resolvidoEm: { type: DataTypes.DATE, allowNull: true },
    resolvidoPor: { type: DataTypes.STRING(150), allowNull: true },
  },
  {
    tableName: "alertas_pagamento",
    timestamps: true,
  },
);

const cache = new Map();

export const lerConfiguracao = async (chave, padrao = null) => {
  if (cache.has(chave)) return cache.get(chave);
  const registro = await Configuracao.findByPk(chave);
  const valor = registro ? registro.valor : padrao;
  cache.set(chave, valor);
  return valor;
};

export const salvarConfiguracao = async (chave, valor) => {
  await Configuracao.upsert({ chave, valor });
  cache.set(chave, valor);
  return valor;
};
