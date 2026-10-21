import { Produto } from "../models/index.js";
import { lerConfiguracao } from "../models/Configuracao.js";
import { calcularPedido } from "./pedidoCalculoEngine.js";
import { cotarServicosVipp } from "./vippService.js";
import { arredondar, somenteDigitos } from "../utils/helpers.js";
import { ENDERECO_LOJA_PADRAO } from "../utils/formasPagamento.js";

// Tipo de embalagem do produto → campo da calculadora de caixas (mesma usada
// na aba Comercial → Calculadora de Pedidos).
export const CAMPO_CALCULADORA_POR_EMBALAGEM = {
  enc_1inch: "qtd1pol",
  enc_2inch: "qtd2pol",
  ball_27mm: "qtd27mm",
  ball_32mm: "qtd32mm",
  ball_45mm: "qtd45mm",
  cap_empty_1inch: "caps1pol",
  cap_empty_2inch: "caps2pol",
};

const CAIXA_PADRAO = { altura: 30, largura: 30, comprimento: 35 };

// Estimativa usada quando o VIPP não está configurado. Pode ser ajustada em
// Configurações (chave "freteEstimado").
const ESTIMATIVA_PADRAO = {
  PAC: { base: 28, porKg: 4.2, prazoBase: 5 },
  SEDEX: { base: 39, porKg: 7.5, prazoBase: 1 },
};
const UF_ORIGEM = "SP";
const PRAZO_EXTRA_REGIAO = {
  SP: 0, RJ: 1, MG: 1, PR: 1, SC: 2, RS: 2, ES: 2, GO: 2, DF: 2, MS: 2, MT: 3,
  BA: 3, SE: 3, AL: 3, PE: 3, PB: 3, RN: 3, CE: 3, PI: 4, MA: 4, TO: 3,
  PA: 5, AP: 6, AM: 6, RR: 6, AC: 6, RO: 5,
};

// Peso, caixa sugerida e quantidades por tipo de embalagem de uma lista de
// itens { produtoId, quantidade (pacotes) }.
export const resumirCarga = async (itens) => {
  const ids = itens.map((item) => item.produtoId).filter(Boolean);
  const produtos = await Produto.findAll({ where: { id: ids } });
  const porId = new Map(produtos.map((p) => [p.id, p]));

  let pesoGramas = 0;
  let freteIndisponivel = false;
  const quantidades = {};
  for (const item of itens) {
    const produto = porId.get(item.produtoId);
    if (!produto) continue;
    const pacotes = Number(item.quantidade) || 0;
    pesoGramas += pacotes * Number(produto.pesoPacoteGramas || 0);
    if (produto.tipoEmbalagem === "frete_indisponivel") freteIndisponivel = true;
    const campo = CAMPO_CALCULADORA_POR_EMBALAGEM[produto.tipoEmbalagem];
    if (campo) {
      quantidades[campo] = (quantidades[campo] || 0) + pacotes * Number(produto.unidadesPacote || 1);
    }
  }

  let caixa = CAIXA_PADRAO;
  if (Object.keys(quantidades).length) {
    const { caixaLegado } = calcularPedido(quantidades);
    const medidas = String(caixaLegado || "").match(/(\d+)\s*x\s*(\d+)\s*x\s*(\d+)/i);
    if (medidas) {
      caixa = {
        altura: Number(medidas[1]),
        largura: Number(medidas[2]),
        comprimento: Number(medidas[3]),
      };
    }
  }

  return { pesoGramas, freteIndisponivel, quantidades, caixa };
};

const estimar = async (servico, pesoGramas, uf) => {
  const tabela = (await lerConfiguracao("freteEstimado")) || ESTIMATIVA_PADRAO;
  const regra = tabela[servico] || ESTIMATIVA_PADRAO[servico];
  const kg = Math.max(0.3, pesoGramas / 1000);
  const fatorDistancia = uf === UF_ORIGEM ? 1 : 1.35;
  return {
    valor: arredondar((regra.base + regra.porKg * kg) * fatorDistancia),
    prazoDias: regra.prazoBase + (PRAZO_EXTRA_REGIAO[uf] ?? 3),
    estimado: true,
  };
};

const vippConfigurado = () => Boolean(process.env.VIPP_USUARIO && process.env.VIPP_SENHA);

// Opções de entrega do checkout. PAC/SEDEX só com CEP válido.
export const cotarFrete = async ({ cep, uf, itens }) => {
  const carga = await resumirCarga(itens || []);
  const opcoes = [
    { metodo: "RETIRAR_LOCAL", nome: "Retirar no local", descricao: `Retire em nossa loja: ${(await lerConfiguracao("enderecoLoja")) || ENDERECO_LOJA_PADRAO}`, valor: 0, prazoDias: 0, disponivel: true },
    { metodo: "TRANSPORTADORA", nome: "Transportadora", descricao: "O time de vendas entrará em contato", valor: 0, prazoDias: null, disponivel: true },
  ];

  const cepLimpo = somenteDigitos(cep);
  const correios = [
    { metodo: "PAC", nome: "PAC - Correios", descricao: "Entrega econômica" },
    { metodo: "SEDEX", nome: "SEDEX - Correios", descricao: "Entrega expressa" },
  ];

  if (cepLimpo.length !== 8) {
    opcoes.push(...correios.map((c) => ({ ...c, disponivel: false, motivo: "Informe o CEP" })));
    return { opcoes, pesoGramas: carga.pesoGramas };
  }
  if (carga.freteIndisponivel) {
    opcoes.push(...correios.map((c) => ({ ...c, disponivel: false, motivo: "Frete indisponível para estes produtos — fale com o time de vendas" })));
    return { opcoes, pesoGramas: carga.pesoGramas };
  }
  if (carga.pesoGramas > 30000) {
    opcoes.push(...correios.map((c) => ({ ...c, disponivel: false, motivo: "Acima de 30 kg — use transportadora" })));
    return { opcoes, pesoGramas: carga.pesoGramas };
  }

  let cotacaoVipp = null;
  if (vippConfigurado()) {
    try {
      cotacaoVipp = await cotarServicosVipp({
        cep: cepLimpo,
        pesoGramas: Math.max(1, carga.pesoGramas),
        ...carga.caixa,
      });
    } catch (error) {
      console.warn("[Frete] VIPP indisponível, usando estimativa:", error.message);
    }
  }

  for (const servico of correios) {
    const doVipp = cotacaoVipp?.servicos?.find(
      (s) => s.disponivel && s.nome.toUpperCase().includes(servico.metodo),
    );
    const cotacao = doVipp
      ? { valor: arredondar(doVipp.valor), prazoDias: doVipp.prazoDias, estimado: false }
      : await estimar(servico.metodo, carga.pesoGramas, String(uf || "").toUpperCase());
    opcoes.push({ ...servico, ...cotacao, disponivel: true });
  }

  return { opcoes, pesoGramas: carga.pesoGramas, caixa: carga.caixa };
};
