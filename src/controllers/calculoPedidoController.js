import {
  CAMPOS_PRODUTO,
  CATALOGO_CAIXAS,
  calcularPedido,
  calcularVolumeBolinhasLitros,
  calcularVolumePecasLitros,
  listarPecasSemDescricao,
  sugerirEmpacotamentoPorVolume,
} from "../services/pedidoCalculoEngine.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELO_CALCULADORA =
  process.env.OPENAI_MODEL_CALCULADORA ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";

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

const LABEL_POR_CHAVE = Object.fromEntries(
  CAMPOS_PRODUTO.map(({ chave, label }) => [chave, label]),
);

const normalizarDimensoesPecas = (dimensoesBrutas = {}) => {
  const dimensoes = {};
  for (const { chave } of CAMPOS_PRODUTO) {
    const dim = dimensoesBrutas?.[chave];
    if (!dim) continue;
    const altura = Number(dim.altura);
    const largura = Number(dim.largura);
    const comprimento = Number(dim.comprimento);
    if (altura > 0 && largura > 0 && comprimento > 0) {
      dimensoes[chave] = { altura, largura, comprimento };
    }
  }
  return dimensoes;
};

const normalizarProdutosPersonalizados = (lista) => {
  if (!Array.isArray(lista)) return [];

  return lista
    .map((item) => ({
      nome: String(item?.nome || "").trim(),
      quantidade: Number(item?.quantidade) || 0,
      pesoUnitario: item?.pesoUnitario ? Number(item.pesoUnitario) : null,
      altura: item?.altura ? Number(item.altura) : null,
      largura: item?.largura ? Number(item.largura) : null,
      comprimento: item?.comprimento ? Number(item.comprimento) : null,
    }))
    .filter((item) => item.nome && item.quantidade > 0);
};

const somarPesoProdutosPersonalizados = (produtosPersonalizados) =>
  produtosPersonalizados.reduce((soma, item) => {
    if (!item.pesoUnitario) return soma;
    return soma + item.pesoUnitario * item.quantidade;
  }, 0);

const somarVolumeProdutosPersonalizadosLitros = (produtosPersonalizados) =>
  produtosPersonalizados.reduce((soma, item) => {
    if (!item.altura || !item.largura || !item.comprimento) return soma;
    return soma + (item.altura * item.largura * item.comprimento * item.quantidade) / 1000;
  }, 0);

const formatarNomeCaixa = (empacotamento) => {
  if (!empacotamento) return null;
  return empacotamento.quantidade > 1
    ? `${empacotamento.nome} x${empacotamento.quantidade}`
    : empacotamento.nome;
};

export const calcular = (req, res) => {
  try {
    const { quantidades, produtosPersonalizados, dimensoesPecas } = req.body;

    const resultadoEngine = calcularPedido(quantidades);
    const dimensoesPecasNormalizadas = normalizarDimensoesPecas(dimensoesPecas);

    const pecasSemDescricao = listarPecasSemDescricao(
      resultadoEngine.quantidades,
      dimensoesPecasNormalizadas,
    );
    if (pecasSemDescricao.length > 0) {
      return res.status(400).json({
        error:
          "Descreva o tamanho (Altura x Largura x Comprimento) dos itens abaixo antes de calcular - eles não têm um tamanho padrão cadastrado no sistema.",
        pecasSemDescricao: pecasSemDescricao.map((chave) => LABEL_POR_CHAVE[chave]),
      });
    }

    const produtosCustom = normalizarProdutosPersonalizados(
      produtosPersonalizados,
    );
    const produtosCustomSemDescricao = produtosCustom.filter(
      (item) => !item.altura || !item.largura || !item.comprimento,
    );
    if (produtosCustomSemDescricao.length > 0) {
      return res.status(400).json({
        error:
          "Descreva o tamanho (Altura x Largura x Comprimento) de todos os produtos personalizados antes de calcular.",
        produtosSemDescricao: produtosCustomSemDescricao.map((item) => item.nome),
      });
    }

    const pesoProdutosCustom = somarPesoProdutosPersonalizados(produtosCustom);

    const volumeBolinhasLitros = calcularVolumeBolinhasLitros(
      resultadoEngine.quantidades,
    );
    const volumePecasLitros = calcularVolumePecasLitros(
      resultadoEngine.quantidades,
      dimensoesPecasNormalizadas,
    );
    const volumeProdutosCustomLitros = somarVolumeProdutosPersonalizadosLitros(
      produtosCustom,
    );
    const volumeTotalLitros =
      volumeBolinhasLitros + volumePecasLitros + volumeProdutosCustomLitros;

    // Grounding numerico sempre calculado (mesmo quando a regra legada bate
    // certo) para a IA usar como referencia confiavel na analise sob demanda.
    const empacotamentoVolumetrico = sugerirEmpacotamentoPorVolume(
      volumeTotalLitros,
    );

    return res.json({
      quantidades: resultadoEngine.quantidades,
      nfTotal: resultadoEngine.nfTotal,
      pesoTotal: resultadoEngine.pesoTotal + pesoProdutosCustom,
      pesoEngine: resultadoEngine.pesoTotal,
      pesoProdutosPersonalizados: pesoProdutosCustom,
      volumeTotalLitros,
      empacotamentoVolumetrico,
      produtosPersonalizados: produtosCustom,
      dimensoesPecas: dimensoesPecasNormalizadas,
    });
  } catch (error) {
    console.error("Erro ao calcular pedido:", error);
    return res.status(500).json({ error: "Erro ao calcular pedido" });
  }
};

const schemaOpcaoEmbalagem = {
  type: "object",
  additionalProperties: false,
  required: ["nomeOpcao", "caixas", "resumoOpcao"],
  properties: {
    nomeOpcao: {
      type: "string",
      description: "Nome curto da opcao, ex: 'Opcao 1 - 2 volumes'",
    },
    caixas: {
      type: "array",
      description: "1 a 3 volumes/caixas que compoem essa opcao",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimensoes", "tipo", "itensAlocados", "justificativa"],
        properties: {
          dimensoes: {
            type: "string",
            description: "Formato AxLxC em cm, ex: 40x40x40",
          },
          tipo: { type: "string", enum: ["padrao", "nova"] },
          itensAlocados: { type: "string" },
          justificativa: { type: "string" },
        },
      },
    },
    resumoOpcao: { type: "string" },
  },
};

const schemaAnaliseCaixas = {
  type: "object",
  additionalProperties: false,
  required: ["opcao1", "opcao2", "resumo"],
  properties: {
    opcao1: schemaOpcaoEmbalagem,
    opcao2: schemaOpcaoEmbalagem,
    resumo: { type: "string" },
  },
};

const chamarOpenAIParaAnalisarCaixas = async ({
  quantidades,
  dimensoesPecas,
  produtosPersonalizados,
  volumeTotalLitros,
  empacotamentoVolumetrico,
  pesoTotal,
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

  const listaQuantidadesConhecidas = CAMPOS_PRODUTO.filter(
    ({ chave }) => quantidades[chave] > 0,
  )
    .map(({ chave, label }) => {
      const dim = dimensoesPecas?.[chave];
      const dimTexto = dim
        ? ` (unidade descrita pelo usuario: ${dim.altura}x${dim.largura}x${dim.comprimento} cm)`
        : "";
      return `- ${label}: ${quantidades[chave]} unidades${dimTexto}`;
    })
    .join("\n");

  const listaProdutosPersonalizados = produtosPersonalizados.length
    ? produtosPersonalizados
        .map((item) => {
          const pesoTexto = item.pesoUnitario
            ? `${item.pesoUnitario} kg por unidade`
            : "peso nao informado";
          return `- ${item.nome}: ${item.quantidade} unidades, ${item.altura}x${item.largura}x${item.comprimento} cm por unidade, ${pesoTexto}`;
        })
        .join("\n")
    : "Nenhum produto personalizado informado.";

  const listaCatalogoCaixas = CATALOGO_CAIXAS.map(
    (caixa) =>
      `- ${caixa.nome} (Altura x Largura x Comprimento em cm, volume interno ~${caixa.volumeLitros.toFixed(1)} litros)`,
  ).join("\n");

  const referenciaVolumetrica = empacotamentoVolumetrico
    ? `Ja existe um calculo matematico (volume real das bolinhas esfericas + volume AxLxC descrito para os demais itens, com fator de ocupacao de esferas soltas de 60% e aproveitamento de caixa de 85%) apontando que esse pedido precisa de aproximadamente ${volumeTotalLitros.toFixed(1)} litros uteis, e que a opcao mais simples seria ${formatarNomeCaixa(empacotamentoVolumetrico)}. Use esse numero como ponto de partida confiavel - nao precisa recalcular do zero, apenas racionalize distribuicoes diferentes em cima dele.`
    : `Volume total estimado do pedido: ${volumeTotalLitros.toFixed(1)} litros uteis (ja calculado matematicamente a partir do volume real dos itens).`;

  const pedido = [
    `Peso total estimado do pedido: ${pesoTotal.toFixed(2)} kg.`,
    referenciaVolumetrica,
    "",
    "Itens de catalogo conhecido presentes no pedido:",
    listaQuantidadesConhecidas || "Nenhum item de catalogo conhecido.",
    "",
    "Produtos personalizados (fora do catalogo conhecido, informados manualmente pelo usuario, com dimensoes reais):",
    listaProdutosPersonalizados,
  ].join("\n");

  const resposta = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO_CALCULADORA,
      instructions: [
        "Voce e um especialista em logistica e embalagem de pedidos para uma empresa de maquinas de pelucia/capsula (Agarra Mais / Gira Kids).",
        "Um calculo matematico determinístico (fora do seu controle) ja estimou o volume real necessario para esse pedido, com base no volume fisico dos itens - isso ja esta no texto do pedido abaixo. NAO ignore esse numero e NAO proponha uma caixa com volume interno visivelmente menor que o volume util necessario informado: isso resultaria numa caixa que fisicamente nao fecha.",
        "",
        "GLOSSARIO DE TAMANHOS - os itens '1pol', '2pol', '27mm', '32mm' e '45mm' sao TODOS bolinhas/capsulas plasticas esfericas (brinquedos de maquina de bolinha), vendidas e embaladas a granel, do menor para o maior:",
        "- 1pol (1 polegada = ~25mm de diametro): a bolinha mais pequena do catalogo, tamanho de uma bolinha de gude pequena.",
        "- 27mm de diametro: bolinha pequena, praticamente do mesmo tamanho da 1pol, do tamanho da ponta de um dedo (ponta do polegar).",
        "- 32mm de diametro: bolinha pequena-media, um pouco maior que a 27mm, proxima ao tamanho de uma azeitona grande ou de uma bolinha de gude grande.",
        "- 45mm de diametro: bolinha media-grande, proxima ao tamanho de uma bola de golfe (que tem ~42mm).",
        "- 2pol (2 polegadas = ~50mm de diametro): a maior bolinha do catalogo, tamanho de uma bola de pingue-pongue grande, quase do tamanho de uma bola de bilhar/sinuca (~57mm).",
        "'Cap 1' e 'Cap 2' sao as tampinhas plasticas finas e leves dos dispensers dessas bolinhas; ocupam pouquissimo volume e peso, podem ser encaixadas em qualquer espaco sobrando na caixa.",
        "Os demais itens do catalogo (Square/Globinho, GV Todas, Pedestal X, Pedestal Redondo, Hack, Cuba, Chiclete, Pelucia), quando presentes, ja vem com as dimensoes AxLxC que o proprio usuario descreveu - use exatamente essas dimensoes, nao invente outras.",
        "",
        "Seu trabalho e distribuir esse volume ja calculado em caixas de papelao reais, preferindo sempre reaproveitar uma das caixas do catalogo padrao da empresa quando ela comportar os itens (por volume E por dimensao - o maior lado de um item individual deve caber dentro do menor lado util da caixa escolhida).",
        `Catalogo de caixas padrao ja usadas pela empresa:\n${listaCatalogoCaixas}`,
        "PRIORIDADE DE EMPACOTAMENTO (vale para QUALQUER produto ou combinacao de produtos, sem excecao) - o objetivo e sempre ENCHER AS CAIXAS ATE A BOCA, usando o volume interno disponivel ao maximo, e usar a MAIOR quantidade possivel de volumes com as MENORES caixas do catalogo:",
        "- Se o volume util necessario cabe dentro do volume interno de uma caixa do catalogo (mesmo que ocupe quase 100% dela, bem proximo do limite), considere que essa caixa CABE e essa e a melhor opcao - nao pule para uma caixa maior so por sobrar pouco espaco. Encher a caixa até a boca é o objetivo, não um problema.",
        "- Exemplo concreto: se 1000 bolinhas de 32mm enchem uma caixa 30x30x35 até a boca (ocupando quase todo o volume interno dela), a caixa 30x30x35 e a resposta correta para essas 1000 bolinhas - NAO proponha uma caixa maior so para sobrar folga.",
        "- Ao dividir um pedido grande em varias caixas, prefira SEMPRE varias unidades da MENOR caixa que comporte um lote cheio dela (cada volume enchido até a boca) em vez de poucas caixas grandes com espaco sobrando. So suba para uma caixa maior quando a menor caixa do catalogo nao comportar nem um item individual (ex: uma peca fisica maior que a menor caixa).",
        "- 'Comportar' significa o volume necessario ser menor ou igual ao volume interno da caixa (nao deixe margem de seguranca artificial); a unica excecao e quando dimensoes de um item individual (nao a granel) realmente nao cabem fisicamente dentro da caixa, mesmo com espaco de volume sobrando.",
        "Quando nenhuma caixa do catalogo sozinha comportar tudo, prefira dividir em varias unidades da MESMA caixa pequena, cada uma cheia ate a boca (explique a divisao no campo itensAlocados), em vez de trocar para uma caixa maior.",
        "So proponha uma caixa 'nova' (tipo=nova) quando nenhuma combinacao das caixas padrao for razoavel; nesse caso, sugira dimensoes no formato AxLxC em cm que comportem os itens ja bem ajustadas (sem folga desnecessaria), sempre com volume interno igual ou maior que o volume util necessario informado.",
        "",
        "IMPORTANTE - voce deve gerar SEMPRE DUAS opcoes de embalagem diferentes entre si (opcao1 e opcao2), para o time comercial escolher:",
        "- Cada opcao pode usar 1, 2 ou 3 volumes/caixas no total, de tamanhos iguais ou diferentes entre si dentro da mesma opcao.",
        "- As duas opcoes precisam ser realmente distintas (numero de volumes diferente, e/ou tamanhos de caixa diferentes, e/ou forma de dividir os itens diferente) - nunca repita a mesma composicao nas duas.",
        "- Em AMBAS as opcoes, aplique a prioridade de empacotamento acima (mais volumes de caixas menores). A opcao1 deve ser a que usa a MENOR caixa possivel (com mais volumes dela). A opcao2 pode usar a segunda menor caixa do catalogo que fizer sentido (ainda assim preferindo mais volumes dela a poucas caixas grandes).",
        "- A soma dos volumes internos das caixas de CADA opcao precisa ser suficiente para o volume util necessario informado no inicio.",
        "- No campo resumoOpcao de cada opcao, explique rapidamente o raciocinio dessa opcao especifica.",
        "- No campo resumo (geral), compare as duas opcoes em 2-3 frases e, se fizer sentido, diga qual delas voce recomendaria e por que.",
        "Responda sempre em portugues, de forma objetiva.",
        "Retorne apenas o JSON estruturado conforme o schema, sem texto adicional.",
      ].join("\n"),
      input: pedido,
      text: {
        format: {
          type: "json_schema",
          name: "analise_caixas_pedido",
          strict: true,
          schema: schemaAnaliseCaixas,
        },
      },
      max_output_tokens: 1500,
    }),
  });

  const payload = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const mensagem =
      payload?.error?.message || "Falha ao analisar caixas com a IA";
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

export const analisarComIA = async (req, res) => {
  try {
    const {
      quantidades,
      dimensoesPecas,
      produtosPersonalizados,
      volumeTotalLitros,
      empacotamentoVolumetrico,
      pesoTotal,
    } = req.body;

    if (typeof volumeTotalLitros !== "number" || typeof pesoTotal !== "number") {
      return res.status(400).json({
        error: "Envie volumeTotalLitros e pesoTotal calculados previamente",
      });
    }

    const resultadoEngine = calcularPedido(quantidades);
    const dimensoesPecasNormalizadas = normalizarDimensoesPecas(dimensoesPecas);
    const produtosCustom = normalizarProdutosPersonalizados(
      produtosPersonalizados,
    );

    const analise = await chamarOpenAIParaAnalisarCaixas({
      quantidades: resultadoEngine.quantidades,
      dimensoesPecas: dimensoesPecasNormalizadas,
      produtosPersonalizados: produtosCustom,
      volumeTotalLitros,
      empacotamentoVolumetrico,
      pesoTotal,
    });

    return res.json(analise);
  } catch (error) {
    console.error("Erro ao analisar caixas com IA:", error);
    return res
      .status(error.status || 500)
      .json({ error: error.message || "Erro ao analisar caixas com IA" });
  }
};
