import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import {
  Pedido,
  PedidoItem,
  PedidoParcela,
  PedidoCustoExtra,
  Parceiro,
  Produto,
  Usuario,
  Categoria,
} from "../models/index.js";
import { lerConfiguracao } from "../models/Configuracao.js";
import { cotarFrete } from "./freteService.js";
import { provedorAtivo } from "./pagamentos/index.js";
import {
  FORMAS_PAGAMENTO,
  TAXAS_CARTAO_PADRAO,
} from "../utils/formasPagamento.js";
import {
  arredondar,
  documentoValido,
  erroHttp,
  hojeISO,
  numero,
  somenteDigitos,
} from "../utils/helpers.js";

// Itens trazem a capa atual do produto para quem não tem imagem própria
// (itens antigos da loja anterior).
export const INCLUDE_COMPLETO = [
  {
    model: PedidoItem,
    as: "itens",
    include: [{ model: Produto, as: "produto", attributes: ["imagemUrl", "imagens"] }],
  },
  { model: PedidoParcela, as: "parcelas" },
  { model: PedidoCustoExtra, as: "custosExtras" },
];

export const ehInterno = (usuario) => ["ADMIN", "FUNCIONARIO"].includes(usuario?.role);

export const formatarNumero = (pedido) =>
  pedido.codigoLegado ||
  (pedido.tipo === "ORCAMENTO" ? String(pedido.numero).padStart(4, "0") : String(pedido.numero));

// Próximo número sequencial do tipo, sob lock transacional.
const proximoNumero = async (tipo, transaction) => {
  await sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:chave))", {
    replacements: { chave: `pedido_numero_${tipo}` },
    transaction,
  });
  const maior = await Pedido.max("numero", { where: { tipo }, transaction });
  const inicial = tipo === "PEDIDO" ? Number(process.env.PEDIDO_NUMERO_INICIAL || 1) : 1;
  return Math.max(Number(maior || 0) + 1, inicial);
};

// Taxa (%) cobrada na forma de pagamento escolhida.
export const percentualTaxa = async (forma, parcelasCartao) => {
  const config = FORMAS_PAGAMENTO[forma];
  if (!config) return 0;
  if (config.cartao || forma === "CREDITO_ONLINE") {
    const tabela = (await lerConfiguracao("taxasCartao")) || TAXAS_CARTAO_PADRAO;
    return Number(tabela[parcelasCartao || 1] ?? tabela[1] ?? 0);
  }
  const taxas = (await lerConfiguracao("taxasFormas")) || {};
  return Number(taxas[forma] ?? config.taxa ?? 0);
};

export const calcularTotais = async ({
  subtotal,
  desconto = 0,
  frete = 0,
  freteAdicional = 0,
  creditoUsado = 0,
  formaPagamento,
  parcelasCartao,
}) => {
  const base = Math.max(0, subtotal - desconto - creditoUsado) + frete + freteAdicional;
  const percentual = await percentualTaxa(formaPagamento, parcelasCartao);
  const taxas = arredondar((base * percentual) / 100);
  return { taxas, total: arredondar(base + taxas), percentualTaxa: percentual };
};

// Cliente pode "combinar com o comercial" (A_DEFINIR) quando a entrega é por
// transportadora ou retirada, ou quando não há pagamento online configurado.
export const clientePodeCombinar = (metodoEnvio) =>
  !["PAC", "SEDEX"].includes(metodoEnvio) || !provedorAtivo();

const validarFormaPagamento = (forma, usuario, cliente, metodoEnvio) => {
  const config = FORMAS_PAGAMENTO[forma];
  if (!config) throw erroHttp(400, "Forma de pagamento inválida.");
  if (ehInterno(usuario)) return;
  if (forma === "A_DEFINIR" && clientePodeCombinar(metodoEnvio)) return;
  if (config.admin) throw erroHttp(403, "Forma de pagamento disponível só para a equipe.");
  if (config.outros && !cliente?.outrosPagamentos) {
    throw erroHttp(403, "Esta forma de pagamento não está liberada para sua conta.");
  }
  if (config.online && !provedorAtivo()) {
    throw erroHttp(400, "Pagamentos online estão desabilitados no momento.");
  }
};

// Monta itens a partir do catálogo atual. A equipe pode informar "novo
// valor" (precoUnitario) por item; o cliente sempre paga o preço do cadastro.
export const montarItens = async (itensEntrada, usuario, transaction) => {
  if (!Array.isArray(itensEntrada) || !itensEntrada.length) {
    throw erroHttp(400, "Adicione produtos ao carrinho.");
  }
  const ids = itensEntrada.map((item) => item.produtoId);
  const produtos = await Produto.findAll({ where: { id: ids }, transaction });
  const porId = new Map(produtos.map((p) => [p.id, p]));
  const categoriasOcultas = new Set(
    (await Categoria.findAll({ where: { visivel: false }, transaction })).map((c) => c.nome),
  );

  return itensEntrada.map((entrada) => {
    const produto = porId.get(entrada.produtoId);
    if (!produto) throw erroHttp(400, "Produto do carrinho não encontrado.");
    if (!ehInterno(usuario) && (produto.arquivado || categoriasOcultas.has(produto.categoria))) {
      throw erroHttp(400, `${produto.nome} não está mais disponível.`);
    }
    const quantidade = Math.round(Number(entrada.quantidade));
    if (!Number.isFinite(quantidade) || quantidade < 1) {
      throw erroHttp(400, `Quantidade inválida para ${produto.nome}.`);
    }
    const precoUnitario =
      ehInterno(usuario) && entrada.precoUnitario != null && entrada.precoUnitario !== ""
        ? numero(entrada.precoUnitario)
        : Number(produto.precoVenda);
    const unidadesPacote = Number(produto.unidadesPacote || 1);
    return {
      produtoId: produto.id,
      nome: produto.nome,
      sku: produto.sku,
      categoria: produto.categoria,
      imagemUrl: produto.imagemUrl,
      unidadesPacote,
      quantidade,
      precoUnitario,
      custoUnitario: produto.custo,
      total: arredondar(precoUnitario * unidadesPacote * quantidade),
      pesoGramas: quantidade * Number(produto.pesoPacoteGramas || 0),
      sobEncomenda: produto.modoVenda === "ENCOMENDA",
    };
  });
};

const dadosCliente = async (corpo, usuario) => {
  const entrada = corpo.cliente || {};
  let cliente = null;
  if (ehInterno(usuario) && corpo.clienteId) {
    cliente = await Usuario.findByPk(corpo.clienteId);
  } else if (!ehInterno(usuario)) {
    cliente = usuario;
  }

  const documento = somenteDigitos(entrada.documento || cliente?.documento);
  const dados = {
    clienteId: cliente?.id || null,
    clienteNome: String(entrada.nome || cliente?.nome || "").trim(),
    clienteEmail: String(entrada.email || cliente?.email || "").trim().toLowerCase() || null,
    clienteTelefone: entrada.telefone || cliente?.telefone || null,
    documentoTipo: documento.length === 14 ? "CNPJ" : documento.length === 11 ? "CPF" : null,
    documento: documento || null,
    cep: somenteDigitos(entrada.cep || cliente?.cep) || null,
    rua: entrada.rua ?? cliente?.rua ?? null,
    numeroEndereco: entrada.numero ?? cliente?.numero ?? null,
    complemento: entrada.complemento ?? cliente?.complemento ?? null,
    bairro: entrada.bairro ?? cliente?.bairro ?? null,
    cidade: entrada.cidade ?? cliente?.cidade ?? null,
    estado: String(entrada.estado || cliente?.estado || "").toUpperCase().slice(0, 2) || null,
  };
  if (!dados.clienteNome) throw erroHttp(400, "Informe o nome do cliente.");
  if (dados.documento && !documentoValido(dados.documento)) {
    throw erroHttp(400, "CPF/CNPJ inválido.");
  }
  return { dados, cliente };
};

// Transportadora escolhida no checkout da equipe: cadastrada (id) ou vinda da
// planilha/busca na web (nome) — nesse caso é cadastrada em Parceiros.
export const textoCurto = (valor, max) => String(valor ?? "").trim().slice(0, max) || null;

export const resolverTransportadora = async (escolha, usuario, transaction) => {
  if (!escolha || (!escolha.id && !String(escolha.nome || "").trim())) return null;
  if (escolha.id) {
    const existente = await Parceiro.findByPk(escolha.id, { transaction });
    if (existente) return existente;
  }
  const nome = String(escolha.nome).trim().slice(0, 200);
  const mesmoNome = await Parceiro.findOne({ where: { tipo: "TRANSPORTADORA", nome: { [Op.iLike]: nome } }, transaction });
  if (mesmoNome) return mesmoNome;
  return Parceiro.create(
    {
      tipo: "TRANSPORTADORA",
      nome,
      telefone: escolha.telefone || null,
      documento: escolha.documento || null,
      cidade: escolha.cidade || null,
      observacoes: escolha.observacao ? String(escolha.observacao).slice(0, 500) : "Cadastrada ao tirar um pedido",
      criadoPor: usuario.nome,
    },
    { transaction },
  );
};

// Senha inicial das contas criadas pela equipe ao tirar pedido.
export const SENHA_PADRAO_CLIENTE = () => process.env.SENHA_PADRAO_CLIENTE || "12345678";

const CAMPOS_ENDERECO = {
  telefone: "clienteTelefone",
  documento: "documento",
  documentoTipo: "documentoTipo",
  cep: "cep",
  rua: "rua",
  numero: "numeroEndereco",
  complemento: "complemento",
  bairro: "bairro",
  cidade: "cidade",
  estado: "estado",
};

// Equipe tirando pedido para cliente sem cadastro: vincula ao cliente que já
// existe (mesmo e-mail ou CPF/CNPJ), completando o que estiver vazio, ou cria
// a conta com os dados do pedido e a senha padrão. Assim, da próxima vez o
// cliente aparece na busca e os dados são preenchidos sozinhos.
const garantirClienteCadastrado = async (dados, transaction) => {
  const emailInformado = /^\S+@\S+\.\S+$/.test(dados.clienteEmail || "") ? dados.clienteEmail : null;
  const identificador = dados.documento || somenteDigitos(dados.clienteTelefone);
  if (!emailInformado && !identificador) return null;

  const ou = [];
  if (emailInformado) ou.push({ email: emailInformado });
  if (dados.documento) ou.push({ documento: dados.documento });
  const existente = await Usuario.findOne({ where: { [Op.or]: ou }, transaction });
  if (existente) {
    const faltando = {};
    for (const [campoUsuario, campoPedido] of Object.entries(CAMPOS_ENDERECO)) {
      if (!existente[campoUsuario] && dados[campoPedido]) faltando[campoUsuario] = dados[campoPedido];
    }
    if (Object.keys(faltando).length) await existente.update(faltando, { transaction });
    return { usuario: existente, criado: false };
  }

  const novo = await Usuario.create(
    {
      nome: dados.clienteNome,
      // Sem e-mail informado, gera um interno só para guardar o cadastro.
      email: emailInformado || `cliente.${identificador}@sememail.girakids.com.br`,
      senha: SENHA_PADRAO_CLIENTE(),
      role: "CLIENTE",
      ...Object.fromEntries(Object.entries(CAMPOS_ENDERECO).map(([campoUsuario, campoPedido]) => [campoUsuario, dados[campoPedido] || null])),
    },
    { transaction },
  );
  return { usuario: novo, criado: true, emailGerado: !emailInformado };
};

// Cria pedido ou orçamento a partir do checkout / geração de orçamentos.
export const criarPedido = async (corpo, usuario, tipo = "PEDIDO") => {
  const interno = ehInterno(usuario);
  const formaPagamento = corpo.formaPagamento || "A_DEFINIR";
  const { dados: cliente, cliente: cadastroCliente } = await dadosCliente(corpo, usuario);
  validarFormaPagamento(formaPagamento, usuario, cadastroCliente, corpo.metodoEnvio);

  const metodoEnvio = corpo.metodoEnvio || (interno ? null : "");
  if (!interno && !metodoEnvio) throw erroHttp(400, "Selecione uma opção de entrega.");
  if (tipo === "PEDIDO" && !interno && !cliente.documento) {
    throw erroHttp(400, "Informe o CPF/CNPJ.");
  }

  let clienteCadastro = null;
  const pedidoCriado = await sequelize.transaction(async (transaction) => {
    if (interno && !cliente.clienteId) {
      clienteCadastro = await garantirClienteCadastrado(cliente, transaction);
      if (clienteCadastro) cliente.clienteId = clienteCadastro.usuario.id;
    }
    const itens = await montarItens(corpo.itens, usuario, transaction);
    const subtotal = arredondar(itens.reduce((soma, item) => soma + item.total, 0));
    const pesoTotalGramas = itens.reduce((soma, item) => soma + item.pesoGramas, 0);

    let frete = 0;
    let prazoEntregaDias = null;
    if (metodoEnvio === "PAC" || metodoEnvio === "SEDEX") {
      const { opcoes } = await cotarFrete({ cep: cliente.cep, uf: cliente.estado, itens: corpo.itens });
      const opcao = opcoes.find((o) => o.metodo === metodoEnvio);
      if (!opcao?.disponivel) throw erroHttp(400, opcao?.motivo || "Frete indisponível.");
      frete = opcao.valor;
      prazoEntregaDias = opcao.prazoDias;
    }

    const desconto = interno ? Math.min(subtotal, Math.max(0, numero(corpo.desconto))) : 0;
    const freteAdicional = interno ? Math.max(0, numero(corpo.freteAdicional)) : 0;
    const creditoDisponivel = Number(cadastroCliente?.credito || 0);
    const creditoUsado = corpo.usarCredito
      ? Math.min(creditoDisponivel, Math.max(0, subtotal - desconto))
      : 0;
    const parcelasCartao = corpo.parcelasCartao ? Number(corpo.parcelasCartao) : null;
    const { taxas, total } = await calcularTotais({
      subtotal,
      desconto,
      frete,
      freteAdicional,
      creditoUsado,
      formaPagamento,
      parcelasCartao,
    });

    const transportadora = interno && metodoEnvio === "TRANSPORTADORA" ? await resolverTransportadora(corpo.transportadora, usuario, transaction) : null;

    const pedido = await Pedido.create(
      {
        tipo,
        numero: await proximoNumero(tipo, transaction),
        transportadoraId: transportadora?.id || null,
        transportadoraNome: transportadora?.nome || null,
        transportadoraObs: transportadora ? corpo.transportadoraObs || null : null,
        transportadoraCotacao: transportadora ? textoCurto(corpo.transportadoraCotacao, 60) : null,
        transportadoraCotacaoCom: transportadora ? textoCurto(corpo.transportadoraCotacaoCom, 150) : null,
        ...cliente,
        origemCliente: interno ? "ADMIN" : "CLIENTE",
        alertaComercial: !interno && tipo === "PEDIDO",
        metodoEnvio: metodoEnvio || null,
        frete,
        freteAdicional,
        prazoEntregaDias,
        pesoTotalGramas,
        observacoes: corpo.observacoes || null,
        subtotal,
        desconto,
        taxas,
        creditoUsado,
        total,
        formaPagamento,
        parcelasCartao,
        composicaoPagamento: formaPagamento === "MESCLA" ? corpo.composicaoPagamento || [] : null,
        orcamentoOrigemId: corpo.orcamentoOrigemId || null,
        criadoPorId: usuario.id,
        criadoPorNome: usuario.nome,
        criadoPorRole: usuario.role,
      },
      { transaction },
    );
    await PedidoItem.bulkCreate(
      itens.map((item) => ({ ...item, pedidoId: pedido.id })),
      { transaction },
    );

    // Mescla: cada forma vira uma parcela em aberto com seu vencimento.
    if (tipo === "PEDIDO" && formaPagamento === "MESCLA") {
      const linhas = (corpo.composicaoPagamento || []).filter((l) => numero(l.valor) > 0);
      await PedidoParcela.bulkCreate(
        linhas.map((linha, indice) => ({
          pedidoId: pedido.id,
          numero: indice + 1,
          valor: numero(linha.valor),
          metodoPrevisto: linha.metodo,
          vencimento: linha.vencimento || hojeISO(),
          usuarioNome: usuario.nome,
        })),
        { transaction },
      );
    }

    if (creditoUsado > 0 && cadastroCliente && tipo === "PEDIDO") {
      await cadastroCliente.update(
        { credito: arredondar(creditoDisponivel - creditoUsado) },
        { transaction },
      );
    }

    return pedido;
  });

  let pedido = await Pedido.findByPk(pedidoCriado.id, { include: INCLUDE_COMPLETO });

  // Cobrança online no banco configurado.
  if (tipo === "PEDIDO" && FORMAS_PAGAMENTO[formaPagamento]?.online) {
    const provedor = provedorAtivo();
    try {
      const cobranca = await provedor.criarCobranca({
        pedido,
        metodo: formaPagamento,
        parcelas: pedido.parcelasCartao,
      });
      await pedido.update({
        pagamentoProvedor: provedor.nome,
        pagamentoReferencia: cobranca.referencia,
        pagamentoLink: cobranca.link || null,
        pagamentoQrCode: cobranca.qrCode || cobranca.copiaECola || null,
        pagamentoExpiraEm: cobranca.expiraEm || null,
      });
    } catch (error) {
      console.error("[Pagamentos] Falha ao criar cobrança:", error);
      await pedido.update({
        historico: [
          ...pedido.historico,
          { tipo: "ERRO_COBRANCA", mensagem: error.message, em: new Date() },
        ],
      });
    }
    pedido = await Pedido.findByPk(pedido.id, { include: INCLUDE_COMPLETO });
  }

  if (clienteCadastro) {
    pedido.clienteCadastro = {
      criado: clienteCadastro.criado,
      email: clienteCadastro.usuario.email,
      emailGerado: Boolean(clienteCadastro.emailGerado),
      senhaPadrao: clienteCadastro.criado ? SENHA_PADRAO_CLIENTE() : null,
    };
  }
  return pedido;
};

// ---------------------------------------------------------------------------
// Serialização para o frontend
// ---------------------------------------------------------------------------

export const statusFinanceiroEfetivo = (pedido) => {
  if (pedido.statusFinanceiro !== "AGUARDANDO_PAGAMENTO") return pedido.statusFinanceiro;
  const hoje = hojeISO();
  const atrasada = (pedido.parcelas || []).some(
    (p) => p.status === "ABERTA" && p.vencimento && p.vencimento < hoje,
  );
  return atrasada ? "ATRASADO" : "AGUARDANDO_PAGAMENTO";
};

export const totalRecebido = (pedido) =>
  arredondar(
    (pedido.parcelas || [])
      .filter((p) => p.status === "RECEBIDA")
      .reduce((soma, p) => soma + Number(p.valor), 0),
  );

export const serializarPedido = (pedido, { completo = true } = {}) => {
  const json = pedido.toJSON();
  const itens = (json.itens || []).map(({ produto, ...item }) => ({
    ...item,
    imagemUrl: item.imagemUrl || produto?.imagemUrl || null,
    imagens: produto?.imagens?.length ? produto.imagens : [item.imagemUrl || produto?.imagemUrl].filter(Boolean),
    precoUnitario: Number(item.precoUnitario),
    custoUnitario: item.custoUnitario != null ? Number(item.custoUnitario) : null,
    total: Number(item.total),
  }));
  const conferidos = itens.filter((item) => item.conferido).length;
  const base = {
    ...json,
    numeroFormatado: formatarNumero(pedido),
    subtotal: Number(json.subtotal),
    desconto: Number(json.desconto),
    taxas: Number(json.taxas),
    frete: Number(json.frete),
    freteAdicional: Number(json.freteAdicional),
    creditoUsado: Number(json.creditoUsado),
    total: Number(json.total),
    pendenciaValor: json.pendenciaValor != null ? Number(json.pendenciaValor) : null,
    statusFinanceiroEfetivo: statusFinanceiroEfetivo(pedido),
    totalRecebido: totalRecebido(pedido),
    quantidadeItens: itens.length,
    checklist: { conferidos, total: itens.length, completo: itens.length > 0 && conferidos === itens.length },
    custosExtras: (json.custosExtras || [])
      .map((c) => ({ ...c, valor: Number(c.valor) }))
      .sort((a, b) => String(b.data).localeCompare(String(a.data))),
    custoExtraTotal: arredondar((json.custosExtras || []).reduce((s, c) => s + Number(c.valor), 0)),
    parcelas: (json.parcelas || [])
      .map((p) => ({ ...p, valor: Number(p.valor) }))
      .sort((a, b) => a.numero - b.numero),
  };
  if (!completo) {
    delete base.historico;
  }
  base.itens = itens;
  return base;
};

// Filtros comuns da listagem (Time de Vendas, Time Financeiro, expedição).
export const montarFiltroPedidos = (query) => {
  const where = {};
  const and = [];
  where.tipo = query.tipo === "ORCAMENTO" ? "ORCAMENTO" : "PEDIDO";

  if (query.inicio) and.push({ createdAt: { [Op.gte]: new Date(`${query.inicio}T00:00:00.000-03:00`) } });
  if (query.fim) and.push({ createdAt: { [Op.lte]: new Date(`${query.fim}T23:59:59.999-03:00`) } });

  const lista = (valor) => String(valor || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (query.formas) and.push({ formaPagamento: { [Op.in]: lista(query.formas) } });
  if (query.envio) and.push({ metodoEnvio: { [Op.in]: lista(query.envio) } });
  if (query.vendas) and.push({ statusVendas: { [Op.in]: lista(query.vendas) } });
  if (query.expedicao) and.push({ statusExpedicao: { [Op.in]: lista(query.expedicao) } });
  if (query.financeiro) {
    const financeiro = lista(query.financeiro).filter((s) => s !== "ATRASADO");
    const ou = [];
    if (financeiro.length) ou.push({ statusFinanceiro: { [Op.in]: financeiro } });
    if (lista(query.financeiro).includes("ATRASADO")) {
      ou.push(
        sequelize.literal(
          `("Pedido"."statusFinanceiro" = 'AGUARDANDO_PAGAMENTO' AND EXISTS (SELECT 1 FROM pedido_parcelas pp WHERE pp."pedidoId" = "Pedido".id AND pp.status = 'ABERTA' AND pp.vencimento < CURRENT_DATE))`,
        ),
      );
    }
    if (ou.length) and.push({ [Op.or]: ou });
  }

  const busca = String(query.busca || "").trim();
  if (busca.length >= 2) {
    const termo = `%${busca}%`;
    const ou = [
      { clienteNome: { [Op.iLike]: termo } },
      { clienteEmail: { [Op.iLike]: termo } },
      { documento: { [Op.iLike]: `%${somenteDigitos(busca) || busca}%` } },
      { codigoLegado: { [Op.iLike]: `%${busca}%` } },
    ];
    if (/^\d+$/.test(busca)) ou.push({ numero: Number(busca) });
    and.push({ [Op.or]: ou });
  }

  if (and.length) where[Op.and] = and;
  return where;
};
