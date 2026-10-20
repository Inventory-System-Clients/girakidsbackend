// Integração com o VIPP (VisualSet Pré-Postagem) — tela "Minhas Postagens →
// Criar Postagens (Digitação Direta)" (entradadados/frmEditarConhecimento.php).
//
// O VIPP é PHP com sessão (cookie PHPSESSID) e jQuery: reproduzimos as mesmas
// chamadas AJAX que a tela faz ao digitar o CEP (ListarServicosPPN.php) e ao
// clicar em "Gravar" (ManterDigitacaoPPN.php), e depois as de impressão em
// PDF (etiqueta Correios e declaração de conteúdo simples), que é o que a tela
// faz automaticamente com as opções padrão "PDF Etiqueta Correios" (201) e
// "PDF Declaração Simples" (404).
//
// Respostas do VIPP vêm em ISO-8859-1.

const BASE_URL = (
  process.env.VIPP_BASE_URL || "https://vipp-novo.visualset.com.br/vipp"
).replace(/\/$/, "");
const URL_FORMULARIO = `${BASE_URL}/entradadados/frmEditarConhecimento.php?ctoId=0`;

export const CONTEUDO_PADRAO = "BRINQUEDOS";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Configure ${name} no ambiente do backend`);
  }
  return value;
};

const decoderLatin1 = new TextDecoder("latin1");

const extrairCookies = (resposta) => {
  const valores =
    typeof resposta.headers.getSetCookie === "function"
      ? resposta.headers.getSetCookie()
      : [resposta.headers.get("set-cookie")].filter(Boolean);
  return valores.map((cookie) => cookie.split(";")[0]);
};

const juntarCookies = (atual, novos) => {
  const mapa = new Map(
    atual
      .split(/;\s*/)
      .filter(Boolean)
      .map((item) => [item.split("=")[0], item]),
  );
  novos.forEach((item) => mapa.set(item.split("=")[0], item));
  return [...mapa.values()].join("; ");
};

// Serializa igual ao jQuery.param (inclusive arrays de objetos:
// DadosConteudo[0][ObjDsc]=...), que é o formato que o PHP do VIPP espera.
const paramJquery = (dados) => {
  const pares = [];
  const adicionar = (chave, valor) => {
    if (Array.isArray(valor)) {
      valor.forEach((item, indice) =>
        adicionar(
          `${chave}[${typeof item === "object" && item !== null ? indice : ""}]`,
          item,
        ),
      );
      return;
    }
    if (valor !== null && typeof valor === "object") {
      Object.entries(valor).forEach(([sub, v]) => adicionar(`${chave}[${sub}]`, v));
      return;
    }
    pares.push(
      `${encodeURIComponent(chave)}=${encodeURIComponent(valor == null ? "" : String(valor))}`,
    );
  };
  Object.entries(dados).forEach(([chave, valor]) => adicionar(chave, valor));
  return pares.join("&").replace(/%20/g, "+");
};

const criarSessao = () => {
  let cookies = "";

  const requisitar = async (url, { method = "GET", corpo, ajax = false } = {}) => {
    const resposta = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        Cookie: cookies,
        Referer: URL_FORMULARIO,
        ...(ajax ? { "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*" } : {}),
        ...(corpo
          ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
          : {}),
      },
      body: corpo,
    });
    cookies = juntarCookies(cookies, extrairCookies(resposta));
    return resposta;
  };

  const texto = async (resposta) =>
    decoderLatin1.decode(new Uint8Array(await resposta.arrayBuffer()));

  const json = async (url, dados) => {
    const resposta = await requisitar(url, {
      method: "POST",
      corpo: paramJquery(dados),
      ajax: true,
    });
    const corpo = await texto(resposta);
    if (resposta.status >= 300 && resposta.status < 400) {
      throw new Error("Sessão do VIPP expirou. Tente novamente.");
    }
    try {
      return JSON.parse(corpo);
    } catch {
      throw new Error(
        `Resposta inesperada do VIPP (${resposta.status}): ${corpo.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`,
      );
    }
  };

  return { requisitar, texto, json };
};

const atributo = (html, regex) => html.match(regex)?.[1]?.trim() || "";

// Faz login e lê da tela de digitação os dados fixos da conta: contrato,
// cartão, remetente, agência postadora e se o contrato é PPN.
const abrirSessaoVipp = async () => {
  const sessao = criarSessao();

  await sessao.requisitar(`${BASE_URL}/inicio/index.php`);
  const corpoLogin = new URLSearchParams({
    txtUsr: required("VIPP_USUARIO"),
    txtPwd: required("VIPP_SENHA"),
  }).toString();
  const respostaLogin = await sessao.requisitar(`${BASE_URL}/inicio/index.php`, {
    method: "POST",
    corpo: corpoLogin,
  });
  const destino = respostaLogin.headers.get("location") || "";
  if (!/login\/index\.php/i.test(destino)) {
    throw new Error("Login no VIPP recusado. Confira usuário e senha.");
  }
  await sessao.requisitar(new URL(destino, `${BASE_URL}/inicio/`).toString());

  const respostaFormulario = await sessao.requisitar(URL_FORMULARIO);
  const html = await sessao.texto(respostaFormulario);
  if (!html.includes("frmEditarConhecimento")) {
    throw new Error("Não foi possível abrir a tela de digitação do VIPP.");
  }

  const tagContrato = atributo(html, /(<[^>]*id="cmbContratos"[^>]*>)/);
  const idRemetente =
    atributo(html, /id="IdRemetente"[^>]*value="(\d+)"/) ||
    atributo(html, /<option[^>]*value="(\d+)"[^>]*selected[^>]*>[^<]*GIRA KIDS/);
  const optionRemetente = atributo(
    html,
    new RegExp(`(<option[^>]*value="${idRemetente}"[^>]*>)`),
  );

  const contexto = {
    nroContrato: atributo(tagContrato, /data-nroctt="([^"]*)"/),
    nroCartao: atributo(tagContrato, /data-nrocar="([^"]*)"/),
    contratoPpn: atributo(tagContrato, /data-stsppn="([^"]*)"/) || "0",
    idPostadora: atributo(html, /id="IdPostadora"[^>]*value="(\d+)"/),
    idRemetente,
    documentoRemetente: atributo(optionRemetente, /data-nrodct="([^"]*)"/),
    prazoPpn: atributo(html, /id="txtPrazoPPN"[^>]*value="(\d+)"/) || "15",
    liberarDigitacao:
      atributo(html, /id="chkLiberarDigitacao"[^>]*value="([^"]*)"/) || "0",
  };

  if (!contexto.nroContrato || !contexto.nroCartao || !contexto.idRemetente) {
    throw new Error("Não foi possível ler o contrato/remetente da conta VIPP.");
  }

  const postadoras = await sessao.json(
    `${BASE_URL}/entradadados/FrmDigitacaoDireta/ListarPostadoras.php`,
    { idxpos: contexto.idPostadora, idxrem: contexto.idRemetente },
  );
  const postadora =
    postadoras.rows?.find((row) => row.SelPos) || postadoras.rows?.[0];
  if (postadoras.erro !== "OK" || !postadora) {
    throw new Error("Não foi possível carregar a agência postadora no VIPP.");
  }
  contexto.idPostadora = String(postadora.IdxPos).trim();
  contexto.cepPostadora = postadora.CepPos;
  contexto.nomePostadora = postadora.FanPos;

  return { sessao, contexto };
};

const listarServicos = async ({ sessao, contexto }, carga) => {
  const dados = await sessao.json(
    `${BASE_URL}/entradadados/digitacao/ListarServicosPPN.php`,
    {
      idxctt: contexto.nroContrato,
      idxcar: contexto.nroCartao,
      CEPOrigem: contexto.cepPostadora,
      CEPDestino: carga.cep,
      PesoBruto: carga.pesoGramas,
      Largura: carga.largura,
      Altura: carga.altura,
      Profundidade: carga.comprimento,
      ValorDeclarado: "",
      ValorACobrar: "",
      Adicionais:
        Number(carga.altura) > 70 ||
        Number(carga.largura) > 70 ||
        Number(carga.comprimento) > 70
          ? ",OF"
          : "",
      TipoOdernacao: 1,
      Tarifar: 1,
      StArDigital: 0,
      SrvObrPpn: 0,
      CttObrPpn: contexto.contratoPpn,
      cmbEmbalagem: "",
    },
  );

  if (dados.erro !== "OK") {
    throw new Error(`VIPP: ${dados.erro}`);
  }

  return (dados.rows || []).map((row) => ({
    id: String(row.IdxSer),
    nome: String(row.DscSer || "").trim(),
    disponivel: row.Tarifa?.Processado === 1,
    valor: Number(row.Tarifa?.ValorTarifaSemAdicionais || 0) +
      Number(row.Tarifa?.ValorAdicionais || 0),
    prazoDias: Number(row.Tarifa?.Prazo || 0),
    erro: row.Tarifa?.Processado === 1 ? "" : String(row.Tarifa?.MsgErroTarifacao || "").trim(),
    bruto: row,
  }));
};

const somenteCep = (cep) => String(cep || "").replace(/\D/g, "");
const formatarCep = (cep) => {
  const digitos = somenteCep(cep);
  return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : digitos;
};

const formatarDocumento = (documento) => {
  const d = String(documento || "").replace(/\D/g, "");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) {
    return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  }
  return d;
};

const formatarTelefone = (telefone) => {
  const d = String(telefone || "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  return "";
};

// Remove acentos, como o RemoveAcentosLocal da própria tela do VIPP.
const semAcento = (texto, limite) =>
  String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limite);

const validarCarga = (carga) => {
  const cep = somenteCep(carga.cep);
  const peso = Math.round(Number(carga.pesoGramas));
  const dimensoes = ["altura", "largura", "comprimento"].map((campo) =>
    Math.round(Number(carga[campo])),
  );

  if (cep.length !== 8) throw new Error("CEP de destino inválido.");
  if (!Number.isFinite(peso) || peso < 1 || peso > 30000) {
    throw new Error("Peso deve estar entre 1 g e 30 kg.");
  }
  if (dimensoes.some((valor) => !Number.isFinite(valor) || valor < 1)) {
    throw new Error("Informe altura, largura e comprimento em cm.");
  }

  return {
    cep: formatarCep(cep),
    pesoGramas: peso,
    altura: dimensoes[0],
    largura: dimensoes[1],
    comprimento: dimensoes[2],
  };
};

export const cotarServicosVipp = async (carga) => {
  const cargaValida = validarCarga(carga);
  const vipp = await abrirSessaoVipp();
  const servicos = await listarServicos(vipp, cargaValida);
  return {
    postadora: vipp.contexto.nomePostadora,
    servicos: servicos.map(({ bruto, ...servico }) => servico),
  };
};

const gerarPdf = async ({ sessao }, idConhecimento, tipo) => {
  const endpoint =
    tipo === "etiqueta"
      ? { url: "FrmDigitacaoDireta/SemZvp/ImpEtqCor.php", tiprel: 107 }
      : { url: "FrmDigitacaoDireta/SemZvp/ImpDeclaracaoPdf.php", tiprel: 1 };

  const resposta = await sessao.json(`${BASE_URL}/entradadados/${endpoint.url}`, {
    idx: idConhecimento,
    tiprel: endpoint.tiprel,
  });
  const arquivo = String(resposta.Msg || "").trim();
  if (String(resposta.Sts).trim() !== "1" || !arquivo) {
    throw new Error(
      `VIPP não gerou o PDF de ${tipo === "etiqueta" ? "etiqueta" : "declaração"}: ${arquivo || "sem resposta"}`,
    );
  }

  const download = await sessao.requisitar(
    `${BASE_URL}/relatoriopersonalizado/Download.php?Arquivo=${encodeURIComponent(arquivo)}`,
  );
  const conteudo = Buffer.from(await download.arrayBuffer());
  if (!download.ok || conteudo.subarray(0, 4).toString() !== "%PDF") {
    throw new Error(`Download do PDF de ${tipo} falhou no VIPP.`);
  }

  return { arquivo, conteudo };
};

// Grava a postagem (equivalente ao botão "Gravar") e baixa a etiqueta e a
// declaração de conteúdo em PDF.
export const criarPostagemVipp = async ({
  destinatario,
  carga,
  servicoId,
  observacao,
}) => {
  const cargaValida = validarCarga({ ...carga, cep: destinatario.cep });
  const obrigatorios = {
    nome: "nome do destinatário",
    logradouro: "logradouro",
    numero: "número",
    bairro: "bairro",
    cidade: "cidade",
    uf: "UF",
  };
  for (const [campo, rotulo] of Object.entries(obrigatorios)) {
    if (!String(destinatario[campo] || "").trim()) {
      throw new Error(`Preencha o ${rotulo}.`);
    }
  }

  const vipp = await abrirSessaoVipp();
  const { sessao, contexto } = vipp;

  const servicos = await listarServicos(vipp, cargaValida);
  const servico = servicos.find((item) => item.id === String(servicoId));
  if (!servico) {
    throw new Error("Serviço escolhido não está disponível para este envio.");
  }
  if (!servico.disponivel) {
    throw new Error(`Serviço ${servico.nome} indisponível: ${servico.erro}`);
  }

  const bruto = servico.bruto;
  const nivelContrato =
    String(bruto.StIndustrial) === "1" && Number(bruto.NivCtt2) > 0
      ? bruto.NivCtt2
      : bruto.NivCtt;
  const documentoDestinatario = formatarDocumento(destinatario.documento);

  const dados = {
    IdConhecimento: "",
    IdStatusConhecimento: "",
    EtiquetaSigep: "",
    NrContrato: contexto.nroContrato,
    NrCartao: contexto.nroCartao,
    IdServico: servico.id,
    // Contrato PPN: a etiqueta vem dos Correios na gravação.
    RegistroECT: "",
    IdRemetente: contexto.idRemetente,
    IdUnidadePostadora: contexto.idPostadora,
    CEPUnidadePostadora: contexto.cepPostadora,
    NomeDestinatario: semAcento(destinatario.nome, 50),
    CEPDestinatario: cargaValida.cep,
    AosCuidados: "",
    DocumentoDestinatario: documentoDestinatario,
    DocumentoDestinatarioVal: documentoDestinatario,
    EnderecoDestinatario: semAcento(destinatario.logradouro, 50),
    SegundoEnderecoDestinatario: "",
    NumeroDestinatario: semAcento(destinatario.numero, 10),
    BairroDestinatario: semAcento(destinatario.bairro, 50),
    ComplementoDestinatario: semAcento(destinatario.complemento, 30),
    CidadeDestinatario: semAcento(destinatario.cidade, 50),
    UFDestinatario: String(destinatario.uf || "").toUpperCase().slice(0, 2),
    TelefoneDestinatario: "",
    CelularDestinatario: formatarTelefone(destinatario.telefone),
    RFID: "",
    EmailDestinatario: String(destinatario.email || "").trim().slice(0, 60),
    ValorDeclarado: "",
    ValorACobrar: "",
    Adicionais: String(bruto.AdcPacote || "").trim().toUpperCase(),
    PesoReal: cargaValida.pesoGramas,
    IdTipoEmbalagem: "",
    Altura: cargaValida.altura,
    Largura: cargaValida.largura,
    Comprimento: cargaValida.comprimento,
    ProtocoloNotaFiscal: "",
    ObservacaoNotaFiscal: "",
    DtNotaFiscal: "",
    SerieNota: "",
    NumeroNota: "",
    ValorNota: "",
    ObservacaoUm: semAcento(observacao, 50),
    ObservacaoDois: "",
    ObservacaoTres: "",
    ObservacaoQuatro: "",
    ObservacaoCinco: "",
    Conteudo: CONTEUDO_PADRAO,
    QtdVolumes: 1,
    LiberarAutomatico: contexto.liberarDigitacao,
    SalvarDestinatario: false,
    ConteudoDocRem: formatarDocumento(contexto.documentoRemetente),
    ConteudoDocDes: documentoDestinatario,
    ConteudoTotalPeso: "",
    ConteudoTotalQtde: "",
    ConteudoTotalVlrx: "",
    NivelContrato: nivelContrato ?? "",
    // Mesmo item que a tela monta quando a declaração detalhada fica vazia
    // e "Descrição padrão" = BRINQUEDOS.
    DadosConteudo: [
      { ObjItem: "1", ObjDsc: CONTEUDO_PADRAO, ObjQtd: "1", ObjVlr: "1.00" },
    ],
    txtIdARDigital: "",
    StsCttPpn: contexto.contratoPpn,
    StsSrvPpn: String(bruto.StObrigatorioPPN ?? ""),
    txtDescricaoPadrao: CONTEUDO_PADRAO,
    chkCriarDCEPadrao: "S",
    txtPrazoPPN: Number(contexto.prazoPpn),
  };

  const resposta = await sessao.json(
    `${BASE_URL}/entradadados/digitacao/ManterDigitacaoPPN.php`,
    dados,
  );
  const status = Number(String(resposta.Status ?? "").trim() || 0);
  const mensagem = String(resposta.Msg || "").replace(/<[^>]+>/g, " ").trim();
  if (status !== 1 || !resposta.IdConhecimento) {
    throw new Error(`VIPP não gravou a postagem: ${mensagem || `status ${status}`}`);
  }

  const idConhecimento = String(resposta.IdConhecimento).trim();
  const etiqueta = String(resposta.Etiqueta || "").trim();

  // A postagem já está gravada; se um PDF falhar, devolvemos o que deu certo
  // e o erro, pra não gravar de novo (geraria postagem duplicada).
  const arquivos = [];
  const errosPdf = [];
  for (const tipo of ["etiqueta", "declaracao"]) {
    try {
      const pdf = await gerarPdf(vipp, idConhecimento, tipo);
      arquivos.push({
        tipo,
        nome: `${tipo === "etiqueta" ? "etiqueta" : "declaracao-conteudo"}-${etiqueta || idConhecimento}.pdf`,
        base64: pdf.conteudo.toString("base64"),
      });
    } catch (erro) {
      errosPdf.push(erro.message);
    }
  }

  return {
    idConhecimento,
    etiqueta,
    servico: { id: servico.id, nome: servico.nome, valor: servico.valor, prazoDias: servico.prazoDias },
    arquivos,
    errosPdf,
  };
};

export const baixarPdfsPostagemVipp = async (idConhecimento) => {
  const vipp = await abrirSessaoVipp();
  const arquivos = [];
  for (const tipo of ["etiqueta", "declaracao"]) {
    const pdf = await gerarPdf(vipp, idConhecimento, tipo);
    arquivos.push({
      tipo,
      nome: `${tipo === "etiqueta" ? "etiqueta" : "declaracao-conteudo"}-${idConhecimento}.pdf`,
      base64: pdf.conteudo.toString("base64"),
    });
  }
  return { arquivos };
};
