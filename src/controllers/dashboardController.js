import { Op, fn, col, literal } from "sequelize";
import {
  Pedido,
  PedidoItem,
  PedidoParcela,
  PedidoCustoExtra,
  Produto,
  MovimentacaoEstoque,
  Parceiro,
  Categoria,
} from "../models/index.js";
import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";
import { serializarPedido } from "../services/pedidoService.js";
import {
  arredondar,
  dataISO,
  erroHttp,
  fimDoDia,
  hojeISO,
  inicioDoDia,
  numero,
  responderErro,
} from "../utils/helpers.js";
import { contem } from "../utils/busca.js";

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

const periodo = (query) => {
  const hoje = hojeISO();
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(query.inicio || "") ? query.inicio : `${hoje.slice(0, 8)}01`;
  const fim = /^\d{4}-\d{2}-\d{2}$/.test(query.fim || "") ? query.fim : hoje;
  if (inicio > fim) throw erroHttp(400, "A data inicial é maior que a final.");
  return { inicio, fim, de: inicioDoDia(inicio), ate: fimDoDia(fim) };
};

const diaDaSemana = (data) =>
  new Date(new Date(data).toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })).getDay();

// Venda dos itens, custo (sem custo cadastrado = 0) e receita líquida.
const analisarPedido = (pedido) => {
  let vendaItens = 0;
  let custoItens = 0;
  let custoCompleto = true;
  for (const item of pedido.itens || []) {
    const unidades = item.quantidade * item.unidadesPacote;
    vendaItens += Number(item.total);
    if (item.custoUnitario == null) custoCompleto = false;
    custoItens += Number(item.custoUnitario || 0) * unidades;
  }
  const total = Number(pedido.total);
  // Custos pós-venda (reenvio, avaria...) também saem da receita líquida.
  const custoExtra = (pedido.custosExtras || []).reduce((s, c) => s + Number(c.valor), 0);
  const liquida =
    total - Number(pedido.taxas) - Number(pedido.frete) - Number(pedido.freteAdicional) - custoItens - custoExtra;
  return {
    total,
    vendaItens,
    custoItens,
    custoCompleto,
    custoExtra,
    liquida,
    margemBruta: vendaItens - Number(pedido.desconto) - custoItens,
  };
};

// "Pedidos expedidos" do período (mesmo critério da loja original): pedidos
// liberados para expedição criados no período + pedidos antigos expedidos no
// período.
const expedidosNoPeriodo = ({ de, ate }, extra = {}) =>
  Pedido.findAll({
    where: {
      tipo: "PEDIDO",
      statusVendas: "LIBERADO",
      [Op.or]: [
        { createdAt: { [Op.between]: [de, ate] } },
        { expedidoEm: { [Op.between]: [de, ate] } },
      ],
      ...extra,
    },
    include: [
      { model: PedidoItem, as: "itens" },
      { model: PedidoParcela, as: "parcelas" },
      { model: PedidoCustoExtra, as: "custosExtras" },
    ],
    order: [["numero", "DESC"]],
  });

// Vendas do período: mesmo critério do "Realizado" da Meta — pedidos criados
// no período, menos cancelados (inclui os que ainda aguardam liberação).
// Pedido de outro período expedido agora não entra: conta no período em que
// foi tirado.
const vendidosNoPeriodo = ({ de, ate }) =>
  Pedido.findAll({
    where: {
      tipo: "PEDIDO",
      statusVendas: { [Op.ne]: "CANCELADO" },
      createdAt: { [Op.between]: [de, ate] },
    },
    include: [
      { model: PedidoItem, as: "itens" },
      { model: PedidoParcela, as: "parcelas" },
      { model: PedidoCustoExtra, as: "custosExtras" },
    ],
    order: [["numero", "DESC"]],
  });

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------

// Vendas por produto (pacotes, unidades, receita, custo, lucro e margem) de
// uma lista de pedidos. Item sem custo cadastrado conta custo 0 e marca
// custoCompleto = false.
const agregarProdutos = (pedidos) => {
  const produtos = new Map();
  for (const pedido of pedidos) {
    for (const item of pedido.itens) {
      const chave = item.produtoId || item.nome;
      const atual = produtos.get(chave) || {
        produtoId: item.produtoId, nome: item.nome, categoria: item.categoria, pacotes: 0, unidades: 0,
        receita: 0, custo: 0, custoCompleto: true, pedidos: new Set(),
      };
      const unidades = item.quantidade * item.unidadesPacote;
      atual.pacotes += item.quantidade;
      atual.unidades += unidades;
      atual.receita += Number(item.total);
      atual.custo += Number(item.custoUnitario || 0) * unidades;
      if (item.custoUnitario == null) atual.custoCompleto = false;
      atual.pedidos.add(pedido.id);
      produtos.set(chave, atual);
    }
  }
  return [...produtos.values()].map(({ pedidos: ids, ...x }) => ({
    ...x,
    pedidos: ids.size,
    receita: arredondar(x.receita),
    custo: arredondar(x.custo),
    lucro: arredondar(x.receita - x.custo),
    margemPercentual: x.receita > 0 ? arredondar(((x.receita - x.custo) / x.receita) * 100) : 0,
  }));
};

const horaSP = (data) => Number(new Date(data).toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }));
// Segunda-feira da semana da data (AAAA-MM-DD), no fuso de São Paulo.
const segundaDaSemana = (data) => {
  const d = new Date(`${dataISO(data)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const chaveCliente = (pedido) => pedido.clienteId || (pedido.documento ? `doc:${pedido.documento}` : `nome:${(pedido.clienteNome || "").trim().toLowerCase()}`);

// Recebimentos: pedidos marcados como pago no período (data do pagamento),
// sem relação com a data do pedido ou da expedição. Pedidos antigos
// importados sem data de pagamento usam a data do pedido.
const pagosNoPeriodo = async ({ de, ate }) => {
  const pedidos = await Pedido.findAll({
    where: {
      tipo: "PEDIDO",
      statusFinanceiro: "PAGO",
      statusVendas: { [Op.ne]: "CANCELADO" },
      [Op.or]: [
        { pagoEm: { [Op.between]: [de, ate] } },
        { pagoEm: null, createdAt: { [Op.between]: [de, ate] } },
      ],
    },
    attributes: ["total", "taxas", "formaPagamento", "createdAt"],
    raw: true,
  });
  const formas = new Map();
  const r = { pedidos: 0, valor: 0, taxas: 0, doPeriodo: 0, deAntes: 0 };
  for (const pedido of pedidos) {
    const total = Number(pedido.total);
    r.pedidos += 1;
    r.valor += total;
    r.taxas += Number(pedido.taxas);
    if (new Date(pedido.createdAt) >= de) r.doPeriodo += total;
    else r.deAntes += total;
    const f = formas.get(pedido.formaPagamento) || { forma: pedido.formaPagamento, pedidos: 0, valor: 0 };
    f.pedidos += 1;
    f.valor += total;
    formas.set(pedido.formaPagamento, f);
  }
  return {
    pedidos: r.pedidos,
    valor: arredondar(r.valor),
    taxas: arredondar(r.taxas),
    liquido: arredondar(r.valor - r.taxas),
    doPeriodo: arredondar(r.doPeriodo),
    deAntes: arredondar(r.deAntes),
    porForma: [...formas.values()].map((f) => ({ ...f, valor: arredondar(f.valor) })).sort((a, b) => b.valor - a.valor),
  };
};

// Mês atual até hoje x mês passado até o mesmo dia, acumulado dia a dia.
// Não depende do período selecionado.
const comparativoMes = async () => {
  const hoje = hojeISO();
  const diaHoje = Number(hoje.slice(8, 10));
  const mesAtual = hoje.slice(0, 7);
  const [ano, mes] = mesAtual.split("-").map(Number);
  const mesAnterior = new Date(Date.UTC(ano, mes - 2, 1)).toISOString().slice(0, 7);
  const pedidos = await Pedido.findAll({
    where: { tipo: "PEDIDO", statusVendas: { [Op.ne]: "CANCELADO" }, createdAt: { [Op.gte]: inicioDoDia(`${mesAnterior}-01`) } },
    attributes: ["total", "createdAt"],
    raw: true,
  });
  const porDia = { [mesAtual]: new Array(32).fill(0), [mesAnterior]: new Array(32).fill(0) };
  for (const pedido of pedidos) {
    const iso = dataISO(pedido.createdAt);
    const lista = porDia[iso.slice(0, 7)];
    if (lista) lista[Number(iso.slice(8, 10))] += Number(pedido.total);
  }
  const [anoA, mesA] = mesAnterior.split("-").map(Number);
  const ultimoDiaAnterior = new Date(Date.UTC(anoA, mesA, 0)).getUTCDate();
  const dias = [];
  let atual = 0;
  let anterior = 0;
  for (let dia = 1; dia <= diaHoje; dia += 1) {
    atual += porDia[mesAtual][dia];
    if (dia <= ultimoDiaAnterior) anterior += porDia[mesAnterior][dia];
    dias.push({ dia, atual: arredondar(atual), anterior: arredondar(anterior) });
  }
  return {
    mesAtual,
    mesAnterior,
    dia: diaHoje,
    dias,
    totalAtual: arredondar(atual),
    totalAnterior: arredondar(anterior),
    variacao: anterior > 0 ? arredondar(((atual - anterior) / anterior) * 100) : null,
  };
};

// Clientes do período que já tinham comprado antes (recorrentes) x primeira compra.
const clientesNovosRecorrentes = async (pedidos, de) => {
  const ids = [...new Set(pedidos.map((x) => x.clienteId).filter(Boolean))];
  const docs = [...new Set(pedidos.filter((x) => !x.clienteId && x.documento).map((x) => x.documento))];
  const anteriores = new Set();
  const base = { tipo: "PEDIDO", statusVendas: { [Op.ne]: "CANCELADO" }, createdAt: { [Op.lt]: de } };
  if (ids.length) {
    const r = await Pedido.findAll({ where: { ...base, clienteId: ids }, attributes: ["clienteId"], group: ["clienteId"], raw: true });
    r.forEach((x) => anteriores.add(x.clienteId));
  }
  if (docs.length) {
    const r = await Pedido.findAll({ where: { ...base, documento: docs }, attributes: ["documento"], group: ["documento"], raw: true });
    r.forEach((x) => anteriores.add(`doc:${x.documento}`));
  }
  const grupos = { novos: { clientes: new Set(), pedidos: 0, bruta: 0 }, recorrentes: { clientes: new Set(), pedidos: 0, bruta: 0 } };
  for (const pedido of pedidos) {
    const chave = chaveCliente(pedido);
    const g = grupos[anteriores.has(chave) ? "recorrentes" : "novos"];
    g.clientes.add(chave);
    g.pedidos += 1;
    g.bruta += Number(pedido.total);
  }
  return Object.fromEntries(Object.entries(grupos).map(([k, g]) => [k, { clientes: g.clientes.size, pedidos: g.pedidos, bruta: arredondar(g.bruta) }]));
};

export const resumo = async (req, res) => {
  try {
    const p = periodo(req.query);
    const pedidos = await vendidosNoPeriodo(p);
    const [pagos, comparativo, clientes] = await Promise.all([pagosNoPeriodo(p), comparativoMes(), clientesNovosRecorrentes(pedidos, p.de)]);

    const card = () => ({ pedidos: 0, bruta: 0, liquida: 0 });
    const cards = { total: card(), recebida: card(), aberto: card(), aguardando: card() };
    const semana = DIAS.map((dia) => ({ dia, pedidos: 0, bruta: 0, liquida: 0, vendaItens: 0, margem: 0 }));
    const extras = { taxas: 0, frete: 0, desconto: 0, custoItens: 0, custosPosVenda: 0 };
    const semanas = new Map();
    const porCliente = new Map();
    const horas = Array.from({ length: 24 }, (_, hora) => ({ hora, pedidos: 0, bruta: 0 }));
    const formas = new Map();
    const somarEm = (mapa, chave, inicial, total) => {
      const x = mapa.get(chave) || inicial();
      x.pedidos += 1;
      x.bruta += total;
      mapa.set(chave, x);
    };

    for (const pedido of pedidos) {
      const a = analisarPedido(pedido);
      const somar = (c) => {
        c.pedidos += 1;
        c.bruta += a.total;
        c.liquida += a.liquida;
      };
      somar(cards.total);
      if (pedido.statusFinanceiro === "PAGO") somar(cards.recebida);
      else somar(cards.aberto);
      if (pedido.statusVendas !== "LIBERADO") somar(cards.aguardando);

      extras.taxas += Number(pedido.taxas);
      extras.frete += Number(pedido.frete) + Number(pedido.freteAdicional);
      extras.desconto += Number(pedido.desconto);
      extras.custoItens += a.custoItens;
      extras.custosPosVenda += a.custoExtra;

      const dia = semana[diaDaSemana(pedido.createdAt)];
      dia.pedidos += 1;
      dia.bruta += a.total;
      dia.liquida += a.liquida;
      dia.vendaItens += a.vendaItens;
      dia.margem += a.vendaItens - a.custoItens;

      const segunda = segundaDaSemana(pedido.createdAt);
      somarEm(semanas, segunda, () => ({ segunda, pedidos: 0, bruta: 0 }), a.total);
      somarEm(porCliente, chaveCliente(pedido), () => ({ nome: pedido.clienteNome, pedidos: 0, bruta: 0 }), a.total);
      somarEm(formas, pedido.formaPagamento, () => ({ forma: pedido.formaPagamento, pedidos: 0, bruta: 0 }), a.total);
      const h = horas[horaSP(pedido.createdAt)];
      h.pedidos += 1;
      h.bruta += a.total;
    }
    const arredondarBruta = (x) => ({ ...x, bruta: arredondar(x.bruta) });

    const arredondarCard = (c) => ({ pedidos: c.pedidos, bruta: arredondar(c.bruta), liquida: arredondar(c.liquida) });
    const listaProdutos = agregarProdutos(pedidos);
    const ordemSemana = [1, 2, 3, 4, 5, 6, 0];

    res.json({
      periodo: { inicio: p.inicio, fim: p.fim },
      atualizadoEm: new Date(),
      cards: Object.fromEntries(Object.entries(cards).map(([k, v]) => [k, arredondarCard(v)])),
      extras: {
        ...Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, arredondar(v)])),
        ticketMedio: cards.total.pedidos ? arredondar(cards.total.bruta / cards.total.pedidos) : 0,
      },
      semana: ordemSemana.map((i) => {
        const d = semana[i];
        return {
          dia: d.dia,
          pedidos: d.pedidos,
          bruta: arredondar(d.bruta),
          liquida: arredondar(d.liquida),
          margem: arredondar(d.margem),
          margemPercentual: d.vendaItens > 0 ? arredondar((d.margem / d.vendaItens) * 100) : null,
        };
      }),
      // Listas completas; o frontend filtra Todos / Top 10 / Top 3 / O mais.
      topQuantidade: [...listaProdutos].sort((a, b) => b.pacotes - a.pacotes || b.receita - a.receita),
      topMargem: listaProdutos
        .filter((x) => x.custoCompleto && x.receita > 0)
        .sort((a, b) => b.margemPercentual - a.margemPercentual || b.lucro - a.lucro),
      pagos,
      // Dados dos gráficos alternativos do Resumo.
      graficos: {
        semanas: [...semanas.values()].sort((a, b) => a.segunda.localeCompare(b.segunda)).map(arredondarBruta),
        topClientes: [...porCliente.values()].sort((a, b) => b.bruta - a.bruta).slice(0, 7).map(arredondarBruta),
        horas: horas.map(arredondarBruta),
        formas: [...formas.values()].sort((a, b) => b.bruta - a.bruta).map(arredondarBruta),
        clientes,
        comparativo,
      },
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar resumo");
  }
};

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const diasDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
const ehComercial = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};

export const meta = async (req, res) => {
  try {
    const p = periodo(req.query);
    const metas = (await lerConfiguracao("metasMensais")) || {};

    const pedidos = await Pedido.findAll({
      where: {
        tipo: "PEDIDO",
        statusVendas: { [Op.ne]: "CANCELADO" },
        createdAt: { [Op.between]: [p.de, p.ate] },
      },
      attributes: ["total", "createdAt"],
      raw: true,
    });
    const porDia = new Map();
    for (const pedido of pedidos) {
      const dia = dataISO(pedido.createdAt);
      porDia.set(dia, (porDia.get(dia) || 0) + Number(pedido.total));
    }

    // Percorre cada dia do período somando a meta diária proporcional.
    const hoje = hojeISO();
    let metaPeriodo = 0;
    let diasComerciaisPeriodo = 0;
    const meses = new Map();
    for (let d = new Date(`${p.inicio}T12:00:00Z`); dataISOUtc(d) <= p.fim; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = dataISOUtc(d);
      const chave = iso.slice(0, 7);
      if (!meses.has(chave)) {
        const [ano, mes] = chave.split("-").map(Number);
        let comerciais = 0;
        for (let dia = 1; dia <= diasDoMes(ano, mes); dia += 1) {
          if (ehComercial(`${chave}-${String(dia).padStart(2, "0")}`)) comerciais += 1;
        }
        meses.set(chave, { metaMensal: Number(metas[chave] || 0), diasComerciais: comerciais });
      }
      if (ehComercial(iso)) {
        const m = meses.get(chave);
        diasComerciaisPeriodo += 1;
        metaPeriodo += m.diasComerciais ? m.metaMensal / m.diasComerciais : 0;
      }
    }

    // Calendário do mês do fim do período.
    const mesCalendario = p.fim.slice(0, 7);
    const [anoC, mesC] = mesCalendario.split("-").map(Number);
    const infoMes = meses.get(mesCalendario) || { metaMensal: Number(metas[mesCalendario] || 0), diasComerciais: 22 };
    const metaDiaria = infoMes.diasComerciais ? infoMes.metaMensal / infoMes.diasComerciais : 0;
    const calendario = [];
    for (let dia = 1; dia <= diasDoMes(anoC, mesC); dia += 1) {
      const iso = `${mesCalendario}-${String(dia).padStart(2, "0")}`;
      const realizado = porDia.get(iso) || 0;
      let status;
      if (iso < p.inicio || iso > p.fim) status = "FORA";
      else if (!ehComercial(iso)) status = "NAO_COMERCIAL";
      else if (!metaDiaria) status = "SEM_META";
      else if (realizado >= metaDiaria) status = "BATIDA";
      else if (iso >= hoje) status = "A_CUMPRIR";
      else status = "NAO_BATIDA";
      calendario.push({
        data: iso,
        diaSemana: new Date(`${iso}T12:00:00Z`).getUTCDay(),
        status,
        realizado: status === "FORA" ? null : arredondar(realizado),
      });
    }

    const realizado = [...porDia.values()].reduce((s, v) => s + v, 0);
    res.json({
      periodo: { inicio: p.inicio, fim: p.fim },
      mes: mesCalendario,
      metaMensal: infoMes.metaMensal,
      diasComerciaisMes: infoMes.diasComerciais,
      diasComerciaisPeriodo,
      metaPeriodo: arredondar(metaPeriodo),
      realizado: arredondar(realizado),
      progresso: metaPeriodo ? arredondar((realizado / metaPeriodo) * 100) : null,
      metaDiaria: arredondar(metaDiaria),
      calendario,
      metas,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar meta");
  }
};

const dataISOUtc = (d) => d.toISOString().slice(0, 10);

export const salvarMetas = async (req, res) => {
  try {
    const entrada = req.body?.metas || {};
    const atuais = (await lerConfiguracao("metasMensais")) || {};
    for (const [mes, valor] of Object.entries(entrada)) {
      if (!/^\d{4}-\d{2}$/.test(mes)) continue;
      const v = numero(valor);
      if (v > 0) atuais[mes] = v;
      else delete atuais[mes];
    }
    res.json(await salvarConfiguracao("metasMensais", atuais));
  } catch (error) {
    responderErro(res, error, "Erro ao salvar metas");
  }
};

// ---------------------------------------------------------------------------
// Pedidos expedidos (fechamento por forma de pagamento)
// ---------------------------------------------------------------------------

export const expedidos = async (req, res) => {
  try {
    const p = periodo(req.query);
    const todos = await expedidosNoPeriodo(p);
    const lista = (v) => String(v || "").split(",").filter(Boolean);
    const formas = lista(req.query.formas);
    const financeiro = lista(req.query.financeiro);
    const busca = String(req.query.busca || "").trim().toLowerCase();

    const filtrados = todos.filter((pedido) => {
      if (formas.length && !formas.includes(pedido.formaPagamento)) return false;
      if (financeiro.length && !financeiro.includes(pedido.statusFinanceiro)) return false;
      if (busca && !String(pedido.numero).includes(busca) && !pedido.clienteNome.toLowerCase().includes(busca)) return false;
      return true;
    });

    const totalizar = (lista) => ({
      valor: arredondar(lista.reduce((s, x) => s + Number(x.total), 0)),
      quantidade: lista.length,
      aguardandoPagamento: lista.filter((x) => x.statusFinanceiro === "AGUARDANDO_PAGAMENTO").length,
    });
    const porForma = new Map();
    for (const pedido of filtrados) {
      const atual = porForma.get(pedido.formaPagamento) || { forma: pedido.formaPagamento, valor: 0, quantidade: 0 };
      atual.valor += Number(pedido.total);
      atual.quantidade += 1;
      porForma.set(pedido.formaPagamento, atual);
    }

    res.json({
      totalPeriodo: totalizar(todos),
      filtrado: totalizar(filtrados),
      porForma: [...porForma.values()]
        .map((x) => ({ ...x, valor: arredondar(x.valor) }))
        .sort((a, b) => b.valor - a.valor),
      pedidos: filtrados.map((x) => serializarPedido(x, { completo: false })),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao listar pedidos expedidos");
  }
};

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

const SEMANAS_PROJECAO = 26;

// Média semanal = unidades vendidas em pedidos pagos nos últimos 6 meses ÷
// semanas do período (o filtro de datas do dashboard não altera a projeção).
const mediasSemanais = async () => {
  const desde = new Date(Date.now() - SEMANAS_PROJECAO * 7 * 86400000);
  const linhas = await PedidoItem.findAll({
    attributes: [
      "produtoId",
      [fn("SUM", literal('"PedidoItem"."quantidade" * "PedidoItem"."unidadesPacote"')), "unidades"],
    ],
    include: [{
      model: Pedido,
      as: "pedido",
      attributes: [],
      where: { tipo: "PEDIDO", statusFinanceiro: "PAGO", createdAt: { [Op.gte]: desde } },
    }],
    group: ["PedidoItem.produtoId"],
    raw: true,
  });
  return new Map(linhas.map((l) => [l.produtoId, Number(l.unidades) / SEMANAS_PROJECAO]));
};

export const estoqueResumo = async (req, res) => {
  try {
    const [produtos, medias] = await Promise.all([
      Produto.findAll({
        where: { arquivado: false, tipo: "SIMPLES" },
        include: [{ model: Parceiro, as: "fornecedorPreferencial", attributes: ["id", "nome"] }],
      }),
      mediasSemanais(),
    ]);
    const linha = (p) => {
      const media = medias.get(p.id) || 0;
      return {
        id: p.id,
        nome: p.nome,
        sku: p.sku,
        categoria: p.categoria,
        estoque: p.estoque,
        estoqueMinimo: p.estoqueMinimo,
        mediaSemanal: arredondar(media, 1),
        semanasRestantes: media > 0 ? arredondar(p.estoque / media, 1) : null,
        fornecedorPreferencial: p.fornecedorPreferencial,
      };
    };
    const zerados = [];
    const baixos = [];
    const projecao = [];
    for (const produto of produtos) {
      const l = linha(produto);
      if (produto.estoque <= 0) zerados.push(l);
      else if (produto.estoqueMinimo != null && produto.estoque <= produto.estoqueMinimo) baixos.push(l);
      else if (l.semanasRestantes != null && l.semanasRestantes < 4) projecao.push(l);
    }
    const porMedia = (a, b) => b.mediaSemanal - a.mediaSemanal;
    res.json({
      zerados: zerados.sort(porMedia),
      baixos: baixos.sort(porMedia),
      projecao: projecao.sort((a, b) => a.semanasRestantes - b.semanasRestantes),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar estoque");
  }
};

export const movimentacoes = async (req, res) => {
  try {
    const p = periodo(req.query);
    const where = { createdAt: { [Op.between]: [p.de, p.ate] } };
    if (req.query.tipo) where.tipo = { [Op.in]: String(req.query.tipo).split(",") };
    if (req.query.produtoId) where.produtoId = req.query.produtoId;
    const busca = String(req.query.busca || "").trim();
    if (busca.length >= 2) {
      where[Op.or] = [
        ...["produtoNome", "clienteNome", "motivo", "usuarioNome"].map((campo) => contem(campo, busca)),
        ...["produtoSku", "clienteEmail", "pedidoNumero"].map((campo) => ({ [campo]: { [Op.iLike]: `%${busca}%` } })),
      ];
    }
    const limite = Math.min(Number(req.query.limite) || 50, 5000);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const [{ rows, count }, porTipo] = await Promise.all([
      MovimentacaoEstoque.findAndCountAll({
        where,
        order: [["createdAt", "DESC"]],
        limit: limite,
        offset: (pagina - 1) * limite,
      }),
      MovimentacaoEstoque.findAll({
        where,
        attributes: ["tipo", [fn("COUNT", col("id")), "total"], [fn("SUM", col("quantidade")), "unidades"]],
        group: ["tipo"],
        raw: true,
      }),
    ]);
    const resumoTipo = Object.fromEntries(
      ["ENTRADA", "SAIDA", "AJUSTE"].map((t) => {
        const r = porTipo.find((x) => x.tipo === t);
        return [t, { movimentos: Number(r?.total || 0), unidades: Number(r?.unidades || 0) }];
      }),
    );
    res.json({ itens: rows, total: count, pagina, paginas: Math.max(1, Math.ceil(count / limite)), resumo: resumoTipo });
  } catch (error) {
    responderErro(res, error, "Erro ao listar movimentações");
  }
};

// Fila sob demanda: itens por encomenda em pedidos liberados ainda não
// expedidos, comparados ao estoque atual (o que precisa ser comprado).
export const filaSobDemanda = async (req, res) => {
  try {
    const itens = await PedidoItem.findAll({
      where: { sobEncomenda: true },
      include: [{
        model: Pedido,
        as: "pedido",
        attributes: ["id", "numero", "clienteNome", "createdAt"],
        where: { tipo: "PEDIDO", statusVendas: { [Op.ne]: "CANCELADO" }, statusExpedicao: { [Op.ne]: "EXPEDIDO" } },
      }],
    });
    const porProduto = new Map();
    for (const item of itens) {
      const atual = porProduto.get(item.produtoId) || { produtoId: item.produtoId, nome: item.nome, sku: item.sku, unidades: 0, pedidos: [] };
      atual.unidades += item.quantidade * item.unidadesPacote;
      atual.pedidos.push({ id: item.pedido.id, numero: item.pedido.numero, cliente: item.pedido.clienteNome });
      porProduto.set(item.produtoId, atual);
    }
    const produtos = await Produto.findAll({
      where: { id: [...porProduto.keys()].filter(Boolean) },
      include: [{ model: Parceiro, as: "fornecedorPreferencial", attributes: ["id", "nome"] }],
    });
    const fila = produtos.map((p) => {
      const pendente = porProduto.get(p.id);
      return {
        ...pendente,
        estoque: p.estoque,
        faltando: Math.max(0, pendente.unidades - Math.max(0, p.estoque)),
        fornecedorPreferencial: p.fornecedorPreferencial,
      };
    });
    res.json(fila.sort((a, b) => b.faltando - a.faltando));
  } catch (error) {
    responderErro(res, error, "Erro ao carregar fila sob demanda");
  }
};

// ---------------------------------------------------------------------------
// Análise de produtos (aba "Análise" do Time Financeiro)
// ---------------------------------------------------------------------------

const MARGEM_ATENCAO = 10;

const dadosAtuais = (produto) =>
  produto && {
    imagemUrl: produto.imagemUrl,
    sku: produto.sku,
    categoria: produto.categoria,
    estoque: produto.estoque,
    unidadesPacote: produto.unidadesPacote,
    precoVenda: Number(produto.precoVenda),
    custoAtual: produto.custo != null ? Number(produto.custo) : null,
    arquivado: produto.arquivado,
  };

// Vendas do período por produto + destaques + produtos fechando no vermelho.
export const analise = async (req, res) => {
  try {
    const p = periodo(req.query);
    const [pedidos, cadastro] = await Promise.all([vendidosNoPeriodo(p), Produto.findAll()]);
    const porId = new Map(cadastro.map((x) => [x.id, x]));

    const vendas = agregarProdutos(pedidos).map((v) => ({ ...v, ...dadosAtuais(porId.get(v.produtoId)), nome: v.nome }));
    const comCusto = vendas.filter((v) => v.custoCompleto && v.receita > 0);
    const maior = (lista, campo) => lista.reduce((m, x) => (!m || x[campo] > m[campo] ? x : m), null);

    // Cadastro com preço de venda abaixo do custo (vende no prejuízo).
    const precoAbaixoDoCusto = cadastro
      .filter((x) => !x.arquivado && x.custo != null && Number(x.custo) > 0 && Number(x.precoVenda) < Number(x.custo))
      .map((x) => ({
        produtoId: x.id,
        nome: x.nome,
        ...dadosAtuais(x),
        prejuizoPorUnidade: arredondar(Number(x.custo) - Number(x.precoVenda), 4),
        margemPercentual: Number(x.precoVenda) > 0 ? arredondar(((Number(x.precoVenda) - Number(x.custo)) / Number(x.precoVenda)) * 100) : -100,
      }))
      .sort((a, b) => a.margemPercentual - b.margemPercentual);

    res.json({
      periodo: { inicio: p.inicio, fim: p.fim },
      pedidos: pedidos.length,
      totais: {
        receita: arredondar(vendas.reduce((s, v) => s + v.receita, 0)),
        lucro: arredondar(vendas.reduce((s, v) => s + v.lucro, 0)),
        produtosVendidos: vendas.length,
        semCusto: vendas.filter((v) => !v.custoCompleto).length,
      },
      destaques: {
        maisVendido: maior(vendas, "pacotes"),
        maiorReceita: maior(vendas, "receita"),
        maiorMargem: maior(comCusto, "margemPercentual"),
        maiorLucro: maior(comCusto, "lucro"),
      },
      vendas: vendas.sort((a, b) => b.pacotes - a.pacotes || b.receita - a.receita),
      vermelho: {
        vendidosComPrejuizo: vendas.filter((v) => v.lucro < 0).sort((a, b) => a.lucro - b.lucro),
        margemBaixa: comCusto
          .filter((v) => v.margemPercentual >= 0 && v.margemPercentual < MARGEM_ATENCAO)
          .sort((a, b) => a.margemPercentual - b.margemPercentual),
        precoAbaixoDoCusto,
        limiteMargemAtencao: MARGEM_ATENCAO,
      },
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar análise");
  }
};

// Produtos ativos (não arquivados) por categoria, com o estoque de cada um.
export const produtosAtivos = async (req, res) => {
  try {
    const [produtos, categorias] = await Promise.all([
      Produto.findAll({ where: { arquivado: false }, order: [["nome", "ASC"]] }),
      Categoria.findAll(),
    ]);
    const visivel = new Map(categorias.map((c) => [c.nome, c.visivel]));
    const lista = produtos.map((x) => {
      const unidadesPacote = Number(x.unidadesPacote || 1);
      const estoque = Number(x.estoque || 0);
      return {
        id: x.id,
        nome: x.nome,
        sku: x.sku,
        categoria: x.categoria || "Sem categoria",
        imagemUrl: x.imagemUrl,
        estoque,
        unidadesPacote,
        pacotes: Math.floor(Math.max(0, estoque) / unidadesPacote),
        estoqueMinimo: x.estoqueMinimo,
        precoVenda: Number(x.precoVenda),
        custo: x.custo != null ? Number(x.custo) : null,
        valorEmEstoque: arredondar(Math.max(0, estoque) * Number(x.custo || 0)),
        modoVenda: x.modoVenda,
        status: estoque <= 0 ? "SEM_ESTOQUE" : x.estoqueMinimo != null && estoque <= x.estoqueMinimo ? "ESTOQUE_BAIXO" : "EM_ESTOQUE",
      };
    });

    const porCategoria = new Map();
    for (const prod of lista) {
      const c = porCategoria.get(prod.categoria) || {
        nome: prod.categoria, visivel: visivel.get(prod.categoria) ?? true, produtos: 0, estoqueUnidades: 0, semEstoque: 0, valorEmEstoque: 0,
      };
      c.produtos += 1;
      c.estoqueUnidades += Math.max(0, prod.estoque);
      c.valorEmEstoque += prod.valorEmEstoque;
      if (prod.estoque <= 0) c.semEstoque += 1;
      porCategoria.set(prod.categoria, c);
    }

    res.json({
      totalProdutos: lista.length,
      categorias: [...porCategoria.values()]
        .map((c) => ({ ...c, valorEmEstoque: arredondar(c.valorEmEstoque) }))
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
      produtos: lista,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar produtos ativos");
  }
};

// ---------------------------------------------------------------------------
// Tendências de venda x estoque (aba Análise)
// ---------------------------------------------------------------------------

const MESES_TENDENCIA = 6;
// Abaixo disso (unidades/mês) a oscilação é ruído e o produto não entra.
const MINIMO_MENSAL = 10;

const somarMes = (chave, meses) => {
  const [ano, mes] = chave.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1 + meses, 1)).toISOString().slice(0, 7);
};

// Meses seguidos subindo (positivo) ou caindo (negativo) até o último mês fechado.
const sequencia = (valores) => {
  let n = 0;
  for (let i = valores.length - 1; i > 0; i -= 1) {
    const diff = valores[i] - valores[i - 1];
    if (diff > 0 && n >= 0) n += 1;
    else if (diff < 0 && n <= 0) n -= 1;
    else break;
  }
  return n;
};

// Vendas por mês de cada produto de estoque (kits contam nos componentes),
// em unidades, nos últimos 6 meses fechados + mês atual; ritmo dos últimos 30
// dias; quantas vezes zerou e quantas reposições teve. Mesmo critério de
// venda do restante do Financeiro: pedidos criados, menos cancelados.
export const tendencias = async (req, res) => {
  try {
    const mesAtual = hojeISO().slice(0, 7);
    const meses = Array.from({ length: MESES_TENDENCIA }, (_, i) => somarMes(mesAtual, i - MESES_TENDENCIA));
    const desde = inicioDoDia(`${meses[0]}-01`);
    const trintaDias = new Date(Date.now() - 30 * 86400000);

    const [itens, produtos, movimentos] = await Promise.all([
      PedidoItem.findAll({
        attributes: ["produtoId", "quantidade", "unidadesPacote"],
        include: [{
          model: Pedido,
          as: "pedido",
          attributes: ["createdAt"],
          where: { tipo: "PEDIDO", statusVendas: { [Op.ne]: "CANCELADO" }, createdAt: { [Op.gte]: desde } },
        }],
        raw: true,
        nest: true,
      }),
      Produto.findAll(),
      MovimentacaoEstoque.findAll({
        attributes: ["produtoId", "tipo", "quantidadeAnterior", "quantidadeNova"],
        where: { createdAt: { [Op.gte]: desde }, produtoId: { [Op.ne]: null } },
        raw: true,
      }),
    ]);
    const porId = new Map(produtos.map((p) => [p.id, p]));

    const vendas = new Map(); // produtoId -> { meses: {chave: un}, ultimos30 }
    const somar = (produtoId, unidades, chave, recente) => {
      const v = vendas.get(produtoId) || { meses: {}, ultimos30: 0 };
      v.meses[chave] = (v.meses[chave] || 0) + unidades;
      if (recente) v.ultimos30 += unidades;
      vendas.set(produtoId, v);
    };
    for (const item of itens) {
      const produto = porId.get(item.produtoId);
      if (!produto) continue;
      const unidades = Number(item.quantidade) * Number(item.unidadesPacote || 1);
      const chave = dataISO(item.pedido.createdAt).slice(0, 7);
      const recente = new Date(item.pedido.createdAt) >= trintaDias;
      if (produto.tipo === "COMPOSTO" && produto.componentes?.length) {
        for (const c of produto.componentes) somar(c.produtoId, unidades * Number(c.quantidade || 1), chave, recente);
      } else somar(produto.id, unidades, chave, recente);
    }

    const estoqueMov = new Map(); // produtoId -> { zerou, reposicoes }
    for (const m of movimentos) {
      const e = estoqueMov.get(m.produtoId) || { zerou: 0, reposicoes: 0 };
      if (m.quantidadeAnterior > 0 && m.quantidadeNova != null && m.quantidadeNova <= 0) e.zerou += 1;
      if (m.tipo === "ENTRADA") e.reposicoes += 1;
      estoqueMov.set(m.produtoId, e);
    }

    const subindo = [];
    const caindo = [];
    for (const [produtoId, v] of vendas) {
      const produto = porId.get(produtoId);
      if (!produto || produto.arquivado || produto.tipo === "COMPOSTO") continue;
      const mensal = meses.map((m) => v.meses[m] || 0);
      const media3 = mensal.slice(-3).reduce((s, x) => s + x, 0) / 3;
      const media3Ant = mensal.slice(0, 3).reduce((s, x) => s + x, 0) / 3;
      if (Math.max(media3, media3Ant) < MINIMO_MENSAL) continue;

      // Base anterior pequena demais: % não diz nada, conta como "começou a vender".
      const variacao = media3Ant >= MINIMO_MENSAL ? ((media3 - media3Ant) / media3Ant) * 100 : null;
      const seq = sequencia(mensal);
      // Ritmo atual: o maior entre os últimos 30 dias e a média dos 3 meses.
      const ritmoDiario = Math.max(v.ultimos30, media3) / 30;
      const estoque = Number(produto.estoque);
      const coberturaDias = ritmoDiario > 0 ? Math.max(0, Math.round(estoque / ritmoDiario)) : null;
      const mov = estoqueMov.get(produtoId) || { zerou: 0, reposicoes: 0 };

      const linha = {
        produtoId,
        nome: produto.nome,
        sku: produto.sku,
        categoria: produto.categoria,
        imagemUrl: produto.imagemUrl,
        estoque,
        mensal,
        mesAtual: v.meses[mesAtual] || 0,
        ultimos30: v.ultimos30,
        mediaRecente: arredondar(media3, 1),
        mediaAnterior: arredondar(media3Ant, 1),
        variacao: variacao == null ? null : arredondar(variacao, 1),
        sequencia: seq,
        ritmoDiario: arredondar(ritmoDiario, 2),
        coberturaDias,
        vezesZerou: mov.zerou,
        reposicoes: mov.reposicoes,
      };

      // Repor com mais frequência: vendas subindo, ou estoque que acaba rápido.
      const vendasCaindo = variacao != null && variacao <= -25;
      const motivosSobe = [];
      if (variacao == null) motivosSobe.push("Começou a vender nos últimos 3 meses");
      else if (variacao >= 200) motivosSobe.push(`Vendas ${Math.round(media3 / media3Ant)}x maiores`);
      else if (variacao >= 20) motivosSobe.push(`Vendas subiram ${Math.round(variacao)}%`);
      if (seq >= 3) motivosSobe.push(`${seq} meses seguidos em alta`);
      if (mov.zerou >= 2) motivosSobe.push(`Zerou ${mov.zerou}x em ${MESES_TENDENCIA} meses`);
      if (coberturaDias != null && coberturaDias < 30 && v.ultimos30 > 0) {
        motivosSobe.push(coberturaDias === 0 ? "Sem estoque" : `Estoque dura ~${coberturaDias} dias`);
      }
      if (motivosSobe.length && !vendasCaindo) {
        subindo.push({
          ...linha,
          motivos: motivosSobe,
          pontos: Math.min(variacao ?? 100, 300) / 10 + Math.max(0, seq) * 3 + mov.zerou * 4 + (coberturaDias != null ? Math.max(0, 30 - coberturaDias) / 3 : 0),
        });
      }

      // Pode comprar menos: vendas caindo.
      const motivosCai = [];
      if (vendasCaindo) motivosCai.push(`Vendas caíram ${Math.abs(Math.round(variacao))}%`);
      if (seq <= -3) motivosCai.push(`${Math.abs(seq)} meses seguidos em queda`);
      if (motivosCai.length) {
        if (coberturaDias == null) motivosCai.push("Sem vendas no ritmo atual");
        else if (coberturaDias >= 90) motivosCai.push(`Estoque dura ~${Math.round(coberturaDias / 30)} meses`);
        caindo.push({
          ...linha,
          motivos: motivosCai,
          // Primeiro quem tem mais estoque parado (é onde dá para cortar compra).
          pontos: Math.min(-(variacao || 0), 100) / 10 + Math.max(0, -seq) * 3 +
            (estoque <= 0 ? 0 : coberturaDias == null ? 24 : Math.min(coberturaDias / 30, 12) * 2),
        });
      }
    }

    const porPontos = (a, b) => b.pontos - a.pontos;
    res.json({
      meses,
      mesAtual,
      minimoMensal: MINIMO_MENSAL,
      subindo: subindo.sort(porPontos),
      caindo: caindo.sort(porPontos),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar tendências");
  }
};
