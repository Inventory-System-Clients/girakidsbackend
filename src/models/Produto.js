import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Tipos de empacotamento usados no cálculo de frete (iguais aos da loja
// original). "peso" = estimativa por peso; "frete_indisponivel" obriga contato.
export const TIPOS_EMBALAGEM = {
  ball_27mm: "Bolinha 27mm",
  ball_32mm: "Bolinha 32mm",
  ball_45mm: "Bolinha 45mm",
  enc_1inch: 'Encapsulado 1"',
  enc_2inch: 'Encapsulado 2"',
  enc_105mm: "Encapsulado 105mm",
  cap_empty_1inch: 'Cápsula Vazia 1"',
  cap_empty_2inch: 'Cápsula Vazia 2"',
  cap_empty_105mm: "Cápsula Vazia 105mm",
  peso: "Estimativa por Peso",
  frete_indisponivel: "Frete Indisponível (contato obrigatório)",
};

const Produto = sequelize.define(
  "Produto",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    sku: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    nome: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    descricao: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    categoria: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    // SIMPLES ou COMPOSTO (kit formado por outros produtos — "componentes").
    tipo: {
      type: DataTypes.ENUM("SIMPLES", "COMPOSTO"),
      allowNull: false,
      defaultValue: "SIMPLES",
    },
    componentes: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    // PADRAO: vende do estoque. ENCOMENDA: pode vender sem estoque; entra na
    // "Fila sob demanda" do dashboard.
    modoVenda: {
      type: DataTypes.ENUM("PADRAO", "ENCOMENDA"),
      allowNull: false,
      defaultValue: "PADRAO",
    },
    // Preço e custo são por UNIDADE; o pacote multiplica por unidadesPacote.
    precoVenda: {
      type: DataTypes.DECIMAL(12, 4),
      allowNull: false,
      defaultValue: 0,
    },
    custo: {
      type: DataTypes.DECIMAL(12, 4),
      allowNull: true,
    },
    unidadesPacote: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    pesoPacoteGramas: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    tipoEmbalagem: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    // Estoque em unidades.
    estoque: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    estoqueMinimo: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    fornecedorPreferencialId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    observacoesCompra: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    imagemUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    imagemSemEstoqueUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // Selo "Mais vendido" no catálogo (aparece primeiro).
    destaque: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    arquivado: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    criadoPor: { type: DataTypes.STRING(150), allowNull: true },
    atualizadoPor: { type: DataTypes.STRING(150), allowNull: true },
    legadoId: { type: DataTypes.STRING(100), allowNull: true },
  },
  {
    tableName: "produtos",
    timestamps: true,
    indexes: [{ fields: ["sku"] }, { fields: ["categoria"] }],
  },
);

export default Produto;
