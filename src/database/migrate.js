import { fileURLToPath } from "url";
import { sequelize } from "./connection.js";
import "../models/index.js";
import { Usuario } from "../models/index.js";

// Cria/ajusta as tabelas a partir dos models (alter: só adiciona colunas e
// ajusta tipos; não apaga dados) e garante o administrador inicial.
export const sincronizarBanco = async () => {
  await sequelize.sync({ alter: process.env.DB_SYNC_ALTER !== "false" });

  // Logs de atividade sobrevivem à exclusão do usuário (o sync não remove o
  // NOT NULL antigo sozinho).
  await sequelize.query(`ALTER TABLE logs_atividades ALTER COLUMN "usuarioId" DROP NOT NULL`);

  // Pedidos de antes das várias fotos da expedição.
  await sequelize.query(
    `UPDATE pedidos SET "imagensExpedicao" = jsonb_build_array("imagemExpedicaoUrl") WHERE "imagensExpedicao" = '[]'::jsonb AND "imagemExpedicaoUrl" IS NOT NULL`,
  );

  // Pedidos já expedidos têm a montagem concluída.
  await sequelize.query(
    `UPDATE pedidos SET "montagemConcluidaEm" = "expedidoEm", "montagemConcluidaPor" = "expedidoPor" WHERE "statusExpedicao" = 'EXPEDIDO' AND "montagemConcluidaEm" IS NULL`,
  );

  // Produtos de antes do carrossel: a imagem única vira a primeira do carrossel.
  await sequelize.query(
    `UPDATE produtos SET imagens = jsonb_build_array("imagemUrl") WHERE imagens = '[]'::jsonb AND "imagemUrl" IS NOT NULL`,
  );

  // Usuários sem telefone/documento/endereço (importados da loja antiga)
  // herdam os dados do pedido mais recente deles. Só preenche o que está vazio.
  await sequelize.query(`
    UPDATE usuarios u SET
      telefone = COALESCE(u.telefone, p."clienteTelefone"),
      documento = COALESCE(u.documento, p.documento),
      "documentoTipo" = COALESCE(u."documentoTipo", CAST(p."documentoTipo" AS "enum_usuarios_documentoTipo")),
      cep = COALESCE(u.cep, p.cep),
      rua = COALESCE(u.rua, p.rua),
      numero = COALESCE(u.numero, p."numeroEndereco"),
      complemento = COALESCE(u.complemento, p.complemento),
      bairro = COALESCE(u.bairro, p.bairro),
      cidade = COALESCE(u.cidade, p.cidade),
      estado = COALESCE(u.estado, p.estado)
    FROM (
      SELECT DISTINCT ON ("clienteId") * FROM pedidos
      WHERE "clienteId" IS NOT NULL ORDER BY "clienteId", "createdAt" DESC
    ) p
    WHERE p."clienteId" = u.id
      AND (u.telefone IS NULL OR u.documento IS NULL OR u.cep IS NULL)
  `);

  // Busca rápida de clientes/pedidos por trecho do nome/e-mail (pg_trgm).
  // Se a extensão não puder ser criada, a busca continua funcionando sem índice.
  try {
    await sequelize.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await sequelize.query(`CREATE INDEX IF NOT EXISTS usuarios_nome_trgm ON usuarios USING gin (nome gin_trgm_ops)`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS usuarios_email_trgm ON usuarios USING gin (email gin_trgm_ops)`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS pedidos_cliente_nome_trgm ON pedidos USING gin ("clienteNome" gin_trgm_ops)`);
  } catch (error) {
    console.warn("[migrate] Índices de busca não criados:", error.message);
  }

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
