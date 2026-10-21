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

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
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

const montarContexto = async ({ usuario, carrinho, estado }) => {
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
      escolhas: { entrega: estado?.metodoEnvio || null, pagamento: estado?.formaPagamento || null, cep: estado?.cep || null },
      formasDePagamento: pagamentos.formas,
      pagamentoOnlineAtivo: pagamentos.pagamentoOnlineAtivo,
      whatsappComercial: `(${whatsapp.slice(2, 4)}) ${whatsapp.slice(4, 9)}-${whatsapp.slice(9)}`,
      enderecoLoja,
    },
    whatsapp,
    pagamentos,
    porId,
  };
};

const INSTRUCOES = `Você é o Giraldo, o assistente de compras da Gira Kids (loja de brinquedos e insumos para máquinas de grua e vending: bolinhas pula-pula, cápsulas, brinquedos encapsulados, pelúcias, peças e máquinas). Fale português do Brasil, de forma simpática, simples e MUITO curta (no máximo 3 frases curtas por resposta). Muitos clientes têm dificuldade com tecnologia: uma pergunta por vez, linguagem fácil, sem jargão.

COMO AJUDAR
1. Entenda o que a pessoa quer comprar. SEMPRE use a ferramenta buscar_produtos antes de recomendar; nunca invente produto, preço ou estoque.
2. Recomende no máximo 4 produtos (mande os ids em "produtos" para aparecerem como cartões com foto). Diga o preço por unidade e quantas unidades vêm na embalagem. Escreva valores sempre como R$ 0,00 (ex.: "R$ 79,00 a embalagem").
3. Quantidade é sempre em EMBALAGENS (pacotes). Se a pessoa pedir em unidades (ex.: 500 bolinhas e a embalagem tem 100), converta arredondando para cima e explique. Só adicione quando souber EXATAMENTE qual produto: se a busca trouxer várias opções parecidas (ex.: vários modelos de bolinha 32mm), mostre as opções e pergunte qual a pessoa quer, SEM adicionar nada ainda. Com o produto definido e a quantidade dita, adicione (ação adicionar_carrinho) e diga que JÁ ADICIONOU — não pergunte se pode adicionar. Se a quantidade não foi dita, pergunte quantas embalagens quer. Nunca adicione o mesmo pedido duas vezes; se adicionou o produto errado, remova-o (remover_carrinho).
4. Depois de adicionar, confirme rapidamente ("Coloquei X embalagens no carrinho 🛒") e pergunte se quer mais alguma coisa.
5. Quando a pessoa disser que é só isso (ou pedir para fechar), pergunte como quer receber, explicando as 3 opções:
   - Correios (PAC ou SEDEX): o pagamento é feito ali mesmo no site. Precisa do CEP; use cotar_frete e informe valor e prazo de PAC e SEDEX.
   - Transportadora: o frete é combinado com o comercial pelo WhatsApp {WHATSAPP} (use a ação whatsapp_comercial). O pedido pode ser registrado com pagamento "Combinar com o comercial".
   - Retirar na loja: endereço {ENDERECO}. Sem custo de frete.
   Só use a ação definir_entrega DEPOIS que a pessoa escolher, sempre com metodoEnvio preenchido.
   Quando escolher retirar na loja, SEMPRE informe o endereço {ENDERECO} na resposta.
   Quando escolher Correios, lembre que o pagamento é feito ali mesmo, online; mostre PAC e SEDEX e só registre definir_entrega depois que a pessoa escolher um dos dois.
   Quando escolher transportadora, mande o WhatsApp do comercial {WHATSAPP} (ação whatsapp_comercial).
6. Em seguida pergunte a forma de pagamento, oferecendo SOMENTE as formas listadas em formasDePagamento do contexto (respeite as observações). Registre com definir_pagamento.
7. Mostre um resumo curto (itens, entrega, pagamento, total aproximado) e pergunte se pode finalizar. Com o "sim", use a ação finalizar_pedido.
   - Se o usuário não estiver logado, explique que precisa entrar ou criar a conta (ação pedir_login) antes de finalizar; o carrinho fica guardado.
   - Se o cadastro estiver incompleto (sem CPF/CNPJ, telefone ou endereço), use a ação ir_checkout para ele completar os dados na tela de finalizar.
8. Se a pessoa quiser ver o carrinho, use abrir_carrinho. Para remover ou mudar quantidade, use remover_carrinho ou definir_quantidade.
9. Se a pessoa estiver perdida ou pedir humano, ofereça o WhatsApp do comercial (whatsapp_comercial).
10. Se já estiver ajudando desde o início e a pessoa adicionou o que queria, conduza os passos de entrega → pagamento → finalizar sem esperar ela pedir.

SEMPRE termine chamando responder_usuario. Em "sugestoes" mande de 2 a 4 respostas rápidas curtas que a pessoa provavelmente vai querer tocar (ex.: "2 embalagens", "Só isso", "Retirar na loja", "PIX").`;

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
                  ],
                },
                produtoId: { type: "string" },
                quantidade: { type: "integer", description: "Em embalagens." },
                metodoEnvio: { type: "string", enum: ["RETIRAR_LOCAL", "TRANSPORTADORA", "PAC", "SEDEX"] },
                formaPagamento: { type: "string" },
                cep: { type: "string" },
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
    body: JSON.stringify({ model: MODELO(), messages: mensagens, tools: FERRAMENTAS, tool_choice: "required", temperature: 0.4, max_tokens: 900 }),
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw erroHttp(502, dados?.error?.message || "O Giraldo não conseguiu responder agora.");
  return dados.choices?.[0]?.message;
};

// Garante que as ações só usem produtos, quantidades e formas válidas.
const validarResposta = (args, { porId, pagamentos }) => {
  const formas = new Set(pagamentos.formas.map((f) => f.codigo));
  // Duas entregas (ou dois pagamentos) diferentes na mesma resposta = a pessoa
  // ainda não escolheu: não aplica nenhuma.
  const indecisos = ["definir_entrega", "definir_pagamento"].filter((tipo) => {
    const valores = new Set((args.acoes || []).filter((a) => a.tipo === tipo).map((a) => a.metodoEnvio || a.formaPagamento));
    return valores.size > 1;
  });
  const acoes = (args.acoes || [])
    .filter((a) => !indecisos.includes(a.tipo))
    .map((a) => ({ ...a, quantidade: a.quantidade != null ? Math.min(9999, Math.max(1, Math.round(a.quantidade))) : undefined }))
    .filter((a) => {
      if (["adicionar_carrinho", "definir_quantidade", "remover_carrinho"].includes(a.tipo)) return porId.has(a.produtoId);
      if (a.tipo === "definir_pagamento") return formas.has(a.formaPagamento);
      if (a.tipo === "definir_entrega") return ["RETIRAR_LOCAL", "TRANSPORTADORA", "PAC", "SEDEX"].includes(a.metodoEnvio);
      if (a.tipo === "definir_cep") return somenteDigitos(a.cep).length === 8;
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
        imagemUrl: p.imagemUrl,
        estoque: p.estoque,
        modoVenda: p.modoVenda,
        disponivel: p.estoque > 0 || p.modoVenda === "ENCOMENDA",
      };
    });
  // Ações de carrinho levam o produto junto (o carrinho do site precisa dele).
  for (const a of acoes) {
    if (a.produtoId && porId.has(a.produtoId)) {
      const p = porId.get(a.produtoId);
      a.produto = { id: p.id, nome: p.nome, sku: p.sku, categoria: p.categoria, precoVenda: p.precoVenda, unidadesPacote: p.unidadesPacote, imagemUrl: p.imagemUrl, estoque: p.estoque, modoVenda: p.modoVenda, disponivel: p.estoque > 0 || p.modoVenda === "ENCOMENDA" };
    }
  }
  return {
    mensagem: String(args.mensagem || "").trim() || "Como posso te ajudar?",
    produtos,
    acoes,
    sugestoes: (args.sugestoes || []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 4),
  };
};

export const conversar = async (req, res) => {
  try {
    limitar(req.ip);
    if (!process.env.OPENAI_API_KEY) throw erroHttp(503, "O Giraldo ainda não está ativado (configure OPENAI_API_KEY no backend).");
    const { mensagens = [], carrinho = [], estado = {} } = req.body || {};
    const historico = (Array.isArray(mensagens) ? mensagens : [])
      .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.trim())
      .slice(-MAX_HISTORICO)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
    if (!historico.length || historico[historico.length - 1].role !== "user") throw erroHttp(400, "Envie a mensagem do usuário.");

    const ctx = await montarContexto({ usuario: req.usuario, carrinho, estado });
    const conversa = [
      { role: "system", content: INSTRUCOES.replaceAll("{WHATSAPP}", ctx.contexto.whatsappComercial).replaceAll("{ENDERECO}", ctx.contexto.enderecoLoja) },
      { role: "system", content: `CONTEXTO ATUAL (JSON): ${JSON.stringify(ctx.contexto)}` },
      ...historico,
    ];

    for (let rodada = 0; rodada < MAX_RODADAS; rodada += 1) {
      const msg = await chamarModelo(conversa);
      const chamadas = msg?.tool_calls || [];
      const final = chamadas.find((c) => c.function?.name === "responder_usuario");
      if (final) {
        const args = JSON.parse(final.function.arguments || "{}");
        const resposta = validarResposta(args, ctx);
        if (resposta.acoes.some((a) => a.tipo === "whatsapp_comercial")) resposta.whatsappComercial = ctx.whatsapp;
        return res.json(resposta);
      }
      conversa.push({ role: "assistant", content: msg?.content || null, tool_calls: chamadas });
      for (const chamada of chamadas) {
        let resultado;
        try {
          const args = JSON.parse(chamada.function.arguments || "{}");
          if (chamada.function.name === "buscar_produtos") {
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
