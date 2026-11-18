import { Op, fn, col } from "sequelize";
import { sequelize } from "../database/connection.js";
import {
  Produto,
  Categoria,
  HistoricoPreco,
  Parceiro,
} from "../models/index.js";
import { TIPOS_EMBALAGEM, emBlackFriday, precoAtual } from "../models/Produto.js";
import { movimentar } from "../services/estoqueService.js";
import { verificarImagemEsgotado } from "../services/imagemEsgotadoService.js";
import { lerParametros } from "../services/pedidoCalculoEngine.js";
import { ehInterno } from "../services/pedidoService.js";
import { arredondar, erroHttp, numero, responderErro } from "../utils/helpers.js";
import { contem } from "../utils/busca.js";

const statusEstoque = (p) => {
  const estoque = Number(p.estoque || 0);
  if (estoque <= 0) return "SEM_ESTOQUE";
  if (p.estoqueMinimo != null && estoque <= Number(p.estoqueMinimo)) return "ESTOQUE_BAIXO";
  return "EM_ESTOQUE";
};

const serializarAdmin = (produto) => {
  const p = produto.toJSON();
  const precoVenda = Number(p.precoVenda);
  const custo = p.custo != null ? Number(p.custo) : null;
  const margem = custo != null ? arredondar(precoVenda - custo, 4) : null;
  return {
    ...p,
    precoVenda,
    precoBlackFriday: p.precoBlackFriday != null ? Number(p.precoBlackFriday) : null,
    precoOriginalBlackFriday: p.precoOriginalBlackFriday != null ? Number(p.precoOriginalBlackFriday) : null,
    custo,
    margemValor: margem,
    margemPercentual: custo != null && precoVenda > 0 ? arredondar((margem / precoVenda) * 100) : null,
    statusEstoque: statusEstoque(p),
  };
};

// Preço riscado da Black Friday (só quando é maior que o promocional).
const blackFridayCatalogo = (p) => {
  if (!emBlackFriday(p)) return { blackFriday: false, precoOriginal: null };
  const original = Number(p.precoOriginalBlackFriday) || Number(p.precoVenda);
  return { blackFriday: true, precoOriginal: original > precoAtual(p) ? original : null };
};

const serializarCatalogo = (produto) => {
  const p = produto.toJSON();
  const disponivel = Number(p.estoque) > 0 || p.modoVenda === "ENCOMENDA";
  return {
    id: p.id,
    sku: p.sku,
    nome: p.nome,
    descricao: p.descricao,
    videoUrl: p.videoUrl,
    categoria: p.categoria,
    // Já com a Black Friday aplicada (é o preço cobrado no carrinho).
    precoVenda: precoAtual(p),
    ...blackFridayCatalogo(p),
    unidadesPacote: p.unidadesPacote,
    pesoPacoteGramas: p.pesoPacoteGramas,
    estoque: p.estoque,
    modoVenda: p.modoVenda,
    destaque: p.destaque,
    disponivel,
    imagemUrl: !disponivel && p.imagemSemEstoqueUrl ? p.imagemSemEstoqueUrl : p.imagemUrl,
    // Esgotado sem arte própria de esgotado (ou com a mesma do estoque): o
    // site mostra a foto em preto e branco.
    temImagemEsgotado: Boolean(p.imagemSemEstoqueUrl && p.imagemSemEstoqueUrl !== p.imagemUrl && !p.imagemEsgotadoIgual),
    imagens: p.imagens?.length ? p.imagens : p.imagemUrl ? [p.imagemUrl] : [],
  };
};

const categoriasOcultas = async () =>
  (await Categoria.findAll({ where: { visivel: false } })).map((c) => c.nome);

// ---------------------------------------------------------------------------
// Catálogo público
// ---------------------------------------------------------------------------

// Categoria especial do catálogo: só os itens com Black Friday ativa (eles
// não aparecem em "Todos" nem nas outras categorias, a não ser na busca).
export const CATEGORIA_BLACK_FRIDAY = "Black Friday";
const SQL_BLACK_FRIDAY = `("blackFriday" AND "precoBlackFriday" > 0)`;

export const catalogo = async (req, res) => {
  try {
    const ocultas = await categoriasOcultas();
    const base = {
      arquivado: false,
      ...(ocultas.length ? { categoria: { [Op.notIn]: ocultas } } : {}),
    };

    const semBlackFriday = sequelize.literal(`NOT ${SQL_BLACK_FRIDAY}`);
    const [contagem, totalBlackFriday] = await Promise.all([
      Produto.findAll({
        where: { ...base, [Op.and]: [semBlackFriday] },
      attributes: ["categoria", [fn("COUNT", col("id")), "total"]],
        group: ["categoria"],
        order: [["categoria", "ASC"]],
        raw: true,
      }),
      Produto.count({ where: { ...base, [Op.and]: [sequelize.literal(SQL_BLACK_FRIDAY)] } }),
    ]);

    const where = { ...base };
    const categoria = String(req.query.categoria || "");
    const busca = String(req.query.busca || "").trim();
    if (categoria === CATEGORIA_BLACK_FRIDAY) {
      where[Op.and] = [sequelize.literal(SQL_BLACK_FRIDAY)];
    } else {
      // Categoria oculta não aparece nem pedida pelo nome.
      if (categoria) where.categoria = ocultas.includes(categoria) ? { [Op.in]: [] } : categoria;
      // Black Friday fica só na categoria dela (a busca em "Todos" acha tudo).
      if (categoria || !busca) where[Op.and] = [semBlackFriday];
    }
    if (busca) {
      where[Op.or] = [
        contem("nome", busca),
        contem("descricao", busca),
        contem("categoria", busca),
        { sku: { [Op.iLike]: `%${busca}%` } },
      ];
    }
    const limite = Math.min(Number(req.query.limite) || 12, 100);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const { rows, count } = await Produto.findAndCountAll({
      where,
      // Esgotados sempre no fim (por encomenda conta como disponível).
      order: [
        [sequelize.literal(`CASE WHEN "estoque" > 0 OR "modoVenda" = 'ENCOMENDA' THEN 0 ELSE 1 END`), "ASC"],
        // Black Friday ativa no topo.
        [sequelize.literal(`CASE WHEN "blackFriday" AND "precoBlackFriday" > 0 THEN 0 ELSE 1 END`), "ASC"],
        ["destaque", "DESC"],
        ["nome", "ASC"],
      ],
      limit: limite,
      offset: (pagina - 1) * limite,
    });

    res.json({
      produtos: rows.map(serializarCatalogo),
      total: count,
      pagina,
      paginas: Math.max(1, Math.ceil(count / limite)),
      categorias: contagem
        .filter((c) => c.categoria)
        .map((c) => ({ nome: c.categoria, total: Number(c.total) })),
      totalGeral: contagem.reduce((s, c) => s + Number(c.total), 0),
      categoriaBlackFriday: CATEGORIA_BLACK_FRIDAY,
      totalBlackFriday,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar catálogo");
  }
};

// Caixas cadastradas na Calculadora de Pedidos (para escolher a caixa de
// envio do produto).
export const caixasFrete = async (req, res) => {
  try {
    const { caixas } = await lerParametros();
    res.json(caixas.map(({ altura, largura, comprimento, nome }) => ({ altura, largura, comprimento, nome })));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar as caixas");
  }
};

// Busca rápida (combobox do recebimento, checkout interno, etc.).
export const buscar = async (req, res) => {
  try {
    const busca = String(req.query.busca || "").trim();
    const where = {};
    if (!req.query.incluirArquivados) where.arquivado = false;
    if (busca) {
      where[Op.or] = [
        contem("nome", busca),
        { sku: { [Op.iLike]: `%${busca}%` } },
      ];
    }
    const produtos = await Produto.findAll({
      where,
      order: [["nome", "ASC"]],
      limit: Math.min(Number(req.query.limite) || 30, 200),
    });
    // Custo e margem só para quem cuida de produtos, compras ou financeiro.
    const veCusto = req.usuario?.temPermissao("PRODUTOS", "ENTRADAS", "RECEBIMENTOS", "FINANCEIRO", "COMERCIAL");
    // Preço que vale agora (com Black Friday) para montar pedidos.
    res.json(produtos.map((p) => (veCusto ? { ...serializarAdmin(p), precoVenda: precoAtual(p), ...blackFridayCatalogo(p) } : serializarCatalogo(p))));
  } catch (error) {
    responderErro(res, error, "Erro ao buscar produtos");
  }
};

export const obterPublico = async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw erroHttp(404, "Produto não encontrado.");
    const produto = await Produto.findByPk(req.params.id);
    if (!produto || produto.arquivado || (await categoriasOcultas()).includes(produto.categoria)) throw erroHttp(404, "Produto não encontrado.");
    res.json(serializarCatalogo(produto));
  } catch (error) {
    responderErro(res, error, "Erro ao abrir produto");
  }
};

// ---------------------------------------------------------------------------
// Gerenciar Produtos
// ---------------------------------------------------------------------------

export const listar = async (req, res) => {
  try {
    const where = { arquivado: req.query.arquivados === "true" };
    const lista = (v) => String(v || "").split(",").filter(Boolean);
    if (req.query.tipo) where.tipo = { [Op.in]: lista(req.query.tipo) };
    if (req.query.venda) where.modoVenda = { [Op.in]: lista(req.query.venda) };
    if (req.query.categoria) where.categoria = { [Op.in]: lista(req.query.categoria) };
    if (req.query.destaque === "true") where.destaque = true;
    const busca = String(req.query.busca || "").trim();
    if (busca) {
      where[Op.or] = [
        contem("nome", busca),
        { sku: { [Op.iLike]: `%${busca}%` } },
        contem("categoria", busca),
      ];
    }
    const status = lista(req.query.status);
    if (status.length) {
      const ou = [];
      if (status.includes("SEM_ESTOQUE")) ou.push({ estoque: { [Op.lte]: 0 } });
      if (status.includes("ESTOQUE_BAIXO")) {
        ou.push({ [Op.and]: [{ estoque: { [Op.gt]: 0 } }, sequelize.where(col("estoque"), Op.lte, col("estoqueMinimo"))] });
      }
      if (status.includes("EM_ESTOQUE")) {
        ou.push({
          [Op.and]: [
            { estoque: { [Op.gt]: 0 } },
            { [Op.or]: [{ estoqueMinimo: null }, sequelize.where(col("estoque"), Op.gt, col("estoqueMinimo"))] },
          ],
        });
      }
      where[Op.and] = [...(where[Op.and] || []), { [Op.or]: ou }];
    }

    const limite = Math.min(Number(req.query.limite) || 30, 500);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const ordem = req.query.ordem === "estoque" ? [["estoque", "ASC"]] : [["destaque", "DESC"], ["nome", "ASC"]];
    const { rows, count } = await Produto.findAndCountAll({
      where,
      order: ordem,
      limit: limite,
      offset: (pagina - 1) * limite,
    });

    const [total, semEstoque, baixo] = await Promise.all([
      Produto.count({ where: { arquivado: false } }),
      Produto.count({ where: { arquivado: false, estoque: { [Op.lte]: 0 } } }),
      Produto.count({
        where: {
          arquivado: false,
          estoque: { [Op.gt]: 0 },
          [Op.and]: [sequelize.where(col("estoque"), Op.lte, col("estoqueMinimo"))],
        },
      }),
    ]);

    res.json({
      itens: rows.map(serializarAdmin),
      total: count,
      pagina,
      paginas: Math.max(1, Math.ceil(count / limite)),
      resumo: { total, semEstoque, estoqueBaixo: baixo },
    });
  } catch (error) {
    responderErro(res, error, "Erro ao listar produtos");
  }
};

export const obter = async (req, res) => {
  try {
    const produto = await Produto.findByPk(req.params.id, {
      include: [{ model: Parceiro, as: "fornecedorPreferencial", attributes: ["id", "nome"] }],
    });
    if (!produto) throw erroHttp(404, "Produto não encontrado.");
    const historico = await HistoricoPreco.findAll({
      where: { produtoId: produto.id },
      order: [["createdAt", "DESC"]],
      limit: 5,
    });
    res.json({ ...serializarAdmin(produto), historicoRecente: historico });
  } catch (error) {
    responderErro(res, error, "Erro ao abrir produto");
  }
};

const CAMPOS = [
  "sku", "nome", "descricao", "categoria", "tipo", "componentes", "modoVenda",
  "unidadesPacote", "pesoPacoteGramas", "tipoEmbalagem", "estoqueMinimo",
  "fornecedorPreferencialId", "observacoesCompra", "imagemUrl",
  "imagemSemEstoqueUrl", "destaque", "videoUrl", "blackFriday",
];

// { altura, largura, comprimento } em cm (todos > 0 e até 300) ou null.
const lerMedidas = (valor, rotulo) => {
  if (!valor) return null;
  const m = {};
  for (const lado of ["altura", "largura", "comprimento"]) m[lado] = Math.round(numero(valor[lado]) * 10) / 10;
  const preenchidos = Object.values(m).filter((n) => n > 0).length;
  if (!preenchidos) return null;
  if (preenchidos < 3 || Object.values(m).some((n) => n > 300)) throw erroHttp(400, `${rotulo}: informe altura, largura e comprimento em cm (até 300).`);
  return m;
};

const normalizar = (corpo) => {
  const dados = {};
  for (const campo of CAMPOS) if (corpo[campo] !== undefined) dados[campo] = corpo[campo];
  if (corpo.precoVenda !== undefined) dados.precoVenda = numero(corpo.precoVenda);
  for (const campo of ["precoBlackFriday", "precoOriginalBlackFriday"]) {
    if (corpo[campo] !== undefined) dados[campo] = corpo[campo] === "" || corpo[campo] == null ? null : numero(corpo[campo]);
  }
  if (dados.blackFriday !== undefined) dados.blackFriday = Boolean(dados.blackFriday);
  if (corpo.custo !== undefined) dados.custo = corpo.custo === "" || corpo.custo == null ? null : numero(corpo.custo);
  if (dados.unidadesPacote !== undefined) dados.unidadesPacote = Math.max(1, Math.round(numero(dados.unidadesPacote)));
  if (dados.pesoPacoteGramas !== undefined) dados.pesoPacoteGramas = Math.max(0, Math.round(numero(dados.pesoPacoteGramas)));
  if (dados.estoqueMinimo !== undefined) {
    dados.estoqueMinimo = dados.estoqueMinimo === "" || dados.estoqueMinimo == null ? null : Math.round(numero(dados.estoqueMinimo));
  }
  if (dados.tipoEmbalagem && !TIPOS_EMBALAGEM[dados.tipoEmbalagem]) dados.tipoEmbalagem = null;
  if (corpo.freteMedidas !== undefined) dados.freteMedidas = lerMedidas(corpo.freteMedidas, "Medidas do pacote");
  if (corpo.freteCaixa !== undefined) {
    const caixa = lerMedidas(corpo.freteCaixa, "Caixa de envio");
    if (caixa) {
      caixa.pacotesPorCaixa = Math.round(numero(corpo.freteCaixa.pacotesPorCaixa));
      if (!(caixa.pacotesPorCaixa > 0)) throw erroHttp(400, "Informe quantos pacotes cabem na caixa de envio.");
    }
    dados.freteCaixa = caixa;
  }
  if (dados.fornecedorPreferencialId === "") dados.fornecedorPreferencialId = null;
  if (dados.categoria) dados.categoria = String(dados.categoria).trim();
  // Só links http(s) (nada de "javascript:").
  if (dados.videoUrl !== undefined) {
    const url = String(dados.videoUrl || "").trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw erroHttp(400, "Link do vídeo inválido. Cole o endereço do YouTube (https://...).");
    dados.videoUrl = url || null;
  }
  // Carrossel: lista de URLs; a primeira vira a capa.
  if (Array.isArray(corpo.imagens)) {
    dados.imagens = corpo.imagens.filter((url) => typeof url === "string" && url.trim()).slice(0, 15);
    dados.imagemUrl = dados.imagens[0] || null;
  }
  return dados;
};

const garantirCategoria = async (nome, transaction) => {
  if (!nome) return;
  await Categoria.findOrCreate({ where: { nome }, defaults: { nome }, transaction });
};

const validar = (dados, novo) => {
  if (novo || dados.sku !== undefined) if (!String(dados.sku || "").trim()) throw erroHttp(400, "SKU é obrigatório.");
  if (novo || dados.nome !== undefined) if (!String(dados.nome || "").trim()) throw erroHttp(400, "Nome é obrigatório.");
  if (novo && !dados.categoria) throw erroHttp(400, "Categoria é obrigatória.");
  if (dados.precoVenda !== undefined && dados.precoVenda < 0) throw erroHttp(400, "Valor de venda inválido.");
};

// Com a Black Friday ligada: precisa do preço promocional, menor que o riscado.
const validarBlackFriday = (p) => {
  if (!p.blackFriday) return;
  const promocional = Number(p.precoBlackFriday);
  if (!(promocional > 0)) throw erroHttp(400, "Informe o valor com desconto da Black Friday.");
  const original = Number(p.precoOriginalBlackFriday) || Number(p.precoVenda);
  if (original <= promocional) throw erroHttp(400, "O valor riscado da Black Friday precisa ser maior que o valor com desconto.");
};

export const criar = async (req, res) => {
  try {
    const dados = normalizar(req.body || {});
    validar(dados, true);
    validarBlackFriday(dados);
    const existente = await Produto.findOne({ where: { sku: dados.sku, arquivado: false } });
    if (existente) throw erroHttp(409, "Já existe um produto ativo com este SKU.");
    const produto = await sequelize.transaction(async (transaction) => {
      await garantirCategoria(dados.categoria, transaction);
      const novo = await Produto.create(
        { ...dados, estoque: 0, criadoPor: req.usuario.nome, atualizadoPor: req.usuario.nome },
        { transaction },
      );
      const estoqueInicial = Math.round(numero(req.body?.estoque));
      if (estoqueInicial > 0) {
        await movimentar({
          produto: novo,
          delta: estoqueInicial,
          tipo: "AJUSTE",
          motivo: "Estoque inicial do cadastro",
          usuario: req.usuario,
          transaction,
        });
      }
      return novo;
    });
    res.locals.entityId = produto.id;
    const criado = await Produto.findByPk(produto.id);
    await verificarImagemEsgotado(criado).catch(() => {});
    res.status(201).json(serializarAdmin(criado));
  } catch (error) {
    responderErro(res, error, "Erro ao criar produto");
  }
};

export const atualizar = async (req, res) => {
  try {
    const dados = normalizar(req.body || {});
    validar(dados, false);
    await sequelize.transaction(async (transaction) => {
      const produto = await Produto.findByPk(req.params.id, { transaction });
      if (!produto) throw erroHttp(404, "Produto não encontrado.");
      await garantirCategoria(dados.categoria, transaction);
      validarBlackFriday({ ...produto.toJSON(), ...dados });
      const historico = [];
      if (dados.precoVenda !== undefined && Number(produto.precoVenda) !== dados.precoVenda) {
        historico.push({ campo: "VENDA", valorAnterior: produto.precoVenda, valorNovo: dados.precoVenda });
      }
      if (dados.custo !== undefined && Number(produto.custo ?? NaN) !== dados.custo && !(produto.custo == null && dados.custo == null)) {
        historico.push({ campo: "CUSTO", valorAnterior: produto.custo, valorNovo: dados.custo });
      }
      await produto.update({ ...dados, atualizadoPor: req.usuario.nome }, { transaction });
      if (historico.length) {
        await HistoricoPreco.bulkCreate(
          historico.map((h) => ({ ...h, produtoId: produto.id, origem: "EDICAO", usuarioNome: req.usuario.nome })),
          { transaction },
        );
      }
    });
    const atualizado = await Produto.findByPk(req.params.id);
    await verificarImagemEsgotado(atualizado).catch(() => {});
    res.json(serializarAdmin(atualizado));
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar produto");
  }
};

export const ajustarEstoque = async (req, res) => {
  try {
    const novaQuantidade = Math.round(Number(req.body?.quantidade));
    // Motivo opcional: o ajuste fica no histórico mesmo sem explicação.
    const motivo = String(req.body?.motivo || "").trim() || "Ajuste manual de estoque";
    if (!Number.isFinite(novaQuantidade) || novaQuantidade < 0) throw erroHttp(400, "Quantidade inválida.");
    await sequelize.transaction(async (transaction) => {
      const produto = await Produto.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!produto) throw erroHttp(404, "Produto não encontrado.");
      const delta = novaQuantidade - Number(produto.estoque);
      if (!delta) return;
      await movimentar({ produto, delta, tipo: "AJUSTE", motivo, usuario: req.usuario, transaction });
    });
    res.json(serializarAdmin(await Produto.findByPk(req.params.id)));
  } catch (error) {
    responderErro(res, error, "Erro ao ajustar estoque");
  }
};

export const arquivar = async (req, res) => {
  try {
    const produto = await Produto.findByPk(req.params.id);
    if (!produto) throw erroHttp(404, "Produto não encontrado.");
    await produto.update({ arquivado: req.body?.arquivado !== false, atualizadoPor: req.usuario.nome });
    res.json(serializarAdmin(produto));
  } catch (error) {
    responderErro(res, error, "Erro ao arquivar produto");
  }
};

export const historicoPrecos = async (req, res) => {
  try {
    const historico = await HistoricoPreco.findAll({
      where: { produtoId: req.params.id },
      order: [["createdAt", "DESC"]],
      limit: 200,
    });
    res.json(historico);
  } catch (error) {
    responderErro(res, error, "Erro ao carregar histórico");
  }
};

// Importação em massa (linhas já lidas do CSV pelo frontend). Atualiza pelo
// SKU quando existir, senão cria.
export const importar = async (req, res) => {
  try {
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    if (!linhas.length) throw erroHttp(400, "Nenhuma linha para importar.");
    const resultado = { criados: 0, atualizados: 0, erros: [] };
    for (const [indice, linha] of linhas.entries()) {
      try {
        const dados = normalizar(linha);
        if (!dados.sku || !dados.nome) throw new Error("SKU e nome são obrigatórios");
        await sequelize.transaction(async (transaction) => {
          await garantirCategoria(dados.categoria, transaction);
          const existente = await Produto.findOne({ where: { sku: String(dados.sku) }, transaction });
          if (existente) {
            await existente.update({ ...dados, atualizadoPor: req.usuario.nome }, { transaction });
            resultado.atualizados += 1;
          } else {
            const novo = await Produto.create(
              { ...dados, estoque: 0, criadoPor: req.usuario.nome, atualizadoPor: req.usuario.nome },
              { transaction },
            );
            const estoque = Math.round(numero(linha.estoque));
            if (estoque > 0) {
              await movimentar({ produto: novo, delta: estoque, tipo: "AJUSTE", motivo: "Importação CSV", usuario: req.usuario, transaction });
            }
            resultado.criados += 1;
          }
        });
      } catch (erro) {
        resultado.erros.push({ linha: indice + 2, erro: erro.message });
      }
    }
    res.json(resultado);
  } catch (error) {
    responderErro(res, error, "Erro ao importar produtos");
  }
};

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

export const listarCategorias = async (req, res) => {
  try {
    const [categorias, contagem] = await Promise.all([
      Categoria.findAll({ order: [["nome", "ASC"]] }),
      Produto.findAll({
        where: { arquivado: false },
        attributes: ["categoria", [fn("COUNT", col("id")), "total"]],
        group: ["categoria"],
        raw: true,
      }),
    ]);
    const porNome = new Map(contagem.map((c) => [c.categoria, Number(c.total)]));
    res.json(categorias.map((c) => ({ ...c.toJSON(), totalProdutos: porNome.get(c.nome) || 0 })));
  } catch (error) {
    responderErro(res, error, "Erro ao listar categorias");
  }
};

export const salvarCategoria = async (req, res) => {
  try {
    const nome = String(req.body?.nome || "").trim();
    if (req.params.id) {
      const categoria = await Categoria.findByPk(req.params.id);
      if (!categoria) throw erroHttp(404, "Categoria não encontrada.");
      await sequelize.transaction(async (transaction) => {
        if (nome && nome !== categoria.nome) {
          await Produto.update({ categoria: nome }, { where: { categoria: categoria.nome }, transaction });
        }
        await categoria.update(
          { ...(nome ? { nome } : {}), ...(req.body?.visivel !== undefined ? { visivel: Boolean(req.body.visivel) } : {}) },
          { transaction },
        );
      });
      return res.json(categoria);
    }
    if (!nome) throw erroHttp(400, "Informe o nome da categoria.");
    const [categoria] = await Categoria.findOrCreate({ where: { nome }, defaults: { nome } });
    res.status(201).json(categoria);
  } catch (error) {
    responderErro(res, error, "Erro ao salvar categoria");
  }
};

export const tiposEmbalagem = (req, res) => res.json(TIPOS_EMBALAGEM);
