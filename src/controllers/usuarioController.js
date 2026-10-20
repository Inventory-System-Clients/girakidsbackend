import { Op } from "sequelize";
import { Usuario, Pedido } from "../models/index.js";
import { PERMISSOES } from "../models/Usuario.js";
import { erroHttp, numero, responderErro, somenteDigitos, documentoValido } from "../utils/helpers.js";

const ROLES = ["ADMIN", "FUNCIONARIO", "CLIENTE"];

export const listar = async (req, res) => {
  try {
    const where = {};
    if (req.query.role) where.role = { [Op.in]: String(req.query.role).split(",") };
    const busca = String(req.query.busca || "").trim();
    if (busca) {
      where[Op.or] = [
        { nome: { [Op.iLike]: `%${busca}%` } },
        { email: { [Op.iLike]: `%${busca}%` } },
        { documento: { [Op.iLike]: `%${somenteDigitos(busca) || busca}%` } },
      ];
    }
    // Funcionário com "Gerenciar Usuários" só enxerga e edita clientes.
    if (req.usuario.role !== "ADMIN") where.role = "CLIENTE";

    const limite = Math.min(Number(req.query.limite) || 30, 200);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const { rows, count } = await Usuario.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: limite,
      offset: (pagina - 1) * limite,
    });
    res.json({ itens: rows, total: count, pagina, paginas: Math.max(1, Math.ceil(count / limite)) });
  } catch (error) {
    responderErro(res, error, "Erro ao listar usuários");
  }
};

// Busca para "Preencher com dados de outro usuário" no checkout.
export const buscarClientes = async (req, res) => {
  try {
    const busca = String(req.query.busca || "").trim();
    if (busca.length < 2) return res.json([]);
    const usuarios = await Usuario.findAll({
      where: {
        ativo: true,
        [Op.or]: [
          { nome: { [Op.iLike]: `%${busca}%` } },
          { email: { [Op.iLike]: `%${busca}%` } },
        ],
      },
      order: [["nome", "ASC"]],
      limit: 20,
    });
    res.json(usuarios);
  } catch (error) {
    responderErro(res, error, "Erro ao buscar clientes");
  }
};

const dados = (corpo, editor) => {
  const saida = {};
  for (const campo of ["nome", "email", "telefone", "rua", "numero", "complemento", "bairro", "cidade", "estado", "outrosPagamentos", "ativo"]) {
    if (corpo[campo] !== undefined) saida[campo] = corpo[campo];
  }
  if (corpo.documento !== undefined) {
    const documento = somenteDigitos(corpo.documento);
    if (documento && !documentoValido(documento)) throw erroHttp(400, "CPF/CNPJ inválido.");
    saida.documento = documento || null;
    saida.documentoTipo = documento.length === 14 ? "CNPJ" : documento ? "CPF" : null;
  }
  if (corpo.cep !== undefined) saida.cep = somenteDigitos(corpo.cep) || null;
  if (corpo.credito !== undefined) saida.credito = Math.max(0, numero(corpo.credito));
  if (corpo.role !== undefined) {
    if (!ROLES.includes(corpo.role)) throw erroHttp(400, "Cargo inválido.");
    if (editor.role !== "ADMIN" && corpo.role !== "CLIENTE") {
      throw erroHttp(403, "Somente administradores podem criar usuários internos.");
    }
    saida.role = corpo.role;
  }
  if (corpo.permissoes !== undefined) {
    saida.permissoes = (corpo.permissoes || []).filter((p) => PERMISSOES.includes(p));
  }
  return saida;
};

export const criar = async (req, res) => {
  try {
    const corpo = req.body || {};
    if (!String(corpo.nome || "").trim()) throw erroHttp(400, "Nome completo é obrigatório.");
    if (String(corpo.senha || "").length < 8) throw erroHttp(400, "Senha deve ter no mínimo 8 caracteres.");
    const usuario = await Usuario.create({
      ...dados({ role: "CLIENTE", ...corpo }, req.usuario),
      senha: corpo.senha,
      trocarSenha: Boolean(corpo.trocarSenha),
    });
    res.locals.entityId = usuario.id;
    res.status(201).json(usuario);
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ error: "Já existe um usuário com este e-mail." });
    }
    responderErro(res, error, "Erro ao criar usuário");
  }
};

const carregarEditavel = async (req) => {
  const usuario = await Usuario.findByPk(req.params.id);
  if (!usuario) throw erroHttp(404, "Usuário não encontrado.");
  if (req.usuario.role !== "ADMIN" && usuario.role !== "CLIENTE") {
    throw erroHttp(403, "Você só pode gerenciar clientes.");
  }
  return usuario;
};

export const atualizar = async (req, res) => {
  try {
    const usuario = await carregarEditavel(req);
    const atualizacao = dados(req.body || {}, req.usuario);
    if (usuario.id === req.usuario.id && atualizacao.role && atualizacao.role !== "ADMIN") {
      throw erroHttp(400, "Você não pode remover seu próprio acesso de administrador.");
    }
    await usuario.update(atualizacao);
    res.json(usuario);
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ error: "Já existe um usuário com este e-mail." });
    }
    responderErro(res, error, "Erro ao atualizar usuário");
  }
};

export const resetarSenha = async (req, res) => {
  try {
    const usuario = await carregarEditavel(req);
    const senha = String(req.body?.senha || "");
    if (senha.length < 8) throw erroHttp(400, "A senha deve ter no mínimo 8 caracteres.");
    await usuario.update({ senha, trocarSenha: true });
    res.json({ message: "Senha redefinida. O usuário deverá trocá-la no próximo login." });
  } catch (error) {
    responderErro(res, error, "Erro ao redefinir senha");
  }
};

// Usuário com pedidos é desativado (mantém o histórico); sem pedidos é
// excluído de fato.
export const excluir = async (req, res) => {
  try {
    const usuario = await carregarEditavel(req);
    if (usuario.id === req.usuario.id) throw erroHttp(400, "Você não pode excluir a própria conta.");
    const pedidos = await Pedido.count({ where: { clienteId: usuario.id } });
    if (pedidos) {
      await usuario.update({ ativo: false });
      return res.json({ message: "Usuário desativado (possui pedidos no histórico)." });
    }
    await usuario.destroy();
    res.json({ message: "Usuário excluído." });
  } catch (error) {
    responderErro(res, error, "Erro ao excluir usuário");
  }
};
