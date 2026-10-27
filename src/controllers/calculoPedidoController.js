import {
  calcularPedidoCompleto,
  lerParametros,
  salvarParametros,
} from "../services/pedidoCalculoEngine.js";
import { erroHttp, responderErro } from "../utils/helpers.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELO_CALCULADORA =
  process.env.OPENAI_MODEL_CALCULADORA || process.env.OPENAI_MODEL || "gpt-4.1-mini";

const entradaDe = (corpo = {}) => ({
  quantidades: corpo.quantidades || {},
  medidas: corpo.medidas || corpo.dimensoesPecas || {},
  avulsos: corpo.avulsos || corpo.produtosPersonalizados || [],
});

// Valor de nota, peso, volume e distribuição em caixas.
export const calcular = async (req, res) => {
  try {
    const resultado = await calcularPedidoCompleto(entradaDe(req.body));
    if (!resultado.itens.length) throw erroHttp(400, "Informe a quantidade de pelo menos um item.");
    if (resultado.faltandoMedidas.length) {
      return res.status(400).json({
        error: `Informe as medidas por unidade (A x L x C em cm) de: ${resultado.faltandoMedidas.join(", ")}.`,
        faltandoMedidas: resultado.faltandoMedidas,
      });
    }
    res.json(resultado);
  } catch (error) {
    responderErro(res, error, "Erro ao calcular pedido");
  }
};

export const parametros = async (req, res) => {
  try {
    res.json(await lerParametros());
  } catch (error) {
    responderErro(res, error, "Erro ao carregar parâmetros");
  }
};

export const atualizarParametros = async (req, res) => {
  try {
    res.json(await salvarParametros(req.body || {}, req.usuario?.nome));
  } catch (error) {
    responderErro(res, error, "Erro ao salvar parâmetros");
  }
};

// ---------------------------------------------------------------------------
// Segunda opinião da IA (opcional): parte do plano calculado.
// ---------------------------------------------------------------------------

const extrairTextoResposta = (resposta) => {
  if (typeof resposta?.output_text === "string") return resposta.output_text;
  const textos = [];
  for (const item of resposta?.output || []) {
    for (const conteudo of item?.content || []) {
      if (conteudo?.type === "output_text" && conteudo?.text) textos.push(conteudo.text);
    }
  }
  return textos.join("\n").trim();
};

const schemaOpcao = {
  type: "object",
  additionalProperties: false,
  required: ["nomeOpcao", "caixas", "resumoOpcao"],
  properties: {
    nomeOpcao: { type: "string" },
    caixas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimensoes", "tipo", "itensAlocados", "justificativa"],
        properties: {
          dimensoes: { type: "string", description: "AxLxC em cm, ex: 40x40x40" },
          tipo: { type: "string", enum: ["padrao", "nova"] },
          itensAlocados: { type: "string" },
          justificativa: { type: "string" },
        },
      },
    },
    resumoOpcao: { type: "string" },
  },
};

const schemaAnalise = {
  type: "object",
  additionalProperties: false,
  required: ["opcao1", "opcao2", "resumo"],
  properties: { opcao1: schemaOpcao, opcao2: schemaOpcao, resumo: { type: "string" } },
};

export const analisarComIA = async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) throw erroHttp(503, "IA não configurada (OPENAI_API_KEY).");
    const [resultado, params] = await Promise.all([calcularPedidoCompleto(entradaDe(req.body)), lerParametros()]);
    if (!resultado.itens.length || resultado.faltandoMedidas.length) throw erroHttp(400, "Calcule o pedido antes de pedir a análise da IA.");

    const litrosRef = params.caixas.find((c) => c.nome === params.referencia).litros;
    const referencia = params.itens
      .filter((i) => i.granel)
      .map((i) => `- ${i.label}: ${i.porCaixaRef} un. por caixa ${params.referencia} (${((litrosRef / i.porCaixaRef) * 1000).toFixed(0)} cm³ por unidade, já contando o espaço vazio)`)
      .join("\n");
    const pedido = [
      `Itens: ${resultado.itens.map((i) => `${i.quantidade} × ${i.label}`).join("; ")}.`,
      `Volume ocupado: ${resultado.resumo.litros} L. Peso: ${resultado.resumo.pesoKg} kg.`,
      `Plano calculado pelo sistema: ${resultado.volumes.map((v, n) => `volume ${n + 1} = caixa ${v.caixa} (${v.ocupacao}% cheia, ${v.pesoKg} kg) com ${v.itens.map((i) => `${i.quantidade} ${i.label}`).join(" + ")}`).join("; ")}.`,
    ].join("\n");

    const resposta = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELO_CALCULADORA,
        instructions: [
          "Você é especialista em embalagem e expedição da Gira Kids (brinquedos para máquinas de grua e vending).",
          'Glossário: Encapsulado 1" e 2" = brinquedos dentro de cápsulas plásticas de 1 e 2 polegadas; Cápsula vazia 1"/2" = só a cápsula; Bolinha 27/32/45mm = bolinhas pula-pula maciças; os demais são peças/máquinas com medidas informadas.',
          `Base de capacidade (medida real da loja, caixa de referência ${params.referencia}):\n${referencia}`,
          `Caixas disponíveis (A x L x C em cm): ${params.caixas.map((c) => `${c.nome} (${c.litros.toFixed(0)} L)`).join(", ")}.`,
          "Regras: cada caixa comporta no máximo o volume dela (as capacidades acima já consideram o espaço vazio); encha as caixas até a boca; limite de 30 kg por volume para PAC/SEDEX.",
          "Proponha DUAS opções diferentes do plano do sistema e entre si (ex.: menos volumes; caixas menores e mais fáceis de manusear; ou separar peças do granel). Use só caixas da lista; caixa nova (tipo=nova) apenas se uma peça não couber em nenhuma.",
          "Em itensAlocados escreva as quantidades exatas por caixa. No resumo compare as opções com o plano do sistema em até 3 frases e diga qual recomenda.",
          "Responda em português, objetivo, apenas no JSON do schema.",
        ].join("\n"),
        input: pedido,
        text: { format: { type: "json_schema", name: "analise_caixas", strict: true, schema: schemaAnalise } },
        max_output_tokens: 1500,
      }),
    });
    const payload = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw erroHttp(502, payload?.error?.message || "Falha ao consultar a IA.");
    const texto = extrairTextoResposta(payload);
    if (!texto) throw erroHttp(502, "A IA não retornou um resultado válido.");
    res.json(JSON.parse(texto));
  } catch (error) {
    responderErro(res, error, "Erro ao analisar caixas com IA");
  }
};
