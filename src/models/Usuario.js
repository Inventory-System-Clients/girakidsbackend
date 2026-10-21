import { DataTypes } from "sequelize";
import bcrypt from "bcryptjs";
import { sequelize } from "../database/connection.js";

// Telas internas que um FUNCIONARIO pode receber (o ADMIN acessa todas).
// Mesmas opções do "Criar Novo Usuário" da loja original + a aba Comercial.
export const PERMISSOES = [
  "FINANCEIRO",
  "CHECKOUT",
  "VENDAS",
  "EXPEDICAO",
  "PRODUTOS",
  "ENTRADAS",
  "ORCAMENTOS",
  "USUARIOS",
  "COMERCIAL",
];

const Usuario = sequelize.define(
  "Usuario",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    nome: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(150),
      allowNull: false,
      unique: true,
      validate: { isEmail: true },
      set(valor) {
        this.setDataValue("email", String(valor || "").trim().toLowerCase());
      },
    },
    senha: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // ADMIN: acesso total; FUNCIONARIO: acesso pelas permissões; CLIENTE:
    // catálogo, checkout e "Meus Pedidos".
    role: {
      type: DataTypes.ENUM("ADMIN", "FUNCIONARIO", "CLIENTE"),
      allowNull: false,
      defaultValue: "CLIENTE",
    },
    permissoes: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    documentoTipo: {
      type: DataTypes.ENUM("CPF", "CNPJ"),
      allowNull: true,
    },
    documento: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    telefone: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    cep: { type: DataTypes.STRING(9), allowNull: true },
    rua: { type: DataTypes.STRING(150), allowNull: true },
    numero: { type: DataTypes.STRING(20), allowNull: true },
    complemento: { type: DataTypes.STRING(100), allowNull: true },
    bairro: { type: DataTypes.STRING(100), allowNull: true },
    cidade: { type: DataTypes.STRING(100), allowNull: true },
    estado: { type: DataTypes.STRING(2), allowNull: true },
    // "Outros pagamentos" (boleto, dinheiro e cheque) liberados ao cliente.
    outrosPagamentos: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Crédito manual do cliente, usado como desconto em pedidos.
    credito: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // Força a troca de senha no próximo login (usuários importados ou senha
    // redefinida pelo admin).
    trocarSenha: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    ativo: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    // Etiquetas rápidas do comercial (ex.: "VIP", "Paga atrasado") e
    // observação interna sobre o cliente.
    etiquetas: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    observacaoComercial: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // Identificador no sistema antigo (Firebase), usado só na importação.
    legadoId: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
  },
  {
    tableName: "usuarios",
    timestamps: true,
    hooks: {
      beforeSave: async (usuario) => {
        if (usuario.changed("senha")) {
          usuario.senha = await bcrypt.hash(usuario.senha, 10);
        }
      },
    },
  },
);

Usuario.prototype.verificarSenha = function (senha) {
  return bcrypt.compare(senha, this.senha);
};

Usuario.prototype.temPermissao = function (...permissoes) {
  if (this.role === "ADMIN") return true;
  if (this.role !== "FUNCIONARIO") return false;
  const minhas = this.permissoes || [];
  return permissoes.some((permissao) => minhas.includes(permissao));
};

Usuario.prototype.toJSON = function () {
  const valores = { ...this.get() };
  delete valores.senha;
  return valores;
};

export default Usuario;
