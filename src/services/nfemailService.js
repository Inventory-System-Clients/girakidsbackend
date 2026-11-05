// Integração com a API REST da NFeMail (https://dev.nfemail.com.br).
// Autenticação: HTTP Basic com o CNPJ da empresa (sem formatação) + API key
// gerada no painel NFeMail (Conta > Empresas > gerar chave de API).
// A NFeMail não expõe webhook, então a sincronização é sempre sob demanda
// (polling), disparada pelo usuário comercial na tela de Pedidos/Notas Fiscais.

const NFEMAIL_API_BASE_URL =
  process.env.NFEMAIL_API_BASE_URL || "https://api.nfemail.com.br";

const credenciaisConfiguradas = () =>
  Boolean(process.env.NFEMAIL_CNPJ && process.env.NFEMAIL_API_KEY);

const montarAuthHeader = () => {
  if (!credenciaisConfiguradas()) {
    const erro = new Error(
      "NFEMAIL_CNPJ/NFEMAIL_API_KEY não configuradas no backend",
    );
    erro.status = 500;
    throw erro;
  }

  const cnpj = String(process.env.NFEMAIL_CNPJ).replace(/\D/g, "");
  const credenciais = Buffer.from(
    `${cnpj}:${process.env.NFEMAIL_API_KEY}`,
  ).toString("base64");

  return `Basic ${credenciais}`;
};

const chamarNFeMail = async (path, params = {}) => {
  if (typeof fetch !== "function") {
    const erro = new Error(
      "fetch nativo indisponível. Execute o backend em Node.js 18 ou superior.",
    );
    erro.status = 500;
    throw erro;
  }

  const url = new URL(path, NFEMAIL_API_BASE_URL);
  Object.entries(params).forEach(([chave, valor]) => {
    if (valor !== undefined && valor !== null && valor !== "") {
      url.searchParams.set(chave, valor);
    }
  });

  const resposta = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: montarAuthHeader(),
      Accept: "application/json",
    },
  });

  const textoBruto = await resposta.text();
  let payload = null;
  try {
    payload = textoBruto ? JSON.parse(textoBruto) : null;
  } catch {
    payload = null;
  }

  // Log temporário de diagnóstico: mostra exatamente o que a NFeMail devolveu,
  // já que o schema de resposta não é 100% documentado publicamente. Remover
  // depois de confirmar o formato real.
  console.log(
    `[nfemailService] GET ${url.pathname}${url.search} -> status ${resposta.status}`,
  );
  console.log(
    `[nfemailService] corpo bruto (até 1000 chars): ${textoBruto.slice(0, 1000)}`,
  );

  if (!resposta.ok) {
    const mensagem =
      payload?.mensagem || payload?.message || "Falha ao consultar a NFeMail";
    const erro = new Error(mensagem);
    erro.status = resposta.status;
    throw erro;
  }

  return payload;
};

// Converte datas nos formatos observados na API da NFeMail (ex.: "22-09-2026"
// ou "22-09-2026 14:27:00", padrão DD-MM-AAAA) para "AAAA-MM-DD" (aceito
// pelas colunas DATEONLY do nosso banco). Se já vier em formato ISO, mantém.
const normalizarDataNFeMail = (valor) => {
  if (!valor) return null;
  const texto = String(valor).trim();

  const matchBr = texto.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (matchBr) {
    const [, dia, mes, ano] = matchBr;
    return `${ano}-${mes}-${dia}`;
  }

  const matchIso = texto.match(/^(\d{4}-\d{2}-\d{2})/);
  if (matchIso) return matchIso[1];

  return texto;
};

// Extrai a lista de registros de respostas cujo formato exato não é
// documentado publicamente pela NFeMail. Observado até agora em
// /api/NotasFiscais: { "ListaNotaFiscal": [...] }.
const extrairLista = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const chavesConhecidas = [
    "ListaNotaFiscal",
    "ListaNFeRecebidas",
    "dados",
    "notas",
    "lista",
    "data",
    "result",
    "records",
  ];
  for (const chave of chavesConhecidas) {
    if (Array.isArray(payload[chave])) return payload[chave];
  }

  return [];
};

// Campos observados em /api/NotasFiscais (payload real, em 2026-09):
// nfe_numero, ped_numero, nom_razaosocial, nom_fantasia, nfe_chave,
// val_total, dat_emissao (DD-MM-AAAA). ped_numero costuma vir vazio quando o
// número do pedido não é preenchido na hora de emitir a nota na NFeMail —
// nesse caso o casamento automático por numeroPedido não encontra o registro
// e a nota fica só disponível para vínculo manual.
// Transportadora e tipo de frete (CIF/FOB) NÃO aparecem nessa listagem
// resumida; ficam nulos até serem preenchidos manualmente.
export const normalizarNotaNFeMail = (raw) => {
  if (!raw || typeof raw !== "object") return null;

  const numeroNota = raw.nfe_numero ?? raw.numero ?? raw.numeroNota ?? raw.nNF ?? null;
  const numeroPedidoBruto =
    raw.ped_numero ??
    raw.pedido ??
    raw.numeroPedido ??
    raw.codigoPedido ??
    raw.codPedido ??
    null;
  const numeroPedido =
    numeroPedidoBruto != null && String(numeroPedidoBruto).trim() !== ""
      ? String(numeroPedidoBruto).trim()
      : null;
  const clienteNome =
    raw.nom_razaosocial ??
    raw.nom_fantasia ??
    raw.cliente ??
    raw.nomeCliente ??
    raw.destinatario ??
    raw.razaoSocial ??
    null;
  const dataNota = normalizarDataNFeMail(
    raw.dat_emissao ?? raw.dataEmissao ?? raw.data ?? raw.dhEmi ?? raw.emissao ?? null,
  );
  const transportadora =
    raw.transportadora ?? raw.transportadoraNome ?? raw.nomeTransportadora ?? null;
  const tipoFreteRaw = raw.tipoFrete ?? raw.frete ?? raw.modFrete ?? null;
  const tipoFrete = tipoFreteRaw
    ? String(tipoFreteRaw).toUpperCase().includes("FOB")
      ? "FOB"
      : String(tipoFreteRaw).toUpperCase().includes("CIF")
        ? "CIF"
        : null
    : null;
  const valorNota = raw.val_total ?? raw.valor ?? raw.valorTotal ?? raw.vNF ?? null;
  const chaveAcessoNFe =
    raw.nfe_chave ?? raw.chave ?? raw.chaveAcesso ?? raw.chNFe ?? null;
  const cnpjCliente = raw.num_cnpj ?? raw.cpfCnpj ?? raw.cnpj ?? null;

  return {
    numeroNota: numeroNota != null ? String(numeroNota) : null,
    numeroPedido,
    clienteNome: clienteNome != null ? String(clienteNome).trim() : null,
    cnpjCliente: cnpjCliente != null ? String(cnpjCliente) : null,
    dataNota,
    transportadora,
    tipoFrete,
    valorNota,
    chaveAcessoNFe,
    idNFeMail: raw.cod_nfemail ?? null,
    status: raw.dsc_processo ?? null,
    codigoStatus: raw.cod_processo ?? null,
  };
};

export const buscarNotasRecebidas = async ({ dataInicial, dataFinal } = {}) => {
  const payload = await chamarNFeMail("/api/NFeRecebidas", {
    dataInicial,
    dataFinal,
  });
  return extrairLista(payload).map(normalizarNotaNFeMail).filter(Boolean);
};

export const buscarNotaPorPedido = async (numeroPedido) => {
  const payload = await chamarNFeMail("/api/NotasFiscais", {
    pedido: numeroPedido,
  });
  return extrairLista(payload).map(normalizarNotaNFeMail).filter(Boolean);
};

// Lista as notas fiscais EMITIDAS pela empresa (notas de venda para os
// clientes) via /api/NotasFiscais, paginado. Diferente de NFeRecebidas, que
// traz notas de COMPRA recebidas de fornecedores — por isso não serve para
// o fluxo comercial de "nota emitida para o cliente X no pedido Y".
export const buscarNotasEmitidas = async ({ page = 1, limit = 50 } = {}) => {
  const payload = await chamarNFeMail("/api/NotasFiscais", { page, limit });
  return extrairLista(payload).map(normalizarNotaNFeMail).filter(Boolean);
};

// A listagem de /api/NotasFiscais não traz transportadora nem CIF/FOB — esses
// dados só existem no XML completo da nota (tags <transp><modFrete> e
// <transporta><xNome>, padrão do layout da NF-e). Busca o XML por chave de
// acesso via /api/ArquivoXML e extrai só o que precisamos.
const buscarXmlBrutoPorChave = async (chave) => {
  if (typeof fetch !== "function") {
    const erro = new Error(
      "fetch nativo indisponível. Execute o backend em Node.js 18 ou superior.",
    );
    erro.status = 500;
    throw erro;
  }

  const url = new URL("/api/ArquivoXML", NFEMAIL_API_BASE_URL);
  url.searchParams.set("chave", chave);

  const resposta = await fetch(url, {
    method: "GET",
    headers: { Authorization: montarAuthHeader() },
  });

  const textoBruto = await resposta.text();

  // Log temporário de diagnóstico (mesmo esquema usado para /api/NotasFiscais):
  // essa resposta pode vir como XML puro ou como JSON que embrulha o XML,
  // e isso não está documentado publicamente.
  console.log(
    `[nfemailService] GET ${url.pathname}${url.search} -> status ${resposta.status}`,
  );
  console.log(
    `[nfemailService] corpo bruto XML (até 1500 chars): ${textoBruto.slice(0, 1500)}`,
  );

  if (!resposta.ok) {
    const erro = new Error("Falha ao buscar XML da nota na NFeMail");
    erro.status = resposta.status;
    throw erro;
  }

  // Pode vir como XML puro ou como JSON { xml: "<...>" } / { arquivo: "<...>" }.
  let xml = textoBruto;
  try {
    const comoJson = JSON.parse(textoBruto);
    xml =
      comoJson?.xml ??
      comoJson?.arquivo ??
      comoJson?.conteudo ??
      comoJson?.data ??
      textoBruto;
  } catch {
    // não era JSON, segue com o texto bruto mesmo (provavelmente já é o XML)
  }

  return typeof xml === "string" ? xml : null;
};

// modFrete (grupo <transp> da NF-e): 0/3 = por conta do remetente (CIF),
// 1/4 = por conta do destinatário (FOB), 2 = terceiros, 9 = sem transporte.
const extrairFreteETransportadoraDoXml = (xml) => {
  if (!xml || typeof xml !== "string") {
    return { tipoFrete: null, transportadora: null };
  }

  const modFreteMatch = xml.match(/<modFrete>\s*(\d)\s*<\/modFrete>/i);
  const modFrete = modFreteMatch ? modFreteMatch[1] : null;

  let tipoFrete = null;
  if (modFrete === "0" || modFrete === "3") tipoFrete = "CIF";
  else if (modFrete === "1" || modFrete === "4") tipoFrete = "FOB";

  const transportadoraMatch = xml.match(
    /<transporta>[\s\S]*?<xNome>([^<]+)<\/xNome>/i,
  );
  const transportadora = transportadoraMatch
    ? transportadoraMatch[1].trim()
    : null;

  return { tipoFrete, transportadora };
};

// Busca CIF/FOB e transportadora para UMA nota específica (pelo XML completo).
// Não é chamado para a listagem inteira (custaria uma requisição por nota) —
// só quando o usuário escolhe uma nota específica na tela.
export const buscarFreteETransportadoraPorChave = async (chave) => {
  if (!chave) return { tipoFrete: null, transportadora: null };
  const xml = await buscarXmlBrutoPorChave(chave);
  return extrairFreteETransportadoraDoXml(xml);
};

export const nfemailCredenciaisConfiguradas = credenciaisConfiguradas;

// Diagnóstico (só leitura) para montar a emissão automática no mesmo padrão
// das notas que a empresa já emite: última nota (partes fiscais do XML) e
// amostras de produtos e clientes cadastrados na NFeMail.
const tag = (xml, nome) => xml?.match(new RegExp(`<${nome}[^>]*>[^]*?</${nome}>`, "i"))?.[0] || null;
const todas = (xml, nome) => xml?.match(new RegExp(`<${nome}[^>]*>[^]*?</${nome}>`, "gi")) || [];

export const diagnosticoEmissaoNFeMail = async () => {
  const notas = await buscarNotasEmitidas({ page: 1, limit: 5 });
  const comChave = notas.filter((n) => n.chaveAcessoNFe);
  const amostras = [];
  for (const nota of comChave.slice(0, 2)) {
    const xml = await buscarXmlBrutoPorChave(nota.chaveAcessoNFe);
    amostras.push({
      numero: nota.numeroNota,
      ide: tag(xml, "ide"),
      emit: tag(xml, "emit"),
      destUF: xml?.match(/<dest>[\s\S]*?<UF>([A-Z]{2})<\/UF>/)?.[1] || null,
      destIndIEDest: xml?.match(/<indIEDest>(\d)<\/indIEDest>/)?.[1] || null,
      itens: todas(xml, "det").slice(0, 2),
      total: tag(xml, "total"),
      transp: tag(xml, "transp"),
      cobr: tag(xml, "cobr"),
      pag: tag(xml, "pag"),
      infAdic: tag(xml, "infAdic"),
      compra: tag(xml, "compra"),
    });
  }
  const bruto = async (path, params) => {
    try {
      return await chamarNFeMail(path, params);
    } catch (error) {
      return { erro: error.message };
    }
  };
  const listaProdutos = await bruto("/api/Produtos", { page: 1, limit: 500 });
  const produtos = (listaProdutos.ListaProduto || []).map((p) => [p.cod_produto, p.cod_alternativo, p.dsc_produto, p.ncm_produto, p.cod_unidade, p.num_cfop, p.inf_inativo ? "inativo" : ""].join(" | "));
  const clientes = await bruto("/api/Clientes", { page: 1, limit: 1 });
  return { notasRecentes: notas, amostras, produtos, clientes };
};


// --- Emissão automática (usado por nfeEmissaoService) ----------------------

export const buscarClienteNFeMail = async (cpfCnpj) => {
  let payload;
  try {
    payload = await chamarNFeMail("/api/Clientes", { cpfcnpj: String(cpfCnpj).replace(/\D/g, "") });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  // Por CPF/CNPJ a NFeMail devolve o cliente sozinho (sem lista).
  const lista = payload?.ListaCliente || (payload?.num_cpfcnpj ? [payload] : extrairLista(payload));
  return lista.find((c) => String(c.num_cpfcnpj || "").replace(/\D/g, "") === String(cpfCnpj).replace(/\D/g, "")) || lista[0] || null;
};

export const buscarNotasPorDocumento = async (cpfCnpj) => {
  const payload = await chamarNFeMail("/api/NotasFiscais", { cpfcnpj: String(cpfCnpj).replace(/\D/g, "") });
  return extrairLista(payload).map(normalizarNotaNFeMail).filter(Boolean);
};

let produtosCache = null;
export const listarProdutosNFeMail = async () => {
  if (produtosCache && Date.now() - produtosCache.em < 10 * 60 * 1000) return produtosCache.lista;
  // A NFeMail devolve no máximo 10 por página: segue até acabar.
  const lista = [];
  const vistos = new Set();
  for (let page = 1; page <= 50; page += 1) {
    const payload = await chamarNFeMail("/api/Produtos", { page, limit: 10 });
    const parte = (payload?.ListaProduto || extrairLista(payload)).filter((p) => !vistos.has(p.cod_produto));
    if (!parte.length) break;
    parte.forEach((p) => vistos.add(p.cod_produto));
    lista.push(...parte);
  }
  produtosCache = { em: Date.now(), lista };
  return lista;
};

// Dados do emitente copiados da última nota autorizada (os mesmos que a
// NFeMail usa nas notas emitidas pela tela).
let emitenteCache = null;
export const emitenteDaUltimaNota = async () => {
  if (emitenteCache) return emitenteCache;
  const notas = await buscarNotasEmitidas({ page: 1, limit: 10 });
  const nota = notas.find((n) => n.chaveAcessoNFe);
  if (!nota) throw Object.assign(new Error("Nenhuma nota autorizada na NFeMail para copiar os dados do emitente."), { status: 400 });
  const xml = await buscarXmlBrutoPorChave(nota.chaveAcessoNFe);
  const emit = xml?.match(/<emit>[^]*?<\/emit>/)?.[0] || "";
  const serie = xml?.match(/<serie>(\d+)<\/serie>/)?.[1] || "1";
  const valor = (t) => emit.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1] || "";
  if (!valor("CNPJ")) throw Object.assign(new Error("Não consegui ler os dados do emitente na NFeMail."), { status: 502 });
  emitenteCache = {
    CNPJ: valor("CNPJ"), xNome: valor("xNome"), xFant: valor("xFant"), IE: valor("IE"), CRT: valor("CRT"),
    xLgr: valor("xLgr"), nro: valor("nro"), xCpl: valor("xCpl"), xBairro: valor("xBairro"), cMun: valor("cMun"),
    xMun: valor("xMun"), UF: valor("UF"), CEP: valor("CEP"), fone: valor("fone"), serie,
  };
  return emitenteCache;
};

// POST api/NotasFiscais: corpo form-urlencoded "=<TXT>" (como o exemplo da NFeMail).
export const enviarTxtNFeMail = async (txt) => {
  const resposta = await fetch(new URL("/api/NotasFiscais", NFEMAIL_API_BASE_URL), {
    method: "POST",
    headers: { Authorization: montarAuthHeader(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: `=${encodeURIComponent(txt)}`,
  });
  const texto = await resposta.text();
  console.log(`[nfemailService] POST /api/NotasFiscais -> status ${resposta.status}: ${texto.slice(0, 1000)}`);
  let dados = texto;
  try {
    dados = JSON.parse(texto);
  } catch {
    // resposta em texto
  }
  if (!resposta.ok) {
    const msg = (typeof dados === "object" && (dados?.Message || dados?.mensagem || dados?.message)) || String(texto).slice(0, 300);
    throw Object.assign(new Error(`A NFeMail recusou a nota: ${msg}`), { status: 502 });
  }
  return dados;
};

// DANFE em PDF: pode vir como PDF puro ou JSON com base64.
export const baixarDanfeNFeMail = async (chave) => {
  const url = new URL("/api/DANFe", NFEMAIL_API_BASE_URL);
  url.searchParams.set("chave", chave);
  const resposta = await fetch(url, { headers: { Authorization: montarAuthHeader() } });
  const bytes = Buffer.from(await resposta.arrayBuffer());
  if (!resposta.ok) throw Object.assign(new Error(`DANFE indisponível (HTTP ${resposta.status}).`), { status: 502 });
  if (bytes.subarray(0, 4).toString() === "%PDF") return bytes;
  const texto = bytes.toString("utf8");
  let base64 = texto.replace(/^"|"$/g, "");
  try {
    const json = JSON.parse(texto);
    base64 = typeof json === "string" ? json : json?.pdf || json?.arquivo || json?.danfe || json?.conteudo || json?.data || "";
  } catch {
    // não era JSON
  }
  const pdf = Buffer.from(String(base64), "base64");
  if (pdf.subarray(0, 4).toString() !== "%PDF") throw Object.assign(new Error("A NFeMail não devolveu o PDF da DANFE."), { status: 502 });
  return pdf;
};
