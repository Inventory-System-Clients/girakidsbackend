import express from "express";
import {
  analisarComIA,
  atualizarParametros,
  calcular,
  parametros,
} from "../controllers/calculoPedidoController.js";
import {
  autenticar,
  exigirPermissao,
  registrarLog,
} from "../middlewares/auth.js";

const router = express.Router();
const comercial = [autenticar, exigirPermissao("COMERCIAL")];

router.get("/parametros", ...comercial, parametros);
router.put("/parametros", ...comercial, registrarLog("PARAMETROS_CALCULADORA", "Configuracao"), atualizarParametros);
router.post("/calcular", ...comercial, calcular);
router.post("/analisar-ia", ...comercial, registrarLog("ANALISAR_CAIXAS_IA", "CalculadoraPedidos"), analisarComIA);

export default router;
