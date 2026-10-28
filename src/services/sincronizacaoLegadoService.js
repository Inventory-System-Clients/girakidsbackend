import crypto from "crypto";
import { createRequire } from "module";
import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";
import { preencherUsuariosPeloPedido } from "../database/migrate.js";
import { Categoria, Parceiro, Pedido, PedidoItem, PedidoParcela, Produto, Usuario } from "../models/index.js";
import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";
import { cifrarCredenciais, decifrarCredenciais } from "../utils/cofreCredenciais.js";
import { erroHttp } from "../utils/helpers.js";
import { criarCliente } from "./legado/krionApi.js";
import {
  andamentoPedido,
  assinaturaPedido,
  data,
  dadosParceiro,
  dadosPedido,
  dadosProduto,
  dadosUsuario,
  emailValido,
  estoqueLegado,
  itensPedido,
  numeroLegado,
  parcelaPaga,
  situacaoPedido,
} from "./legado/mapeamento.js";
import { devolverEstoquePedido, movimentar } from "./estoqueService.js";
import { NUMERO_COLISAO_LEGADO } from "./pedidoService.js";
import { avisarPedido } from "./whatsappService.js";

// Sincronização contínua com a loja antiga (Krion/Firebase), só de lá para
// cá, enquanto as duas convivem:
//   - pedidos e orçamentos novos de lá entram aqui (mesmo número; se o número
//     já existir aqui, o de lá aparece como "63127-ANT");
//   - o andamento dos pedidos de lá (pagamento, liberação, expedição, nota,
//     cancelamento) é copiado, só para a frente — nunca desfaz o que foi
//     feito aqui;
//   - estoque: a DIFERENÇA entre uma leitura e outra (vendas e ajustes feitos
//     lá) é aplicada aqui, sem sobrescrever o que foi movimentado no novo;
//   - produtos, clientes e parceiros criados lá entram aqui. Nome, imagens,
//     descrição e preço de produtos que já existem aqui não são tocados.
//
// Registros de antes da importação inicial (20/10/2026) que não existem aqui
// foram apagados aqui de propósito e não voltam.

const CHAVE_CONFIG = "sincronizacaoLegado";
const CHAVE_STATUS = "sincronizacaoLegadoStatus";
const CHAVE_LEASE = "sincronizacaoLegadoLease";
const PROVEDOR_COFRE = "legado-krion";
const CORTE = new Date("2026-10-20T00:00:00.000Z");
// Estoque de cada produto lá no momento da importação inicial (base das diferenças).
const ESTOQUE_BASE = createRequire(import.meta.url)("./legado/estoqueBase.json");
const INTERVALO_PADRAO = 60;
const INTERVALO_MINIMO = 30;
const HISTORICO_MAX = 30;
const DIA = 24 * 60 * 60 * 1000;
const RANK_VENDAS = { AGUARDANDO: 0, LIBERADO: 1 };
const RANK_FINANCEIRO = { AGUARDANDO_PAGAMENTO: 0, PAGO: 1 };
const RANK_EXPEDICAO = { NAO_INICIADO: 0, MONTAGEM: 1, EXPEDIDO: 2 };
const INSTANCIA = crypto.randomUUID();

// ---------------------------------------------------------------------------
// Configuração (senha do sistema antigo criptografada no cofre)
// ---------------------------------------------------------------------------

const lerConfig = async () => {
  const salvo = (await lerConfiguracao(CHAVE_CONFIG)) || {};
  let senha = null;
  if (salvo.senhaCifrada) {
    try {
      senha = decifrarCredenciais(PROVEDOR_COFRE, salvo.senhaCifrada).senha;
    } catch {
      senha = null;
    }
  }
  return {
    ativo: Boolean(salvo.ativo),
    email: salvo.email || null,
    senha,
    senhaCifrada: salvo.senhaCifrada || null,
    intervaloSegundos: Math.max(INTERVALO_MINIMO, Number(salvo.intervaloSegundos) || INTERVALO_PADRAO),
    baseRealizada: Boolean(salvo.baseRealizada),
    atualizadoPor: salvo.atualizadoPor || null,
    atualizadoEm: salvo.atualizadoEm || null,
  };
};

const gravarConfig = async (config) => {
  const { senha: _senha, ...resto } = config;
  await salvarConfiguracao(CHAVE_CONFIG, resto);
};

const lerStatus = async () => (await lerConfiguracao(CHAVE_STATUS)) || { historico: [] };

// Para a tela do admin: a senha nunca volta.
export const obterStatus = async () => {
  const c = await lerConfig();
  const status = await lerStatus();
  const [pedidosLegado, ultimosPedidos] = await Promise.all([
    Pedido.count({ where: { legadoId: { [Op.ne]: null }, tipo: "PEDIDO" } }),
    Pedido.findAll({
      where: { legadoId: { [Op.ne]: null }, tipo: "PEDIDO", createdAt: { [Op.gte]: CORTE } },
      attributes: ["id", "numero", "codigoLegado", "clienteNome", "total", "createdAt", "statusVendas", "statusFinanceiro", "statusExpedicao"],
      order: [["createdAt", "DESC"]],
      limit: 15,
    }),
  ]);
  return {
    config: {
      ativo: c.ativo,
      email: c.email,
      senhaConfigurada: Boolean(c.senha),
      intervaloSegundos: c.intervaloSegundos,
      baseRealizada: c.baseRealizada,
      atualizadoPor: c.atualizadoPor,
      atualizadoEm: c.atualizadoEm,
    },
    executando: Boolean(rodando),
    proximaEm: proximaEm ? new Date(proximaEm).toISOString() : null,
    ultima: status.ultima || null,
    historico: status.historico || [],
    pedidosLegado,
    ultimosPedidos,
  };
};

export const salvarConfig = async (payload = {}, usuarioNome) => {
  const atual = await lerConfig();
  const novo = { ...atual };
  if (payload.email !== undefined) {
    const email = String(payload.email || "").trim().toLowerCase();
    if (email && !emailValido(email)) throw erroHttp(400, "E-mail do sistema antigo inválido.");
    novo.email = email || null;
  }
  if (String(payload.senha || "").trim()) {
    novo.senha = String(payload.senha);
    novo.senhaCifrada = cifrarCredenciais(PROVEDOR_COFRE, { senha: novo.senha });
  }
  if (payload.intervaloSegundos !== undefined) {
    const s = Math.round(Number(payload.intervaloSegundos));
    if (!Number.isFinite(s) || s < INTERVALO_MINIMO || s > 3600) throw erroHttp(400, `Intervalo entre ${INTERVALO_MINIMO} s e 1 hora.`);
    novo.intervaloSegundos = s;
  }
  if (payload.ativo !== undefined) novo.ativo = Boolean(payload.ativo);
  if (novo.ativo && (!novo.email || !novo.senha)) throw erroHttp(400, "Informe o e-mail e a senha de um administrador do sistema antigo.");

  // Credencial nova: testa o login antes de guardar.
  if ((payload.email !== undefined && novo.email !== atual.email) || String(payload.senha || "").trim()) {
    if (novo.email && novo.senha) {
      try {
        await criarCliente({ email: novo.email, senha: novo.senha }).entrar();
      } catch (error) {
        throw erroHttp(400, error.message);
      }
    }
    cliente = null;
  }

  await gravarConfig({ ...novo, atualizadoPor: usuarioNome || null, atualizadoEm: new Date().toISOString() });
  agendar(novo.ativo ? 2000 : null);
  return (await obterStatus()).config;
};

// ---------------------------------------------------------------------------
// Trava entre instâncias (deploy novo subindo com o antigo ainda no ar)
// ---------------------------------------------------------------------------

const pegarTrava = async (minutos) => {
  const [linhas] = await sequelize.query(
    `INSERT INTO configuracoes (chave, valor, "createdAt", "updatedAt")
     VALUES (:chave, CAST(:valor AS jsonb), now(), now())
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, "updatedAt" = now()
     WHERE (configuracoes.valor->>'ate')::timestamptz < now() OR configuracoes.valor->>'dono' = :dono
     RETURNING chave`,
    {
      replacements: {
        chave: CHAVE_LEASE,
        dono: INSTANCIA,
        valor: JSON.stringify({ dono: INSTANCIA, ate: new Date(Date.now() + minutos * 60 * 1000).toISOString() }),
      },
    },
  );
  return linhas.length > 0;
};

const soltarTrava = () =>
  sequelize
    .query(`UPDATE configuracoes SET valor = jsonb_set(valor, '{ate}', to_jsonb(now()::text)) WHERE chave = :chave AND valor->>'dono' = :dono`, {
      replacements: { chave: CHAVE_LEASE, dono: INSTANCIA },
    })
    .catch(() => {});

// ---------------------------------------------------------------------------
// Partes da sincronização
// ---------------------------------------------------------------------------

const criadoDepoisDoCorte = (valor) => {
  const d = data(valor);
  return Boolean(d && !Number.isNaN(d.getTime()) && d >= CORTE);
};

const sincronizarParceiros = async (api, resumo) => {
  const lista = [
    ...(await api.fornecedores()).map((p) => ({ ...p, tipo: "FORNECEDOR" })),
    ...(await api.transportadoras()).map((p) => ({ ...p, tipo: "TRANSPORTADORA" })),
  ];
  const existentes = new Set((await Parceiro.findAll({ where: { legadoId: { [Op.ne]: null } }, attributes: ["legadoId"] })).map((p) => p.legadoId));
  for (const p of lista) {
    if (existentes.has(p.id) || !criadoDepoisDoCorte(p.createdAt)) continue;
    await Parceiro.create(dadosParceiro(p, p.tipo));
    existentes.add(p.id);
    resumo.parceirosNovos += 1;
  }
};

const sincronizarUsuarios = async (api, resumo) => {
  const locais = await Usuario.findAll({ attributes: ["id", "email", "legadoId"] });
  const porEmail = new Map(locais.map((u) => [String(u.email).toLowerCase(), u]));
  for (const u of await api.usuarios()) {
    const dados = dadosUsuario(u);
    if (!dados.email || !emailValido(dados.email)) continue;
    const local = porEmail.get(dados.email);
    if (local) {
      // Já existe aqui (cadastrado aqui ou importado): só guarda o vínculo.
      if (!local.legadoId) await local.update({ legadoId: u.id });
      continue;
    }
    if (!criadoDepoisDoCorte(u.created_at)) continue;
    const novo = await Usuario.create(dados);
    porEmail.set(dados.email, novo);
    resumo.usuariosNovos += 1;
  }
};

// Cria os produtos novos de lá e aplica aqui a diferença de estoque.
const sincronizarProdutos = async (lista, resumo) => {
  const locais = new Map(
    (await Produto.findAll({ where: { legadoId: { [Op.ne]: null } }, attributes: ["id", "legadoId", "legadoEstoque"] })).map((p) => [p.legadoId, p]),
  );
  const parceiroPorLegado = new Map(
    (await Parceiro.findAll({ where: { legadoId: { [Op.ne]: null } }, attributes: ["id", "legadoId"] })).map((p) => [p.legadoId, p.id]),
  );

  for (const p of lista) {
    const atual = estoqueLegado(p);
    const local = locais.get(p.id);
    if (!local) {
      if (p.excluded || !criadoDepoisDoCorte(p.created_date)) continue;
      if (p.item_category) await Categoria.findOrCreate({ where: { nome: p.item_category }, defaults: { nome: p.item_category } });
      const novo = await Produto.create({ ...dadosProduto(p, parceiroPorLegado), legadoEstoque: atual });
      locais.set(p.id, novo);
      resumo.produtosNovos += 1;
      continue;
    }

    const anterior = local.legadoEstoque ?? ESTOQUE_BASE[p.id];
    if (anterior == null || anterior === atual) {
      if (local.legadoEstoque == null) await Produto.update({ legadoEstoque: atual }, { where: { id: local.id, legadoEstoque: null } });
      continue;
    }

    await sequelize.transaction(async (transaction) => {
      const produto = await Produto.findByPk(local.id, { transaction, lock: transaction.LOCK.UPDATE });
      // Outra leitura já aplicou esta diferença.
      if ((produto.legadoEstoque ?? ESTOQUE_BASE[p.id]) !== anterior) return;
      const delta = atual - anterior;
      if (produto.tipo !== "COMPOSTO") {
        await movimentar({
          produto,
          delta,
          tipo: delta > 0 ? "ENTRADA" : "SAIDA",
          motivo: `Sistema antigo: estoque lá foi de ${anterior} para ${atual}`,
          transaction,
          origem: "SISTEMA_ANTIGO",
        });
      }
      await produto.update({ legadoEstoque: atual }, { transaction });
      resumo.estoqueAjustado.push({ nome: produto.nome, delta });
    });
  }
};

// Número livre na faixa de colisão (pedido de lá cujo número já existe aqui).
const numeroLivre = async (tipo, base, transaction) => {
  let numero = NUMERO_COLISAO_LEGADO + base;
  while (await Pedido.count({ where: { tipo, numero }, transaction })) numero += 1;
  return numero;
};

const criarPedido = async (o, tipo, ctx) =>
  sequelize.transaction(async (transaction) => {
    // Mesma trava da numeração dos pedidos novos daqui.
    await sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:chave))", { replacements: { chave: `pedido_numero_${tipo}` }, transaction });
    if (await Pedido.count({ where: { tipo, legadoId: String(o.id) }, transaction })) return null;

    let numero = numeroLegado(o);
    let codigoLegado = null;
    if (!numero) {
      codigoLegado = String(o.id).slice(0, 30);
      numero = await numeroLivre(tipo, 0, transaction);
    } else if (await Pedido.count({ where: { tipo, numero }, transaction })) {
      codigoLegado = `${tipo === "ORCAMENTO" ? String(numero).padStart(4, "0") : numero}-ANT`;
      numero = await numeroLivre(tipo, numero, transaction);
    }

    const email = String(o.customer_email || "").trim().toLowerCase();
    const cliente = email ? await Usuario.findOne({ where: { email }, attributes: ["id"], transaction }) : null;
    const transportadora = o.carrier_id ? await Parceiro.findOne({ where: { legadoId: o.carrier_id }, attributes: ["id"], transaction }) : null;
    const pedido = await Pedido.create(
      {
        ...dadosPedido(o, { tipo, numero, codigoLegado, clienteId: cliente?.id || null, transportadoraId: transportadora?.id || null }),
        legadoAssinatura: assinaturaPedido(o),
      },
      { transaction },
    );
    await PedidoItem.bulkCreate(itensPedido(o, pedido.id, ctx), { transaction });
    if (situacaoPedido(o).pago && Number(pedido.total) > 0) await PedidoParcela.create(parcelaPaga(o, pedido), { transaction });
    return pedido;
  });

// Copia o andamento de lá, só para a frente.
const atualizarPedido = async (local, o, { avisar }) => {
  const novo = andamentoPedido(o);
  const mudancas = { legadoAssinatura: assinaturaPedido(o) };
  let aviso = null;

  await sequelize.transaction(async (transaction) => {
    const pedido = await Pedido.findByPk(local.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!pedido) return;

    if (pedido.statusVendas !== "CANCELADO" && novo.statusVendas === "CANCELADO") {
      // Devolve só o que este pedido baixou aqui; o que foi baixado lá volta
      // pela diferença de estoque.
      await devolverEstoquePedido(pedido, null, transaction, `Devolução - pedido ${pedido.numero} cancelado no sistema antigo`);
      Object.assign(mudancas, {
        statusVendas: "CANCELADO",
        statusFinanceiro: "CANCELADO",
        estoqueBaixado: false,
        canceladoEm: novo.canceladoEm || new Date(),
        motivoCancelamento: pedido.motivoCancelamento || novo.motivoCancelamento || "Cancelado no sistema antigo",
      });
    } else if (pedido.statusVendas !== "CANCELADO") {
      if (RANK_FINANCEIRO[novo.statusFinanceiro] > (RANK_FINANCEIRO[pedido.statusFinanceiro] ?? 9)) {
        Object.assign(mudancas, { statusFinanceiro: novo.statusFinanceiro, pagoEm: novo.pagoEm || new Date(), pagoPor: novo.pagoPor || "Sistema antigo" });
        if (Number(pedido.total) > 0 && !(await PedidoParcela.count({ where: { pedidoId: pedido.id }, transaction }))) {
          await PedidoParcela.create(parcelaPaga(o, { ...pedido.get(), ...mudancas }), { transaction });
        }
      }
      if (novo.pendenciaStatus && novo.pendenciaStatus !== pedido.pendenciaStatus && !(pedido.pendenciaStatus === "QUITADA")) {
        for (const campo of ["pendenciaStatus", "pendenciaValor", "pendenciaAbertaEm", "pendenciaAbertaPor", "pendenciaQuitadaEm", "pendenciaQuitadaPor", "observacaoQuitacao"]) {
          mudancas[campo] = novo[campo];
        }
      }
      if (RANK_VENDAS[novo.statusVendas] > (RANK_VENDAS[pedido.statusVendas] ?? 9)) {
        Object.assign(mudancas, { statusVendas: novo.statusVendas, liberadoEm: novo.liberadoEm || new Date(), liberadoPor: novo.liberadoPor || "Sistema antigo" });
      }
      // Lá baixou o estoque (a diferença chega pelo produto): não baixa de novo aqui.
      if (novo.estoqueBaixado && !pedido.estoqueBaixado) mudancas.estoqueBaixado = true;
      if (RANK_EXPEDICAO[novo.statusExpedicao] > (RANK_EXPEDICAO[pedido.statusExpedicao] ?? 9)) {
        mudancas.statusExpedicao = novo.statusExpedicao;
        if (novo.statusExpedicao === "EXPEDIDO") {
          Object.assign(mudancas, {
            expedidoEm: novo.expedidoEm || new Date(),
            expedidoPor: novo.expedidoPor || "Sistema antigo",
            montagemConcluidaEm: pedido.montagemConcluidaEm || novo.montagemConcluidaEm || new Date(),
            montagemConcluidaPor: pedido.montagemConcluidaPor || novo.montagemConcluidaPor || "Sistema antigo",
          });
          await PedidoItem.update({ conferido: true }, { where: { pedidoId: pedido.id, conferido: false }, transaction });
          aviso = !pedido.metodoEnvio || pedido.metodoEnvio === "RETIRAR_LOCAL" ? "PRONTO" : "A_CAMINHO";
        }
      }
      // Preenche o que está vazio aqui.
      for (const campo of ["notaFiscalNumero", "notaFiscalUrl", "transportadoraNome", "transportadoraObs", "observacoesExpedicao", "imagemExpedicaoUrl"]) {
        if (!pedido[campo] && novo[campo]) mudancas[campo] = novo[campo];
      }
      if (!(pedido.imagensExpedicao || []).length && novo.imagensExpedicao.length) mudancas.imagensExpedicao = novo.imagensExpedicao;
      if (!pedido.transportadoraId && o.carrier_id) {
        const transportadora = await Parceiro.findOne({ where: { legadoId: o.carrier_id }, attributes: ["id"], transaction });
        if (transportadora) mudancas.transportadoraId = transportadora.id;
      }
    }
    await pedido.update(mudancas, { transaction });
  });

  if (aviso && avisar) avisarPedido(local.id, aviso);
  return Object.keys(mudancas).length > 1;
};

const sincronizarPedidos = async (lista, tipo, ctx, resumo, { avisar }) => {
  if (!lista.length) return;
  const locais = new Map(
    (
      await Pedido.findAll({
        where: { tipo, legadoId: lista.map((o) => String(o.id)) },
        attributes: ["id", "legadoId", "legadoAssinatura"],
      })
    ).map((p) => [p.legadoId, p]),
  );
  // Do mais antigo para o mais novo: a numeração segue a ordem de lá.
  const ordenados = [...lista].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const o of ordenados) {
    try {
      const local = locais.get(String(o.id));
      if (!local) {
        if (!criadoDepoisDoCorte(o.created_at)) continue;
        const pedido = await criarPedido(o, tipo, ctx);
        if (!pedido) continue;
        resumo[tipo === "PEDIDO" ? "pedidosNovos" : "orcamentosNovos"].push(pedido.codigoLegado || pedido.numero);
        // Aviso de "recebemos seu pedido" só para pedido recém-feito lá.
        if (tipo === "PEDIDO" && avisar && Date.now() - new Date(pedido.createdAt).getTime() < 2 * 60 * 60 * 1000) {
          avisarPedido(pedido.id, "CRIADO");
        }
        continue;
      }
      if (tipo === "PEDIDO" && local.legadoAssinatura !== assinaturaPedido(o)) {
        if (await atualizarPedido(local, o, { avisar })) resumo.pedidosAtualizados.push(numeroLegado(o) || o.id);
      }
    } catch (error) {
      resumo.erros.push(`${tipo === "PEDIDO" ? "Pedido" : "Orçamento"} ${o.order_sequence || o.id}: ${error.message}`);
    }
  }
};

// Orçamento de lá que virou pedido: liga os dois.
const ligarOrcamentos = async (pedidos) => {
  for (const o of pedidos.filter((x) => x.source_quote_id)) {
    const pedido = await Pedido.findOne({ where: { tipo: "PEDIDO", legadoId: String(o.id) }, attributes: ["id", "numero", "orcamentoOrigemId"] });
    if (!pedido || pedido.orcamentoOrigemId) continue;
    const orcamento = await Pedido.findOne({ where: { tipo: "ORCAMENTO", legadoId: String(o.source_quote_id) }, attributes: ["id", "numero"] });
    if (!orcamento) continue;
    await Pedido.update({ orcamentoOrigemId: orcamento.id, orcamentoOrigemNumero: orcamento.numero }, { where: { id: pedido.id } });
    await Pedido.update({ pedidoGeradoId: pedido.id, pedidoGeradoNumero: pedido.numero }, { where: { id: orcamento.id } });
  }
};

// ---------------------------------------------------------------------------
// Ciclo
// ---------------------------------------------------------------------------

let cliente = null;
let clienteChave = null;
let rodando = null;
let ciclos = 0;
let timer = null;
let proximaEm = null;

const clienteDe = (config) => {
  const chave = `${config.email}:${config.senhaCifrada}`;
  if (!cliente || clienteChave !== chave) {
    cliente = criarCliente({ email: config.email, senha: config.senha });
    clienteChave = chave;
  }
  return cliente;
};

const registrar = async (registro) => {
  const status = await lerStatus();
  const historico = [registro, ...(status.historico || [])].slice(0, HISTORICO_MAX);
  await salvarConfiguracao(CHAVE_STATUS, { ultima: registro, historico });
};

const executar = async ({ manual = false } = {}) => {
  const config = await lerConfig();
  if (!config.email || !config.senha) throw erroHttp(400, "Informe o e-mail e a senha de um administrador do sistema antigo.");
  if (!(await pegarTrava(10))) return { ignorado: "Outra instância do servidor está sincronizando agora." };

  const inicio = Date.now();
  const inicial = !config.baseRealizada;
  const completo = inicial || manual || ciclos % 10 === 0;
  ciclos += 1;
  const resumo = { pedidosNovos: [], orcamentosNovos: [], pedidosAtualizados: [], estoqueAjustado: [], produtosNovos: 0, usuariosNovos: 0, parceirosNovos: 0, erros: [] };
  try {
    const api = clienteDe(config);
    if (completo) {
      await sincronizarParceiros(api, resumo);
      await sincronizarUsuarios(api, resumo);
    }
    const produtos = await api.produtos();
    await sincronizarProdutos(produtos, resumo);

    const ctx = {
      legadoPorId: new Map(produtos.map((p) => [p.id, p])),
      produtoPorLegado: new Map(
        (await Produto.findAll({ where: { legadoId: { [Op.ne]: null } }, attributes: ["id", "legadoId"] })).map((p) => [p.legadoId, p.id]),
      ),
    };
    // Ciclo normal olha os últimos 3 dias; o completo, 30 (pedidos antigos
    // que andaram lá: pagos, expedidos, cancelados).
    const desde = completo ? Math.min(Date.now() - 30 * DIA, CORTE.getTime()) : Date.now() - 3 * DIA;
    const avisar = !inicial;
    if (completo || ciclos % 5 === 0) {
      await sincronizarPedidos(await api.orcamentos(desde), "ORCAMENTO", ctx, resumo, { avisar });
    }
    const pedidos = await api.pedidos(desde);
    await sincronizarPedidos(pedidos, "PEDIDO", ctx, resumo, { avisar });
    await ligarOrcamentos(pedidos);

    if (resumo.usuariosNovos || resumo.pedidosNovos.length) await preencherUsuariosPeloPedido();
    if (inicial) await gravarConfig({ ...(await lerConfig()), baseRealizada: true });

    const registro = {
      inicio: new Date(inicio).toISOString(),
      duracaoMs: Date.now() - inicio,
      ok: resumo.erros.length === 0,
      completo,
      inicial,
      manual,
      pedidosLidos: pedidos.length,
      produtosLidos: produtos.length,
      ...resumo,
      estoqueAjustado: resumo.estoqueAjustado.slice(0, 50),
      estoqueAjustadoTotal: resumo.estoqueAjustado.length,
      erros: resumo.erros.slice(0, 20),
    };
    // Ciclo sem novidade não ocupa o histórico.
    const novidade =
      inicial || manual || registro.erros.length || resumo.pedidosNovos.length || resumo.orcamentosNovos.length || resumo.pedidosAtualizados.length ||
      resumo.estoqueAjustado.length || resumo.produtosNovos || resumo.usuariosNovos || resumo.parceirosNovos;
    if (novidade) await registrar(registro);
    else await salvarConfiguracao(CHAVE_STATUS, { ...(await lerStatus()), ultima: registro });
    return registro;
  } catch (error) {
    const registro = { inicio: new Date(inicio).toISOString(), duracaoMs: Date.now() - inicio, ok: false, completo, inicial, manual, ...resumo, erros: [error.message, ...resumo.erros].slice(0, 20) };
    await registrar(registro).catch(() => {});
    if (manual) throw erroHttp(502, error.message);
    return registro;
  } finally {
    await soltarTrava();
  }
};

export const sincronizarAgora = async () => {
  if (rodando) throw erroHttp(409, "A sincronização já está rodando. Aguarde terminar.");
  rodando = executar({ manual: true });
  try {
    return await rodando;
  } finally {
    rodando = null;
  }
};

const agendar = (ms) => {
  if (timer) clearTimeout(timer);
  timer = null;
  proximaEm = null;
  if (ms == null) return;
  proximaEm = Date.now() + ms;
  timer = setTimeout(rodarAgendado, ms);
};

const rodarAgendado = async () => {
  timer = null;
  let config;
  try {
    config = await lerConfig();
    if (!config.ativo) return agendar(null);
    if (!rodando) {
      rodando = executar();
      await rodando;
    }
  } catch (error) {
    console.error("[legado] sincronização:", error.message);
  } finally {
    rodando = null;
  }
  agendar((config?.intervaloSegundos || INTERVALO_PADRAO) * 1000);
};

export const iniciarSincronizacao = async () => {
  try {
    const config = await lerConfig();
    if (config.ativo) agendar(20 * 1000);
  } catch (error) {
    console.error("[legado] iniciar:", error.message);
  }
};
