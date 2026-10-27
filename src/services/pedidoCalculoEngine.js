import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";

// Calculadora de Pedidos (Comercial): valor de nota, peso e caixas.
//
// Caixas: a base é a caixa de referência 70x50x60, que comporta 3000
// encapsulados de 1" ou 1000 de 2". Cada item tem "unidades por caixa de
// referência"; daí sai o volume que cada unidade ocupa (já com o espaço vazio
// entre elas), e qualquer outra caixa comporta proporcionalmente ao volume.
// Peças sem padrão (pedestais, pelúcias...) usam as medidas A x L x C
// informadas por unidade.

export const CHAVE_PARAMETROS = "calculadoraPedidos";

// granel = tem capacidade na caixa de referência; senão precisa de medidas.
// fonte: "informado" (base passada pela loja) ou "estimado" (ajustável).
export const ITENS_PADRAO = [
  { chave: "qtd1pol", label: 'Encapsulado 1"', grupo: "Encapsulados", granel: true, porCaixaRef: 3000, valorNf: 0.05, pesoKg: 0.01, fonte: "informado" },
  { chave: "qtd2pol", label: 'Encapsulado 2"', grupo: "Encapsulados", granel: true, porCaixaRef: 1000, valorNf: 0.14, pesoKg: 0.01, fonte: "informado" },
  { chave: "qtd27mm", label: "Bolinha 27mm", grupo: "Bolinhas pula-pula", granel: true, porCaixaRef: 7000, valorNf: 0.08, pesoKg: 0.01, fonte: "estimado" },
  { chave: "qtd32mm", label: "Bolinha 32mm", grupo: "Bolinhas pula-pula", granel: true, porCaixaRef: 4600, valorNf: 0.16, pesoKg: 0.025, fonte: "estimado" },
  { chave: "qtd45mm", label: "Bolinha 45mm", grupo: "Bolinhas pula-pula", granel: true, porCaixaRef: 1600, valorNf: 0.44, pesoKg: 0.05, fonte: "estimado" },
  { chave: "caps1pol", label: 'Cápsula vazia 1"', grupo: "Cápsulas vazias", granel: true, porCaixaRef: 3000, valorNf: 0.04, pesoKg: 0.003, fonte: "estimado" },
  { chave: "caps2pol", label: 'Cápsula vazia 2"', grupo: "Cápsulas vazias", granel: true, porCaixaRef: 1000, valorNf: 0.1, pesoKg: 0.006, fonte: "estimado" },
  { chave: "squareGlobinho", label: "Square / Globinho", grupo: "Peças e máquinas", granel: false, valorNf: 57, pesoKg: 6 },
  { chave: "gvTodas", label: "GV (todas)", grupo: "Peças e máquinas", granel: false, valorNf: 195, pesoKg: 10 },
  { chave: "pedestalX", label: "Pedestal X", grupo: "Peças e máquinas", granel: false, valorNf: 19, pesoKg: 6 },
  { chave: "pedestalRedondo", label: "Pedestal redondo", grupo: "Peças e máquinas", granel: false, valorNf: 19, pesoKg: 10 },
  { chave: "hack", label: "Hack", grupo: "Peças e máquinas", granel: false, valorNf: 45, pesoKg: 10 },
  { chave: "cuba", label: "Cuba", grupo: "Peças e máquinas", granel: false, valorNf: 26, pesoKg: 0.5 },
  { chave: "chiclete", label: "Chiclete", grupo: "Peças e máquinas", granel: false, valorNf: 97.5, pesoKg: 6 },
  { chave: "pelucia", label: "Pelúcia", grupo: "Pelúcias", granel: false, valorNf: 2.33, pesoKg: 0.0035 },
];

// Medidas internas em cm (Altura x Largura x Comprimento).
export const CAIXAS_PADRAO = [
  { altura: 30, largura: 30, comprimento: 35 },
  { altura: 30, largura: 30, comprimento: 40 },
  { altura: 40, largura: 40, comprimento: 40 },
  { altura: 30, largura: 60, comprimento: 50 },
  { altura: 50, largura: 60, comprimento: 50 },
  { altura: 70, largura: 50, comprimento: 60 },
];
export const CAIXA_REFERENCIA = "70x50x60";

// Correios (PAC/SEDEX): limites por volume e divisor do peso cubado.
export const LIMITE_PESO_CORREIOS_KG = 30;
const LIMITE_SOMA_LADOS_CORREIOS_CM = 200;
const LIMITE_LADO_CORREIOS_CM = 100;
const DIVISOR_CUBAGEM = 6000;

const positivo = (valor) => {
  const n = Number(String(valor ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const arred = (n, casas = 2) => Math.round(n * 10 ** casas) / 10 ** casas;
const litrosDe = (c) => (c.altura * c.largura * c.comprimento) / 1000;
const nomeCaixa = (c) => `${c.altura}x${c.largura}x${c.comprimento}`;
const ladosOrdenados = (d) => [d.altura, d.largura, d.comprimento].map(Number).sort((a, b) => a - b);
// A peça cabe na caixa em alguma posição (compara os lados ordenados).
const cabePeca = (peca, caixa) => {
  const c = ladosOrdenados(caixa);
  return ladosOrdenados(peca).every((lado, i) => lado <= c[i]);
};

// ---------------------------------------------------------------------------
// Parâmetros (editáveis pelo Comercial)
// ---------------------------------------------------------------------------

const normalizarParametros = (salvos = {}) => {
  const porChave = Object.fromEntries((salvos.itens || []).map((i) => [i.chave, i]));
  const itens = ITENS_PADRAO.map((padrao) => {
    const s = porChave[padrao.chave] || {};
    const item = { ...padrao, padrao: { valorNf: padrao.valorNf, pesoKg: padrao.pesoKg, porCaixaRef: padrao.porCaixaRef ?? null } };
    if (s.valorNf != null && Number.isFinite(Number(s.valorNf)) && Number(s.valorNf) >= 0) item.valorNf = Number(s.valorNf);
    if (positivo(s.pesoKg)) item.pesoKg = positivo(s.pesoKg);
    if (padrao.granel && positivo(s.porCaixaRef)) {
      item.porCaixaRef = Math.round(positivo(s.porCaixaRef));
      if (item.porCaixaRef !== padrao.porCaixaRef) item.fonte = "ajustado";
    }
    return item;
  });
  const caixas = (Array.isArray(salvos.caixas) && salvos.caixas.length ? salvos.caixas : CAIXAS_PADRAO)
    .map((c) => ({ altura: positivo(c.altura), largura: positivo(c.largura), comprimento: positivo(c.comprimento) }))
    .filter((c) => c.altura && c.largura && c.comprimento);
  if (!caixas.some((c) => nomeCaixa(c) === CAIXA_REFERENCIA)) caixas.push({ altura: 70, largura: 50, comprimento: 60 });
  const unicas = [...new Map(caixas.map((c) => [nomeCaixa(c), { ...c, nome: nomeCaixa(c), litros: litrosDe(c) }])).values()]
    .sort((a, b) => a.litros - b.litros);
  return { itens, caixas: unicas, referencia: CAIXA_REFERENCIA, atualizadoEm: salvos.atualizadoEm || null, atualizadoPor: salvos.atualizadoPor || null };
};

export const lerParametros = async () => normalizarParametros((await lerConfiguracao(CHAVE_PARAMETROS)) || {});

export const salvarParametros = async (entrada, usuarioNome) => {
  const atual = (await lerConfiguracao(CHAVE_PARAMETROS)) || {};
  const itens = Array.isArray(entrada?.itens)
    ? entrada.itens
        .filter((i) => ITENS_PADRAO.some((p) => p.chave === i?.chave))
        .map((i) => ({ chave: i.chave, valorNf: Math.max(0, Number(String(i.valorNf ?? "").replace(",", ".")) || 0), pesoKg: positivo(i.pesoKg), porCaixaRef: positivo(i.porCaixaRef) }))
    : atual.itens;
  const caixas = Array.isArray(entrada?.caixas)
    ? entrada.caixas
        .map((c) => ({ altura: positivo(c.altura), largura: positivo(c.largura), comprimento: positivo(c.comprimento) }))
        .filter((c) => c.altura && c.largura && c.comprimento && c.altura <= 300 && c.largura <= 300 && c.comprimento <= 300)
        .slice(0, 20)
    : atual.caixas;
  await salvarConfiguracao(CHAVE_PARAMETROS, { itens, caixas, atualizadoEm: new Date().toISOString(), atualizadoPor: usuarioNome || null });
  return lerParametros();
};

// ---------------------------------------------------------------------------
// Cálculo
// ---------------------------------------------------------------------------

// Linhas do pedido: itens do catálogo + produtos avulsos (com medidas).
const montarLinhas = (params, quantidades = {}, medidas = {}, avulsos = []) => {
  const ref = params.caixas.find((c) => c.nome === params.referencia);
  const linhas = [];
  const faltandoMedidas = [];
  for (const item of params.itens) {
    const qtd = Math.round(positivo(quantidades?.[item.chave]));
    if (!qtd) continue;
    const linha = { chave: item.chave, label: item.label, quantidade: qtd, valorNfUn: item.valorNf, pesoUn: item.pesoKg, granel: item.granel };
    if (item.granel) {
      linha.litrosUn = ref.litros / item.porCaixaRef;
    } else {
      const m = medidas?.[item.chave] || {};
      linha.medidas = { altura: positivo(m.altura), largura: positivo(m.largura), comprimento: positivo(m.comprimento) };
      if (!linha.medidas.altura || !linha.medidas.largura || !linha.medidas.comprimento) faltandoMedidas.push(item.label);
      linha.litrosUn = litrosDe(linha.medidas);
    }
    linhas.push(linha);
  }
  for (const [i, a] of (Array.isArray(avulsos) ? avulsos : []).slice(0, 50).entries()) {
    const nome = String(a?.nome || "").trim().slice(0, 80);
    const qtd = Math.round(positivo(a?.quantidade));
    if (!nome || !qtd) continue;
    const dims = { altura: positivo(a.altura), largura: positivo(a.largura), comprimento: positivo(a.comprimento) };
    if (!dims.altura || !dims.largura || !dims.comprimento) faltandoMedidas.push(nome);
    linhas.push({
      chave: `avulso_${i}`,
      label: nome,
      quantidade: qtd,
      valorNfUn: Math.max(0, Number(String(a.valorNf ?? "").replace(",", ".")) || 0),
      pesoUn: positivo(a.pesoUnitario),
      granel: false,
      medidas: dims,
      litrosUn: litrosDe(dims),
      avulso: true,
    });
  }
  return { linhas, faltandoMedidas };
};

const resumoVolume = (caixa, itens, sobMedida = false) => {
  const litrosUsados = itens.reduce((s, i) => s + i.quantidade * i.litrosUn, 0);
  const pesoKg = itens.reduce((s, i) => s + i.quantidade * i.pesoUn, 0);
  const pesoCubadoKg = (caixa.altura * caixa.largura * caixa.comprimento) / DIVISOR_CUBAGEM;
  const alertas = [];
  if (pesoKg > LIMITE_PESO_CORREIOS_KG) alertas.push(`Mais de ${LIMITE_PESO_CORREIOS_KG} kg: não vai por PAC/SEDEX.`);
  if (caixa.altura + caixa.largura + caixa.comprimento > LIMITE_SOMA_LADOS_CORREIOS_CM || Math.max(caixa.altura, caixa.largura, caixa.comprimento) > LIMITE_LADO_CORREIOS_CM) {
    alertas.push("Fora das medidas dos Correios (soma dos lados até 200 cm e lado até 100 cm).");
  }
  return {
    caixa: nomeCaixa(caixa),
    medidas: { altura: caixa.altura, largura: caixa.largura, comprimento: caixa.comprimento },
    sobMedida,
    itens: itens.map((i) => ({ label: i.label, quantidade: i.quantidade })),
    ocupacao: Math.min(100, Math.round((litrosUsados / litrosDe(caixa)) * 100)),
    pesoKg: arred(pesoKg),
    pesoCubadoKg: arred(pesoCubadoKg),
    pesoTaxadoKg: arred(Math.max(pesoKg, pesoCubadoKg)),
    alertas,
  };
};

// Distribuição: enche a maior caixa até a boca enquanto sobrar mais do que
// cabe numa caixa; o restante vai para a MENOR caixa que comporta tudo.
export const planejarCaixas = (linhas, caixas) => {
  const volumes = [];
  const restante = linhas.map((l) => ({ ...l }));

  // Peça que não cabe nem na maior caixa: volume sob medida por unidade.
  for (const l of restante.filter((x) => x.medidas)) {
    if (caixas.some((c) => cabePeca(l.medidas, c))) continue;
    const caixa = { altura: l.medidas.altura + 4, largura: l.medidas.largura + 4, comprimento: l.medidas.comprimento + 4 };
    for (let n = 0; n < l.quantidade; n += 1) volumes.push(resumoVolume(caixa, [{ ...l, quantidade: 1 }], true));
    l.quantidade = 0;
  }

  const pendentes = () => restante.filter((l) => l.quantidade > 0);
  const servem = (lista) => caixas.filter((c) => lista.every((l) => !l.medidas || cabePeca(l.medidas, c)));
  for (let rodada = 0; pendentes().length && rodada < 1000; rodada += 1) {
    const lista = pendentes();
    const total = lista.reduce((s, l) => s + l.quantidade * l.litrosUn, 0);
    const opcoes = servem(lista);
    const final = opcoes.find((c) => c.litros + 1e-9 >= total);
    if (final) {
      volumes.push(resumoVolume(final, lista));
      break;
    }
    // Enche a maior caixa onde as peças restantes cabem: peças primeiro,
    // o granel completa o espaço.
    const caixa = opcoes[opcoes.length - 1] || caixas[caixas.length - 1];
    let livre = caixa.litros;
    const dentro = [];
    const ordem = [...lista].sort((a, b) => Number(Boolean(b.medidas)) - Number(Boolean(a.medidas)) || b.litrosUn - a.litrosUn);
    for (const l of ordem) {
      if (l.medidas && !cabePeca(l.medidas, caixa)) continue;
      const n = Math.min(l.quantidade, Math.floor((livre + 1e-9) / l.litrosUn));
      if (n <= 0) continue;
      dentro.push({ ...l, quantidade: n });
      l.quantidade -= n;
      livre -= n * l.litrosUn;
    }
    if (!dentro.length) {
      const l = ordem[0];
      dentro.push({ ...l, quantidade: 1 });
      l.quantidade -= 1;
    }
    volumes.push(resumoVolume(caixa, dentro));
  }
  return volumes;
};

// "Só com esta caixa": quantos volumes de cada tamanho seriam necessários.
const porTamanho = (linhas, caixas) => {
  const total = linhas.reduce((s, l) => s + l.quantidade * l.litrosUn, 0);
  const pecas = linhas.filter((l) => l.medidas);
  return caixas.map((c) => {
    const servePecas = pecas.every((p) => cabePeca(p.medidas, c));
    const volumes = servePecas ? Math.max(1, Math.ceil(total / c.litros - 1e-9)) : null;
    return {
      caixa: c.nome,
      litros: arred(c.litros, 1),
      volumes,
      ocupacaoMedia: volumes ? Math.round((total / (volumes * c.litros)) * 100) : null,
      motivo: servePecas ? null : "Alguma peça não cabe",
    };
  });
};

export const calcularPedidoCompleto = async ({ quantidades, medidas, avulsos }) => {
  const params = await lerParametros();
  const { linhas, faltandoMedidas } = montarLinhas(params, quantidades, medidas, avulsos);
  const itens = linhas.map((l) => ({
    chave: l.chave,
    label: l.label,
    quantidade: l.quantidade,
    valorNfUn: l.valorNfUn,
    valorNf: arred(l.quantidade * l.valorNfUn),
    pesoUn: l.pesoUn,
    pesoKg: arred(l.quantidade * l.pesoUn, 3),
    litros: arred(l.quantidade * l.litrosUn, 1),
    avulso: Boolean(l.avulso),
  }));
  const resumo = {
    valorNf: arred(itens.reduce((s, i) => s + i.valorNf, 0)),
    pesoKg: arred(itens.reduce((s, i) => s + i.pesoKg, 0)),
    litros: arred(linhas.reduce((s, l) => s + l.quantidade * l.litrosUn, 0), 1),
    unidades: itens.reduce((s, i) => s + i.quantidade, 0),
  };
  if (faltandoMedidas.length || !linhas.length) {
    return { itens, resumo, faltandoMedidas, volumes: [], porTamanho: [], referencia: params.referencia };
  }
  const volumes = planejarCaixas(linhas, params.caixas);
  return {
    itens,
    resumo: { ...resumo, volumes: volumes.length, pesoTaxadoKg: arred(volumes.reduce((s, v) => s + v.pesoTaxadoKg, 0)) },
    faltandoMedidas: [],
    volumes,
    porTamanho: porTamanho(linhas, params.caixas),
    referencia: params.referencia,
  };
};

// Frete do checkout: medidas do primeiro volume (só itens a granel).
export const caixaParaFrete = async (quantidades) => {
  const params = await lerParametros();
  const { linhas } = montarLinhas(params, quantidades, {}, []);
  const granel = linhas.filter((l) => l.granel);
  if (!granel.length) return null;
  const [primeiro] = planejarCaixas(granel, params.caixas);
  return primeiro?.medidas || null;
};
