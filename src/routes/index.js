import express from "express";
import multer from "multer";
import {
  autenticar,
  autenticarOpcional,
  exigirInterno,
  exigirPermissao,
  exigirPermissaoOuShowroom,
  registrarLog,
} from "../middlewares/auth.js";
import * as auth from "../controllers/authController.js";
import * as produtos from "../controllers/produtoController.js";
import * as pedidos from "../controllers/pedidoController.js";
import * as expedicao from "../controllers/expedicaoController.js";
import * as entradas from "../controllers/entradaController.js";
import * as usuarios from "../controllers/usuarioController.js";
import * as dashboard from "../controllers/dashboardController.js";
import * as arquivos from "../controllers/arquivoController.js";
import * as pagamentos from "../controllers/pagamentoController.js";
import * as pagamentosConfig from "../controllers/pagamentoConfigController.js";
import * as comercial from "../controllers/comercialController.js";
import * as correios from "../controllers/correiosController.js";
import * as nfeEmissao from "../controllers/nfeEmissaoController.js";
import * as banners from "../controllers/bannerController.js";
import * as custosExtras from "../controllers/custoExtraController.js";
import * as giraldo from "../controllers/giraldoController.js";
import * as transportadoras from "../controllers/transportadoraController.js";
import * as recebimentos from "../controllers/recebimentoController.js";
import * as whatsapp from "../controllers/whatsappController.js";
import * as legado from "../controllers/sincronizacaoLegadoController.js";
import * as compras from "../controllers/compraController.js";
import * as bancos from "../controllers/bancoController.js";
import * as cheques from "../controllers/chequeController.js";
import * as portalFornecedor from "../controllers/portalFornecedorController.js";
import { limitarTaxa } from "../utils/linkSeguro.js";
import { cotarBraspressSite, diagnosticoBraspress } from "../services/braspressService.js";
import transportadoraRoutes from "./transportadora.routes.js";
import calculoPedidoRoutes from "./calculoPedido.routes.js";
import pedidoNotaFiscalRoutes from "./pedidoNotaFiscal.routes.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.get("/health", (req, res) => res.json({ status: "ok", servico: "girakids-backend" }));

// Autenticação e perfil
// Limite por IP contra robôs testando senhas e criando contas em massa.
router.post("/auth/login", limitarTaxa({ janelaMs: 60_000, maximo: 10 }), auth.login);
router.post("/auth/registrar", limitarTaxa({ janelaMs: 60 * 60_000, maximo: 10 }), auth.registrar);
router.get("/auth/perfil", autenticar, auth.perfil);
router.put("/auth/perfil", autenticar, auth.atualizarPerfil);
router.put("/auth/senha", autenticar, auth.alterarSenha);

// Configuração pública (WhatsApp do comercial) e banners do catálogo
router.get("/config/publica", comercial.configPublica);
router.put("/config/whatsapp", autenticar, exigirPermissao("COMERCIAL", "USUARIOS"), registrarLog("WHATSAPP_COMERCIAL", "Configuracao"), comercial.salvarWhatsapp);
router.put("/config/banner-layout", autenticar, exigirPermissao("PRODUTOS", "COMERCIAL"), registrarLog("LAYOUT_BANNER", "Configuracao"), comercial.salvarBannerLayout);
router.get("/banners", banners.listarAtivos);
router.get("/banners/todos", autenticar, exigirPermissao("PRODUTOS", "COMERCIAL"), banners.listarTodos);
router.post("/banners", autenticar, exigirPermissao("PRODUTOS", "COMERCIAL"), registrarLog("CRIAR_BANNER", "Banner"), banners.criar);
router.put("/banners/ordem", autenticar, exigirPermissao("PRODUTOS", "COMERCIAL"), banners.reordenar);
router.put("/banners/:id", autenticar, exigirPermissao("PRODUTOS", "COMERCIAL"), registrarLog("ATUALIZAR_BANNER", "Banner"), banners.atualizar);
router.delete("/banners/:id", autenticar, exigirPermissao("PRODUTOS", "COMERCIAL"), registrarLog("EXCLUIR_BANNER", "Banner"), banners.excluir);

// Giraldo (assistente de compras com IA) — público; usa o login se houver.
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post("/assistente/mensagem", autenticarOpcional, giraldo.conversar);
router.post("/assistente/transcrever", autenticarOpcional, uploadAudio.single("audio"), giraldo.transcrever);

// Catálogo público
router.get("/catalogo", autenticarOpcional, produtos.catalogo);
router.get("/catalogo/produtos/:id", produtos.obterPublico);

// Acompanhamento público do pedido (link assinado enviado ao cliente)
const limiteAcompanhamento = limitarTaxa({ janelaMs: 60_000, maximo: 30 });
router.get("/acompanhamento/:id/:assinatura", limiteAcompanhamento, pedidos.acompanhamentoPublico);
router.get("/acompanhamento/:id/:assinatura/rastreio", limiteAcompanhamento, pedidos.rastreioPublico);

// Checkout e pedidos do cliente
router.get("/checkout/opcoes", autenticar, pedidos.opcoesCheckout);
// Equipe tirando pedido com entrega por transportadora
// Também a expedição, que pode trocar a transportadora de um pedido.
const tiraPedido = [autenticar, exigirPermissao("CHECKOUT", "VENDAS", "ORCAMENTOS", "COMERCIAL", "EXPEDICAO")];
router.get("/checkout/transportadoras", ...tiraPedido, transportadoras.sugestoesCheckout);
router.post("/checkout/transportadoras/ia", ...tiraPedido, registrarLog("BUSCAR_TRANSPORTADORAS", "Transportadora"), transportadoras.buscarTransportadoras);
// Cada cotação consulta Correios e o site da Braspress: limite por IP.
router.post("/checkout/frete", limitarTaxa({ janelaMs: 60_000, maximo: 40 }), autenticar, pedidos.cotar);
router.post("/pedidos", autenticar, (req, res, next) =>
  ["CLIENTE", "SHOWROOM"].includes(req.usuario.role) ? next() : exigirPermissao("CHECKOUT", "VENDAS")(req, res, next),
registrarLog("CRIAR_PEDIDO", "Pedido"), pedidos.criar);
router.get("/pedidos/meus", autenticar, pedidos.meusPedidos);
router.get("/pedidos/codigo/:codigo", autenticar, pedidos.obterPorCodigo);
router.get("/pedidos/carregar", autenticar, pedidos.buscarParaCarregar);

// Time de Vendas / Financeiro
const vendasOuFinanceiro = exigirPermissao("VENDAS", "FINANCEIRO");
router.get("/pedidos", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "EXPEDICAO"), pedidos.listar);
router.get("/pedidos/contadores", autenticar, exigirInterno, pedidos.contadores);
router.get("/pedidos/alertas-pagamento", autenticar, vendasOuFinanceiro, pedidos.listarAlertasPagamento);
router.put("/pedidos/alertas-pagamento/:alertaId/resolver", autenticar, vendasOuFinanceiro, pedidos.resolverAlertaPagamento);
router.put("/pedidos/config/cartoes-online", autenticar, vendasOuFinanceiro, registrarLog("CARTOES_ONLINE", "Configuracao"), pedidos.alternarCartoesOnline);
router.post("/orcamentos", autenticar, exigirPermissao("ORCAMENTOS", "VENDAS"), registrarLog("CRIAR_ORCAMENTO", "Pedido"), pedidos.criarOrcamento);
router.post("/orcamentos/:id/gerar-pedido", autenticar, exigirPermissao("VENDAS"), registrarLog("GERAR_PEDIDO_ORCAMENTO", "Pedido"), pedidos.gerarPedidoDoOrcamento);
router.get("/pedidos/:id/rastreio", autenticar, limitarTaxa({ janelaMs: 60_000, maximo: 30 }), pedidos.rastreio);
router.get("/pedidos/:id/link-acompanhamento", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "COMERCIAL", "EXPEDICAO"), pedidos.linkAcompanhamento);
router.get("/pedidos/:id", autenticar, pedidos.obter);
router.put("/pedidos/:id", autenticar, exigirPermissao("VENDAS"), registrarLog("EDITAR_PEDIDO", "Pedido"), pedidos.editar);
router.put("/pedidos/:id/reabrir", autenticar, exigirPermissao("VENDAS"), registrarLog("REABRIR_PEDIDO", "Pedido"), pedidos.reabrir);
router.post("/pedidos/:id/liberar", autenticar, vendasOuFinanceiro, registrarLog("LIBERAR_PEDIDO", "Pedido"), pedidos.liberar);
router.post("/pedidos/:id/cancelar", autenticar, exigirPermissao("VENDAS"), registrarLog("CANCELAR_PEDIDO", "Pedido"), pedidos.cancelar);
router.put("/pedidos/:id/forma-pagamento", autenticar, vendasOuFinanceiro, registrarLog("ALTERAR_FORMA_PAGAMENTO", "Pedido"), pedidos.alterarFormaPagamento);
router.put("/pedidos/:id/transportadora", autenticar, exigirPermissao("VENDAS", "EXPEDICAO"), registrarLog("ALTERAR_TRANSPORTADORA", "Pedido"), pedidos.alterarTransportadora);
// Diagnóstico da cotação Braspress (estrutura da tela depois do login).
router.get("/frete/braspress/diagnostico", autenticar, exigirPermissao("ADMIN"), async (req, res) => {
  try {
    // ?cep=...&peso=...&valor=... faz uma cotação de teste (CIF, 1 volume 30x30x35).
    if (req.query.cep) {
      return res.json(await cotarBraspressSite({ cepDestino: req.query.cep, documentoDestino: req.query.doc, pesoKg: Number(req.query.peso || 5), valorMercadoria: Number(req.query.valor || 500), caixas: [{ volumes: 1, comprimento: 35, largura: 30, altura: 30 }] }));
    }
    res.json(await diagnosticoBraspress());
  } catch (error) {
    res.status(502).json({ erro: error.message });
  }
});
router.get("/nfe/vinculos-categorias", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "COMERCIAL"), nfeEmissao.vinculosCategorias);
router.put("/nfe/vinculos-categorias", autenticar, exigirPermissao("ADMIN"), registrarLog("VINCULOS_NFE", "Configuracao"), nfeEmissao.salvarVinculos);
router.put("/nfe/produtos/:produtoId/vinculo", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "COMERCIAL"), registrarLog("VINCULO_NFE_PRODUTO", "Produto"), nfeEmissao.fixarVinculo);
router.put("/nfe/valores/:codigo", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "COMERCIAL"), registrarLog("VALOR_MANUAL_NFE", "NFe"), nfeEmissao.valorManual);
router.post("/pedidos/:id/nfe/previa", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "COMERCIAL"), nfeEmissao.previa);
router.post("/pedidos/:id/nfe/danfe", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "COMERCIAL", "EXPEDICAO"), nfeEmissao.danfe);
router.post("/pedidos/:id/nfe/emitir", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "COMERCIAL"), registrarLog("EMITIR_NFE", "Pedido"), nfeEmissao.emitir);
router.put("/pedidos/:id/nota-fiscal", autenticar, exigirPermissao("VENDAS", "EXPEDICAO", "FINANCEIRO"), registrarLog("NOTA_FISCAL_PEDIDO", "Pedido"), pedidos.atualizarNotaFiscal);
router.post("/pedidos/:id/confirmar-pagamento", autenticar, vendasOuFinanceiro, registrarLog("CONFIRMAR_PAGAMENTO", "Pedido"), pedidos.confirmarPagamento);
// Bancos que recebem os pagamentos (escolhidos ao confirmar/quitar).
router.get("/financeiro/bancos", autenticar, vendasOuFinanceiro, bancos.listar);
router.post("/financeiro/bancos", autenticar, vendasOuFinanceiro, registrarLog("CRIAR_BANCO_RECEBEDOR", "Configuracao"), bancos.criar);
router.post("/pedidos/:id/recebimentos", autenticar, vendasOuFinanceiro, registrarLog("REGISTRAR_RECEBIMENTO", "Pedido"), pedidos.registrarRecebimento);
router.put("/pedidos/:id/link-rede", autenticar, vendasOuFinanceiro, registrarLog("LINK_REDE", "Pedido"), pedidos.salvarLinkRede);
router.put("/pedidos/:id/boletos", autenticar, vendasOuFinanceiro, registrarLog("DEFINIR_BOLETOS", "Pedido"), pedidos.definirBoletos);
router.post("/pedidos/:id/parcelas", autenticar, vendasOuFinanceiro, registrarLog("ADICIONAR_PARCELA", "Pedido"), pedidos.adicionarParcela);
router.put("/pedidos/:id/parcelas/:parcelaId", autenticar, vendasOuFinanceiro, registrarLog("ATUALIZAR_PARCELA", "Pedido"), pedidos.atualizarParcela);
router.post("/pedidos/:id/reabrir-financeiro", autenticar, exigirPermissao("FINANCEIRO"), registrarLog("REABRIR_FINANCEIRO", "Pedido"), pedidos.reabrirFinanceiro);

// Time Expedição
const exp = [autenticar, exigirPermissao("EXPEDICAO")];
router.get("/expedicao", ...exp, expedicao.listar);
router.put("/expedicao/:id/itens/:itemId", ...exp, expedicao.marcarItem);
router.put("/expedicao/:id/observacoes", ...exp, expedicao.salvarObservacoes);
router.put("/expedicao/:id/fotos", ...exp, registrarLog("FOTOS_EXPEDICAO", "Pedido"), expedicao.salvarFotos);
router.post("/expedicao/:id/concluir-montagem", ...exp, registrarLog("CONCLUIR_MONTAGEM", "Pedido"), expedicao.concluirMontagem);
router.post("/expedicao/:id/desfazer", ...exp, registrarLog("DESFAZER_CHECKLIST", "Pedido"), expedicao.desfazerChecklist);
router.post("/expedicao/:id/expedir", ...exp, registrarLog("EXPEDIR_PEDIDO", "Pedido"), expedicao.expedir);

// Gerenciar Produtos
const prod = [autenticar, exigirPermissao("PRODUTOS")];
router.get("/produtos/busca", autenticar, exigirInterno, produtos.buscar);
router.get("/produtos/embalagens", autenticar, produtos.tiposEmbalagem);
router.get("/produtos/categorias", autenticar, exigirInterno, produtos.listarCategorias);
router.post("/produtos/categorias", ...prod, produtos.salvarCategoria);
router.put("/produtos/categorias/:id", ...prod, registrarLog("ATUALIZAR_CATEGORIA", "Categoria"), produtos.salvarCategoria);
router.post("/produtos/importar", ...prod, registrarLog("IMPORTAR_PRODUTOS", "Produto"), produtos.importar);
router.get("/produtos", ...prod, produtos.listar);
router.post("/produtos", ...prod, registrarLog("CRIAR_PRODUTO", "Produto"), produtos.criar);
router.get("/produtos/:id", ...prod, produtos.obter);
router.put("/produtos/:id", ...prod, registrarLog("ATUALIZAR_PRODUTO", "Produto"), produtos.atualizar);
router.post("/produtos/:id/estoque", ...prod, registrarLog("AJUSTAR_ESTOQUE", "Produto"), produtos.ajustarEstoque);
router.put("/produtos/:id/arquivar", ...prod, registrarLog("ARQUIVAR_PRODUTO", "Produto"), produtos.arquivar);
router.get("/produtos/:id/historico-precos", ...prod, produtos.historicoPrecos);

// Entradas e parceiros
// Resumo de entradas: abre pela aba Recebimentos também.
const ent = [autenticar, exigirPermissao("ENTRADAS", "RECEBIMENTOS")];
router.get("/parceiros", autenticar, exigirInterno, entradas.listarParceiros);
// Fornecedores também são cadastrados pela aba Recebimentos.
const parc = [autenticar, exigirPermissao("ENTRADAS", "RECEBIMENTOS")];
router.post("/parceiros", ...parc, registrarLog("CRIAR_PARCEIRO", "Parceiro"), entradas.criarParceiro);
router.put("/parceiros/:id", ...parc, registrarLog("ATUALIZAR_PARCEIRO", "Parceiro"), entradas.atualizarParceiro);
router.delete("/parceiros/:id", ...parc, registrarLog("EXCLUIR_PARCEIRO", "Parceiro"), entradas.excluirParceiro);
router.get("/entradas/resumo", ...ent, entradas.resumo);
router.get("/entradas/custos", ...ent, entradas.ultimosCustos);
router.get("/entradas/recebimentos", ...ent, entradas.listarRecebimentos);
router.post("/entradas/recebimentos", ...ent, registrarLog("CRIAR_RECEBIMENTO", "Recebimento"), entradas.criarRecebimento);
router.post("/entradas/recebimentos/:id/estornar", ...ent, registrarLog("ESTORNAR_RECEBIMENTO", "Recebimento"), entradas.estornarRecebimento);

// Recebimentos (pré-recebimento com link do fornecedor, montagem em cápsula)
const rec = [autenticar, exigirPermissao("RECEBIMENTOS")];
router.get("/recebimentos/alertas", ...rec, recebimentos.alertas);
// Login e itens de cada fornecedor (portal do fornecedor).
router.get("/recebimentos/fornecedores/:id/acesso", ...rec, portalFornecedor.obterAcesso);
router.put("/recebimentos/fornecedores/:id/acesso", ...rec, registrarLog("ACESSO_FORNECEDOR", "Parceiro"), portalFornecedor.salvarAcesso);
router.put("/recebimentos/fornecedores/:id/produtos", ...rec, registrarLog("ITENS_FORNECEDOR", "Parceiro"), portalFornecedor.definirProdutos);
router.get("/recebimentos/produtos", ...rec, recebimentos.buscarProdutos);
router.get("/recebimentos/historico", ...rec, recebimentos.historico);
router.get("/recebimentos/montagem", ...rec, recebimentos.montagem);
router.put("/recebimentos/montagem/produtos/:id", ...rec, registrarLog("CONFIGURAR_MONTAGEM", "Produto"), recebimentos.configurarProduto);
router.post("/recebimentos/montagem/produtos/:id/enviar", ...rec, registrarLog("ENVIAR_MONTAGEM", "Produto"), recebimentos.enviarParaMontagem);
router.post("/recebimentos/montagem/produtos/:id/ajustar", ...rec, registrarLog("AJUSTAR_SALDO_MONTAGEM", "Produto"), recebimentos.ajustarSaldo);
router.post("/recebimentos/montagem/ordens/:id/concluir", ...rec, registrarLog("CONCLUIR_MONTAGEM", "OrdemMontagem"), recebimentos.concluirOrdem);
router.post("/recebimentos/montagem/ordens/:id/cancelar", ...rec, registrarLog("CANCELAR_MONTAGEM", "OrdemMontagem"), recebimentos.cancelarOrdem);
router.post("/recebimentos/capsulas", ...rec, registrarLog("CRIAR_CAPSULA", "Produto"), recebimentos.criarCapsula);
router.put("/recebimentos/insumos/:id", ...rec, registrarLog("REGRAS_INSUMO", "Produto"), recebimentos.configurarInsumo);
router.put("/recebimentos/capsulas/:id", ...rec, registrarLog("MARCAR_CAPSULA", "Produto"), recebimentos.marcarCapsula);
router.get("/recebimentos", ...rec, recebimentos.listar);
router.post("/recebimentos", ...rec, registrarLog("CRIAR_PRE_RECEBIMENTO", "PreRecebimento"), recebimentos.criar);
router.get("/recebimentos/:id", ...rec, recebimentos.obter);
router.put("/recebimentos/:id", ...rec, registrarLog("ATUALIZAR_PRE_RECEBIMENTO", "PreRecebimento"), recebimentos.atualizar);
router.post("/recebimentos/:id/link", ...rec, registrarLog("NOVO_LINK_FORNECEDOR", "PreRecebimento"), recebimentos.gerarNovoLink);
router.post("/recebimentos/:id/receber", ...rec, registrarLog("CONFERIR_RECEBIMENTO", "PreRecebimento"), recebimentos.receber);
router.post("/recebimentos/:id/divergencia/resolver", ...rec, registrarLog("RESOLVER_DIVERGENCIA", "PreRecebimento"), recebimentos.resolverDivergencia);
router.post("/recebimentos/:id/cancelar", ...rec, registrarLog("CANCELAR_PRE_RECEBIMENTO", "PreRecebimento"), recebimentos.cancelar);
router.post("/recebimentos/:id/estornar", ...rec, registrarLog("ESTORNAR_PRE_RECEBIMENTO", "PreRecebimento"), recebimentos.estornar);
router.delete("/recebimentos/:id", ...rec, registrarLog("EXCLUIR_PRE_RECEBIMENTO", "PreRecebimento"), recebimentos.excluir);

// Link público do fornecedor (sem login; token no cabeçalho, nunca na URL
// do servidor, e limite de tentativas por IP).
const publicoFornecedor = limitarTaxa({ janelaMs: 60_000, maximo: 30 });
// Portal do fornecedor (login FORNECEDOR: só estas rotas; ver auth.js).
router.get("/portal-fornecedor/dados", autenticar, portalFornecedor.meusDados);
router.get("/portal-fornecedor/pre-recebimentos", autenticar, portalFornecedor.meusPreRecebimentos);
router.post("/portal-fornecedor/pre-recebimentos", autenticar, limitarTaxa({ janelaMs: 60_000, maximo: 20 }), portalFornecedor.criarMeu);
router.put("/portal-fornecedor/pre-recebimentos/:id", autenticar, limitarTaxa({ janelaMs: 60_000, maximo: 30 }), portalFornecedor.responderMeu);
router.get("/publico/pre-recebimento", publicoFornecedor, recebimentos.publicoObter);
router.put("/publico/pre-recebimento", publicoFornecedor, recebimentos.publicoResponder);

// Gerenciar Usuários
const usr = [autenticar, exigirPermissao("USUARIOS")];
router.get("/usuarios/clientes", autenticar, exigirPermissaoOuShowroom("CHECKOUT", "ORCAMENTOS", "VENDAS", "USUARIOS"), usuarios.buscarClientes);
router.get("/usuarios/etiquetas", autenticar, exigirInterno, usuarios.etiquetasUsadas);
router.put("/usuarios/:id/etiquetas", autenticar, exigirPermissao("VENDAS", "COMERCIAL", "USUARIOS", "ORCAMENTOS"), registrarLog("ETIQUETAS_CLIENTE", "Usuario"), usuarios.atualizarEtiquetas);
router.get("/usuarios/:id/historico", autenticar, exigirPermissao("CHECKOUT", "ORCAMENTOS", "VENDAS", "COMERCIAL"), comercial.historicoCliente);
router.get("/usuarios", ...usr, usuarios.listar);
router.post("/usuarios", ...usr, registrarLog("CRIAR_USUARIO", "Usuario"), usuarios.criar);
router.put("/usuarios/:id", ...usr, registrarLog("ATUALIZAR_USUARIO", "Usuario"), usuarios.atualizar);
router.put("/usuarios/:id/senha", ...usr, registrarLog("RESETAR_SENHA", "Usuario"), usuarios.resetarSenha);
router.delete("/usuarios/:id", ...usr, registrarLog("EXCLUIR_USUARIO", "Usuario"), usuarios.excluir);

// Time Financeiro (dashboard)
const fin = [autenticar, exigirPermissao("FINANCEIRO")];
router.get("/dashboard/resumo", ...fin, dashboard.resumo);
router.get("/dashboard/meta", ...fin, dashboard.meta);
router.put("/dashboard/metas", ...fin, registrarLog("SALVAR_METAS", "Configuracao"), dashboard.salvarMetas);
router.get("/dashboard/expedidos", ...fin, dashboard.expedidos);
router.get("/dashboard/boletos", ...fin, dashboard.boletos);
// Cheques recebidos: no caixa, enviados a fornecedores ou devolvidos.
router.get("/cheques", ...fin, cheques.listar);
router.get("/cheques/periodo", ...fin, cheques.periodo);
router.put("/cheques/:id", ...fin, registrarLog("ATUALIZAR_CHEQUE", "Cheque"), cheques.atualizar);
router.put("/cheques/:id/distribuir", ...fin, registrarLog("DIVIDIR_CHEQUES", "Cheque"), cheques.distribuir);
router.post("/cheques/:id/status", ...fin, registrarLog("STATUS_CHEQUE", "Cheque"), cheques.alterarStatus);
router.get("/dashboard/analise", ...fin, dashboard.analise);
router.get("/dashboard/tendencias", ...fin, dashboard.tendencias);
router.get("/dashboard/produtos-ativos", autenticar, exigirPermissao("FINANCEIRO", "PRODUTOS"), dashboard.produtosAtivos);
router.get("/dashboard/estoque", autenticar, exigirPermissao("FINANCEIRO", "PRODUTOS"), dashboard.estoqueResumo);
router.get("/dashboard/movimentacoes", autenticar, exigirPermissao("FINANCEIRO", "PRODUTOS"), dashboard.movimentacoes);
// Setor de compras (Financeiro): recebimentos conferidos → pagamento registrado.
router.get("/compras/opcoes", ...fin, compras.opcoes);
router.get("/compras/pendentes", ...fin, compras.pendentes);
router.get("/compras", ...fin, compras.finalizadas);
router.put("/compras/:id", ...fin, registrarLog("REGISTRAR_COMPRA", "PreRecebimento"), compras.registrar);
router.post("/compras/:id/reabrir", ...fin, registrarLog("REABRIR_COMPRA", "PreRecebimento"), compras.reabrir);
router.get("/dashboard/fila-sob-demanda", autenticar, exigirPermissao("FINANCEIRO", "PRODUTOS", "ENTRADAS"), dashboard.filaSobDemanda);

// Arquivos (imagens e PDFs)
router.post("/arquivos", autenticar, exigirInterno, upload.single("arquivo"), arquivos.enviar);
router.get("/arquivos/:id", arquivos.servir);

// Pagamentos online (banco/gateway configurável)
router.get("/pagamentos/status", pagamentos.status);
router.post("/pagamentos/webhook/:provedor", pagamentos.webhook);
// A Getnet pode notificar por GET (parâmetros na URL).
router.get("/pagamentos/webhook/:provedor", pagamentos.webhook);
router.post("/pagamentos/pedidos/:id/consultar", autenticar, pagamentos.consultar);
router.post("/pagamentos/pedidos/:id/cobranca", autenticar, pagamentos.gerarCobranca);
// Cobrança na maquininha (equipe)
const cobraMaquininha = [autenticar, exigirPermissaoOuShowroom("VENDAS", "FINANCEIRO", "CHECKOUT")];
router.get("/pagamentos/maquininhas", ...cobraMaquininha, pagamentosConfig.maquininhasAtivas);
router.post("/pagamentos/pedidos/:id/maquininha", ...cobraMaquininha, registrarLog("COBRAR_MAQUININHA", "Pedido"), pagamentos.cobrarNaMaquininha);
router.post("/pagamentos/pedidos/:id/maquininha/cancelar", ...cobraMaquininha, registrarLog("CANCELAR_MAQUININHA", "Pedido"), pagamentos.cancelarNaMaquininha);
// Aba Pagamentos (só ADMIN; credenciais nunca saem em texto). Sem
// registrarLog aqui: ele gravaria o corpo com as chaves — o controller
// registra só o que mudou.
const adminPag = [autenticar, pagamentosConfig.soAdmin];
router.get("/pagamentos/config", ...adminPag, pagamentosConfig.obter);
router.put("/pagamentos/config/canais", ...adminPag, pagamentosConfig.salvarCanaisPagamento);
router.put("/pagamentos/config/credenciais/:provedor", ...adminPag, pagamentosConfig.salvarCredenciais);
router.delete("/pagamentos/config/credenciais/:provedor", ...adminPag, pagamentosConfig.removerCredenciais);
router.post("/pagamentos/config/maquininhas", ...adminPag, pagamentosConfig.criarMaquininha);
router.put("/pagamentos/config/maquininhas/:id", ...adminPag, pagamentosConfig.atualizarMaquininha);
router.delete("/pagamentos/config/maquininhas/:id", ...adminPag, pagamentosConfig.removerMaquininha);
router.get("/pagamentos/config/sumup/readers", ...adminPag, pagamentosConfig.readersSumup);
router.post("/pagamentos/config/sumup/parear", ...adminPag, pagamentosConfig.parearSumup);

// Avisos de pedido no WhatsApp (Evolution API). Configuração só do ADMIN;
// o webhook é público, protegido pelo token secreto na URL.
const adminWhats = [autenticar, whatsapp.soAdmin];
router.get("/whatsapp/avisos", ...adminWhats, whatsapp.status);
router.put("/whatsapp/avisos", ...adminWhats, whatsapp.salvar);
router.post("/whatsapp/avisos/conectar", ...adminWhats, registrarLog("CONECTAR_WHATSAPP", "WhatsApp"), whatsapp.conectar);
router.post("/whatsapp/avisos/teste", ...adminWhats, registrarLog("TESTE_WHATSAPP", "WhatsApp"), whatsapp.teste);
router.post("/whatsapp/avisos/mensagens/:id/reenviar", ...adminWhats, registrarLog("REENVIAR_WHATSAPP", "WhatsApp"), whatsapp.reenviar);
router.post("/whatsapp/webhook/:token", whatsapp.webhook);

// Sincronização com o sistema antigo (Krion) — só ADMIN
const adminLegado = [autenticar, legado.soAdmin];
router.get("/sistema-antigo/sincronizacao", ...adminLegado, legado.status);
router.put("/sistema-antigo/sincronizacao", ...adminLegado, legado.salvar);
router.post("/sistema-antigo/sincronizacao/executar", ...adminLegado, legado.executar);

// Comercial (herdado do AgarraMais, agora consultando os pedidos da loja)
const com = [autenticar, exigirPermissao("COMERCIAL")];
router.get("/comercial/pedidos/:numero", ...com, comercial.dadosDoPedido);
router.get("/comercial/alertas-clientes", autenticar, exigirPermissao("VENDAS", "COMERCIAL"), comercial.alertasClientes);
router.post("/comercial/alertas-clientes/:id/visto", autenticar, exigirPermissao("VENDAS", "COMERCIAL"), comercial.marcarAlertaVisto);
router.post("/orcamentos/ia/interpretar", autenticar, exigirPermissao("ORCAMENTOS", "CHECKOUT", "VENDAS"), registrarLog("IA_ORCAMENTO", "Pedido"), comercial.interpretarPedidoIA);
const custo = [autenticar, exigirPermissao("COMERCIAL", "FINANCEIRO", "VENDAS")];
router.get("/custos-extras/categorias", ...custo, custosExtras.categorias);
router.get("/custos-extras", ...custo, custosExtras.listar);
router.post("/custos-extras", ...custo, registrarLog("CRIAR_CUSTO_EXTRA", "PedidoCustoExtra"), custosExtras.criar);
router.delete("/custos-extras/:id", ...custo, registrarLog("EXCLUIR_CUSTO_EXTRA", "PedidoCustoExtra"), custosExtras.excluir);
router.get("/correios/pedidos", ...com, correios.buscarPedidos);
router.get("/correios/pedidos/:id", ...com, correios.detalharPedido);
router.post("/correios/cotacao", ...com, correios.cotar);
router.get("/correios/api/status", ...com, correios.apiStatus);
router.post("/correios/postagens", ...com, registrarLog("CRIAR_POSTAGEM_CORREIOS", "CorreiosPostagem"), correios.criarPostagem);
router.get("/correios/postagens/:id/pdfs", ...com, correios.baixarPdfs);
router.use("/transportadoras", transportadoraRoutes);
router.use("/calculadora-pedidos", calculoPedidoRoutes);
router.use("/calculo-pedido", calculoPedidoRoutes);
router.use("/pedidos-notas-fiscais", pedidoNotaFiscalRoutes);

export default router;
