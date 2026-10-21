import { Op, fn, col, literal } from "sequelize";
import {
  Pedido,
  PedidoItem,
  PedidoParcela,
  PedidoCustoExtra,
  Produto,
  MovimentacaoEstoque,
  Parceiro,
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

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------

export const resumo = async (req, res) => {
  try {
    const p = periodo(req.query);
    const pedidos = await expedidosNoPeriodo(p);

    const card = () => ({ pedidos: 0, bruta: 0, liquida: 0 });
    const cards = { total: card(), recebida: card(), aberto: card(), antigos: card() };
    const semana = DIAS.map((dia) => ({ dia, pedidos: 0, bruta: 0, liquida: 0, vendaItens: 0, margem: 0 }));
    const produtos = new Map();
    const extras = { taxas: 0, frete: 0, desconto: 0, custoItens: 0, custosPosVenda: 0 };

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
      if (new Date(pedido.createdAt) < p.de) somar(cards.antigos);

      extras.taxas += Number(pedido.taxas);
      extras.frete += Number(pedido.frete) + Number(pedido.freteAdicional);
      extras.desconto += Number(pedido.desconto);
      extras.custoItens += a.custoItens;
      extras.custosPosVenda += a.custoExtra;

      const referencia = pedido.expedidoEm || pedido.createdAt;
      const dia = semana[diaDaSemana(referencia)];
      dia.pedidos += 1;
      dia.bruta += a.total;
      dia.liquida += a.liquida;
      dia.vendaItens += a.vendaItens;
      dia.margem += a.vendaItens - a.custoItens;

      for (const item of pedido.itens) {
        const chave = item.produtoId || item.nome;
        const atual = produtos.get(chave) || {
          produtoId: item.produtoId, nome: item.nome, pacotes: 0, unidades: 0, receita: 0, custo: 0, custoCompleto: true,
        };
        const unidades = item.quantidade * item.unidadesPacote;
        atual.pacotes += item.quantidade;
        atual.unidades += unidades;
        atual.receita += Number(item.total);
        atual.custo += Number(item.custoUnitario || 0) * unidades;
        if (item.custoUnitario == null) atual.custoCompleto = false;
        produtos.set(chave, atual);
      }
    }

    const arredondarCard = (c) => ({ pedidos: c.pedidos, bruta: arredondar(c.bruta), liquida: arredondar(c.liquida) });
    const listaProdutos = [...produtos.values()].map((x) => ({
      ...x,
      receita: arredondar(x.receita),
      lucro: arredondar(x.receita - x.custo),
      margemPercentual: x.receita > 0 ? arredondar(((x.receita - x.custo) / x.receita) * 100) : 0,
    }));
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
      topQuantidade: [...listaProdutos].sort((a, b) => b.pacotes - a.pacotes).slice(0, 10),
      topMargem: listaProdutos
        .filter((x) => x.custoCompleto && x.receita > 0)
        .sort((a, b) => b.margemPercentual - a.margemPercentual || b.lucro - a.lucro)
        .slice(0, 10),
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
      where[Op.or] = ["produtoNome", "produtoSku", "clienteNome", "clienteEmail", "motivo", "usuarioNome", "pedidoNumero"].map(
        (campo) => ({ [campo]: { [Op.iLike]: `%${busca}%` } }),
      );
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
