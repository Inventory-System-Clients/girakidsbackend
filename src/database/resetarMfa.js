// Emergência: zera o 2FA de uma conta (ex.: o único administrador perdeu o
// celular e os códigos de recuperação). Roda no servidor, com acesso ao
// banco — não existe pelo site.
//   npm run mfa:resetar -- email@dominio.com
import dotenv from "dotenv";

dotenv.config();
const { sequelize } = await import("./connection.js");
const { Usuario } = await import("../models/index.js");

const email = String(process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Uso: npm run mfa:resetar -- email@dominio.com");
  process.exit(1);
}
const usuario = await Usuario.findOne({ where: { email } });
if (!usuario) {
  console.error(`Nenhum usuário com o e-mail ${email}.`);
  process.exit(1);
}
await usuario.update({ mfaAtivo: false, mfaSegredo: null, mfaPendente: null, mfaRecuperacao: [], mfaUltimoPasso: null, mfaAtivadoEm: null });
console.log(`2FA de ${email} resetado. As sessões dele caíram; configure de novo no próximo login.`);
await sequelize.close();
