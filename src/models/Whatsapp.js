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

// Listas de clientes para mensagens de novidades/promoções (até 20 pessoas
// por lista, para não parecer disparo em massa). O texto usa {nome}.
// RASCUNHO | AGENDADA | ENVIANDO | CONCLUIDA | CANCELADA
export const WhatsappCampanha = sequelize.define(
  "WhatsappCampanha",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    nome: { type: DataTypes.STRING(120), allowNull: false },
    produtoNome: { type: DataTypes.STRING(200), allowNull: true },
    detalhes: { type: DataTypes.TEXT, allowNull: true },
    texto: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    // Imagem ou vídeo enviado junto (fica na tabela arquivos).
    midiaArquivoId: { type: DataTypes.UUID, allowNull: true },
    midiaTipo: { type: DataTypes.STRING(10), allowNull: true },
    midiaNome: { type: DataTypes.STRING(200), allowNull: true },
    // [{ usuarioId, nome, telefone, pedidos }]
    clientes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    // Critério usado na recomendação: { tipo: GERAL|CATEGORIA|PRODUTO,
    // categoria, produtoId, produtoNome, dias } (para "gerar outra lista").
    filtro: { type: DataTypes.JSONB, allowNull: true },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "RASCUNHO" },
    agendadaPara: { type: DataTypes.DATE, allowNull: true },
    concluidaEm: { type: DataTypes.DATE, allowNull: true },
    criadoPor: { type: DataTypes.STRING(150), allowNull: true },
  },
  { tableName: "whatsapp_campanhas", timestamps: true, indexes: [{ fields: ["status"] }] },
);

// Uma mensagem por cliente da lista; sai pela mesma fila dos avisos.
// FILA | ENVIANDO | ENVIADO | ERRO | DESCARTADA
export const WhatsappCampanhaEnvio = sequelize.define(
  "WhatsappCampanhaEnvio",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    campanhaId: { type: DataTypes.UUID, allowNull: false },
    usuarioId: { type: DataTypes.UUID, allowNull: false },
    clienteNome: { type: DataTypes.STRING(150), allowNull: true },
    telefone: { type: DataTypes.STRING(20), allowNull: false },
    texto: { type: DataTypes.TEXT, allowNull: false },
    programadoPara: { type: DataTypes.DATE, allowNull: false },
    ordem: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "FILA" },
    tentativas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    erro: { type: DataTypes.TEXT, allowNull: true },
    enviadoEm: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "whatsapp_campanha_envios",
    timestamps: true,
    indexes: [{ unique: true, fields: ["campanhaId", "usuarioId"] }, { fields: ["status", "programadoPara"] }, { fields: ["usuarioId", "enviadoEm"] }],
  },
);

// Listas nichadas salvas (quem mais compra de uma categoria ou de um produto),
// para reaproveitar nos envios. Até 20 clientes, como as listas de envio.
export const WhatsappPublico = sequelize.define(
  "WhatsappPublico",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    nome: { type: DataTypes.STRING(120), allowNull: false },
    // GERAL, CATEGORIA ou PRODUTO
    tipo: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "GERAL" },
    categoria: { type: DataTypes.STRING(100), allowNull: true },
    produtoId: { type: DataTypes.UUID, allowNull: true },
    produtoNome: { type: DataTypes.STRING(200), allowNull: true },
    periodoDias: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 90 },
    // [{ usuarioId, nome, telefone, pedidos, itens }]
    clientes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    usadaEm: { type: DataTypes.DATE, allowNull: true },
    criadoPor: { type: DataTypes.STRING(150), allowNull: true },
  },
  { tableName: "whatsapp_publicos", timestamps: true },
);
