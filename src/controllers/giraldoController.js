import { Op } from "sequelize";
import { Categoria, Produto } from "../models/index.js";
import { lerConfiguracao } from "../models/Configuracao.js";
import { cotarFrete } from "../services/freteService.js";
import { statusPagamentos } from "../services/pagamentos/index.js";
import { clientePodeCombinar, ehInterno } from "../services/pedidoService.js";
import { ENDERECO_LOJA_PADRAO, FORMAS_PAGAMENTO } from "../utils/formasPagamento.js";
import { arredondar, erroHttp, responderErro, somenteDigitos } from "../utils/helpers.js";

// Giraldo: assistente de compras do catálogo (OpenAI com ferramentas).
// O modelo consulta o catálogo/frete aqui no backend e termina cada resposta
// chamando "responder_usuario" com a mensagem e as ações que o site executa
// (adicionar ao carrinho, escolher entrega/pagamento, finalizar pedido...).

// Endereço trocável só para testes locais com uma IA simulada.
const OPENAI_CHAT_URL = process.env.OPENAI_CHAT_URL || "https://api.openai.com/v1/chat/completions";
const MODELO = () => process.env.OPENAI_MODEL_ASSISTENTE || process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_RODADAS = 5;
const MAX_HISTORICO = 24;

// ---------------------------------------------------------------------------
// Limite simples por IP (evita abuso do endpoint público)
// ---------------------------------------------------------------------------

const acessos = new Map();
const limitar = (ip) => {
  const agora = Date.now();
  const janela = (acessos.get(ip) || []).filter((t) => agora - t < 10 * 60 * 1000);
  if (janela.length >= 60) throw erroHttp(429, "Muitas mensagens seguidas. Aguarde um pouquinho e tente de novo.");
  janela.push(agora);
  acessos.set(ip, janela);
};

// ---------------------------------------------------------------------------
// Catálogo (cache curto) e busca tolerante a acentos/erros simples
// ---------------------------------------------------------------------------

let cacheCatalogo = { em: 0, produtos: [], categorias: [] };

const normalizar = (t) =>
  String(t || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const catalogo = async () => {
  if (Date.now() - cacheCatalogo.em < 60 * 1000) return cacheCatalogo;
  const ocultas = (await Categoria.findAll({ where: { visivel: false } })).map((c) => c.nome);
  const produtos = await Produto.findAll({
    where: { arquivado: false, ...(ocultas.length ? { categoria: { [Op.notIn]: ocultas } } : {}) },
  });
  cacheCatalogo = {
    em: Date.now(),
    produtos: produtos.map((p) => ({
      id: p.id,
      nome: p.nome,
      sku: p.sku,
      categoria: p.categoria,
      descricao: p.descricao,
      precoVenda: Number(p.precoVenda),
      unidadesPacote: p.unidadesPacote,
      estoque: p.estoque,
      modoVenda: p.modoVenda,
      imagemUrl: p.imagemUrl,
      imagemSemEstoqueUrl: p.imagemSemEstoqueUrl,
      imagemEsgotadoIgual: p.imagemEsgotadoIgual,
      destaque: p.destaque,
      busca: normalizar(`${p.nome} ${p.categoria} ${p.descricao || ""}`),
      nomeNorm: normalizar(p.nome),
      catNorm: normalizar(p.categoria),
    })),
    categorias: [...new Set(produtos.map((p) => p.categoria).filter(Boolean))].sort(),
  };
  return cacheCatalogo;
};

const resumoProduto = (p) => ({
  id: p.id,
  nome: p.nome,
  categoria: p.categoria,
  precoUnidade: p.precoVenda,
  unidadesPorEmbalagem: p.unidadesPacote,
  precoEmbalagem: arredondar(p.precoVenda * p.unidadesPacote),
  disponivel: p.estoque > 0 || p.modoVenda === "ENCOMENDA",
  embalagensEmEstoque: Math.floor(Math.max(0, p.estoque) / Math.max(1, p.unidadesPacote)),
  descricao: (p.descricao || "").slice(0, 120),
});

const buscarProdutos = async ({ busca = "", categoria = "" }) => {
  const { produtos, categorias } = await catalogo();
  const termos = normalizar(busca)
    .split(/[^a-z0-9]+/)
    .filter((t) => (t.length > 1 || /^\d$/.test(t)) &&!["de", "da", "do", "das", "dos", "com", "para", "quero", "uma", "um", "uns", "pct", "pacote", "pacotes"].includes(t));
  const cat = normalizar(categoria);
  const pontuados = produtos
    .filter((p) => !cat || p.catNorm.includes(cat))
    .map((p) => {
      let pontos = 0;
      for (const t of termos) {
        // Números ("2", "32") valem como palavra inteira: "2 pol" não casa com "32mm".
        if (/^\d+$/.test(t)) {
          const palavra = new RegExp(`(^|[^0-9])${t}([^0-9]|$)`);
          if (palavra.test(p.nomeNorm)) pontos += 3;
          else if (palavra.test(p.catNorm)) pontos += 2;
          continue;
        }
        const raiz = t.length > 4 ? t.slice(0, -1) : t; // "bolinhas" ~ "bolinha"
        if (p.nomeNorm.includes(raiz)) pontos += 3;
        else if (p.catNorm.includes(raiz)) pontos += 2;
        else if (p.busca.includes(raiz)) pontos += 1;
        if (normalizar(p.sku) === t) pontos += 5;
      }
      if (!termos.length) pontos = p.destaque ? 2 : 1;
      if (p.estoque > 0) pontos += 0.5;
      return { p, pontos };
    })
    .filter((x) => x.pontos >= (termos.length ? 1 : 0))
    .sort((a, b) => b.pontos - a.pontos || Number(b.p.destaque) - Number(a.p.destaque));
  return {
    encontrados: pontuados.length,
    produtos: pontuados.slice(0, 8).map((x) => resumoProduto(x.p)),
    ...(pontuados.length ? {} : { categoriasDisponiveis: categorias }),
  };
};

// ---------------------------------------------------------------------------
// Contexto da conversa
// ---------------------------------------------------------------------------

const formasPermitidas = (usuario) => {
  const online = statusPagamentos();
  const formas = Object.entries(FORMAS_PAGAMENTO)
    .filter(([codigo, cfg]) => {
      if (ehInterno(usuario)) return !["MESCLA"].includes(codigo);
      if (cfg.admin) return false;
      if (cfg.outros) return Boolean(usuario?.outrosPagamentos);
      if (cfg.online) return online.habilitado && online.metodos.includes(codigo);
      return true;
    })
    .map(([codigo, cfg]) => ({ codigo, nome: cfg.nome, online: Boolean(cfg.online) }));
  if (!ehInterno(usuario)) {
    formas.push({ codigo: "A_DEFINIR", nome: "Combinar com o comercial", observacao: online.habilitado ? "só para retirada ou transportadora" : "o comercial envia a forma de pagamento" });
  }
  return { formas, pagamentoOnlineAtivo: online.habilitado };
};

// Telas que o Giraldo pode abrir: só as que a pessoa tem acesso.
const TELAS_EQUIPE = {
  FINANCEIRO: ["/dashboard", "Time Financeiro"],
  VENDAS: ["/historico-pedidos", "Time de Vendas (pedidos)"],
  EXPEDICAO: ["/expedicao", "Time Expedição"],
  PRODUTOS: ["/produtos", "Gerenciar Produtos"],
  ORCAMENTOS: ["/orcamentos", "Orçamentos"],
  USUARIOS: ["/usuarios", "Gerenciar Usuários"],
  COMERCIAL: ["/comercial/correios", "Comercial"],
  RECEBIMENTOS: ["/recebimentos", "Recebimentos"],
};
const telasPermitidas = (usuario) => {
  const telas = { "/": "Catálogo de produtos", "/checkout": "Carrinho / finalizar pedido" };
  if (!usuario) return { ...telas, "/login": "Entrar na conta", "/registrar": "Criar conta" };
  telas["/perfil"] = "Meu perfil (dados e endereço)";
  if (usuario.role === "CLIENTE") telas["/meus-pedidos"] = "Meus pedidos";
  for (const [permissao, [rota, nome]] of Object.entries(TELAS_EQUIPE)) {
    if (usuario.temPermissao?.(permissao)) telas[rota] = nome;
  }
  return telas;
};

const NOMES_PAGINA = { "/": "Catálogo", "/catalogo": "Catálogo", "/checkout": "Carrinho / finalizar pedido", "/meus-pedidos": "Meus pedidos", "/perfil": "Meu perfil", "/login": "Entrar", "/registrar": "Criar conta" };
const nomePagina = (rota) => {
  const r = String(rota || "/").split("?")[0];
  if (r.startsWith("/produto/")) return "Detalhes de um produto (catálogo)";
  if (r.startsWith("/pagamento/")) return "Pedido finalizado (tela de pagamento)";
  return NOMES_PAGINA[r] || r;
};

// O que está na tela do carrinho (enviado pelo site), só com campos conhecidos.
const resumirCheckout = (c) => {
  if (!c || typeof c !== "object") return null;
  const lista = (v) => (Array.isArray(v) ? v.slice(0, 20) : []);
  return {
    entrega: c.metodoEnvio || null,
    pagamento: c.formaPagamento || null,
    parcelas: c.parcelas || null,
    cep: c.cep || null,
    opcoesDeEntrega: lista(c.opcoesEntrega).map((o) => ({ metodo: o.metodo, disponivel: Boolean(o.disponivel), valor: Number(o.valor) || 0, prazoDias: o.prazoDias ?? null })),
    formasDisponiveisNaTela: lista(c.formasDisponiveis).map((f) => ({ codigo: f.codigo, nome: f.nome, somenteEnvios: f.somenteEnvios || null })),
    subtotal: Number(c.subtotal) || 0,
    frete: Number(c.frete) || 0,
    total: Number(c.total) || 0,
    dadosFaltando: lista(c.dadosFaltando).map(String),
    equipe: Boolean(c.equipe),
    clienteEscolhido: c.clienteEscolhido !== false,
  };
};

const montarContexto = async ({ usuario, carrinho, estado, pagina, checkout }) => {
  const { produtos } = await catalogo();
  const porId = new Map(produtos.map((p) => [p.id, p]));
  const itens = (carrinho || [])
    .map((i) => ({ p: porId.get(i.produtoId), quantidade: Math.max(0, Math.round(Number(i.quantidade) || 0)) }))
    .filter((i) => i.p && i.quantidade > 0)
    .map(({ p, quantidade }) => ({
      produtoId: p.id,
      nome: p.nome,
      embalagens: quantidade,
      unidades: quantidade * p.unidadesPacote,
      subtotal: arredondar(quantidade * p.unidadesPacote * p.precoVenda),
    }));
  const whatsapp = (await lerConfiguracao("whatsappComercial")) || process.env.WHATSAPP_COMERCIAL || "5511942058445";
  const enderecoLoja = (await lerConfiguracao("enderecoLoja")) || ENDERECO_LOJA_PADRAO;
  const pagamentos = formasPermitidas(usuario);
  const tela = String(pagina || "").startsWith("/checkout") ? resumirCheckout(checkout) : null;
  const temCadastroCompleto = Boolean(usuario?.documento && usuario?.telefone && usuario?.cep && usuario?.rua && usuario?.numero && usuario?.cidade);
  return {
    contexto: {
      usuario: usuario
        ? {
            logado: true,
            nome: usuario.nome?.split(" ")[0],
            equipeInterna: ehInterno(usuario),
            cadastroCompleto: temCadastroCompleto,
            cep: usuario.cep || null,
            cidade: usuario.cidade ? `${usuario.cidade}/${usuario.estado || ""}` : null,
          }
        : { logado: false },
      carrinho: itens,
      subtotalCarrinho: arredondar(itens.reduce((s, i) => s + i.subtotal, 0)),
      paginaAtual: nomePagina(pagina),
      telaDoCarrinho: tela,
      escolhasAtuais: {
        entrega: tela?.entrega || estado?.metodoEnvio || null,
        pagamento: tela?.pagamento || estado?.formaPagamento || null,
        parcelas: tela?.parcelas || null,
        cep: tela?.cep || estado?.cep || null,
      },
      telasQuePodeAbrir: telasPermitidas(usuario),
      formasDePagamento: pagamentos.formas,
      pagamentoOnlineAtivo: pagamentos.pagamentoOnlineAtivo,
      whatsappComercial: `(${whatsapp.slice(2, 4)}) ${whatsapp.slice(4, 9)}-${whatsapp.slice(9)}`,
      enderecoLoja,
    },
    whatsapp,
    pagamentos,
    porId,
    telas: telasPermitidas(usuario),
    pagina,
  };
};

const INSTRUCOES = `Você é o Giraldo, assistente de compras da Gira Kids (brinquedos e insumos para máquinas de grua e vending: bolinhas pula-pula, cápsulas, brinquedos encapsulados, pelúcias, peças e máquinas).

TOM
- Português do Brasil, cordial, profissional e objetivo. No máximo 3 frases curtas por resposta.
- Seja específico: use o nome exato do produto, preço por unidade e por embalagem (sempre no formato R$ 0,00), quantidades em embalagens e unidades, e o total quando houver.
- Contas: unidades = embalagens × unidades por embalagem (ex.: 2 embalagens de 100 un. = 200 un.); valor = unidades × preço por unidade. Confira antes de responder.
- No máximo 1 emoji por resposta (pode não usar nenhum). Não cumprimente de novo depois da primeira mensagem. Nada de frases vazias como "Como posso ajudar?" quando já existe um próximo passo.
- Faça UMA pergunta por vez e só quando precisar.

NUNCA REPITA
- Antes de perguntar, confira "escolhasAtuais" e "telaDoCarrinho" no contexto. O que já está definido NÃO se pergunta de novo: só siga para o próximo passo.
- Se a pessoa já disse algo antes (mesmo fora do carrinho, ex.: "vou retirar e pagar no PIX"), aplique com as ações (definir_entrega, definir_pagamento) e não pergunte outra vez.
- Não repita listas de opções, endereço ou WhatsApp que já mandou na conversa, a não ser que a pessoa peça.

PRODUTOS (em qualquer tela)
1. SEMPRE use buscar_produtos antes de recomendar; nunca invente produto, preço ou estoque.
2. Mostre no máximo 4 produtos (ids em "produtos" para virarem cartões com foto).
3. Quantidade é em EMBALAGENS. Se pedirem em unidades (ex.: 500 bolinhas, embalagem com 100), converta arredondando para cima e diga a conta.
4. Só adicione quando o produto estiver definido. Se a busca trouxer modelos parecidos, mostre as opções e pergunte qual, sem adicionar. Com produto e quantidade definidos, adicione (adicionar_carrinho) e confirme: "Adicionei 2 embalagens de Bolinha 32mm (200 un.) — R$ 122,00." Se faltou a quantidade, pergunte quantas embalagens.
5. Nunca adicione o mesmo item duas vezes. Produto errado: remover_carrinho. Mudar quantidade: definir_quantidade.
6. Pedido para VER/MOSTRAR produtos no catálogo/site/tela: use mostrar_catalogo (busca ou categoria com o nome exato), além dos cartões. Produto específico ampliado: abrir_produto.

FECHAMENTO (entrega, pagamento e dados acontecem NO CARRINHO)
7. Quando a pessoa terminar de escolher ("só isso", "fechar", "finalizar") e paginaAtual não for o carrinho: use navegar "/checkout" e diga que JÁ abriu o carrinho ("Abri o carrinho para você."); na mesma resposta faça a próxima pergunta que falta (normalmente a entrega) ou, se entrega e pagamento já estiverem definidos, mostre o resumo e pergunte "Posso finalizar?". Nunca pergunte se pode levar ao carrinho. Não use finalizar_pedido fora do carrinho e não pergunte nada sobre entrega/pagamento antes desse momento, a não ser que a pessoa traga o assunto.
8. No carrinho, siga esta ordem e PULE o que já estiver definido:
   a) Entrega:
      - Retirar na loja: {ENDERECO}, sem frete. Ao escolher, informe o endereço uma vez.
      - Correios PAC ou SEDEX: pago no site. Precisa de CEP (definir_cep). Use os valores de telaDoCarrinho.opcoesDeEntrega (ou cotar_frete) e informe valor e prazo de cada um; só use definir_entrega depois da escolha.
      - Transportadora: frete combinado com o comercial no WhatsApp {WHATSAPP} (ação whatsapp_comercial).
   b) Pagamento: ofereça SOMENTE as formas de telaDoCarrinho.formasDisponiveisNaTela (ou formasDePagamento), respeitando "somenteEnvios". PIX online e cartão online são pagos no site; Crédito link: o comercial envia o link; Maquininha (só equipe): a cobrança vai para a maquininha. Crédito: pergunte as parcelas (definir_parcelas, 1 a 12) se a pessoa não disse.
   c) Dados: se telaDoCarrinho.dadosFaltando tiver itens, peça UM por vez e preencha com preencher_dados (nome, telefone, documento = CPF/CNPJ, numero, complemento) ou definir_cep. Equipe sem cliente escolhido (clienteEscolhido = false): peça o nome do cliente ou para buscá-lo no topo da tela.
   d) Com tudo definido e dadosFaltando vazio: resumo em uma linha (itens, entrega, pagamento, total de telaDoCarrinho.total) e pergunte "Posso finalizar?". Se a pessoa já está no carrinho, NÃO use navegar "/checkout" de novo.
9. Com o "sim", use finalizar_pedido: o site aperta o botão da tela e gera o PIX/QR Code, a página do cartão ou envia para a maquininha. Não diga que o pedido foi criado — o site confirma em seguida.
10. Usuário não logado na hora de finalizar: explique que precisa entrar ou criar conta (pedir_login); o carrinho fica guardado.

OUTROS
- Telas: navegar só para rotas de "telasQuePodeAbrir".
- Pessoa perdida, reclamação ou pedido de atendente: ofereça o WhatsApp do comercial (whatsapp_comercial).
- Não sabe responder: diga isso com franqueza e ofereça o comercial.

SEMPRE termine chamando responder_usuario. Em "sugestoes" mande de 2 a 4 respostas curtas escritas como a PESSOA responderia À PERGUNTA que você acabou de fazer (ex.: "Retirar na loja", "Correios", "PIX", "2 embalagens", "Pode finalizar"); nunca em forma de pergunta e nunca opções já escolhidas.`;

const FERRAMENTAS = [
  {
    type: "function",
    function: {
      name: "buscar_produtos",
      description: "Busca produtos no catálogo da Gira Kids por texto (nome, tipo, tema, tamanho) e/ou categoria.",
      parameters: {
        type: "object",
        properties: {
          busca: { type: "string", description: "O que procurar, ex.: 'bolinha 32mm', 'pokemon encapsulado', 'pelúcia'." },
          categoria: { type: "string", description: "Opcional: nome (ou parte) da categoria." },
        },
        required: ["busca"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cotar_frete",
      description: "Calcula PAC e SEDEX dos itens do carrinho para um CEP.",
      parameters: {
        type: "object",
        properties: { cep: { type: "string" } },
        required: ["cep"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "responder_usuario",
      description: "Resposta final para o usuário, com as ações que o site deve executar.",
      parameters: {
        type: "object",
        properties: {
          mensagem: { type: "string", description: "Texto curto e simpático para o usuário." },
          produtos: { type: "array", items: { type: "string" }, description: "Ids de até 4 produtos para mostrar como cartões." },
          acoes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tipo: {
                  type: "string",
                  enum: [
                    "adicionar_carrinho",
                    "definir_quantidade",
                    "remover_carrinho",
                    "abrir_carrinho",
                    "definir_entrega",
                    "definir_pagamento",
                    "definir_cep",
                    "finalizar_pedido",
                    "pedir_login",
                    "ir_checkout",
                    "whatsapp_comercial",
                    "navegar",
                    "mostrar_catalogo",
                    "abrir_produto",
                    "definir_parcelas",
                    "definir_observacao",
                    "preencher_dados",
                  ],
                },
                produtoId: { type: "string" },
                quantidade: { type: "integer", description: "Em embalagens." },
                metodoEnvio: { type: "string", enum: ["RETIRAR_LOCAL", "TRANSPORTADORA", "PAC", "SEDEX"] },
                formaPagamento: { type: "string" },
                cep: { type: "string" },
                rota: { type: "string", description: "navegar: uma rota de telasQuePodeAbrir." },
                categoria: { type: "string", description: "mostrar_catalogo: nome da categoria." },
                busca: { type: "string", description: "mostrar_catalogo: texto a buscar." },
                parcelas: { type: "integer", description: "definir_parcelas: 1 a 12." },
                texto: { type: "string", description: "definir_observacao: observação do pedido." },
                campo: { type: "string", enum: ["nome", "telefone", "documento", "numero", "complemento"], description: "preencher_dados: campo do formulário." },
                valor: { type: "string", description: "preencher_dados: valor do campo." },
              },
              required: ["tipo"],
            },
          },
          sugestoes: { type: "array", items: { type: "string" } },
        },
        required: ["mensagem"],
      },
    },
  },
];

const chamarModelo = async (mensagens) => {
  const resposta = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODELO(), messages: mensagens, tools: FERRAMENTAS, tool_choice: "required", temperature: 0.2, max_tokens: 900 }),
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw erroHttp(502, dados?.error?.message || "O Giraldo não conseguiu responder agora.");
  return dados.choices?.[0]?.message;
};

// Mesma regra de imagem do catálogo: esgotado mostra a arte de esgotado, se houver.
const imagemCartao = (p) => {
  const esgotado = !(p.estoque > 0 || p.modoVenda === "ENCOMENDA");
  return {
    imagemUrl: esgotado && p.imagemSemEstoqueUrl ? p.imagemSemEstoqueUrl : p.imagemUrl,
    temImagemEsgotado: Boolean(p.imagemSemEstoqueUrl && p.imagemSemEstoqueUrl !== p.imagemUrl && !p.imagemEsgotadoIgual),
  };
};

// Garante que as ações só usem produtos, quantidades e formas válidas.
const validarResposta = (args, { porId, pagamentos, telas, pagina }) => {
  const paginaAtual = String(pagina || "").split("?")[0];
  const formas = new Set(pagamentos.formas.map((f) => f.codigo));
  // Duas entregas (ou dois pagamentos) diferentes na mesma resposta = a pessoa
  // ainda não escolheu: não aplica nenhuma.
  const indecisos = ["definir_entrega", "definir_pagamento"].filter((tipo) => {
    const valores = new Set((args.acoes || []).filter((a) => a.tipo === tipo).map((a) => a.metodoEnvio || a.formaPagamento));
    return valores.size > 1;
  });
  const acoes = (args.acoes || [])
    .filter((a) => !indecisos.includes(a.tipo))
    .map((a) => ({
      ...a,
      quantidade: a.quantidade != null ? Math.min(9999, Math.max(1, Math.round(a.quantidade))) : undefined,
      categoria: a.categoria ? String(a.categoria).slice(0, 80) : undefined,
      busca: a.busca ? String(a.busca).slice(0, 80) : undefined,
      texto: a.texto != null ? String(a.texto).slice(0, 500) : undefined,
      valor: a.valor != null ? String(a.valor).trim().slice(0, 120) : undefined,
    }))
    .filter((a) => {
      if (["adicionar_carrinho", "definir_quantidade", "remover_carrinho"].includes(a.tipo)) return porId.has(a.produtoId);
      if (a.tipo === "definir_pagamento") return formas.has(a.formaPagamento);
      if (a.tipo === "definir_entrega") return ["RETIRAR_LOCAL", "TRANSPORTADORA", "PAC", "SEDEX"].includes(a.metodoEnvio);
      if (a.tipo === "definir_cep") return somenteDigitos(a.cep).length === 8;
      if (a.tipo === "navegar") return Boolean(telas?.[a.rota]) && a.rota !== paginaAtual;
      if (a.tipo === "mostrar_catalogo") return Boolean(String(a.categoria || a.busca || "").trim());
      if (a.tipo === "abrir_produto") return porId.has(a.produtoId);
      if (a.tipo === "definir_parcelas") return Number(a.parcelas) >= 1 && Number(a.parcelas) <= 12;
      if (a.tipo === "definir_observacao") return typeof a.texto === "string";
      if (a.tipo === "preencher_dados") return ["nome", "telefone", "documento", "numero", "complemento"].includes(a.campo) && String(a.valor || "").trim().length > 0;
      return true;
    });
  const produtos = (args.produtos || [])
    .filter((id) => porId.has(id))
    .slice(0, 4)
    .map((id) => {
      const p = porId.get(id);
      return {
        id: p.id,
        nome: p.nome,
        sku: p.sku,
        categoria: p.categoria,
        precoVenda: p.precoVenda,
        unidadesPacote: p.unidadesPacote,
        ...imagemCartao(p),
        estoque: p.estoque,
        modoVenda: p.modoVenda,
        disponivel: p.estoque > 0 || p.modoVenda === "ENCOMENDA",
      };
    });
  // Ações de carrinho levam o produto junto (o carrinho do site precisa dele).
  for (const a of acoes) {
    if (a.produtoId && porId.has(a.produtoId)) {
      const p = porId.get(a.produtoId);
      a.produto = { id: p.id, nome: p.nome, sku: p.sku, categoria: p.categoria, precoVenda: p.precoVenda, unidadesPacote: p.unidadesPacote, ...imagemCartao(p), estoque: p.estoque, modoVenda: p.modoVenda, disponivel: p.estoque > 0 || p.modoVenda === "ENCOMENDA" };
    }
  }
  return {
    mensagem: String(args.mensagem || "").trim() || "Como posso te ajudar?",
    produtos,
    acoes,
    sugestoes: (args.sugestoes || [])
      .map((s) => String(s).trim().slice(0, 40))
      .filter((s) => s && !s.endsWith("?"))
      .slice(0, 4),
  };
};

export const conversar = async (req, res) => {
  try {
    limitar(req.ip);
    if (!process.env.OPENAI_API_KEY) throw erroHttp(503, "O Giraldo ainda não está ativado (configure OPENAI_API_KEY no backend).");
    const { mensagens = [], carrinho = [], estado = {}, pagina = "/", checkout = null } = req.body || {};
    const historico = (Array.isArray(mensagens) ? mensagens : [])
      .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.trim())
      .slice(-MAX_HISTORICO)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
    if (!historico.length || historico[historico.length - 1].role !== "user") throw erroHttp(400, "Envie a mensagem do usuário.");

    const ctx = await montarContexto({ usuario: req.usuario, carrinho, estado, pagina: String(pagina).slice(0, 120), checkout });
    const conversa = [
      { role: "system", content: INSTRUCOES.replaceAll("{WHATSAPP}", ctx.contexto.whatsappComercial).replaceAll("{ENDERECO}", ctx.contexto.enderecoLoja) },
      { role: "system", content: `CONTEXTO ATUAL (JSON): ${JSON.stringify(ctx.contexto)}` },
      ...historico,
    ];

    // Última busca feita pela IA: se a pessoa pediu para VER no catálogo e a
    // IA só mostrou cartões, o site abre o catálogo com essa busca.
    let ultimaBusca = null;
    const pediuCatalogo = /(mostr|ver |veja|abr|exib).{0,40}(cat[aá]logo|site|tela)|no cat[aá]logo/i.test(historico[historico.length - 1].content);
    for (let rodada = 0; rodada < MAX_RODADAS; rodada += 1) {
      const msg = await chamarModelo(conversa);
      const chamadas = msg?.tool_calls || [];
      const final = chamadas.find((c) => c.function?.name === "responder_usuario");
      if (final) {
        const args = JSON.parse(final.function.arguments || "{}");
        const resposta = validarResposta(args, ctx);
        const navegou = resposta.acoes.some((a) => ["mostrar_catalogo", "navegar", "abrir_produto", "abrir_carrinho", "ir_checkout"].includes(a.tipo));
        if (pediuCatalogo && ultimaBusca && !navegou) resposta.acoes.push({ tipo: "mostrar_catalogo", busca: ultimaBusca.slice(0, 80) });
        if (resposta.acoes.some((a) => a.tipo === "whatsapp_comercial")) resposta.whatsappComercial = ctx.whatsapp;
        return res.json(resposta);
      }
      conversa.push({ role: "assistant", content: msg?.content || null, tool_calls: chamadas });
      for (const chamada of chamadas) {
        let resultado;
        try {
          const args = JSON.parse(chamada.function.arguments || "{}");
          if (chamada.function.name === "buscar_produtos") {
            ultimaBusca = String(args.busca || "").trim() || ultimaBusca;
            resultado = await buscarProdutos(args);
          } else if (chamada.function.name === "cotar_frete") {
            const itens = (carrinho || []).map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade }));
            if (!itens.length) resultado = { erro: "Carrinho vazio." };
            else {
              const { opcoes } = await cotarFrete({ cep: args.cep, itens });
              resultado = opcoes
                .filter((o) => ["PAC", "SEDEX"].includes(o.metodo))
                .map((o) => ({ metodo: o.metodo, disponivel: o.disponivel, valor: o.valor, prazoDiasUteis: o.prazoDias, motivo: o.motivo }));
            }
          } else {
            resultado = { erro: "Ferramenta desconhecida." };
          }
        } catch (erro) {
          resultado = { erro: erro.message };
        }
        conversa.push({ role: "tool", tool_call_id: chamada.id, content: JSON.stringify(resultado) });
      }
    }
    res.json({ mensagem: "Desculpe, me enrolei aqui. Pode repetir de outro jeito? 😊", produtos: [], acoes: [], sugestoes: [] });
  } catch (error) {
    responderErro(res, error, "Erro no assistente");
  }
};

// Voz → texto (áudio gravado no navegador).
export const transcrever = async (req, res) => {
  try {
    limitar(req.ip);
    if (!process.env.OPENAI_API_KEY) throw erroHttp(503, "Configure OPENAI_API_KEY para usar a voz.");
    if (!req.file?.buffer?.length) throw erroHttp(400, "Nenhum áudio recebido.");
    const tipo = req.file.mimetype || "audio/webm";
    const extensao = tipo.includes("mp4") || tipo.includes("m4a") ? "m4a" : tipo.includes("ogg") ? "ogg" : tipo.includes("wav") ? "wav" : "webm";
    const corpo = new FormData();
    corpo.append("file", new Blob([req.file.buffer], { type: tipo }), `audio.${extensao}`);
    corpo.append("model", process.env.OPENAI_MODEL_TRANSCRICAO || "gpt-4o-mini-transcribe");
    corpo.append("language", "pt");
    corpo.append("prompt", "Pedido de compra de brinquedos: bolinhas pula-pula 27mm 32mm 45mm, cápsulas, encapsulados 1 polegada e 2 polegadas, Pokémon, Minecraft, pelúcias, grua, embalagens, PAC, SEDEX, PIX.");
    const resposta = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: corpo,
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw erroHttp(502, dados?.error?.message || "Não consegui entender o áudio.");
    res.json({ texto: String(dados.text || "").trim() });
  } catch (error) {
    responderErro(res, error, "Erro ao transcrever áudio");
  }
};
