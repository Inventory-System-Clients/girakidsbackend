import bcrypt from "bcryptjs";
import { Usuario } from "../models/index.js";
import { gerarToken } from "../middlewares/auth.js";
import { documentoValido, erroHttp, responderErro, somenteDigitos } from "../utils/helpers.js";
import { definirAvisosCliente } from "../services/whatsappService.js";

// Contra adivinhação de senha: 5 erros seguidos no mesmo e-mail bloqueiam
// esse e-mail por 15 min (em memória; uma instância na Render).
const ERROS_MAXIMOS = 5;
const BLOQUEIO_MS = 15 * 60_000;
const errosLogin = new Map();
const bloqueadoAte = (email) => {
  const e = errosLogin.get(email);
  return e && e.ate > Date.now() ? e.ate : 0;
};
const registrarErroLogin = (email) => {
  const agora = Date.now();
  const e = errosLogin.get(email);
  const atual = e && e.expira > agora ? e : { erros: 0, ate: 0, expira: agora + BLOQUEIO_MS };
  atual.erros += 1;
  if (atual.erros >= ERROS_MAXIMOS) atual.ate = agora + BLOQUEIO_MS;
  errosLogin.set(email, atual);
  if (errosLogin.size > 10_000) errosLogin.delete(errosLogin.keys().next().value);
};
// Compara com um hash qualquer quando o e-mail não existe (mesmo tempo de
// resposta: não dá para descobrir quais e-mails têm conta).
const HASH_FALSO = bcrypt.hashSync("girakids-senha-inexistente", 10);

export const login = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 150);
    const senha = String(req.body?.senha || "").slice(0, 200);
    if (!email || !senha) throw erroHttp(400, "Informe e-mail e senha.");
    if (bloqueadoAte(email)) throw erroHttp(429, "Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.");
    const usuario = await Usuario.findOne({ where: { email } });
    const senhaOk = usuario ? await usuario.verificarSenha(senha) : await bcrypt.compare(senha, HASH_FALSO);
    if (!usuario || !usuario.ativo || !senhaOk) {
      registrarErroLogin(email);
      throw erroHttp(401, "E-mail ou senha inválidos.");
    }
    errosLogin.delete(email);
    res.json({ token: gerarToken(usuario), usuario });
  } catch (error) {
    responderErro(res, error, "Erro ao fazer login");
  }
};

const ENDERECO = ["cep", "rua", "numero", "complemento", "bairro", "cidade", "estado"];

const validarCadastro = (corpo, { exigirEndereco = true } = {}) => {
  const erros = [];
  if (!String(corpo.nome || "").trim()) erros.push("Nome completo é obrigatório");
  if (!/^\S+@\S+\.\S+$/.test(String(corpo.email || ""))) erros.push("Email inválido");
  if (!documentoValido(corpo.documento)) erros.push("CPF/CNPJ inválido");
  if (somenteDigitos(corpo.telefone).length < 10) erros.push("Telefone inválido");
  if (exigirEndereco) {
    for (const campo of ["cep", "rua", "numero", "bairro", "cidade", "estado"]) {
      if (!String(corpo[campo] || "").trim()) erros.push(`${campo} é obrigatório`);
    }
  }
  if (erros.length) throw erroHttp(400, erros.join(". "));
};

// Cadastro público de cliente ("Criar Nova Conta").
export const registrar = async (req, res) => {
  try {
    const corpo = req.body || {};
    validarCadastro(corpo);
    if (String(corpo.senha || "").length < 8) throw erroHttp(400, "Senha deve ter no mínimo 8 caracteres.");
    if (String(corpo.senha).length > 200) throw erroHttp(400, "Senha muito longa.");
    const existente = await Usuario.findOne({ where: { email: String(corpo.email).trim().toLowerCase() } });
    if (existente) throw erroHttp(409, "Já existe uma conta com este e-mail.");
    const documento = somenteDigitos(corpo.documento);
    const usuario = await Usuario.create({
      nome: corpo.nome.trim(),
      email: corpo.email,
      senha: corpo.senha,
      role: "CLIENTE",
      documento,
      documentoTipo: documento.length === 14 ? "CNPJ" : "CPF",
      telefone: corpo.telefone,
      ...Object.fromEntries(ENDERECO.map((c) => [c, corpo[c] || null])),
      cep: somenteDigitos(corpo.cep),
    });
    res.status(201).json({ token: gerarToken(usuario), usuario });
  } catch (error) {
    responderErro(res, error, "Erro ao criar conta");
  }
};

export const perfil = async (req, res) => res.json(req.usuario);

export const atualizarPerfil = async (req, res) => {
  try {
    if (req.usuario.role === "SHOWROOM") throw erroHttp(403, "A conta do showroom só pode ser alterada pelo administrador.");
    const corpo = { ...req.usuario.toJSON(), ...req.body };
    const novoEmail = String(corpo.email || "").trim().toLowerCase();
    if (novoEmail !== String(req.usuario.email || "").toLowerCase() && !req.usuario.trocarSenha) {
      if (!(await req.usuario.verificarSenha(String(req.body?.senhaAtual || "")))) {
        throw erroHttp(400, "Para trocar o e-mail, informe sua senha atual.");
      }
    }
    validarCadastro(corpo, { exigirEndereco: req.usuario.role === "CLIENTE" });
    const documento = somenteDigitos(corpo.documento);
    await req.usuario.update({
      nome: corpo.nome.trim(),
      email: corpo.email,
      telefone: corpo.telefone,
      documento,
      documentoTipo: documento.length === 14 ? "CNPJ" : "CPF",
      ...Object.fromEntries(ENDERECO.map((c) => [c, corpo[c] || null])),
      cep: somenteDigitos(corpo.cep) || null,
    });
    if (req.body?.whatsappAvisos !== undefined && Boolean(req.body.whatsappAvisos) !== req.usuario.whatsappAvisos) {
      await definirAvisosCliente(req.usuario, Boolean(req.body.whatsappAvisos));
    }
    res.json(req.usuario);
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ error: "Este e-mail já está em uso." });
    }
    responderErro(res, error, "Erro ao atualizar perfil");
  }
};

export const alterarSenha = async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body || {};
    if (req.usuario.role === "SHOWROOM" && !req.usuario.trocarSenha) {
      throw erroHttp(403, "A senha do showroom só pode ser alterada pelo administrador.");
    }
    if (String(novaSenha || "").length < 8) throw erroHttp(400, "A nova senha deve ter no mínimo 8 caracteres.");
    if (String(novaSenha).length > 200) throw erroHttp(400, "Senha muito longa.");
    if (!req.usuario.trocarSenha && !(await req.usuario.verificarSenha(String(senhaAtual || "")))) {
      throw erroHttp(400, "Senha atual incorreta.");
    }
    await req.usuario.update({ senha: novaSenha, trocarSenha: false });
    // As outras sessões caem; esta recebe um token novo.
    res.json({ message: "Senha alterada com sucesso.", token: gerarToken(req.usuario) });
  } catch (error) {
    responderErro(res, error, "Erro ao alterar senha");
  }
};
