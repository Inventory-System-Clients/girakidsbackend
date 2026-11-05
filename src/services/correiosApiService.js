// Integração direta com a API dos Correios (api.correios.com.br), no lugar do
// VIPP: cotação (Preço + Prazo), pré-postagem, rótulo em PDF e declaração de
// conteúdo. Credenciais só no ambiente (Render):
//   CORREIOS_USUARIO        usuário do Meu Correios (geralmente o CNPJ)
//   CORREIOS_CODIGO_ACESSO  código de acesso à API gerado no CWS
//   CORREIOS_CARTAO_POSTAGEM / CORREIOS_CONTRATO
// Remetente (opcionais, com padrão):
//   CORREIOS_REMETENTE_NOME, _CEP, _LOGRADOURO, _NUMERO, _COMPLEMENTO,
//   _BAIRRO, _CIDADE, _UF, _TELEFONE, _EMAIL
// Serviços cotados: CORREIOS_SERVICOS="03298:PAC,03220:SEDEX" (padrão).

import { CONTEUDO_PADRAO, validarCarga } from "./vippService.js";

const BASE_URL = (process.env.CORREIOS_API_URL || "https://api.correios.com.br").replace(/\/$/, "");
const SERVICOS_PADRAO = "03298:PAC,03220:SEDEX";

const erroHttp = (status, mensagem) => Object.assign(new Error(mensagem), { status });
const env = (nome) => String(process.env[nome] || "").trim();
const digitos = (valor) => String(valor || "").replace(/\D/g, "");

export const apiCorreiosConfigurada = () =>
  Boolean(env("CORREIOS_USUARIO") && env("CORREIOS_CODIGO_ACESSO") && env("CORREIOS_CARTAO_POSTAGEM"));

const servicosConfigurados = () =>
  (env("CORREIOS_SERVICOS") || SERVICOS_PADRAO)
    .split(",")
    .map((item) => item.split(":").map((parte) => parte.trim()))
    .filter(([codigo]) => codigo)
    .map(([codigo, nome]) => ({ codigo: codigo.padStart(5, "0"), nome: nome || codigo }));

const lerResposta = async (resposta) => {
  const texto = await resposta.text();
  try {
    return JSON.parse(texto);
  } catch {
    return { texto };
  }
};

// Mensagem de erro no formato dos Correios ({ msgs: [...] }) ou parecido.
const mensagemCorreios = (dados) =>
  [dados?.msgs, dados?.mensagens, dados?.message, dados?.msg, dados?.causa, dados?.texto]
    .flat()
    .filter((m) => typeof m === "string" && m.trim())
    .join("; ")
    .replace(/<[^>]+>/g, " ")
    .slice(0, 400) || "sem detalhes";

const lerJwt = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
};

// Token do cartão de postagem: vale ~24 h; renova com folga de 10 min.
let sessao = null;

const autenticar = async () => {
  if (sessao && sessao.expiraEm - Date.now() > 10 * 60 * 1000) return sessao;
  if (!apiCorreiosConfigurada()) {
    throw erroHttp(500, "Configure CORREIOS_USUARIO, CORREIOS_CODIGO_ACESSO e CORREIOS_CARTAO_POSTAGEM no ambiente do backend.");
  }
  const basic = Buffer.from(`${env("CORREIOS_USUARIO")}:${env("CORREIOS_CODIGO_ACESSO")}`).toString("base64");
  const resposta = await fetch(`${BASE_URL}/token/v1/autentica/cartaopostagem`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ numero: digitos(env("CORREIOS_CARTAO_POSTAGEM")).padStart(10, "0") }),
  });
  const dados = await lerResposta(resposta);
  if (!resposta.ok || !dados.token) {
    throw erroHttp(502, `Os Correios recusaram o login da API (HTTP ${resposta.status}): ${mensagemCorreios(dados)}`);
  }
  const jwt = lerJwt(dados.token);
  const cartao = dados.cartaoPostagem || jwt["cartao-postagem"] || {};
  sessao = {
    token: dados.token,
    expiraEm: new Date(dados.expiraEm || 0).getTime() || (jwt.exp ? jwt.exp * 1000 : Date.now() + 60 * 60 * 1000),
    ambiente: dados.ambiente || jwt.ambiente || null,
    cnpj: digitos(dados.cnpj || jwt.cnpj || ""),
    cartao: String(cartao.numero || env("CORREIOS_CARTAO_POSTAGEM")),
    contrato: String(cartao.contrato || env("CORREIOS_CONTRATO") || ""),
    dr: cartao.dr ?? null,
    apis: cartao.api || [],
  };
  return sessao;
};

const requisitar = async (caminho, { method = "GET", corpo, tentarDeNovo = true } = {}) => {
  const { token } = await autenticar();
  const resposta = await fetch(`${BASE_URL}${caminho}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/html, */*",
      ...(corpo ? { "Content-Type": "application/json" } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (resposta.status === 401 && tentarDeNovo) {
    sessao = null;
    return requisitar(caminho, { method, corpo, tentarDeNovo: false });
  }
  return resposta;
};

const requisitarJson = async (caminho, opcoes, contexto) => {
  const resposta = await requisitar(caminho, opcoes);
  const dados = await lerResposta(resposta);
  if (!resposta.ok) {
    throw erroHttp(resposta.status >= 500 ? 502 : 400, `${contexto}: ${mensagemCorreios(dados)}`);
  }
  return dados;
};

// --- Remetente -------------------------------------------------------------

const semAcento = (texto, limite) =>
  String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limite);

const enderecoDoCep = async (cep) => {
  try {
    const dados = await requisitarJson(`/cep/v2/enderecos/${cep}`, {}, "CEP");
    if (dados.logradouro || dados.localidade) {
      return { logradouro: dados.logradouro, bairro: dados.bairro, cidade: dados.localidade, uf: dados.uf };
    }
  } catch {
    // API de CEP não liberada no cartão: tenta o ViaCEP.
  }
  try {
    const dados = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
    if (!dados.erro) return { logradouro: dados.logradouro, bairro: dados.bairro, cidade: dados.localidade, uf: dados.uf };
  } catch {
    // Sem consulta de CEP: fica só o que veio do ambiente.
  }
  return {};
};

// Telefone brasileiro → campos separados que a pré-postagem pede.
const telefoneCorreios = (telefone) => {
  const d = digitos(telefone).replace(/^55(?=\d{10,11}$)/, "");
  if (d.length === 11) return { dddCelular: d.slice(0, 2), celular: d.slice(2) };
  if (d.length === 10) return { dddTelefone: d.slice(0, 2), telefone: d.slice(2) };
  return {};
};

let remetenteCache = null;

const remetente = async () => {
  if (remetenteCache) return remetenteCache;
  const cep = digitos(env("CORREIOS_REMETENTE_CEP"));
  if (cep.length !== 8) {
    throw erroHttp(500, "Configure CORREIOS_REMETENTE_CEP (CEP de onde as encomendas saem) no ambiente do backend.");
  }
  const { cnpj } = await autenticar();
  const doCep = await enderecoDoCep(cep);
  const endereco = {
    cep,
    logradouro: semAcento(env("CORREIOS_REMETENTE_LOGRADOURO") || doCep.logradouro, 50),
    numero: semAcento(env("CORREIOS_REMETENTE_NUMERO") || "S/N", 6),
    complemento: semAcento(env("CORREIOS_REMETENTE_COMPLEMENTO"), 30),
    bairro: semAcento(env("CORREIOS_REMETENTE_BAIRRO") || doCep.bairro, 30),
    cidade: semAcento(env("CORREIOS_REMETENTE_CIDADE") || doCep.cidade, 30),
    uf: (env("CORREIOS_REMETENTE_UF") || doCep.uf || "").toUpperCase().slice(0, 2),
  };
  const faltando = ["logradouro", "bairro", "cidade", "uf"].filter((campo) => !endereco[campo]);
  if (faltando.length) {
    throw erroHttp(500, `Não achei o endereço do CEP do remetente. Configure CORREIOS_REMETENTE_${faltando[0].toUpperCase()} no ambiente do backend.`);
  }
  remetenteCache = {
    nome: semAcento(env("CORREIOS_REMETENTE_NOME") || "Gira Kids", 50),
    cpfCnpj: digitos(env("CORREIOS_REMETENTE_CNPJ")) || cnpj || digitos(env("CORREIOS_USUARIO")),
    ...(env("CORREIOS_REMETENTE_EMAIL") ? { email: env("CORREIOS_REMETENTE_EMAIL") } : {}),
    ...telefoneCorreios(env("CORREIOS_REMETENTE_TELEFONE")),
    endereco,
  };
  return remetenteCache;
};

// --- Cotação -----------------------------------------------------------------

const numeroBr = (valor) => Number(String(valor ?? "").replace(/\./g, "").replace(",", ".")) || 0;

const cotarServico = async (servico, carga, origem, conta) => {
  const destino = digitos(carga.cep);
  const parametros = new URLSearchParams({
    cepOrigem: origem,
    cepDestino: destino,
    psObjeto: String(carga.pesoGramas),
    tpObjeto: "2",
    comprimento: String(carga.comprimento),
    largura: String(carga.largura),
    altura: String(carga.altura),
    ...(conta.contrato ? { nuContrato: conta.contrato } : {}),
    ...(conta.dr != null ? { nuDR: String(conta.dr) } : {}),
  });
  try {
    const [preco, prazo] = await Promise.all([
      requisitarJson(`/preco/v1/nacional/${servico.codigo}?${parametros}`, {}, "Preço"),
      requisitarJson(`/prazo/v1/nacional/${servico.codigo}?cepOrigem=${origem}&cepDestino=${destino}`, {}, "Prazo").catch(() => ({})),
    ]);
    const valor = numeroBr(preco.pcFinal);
    return {
      id: servico.codigo,
      nome: servico.nome,
      disponivel: valor > 0 && !preco.txErro,
      valor,
      prazoDias: Number(prazo.prazoEntrega || 0),
      erro: preco.txErro || (valor > 0 ? "" : "Sem preço para este envio."),
    };
  } catch (error) {
    return { id: servico.codigo, nome: servico.nome, disponivel: false, valor: 0, prazoDias: 0, erro: error.message };
  }
};

const cotarTodos = async (cargaValida) => {
  const conta = await autenticar();
  const { endereco } = await remetente();
  return Promise.all(servicosConfigurados().map((servico) => cotarServico(servico, cargaValida, endereco.cep, conta)));
};

const nomeConta = (conta) => `API dos Correios${conta.contrato ? ` · contrato ${conta.contrato}` : ""}`;

export const cotarServicosApi = async (carga) => {
  const cargaValida = validarCarga(carga);
  const servicos = await cotarTodos(cargaValida);
  return { postadora: nomeConta(await autenticar()), servicos };
};

// --- Pré-postagem, rótulo e declaração -------------------------------------

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pede o rótulo (assíncrono nos Correios) e espera o PDF ficar pronto.
const gerarRotulo = async (idPrePostagem) => {
  const conta = await autenticar();
  const pedido = await requisitarJson(
    "/prepostagem/v1/prepostagens/rotulo/assincrono/pdf",
    {
      method: "POST",
      corpo: {
        idsPrePostagem: [idPrePostagem],
        numeroCartaoPostagem: conta.cartao,
        tipoRotulo: "P",
        formatoRotulo: "ET",
        imprimeRemetente: "S",
        layoutImpressao: "PADRAO",
      },
    },
    "Rótulo",
  );
  const recibo = pedido.idRecibo || pedido.recibo || pedido.id;
  if (!recibo) throw erroHttp(502, `Os Correios não devolveram o recibo do rótulo: ${mensagemCorreios(pedido)}`);

  let ultimo = "";
  for (let tentativa = 0; tentativa < 10; tentativa += 1) {
    await esperar(tentativa ? 2000 : 1000);
    const resposta = await requisitar(`/prepostagem/v1/prepostagens/rotulo/download/assincrono/${encodeURIComponent(recibo)}`);
    const dados = await lerResposta(resposta);
    const base64 = dados.dados || dados.arquivo || dados.conteudo;
    if (resposta.ok && base64) return Buffer.from(base64, "base64");
    ultimo = mensagemCorreios(dados);
  }
  throw erroHttp(502, `O rótulo ainda não ficou pronto nos Correios (${ultimo}). Tente "Baixar PDFs" de novo em instantes.`);
};

const gerarDeclaracao = async (idPrePostagem) => {
  const resposta = await requisitar(`/prepostagem/v1/prepostagens/declaracaoconteudo/${encodeURIComponent(idPrePostagem)}`);
  const conteudo = Buffer.from(await resposta.arrayBuffer());
  if (!resposta.ok) {
    throw erroHttp(502, `Declaração de conteúdo: ${mensagemCorreios(await lerResposta(new Response(conteudo)))}`);
  }
  const pdf = conteudo.subarray(0, 4).toString() === "%PDF";
  return { conteudo, mime: pdf ? "application/pdf" : "text/html", extensao: pdf ? "pdf" : "html" };
};

const arquivosDaPostagem = async (idPrePostagem, nomeBase) => {
  const arquivos = [];
  const errosPdf = [];
  try {
    const rotulo = await gerarRotulo(idPrePostagem);
    arquivos.push({ tipo: "etiqueta", nome: `etiqueta-${nomeBase}.pdf`, mime: "application/pdf", base64: rotulo.toString("base64") });
  } catch (error) {
    errosPdf.push(error.message);
  }
  try {
    const declaracao = await gerarDeclaracao(idPrePostagem);
    arquivos.push({
      tipo: "declaracao",
      nome: `declaracao-conteudo-${nomeBase}.${declaracao.extensao}`,
      mime: declaracao.mime,
      base64: declaracao.conteudo.toString("base64"),
    });
  } catch (error) {
    errosPdf.push(error.message);
  }
  return { arquivos, errosPdf };
};

const buscarCodigoObjeto = async (idPrePostagem) => {
  try {
    const dados = await requisitarJson(`/prepostagem/v2/prepostagens?id=${encodeURIComponent(idPrePostagem)}`, {}, "Consulta");
    const item = (dados.itens || dados.content || [dados]).find((p) => p?.id === idPrePostagem) || {};
    return item.codigoObjeto || "";
  } catch {
    return "";
  }
};

export const criarPostagemApi = async ({ destinatario, carga, servicoId, observacao, valorDeclarado }) => {
  const cargaValida = validarCarga({ ...carga, cep: destinatario.cep });
  const obrigatorios = { nome: "nome do destinatário", logradouro: "logradouro", numero: "número", bairro: "bairro", cidade: "cidade", uf: "UF" };
  for (const [campo, rotulo] of Object.entries(obrigatorios)) {
    if (!String(destinatario[campo] || "").trim()) throw new Error(`Preencha o ${rotulo}.`);
  }

  // Confere o serviço com a cotação de agora (preço e disponibilidade).
  const servicos = await cotarTodos(cargaValida);
  const servico = servicos.find((item) => item.id === String(servicoId));
  if (!servico) throw new Error("Serviço escolhido não está disponível para este envio.");
  if (!servico.disponivel) throw new Error(`Serviço ${servico.nome} indisponível: ${servico.erro}`);

  const documento = digitos(destinatario.documento);
  const corpo = {
    remetente: await remetente(),
    destinatario: {
      nome: semAcento(destinatario.nome, 50),
      ...(destinatario.email ? { email: String(destinatario.email).trim().slice(0, 255) } : {}),
      ...(documento.length === 11 || documento.length === 14 ? { cpfCnpj: documento } : {}),
      ...telefoneCorreios(destinatario.telefone),
      endereco: {
        cep: digitos(cargaValida.cep),
        logradouro: semAcento(destinatario.logradouro, 50),
        numero: semAcento(destinatario.numero, 6) || "S/N",
        complemento: semAcento(destinatario.complemento, 30),
        bairro: semAcento(destinatario.bairro, 30),
        cidade: semAcento(destinatario.cidade, 30),
        uf: String(destinatario.uf || "").toUpperCase().slice(0, 2),
      },
    },
    codigoServico: servico.id,
    pesoInformado: String(cargaValida.pesoGramas),
    codigoFormatoObjetoInformado: "2",
    alturaInformada: String(cargaValida.altura),
    larguraInformada: String(cargaValida.largura),
    comprimentoInformado: String(cargaValida.comprimento),
    cienteObjetoNaoProibido: "1",
    modalidadePagamento: "2",
    observacao: semAcento(observacao, 50),
    itensDeclaracaoConteudo: [
      { conteudo: CONTEUDO_PADRAO, quantidade: "1", valor: (Number(valorDeclarado) > 0 ? Number(valorDeclarado) : 1).toFixed(2) },
    ],
  };

  const prePostagem = await requisitarJson("/prepostagem/v1/prepostagens", { method: "POST", corpo }, "Os Correios recusaram a pré-postagem");
  if (!prePostagem.id) throw erroHttp(502, `Os Correios não devolveram o número da pré-postagem: ${mensagemCorreios(prePostagem)}`);

  // A pré-postagem já existe; se o rótulo falhar, devolvemos o erro sem
  // gravar de novo (geraria outra pré-postagem).
  const { arquivos, errosPdf } = await arquivosDaPostagem(prePostagem.id, prePostagem.codigoObjeto || prePostagem.id);
  const etiqueta = prePostagem.codigoObjeto || (await buscarCodigoObjeto(prePostagem.id));

  return {
    idConhecimento: prePostagem.id,
    etiqueta,
    servico: { id: servico.id, nome: servico.nome, valor: servico.valor, prazoDias: servico.prazoDias },
    arquivos,
    errosPdf,
  };
};

export const baixarPdfsPostagemApi = async (idPrePostagem, nomeBase) => {
  const { arquivos, errosPdf } = await arquivosDaPostagem(idPrePostagem, nomeBase || idPrePostagem);
  if (!arquivos.length) throw erroHttp(502, errosPdf.join(" | "));
  return { arquivos, errosPdf };
};

// Diagnóstico para a tela (nada de senha): login, contrato e remetente.
export const statusApiCorreios = async () => {
  const variaveis = Object.fromEntries(
    ["CORREIOS_USUARIO", "CORREIOS_CODIGO_ACESSO", "CORREIOS_CARTAO_POSTAGEM", "CORREIOS_CONTRATO", "CORREIOS_REMETENTE_CEP", "CORREIOS_REMETENTE_NUMERO"].map((nome) => [nome, Boolean(env(nome))]),
  );
  if (!apiCorreiosConfigurada()) return { configurada: false, variaveis };
  try {
    const conta = await autenticar();
    let remetenteStatus;
    try {
      const r = await remetente();
      remetenteStatus = { ok: true, nome: r.nome, cep: r.endereco.cep, endereco: `${r.endereco.logradouro}, ${r.endereco.numero} - ${r.endereco.bairro}, ${r.endereco.cidade}/${r.endereco.uf}` };
    } catch (error) {
      remetenteStatus = { ok: false, erro: error.message };
    }
    return {
      configurada: true,
      login: true,
      ambiente: conta.ambiente,
      contrato: conta.contrato,
      cartao: conta.cartao,
      dr: conta.dr,
      apisLiberadas: conta.apis,
      servicos: servicosConfigurados(),
      remetente: remetenteStatus,
      variaveis,
    };
  } catch (error) {
    return { configurada: true, login: false, erro: error.message, variaveis };
  }
};
