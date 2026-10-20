import fs from "fs";
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
