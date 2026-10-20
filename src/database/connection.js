import { Sequelize } from "sequelize";
import dotenv from "dotenv";

dotenv.config();

// Mesmo fuso usado pelo processo (process.env.TZ em src/server.js): as colunas
// são "timestamp with time zone", mas os filtros por dia do dashboard e da
// meta são calculados em horário de Brasília.
const TIMEZONE_BANCO = "-03:00";

const opcoesComuns = {
  dialect: "postgres",
  timezone: TIMEZONE_BANCO,
  logging: process.env.DB_LOGGING === "true" ? console.log : false,
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
};

// DATABASE_URL (Render/Neon/Supabase) tem prioridade; senão usa as variáveis
// individuais do desenvolvimento local.
export const sequelize = process.env.DATABASE_URL
  ? new Sequelize(process.env.DATABASE_URL, {
      ...opcoesComuns,
      dialectOptions:
        process.env.DB_SSL === "false"
          ? {}
          : { ssl: { require: true, rejectUnauthorized: false } },
    })
  : new Sequelize(
      process.env.DB_NAME || "girakids_db",
      process.env.DB_USER || "postgres",
      process.env.DB_PASSWORD || "postgres",
      {
        ...opcoesComuns,
        host: process.env.DB_HOST || "localhost",
        port: process.env.DB_PORT || 5432,
      },
    );
