// Emissão automática de NF-e pela NFeMail a partir de um pedido do site.
// A nota é montada no layout TXT da NFeMail (dev.nfemail.com.br/LayoutTxtNFeMail.htm)
// e enviada por POST api/NotasFiscais; pela API a NFeMail grava, assina e
// transmite sozinha. Depois buscamos o status e baixamos a DANFE.
//
// Regras da Gira Kids (definidas pelo comercial):
// - CFOP: destino SP = 5102; fora de SP: CNPJ = 6102, CPF = 6108.
// - ICMS: CNPJ contribuinte (com IE no cadastro da NFeMail) = CSOSN 101 com
//   crédito (alíquota padrão 2,73%); não contribuinte (CPF ou CNPJ sem IE) = 102.
// - PIS/COFINS: CST 99 zerado (igual às notas emitidas hoje).
// - Frete: Braspress = CIF; as demais = FOB.
// - Pagamento: cartão de crédito = 03 (a prazo); PIX/à vista = 20; boleto = 15
//   (a prazo); a receber/a definir/outros = 21 crédito em loja (a prazo).
// - Pedidos em aberto do mesmo cliente sem nota podem sair juntos numa nota só
//   (opcoes.juntar = ids); o pedido aberto na tela é o principal (xPed, transporte).
// - Valor dos produtos: o valor comercial cadastrado no produto da NFeMail
//   (val_comercial) × quantidade. O valor real do site só com opcoes.usarValorReal.

import { Op } from "sequelize";
import { Arquivo, Parceiro, Pedido, Produto } from "../models/index.js";
import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";
import { INCLUDE_COMPLETO } from "./pedidoService.js";
import { CAMPO_CALCULADORA_POR_EMBALAGEM } from "./freteService.js";
import { calcularPedidoCompleto } from "./pedidoCalculoEngine.js";
import {
  baixarDanfeNFeMail,
  buscarClienteNFeMail,
  buscarNotaPorPedido,
  buscarNotasPorDocumento,
  emitenteDaUltimaNota,
  enviarTxtNFeMail,
  listarProdutosNFeMail,
} from "./nfemailService.js";
import { arredondar, erroHttp } from "../utils/helpers.js";

export const ALIQUOTA_CREDITO_PADRAO = 2.73;
export const CHAVE_VINCULO_CATEGORIAS = "nfeVinculoCategorias";

// Tabela de vínculo → produto da NFeMail (cod_produto). Chaves: "produto:<id>",
// "<categoria>|<tipoEmbalagem>" ou "<categoria>".
export const lerVinculosCategorias = async () => (await lerConfiguracao(CHAVE_VINCULO_CATEGORIAS)) || {};
export const salvarVinculosCategorias = async (vinculos) => {
  const limpos = Object.fromEntries(Object.entries(vinculos || {}).filter(([c, v]) => c.trim() && v).map(([c, v]) => [c.trim(), String(v)]));
  await salvarConfiguracao(CHAVE_VINCULO_CATEGORIAS, limpos);
  return limpos;
};

const CORREIOS = { nome: "EMPRESA BRASILEIRA DE CORREIOS E TELEGRAFOS", cnpj: "34028316000103", endereco: "ST SBN QUADRA 1 BLOCO A, S/N, ASA NORTE", cidade: "BRASILIA", uf: "DF" };

const FORMAS_CARTAO = new Set(["CREDITO_ONLINE", "CREDITO_LINK", "LINK_PAGAMENTO", "MAQUININHA"]);
const FORMAS_A_VISTA = new Set(["PIX_ONLINE", "PIX_PRESENCIAL", "DEBITO_ONLINE", "DINHEIRO", "TRANSFERENCIA"]);

export const PAGAMENTOS_NF = {
  "03": { nome: "Cartão de crédito", indPag: "1" },
  20: { nome: "PIX", indPag: "0" },
  15: { nome: "Boleto bancário", indPag: "1" },
  21: { nome: "Crédito em loja", indPag: "1" },
};

const pagamentoPadrao = (forma) => {
  if (FORMAS_CARTAO.has(forma)) return "03";
  if (FORMAS_A_VISTA.has(forma)) return "20";
  if (forma === "BOLETO") return "15";
  return "21";
};

const digitos = (v) => String(v ?? "").replace(/\D/g, "");
// Campo do TXT: sem pipe nem quebra de linha.
const campo = (v) => String(v ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const linha = (...campos) => `${campos.map(campo).join("|")}|`;
const dec = (v, casas = 2) => Number(v || 0).toFixed(casas);

const codigoIbge = async (cep) => {
  try {
    const dados = await (await fetch(`https://viacep.com.br/ws/${digitos(cep)}/json/`)).json();
    return dados.erro ? null : { ibge: dados.ibge, cidade: dados.localidade, uf: dados.uf };
  } catch {
    return null;
  }
};

// Divide um valor entre as linhas proporcionalmente ao vProd, fechando os
// centavos na última (a soma dos itens precisa bater com o total da nota).
const ratear = (valor, linhas) => {
  const total = linhas.reduce((s, l) => s + l.vProd, 0);
  let usado = 0;
  return linhas.map((l, i) => {
    if (i === linhas.length - 1) return arredondar(valor - usado);
    const parte = total ? arredondar((valor * l.vProd) / total) : 0;
    usado += parte;
    return parte;
  });
};

const volumesDoPedido = async (pedido) => {
  const produtos = await Produto.findAll({ where: { id: pedido.itens.map((i) => i.produtoId).filter(Boolean) } });
  const porId = new Map(produtos.map((p) => [p.id, p]));
  const quantidades = {};
  for (const item of pedido.itens) {
    const campoCalc = CAMPO_CALCULADORA_POR_EMBALAGEM[porId.get(item.produtoId)?.tipoEmbalagem];
    if (campoCalc) quantidades[campoCalc] = (quantidades[campoCalc] || 0) + item.quantidade * (item.unidadesPacote || 1);
  }
  let qVol = 1;
  try {
    if (Object.keys(quantidades).length) {
      const calculo = await calcularPedidoCompleto({ quantidades, medidas: {}, avulsos: [] });
      qVol = Math.max(1, calculo.resumo?.volumes || 1);
    }
  } catch {
    // Calculadora sem parâmetros: fica 1 volume.
  }
  const pesoKg = Number(pedido.pesoTotalGramas || 0) / 1000;
  return { qVol, pesoL: pesoKg, pesoB: pesoKg };
};

const transporteDoPedido = async (pedido) => {
  if (pedido.metodoEnvio === "PAC" || pedido.metodoEnvio === "SEDEX") {
    return { modFrete: "1", transportadora: CORREIOS };
  }
  if (pedido.metodoEnvio === "TRANSPORTADORA" && (pedido.transportadoraId || pedido.transportadoraNome)) {
    const parceiro = pedido.transportadoraId ? await Parceiro.findByPk(pedido.transportadoraId) : null;
    const nome = parceiro?.nome || pedido.transportadoraNome;
    return {
      modFrete: /braspress/i.test(nome) ? "0" : "1",
      transportadora: { nome, cnpj: digitos(parceiro?.documento), endereco: "", cidade: parceiro?.cidade || "", uf: parceiro?.estado || "" },
    };
  }
  // Retirada no local: sem transporte.
  return { modFrete: "9", transportadora: null };
};

// Pedido que já saiu numa nota junto com outro (registrado no histórico).
const notaConjunta = (pedido) =>
  [...(pedido.historico || [])].reverse().find((h) => h.tipo === "NFE_EMITIDA" && h.chave) || null;

const semNota = (p) => !String(p.notaFiscalNumero || "").trim() && !notaConjunta(p);

// Outros pedidos do mesmo cliente ainda em aberto (não cancelados, não
// expedidos) e sem nota: candidatos a sair na mesma nota.
export const pedidosAbertosDoCliente = async (pedido) => {
  const documento = digitos(pedido.documento);
  const doCliente = [];
  if (pedido.clienteId) doCliente.push({ clienteId: pedido.clienteId });
  if (documento.length === 11 || documento.length === 14) doCliente.push({ documento });
  if (!doCliente.length) return [];
  const candidatos = await Pedido.findAll({
    where: {
      tipo: "PEDIDO",
      id: { [Op.ne]: pedido.id },
      statusVendas: { [Op.ne]: "CANCELADO" },
      statusExpedicao: { [Op.ne]: "EXPEDIDO" },
      [Op.or]: doCliente,
    },
    order: [["numero", "ASC"]],
    limit: 20,
  });
  return candidatos.filter(semNota);
};

const resumoPedido = (p) => ({
  id: p.id,
  numero: p.numero,
  numeroFormatado: p.numeroFormatado || String(p.numero),
  total: Number(p.total),
  formaPagamento: p.formaPagamento,
  metodoEnvio: p.metodoEnvio,
  statusVendas: p.statusVendas,
  criadoEm: p.createdAt,
  observacoes: p.observacoes || "",
});

// Monta a prévia da nota (o que vai em cada campo) sem enviar nada.
export const prepararNota = async (pedidoId, opcoes = {}) => {
  const pedido = await Pedido.findByPk(pedidoId, { include: INCLUDE_COMPLETO });
  if (!pedido || pedido.tipo !== "PEDIDO") throw erroHttp(404, "Pedido não encontrado.");
  const bloqueios = [];
  const avisos = [];
  if (pedido.statusVendas === "CANCELADO") bloqueios.push("Pedido cancelado.");
  const jaSaiu = notaConjunta(pedido);
  if (jaSaiu?.juntoAoPedido) {
    bloqueios.push(`Este pedido já saiu na nota ${jaSaiu.numero}, junto com o pedido ${jaSaiu.juntoAoPedido}.`);
  }

  // Pedidos do mesmo cliente que entram na mesma nota (escolhidos na tela).
  const abertos = await pedidosAbertosDoCliente(pedido);
  const idsJuntar = [...new Set((opcoes.juntar || []).map(String))].filter((id) => id !== String(pedido.id));
  const juntos = [];
  for (const id of idsJuntar) {
    if (!abertos.some((p) => String(p.id) === id)) {
      bloqueios.push("Um dos pedidos escolhidos para juntar não é deste cliente, já tem nota ou não está mais em aberto.");
      continue;
    }
    juntos.push(await Pedido.findByPk(id, { include: INCLUDE_COMPLETO }));
  }
  const todos = [pedido, ...juntos];
  const itensTodos = todos.flatMap((p) => p.itens || []);
  const somar = (campo) => arredondar(todos.reduce((s, p) => s + Number(p[campo] || 0), 0));

  // Destinatário. "opcoes.cliente" traz o que a pessoa completou na tela
  // quando faltava algo no pedido (vale por cima do pedido e é salvo nele ao emitir).
  const corrigido = opcoes.cliente || {};
  const doPedido = (campo, coluna) => {
    const valor = corrigido[campo];
    return valor != null && String(valor).trim() !== "" ? String(valor).trim() : pedido[coluna];
  };
  const documento = digitos(doPedido("documento", "documento"));
  const ehCnpj = documento.length === 14;
  const faltando = [];
  if (documento.length !== 11 && !ehCnpj) faltando.push("documento");
  const cadastro = documento.length === 11 || ehCnpj ? await buscarClienteNFeMail(documento).catch(() => null) : null;
  const ie = digitos(cadastro?.num_inscricaoest);
  const isento = /isent/i.test(cadastro?.num_inscricaoest || "");
  if (ehCnpj && !cadastro) {
    bloqueios.push("Cliente CNPJ sem cadastro na NFeMail: cadastre o cliente lá (com a Inscrição Estadual, se tiver) e tente de novo.");
  }
  const contribuinte = ehCnpj && Boolean(ie);
  const indIEDest = contribuinte ? "1" : isento ? "2" : "9";
  const cepInformado = digitos(doPedido("cep", "cep") || cadastro?.end_cep);
  const local = cepInformado.length === 8 ? await codigoIbge(cepInformado) : null;
  const uf = String(doPedido("uf", "estado") || local?.uf || cadastro?.end_uf || "").toUpperCase().slice(0, 2);
  const cMun = (corrigido.cep ? null : cadastro?.end_ibge) || local?.ibge;
  const destino = {
    nome: cadastro?.raz_social || doPedido("nome", "clienteNome"),
    documento,
    ehCnpj,
    ie: contribuinte ? ie : "",
    indIEDest,
    contribuinte,
    cadastradoNFeMail: Boolean(cadastro),
    email: pedido.clienteEmail || "",
    logradouro: doPedido("logradouro", "rua") || cadastro?.end_logradouro,
    numero: doPedido("numero", "numeroEndereco") || cadastro?.end_numero || "",
    complemento: doPedido("complemento", "complemento") || "",
    bairro: doPedido("bairro", "bairro") || cadastro?.end_bairro,
    cMun,
    cidade: local?.cidade || doPedido("cidade", "cidade") || cadastro?.end_municipio,
    uf,
    cep: cepInformado,
    fone: digitos(pedido.clienteTelefone).replace(/^55(?=\d{10,11}$)/, ""),
  };
  if (!destino.nome) faltando.push("nome");
  if (destino.cep.length !== 8 || !cMun) faltando.push("cep");
  for (const campo of ["logradouro", "numero", "bairro", "cidade", "uf"]) if (!destino[campo]) faltando.push(campo);
  const ROTULOS = { documento: "CPF/CNPJ", nome: "nome", cep: "CEP válido", logradouro: "rua", numero: "número", bairro: "bairro", cidade: "cidade", uf: "UF" };
  if (faltando.length) bloqueios.push(`Complete os dados do cliente: ${faltando.map((c) => ROTULOS[c]).join(", ")}.`);

  const dentroSP = uf === "SP";
  const cfop = dentroSP ? "5102" : ehCnpj ? "6102" : "6108";
  const aliquota = Number(opcoes.aliquota) > 0 ? Number(opcoes.aliquota) : ALIQUOTA_CREDITO_PADRAO;
  const csosn = contribuinte ? "101" : "102";

  // Itens: cada produto do site aponta para um produto da NFeMail; produtos
  // iguais na NFeMail somam numa linha (como as notas emitidas à mão).
  let produtosNFe = await listarProdutosNFeMail();
  // Produto com nome inválido no cache: busca de novo (pode ter sido corrigido agora).
  if (produtosNFe.some((p) => !/[a-zA-Z]/.test(String(p.dsc_produto || "")))) {
    produtosNFe = await listarProdutosNFeMail({ atualizar: true });
  }
  const nfePorCodigo = new Map(produtosNFe.map((p) => [String(p.cod_produto), p]));
  const vinculos = { ...(opcoes.vinculos || {}) };
  const produtosSite = await Produto.findAll({ where: { id: itensTodos.map((i) => i.produtoId).filter(Boolean) } });
  // Vínculo do próprio produto; senão o da tabela: produto específico,
  // categoria + embalagem (ex.: cápsulas de 1" e 2") e por fim a categoria.
  const tabela = (await lerConfiguracao(CHAVE_VINCULO_CATEGORIAS)) || {};
  for (const p of produtosSite) {
    const categoria = String(p.categoria || "").trim();
    if (!vinculos[p.id]) {
      vinculos[p.id] = p.nfeProdutoCodigo || tabela[`produto:${p.id}`] || tabela[`${categoria}|${p.tipoEmbalagem || ""}`] || tabela[categoria] || "";
    }
  }

  const semVinculo = [];
  const grupos = new Map();
  for (const item of itensTodos) {
    const codigo = vinculos[item.produtoId];
    const nfe = codigo && nfePorCodigo.get(String(codigo));
    if (!nfe) {
      if (!semVinculo.some((s) => s.produtoId === item.produtoId)) semVinculo.push({ produtoId: item.produtoId, nome: item.nome });
      continue;
    }
    const unidades = item.quantidade * (item.unidadesPacote || 1);
    const grupo = grupos.get(nfe.cod_produto) || { nfe, qCom: 0, vProd: 0, produtosSite: [] };
    grupo.qCom += unidades;
    grupo.vProd = arredondar(grupo.vProd + Number(item.total));
    grupo.produtosSite.push(item.nome);
    grupos.set(nfe.cod_produto, grupo);
  }
  if (semVinculo.length) bloqueios.push("Escolha o produto da NFeMail para cada produto do pedido.");
  // Descrição só com números = cadastro da NFeMail estragado (ex.: NCM gravado
  // no lugar do nome por uma importação antiga).
  for (const g of grupos.values()) {
    if (!/[a-zA-Z]/.test(String(g.nfe.dsc_produto || ""))) {
      bloqueios.push(`O produto "${g.nfe.cod_alternativo}" está sem descrição válida na NFeMail ("${g.nfe.dsc_produto}"). Corrija o nome dele no cadastro de produtos da NFeMail.`);
    }
  }

  const usarValorReal = Boolean(opcoes.usarValorReal);
  const semValorNFeMail = [];
  const linhasNota = [...grupos.values()].map((g) => {
    const valorCadastro = Number(g.nfe.val_comercial || 0);
    // Sem valor no cadastro da NFeMail: fica o valor do site (com aviso).
    const doCadastro = !usarValorReal && valorCadastro > 0;
    if (!usarValorReal && !doCadastro) semValorNFeMail.push(g.nfe.dsc_produto);
    const vProd = doCadastro ? arredondar(g.qCom * valorCadastro) : g.vProd;
    return {
      cProd: g.nfe.cod_alternativo || String(g.nfe.cod_produto),
      xProd: g.nfe.dsc_produto,
      ncm: digitos(g.nfe.ncm_produto),
      unidade: g.nfe.cod_unidade || "UN",
      qCom: g.qCom,
      vProd,
      vUnCom: doCadastro ? valorCadastro : g.qCom ? g.vProd / g.qCom : 0,
      valorSite: g.vProd,
      origemValor: doCadastro ? "NFEMAIL" : "SITE",
      produtosSite: g.produtosSite,
    };
  });
  if (semValorNFeMail.length) {
    avisos.push(`Sem valor cadastrado na NFeMail (foi o valor do site): ${semValorNFeMail.join(", ")}. Cadastre o valor comercial desses produtos na NFeMail.`);
  }

  // Totais iguais ao pedido: desconto (+ crédito usado), frete e taxas.
  const vProd = arredondar(linhasNota.reduce((s, l) => s + l.vProd, 0));
  // Desconto/crédito são sobre o valor do site: só entram com o valor real.
  const vDesc = usarValorReal ? arredondar(somar("desconto") + somar("creditoUsado")) : 0;
  const vFrete = arredondar(somar("frete") + somar("freteAdicional"));
  const vOutro = somar("taxas");
  const descontos = ratear(vDesc, linhasNota);
  const fretes = ratear(vFrete, linhasNota);
  const outros = ratear(vOutro, linhasNota);
  linhasNota.forEach((l, i) => {
    l.vDesc = descontos[i];
    l.vFrete = fretes[i];
    l.vOutro = outros[i];
    l.vCredICMSSN = contribuinte ? arredondar((l.vProd * aliquota) / 100) : 0;
  });
  const vNF = arredondar(vProd - vDesc + vFrete + vOutro);
  const totalPedidos = somar("total");
  if (usarValorReal && semVinculo.length === 0 && Math.abs(vNF - totalPedidos) > 0.02) {
    avisos.push(`Total da nota (${dec(vNF)}) diferente do total ${juntos.length ? "dos pedidos" : "do pedido"} (${dec(totalPedidos)}).`);
  }

  const volumes = await volumesDoPedido({ itens: itensTodos, pesoTotalGramas: somar("pesoTotalGramas") });
  const transporte = { ...(await transporteDoPedido(pedido)), ...volumes, esp: "VOLUMES" };
  if (juntos.some((p) => p.metodoEnvio !== pedido.metodoEnvio)) {
    avisos.push(`Os pedidos juntados têm formas de envio diferentes; a nota usa a do pedido ${pedido.numero} (${pedido.metodoEnvio}).`);
  }
  if (opcoes.modFrete != null && opcoes.modFrete !== "") transporte.modFrete = String(opcoes.modFrete);
  if (Number(opcoes.qVol) > 0) transporte.qVol = Math.round(Number(opcoes.qVol));
  if (Number(opcoes.pesoKg) > 0) transporte.pesoL = transporte.pesoB = Number(opcoes.pesoKg);

  const tPag = String(opcoes.tPag || pagamentoPadrao(pedido.formaPagamento));
  const pagamento = { tPag, indPag: PAGAMENTOS_NF[tPag]?.indPag ?? "1", nome: PAGAMENTOS_NF[tPag]?.nome || tPag, vPag: vNF };
  if (!opcoes.tPag && juntos.some((p) => pagamentoPadrao(p.formaPagamento) !== tPag)) {
    avisos.push("Os pedidos juntados têm formas de pagamento diferentes; confira o pagamento da nota.");
  }

  const infCplPadrao = [
    juntos.length ? `Pedidos: ${todos.map((p) => p.numeroFormatado || p.numero).join(", ")}.` : "",
    ...todos.map((p) => String(p.observacoes || "").trim()),
  ].filter(Boolean).join(" ");
  const infCpl = opcoes.infCpl !== undefined ? String(opcoes.infCpl || "") : infCplPadrao;

  const existentes = (await Promise.all(todos.map((p) => notasDoPedidoNaNFeMail(p.numero)))).flat()
    .filter((n, i, lista) => lista.findIndex((o) => String(o.idNFeMail ?? o.chaveAcessoNFe ?? o.numeroNota) === String(n.idNFeMail ?? n.chaveAcessoNFe ?? n.numeroNota)) === i);
  for (const n of existentes) {
    // Rejeitada pela SEFAZ não tem número nem valor fiscal: pode gerar de novo.
    if (REJEITADA(n)) {
      avisos.push(`Tentativa anterior rejeitada pela SEFAZ (${n.status}). Esta nova emissão substitui aquela.`);
      continue;
    }
    bloqueios.push(`${juntos.length ? "Um dos pedidos" : "O pedido"} já tem a nota ${n.numeroNota} na NFeMail (${descreverSituacao(n)}). ${AUTORIZADA(n) ? "Baixe a DANFE dela abaixo." : "Transmita ou exclua essa nota na NFeMail antes de gerar outra."}`);
  }

  return {
    pedido: { id: pedido.id, numero: pedido.numero, numeroFormatado: pedido.numeroFormatado || String(pedido.numero), total: Number(pedido.total), formaPagamento: pedido.formaPagamento, metodoEnvio: pedido.metodoEnvio, notaFiscalNumero: pedido.notaFiscalNumero },
    // Sugestão: outros pedidos em aberto do cliente; "juntos" = os que entraram nesta nota.
    pedidosAbertos: abertos.map(resumoPedido),
    juntos: juntos.map(resumoPedido),
    totalPedidos,
    usarValorReal,
    destino,
    faltando,
    cfop,
    csosn,
    aliquota,
    itens: linhasNota,
    semVinculo,
    notasExistentes: existentes.map((n) => ({ numero: n.numeroNota, chave: n.chaveAcessoNFe, situacao: descreverSituacao(n), autorizada: AUTORIZADA(n), valor: n.valorNota })),
    produtosNFeMail: produtosNFe.filter((p) => !p.inf_inativo).map((p) => ({ codigo: String(p.cod_produto), nome: p.dsc_produto, ncm: p.ncm_produto, unidade: p.cod_unidade, valor: Number(p.val_comercial || 0) })),
    totais: { vProd, vDesc, vFrete, vOutro, vNF },
    transporte,
    pagamento,
    infCpl,
    avisos,
    bloqueios,
  };
};

const agoraBrasilia = () => {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return `${d.toISOString().slice(0, 19)}-03:00`;
};

// Arquivo TXT (layout NFeMail) a partir da prévia.
export const montarTxt = (nota, emit) => {
  const d = nota.destino;
  // Cabeçalho do TXT padrão SEFAZ (quantidade de notas no arquivo): sem ele o
  // conversor da NFeMail falha com "Object reference not set...".
  const linhas = [
    linha("NOTAFISCAL", "1"),
    linha("A", "4.00", ""),
    // B|cUF|cNF|natOp|mod|serie|nNF|dhEmi|dhSaiEnt|tpNF|idDest|cMunFG|tpImp|tpEmis|cDV|tpAmb|finNFe|indFinal|indPres|indIntermed|procEmi|verProc|dhCont|xJust|
    // (layout que o conversor da NFeMail informa; o manual web não traz indIntermed)
    linha("B", "35", "", "Venda de mercadoria", "55", emit.serie || "1", "", agoraBrasilia(), "", "1", d.uf === "SP" ? "1" : "2", emit.cMun, "1", "1", "", "1", "1", d.contribuinte ? "0" : "1", "1", "0", "0", "GiraKids", "", ""),
    linha("C", emit.xNome, emit.xFant, emit.IE, "", "", "", emit.CRT || "1"),
    linha("C02", emit.CNPJ),
    linha("C05", emit.xLgr, emit.nro, emit.xCpl, emit.xBairro, emit.cMun, emit.xMun, emit.UF, emit.CEP, "1058", "BRASIL", emit.fone),
    linha("E", d.nome, d.indIEDest, d.ie, "", "", d.email),
    d.ehCnpj ? linha("E02", d.documento) : linha("E03", d.documento),
    linha("E05", d.logradouro, d.numero, d.complemento, d.bairro, d.cMun, d.cidade, d.uf, d.cep, "1058", "BRASIL", d.fone),
  ];
  nota.itens.forEach((l, i) => {
    linhas.push(linha("H", i + 1, ""));
    // I|cProd|cEAN|cBarra|xProd|NCM|EXTIPI|CFOP|uCom|qCom|vUnCom|vProd|cEANTrib|cBarraTrib|uTrib|qTrib|vUnTrib|vFrete|vSeg|vDesc|vOutro|indTot|xPed|nItemPed|nFCI|indEscala|CNPJFab|cBenef|
    linhas.push(linha("I", l.cProd, "SEM GTIN", "", l.xProd, l.ncm, "", nota.cfop, l.unidade, dec(l.qCom, 4), dec(l.vUnCom, 10), dec(l.vProd), "SEM GTIN", "", l.unidade, dec(l.qCom, 4), dec(l.vUnCom, 10), l.vFrete ? dec(l.vFrete) : "", "", l.vDesc ? dec(l.vDesc) : "", l.vOutro ? dec(l.vOutro) : "", "1", String(nota.pedido.numero), "", "", "", "", ""));
    linhas.push(linha("M", ""));
    linhas.push(nota.csosn === "101" ? linha("N10c", "0", "101", dec(nota.aliquota, 4), dec(l.vCredICMSSN)) : linha("N10d", "0", "102"));
    linhas.push(linha("Q05", "99", "0.00"), linha("Q07", "0.00", "0.0000"));
    linhas.push(linha("S05", "99", "0.00"), linha("S07", "0.00", "0.0000"));
  });
  const t = nota.totais;
  linhas.push(linha("W02", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", dec(t.vProd), dec(t.vFrete), "0.00", dec(t.vDesc), "0.00", "0.00", "0.00", "0.00", "0.00", dec(t.vOutro), dec(t.vNF), ""));
  const tr = nota.transporte;
  linhas.push(linha("X", tr.modFrete));
  if (tr.transportadora) {
    const tp = tr.transportadora;
    linhas.push(linha("X03", tp.nome, "", tp.endereco, tp.cidade, tp.uf));
    if (digitos(tp.cnpj).length === 14) linhas.push(linha("X04", digitos(tp.cnpj)));
  }
  linhas.push(linha("X26", tr.qVol, tr.esp, "", "", dec(tr.pesoL, 3), dec(tr.pesoB, 3)));
  linhas.push(linha("YA", ""));
  // YA01a|indPag|tPag|xPag|vPag|: xPag (descrição) só é aceito com tPag 99.
  linhas.push(linha("YA01a", nota.pagamento.indPag, nota.pagamento.tPag, "", dec(nota.pagamento.vPag)));
  // Sem ZB (compra): o conversor da NFeMail põe <compra> antes de <infAdic> e a
  // SEFAZ rejeita pelo schema. O número do pedido já vai no xPed de cada item.
  if (String(nota.infCpl || "").trim()) linhas.push(linha("Z", "", nota.infCpl));
  return `${linhas.join("\r\n")}\r\n`;
};

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTORIZADA = (n) => Number(n?.codigoStatus) === 100 && Boolean(n?.chaveAcessoNFe);
const REJEITADA = (n) => Number(n?.codigoStatus) > 100 && !AUTORIZADA(n);
const EXCLUIDA = (n) => /exclu/i.test(n?.status || "") || Number(n?.codigoStatus) === 0;

// Notas que a NFeMail já tem para o pedido (sem as excluídas).
export const notasDoPedidoNaNFeMail = async (numeroPedido) =>
  (await buscarNotaPorPedido(numeroPedido).catch(() => [])).filter((n) => !EXCLUIDA(n));

const descreverSituacao = (n) =>
  AUTORIZADA(n) ? "autorizada" : n.status ? n.status : "em digitação (não transmitida)";

// Emite a nota: envia o TXT, acompanha a autorização e baixa a DANFE.
export const emitirNota = async (pedidoId, opcoes, usuario) => {
  const nota = await prepararNota(pedidoId, opcoes);
  if (nota.bloqueios.length) throw erroHttp(400, nota.bloqueios.join(" "));

  // Vínculos escolhidos na tela ficam salvos no produto para as próximas notas.
  for (const [produtoId, codigo] of Object.entries(opcoes.vinculos || {})) {
    if (codigo) await Produto.update({ nfeProdutoCodigo: String(codigo) }, { where: { id: produtoId } });
  }

  const corrigido = opcoes.cliente || {};
  const MAPA_PEDIDO = { documento: "documento", nome: "clienteNome", cep: "cep", logradouro: "rua", numero: "numeroEndereco", complemento: "complemento", bairro: "bairro", cidade: "cidade", uf: "estado" };
  const atualizar = Object.fromEntries(
    Object.entries(MAPA_PEDIDO)
      .filter(([campo]) => corrigido[campo] != null && String(corrigido[campo]).trim() !== "")
      .map(([campo, coluna]) => {
        const valor = String(corrigido[campo]).trim();
        return [coluna, campo === "documento" || campo === "cep" ? digitos(valor) : campo === "uf" ? valor.toUpperCase().slice(0, 2) : valor];
      }),
  );
  const idsPedidos = [pedidoId, ...nota.juntos.map((p) => p.id)];
  if (Object.keys(atualizar).length) await Pedido.update(atualizar, { where: { id: idsPedidos } });

  const emit = await emitenteDaUltimaNota();
  const txt = montarTxt(nota, emit);
  // Notas do cliente que já existiam: a nova é a que aparecer depois do envio.
  const notasDoCliente = async () => {
    const [porPedido, porDocumento] = await Promise.all([
      buscarNotaPorPedido(nota.pedido.numero).catch(() => []),
      buscarNotasPorDocumento(nota.destino.documento).catch(() => []),
    ]);
    return [...porPedido, ...porDocumento];
  };
  const identificar = (n) => String(n.idNFeMail ?? n.chaveAcessoNFe ?? n.numeroNota);
  // Guarda a situação também: reenvio de nota rejeitada pode reaproveitar o registro.
  const assinatura = (n) => `${n.codigoStatus}|${n.status}|${n.chaveAcessoNFe || ""}`;
  const antes = new Map((await notasDoCliente()).map((n) => [identificar(n), assinatura(n)]));
  const respostaEnvio = await enviarTxtNFeMail(txt);

  // A NFeMail processa e transmite em segundo plano: acompanha até autorizar.
  let emitida = null;
  let criada = null;
  let ultimoStatus = "";
  for (let tentativa = 0; tentativa < 20 && !emitida; tentativa += 1) {
    await esperar(tentativa ? 3000 : 2000);
    // Rejeição antiga que só mudou de texto não é a nota nova; autorizada tem prioridade.
    const mudaram = (await notasDoCliente()).filter(
      (n) => antes.get(identificar(n)) !== assinatura(n) && !EXCLUIDA(n) && !(antes.has(identificar(n)) && REJEITADA(n)),
    );
    const nova = mudaram.find(AUTORIZADA) || mudaram[0] || null;
    if (nova) {
      criada = nova;
      ultimoStatus = nova.status || "";
      // Rejeição da SEFAZ (status com código e texto): não adianta esperar.
      if (REJEITADA(nova)) break;
    }
    if (AUTORIZADA(nova)) emitida = nova;
  }

  const pedido = await Pedido.findByPk(pedidoId);
  const historico = { tipo: "NFE_EMITIDA", por: usuario?.nome, em: new Date().toISOString() };
  if (!emitida) {
    await pedido.update({ historico: [...(pedido.historico || []), { ...historico, tipo: "NFE_ENVIADA", status: ultimoStatus || null }] });
    const status = criada
      ? Number(criada.codigoStatus) > 100
        ? `Nota ${criada.numeroNota} rejeitada pela SEFAZ: ${criada.status}`
        : `Nota ${criada.numeroNota} criada na NFeMail, mas ainda não transmitida (em digitação). Veja em Emissão › NFe se ela tem erro; depois de transmitir, baixe a DANFE aqui.`
      : "A NFeMail recebeu o arquivo, mas a nota não apareceu. Veja o histórico em Emissão › NFe › Importar.";
    return { emitida: false, status, numero: criada?.numeroNota || null, respostaEnvio };
  }

  let danfe = null;
  let erroDanfe = null;
  try {
    danfe = await baixarDanfeNFeMail(emitida.chaveAcessoNFe);
  } catch (error) {
    erroDanfe = error.message;
  }
  let url = pedido.notaFiscalUrl;
  if (danfe) {
    const arquivo = await Arquivo.create({ nome: `DANFE-${emitida.numeroNota}.pdf`, mime: "application/pdf", tamanho: danfe.length, dados: danfe, enviadoPor: usuario?.nome || null });
    const base = (process.env.PUBLIC_API_URL || "").replace(/\/$/, "");
    url = base ? `${base}/arquivos/${arquivo.id}` : `/api/arquivos/${arquivo.id}`;
  }
  const registro = { ...historico, numero: String(emitida.numeroNota), chave: emitida.chaveAcessoNFe };
  if (nota.juntos.length) registro.pedidosNaNota = [nota.pedido.numero, ...nota.juntos.map((p) => p.numero)];
  await pedido.update({ notaFiscalNumero: String(emitida.numeroNota), notaFiscalUrl: url, historico: [...(pedido.historico || []), registro] });
  for (const resumo of nota.juntos) {
    const outro = await Pedido.findByPk(resumo.id);
    await outro.update({
      notaFiscalNumero: String(emitida.numeroNota),
      notaFiscalUrl: url,
      historico: [...(outro.historico || []), { ...registro, juntoAoPedido: nota.pedido.numero }],
    });
  }
  return {
    emitida: true,
    pedidosNaNota: registro.pedidosNaNota || [nota.pedido.numero],
    numero: emitida.numeroNota,
    chave: emitida.chaveAcessoNFe,
    danfe: danfe ? danfe.toString("base64") : null,
    erroDanfe,
    url,
  };
};

const salvarDanfe = async (pedido, nota, danfe, usuario) => {
  const arquivo = await Arquivo.create({ nome: `DANFE-${nota.numeroNota}.pdf`, mime: "application/pdf", tamanho: danfe.length, dados: danfe, enviadoPor: usuario?.nome || null });
  const base = (process.env.PUBLIC_API_URL || "").replace(/\/$/, "");
  const url = base ? `${base}/arquivos/${arquivo.id}` : `/api/arquivos/${arquivo.id}`;
  await pedido.update({ notaFiscalNumero: String(nota.numeroNota), notaFiscalUrl: url });
  return url;
};

export const baixarDanfeDoPedido = async (pedidoId, usuario) => {
  const pedido = await Pedido.findByPk(pedidoId);
  if (!pedido) throw erroHttp(404, "Pedido não encontrado.");
  let nota = (await notasDoPedidoNaNFeMail(pedido.numero)).find(AUTORIZADA);
  const conjunta = notaConjunta(pedido);
  if (!nota && conjunta?.juntoAoPedido) {
    nota = (await notasDoPedidoNaNFeMail(conjunta.juntoAoPedido)).find((n) => AUTORIZADA(n) && n.chaveAcessoNFe === conjunta.chave);
  }
  if (!nota) throw erroHttp(400, "Ainda não há nota autorizada para este pedido na NFeMail. Transmita a nota por lá e tente de novo.");
  const danfe = await baixarDanfeNFeMail(nota.chaveAcessoNFe);
  const url = await salvarDanfe(pedido, nota, danfe, usuario);
  return { numero: nota.numeroNota, chave: nota.chaveAcessoNFe, danfe: danfe.toString("base64"), url };
};
