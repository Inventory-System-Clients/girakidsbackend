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
