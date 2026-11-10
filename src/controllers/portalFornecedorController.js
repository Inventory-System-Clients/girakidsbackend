import crypto from "crypto";
import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { Parceiro, PreRecebimento, PreRecebimentoItem, Produto, Usuario } from "../models/index.js";
import { erroHttp, hojeISO, numero, responderErro } from "../utils/helpers.js";

// Portal do fornecedor: login próprio, só os pré-recebimentos dele e só os
// itens que a Gira Kids liberou. Nunca devolve valores (custo, preço).

const ABERTOS = ["AGUARDANDO_FORNECEDOR", "FORNECEDOR_RESPONDEU"];
const RECEBIDOS = ["RECEBIDO", "RECEBIDO_PARCIAL"];
const INCLUDE = [{ model: PreRecebimentoItem, as: "itens" }];
const qtd = (v) => {
  const n = Math.round(numero(v));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw erroHttp(400, "Quantidade inválida.");
  return n;
};
const texto = (v, max = 2000) => (v == null ? null : String(v).trim().slice(0, max) || null);
const dataOuNulo = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
const esperado = (i) => (i.quantidadeFornecedor != null ? i.quantidadeFornecedor : i.quantidadeSolicitada);

const SITUACAO = {
  AGUARDANDO_FORNECEDOR: "Aguardando sua confirmação",
  FORNECEDOR_RESPONDEU: "Confirmado · aguardando entrega",
  RECEBIDO: "Entrega concluída",
  RECEBIDO_PARCIAL: "Entrega concluída",
  CANCELADO: "Cancelado",
};

// O que o fornecedor vê de um pré-recebimento (sem valores).
const visao = (pre) => {
  const recebido = RECEBIDOS.includes(pre.status);
  const itens = [...(pre.itens || [])]
    .sort((a, b) => String(a.produtoNome).localeCompare(String(b.produtoNome)))
    .map((i) => ({
      id: i.id,
      nome: i.produtoNome,
      sku: i.produtoSku,
      imagemUrl: i.imagemUrl,
      quantidadeSolicitada: i.quantidadeSolicitada,
      quantidadeFornecedor: i.quantidadeFornecedor,
      observacao: i.observacaoFornecedor,
      quantidadeRecebida: recebido ? i.quantidadeRecebida : null,
      faltou: recebido && i.quantidadeRecebida != null ? Math.max(0, esperado(i) - i.quantidadeRecebida) : 0,
    }));
  return {
    id: pre.id,
    numero: pre.numero,
    status: pre.status,
    situacao: SITUACAO[pre.status] || pre.status,
    aberto: ABERTOS.includes(pre.status),
    recebido,
    criadoPeloFornecedor: pre.criadoPeloFornecedor,
    criadoPor: pre.criadoPeloFornecedor ? pre.criadoPor : "Gira Kids",
    criadoEm: pre.createdAt,
    previsaoEntrega: pre.previsaoEntrega,
    observacao: pre.criadoPeloFornecedor ? null : pre.observacao,
    respondidoEm: pre.respondidoEm,
    previsaoFornecedor: pre.previsaoFornecedor,
    observacaoFornecedor: pre.observacaoFornecedor,
    recebidoEm: recebido ? pre.recebidoEm : null,
    canceladoEm: pre.status === "CANCELADO" ? pre.canceladoEm : null,
    itens,
    totais: {
      combinado: itens.reduce((s, i) => s + (i.quantidadeFornecedor ?? i.quantidadeSolicitada), 0),
      recebido: recebido ? itens.reduce((s, i) => s + (i.quantidadeRecebida ?? 0), 0) : null,
      faltou: itens.reduce((s, i) => s + i.faltou, 0),
    },
  };
};

const fornecedorDoLogin = async (req) => {
  if (req.usuario?.role !== "FORNECEDOR" || !req.usuario.parceiroId) throw erroHttp(403, "Acesso restrito ao fornecedor.");
  const fornecedor = await Parceiro.findByPk(req.usuario.parceiroId);
  if (!fornecedor || !fornecedor.ativo) throw erroHttp(403, "Fornecedor desativado. Fale com a Gira Kids.");
  return fornecedor;
};

const produtosDoFornecedor = async (fornecedor) => {
  const ids = (fornecedor.produtosFornecidos || []).filter(Boolean);
  if (!ids.length) return [];
  return Produto.findAll({ where: { id: ids }, attributes: ["id", "nome", "sku", "imagemUrl", "ehCapsula", "unidadesPacote"], order: [["nome", "ASC"]] });
};

// ---------------------------------------------------------------------------
// Fornecedor logado
// ---------------------------------------------------------------------------

export const meusDados = async (req, res) => {
  try {
    const fornecedor = await fornecedorDoLogin(req);
    const produtos = await produtosDoFornecedor(fornecedor);
    res.json({
      fornecedor: { nome: fornecedor.nome },
      produtos: produtos.map((p) => ({ id: p.id, nome: p.nome, sku: p.sku, imagemUrl: p.imagemUrl, unidadesPacote: p.unidadesPacote })),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar seus dados");
  }
};

export const meusPreRecebimentos = async (req, res) => {
  try {
    const fornecedor = await fornecedorDoLogin(req);
    const lista = await PreRecebimento.findAll({
      where: { fornecedorId: fornecedor.id, status: { [Op.ne]: "ESTORNADO" } },
      include: INCLUDE,
      order: [["numero", "DESC"]],
      limit: 200,
    });
    res.json(lista.map(visao));
  } catch (error) {
    responderErro(res, error, "Erro ao listar pré-recebimentos");
  }
};

// O fornecedor avisa o que vai trazer: itens do escopo dele, quantidades,
// data prevista e observação. Chega para a equipe como "fornecedor respondeu".
export const criarMeu = async (req, res) => {
  try {
    const fornecedor = await fornecedorDoLogin(req);
    const corpo = req.body || {};
    const permitidos = new Set((fornecedor.produtosFornecidos || []).map(String));
    const linhas = (Array.isArray(corpo.itens) ? corpo.itens : []).filter((i) => i?.produtoId && Number(i.quantidade) > 0);
    if (!linhas.length) throw erroHttp(400, "Informe a quantidade de pelo menos um item.");
    if (linhas.length > 300) throw erroHttp(400, "Itens demais.");
    if (linhas.some((i) => !permitidos.has(String(i.produtoId)))) throw erroHttp(403, "Item fora da sua lista de produtos.");
    const previsao = dataOuNulo(corpo.previsaoEntrega);
    if (!previsao) throw erroHttp(400, "Informe a data em que pretende entregar.");
    if (previsao < hojeISO()) throw erroHttp(400, "A data de entrega não pode ser no passado.");
    const produtos = new Map((await Produto.findAll({ where: { id: linhas.map((i) => i.produtoId) } })).map((p) => [p.id, p]));
    const id = await sequelize.transaction(async (transaction) => {
      const numeroPre = Number((await PreRecebimento.max("numero", { transaction })) || 0) + 1;
      const pre = await PreRecebimento.create(
        {
          numero: numeroPre,
          fornecedorId: fornecedor.id,
          fornecedorNome: fornecedor.nome,
          status: "FORNECEDOR_RESPONDEU",
          previsaoEntrega: previsao,
          previsaoFornecedor: previsao,
          observacaoFornecedor: texto(corpo.observacao),
          respondidoEm: new Date(),
          respondidoPor: req.usuario.nome,
          respostaVista: false,
          criadoPor: `${req.usuario.nome} (fornecedor)`,
          criadoPeloFornecedor: true,
        },
        { transaction },
      );
      for (const l of linhas) {
        const p = produtos.get(l.produtoId);
        if (!p) throw erroHttp(400, "Produto não encontrado.");
        const quantidade = qtd(l.quantidade);
        await PreRecebimentoItem.create(
          {
            preRecebimentoId: pre.id,
            produtoId: p.id,
            produtoNome: p.nome,
            produtoSku: p.sku,
            imagemUrl: p.imagemUrl,
            destino: p.ehCapsula ? "CAPSULA" : "PRONTO",
            quantidadeSolicitada: quantidade,
            quantidadeFornecedor: quantidade,
            observacaoFornecedor: texto(l.observacao, 500),
          },
          { transaction },
        );
      }
      return pre.id;
    });
    res.status(201).json(visao(await PreRecebimento.findByPk(id, { include: INCLUDE })));
  } catch (error) {
    responderErro(res, error, "Erro ao criar pré-recebimento");
  }
};

// Confirma (ou corrige) o que vai trazer de um pré-recebimento em aberto,
// inclusive os que a Gira Kids criou para ele.
export const responderMeu = async (req, res) => {
  try {
    const fornecedor = await fornecedorDoLogin(req);
    const pre = await PreRecebimento.findOne({ where: { id: req.params.id, fornecedorId: fornecedor.id }, include: INCLUDE });
    if (!pre) throw erroHttp(404, "Pré-recebimento não encontrado.");
    if (!ABERTOS.includes(pre.status)) throw erroHttp(400, "Este pré-recebimento já foi recebido ou cancelado.");
    const corpo = req.body || {};
    const respostas = new Map((Array.isArray(corpo.itens) ? corpo.itens : []).slice(0, 300).map((i) => [String(i?.id), i]));
    await sequelize.transaction(async (transaction) => {
      for (const item of pre.itens) {
        const r = respostas.get(item.id);
        if (!r || r.quantidade === "" || r.quantidade == null) throw erroHttp(400, `Informe quanto vai entregar de "${item.produtoNome}" (0 se não for entregar).`);
        await item.update({ quantidadeFornecedor: qtd(r.quantidade), observacaoFornecedor: texto(r.observacao, 500) }, { transaction });
      }
      await pre.update(
        {
          status: "FORNECEDOR_RESPONDEU",
          respondidoEm: new Date(),
          respondidoPor: req.usuario.nome,
          previsaoFornecedor: dataOuNulo(corpo.previsaoEntrega),
          observacaoFornecedor: texto(corpo.observacao),
          respostaVista: false,
        },
        { transaction },
      );
    });
    await pre.reload({ include: INCLUDE });
    res.json(visao(pre));
  } catch (error) {
    responderErro(res, error, "Erro ao enviar resposta");
  }
};

// ---------------------------------------------------------------------------
// Equipe (aba Recebimentos → Fornecedores): login e itens de cada fornecedor
// ---------------------------------------------------------------------------

const resumoAcesso = async (fornecedor) => {
  const [usuario, produtos] = await Promise.all([
    Usuario.findOne({ where: { parceiroId: fornecedor.id, role: "FORNECEDOR" } }),
    produtosDoFornecedor(fornecedor),
  ]);
  return {
    fornecedorId: fornecedor.id,
    usuario: usuario ? { id: usuario.id, nome: usuario.nome, email: usuario.email, ativo: usuario.ativo, trocarSenha: usuario.trocarSenha } : null,
    produtos: produtos.map((p) => ({ id: p.id, nome: p.nome, sku: p.sku, imagemUrl: p.imagemUrl })),
  };
};

const carregarFornecedor = async (id) => {
  const fornecedor = await Parceiro.findByPk(id);
  if (!fornecedor || fornecedor.tipo !== "FORNECEDOR") throw erroHttp(404, "Fornecedor não encontrado.");
  return fornecedor;
};

export const obterAcesso = async (req, res) => {
  try {
    res.json(await resumoAcesso(await carregarFornecedor(req.params.id)));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar o acesso do fornecedor");
  }
};

// Itens que o fornecedor traz (e pode ver no portal dele).
export const definirProdutos = async (req, res) => {
  try {
    const fornecedor = await carregarFornecedor(req.params.id);
    const ids = [...new Set((Array.isArray(req.body?.produtoIds) ? req.body.produtoIds : []).map(String))].slice(0, 2000);
    const existentes = ids.length ? await Produto.findAll({ where: { id: ids }, attributes: ["id"] }) : [];
    await fornecedor.update({ produtosFornecidos: existentes.map((p) => p.id) });
    res.json(await resumoAcesso(fornecedor));
  } catch (error) {
    responderErro(res, error, "Erro ao salvar os itens do fornecedor");
  }
};

const senhaProvisoria = () => {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(10), (b) => letras[b % letras.length]).join("");
};

// Cria ou altera o login do fornecedor: e-mail, nova senha (provisória,
// gerada se não informada) e ativo. A senha só volta nesta resposta.
export const salvarAcesso = async (req, res) => {
  try {
    const fornecedor = await carregarFornecedor(req.params.id);
    const corpo = req.body || {};
    const email = String(corpo.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw erroHttp(400, "Informe um e-mail válido para o login.");
    let usuario = await Usuario.findOne({ where: { parceiroId: fornecedor.id, role: "FORNECEDOR" } });
    const outro = await Usuario.findOne({ where: { email } });
    if (outro && outro.id !== usuario?.id) throw erroHttp(409, "Este e-mail já é usado por outra conta do site.");
    let senha = null;
    if (!usuario || corpo.novaSenha) {
      senha = String(corpo.senha || "").trim() || senhaProvisoria();
      if (senha.length < 8) throw erroHttp(400, "A senha deve ter no mínimo 8 caracteres.");
    }
    const dados = {
      email,
      nome: fornecedor.nome,
      ativo: corpo.ativo === undefined ? true : Boolean(corpo.ativo),
      ...(senha ? { senha, trocarSenha: true } : {}),
    };
    if (usuario) await usuario.update(dados);
    else usuario = await Usuario.create({ ...dados, role: "FORNECEDOR", parceiroId: fornecedor.id, permissoes: [] });
    res.json({ ...(await resumoAcesso(fornecedor)), senha });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") return res.status(409).json({ error: "Este e-mail já é usado por outra conta do site." });
    responderErro(res, error, "Erro ao salvar o login do fornecedor");
  }
};
