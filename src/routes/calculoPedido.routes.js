import express from "express";
import {
  analisarComIA,
  calcular,
} from "../controllers/calculoPedidoController.js";
import {
  autenticar,
  exigirPermissao,
  registrarLog,
} from "../middlewares/auth.js";

const router = express.Router();

router.post(
  "/calcular",
  autenticar,
  exigirPermissao("COMERCIAL"),
  registrarLog("CALCULAR_PEDIDO", "CalculadoraPedidos"),
  calcular,
);

router.post(
  "/analisar-ia",
  autenticar,
  exigirPermissao("COMERCIAL"),
  registrarLog("ANALISAR_CAIXAS_IA", "CalculadoraPedidos"),
  analisarComIA,
);

export default router;
