import crypto from "crypto";
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
import { provedorAtivo, provedorMaquininha } from "./pagamentos/index.js";
import { configPagamentos } from "./pagamentos/config.js";
import {
  FORMAS_PAGAMENTO,
  FORMAS_SHOWROOM,
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
import { contem } from "../utils/busca.js";
import { avisarPedido } from "./whatsappService.js";
import { verificarEstoque } from "./estoqueService.js";

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
export const ehShowroom = (usuario) => usuario?.role === "SHOWROOM";
// Quem tira pedido em nome de clientes (escolhe ou cadastra o cliente).
export const tiraPedidoParaCliente = (usuario) => ehInterno(usuario) || ehShowroom(usuario);

export const formatarNumero = (pedido) =>
  pedido.codigoLegado ||
  (pedido.tipo === "ORCAMENTO" ? String(pedido.numero).padStart(4, "0") : String(pedido.numero));

// Pedido do sistema antigo cujo número já existia aqui recebe número interno a
// partir daqui (e mostra "63127-ANT"); a sequência normal ignora essa faixa.
export const NUMERO_COLISAO_LEGADO = 900000;

// Pedidos (daqui e os que ainda chegam do sistema antigo) seguem uma única
// sequência a partir deste número.
export const PEDIDO_NUMERO_INICIAL = 70000;

// Próximo número sequencial do tipo, sob lock transacional.
export const proximoNumero = async (tipo, transaction) => {
  await sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:chave))", {
    replacements: { chave: `pedido_numero_${tipo}` },
    transaction,
  });
  const maior = await Pedido.max("numero", { where: { tipo, numero: { [Op.lt]: NUMERO_COLISAO_LEGADO } }, transaction });
  const inicial = tipo === "PEDIDO" ? Math.max(PEDIDO_NUMERO_INICIAL, Number(process.env.PEDIDO_NUMERO_INICIAL || 1)) : 1;
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

// Mescla de pagamentos: cada linha traz a parte do valor (sem taxa) que vai
// por aquela forma. A parte no cartão (maquininha, link...) ganha a mesma taxa
// que o pedido inteiro teria nessa forma e parcelas; as outras formas, a taxa
// delas (PIX, boleto etc. = 0). Linha antiga de cartão sem "parcelas" (de
// antes da taxa na mescla) fica sem taxa, para não mudar pedidos já feitos.
const ehCartao = (metodo) => Boolean(FORMAS_PAGAMENTO[metodo]?.cartao) || metodo === "CREDITO_ONLINE";
export const calcularMescla = async (linhas) =>
  Promise.all(
    (Array.isArray(linhas) ? linhas : [])
      .filter((l) => l && numero(l.valor) > 0)
      .map(async (l) => {
        const valor = arredondar(numero(l.valor));
        const cartao = ehCartao(l.metodo);
        const parcelas = cartao && l.parcelas != null ? Math.min(12, Math.max(1, Math.round(Number(l.parcelas) || 1))) : null;
        const percentual = cartao && parcelas == null ? 0 : await percentualTaxa(l.metodo, parcelas);
        const taxa = arredondar((valor * percentual) / 100);
        return { metodo: l.metodo, valor, vencimento: l.vencimento || null, parcelas, percentualTaxa: percentual, taxa, valorCobrado: arredondar(valor + taxa) };
      }),
  );

export const calcularTotais = async ({
  subtotal,
  desconto = 0,
  frete = 0,
  freteAdicional = 0,
  creditoUsado = 0,
  formaPagamento,
  parcelasCartao,
  composicaoPagamento,
}) => {
  const base = Math.max(0, subtotal - desconto - creditoUsado) + frete + freteAdicional;
  if (formaPagamento === "MESCLA") {
    const composicao = await calcularMescla(composicaoPagamento);
    const taxas = arredondar(composicao.reduce((s, l) => s + l.taxa, 0));
    return { taxas, total: arredondar(base + taxas), percentualTaxa: base > 0 ? arredondar((taxas / base) * 100) : 0, composicao };
  }
  const percentual = await percentualTaxa(formaPagamento, parcelasCartao);
  const taxas = arredondar((base * percentual) / 100);
  return { taxas, total: arredondar(base + taxas), percentualTaxa: percentual, composicao: null };
};

// Cliente pode "combinar com o comercial" (A_DEFINIR) quando a entrega é por
// transportadora ou retirada, ou quando não há pagamento online configurado.
export const clientePodeCombinar = (metodoEnvio) =>
  !["PAC", "SEDEX", "BRASPRESS"].includes(metodoEnvio) || !provedorAtivo();

const validarFormaPagamento = (forma, usuario, cliente, metodoEnvio) => {
  const config = FORMAS_PAGAMENTO[forma];
  if (!config) throw erroHttp(400, "Forma de pagamento inválida.");
  if (ehInterno(usuario)) return;
  if (ehShowroom(usuario) && FORMAS_SHOWROOM.includes(forma)) return;
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
// manterLiberados: produtos que já estavam liberados sem estoque no pedido
// (edição feita por quem não é admin não tira a liberação).
export const montarItens = async (itensEntrada, usuario, transaction, { manterLiberados = new Set() } = {}) => {
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
      liberadoSemEstoque:
        Boolean(entrada.liberadoSemEstoque) && (usuario?.role === "ADMIN" || manterLiberados.has(produto.id)),
    };
  });
};

const dadosCliente = async (corpo, usuario) => {
  const entrada = corpo.cliente || {};
  let cliente = null;
  if (ehInterno(usuario) && corpo.clienteId) {
    cliente = await Usuario.findByPk(corpo.clienteId);
  } else if (ehShowroom(usuario) && corpo.clienteId) {
    // Totem: só cadastros de clientes (nunca contas da equipe).
    cliente = await Usuario.findOne({ where: { id: corpo.clienteId, role: "CLIENTE", ativo: true } });
    if (!cliente) throw erroHttp(400, "Cliente não encontrado.");
  } else if (!tiraPedidoParaCliente(usuario)) {
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

// Senha provisória das contas criadas pela equipe ao tirar pedido: aleatória
// para cada conta (nunca uma senha fixa) e trocada no primeiro acesso.
const LETRAS_SENHA = "abcdefghjkmnpqrstuvwxyz23456789";
const gerarSenhaProvisoria = () => Array.from({ length: 10 }, () => LETRAS_SENHA[crypto.randomInt(LETRAS_SENHA.length)]).join("");

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
const garantirClienteCadastrado = async (dados, transaction, { showroom = false } = {}) => {
  const emailInformado = /^\S+@\S+\.\S+$/.test(dados.clienteEmail || "") ? dados.clienteEmail : null;
  const identificador = dados.documento || somenteDigitos(dados.clienteTelefone);
  if (!emailInformado && !identificador) return null;

  const ou = [];
  if (emailInformado) ou.push({ email: emailInformado });
  if (dados.documento) ou.push({ documento: dados.documento });
  // Só vincula a contas de cliente (nunca a contas da equipe). No totem não
  // completa o cadastro existente: quem está na frente da tela não prova que
  // é o dono daquele CPF/e-mail.
  const existente = await Usuario.findOne({ where: { [Op.or]: ou, role: "CLIENTE" }, transaction });
  if (existente && showroom) return { usuario: existente, criado: false };
  if (existente) {
    const faltando = {};
    for (const [campoUsuario, campoPedido] of Object.entries(CAMPOS_ENDERECO)) {
      if (!existente[campoUsuario] && dados[campoPedido]) faltando[campoUsuario] = dados[campoPedido];
    }
    if (Object.keys(faltando).length) await existente.update(faltando, { transaction });
    return { usuario: existente, criado: false };
  }

  const senhaProvisoria = gerarSenhaProvisoria();
  const novo = await Usuario.create(
    {
      nome: dados.clienteNome,
      // Sem e-mail informado, gera um interno só para guardar o cadastro.
      email: emailInformado || `cliente.${identificador}@sememail.girakids.com.br`,
      senha: senhaProvisoria,
      trocarSenha: true,
      role: "CLIENTE",
      ...Object.fromEntries(Object.entries(CAMPOS_ENDERECO).map(([campoUsuario, campoPedido]) => [campoUsuario, dados[campoPedido] || null])),
    },
    { transaction },
  );
  return { usuario: novo, criado: true, emailGerado: !emailInformado, senhaProvisoria };
};

// Cria pedido ou orçamento a partir do checkout / geração de orçamentos.
// Gera a cobrança (PIX/cartão online ou maquininha) ainda dentro da transação
// do pedido: se o banco ou a maquininha recusar, nada é salvo e a tela do
// checkout pergunta se tenta de novo ou troca a forma de pagamento (402).
const cobrarAntesDeSalvar = async (pedidoId, { formaPagamento, maquininhaId, interno, usuario }, transaction) => {
  const online = FORMAS_PAGAMENTO[formaPagamento]?.online;
  const maquininhaEscolhida = interno && formaPagamento === "MAQUININHA" && maquininhaId;
  if (!online && !maquininhaEscolhida) return;
  const pedido = await Pedido.findByPk(pedidoId, { include: INCLUDE_COMPLETO, transaction });
  try {
    if (online) {
      const provedor = provedorAtivo();
      if (!provedor) throw new Error("Pagamento online indisponível no momento.");
      const cobranca = await provedor.criarCobranca({ pedido, metodo: formaPagamento, parcelas: pedido.parcelasCartao });
      await pedido.update(
        {
          pagamentoProvedor: provedor.nome,
          pagamentoReferencia: cobranca.referencia,
          pagamentoLink: cobranca.link || null,
          pagamentoQrCode: cobranca.qrCode || cobranca.copiaECola || null,
          pagamentoExpiraEm: cobranca.expiraEm || null,
        },
        { transaction },
      );
    } else {
      const provedor = provedorMaquininha();
      if (!provedor) throw new Error("Nenhum banco de maquininha configurado na aba Pagamentos.");
      const maquininha = configPagamentos().maquininhas.find((m) => m.id === maquininhaId && m.ativa !== false);
      if (!maquininha) throw new Error("Escolha uma maquininha cadastrada.");
      if (maquininha.provedor !== provedor.nome) throw new Error(`Esta maquininha é ${maquininha.provedor}; o banco de maquininha ativo é ${provedor.rotulo}.`);
      const { referencia } = await provedor.cobrarMaquininha({ pedido, maquininha });
      await pedido.update(
        {
          pagamentoProvedor: provedor.nome,
          pagamentoReferencia: referencia,
          historico: [...(pedido.historico || []), { tipo: "COBRANCA_MAQUININHA", maquininha: maquininha.nome, por: usuario.nome, em: new Date().toISOString() }],
        },
        { transaction },
      );
    }
  } catch (error) {
    console.error("[Pagamentos] Falha ao criar cobrança:", error);
    throw Object.assign(erroHttp(402, error.message || "O pagamento não foi gerado."), { erroPagamento: true });
  }
};

// reabrirId: pedido ainda "Aguardando" que a equipe reabriu no carrinho. O
// mesmo pedido (número, data, histórico) recebe o conteúdo novo do checkout.
export const criarPedido = async (corpo, usuario, tipo = "PEDIDO", { reabrirId = null } = {}) => {
  const interno = ehInterno(usuario);
  if (reabrirId && (!interno || tipo !== "PEDIDO")) throw erroHttp(403, "Só a equipe reabre pedidos.");
  const formaPagamento = corpo.formaPagamento || "A_DEFINIR";
  const showroom = ehShowroom(usuario);
  const { dados: cliente, cliente: cadastroCliente } = await dadosCliente(corpo, usuario);
  validarFormaPagamento(formaPagamento, usuario, cadastroCliente, corpo.metodoEnvio);
  if (showroom && tipo !== "PEDIDO") throw erroHttp(403, "O showroom só tira pedidos.");
  if (formaPagamento === "MESCLA" && !interno) {
    for (const linha of corpo.composicaoPagamento || []) {
      if (linha?.metodo === "MESCLA") throw erroHttp(400, "Forma inválida na mescla de pagamentos.");
      validarFormaPagamento(linha?.metodo, usuario, cadastroCliente, corpo.metodoEnvio);
      if (FORMAS_PAGAMENTO[linha.metodo]?.online) throw erroHttp(400, "Na mescla use formas presenciais (PIX presencial, maquininha, link, a receber...).");
    }
  }

  // Braspress cotada no checkout vira "Transportadora" com a Braspress escolhida.
  if (corpo.metodoEnvio && !["RETIRAR_LOCAL", "TRANSPORTADORA", "PAC", "SEDEX", "BRASPRESS"].includes(corpo.metodoEnvio)) {
    throw erroHttp(400, "Opção de entrega inválida.");
  }
  const viaBraspress = corpo.metodoEnvio === "BRASPRESS";
  const metodoEnvio = viaBraspress ? "TRANSPORTADORA" : corpo.metodoEnvio || (interno ? null : "");
  if (!interno && !metodoEnvio) throw erroHttp(400, "Selecione uma opção de entrega.");
  if (tipo === "PEDIDO" && !interno && !cliente.documento) {
    throw erroHttp(400, "Informe o CPF/CNPJ.");
  }

  let clienteCadastro = null;
  const pedidoCriado = await sequelize.transaction(async (transaction) => {
    let reaberto = null;
    if (reabrirId) {
      const travado = await Pedido.findByPk(reabrirId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!travado || travado.tipo !== "PEDIDO") throw erroHttp(404, "Pedido não encontrado.");
      reaberto = await Pedido.findByPk(reabrirId, { include: INCLUDE_COMPLETO, transaction });
      if (reaberto.statusVendas !== "AGUARDANDO" || reaberto.estoqueBaixado) {
        throw erroHttp(400, "Só dá para reabrir pedido que ainda está aguardando (amarelo).");
      }
      if (reaberto.statusFinanceiro === "PAGO" || (reaberto.parcelas || []).some((p) => p.status === "RECEBIDA")) {
        throw erroHttp(400, "Este pedido já tem pagamento recebido; use a edição simples do pedido.");
      }
      // Devolve o crédito que o pedido tinha usado; o checkout usa de novo se marcado.
      const creditoAnterior = Number(reaberto.creditoUsado || 0);
      if (creditoAnterior > 0 && reaberto.clienteId) {
        const dono = await Usuario.findByPk(reaberto.clienteId, { transaction });
        if (dono) await dono.update({ credito: arredondar(Number(dono.credito || 0) + creditoAnterior) }, { transaction });
        if (cadastroCliente?.id === reaberto.clienteId) cadastroCliente.credito = arredondar(Number(cadastroCliente.credito || 0) + creditoAnterior);
      }
    }
    if ((interno || showroom) && !cliente.clienteId) {
      clienteCadastro = await garantirClienteCadastrado(cliente, transaction, { showroom });
      if (clienteCadastro) cliente.clienteId = clienteCadastro.usuario.id;
    }
    const manterLiberados = new Set((reaberto?.itens || []).filter((i) => i.liberadoSemEstoque).map((i) => i.produtoId));
    const itens = await montarItens(corpo.itens, usuario, transaction, { manterLiberados });
    // Pedido só nasce com estoque para todos os itens (orçamento não reserva).
    if (tipo === "PEDIDO") await verificarEstoque(itens, transaction);
    const subtotal = arredondar(itens.reduce((soma, item) => soma + item.total, 0));
    const pesoTotalGramas = itens.reduce((soma, item) => soma + item.pesoGramas, 0);

    let frete = 0;
    let prazoEntregaDias = null;
    if (metodoEnvio === "PAC" || metodoEnvio === "SEDEX") {
      const { opcoes } = await cotarFrete({ cep: cliente.cep, uf: cliente.estado, itens: corpo.itens, semBraspress: true });
      const opcao = opcoes.find((o) => o.metodo === metodoEnvio);
      if (!opcao?.disponivel) throw erroHttp(400, opcao?.motivo || "Frete indisponível.");
      frete = opcao.valor;
      prazoEntregaDias = opcao.prazoDias;
    }
    if (viaBraspress) {
      const { opcoes } = await cotarFrete({
        cep: cliente.cep,
        uf: cliente.estado,
        itens: corpo.itens,
        documento: cliente.documento,
        braspressAjuste: usuario?.role === "ADMIN" ? corpo.braspressAjuste : null,
      });
      const opcao = opcoes.find((o) => o.metodo === "BRASPRESS");
      if (!opcao?.disponivel) throw erroHttp(400, opcao?.motivo || "Cotação Braspress indisponível; escolha outra entrega.");
      frete = opcao.valor;
      prazoEntregaDias = opcao.prazoDias;
    }

    const desconto = interno ? Math.min(subtotal, Math.max(0, numero(corpo.desconto))) : 0;
    const freteAdicional = interno ? Math.max(0, numero(corpo.freteAdicional)) : 0;
    const creditoDisponivel = Number(cadastroCliente?.credito || 0);
    const creditoUsado = corpo.usarCredito && !showroom
      ? Math.min(creditoDisponivel, Math.max(0, subtotal - desconto))
      : 0;
    const parcelasCartao = corpo.parcelasCartao ? Number(corpo.parcelasCartao) : null;
    const { taxas, total, composicao } = await calcularTotais({
      subtotal,
      desconto,
      frete,
      freteAdicional,
      creditoUsado,
      formaPagamento,
      parcelasCartao,
      composicaoPagamento: corpo.composicaoPagamento,
    });

    const transportadora = viaBraspress
      ? await resolverTransportadora({ nome: "Braspress" }, usuario, transaction)
      : interno && metodoEnvio === "TRANSPORTADORA" ? await resolverTransportadora(corpo.transportadora, usuario, transaction) : null;

    const dadosPedido = {
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
        composicaoPagamento: formaPagamento === "MESCLA" ? composicao : null,
        orcamentoOrigemId: corpo.orcamentoOrigemId || null,
    };
    let pedido;
    if (reaberto) {
      // Mantém número, data, quem criou e histórico; a cobrança antiga deixa
      // de valer (a nova é gerada abaixo, se a forma for online).
      await PedidoItem.destroy({ where: { pedidoId: reaberto.id }, transaction });
      await PedidoParcela.destroy({ where: { pedidoId: reaberto.id }, transaction });
      delete dadosPedido.origemCliente;
      delete dadosPedido.alertaComercial;
      delete dadosPedido.orcamentoOrigemId;
      pedido = await reaberto.update(
        {
          ...dadosPedido,
          pagamentoProvedor: null,
          pagamentoReferencia: null,
          pagamentoLink: null,
          pagamentoQrCode: null,
          pagamentoExpiraEm: null,
          historico: [
            ...(reaberto.historico || []),
            { tipo: "REABERTO", por: usuario.nome, totalAnterior: Number(reaberto.total), totalNovo: total, em: new Date().toISOString() },
          ],
        },
        { transaction },
      );
    } else {
      pedido = await Pedido.create(
        {
          tipo,
          numero: await proximoNumero(tipo, transaction),
          ...dadosPedido,
          criadoPorId: usuario.id,
          criadoPorNome: usuario.nome,
          criadoPorRole: usuario.role,
        },
        { transaction },
      );
    }
    await PedidoItem.bulkCreate(
      itens.map((item) => ({ ...item, pedidoId: pedido.id })),
      { transaction },
    );

    // Mescla: cada forma vira uma parcela em aberto com seu vencimento.
    // A parcela no cartão já vem com a taxa dela (valorCobrado).
    if (tipo === "PEDIDO" && formaPagamento === "MESCLA") {
      await PedidoParcela.bulkCreate(
        composicao.map((linha, indice) => ({
          pedidoId: pedido.id,
          numero: indice + 1,
          valor: linha.valorCobrado,
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

    if (tipo === "PEDIDO") {
      await cobrarAntesDeSalvar(pedido.id, { formaPagamento, maquininhaId: corpo.maquininhaId, interno, usuario }, transaction);
    }

    return pedido;
  });

  const pedido = await Pedido.findByPk(pedidoCriado.id, { include: INCLUDE_COMPLETO });

  // WhatsApp: "recebemos seu pedido" (cliente sozinho ou equipe tirando para ele).
  if (tipo === "PEDIDO" && !reabrirId) avisarPedido(pedido.id, "CRIADO");

  if (clienteCadastro && !(showroom && !clienteCadastro.criado)) {
    pedido.clienteCadastro = {
      criado: clienteCadastro.criado,
      email: clienteCadastro.usuario.email,
      emailGerado: Boolean(clienteCadastro.emailGerado),
      // Senha provisória (só desta conta): aparece uma vez para a equipe
      // passar ao cliente; no totem não aparece.
      senhaPadrao: clienteCadastro.criado && !showroom && !clienteCadastro.emailGerado ? clienteCadastro.senhaProvisoria : null,
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

// Campos só da equipe: custos, anotações internas, quem fez o quê,
// integração com bancos e sistema antigo.
const CAMPOS_INTERNOS = [
  "historico", "custosExtras", "custoExtraTotal", "pagoPor", "pendenciaAbertaPor", "pendenciaQuitadaPor",
  "observacaoQuitacao", "liberadoPor", "observacaoLiberacao", "expedidoPor", "montagemConcluidaPor",
  "observacoesExpedicao", "transportadoraObs", "transportadoraCotacao", "transportadoraCotacaoCom", "canceladoPor",
  "criadoPorId", "criadoPorNome", "criadoPorRole", "legadoId", "legadoAssinatura", "alertaComercial", "alertaVistoEm",
  "alertaVistoPor", "origemCliente", "estoqueBaixado", "cliente",
];
const CAMPOS_INTERNOS_ITEM = ["custoUnitario", "conferido", "conferidoEm", "conferidoPor", "liberadoSemEstoque"];

export const serializarPedido = (pedido, { completo = true, usuario = null } = {}) => {
  const dados = serializarPedidoInterno(pedido, { completo });
  if (!usuario || ehInterno(usuario)) return dados;
  for (const campo of CAMPOS_INTERNOS) delete dados[campo];
  dados.itens = dados.itens.map((item) => {
    const limpo = { ...item };
    for (const campo of CAMPOS_INTERNOS_ITEM) delete limpo[campo];
    return limpo;
  });
  dados.parcelas = (dados.parcelas || []).map(({ usuarioNome, observacao, ...p }) => p);
  return dados;
};

const serializarPedidoInterno = (pedido, { completo = true } = {}) => {
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
      contem("Pedido.clienteNome", busca),
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
