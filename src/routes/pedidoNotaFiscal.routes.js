import express from "express";
import pedidoNotaFiscalController from "../controllers/pedidoNotaFiscalController.js";
import {
  autenticar,
  exigirPermissao,
  registrarLog,
} from "../middlewares/auth.js";

const router = express.Router();

router.use(autenticar, exigirPermissao("COMERCIAL"));

router.post(
  "/",
  registrarLog("CRIAR_PEDIDO_NOTA_FISCAL", "PedidoNotaFiscal"),
  pedidoNotaFiscalController.criar,
);
router.get("/", pedidoNotaFiscalController.listar);
router.get("/nfemail/notas", pedidoNotaFiscalController.buscarNotasNFeMail);
router.get(
  "/nfemail/detalhe-frete",
  pedidoNotaFiscalController.buscarDetalheFreteNFeMail,
);
router.put(
  "/:id",
  registrarLog("ATUALIZAR_PEDIDO_NOTA_FISCAL", "PedidoNotaFiscal"),
  pedidoNotaFiscalController.atualizar,
);
router.delete(
  "/:id",
  registrarLog("EXCLUIR_PEDIDO_NOTA_FISCAL", "PedidoNotaFiscal"),
  pedidoNotaFiscalController.excluir,
);
router.delete(
  "/",
  registrarLog("EXCLUIR_PEDIDOS_NOTAS_FISCAIS_LOTE", "PedidoNotaFiscal"),
  pedidoNotaFiscalController.excluirEmLote,
);
router.post(
  "/sincronizar-nfemail",
  registrarLog("SINCRONIZAR_NFEMAIL", "PedidoNotaFiscal"),
  pedidoNotaFiscalController.sincronizarNFeMail,
);

export default router;
