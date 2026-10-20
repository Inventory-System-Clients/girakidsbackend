import { fileURLToPath } from "url";
import { sequelize } from "./connection.js";
import "../models/index.js";
import { Usuario } from "../models/index.js";

// Cria/ajusta as tabelas a partir dos models (alter: só adiciona colunas e
// ajusta tipos; não apaga dados) e garante o administrador inicial.
export const sincronizarBanco = async () => {
  await sequelize.sync({ alter: process.env.DB_SYNC_ALTER !== "false" });

  const email = process.env.ADMIN_EMAIL;
  const senha = process.env.ADMIN_PASSWORD;
  if (email && senha) {
    const existente = await Usuario.findOne({ where: { email: email.toLowerCase() } });
    if (!existente) {
      await Usuario.create({
        nome: process.env.ADMIN_NOME || "Administrador",
        email,
        senha,
        role: "ADMIN",
      });
      console.log(`👤 Administrador ${email} criado.`);
    }
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sincronizarBanco()
    .then(() => {
      console.log("✅ Banco sincronizado.");
      return sequelize.close();
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
