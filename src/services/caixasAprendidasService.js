import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";

// Caixas aprendidas com as postagens dos Correios.
//
// A Calculadora de Pedidos às vezes erra a caixa e a expedição corrige as
// medidas na aba Correios. Cada postagem gravada ensina: "um pedido com este
// conteúdo (quantidade de unidades por categoria) vai nesta(s) caixa(s)".
// No próximo pedido com o mesmo conteúdo, a sugestão passa a ser essa caixa
// (na postagem e no cálculo do frete), no lugar da conta da calculadora.

const CHAVE = "caixasAprendidas";
const MAXIMO_REGISTROS = 3000;
const MAXIMO_VOLUMES = 20;

const normalizar = (texto) =>
  String(texto || "sem categoria")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

// Conteúdo do pedido: { categoria: unidades } → "capsulas:300|encapsulados:1000".
export const assinaturaConteudo = (porCategoria) => {
  const mapa = new Map();
  for (const [categoria, unidades] of Object.entries(porCategoria || {})) {
    const n = Math.round(Number(unidades) || 0);
    if (n > 0) mapa.set(normalizar(categoria), (mapa.get(normalizar(categoria)) || 0) + n);
  }
  return [...mapa.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([categoria, unidades]) => `${categoria}:${unidades}`)
    .join("|");
};

const lerTodas = async () => ({ ...((await lerConfiguracao(CHAVE)) || {}) });

// "capsulas:300|encapsulados:1000" → Map { capsulas → 300, encapsulados → 1000 }
const lerAssinatura = (assinatura) =>
  new Map(
    String(assinatura || "")
      .split("|")
      .filter(Boolean)
      .map((parte) => {
        const i = parte.lastIndexOf(":");
        return [parte.slice(0, i), Number(parte.slice(i + 1)) || 0];
      }),
  );

// Pedido parecido: mesmas categorias e quantidades próximas.
//  - cabe com folga: cada categoria até a quantidade já postada naquela
//    caixa, sem ser pequeno demais (no mínimo 70% do total, senão a caixa
//    fica grande e a calculadora acerta melhor);
//  - um pouco mais: até 10% acima em cada categoria (a caixa costuma ter
//    sobra), só se não houver uma que caiba com folga.
const MINIMO_DO_TOTAL = 0.7;
const MAXIMO_ACIMA = 1.1;

const compararConteudo = (atual, aprendido) => {
  if (atual.size !== aprendido.size) return null;
  let maiorRazao = 0;
  let somaAtual = 0;
  let somaAprendida = 0;
  for (const [categoria, unidades] of atual) {
    const base = aprendido.get(categoria);
    if (!base) return null;
    maiorRazao = Math.max(maiorRazao, unidades / base);
    somaAtual += unidades;
    somaAprendida += base;
  }
  const proporcao = somaAtual / somaAprendida;
  if (maiorRazao > MAXIMO_ACIMA || proporcao < MINIMO_DO_TOTAL) return null;
  // Menor nota = melhor: primeiro as que cabem, depois a mais próxima.
  return { cabe: maiorRazao <= 1, distancia: Math.abs(1 - proporcao) };
};

export const buscarCaixaAprendida = async (assinatura) => {
  if (!assinatura) return null;
  const todas = await lerTodas();
  const exata = todas[assinatura];
  if (exata?.volumes?.length) return { assinatura, ...exata, parecida: false };

  const atual = lerAssinatura(assinatura);
  let melhor = null;
  for (const [chave, registro] of Object.entries(todas)) {
    if (!registro?.volumes?.length) continue;
    const nota = compararConteudo(atual, lerAssinatura(chave));
    if (!nota) continue;
    const melhorQue =
      !melhor ||
      (nota.cabe && !melhor.nota.cabe) ||
      (nota.cabe === melhor.nota.cabe &&
        (nota.distancia < melhor.nota.distancia ||
          (nota.distancia === melhor.nota.distancia && (registro.vezes || 1) > (melhor.registro.vezes || 1))));
    if (melhorQue) melhor = { chave, registro, nota };
  }
  return melhor ? { assinatura: melhor.chave, ...melhor.registro, parecida: true } : null;
};

const medida = (valor) => {
  const n = Math.round(Number(valor));
  return Number.isFinite(n) && n > 0 && n <= 300 ? n : null;
};
const mesmaCaixa = (a, b) => a.altura === b.altura && a.largura === b.largura && a.comprimento === b.comprimento;

// Chamado ao gravar uma postagem. Várias postagens do mesmo pedido = vários
// volumes; um pedido novo com o mesmo conteúdo substitui o que havia.
export const aprenderCaixa = async ({ assinatura, descricao, pedidoId, pedidoNumero, carga, usuarioNome }) => {
  const caixa = { altura: medida(carga?.altura), largura: medida(carga?.largura), comprimento: medida(carga?.comprimento) };
  if (!assinatura || !caixa.altura || !caixa.largura || !caixa.comprimento) return null;
  const pesoKg = Number(carga?.pesoGramas) > 0 ? Math.round(Number(carga.pesoGramas)) / 1000 : null;
  const volume = { ...caixa, pesoKg };

  const todas = await lerTodas();
  const anterior = todas[assinatura];
  let volumes;
  let vezes;
  if (anterior && anterior.pedidoId === pedidoId) {
    volumes = [...(anterior.volumes || []), volume].slice(0, MAXIMO_VOLUMES);
    vezes = anterior.vezes || 1;
  } else {
    volumes = [volume];
    // Mesma caixa única de antes: mais uma confirmação.
    const repetiu = anterior?.volumes?.length === 1 && mesmaCaixa(anterior.volumes[0], caixa);
    vezes = repetiu ? (anterior.vezes || 1) + 1 : 1;
  }
  todas[assinatura] = {
    descricao: String(descricao || "").slice(0, 300),
    volumes,
    vezes,
    pedidoId,
    pedidoNumero: pedidoNumero ?? null,
    por: usuarioNome || null,
    atualizadoEm: new Date().toISOString(),
  };

  const chaves = Object.keys(todas);
  if (chaves.length > MAXIMO_REGISTROS) {
    chaves
      .sort((a, b) => String(todas[a].atualizadoEm).localeCompare(String(todas[b].atualizadoEm)))
      .slice(0, chaves.length - MAXIMO_REGISTROS)
      .forEach((c) => delete todas[c]);
  }
  await salvarConfiguracao(CHAVE, todas);
  return todas[assinatura];
};

export const esquecerCaixa = async (assinatura) => {
  const todas = await lerTodas();
  if (!todas[assinatura]) return false;
  delete todas[assinatura];
  await salvarConfiguracao(CHAVE, todas);
  return true;
};

// Volumes aprendidos agrupados por tamanho, no formato de volumesSugeridos.
export const volumesDaCaixaAprendida = (registro) => {
  const grupos = new Map();
  for (const v of registro?.volumes || []) {
    const chave = `${v.altura}x${v.largura}x${v.comprimento}`;
    const g = grupos.get(chave) || { volumes: 0, altura: v.altura, largura: v.largura, comprimento: v.comprimento, pesoKg: 0 };
    g.volumes += 1;
    g.pesoKg = Math.max(g.pesoKg, Number(v.pesoKg) || 0);
    grupos.set(chave, g);
  }
  return [...grupos.values()];
};
