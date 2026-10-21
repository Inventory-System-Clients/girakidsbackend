import fs from "fs";
import { Op, fn, col } from "sequelize";
import { Parceiro, Pedido } from "../models/index.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELO_BUSCA_TRANSPORTADORAS =
  process.env.OPENAI_MODEL_TRANSPORTADORAS ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";

const ORIGEM_PADRAO = "São Paulo (SP), Brasil";
const MAX_CANDIDATOS_PLANILHA = 40;

const transportadorasReferencia = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../data/transportadorasReferencia.json"),
    "utf8",
  ),
);

const listarCandidatosPlanilha = (estadoDestino) => {
  const uf = String(estadoDestino).toUpperCase();
  return transportadorasReferencia
    .filter((item) => Array.isArray(item.estados) && item.estados.includes(uf))
    .slice(0, MAX_CANDIDATOS_PLANILHA);
};

const extrairTextoResposta = (resposta) => {
  if (typeof resposta?.output_text === "string") return resposta.output_text;

  const textos = [];
  for (const item of resposta?.output || []) {
    for (const conteudo of item?.content || []) {
      if (conteudo?.type === "output_text" && conteudo?.text) {
        textos.push(conteudo.text);
      }
    }
  }

  return textos.join("\n").trim();
};

const schemaBuscaTransportadoras = {
  type: "object",
  additionalProperties: false,
  required: ["transportadoras", "resumo"],
  properties: {
    transportadoras: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "nome",
          "telefone",
          "whatsapp",
          "cidadeBase",
          "motivoRelevancia",
          "fonte",
          "origem",
        ],
        properties: {
          nome: { type: "string" },
          telefone: { type: ["string", "null"] },
          whatsapp: { type: ["string", "null"] },
          cidadeBase: { type: ["string", "null"] },
          motivoRelevancia: { type: "string" },
          fonte: { type: ["string", "null"] },
          origem: {
            type: "string",
            enum: ["planilha", "web"],
          },
        },
      },
    },
    resumo: { type: "string" },
  },
};

const chamarOpenAIParaBuscarTransportadoras = async ({
  estadoDestino,
  cidadeDestino,
  peso,
  dimensoes,
}) => {
  if (!process.env.OPENAI_API_KEY) {
    const erro = new Error("OPENAI_API_KEY nao configurada no backend");
    erro.status = 500;
    throw erro;
  }

  if (typeof fetch !== "function") {
    const erro = new Error(
      "fetch nativo indisponivel. Execute o backend em Node.js 18 ou superior.",
    );
    erro.status = 500;
    throw erro;
  }

  const detalhesCarga = [];
  if (peso) detalhesCarga.push(`Peso aproximado da carga: ${peso} kg.`);
  if (dimensoes)
    detalhesCarga.push(`Dimensoes/tamanho aproximado do produto: ${dimensoes}.`);

  const candidatosPlanilha = listarCandidatosPlanilha(estadoDestino);
  const listaCandidatosTexto = candidatosPlanilha.length
    ? candidatosPlanilha
        .map(
          (item) =>
            `- ${item.nome} | telefone(s) cadastrado(s): ${item.telefones.join(", ")} | estados atendidos (planilha): ${item.estados.join(", ")}`,
        )
        .join("\n")
    : "Nenhuma transportadora da planilha interna atende esse estado.";

  const pedido = [
    `Origem: ${ORIGEM_PADRAO}.`,
    `Destino: ${cidadeDestino} - ${estadoDestino}, Brasil.`,
    ...detalhesCarga,
    "Encontre transportadoras que realizam esse frete.",
    "",
    "Transportadoras da planilha interna da empresa que, segundo o cadastro, atendem esse estado (podem estar desatualizadas, precisam ser verificadas na web antes de recomendar):",
    listaCandidatosTexto,
  ].join("\n");

  const resposta = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO_BUSCA_TRANSPORTADORAS,
      tools: [{ type: "web_search" }],
      instructions: [
        "Voce e um especialista senior em logistica e fretes rodoviarios no Brasil, com foco em encontrar transportadoras de carga (nao correios, nao motoboy) que atendam rotas especificas entre estados.",
        "Voce recebe duas fontes de candidatos: (1) uma planilha interna da empresa com transportadoras usadas no passado, que pode estar desatualizada; (2) sua propria busca livre na web.",
        "Para CADA transportadora da planilha interna que fizer sentido para essa rota, use a ferramenta de busca na web para verificar se ela ainda existe/esta em operacao e se o telefone cadastrado ainda e valido e atual.",
        "Se encontrar um telefone ou whatsapp mais atual e confiavel para uma transportadora da planilha (diferente do cadastrado), use o numero atualizado encontrado na web, nao o antigo.",
        "Se NAO conseguir confirmar na web que uma transportadora da planilha ainda existe e opera, NAO a inclua no resultado. Nunca recomende uma transportadora sem conseguir validar minimamente sua existencia atual.",
        "Alem de verificar a planilha, use a ferramenta de busca na web para pesquisar livremente por outras transportadoras relevantes nao presentes na planilha, em fontes como sites oficiais, marketplaces e guias de frete (ex: Transvias, oHub, CargoX, Central do Frete, FreteRapido, Guia da Carga, Google Maps) e diretorios setoriais.",
        "Priorize transportadoras que declarem explicitamente atender a rota entre a origem e o destino informados, ou que atuem na regiao de destino com coleta em Sao Paulo.",
        "Se peso e/ou dimensoes forem informados, priorize transportadoras compativeis com esse tipo de carga (ex: cargas pequenas/fracionadas vs cargas grandes/paletizadas).",
        "Retorne no maximo 10 transportadoras no total, ordenadas da mais relevante para a menos relevante, misturando as duas origens conforme a relevancia.",
        "No campo origem, use exatamente 'planilha' quando a transportadora veio da planilha interna (mesmo que com telefone atualizado via web), ou 'web' quando foi encontrada apenas pela sua busca livre.",
        "Para cada transportadora, preencha telefone e whatsapp no formato brasileiro com DDD (ex: (11) 91234-5678) somente quando encontrar essa informacao em uma fonte confiavel (planilha validada ou web). Nunca invente numero de telefone ou whatsapp: se nao encontrar/confirmar, retorne null.",
        "No campo fonte, informe onde a informacao foi validada (ex: site oficial, Transvias, oHub, Google Maps, planilha interna confirmada via site oficial).",
        "No campo motivoRelevancia, quando a transportadora vier da planilha, mencione brevemente que foi verificada e segue ativa.",
        "No campo resumo, escreva 2 a 3 frases resumindo o resultado da busca em portugues, mencionando quantas vieram da planilha (verificadas) e quantas foram encontradas livremente na web.",
        "Retorne apenas o JSON estruturado conforme o schema, sem texto adicional.",
      ].join("\n"),
      input: pedido,
      text: {
        format: {
          type: "json_schema",
          name: "busca_transportadoras",
          strict: true,
          schema: schemaBuscaTransportadoras,
        },
      },
      max_output_tokens: 2500,
    }),
  });

  const payload = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const mensagem =
      payload?.error?.message || "Falha ao buscar transportadoras com a IA";
    const erro = new Error(mensagem);
    erro.status = resposta.status;
    throw erro;
  }

  const textoJson = extrairTextoResposta(payload);
  if (!textoJson) {
    const erro = new Error("A IA nao retornou um resultado valido");
    erro.status = 502;
    throw erro;
  }

  return JSON.parse(textoJson);
};

export const buscarTransportadoras = async (req, res) => {
  try {
    const { estadoDestino, cidadeDestino, peso, dimensoes } = req.body;

    if (!estadoDestino || !String(estadoDestino).trim()) {
      return res.status(400).json({ error: "Estado de destino e obrigatorio" });
    }

    if (!cidadeDestino || !String(cidadeDestino).trim()) {
      return res.status(400).json({ error: "Cidade de destino e obrigatoria" });
    }

    const resultado = await chamarOpenAIParaBuscarTransportadoras({
      estadoDestino: String(estadoDestino).trim(),
      cidadeDestino: String(cidadeDestino).trim(),
      peso: peso ? String(peso).trim() : "",
      dimensoes: dimensoes ? String(dimensoes).trim() : "",
    });

    return res.json(resultado);
  } catch (error) {
    console.error("Erro ao buscar transportadoras:", error);
    return res
      .status(error.status || 500)
      .json({ error: error.message || "Erro ao buscar transportadoras" });
  }
};

// ---------------------------------------------------------------------------
// Sugestões para o checkout da equipe (entrega por transportadora)
// ---------------------------------------------------------------------------

const normalizarNome = (nome) =>
  String(nome || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(ltda|me|eireli|s\.?a|transportes?|transportadora|logistica|cargas|e|de|do|da)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Telefones da planilha sem DDD são de São Paulo.
const comDdd = (telefone) => {
  const d = String(telefone || "").replace(/\D/g, "");
  if (d.length === 8 || d.length === 9) return `(11) ${d.slice(0, d.length - 4)}-${d.slice(-4)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return telefone || null;
};

// Transportadoras que atendem a UF do cliente: planilha interna + Parceiros
// cadastrados + as já usadas em pedidos para esse estado (primeiro).
export const sugestoesCheckout = async (req, res) => {
  try {
    const uf = String(req.query.uf || "").toUpperCase().slice(0, 2);
    const parceiros = await Parceiro.findAll({ where: { tipo: "TRANSPORTADORA", ativo: true }, order: [["nome", "ASC"]] });
    const usadas = uf
      ? await Pedido.findAll({
          attributes: ["transportadoraId", [fn("COUNT", col("id")), "vezes"]],
          where: { tipo: "PEDIDO", estado: uf, transportadoraId: { [Op.ne]: null } },
          group: ["transportadoraId"],
          raw: true,
        })
      : [];
    const vezesPorId = new Map(usadas.map((u) => [u.transportadoraId, Number(u.vezes)]));

    const porNome = new Map();
    const chave = (nome) => normalizarNome(nome) || String(nome).toLowerCase();

    for (const p of parceiros) {
      porNome.set(chave(p.nome), {
        id: p.id,
        nome: p.nome.trim(),
        telefone: p.telefone || null,
        documento: p.documento || null,
        cidade: p.cidade,
        estados: p.estado ? [p.estado] : [],
        cadastrada: true,
        atende: p.estado ? p.estado === uf : null,
        vezesNoEstado: vezesPorId.get(p.id) || 0,
        origem: "cadastro",
      });
    }
    for (const t of transportadorasReferencia) {
      const atende = (t.estados || []).includes(uf);
      const existente = porNome.get(chave(t.nome));
      if (existente) {
        existente.estados = [...new Set([...existente.estados, ...(t.estados || [])])];
        existente.atende = existente.atende || atende;
        existente.telefone = existente.telefone || comDdd(t.telefones?.[0]);
        existente.abrangencia = t.abrangencia_original;
        existente.origem = "cadastro+planilha";
      } else if (atende) {
        porNome.set(chave(t.nome), {
          id: null,
          nome: t.nome.trim(),
          telefone: comDdd(t.telefones?.[0]),
          telefones: (t.telefones || []).map(comDdd),
          estados: t.estados,
          abrangencia: t.abrangencia_original,
          cadastrada: false,
          atende: true,
          vezesNoEstado: 0,
          origem: "planilha",
        });
      }
    }

    const lista = [...porNome.values()];
    const peso = (t) => (t.vezesNoEstado > 0 ? 0 : t.atende === true ? 1 : t.atende === null ? 2 : 3);
    lista.sort((a, b) => peso(a) - peso(b) || b.vezesNoEstado - a.vezesNoEstado || a.nome.localeCompare(b.nome, "pt-BR"));
    res.json({
      uf,
      atendem: lista.filter((t) => t.atende === true || t.vezesNoEstado > 0),
      outras: lista.filter((t) => !(t.atende === true || t.vezesNoEstado > 0)),
    });
  } catch (error) {
    console.error("Erro ao sugerir transportadoras:", error);
    res.status(500).json({ error: "Erro ao sugerir transportadoras" });
  }
};
