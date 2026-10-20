export const CAMPOS_PRODUTO = [
  { chave: "qtd1pol", label: "1pol" },
  { chave: "qtd2pol", label: "2pol" },
  { chave: "qtd27mm", label: "27mm" },
  { chave: "qtd32mm", label: "32mm" },
  { chave: "qtd45mm", label: "45mm" },
  { chave: "caps1pol", label: "Cap 1" },
  { chave: "caps2pol", label: "Cap 2" },
  { chave: "squareGlobinho", label: "Square/Globinho" },
  { chave: "gvTodas", label: "GV Todas" },
  { chave: "pedestalX", label: "Pedestal X" },
  { chave: "hack", label: "Hack" },
  { chave: "cuba", label: "Cuba" },
  { chave: "pelucia", label: "Pelúcia" },
  { chave: "chiclete", label: "Chiclete" },
  { chave: "pedestalRedondo", label: "Pedestal Redondo" },
];

// Catálogo de caixas padrão já usadas pela empresa (dimensões em cm, Altura x Largura x Comprimento)
export const CATALOGO_CAIXAS = [
  { nome: "30x30x35", altura: 30, largura: 30, comprimento: 35 },
  { nome: "30x30x40", altura: 30, largura: 30, comprimento: 40 },
  { nome: "40x40x40", altura: 40, largura: 40, comprimento: 40 },
  { nome: "30x60x50", altura: 30, largura: 60, comprimento: 50 },
  { nome: "50x60x50", altura: 50, largura: 60, comprimento: 50 },
  { nome: "70x50x60", altura: 70, largura: 50, comprimento: 60 },
].map((caixa) => ({
  ...caixa,
  volumeLitros: (caixa.altura * caixa.largura * caixa.comprimento) / 1000,
}));

// Python sempre imprime float de divisão com decimal (ex: 3.0, 2.25); replica aqui.
const formatarDivisao = (valor) =>
  Number.isInteger(valor) ? `${valor}.0` : `${valor}`;

// Campos que são bolinhas/cápsulas esféricas com diâmetro conhecido (mm).
const DIAMETRO_MM_BOLINHA = {
  qtd1pol: 25.4,
  qtd27mm: 27,
  qtd32mm: 32,
  qtd45mm: 45,
  qtd2pol: 50.8,
};

const volumeEsferaCm3 = (diametroMm) => {
  const raioCm = diametroMm / 2 / 10;
  return (4 / 3) * Math.PI * raioCm ** 3;
};

const VOLUME_UNITARIO_BOLINHA_CM3 = Object.fromEntries(
  Object.entries(DIAMETRO_MM_BOLINHA).map(([chave, diametro]) => [
    chave,
    volumeEsferaCm3(diametro),
  ]),
);

// Esferas soltas dentro de uma caixa nunca preenchem 100% do volume: ~55-65%
// de aproveitamento real é o padrão físico de empacotamento aleatório de esferas.
const FATOR_OCUPACAO_BOLINHAS = 0.6;

// Prioridade do negócio: encher a caixa até a boca, usando todo o volume
// interno disponível, em vez de reservar margem "de segurança".
const FATOR_APROVEITAMENTO_CAIXA = 1.0;

// Itens sem tamanho físico conhecido no catálogo (só têm fórmula de preço/peso,
// nunca dimensão) - o usuário precisa descrever a caixa AxLxC antes de calcular.
export const CAMPOS_SEM_TAMANHO_CONHECIDO = [
  "caps1pol",
  "caps2pol",
  "squareGlobinho",
  "gvTodas",
  "pedestalX",
  "hack",
  "cuba",
  "pelucia",
  "chiclete",
  "pedestalRedondo",
];

// Volume real necessário (em litros) só para os itens que são bolinhas/cápsulas,
// já descontando o espaço vazio entre as esferas.
export const calcularVolumeBolinhasLitros = (quantidades) => {
  let cm3 = 0;
  for (const chave of Object.keys(VOLUME_UNITARIO_BOLINHA_CM3)) {
    cm3 += (quantidades[chave] || 0) * VOLUME_UNITARIO_BOLINHA_CM3[chave];
  }
  return cm3 / FATOR_OCUPACAO_BOLINHAS / 1000;
};

// Volume (em litros) dos itens sem tamanho conhecido, a partir das dimensões
// AxLxC (cm) que o usuário descreveu para cada um.
export const calcularVolumePecasLitros = (quantidades, dimensoesPecas = {}) => {
  let cm3 = 0;
  for (const chave of CAMPOS_SEM_TAMANHO_CONHECIDO) {
    const qtd = quantidades[chave] || 0;
    if (qtd <= 0) continue;
    const dim = dimensoesPecas[chave];
    if (!dim || !dim.altura || !dim.largura || !dim.comprimento) continue;
    cm3 += qtd * dim.altura * dim.largura * dim.comprimento;
  }
  return cm3 / 1000;
};

// Lista, dentre os campos sem tamanho conhecido, quais têm quantidade > 0 mas
// ainda não tiveram suas dimensões descritas pelo usuário.
export const listarPecasSemDescricao = (quantidades, dimensoesPecas = {}) =>
  CAMPOS_SEM_TAMANHO_CONHECIDO.filter((chave) => (quantidades[chave] || 0) > 0).filter(
    (chave) => {
      const dim = dimensoesPecas[chave];
      return !dim || !dim.altura || !dim.largura || !dim.comprimento;
    },
  );

// Sugestão determinística (sem IA) de embalagem a partir do volume total
// necessário: prioriza sempre a MAIOR quantidade de volumes da MENOR caixa
// do catálogo que comporte tudo, em vez de menos caixas grandes.
export const sugerirEmpacotamentoPorVolume = (litrosNecessarios) => {
  if (!litrosNecessarios || litrosNecessarios <= 0) return null;

  const capacidadeUtilLitros = (caixa) =>
    caixa.volumeLitros * FATOR_APROVEITAMENTO_CAIXA;

  const ordenadoPorVolume = [...CATALOGO_CAIXAS].sort(
    (a, b) => a.volumeLitros - b.volumeLitros,
  );

  const menorCaixa = ordenadoPorVolume[0];
  const quantidade = Math.max(
    1,
    Math.ceil(litrosNecessarios / capacidadeUtilLitros(menorCaixa)),
  );

  return {
    nome: menorCaixa.nome,
    quantidade,
    volumeNecessarioLitros: litrosNecessarios,
  };
};

const normalizarQuantidades = (quantidadesBrutas = {}) => {
  const quantidades = {};
  for (const { chave } of CAMPOS_PRODUTO) {
    const valor = Number(quantidadesBrutas[chave]);
    quantidades[chave] = Number.isFinite(valor) && valor > 0 ? valor : 0;
  }
  return quantidades;
};

export const calcularNfEPeso = (quantidades) => {
  const {
    qtd1pol,
    qtd2pol,
    qtd27mm,
    qtd32mm,
    qtd45mm,
    caps1pol,
    caps2pol,
    squareGlobinho,
    gvTodas,
    pedestalX,
    hack,
    cuba,
    pelucia,
    chiclete,
    pedestalRedondo,
  } = quantidades;

  const nf1 =
    qtd1pol * 0.05 +
    qtd2pol * 0.14 +
    qtd27mm * 0.08 +
    caps1pol * 0.04 +
    caps2pol * 0.1 +
    squareGlobinho * 57.0 +
    gvTodas * 195.0 +
    pedestalX * 19.0;

  const nf2 =
    qtd32mm * 0.16 +
    qtd45mm * 0.44 +
    hack * 45.0 +
    cuba * 26.0 +
    pelucia * 2.33 +
    chiclete * 97.5 +
    pedestalRedondo * 19.0;

  const peso1 =
    qtd1pol * 0.01 +
    qtd2pol * 0.01 +
    qtd27mm * 0.01 +
    chiclete * 6.0 +
    pedestalX * 6.0 +
    caps1pol * 0.003 +
    caps2pol * 0.006 +
    squareGlobinho * 6.0;

  const peso2 =
    qtd32mm * 0.025 +
    qtd45mm * 0.05 +
    gvTodas * 10.0 +
    hack * 10.0 +
    pelucia * 0.0035 +
    cuba * 0.5 +
    pedestalRedondo * 10.0;

  return {
    nfTotal: nf1 + nf2,
    pesoTotal: peso1 + peso2,
  };
};

// Portado 1:1 do sistema legado em Python (18GKSISTEM.py), mesma ordem e limiares.
// A primeira regra que bater decide o resultado - não reordenar.
export const determinarCaixaLegado = (quantidades) => {
  const {
    qtd1pol,
    qtd2pol,
    qtd27mm,
    qtd32mm,
    qtd45mm,
    caps1pol,
    caps2pol,
    squareGlobinho,
    gvTodas,
    pedestalX,
    hack,
    cuba,
    pelucia,
    chiclete,
    pedestalRedondo,
  } = quantidades;

  const div27 = qtd27mm / 2000;
  const div2pol = qtd2pol / 1000;
  const total2pol = qtd2pol + qtd45mm;

  if (
    caps1pol !== 0 ||
    caps2pol !== 0 ||
    squareGlobinho !== 0 ||
    gvTodas !== 0 ||
    pedestalX !== 0 ||
    hack !== 0 ||
    cuba !== 0 ||
    pelucia !== 0 ||
    chiclete !== 0 ||
    pedestalRedondo !== 0
  ) {
    return "Personalizada (peças ou pelúcias)";
  }
  if (qtd1pol === 100 && qtd32mm <= 700) return "30x30x40";
  if (qtd1pol === 100 && qtd27mm <= 1600) return "30x30x35";
  if (qtd1pol === 400 && qtd32mm === 500) return "30x30x35";
  if (
    400 >= qtd1pol &&
    qtd1pol >= 300 &&
    600 >= qtd32mm &&
    qtd32mm >= 500 &&
    200 >= qtd2pol &&
    qtd2pol >= 100
  )
    return "30x60x50";
  if (
    qtd2pol === 100 &&
    ((400 >= qtd1pol && qtd1pol > 100) ||
      (500 > qtd27mm && qtd27mm > 250) ||
      (500 > qtd32mm && qtd32mm > 100))
  )
    return "30x60x50";
  if (
    qtd2pol === 100 &&
    (qtd1pol === 100 || qtd27mm === 250 || qtd32mm === 100)
  )
    return "40x40x40";
  if (500 >= qtd2pol && qtd2pol >= 300) return "50x60x50";
  if (1000 >= qtd2pol && qtd2pol > 500) return "70x50x60";
  if (
    400 >= qtd2pol &&
    qtd2pol >= 300 &&
    (qtd1pol === 100 || qtd27mm === 250 || qtd32mm === 100)
  )
    return "50x60x50";
  if (1100 > qtd27mm && qtd27mm >= 1000 && 1100 > qtd32mm && qtd32mm >= 1000)
    return "30x30x35 e 30x30x35";
  if (
    1500 >= qtd2pol &&
    qtd2pol >= 1000 &&
    ((700 >= qtd1pol && qtd1pol > 0) ||
      (1000 >= qtd32mm && qtd32mm > 0) ||
      (2000 >= qtd27mm && qtd27mm > 0))
  )
    return "70x50x60 e 40x40x40";
  if (
    1500 >= qtd2pol &&
    qtd2pol >= 1000 &&
    ((2000 >= qtd1pol && qtd1pol > 1000) ||
      (2000 >= qtd32mm && qtd32mm > 1000) ||
      (4000 >= qtd27mm && qtd27mm > 2000))
  )
    return "70x50x60 e 30x60x50";
  if (1500 >= qtd2pol && qtd2pol >= 1000) return "70x50x60 e 40x40x40";
  if (2000 >= qtd2pol && qtd2pol >= 1500) return "70x50x60 e 70x50x60";
  if (2000 >= qtd2pol && qtd2pol >= 1500 && 2000 >= qtd1pol && qtd1pol > 1200)
    return "70x50x60 e 70x60x50 e 30x30x35";
  if (
    400 >= qtd45mm &&
    qtd45mm >= 300 &&
    (qtd1pol === 100 || qtd27mm === 250 || qtd32mm === 100 || qtd2pol === 100)
  )
    return "50x60x50";
  if (1100 > qtd27mm && qtd27mm >= 1000 && 1100 > qtd32mm && qtd32mm >= 1000)
    return "30x30x35 e 30x30x35";
  if (
    1500 >= qtd45mm &&
    qtd45mm >= 1000 &&
    ((700 >= qtd1pol && qtd1pol > 0) ||
      (1000 >= qtd32mm && qtd32mm > 0) ||
      (2000 >= qtd27mm && qtd27mm > 0) ||
      (500 >= qtd2pol && qtd2pol > 200))
  )
    return "70x50x60 e 40x40x40";
  if (
    1500 >= qtd45mm &&
    qtd45mm >= 1000 &&
    ((2000 >= qtd1pol && qtd1pol > 1000) ||
      (2000 >= qtd32mm && qtd32mm > 1000) ||
      (4000 >= qtd27mm && qtd27mm > 2000))
  )
    return "70x50x60 e 30x60x50";
  if (1500 >= qtd45mm && qtd45mm >= 1000) return "70x50x60 e 40x40x40";
  if (2000 >= qtd45mm && qtd45mm >= 1500) return "70x50x60 e 70x50x60";
  if (2000 >= qtd45mm && qtd45mm >= 1500 && 2000 >= qtd1pol && qtd1pol > 1200)
    return "70x50x60 e 70x60x50 e 30x30x35";
  if (600 > total2pol && total2pol >= 500) return "40x40x40";
  if (
    500 > qtd45mm &&
    qtd45mm > 0 &&
    ((700 >= qtd1pol && qtd1pol > 0) ||
      (1000 >= qtd32mm && qtd32mm > 0) ||
      (2000 >= qtd27mm && qtd27mm > 0))
  )
    return "30x30x35 e 30x30x35";
  if (
    500 > qtd45mm &&
    qtd45mm > 0 &&
    ((2000 >= qtd1pol && qtd1pol > 1000) ||
      (2000 >= qtd32mm && qtd32mm > 1000) ||
      (4000 >= qtd27mm && qtd27mm > 2000))
  )
    return "30x30x35 e 30x50x60";
  if (500 > qtd45mm && qtd45mm > 0 && 2000 >= qtd1pol && qtd1pol > 1200)
    return "30x30x35 e 70x60x50 e 30x30x35";
  if (
    500 > qtd45mm &&
    qtd45mm > 0 &&
    (qtd27mm > 4000 || qtd32mm > 2000 || qtd1pol > 2000 || qtd2pol > 2000)
  )
    return "30x30x35 e Personalizada";
  if (500 > qtd45mm && qtd45mm > 0) return "30x30x35";

  if (total2pol === 1000 || qtd1pol === 3000) return "70x50x60";
  if (
    total2pol === 500 ||
    qtd1pol === 1500 ||
    qtd27mm === 3000 ||
    qtd32mm === 2000
  )
    return "30x60x50";
  if (qtd1pol === 3000 || qtd2pol === 700) return "50x60x50";
  if (qtd27mm > 3000) return `30x30x35 x${formatarDivisao(div27)}`;
  if (qtd2pol > 1000) return `70x50x60 x${formatarDivisao(div2pol)}`;

  return "Personalizada";
};

export const precisaAnaliseIA = (caixaLegado, produtosPersonalizados = []) => {
  const temPersonalizada =
    typeof caixaLegado === "string" && caixaLegado.includes("Personalizada");
  const temProdutosPersonalizados =
    Array.isArray(produtosPersonalizados) && produtosPersonalizados.length > 0;
  return temPersonalizada || temProdutosPersonalizados;
};

export const calcularPedido = (quantidadesBrutas) => {
  const quantidades = normalizarQuantidades(quantidadesBrutas);
  const { nfTotal, pesoTotal } = calcularNfEPeso(quantidades);
  const caixaLegado = determinarCaixaLegado(quantidades);

  return { quantidades, nfTotal, pesoTotal, caixaLegado };
};
