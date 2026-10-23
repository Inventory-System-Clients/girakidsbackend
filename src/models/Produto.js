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
    // Montagem em cápsula (aba Recebimentos). Com controlaMontagem, o
    // "estoque" do catálogo é calculado: montado + em montagem + o que dá para
    // montar com os brinquedos sem cápsula e as cápsulas disponíveis.
    controlaMontagem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    estoqueMontado: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    estoqueEmMontagem: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Brinquedos recebidos fora da cápsula (quando não há produtoSoltoId).
    estoqueSemCapsula: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Opcional: os brinquedos soltos são o estoque de outro produto (ex.:
    // "Pokemon sem Caps"), que continua podendo ser vendido.
    produtoSoltoId: { type: DataTypes.UUID, allowNull: true },
    // Cápsulas usadas por unidade: [{ produtoId, quantidade }].
    capsulas: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    // Quem recebe as cápsulas primeiro quando não dá para todos (maior primeiro).
    prioridadeMontagem: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Produto usado como cápsula/sleeve na montagem de outros.
    ehCapsula: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // CAPSULA ou SLEEVE (sem valor: deduzido pelo nome).
    tipoInsumo: { type: DataTypes.STRING(20), allowNull: true },
    // % a mais na sugestão de compra (perda na montagem). Sem valor: 10% para
    // sleeve, 0 para cápsula.
    margemPerda: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    // Avisa que está acabando quando o estoque chega neste número. Sem valor:
    // 500 para sleeve, sem aviso para cápsula.
    avisoCompraAbaixo: { type: DataTypes.INTEGER, allowNull: true },
    fornecedorPreferencialId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    observacoesCompra: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // Capa do produto (sempre a primeira de "imagens").
    imagemUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // Carrossel de imagens do produto, na ordem de exibição.
    imagens: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    imagemSemEstoqueUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // A imagem de esgotado é cópia da de estoque (mesmo arquivo em outro
    // endereço)? Calculado em services/imagemEsgotadoService.js para o par
    // guardado em imagemEsgotadoVerificada.
    imagemEsgotadoIgual: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    imagemEsgotadoVerificada: {
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
