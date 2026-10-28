import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Fila dos avisos de WhatsApp dos pedidos (Evolution API). Um aviso por
// pedido e etapa: clicar duas vezes não repete a mensagem.
export const WhatsappMensagem = sequelize.define(
  "WhatsappMensagem",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    pedidoId: { type: DataTypes.UUID, allowNull: false },
    pedidoNumero: { type: DataTypes.INTEGER, allowNull: true },
    clienteNome: { type: DataTypes.STRING(150), allowNull: true },
    // CRIADO | PRONTO | A_CAMINHO
    etapa: { type: DataTypes.STRING(20), allowNull: false },
    telefone: { type: DataTypes.STRING(20), allowNull: false },
    texto: { type: DataTypes.TEXT, allowNull: false },
    // FILA | ENVIANDO | ENVIADO | ERRO | DESCARTADA
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "FILA" },
    tentativas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    erro: { type: DataTypes.TEXT, allowNull: true },
    enviadoEm: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "whatsapp_mensagens",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["pedidoId", "etapa"] },
      { fields: ["status", "createdAt"] },
    ],
  },
);

// Números que responderam SAIR. A chave ignora o 9º dígito do celular
// (o WhatsApp às vezes devolve o número sem ele).
export const WhatsappOptOut = sequelize.define(
  "WhatsappOptOut",
  {
    chave: { type: DataTypes.STRING(20), primaryKey: true },
    telefone: { type: DataTypes.STRING(20), allowNull: true },
    origem: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "WHATSAPP" },
  },
  {
    tableName: "whatsapp_optouts",
    timestamps: true,
  },
);
