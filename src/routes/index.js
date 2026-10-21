import express from "express";
import multer from "multer";
import {
  autenticar,
  autenticarOpcional,
  exigirInterno,
  exigirPermissao,
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
import * as comercial from "../controllers/comercialController.js";
import * as correios from "../controllers/correiosController.js";
import * as banners from "../controllers/bannerController.js";
import * as custosExtras from "../controllers/custoExtraController.js";
import * as giraldo from "../controllers/giraldoController.js";
import * as transportadoras from "../controllers/transportadoraController.js";
import transportadoraRoutes from "./transportadora.routes.js";
import calculoPedidoRoutes from "./calculoPedido.routes.js";
import pedidoNotaFiscalRoutes from "./pedidoNotaFiscal.routes.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.get("/health", (req, res) => res.json({ status: "ok", servico: "girakids-backend" }));

// Autenticação e perfil
router.post("/auth/login", auth.login);
router.post("/auth/registrar", auth.registrar);
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

// Checkout e pedidos do cliente
router.get("/checkout/opcoes", autenticar, pedidos.opcoesCheckout);
// Equipe tirando pedido com entrega por transportadora
const tiraPedido = [autenticar, exigirPermissao("CHECKOUT", "VENDAS", "ORCAMENTOS", "COMERCIAL")];
router.get("/checkout/transportadoras", ...tiraPedido, transportadoras.sugestoesCheckout);
router.post("/checkout/transportadoras/ia", ...tiraPedido, registrarLog("BUSCAR_TRANSPORTADORAS", "Transportadora"), transportadoras.buscarTransportadoras);
router.post("/checkout/frete", autenticar, pedidos.cotar);
router.post("/pedidos", autenticar, (req, res, next) =>
  req.usuario.role === "CLIENTE" ? next() : exigirPermissao("CHECKOUT", "VENDAS")(req, res, next),
registrarLog("CRIAR_PEDIDO", "Pedido"), pedidos.criar);
router.get("/pedidos/meus", autenticar, pedidos.meusPedidos);
router.get("/pedidos/codigo/:codigo", autenticar, pedidos.obterPorCodigo);

// Time de Vendas / Financeiro
const vendasOuFinanceiro = exigirPermissao("VENDAS", "FINANCEIRO");
router.get("/pedidos", autenticar, exigirPermissao("VENDAS", "FINANCEIRO", "EXPEDICAO"), pedidos.listar);
router.get("/pedidos/contadores", autenticar, exigirInterno, pedidos.contadores);
router.get("/pedidos/alertas-pagamento", autenticar, vendasOuFinanceiro, pedidos.listarAlertasPagamento);
router.put("/pedidos/alertas-pagamento/:alertaId/resolver", autenticar, vendasOuFinanceiro, pedidos.resolverAlertaPagamento);
router.put("/pedidos/config/cartoes-online", autenticar, vendasOuFinanceiro, registrarLog("CARTOES_ONLINE", "Configuracao"), pedidos.alternarCartoesOnline);
router.post("/orcamentos", autenticar, exigirPermissao("ORCAMENTOS", "VENDAS"), registrarLog("CRIAR_ORCAMENTO", "Pedido"), pedidos.criarOrcamento);
router.post("/orcamentos/:id/gerar-pedido", autenticar, exigirPermissao("VENDAS"), registrarLog("GERAR_PEDIDO_ORCAMENTO", "Pedido"), pedidos.gerarPedidoDoOrcamento);
router.get("/pedidos/:id", autenticar, pedidos.obter);
router.put("/pedidos/:id", autenticar, exigirPermissao("VENDAS"), registrarLog("EDITAR_PEDIDO", "Pedido"), pedidos.editar);
router.post("/pedidos/:id/liberar", autenticar, vendasOuFinanceiro, registrarLog("LIBERAR_PEDIDO", "Pedido"), pedidos.liberar);
router.post("/pedidos/:id/cancelar", autenticar, exigirPermissao("VENDAS"), registrarLog("CANCELAR_PEDIDO", "Pedido"), pedidos.cancelar);
router.put("/pedidos/:id/forma-pagamento", autenticar, vendasOuFinanceiro, registrarLog("ALTERAR_FORMA_PAGAMENTO", "Pedido"), pedidos.alterarFormaPagamento);
router.put("/pedidos/:id/transportadora", autenticar, exigirPermissao("VENDAS", "EXPEDICAO"), registrarLog("ALTERAR_TRANSPORTADORA", "Pedido"), pedidos.alterarTransportadora);
router.put("/pedidos/:id/nota-fiscal", autenticar, exigirPermissao("VENDAS", "EXPEDICAO", "FINANCEIRO"), registrarLog("NOTA_FISCAL_PEDIDO", "Pedido"), pedidos.atualizarNotaFiscal);
router.post("/pedidos/:id/confirmar-pagamento", autenticar, vendasOuFinanceiro, registrarLog("CONFIRMAR_PAGAMENTO", "Pedido"), pedidos.confirmarPagamento);
router.post("/pedidos/:id/recebimentos", autenticar, vendasOuFinanceiro, registrarLog("REGISTRAR_RECEBIMENTO", "Pedido"), pedidos.registrarRecebimento);
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
const ent = [autenticar, exigirPermissao("ENTRADAS")];
router.get("/parceiros", autenticar, exigirInterno, entradas.listarParceiros);
router.post("/parceiros", ...ent, registrarLog("CRIAR_PARCEIRO", "Parceiro"), entradas.criarParceiro);
router.put("/parceiros/:id", ...ent, registrarLog("ATUALIZAR_PARCEIRO", "Parceiro"), entradas.atualizarParceiro);
router.get("/entradas/resumo", ...ent, entradas.resumo);
router.get("/entradas/custos", ...ent, entradas.ultimosCustos);
router.get("/entradas/recebimentos", ...ent, entradas.listarRecebimentos);
router.post("/entradas/recebimentos", ...ent, registrarLog("CRIAR_RECEBIMENTO", "Recebimento"), entradas.criarRecebimento);
router.post("/entradas/recebimentos/:id/estornar", ...ent, registrarLog("ESTORNAR_RECEBIMENTO", "Recebimento"), entradas.estornarRecebimento);

// Gerenciar Usuários
const usr = [autenticar, exigirPermissao("USUARIOS")];
router.get("/usuarios/clientes", autenticar, exigirPermissao("CHECKOUT", "ORCAMENTOS", "VENDAS", "USUARIOS"), usuarios.buscarClientes);
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
router.get("/dashboard/analise", ...fin, dashboard.analise);
router.get("/dashboard/produtos-ativos", autenticar, exigirPermissao("FINANCEIRO", "PRODUTOS"), dashboard.produtosAtivos);
router.get("/dashboard/estoque", autenticar, exigirPermissao("FINANCEIRO", "PRODUTOS"), dashboard.estoqueResumo);
router.get("/dashboard/movimentacoes", autenticar, exigirPermissao("FINANCEIRO", "PRODUTOS"), dashboard.movimentacoes);
router.get("/dashboard/fila-sob-demanda", autenticar, exigirPermissao("FINANCEIRO", "PRODUTOS", "ENTRADAS"), dashboard.filaSobDemanda);

// Arquivos (imagens e PDFs)
router.post("/arquivos", autenticar, exigirInterno, upload.single("arquivo"), arquivos.enviar);
router.get("/arquivos/:id", arquivos.servir);

// Pagamentos online (banco/gateway configurável)
router.get("/pagamentos/status", pagamentos.status);
router.post("/pagamentos/webhook/:provedor", pagamentos.webhook);
router.post("/pagamentos/pedidos/:id/consultar", autenticar, pagamentos.consultar);

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
router.post("/correios/postagens", ...com, registrarLog("CRIAR_POSTAGEM_VIPP", "CorreiosPostagem"), correios.criarPostagem);
router.get("/correios/postagens/:id/pdfs", ...com, correios.baixarPdfs);
router.use("/transportadoras", transportadoraRoutes);
router.use("/calculo-pedido", calculoPedidoRoutes);
router.use("/pedidos-notas-fiscais", pedidoNotaFiscalRoutes);

export default router;
