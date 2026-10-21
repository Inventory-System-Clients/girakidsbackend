import { Op } from "sequelize";
import { Pedido, PedidoItem, Produto, Usuario } from "../models/index.js";
import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";
import { CAMPO_CALCULADORA_POR_EMBALAGEM } from "../services/freteService.js";
import { ENDERECO_LOJA_PADRAO } from "../utils/formasPagamento.js";
import { responderErro, erroHttp, dataISO } from "../utils/helpers.js";

// Dados de um pedido da própria loja para as ferramentas do Comercial:
// Calculadora de Pedidos (quantidades por tipo de embalagem), Pedidos e Notas
// Fiscais (cliente/número/data/valor) e Busca de Transportadoras (destino e
// peso) — antes isso era digitado à mão a partir da loja antiga.
export const dadosDoPedido = async (req, res) => {
  try {
    const numero = Number(String(req.params.numero || "").replace(/\D/g, ""));
    if (!numero) throw erroHttp(400, "Informe o número do pedido.");
    const pedido = await Pedido.findOne({
      where: { tipo: "PEDIDO", numero },
      include: [{ model: PedidoItem, as: "itens", include: [{ model: Produto, as: "produto" }] }],
    });
    if (!pedido) throw erroHttp(404, "Pedido não encontrado.");

    const quantidades = {};
    const produtosPersonalizados = [];
    for (const item of pedido.itens) {
      const unidades = item.quantidade * item.unidadesPacote;
      const campo = CAMPO_CALCULADORA_POR_EMBALAGEM[item.produto?.tipoEmbalagem];
      if (campo) {
        quantidades[campo] = (quantidades[campo] || 0) + unidades;
      } else {
        produtosPersonalizados.push({
          nome: item.nome,
          quantidade: unidades,
          pesoUnitario:
            item.produto?.pesoPacoteGramas && item.unidadesPacote
              ? item.produto.pesoPacoteGramas / 1000 / item.unidadesPacote
              : null,
        });
      }
    }

    res.json({
      id: pedido.id,
      numero: pedido.numero,
      clienteNome: pedido.clienteNome,
      dataPedido: dataISO(pedido.createdAt),
      valor: Number(pedido.total),
      notaFiscalNumero: pedido.notaFiscalNumero,
      transportadoraNome: pedido.transportadoraNome,
      cidade: pedido.cidade,
      estado: pedido.estado,
      cep: pedido.cep,
      pesoKg: Number(pedido.pesoTotalGramas || 0) / 1000,
      metodoEnvio: pedido.metodoEnvio,
      quantidades,
      produtosPersonalizados,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar pedido");
  }
};

// ---------------------------------------------------------------------------
// Alerta "cliente comprou sozinho"
// ---------------------------------------------------------------------------

export const alertasClientes = async (req, res) => {
  try {
    const pedidos = await Pedido.findAll({
      where: { tipo: "PEDIDO", alertaComercial: true, alertaVistoEm: null, statusVendas: { [Op.ne]: "CANCELADO" } },
      include: [{ model: Usuario, as: "cliente", attributes: ["id", "nome", "telefone", "etiquetas", "observacaoComercial"] }],
      order: [["createdAt", "DESC"]],
      limit: 50,
    });
    res.json(
      pedidos.map((p) => ({
        id: p.id,
        numero: p.numero,
        clienteNome: p.clienteNome,
        clienteTelefone: p.clienteTelefone || p.cliente?.telefone || null,
        clienteId: p.clienteId,
        etiquetas: p.cliente?.etiquetas || [],
        observacaoComercial: p.cliente?.observacaoComercial || null,
        total: Number(p.total),
        formaPagamento: p.formaPagamento,
        metodoEnvio: p.metodoEnvio,
        createdAt: p.createdAt,
      })),
    );
  } catch (error) {
    responderErro(res, error, "Erro ao carregar alertas");
  }
};

export const marcarAlertaVisto = async (req, res) => {
  try {
    const filtro = req.params.id === "todos" ? {} : { id: req.params.id };
    await Pedido.update(
      { alertaVistoEm: new Date(), alertaVistoPor: req.usuario.nome },
      { where: { alertaComercial: true, alertaVistoEm: null, ...filtro } },
    );
    res.json({ ok: true });
  } catch (error) {
    responderErro(res, error, "Erro ao marcar alerta");
  }
};

// Dados públicos do site (WhatsApp do comercial).
export const configPublica = async (req, res) => {
  try {
    const whatsapp = (await lerConfiguracao("whatsappComercial")) || process.env.WHATSAPP_COMERCIAL || "5511942058445";
    res.json({
      whatsappComercial: String(whatsapp).replace(/\D/g, ""),
      enderecoLoja: (await lerConfiguracao("enderecoLoja")) || ENDERECO_LOJA_PADRAO,
      bannerLayout: (await lerConfiguracao("bannerLayout")) || "FAIXA",
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar configuração");
  }
};

export const salvarWhatsapp = async (req, res) => {
  try {
    const numeroWhats = String(req.body?.whatsappComercial || "").replace(/\D/g, "");
    if (numeroWhats.length < 10) throw erroHttp(400, "Informe o WhatsApp com DDD.");
    await salvarConfiguracao("whatsappComercial", numeroWhats.startsWith("55") ? numeroWhats : `55${numeroWhats}`);
    res.json({ ok: true });
  } catch (error) {
    responderErro(res, error, "Erro ao salvar WhatsApp");
  }
};

// Onde os banners aparecem no catálogo: FAIXA (largura toda, no lugar do
// título) ou CLASSICO (cartão acima dos produtos).
export const salvarBannerLayout = async (req, res) => {
  try {
    const layout = req.body?.bannerLayout === "CLASSICO" ? "CLASSICO" : "FAIXA";
    await salvarConfiguracao("bannerLayout", layout);
    res.json({ bannerLayout: layout });
  } catch (error) {
    responderErro(res, error, "Erro ao salvar layout dos banners");
  }
};

// ---------------------------------------------------------------------------
// Histórico do cliente para o orçamento (copiar último pedido / frequentes)
// ---------------------------------------------------------------------------

const resumoProduto = (p) =>
  p && {
    id: p.id,
    nome: p.nome,
    sku: p.sku,
    categoria: p.categoria,
    precoVenda: Number(p.precoVenda),
    unidadesPacote: p.unidadesPacote,
    imagemUrl: p.imagemUrl,
    estoque: p.estoque,
    modoVenda: p.modoVenda,
    disponivel: p.estoque > 0 || p.modoVenda === "ENCOMENDA",
  };

export const historicoCliente = async (req, res) => {
  try {
    const cliente = await Usuario.findByPk(req.params.id);
    if (!cliente) throw erroHttp(404, "Cliente não encontrado.");
    const pedidos = await Pedido.findAll({
      where: {
        [Op.or]: [{ clienteId: cliente.id }, { clienteEmail: cliente.email }],
        statusVendas: { [Op.ne]: "CANCELADO" },
      },
      include: [{ model: PedidoItem, as: "itens", include: [{ model: Produto, as: "produto" }] }],
      order: [["createdAt", "DESC"]],
      limit: 10,
    });

    const frequencia = new Map();
    for (const p of pedidos) {
      for (const i of p.itens) {
        if (!i.produto || i.produto.arquivado) continue;
        const atual = frequencia.get(i.produtoId) || { produto: resumoProduto(i.produto), vezes: 0, quantidadeTotal: 0 };
        atual.vezes += 1;
        atual.quantidadeTotal += i.quantidade;
        frequencia.set(i.produtoId, atual);
      }
    }

    res.json({
      cliente,
      pedidos: pedidos.map((p) => ({
        id: p.id,
        tipo: p.tipo,
        numero: p.numero,
        numeroFormatado: p.codigoLegado || (p.tipo === "ORCAMENTO" ? String(p.numero).padStart(4, "0") : String(p.numero)),
        createdAt: p.createdAt,
        total: Number(p.total),
        formaPagamento: p.formaPagamento,
        metodoEnvio: p.metodoEnvio,
        itens: p.itens.map((i) => ({
          produtoId: i.produtoId,
          nome: i.nome,
          quantidade: i.quantidade,
          precoUnitario: Number(i.precoUnitario),
          disponivel: Boolean(i.produto && !i.produto.arquivado),
          produto: resumoProduto(i.produto),
        })),
      })),
      frequentes: [...frequencia.values()]
        .sort((a, b) => b.vezes - a.vezes || b.quantidadeTotal - a.quantidadeTotal)
        .slice(0, 12)
        .map((f) => ({ ...f, quantidadeMedia: Math.max(1, Math.round(f.quantidadeTotal / f.vezes)) })),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar histórico do cliente");
  }
};

// ---------------------------------------------------------------------------
// IA: transforma a mensagem do cliente (WhatsApp, e-mail) em itens do
// orçamento, casando com o catálogo.
// ---------------------------------------------------------------------------

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const ESQUEMA_ITENS = {
  type: "object",
  additionalProperties: false,
  required: ["itens", "naoEncontrados", "observacao"],
  properties: {
    itens: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["linha", "quantidadePacotes", "trechoDaMensagem"],
        properties: {
          linha: { type: "integer" },
          quantidadePacotes: { type: "integer" },
          trechoDaMensagem: { type: "string" },
        },
      },
    },
    naoEncontrados: { type: "array", items: { type: "string" } },
    observacao: { type: "string" },
  },
};

export const interpretarPedidoIA = async (req, res) => {
  try {
    const texto = String(req.body?.texto || "").trim().slice(0, 4000);
    if (texto.length < 3) throw erroHttp(400, "Cole a mensagem do cliente.");
    if (!process.env.OPENAI_API_KEY) throw erroHttp(500, "Configure OPENAI_API_KEY no backend para usar a IA.");

    const produtos = await Produto.findAll({ where: { arquivado: false }, order: [["categoria", "ASC"], ["nome", "ASC"]] });
    const catalogo = produtos
      .map((p, i) => [i + 1, p.sku, p.nome, p.categoria || "", `${p.unidadesPacote} un/pct`, (p.descricao || "").slice(0, 60)].join("|"))
      .join("\n");

    const resposta = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL_ORCAMENTO || process.env.OPENAI_MODEL || "gpt-4.1-mini",
        instructions: [
          "Você monta orçamentos da Gira Kids (brinquedos para máquinas de grua: bolinhas, cápsulas, encapsulados, pelúcias, peças).",
          "Receba a mensagem do cliente e o catálogo (linha: numero|sku|nome|categoria|unidades por pacote|descrição).",
          "Para cada produto pedido, escolha a linha do catálogo correspondente e informe a quantidade EM PACOTES.",
          "Se o cliente pedir em unidades (ex.: 500 bolinhas com pacote de 100), converta para pacotes arredondando para cima.",
          "Se não houver quantidade, use 1 pacote. Se houver dúvida entre produtos, escolha o mais provável e explique em observacao.",
          "Coloque em naoEncontrados o que o cliente pediu e não existe no catálogo. Nunca invente produtos.",
          "Escreva observacao em português, curta.",
        ].join("\n"),
        input: `CATÁLOGO:\n${catalogo}\n\nMENSAGEM DO CLIENTE:\n${texto}`,
        text: { format: { type: "json_schema", name: "itens_orcamento", strict: true, schema: ESQUEMA_ITENS } },
        max_output_tokens: 1500,
      }),
    });
    const payload = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw erroHttp(502, payload?.error?.message || "A IA não respondeu.");
    const textoJson =
      payload.output_text ||
      (payload.output || [])
        .flatMap((o) => o.content || [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
    const resultado = JSON.parse(textoJson);

    res.json({
      itens: resultado.itens
        .map((i) => ({ produto: produtos[i.linha - 1], quantidade: Math.max(1, i.quantidadePacotes), trecho: i.trechoDaMensagem }))
        .filter((i) => i.produto)
        .map((i) => ({ produtoId: i.produto.id, quantidade: i.quantidade, trecho: i.trecho, produto: resumoProduto(i.produto) })),
      naoEncontrados: resultado.naoEncontrados,
      observacao: resultado.observacao,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao interpretar com IA");
  }
};
