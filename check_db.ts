import mssql from 'mssql';
import { sqlConfig } from './src/config/mssql';

async function run() {
  try {
    const pool = await mssql.connect(sqlConfig);
    console.log("Connected to MS SQL");

    const cols = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'OutExporter'
      ORDER BY ORDINAL_POSITION;
    `);
    console.log("Columns on OutExporter:", JSON.stringify(cols.recordset, null, 2));

    const sample = await pool.request().query(`SELECT TOP 2 * FROM OutExporter`);
    console.log("Sample rows:", JSON.stringify(sample.recordset, null, 2));

    await pool.close();
  } catch (err) {
    console.error("Error:", err);
  }
}

run();
