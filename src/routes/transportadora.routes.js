import express from "express";
import {
  atualizarCadastrada,
  buscarTransportadoras,
  criarCadastrada,
  listarCadastradas,
} from "../controllers/transportadoraController.js";
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

// Transportadoras cadastradas: dados que vão na nota fiscal.
const comercial = [autenticar, exigirPermissao("COMERCIAL")];
router.get("/cadastradas", ...comercial, listarCadastradas);
router.post("/cadastradas", ...comercial, registrarLog("CRIAR_PARCEIRO", "Parceiro"), criarCadastrada);
router.put("/cadastradas/:id", ...comercial, registrarLog("ATUALIZAR_PARCEIRO", "Parceiro"), atualizarCadastrada);

export default router;
