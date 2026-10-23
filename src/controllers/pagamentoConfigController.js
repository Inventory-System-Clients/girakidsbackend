import { CredencialPagamento, LogAtividade } from "../models/index.js";
import { PROVEDORES, canalAutomatico, provedorAtivo, provedorMaquininha } from "../services/pagamentos/index.js";
import {
  carregarConfigPagamentos,
  configPagamentos,
  credenciaisDe,
  novoIdMaquininha,
  salvarCanais,
  salvarMaquininhas,
  urlBackend,
} from "../services/pagamentos/config.js";
import { cifrarCredenciais, mascarar, usaChavePropria } from "../utils/cofreCredenciais.js";
import { erroHttp, responderErro } from "../utils/helpers.js";

// Aba Pagamentos (só ADMIN): escolhe o banco de cada canal, guarda as
// credenciais cifradas e cadastra as maquininhas. Nenhuma rota devolve o
// valor de uma credencial — só máscara e se está preenchida.

export const soAdmin = (req, res, next) =>
  req.usuario?.role === "ADMIN" ? next() : res.status(403).json({ error: "Só o administrador acessa os pagamentos." });

// Log sem os valores: só o que mudou.
const registrar = (req, acao, detalhes) =>
  LogAtividade.create({
    usuarioId: req.usuario?.id,
    acao,
    entidade: "Pagamentos",
    detalhes,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  }).catch((e) => console.error("Erro ao registrar log:", e));

const visao = async () => {
  const { canais, maquininhas } = configPagamentos();
  const linhas = await CredencialPagamento.findAll();
  const porProvedor = new Map(linhas.map((l) => [l.provedor, l]));
  return {
    canais,
    // Banco que está cobrando de fato em cada canal (inclui o automático).
    emUso: {
      online: provedorAtivo()?.nome || null,
      maquininha: provedorMaquininha()?.nome || null,
      onlineAutomatico: canalAutomatico("online"),
      maquininhaAutomatico: canalAutomatico("maquininha"),
    },
    chavePropria: usaChavePropria(),
    provedores: Object.values(PROVEDORES).map((p) => {
      const linha = porProvedor.get(p.nome);
      return {
        nome: p.nome,
        rotulo: p.rotulo,
        canais: p.canais,
        metodos: p.metodos,
        campos: p.campos.map(({ chave, rotulo, secreto, obrigatorio, dica, opcoes }) => ({ chave, rotulo, secreto: Boolean(secreto), obrigatorio: Boolean(obrigatorio), dica, opcoes })),
        configurado: p.configurado(),
        resumo: linha?.resumo || {},
        validadoEm: linha?.validadoEm || null,
        atualizadoPor: linha?.atualizadoPor || null,
        atualizadoEm: linha?.updatedAt || null,
        webhookUrl: p.webhookUrl ? p.webhookUrl() : p.webhook ? `${urlBackend()}/api/pagamentos/webhook/${p.nome}` : null,
        ajudaWebhook: p.ajudaWebhook || null,
        ajudaMaquininha: p.ajudaMaquininha,
      };
    }),
    maquininhas,
  };
};

export const obter = async (req, res) => {
  try {
    res.json(await visao());
  } catch (error) {
    responderErro(res, error, "Erro ao carregar pagamentos");
  }
};

// Salva credenciais: campos em branco mantêm o valor atual; "limpar" apaga.
export const salvarCredenciais = async (req, res) => {
  try {
    const provedor = PROVEDORES[req.params.provedor];
    if (!provedor) throw erroHttp(404, "Banco desconhecido.");
    const valores = req.body?.valores || {};
    const limpar = Array.isArray(req.body?.limpar) ? req.body.limpar : [];
    const atuais = credenciaisDe(provedor.nome) || {};
    const novas = { ...atuais };
    const alterados = [];
    for (const campo of provedor.campos) {
      if (limpar.includes(campo.chave)) {
        delete novas[campo.chave];
        alterados.push(campo.chave);
        continue;
      }
      const valor = valores[campo.chave];
      if (valor === undefined || (campo.secreto && String(valor).trim() === "")) continue;
      const limpo = String(valor).trim().slice(0, 500);
      if (limpo !== (atuais[campo.chave] ?? "")) alterados.push(campo.chave);
      novas[campo.chave] = limpo;
    }
    const faltando = provedor.campos.filter((c) => c.obrigatorio && !novas[c.chave]);
    if (faltando.length) throw erroHttp(400, `Preencha: ${faltando.map((c) => c.rotulo).join(", ")}.`);

    // Testa no banco antes de salvar (chave errada não entra).
    const validacao = await provedor.validarCredenciais(novas);
    Object.assign(novas, validacao?.extras || {});

    const resumo = { conta: validacao?.conta || null };
    for (const campo of provedor.campos) {
      if (!novas[campo.chave]) continue;
      resumo[campo.chave] = campo.secreto ? mascarar(novas[campo.chave]) : novas[campo.chave];
    }
    await CredencialPagamento.upsert({
      provedor: provedor.nome,
      dadosCifrados: cifrarCredenciais(provedor.nome, novas),
      resumo,
      validadoEm: new Date(),
      atualizadoPor: req.usuario.nome,
    });
    await carregarConfigPagamentos();
    registrar(req, "CREDENCIAIS_PAGAMENTO", { provedor: provedor.nome, camposAlterados: alterados });
    res.json(await visao());
  } catch (error) {
    responderErro(res, error, "Erro ao salvar credenciais");
  }
};

export const removerCredenciais = async (req, res) => {
  try {
    const provedor = PROVEDORES[req.params.provedor];
    if (!provedor) throw erroHttp(404, "Banco desconhecido.");
    await CredencialPagamento.destroy({ where: { provedor: provedor.nome } });
    const { canais } = configPagamentos();
    const novosCanais = Object.fromEntries(Object.entries(canais).map(([k, v]) => [k, v === provedor.nome ? null : v]));
    await salvarCanais(novosCanais);
    await carregarConfigPagamentos();
    registrar(req, "REMOVER_CREDENCIAIS_PAGAMENTO", { provedor: provedor.nome });
    res.json(await visao());
  } catch (error) {
    responderErro(res, error, "Erro ao remover credenciais");
  }
};

export const salvarCanaisPagamento = async (req, res) => {
  try {
    const atuais = configPagamentos().canais;
    const novos = { ...atuais };
    for (const canal of ["online", "maquininha"]) {
      if (req.body?.[canal] === undefined) continue;
      const nome = req.body[canal] || null;
      if (nome && nome !== "desligado") {
        const provedor = PROVEDORES[nome];
        if (!provedor || !provedor.canais.includes(canal)) throw erroHttp(400, `Banco inválido para ${canal === "online" ? "o pagamento online" : "a maquininha"}.`);
        if (!provedor.configurado()) throw erroHttp(400, `Cadastre as credenciais do ${provedor.rotulo} antes de ativá-lo.`);
      }
      novos[canal] = nome;
    }
    await salvarCanais(novos);
    registrar(req, "CANAIS_PAGAMENTO", novos);
    res.json(await visao());
  } catch (error) {
    responderErro(res, error, "Erro ao salvar canais");
  }
};

// Maquininhas: { nome, provedor, identificador } (serial Stone, terminal_id
// do Point ou reader SumUp).
export const criarMaquininha = async (req, res) => {
  try {
    const { nome, provedor, identificador } = req.body || {};
    if (!String(nome || "").trim()) throw erroHttp(400, "Dê um nome para a maquininha.");
    if (!PROVEDORES[provedor]?.canais.includes("maquininha")) throw erroHttp(400, "Banco inválido para maquininha.");
    if (!String(identificador || "").trim()) throw erroHttp(400, "Informe o identificador da maquininha.");
    const lista = [...configPagamentos().maquininhas, { id: novoIdMaquininha(), nome: String(nome).trim().slice(0, 80), provedor, identificador: String(identificador).trim().slice(0, 120), ativa: true }];
    await salvarMaquininhas(lista);
    registrar(req, "CRIAR_MAQUININHA", { nome, provedor });
    res.status(201).json(await visao());
  } catch (error) {
    responderErro(res, error, "Erro ao cadastrar maquininha");
  }
};

export const atualizarMaquininha = async (req, res) => {
  try {
    const lista = configPagamentos().maquininhas.map((m) =>
      m.id === req.params.id
        ? {
            ...m,
            ...(req.body?.nome !== undefined ? { nome: String(req.body.nome).trim().slice(0, 80) || m.nome } : {}),
            ...(req.body?.identificador !== undefined ? { identificador: String(req.body.identificador).trim().slice(0, 120) || m.identificador } : {}),
            ...(req.body?.ativa !== undefined ? { ativa: Boolean(req.body.ativa) } : {}),
          }
        : m,
    );
    await salvarMaquininhas(lista);
    res.json(await visao());
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar maquininha");
  }
};

export const removerMaquininha = async (req, res) => {
  try {
    await salvarMaquininhas(configPagamentos().maquininhas.filter((m) => m.id !== req.params.id));
    registrar(req, "REMOVER_MAQUININHA", { id: req.params.id });
    res.json(await visao());
  } catch (error) {
    responderErro(res, error, "Erro ao remover maquininha");
  }
};

// SumUp: maquininhas conectadas à conta e pareamento pelo código.
export const readersSumup = async (req, res) => {
  try {
    res.json(await PROVEDORES.sumup.listarReaders());
  } catch (error) {
    responderErro(res, error, "Erro ao listar maquininhas da SumUp");
  }
};

export const parearSumup = async (req, res) => {
  try {
    const nome = String(req.body?.nome || "").trim();
    if (!nome) throw erroHttp(400, "Dê um nome para a maquininha.");
    const reader = req.body?.readerId ? { id: String(req.body.readerId) } : await PROVEDORES.sumup.parearReader(req.body?.codigo, nome);
    await salvarMaquininhas([...configPagamentos().maquininhas, { id: novoIdMaquininha(), nome: nome.slice(0, 80), provedor: "sumup", identificador: reader.id, ativa: true }]);
    registrar(req, "PAREAR_MAQUININHA_SUMUP", { nome });
    res.status(201).json(await visao());
  } catch (error) {
    responderErro(res, error, "Erro ao parear maquininha");
  }
};

// Lista para a equipe escolher na hora de cobrar (sem nada sensível).
export const maquininhasAtivas = (req, res) => {
  const { maquininhas } = configPagamentos();
  const ativo = provedorMaquininha()?.nome;
  res.json(maquininhas.filter((m) => m.ativa !== false && m.provedor === ativo).map(({ id, nome, provedor }) => ({ id, nome, provedor })));
};
