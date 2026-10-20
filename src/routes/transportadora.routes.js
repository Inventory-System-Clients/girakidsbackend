import express from "express";
import { buscarTransportadoras } from "../controllers/transportadoraController.js";
import {
  autenticar,
  exigirPermissao,
  registrarLog,
} from "../middlewares/auth.js";

const router = express.Router();

router.post(
  "/buscar",
  autenticar,
  exigirPermissao("COMERCIAL"),
  registrarLog("BUSCAR_TRANSPORTADORAS", "Transportadora"),
  buscarTransportadoras,
);

export default router;
