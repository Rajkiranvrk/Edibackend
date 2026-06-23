import mssql from 'mssql';
import { connectMssql, initializeMssqlDatabase } from './mssql';

// Helper: Translate SQLite queries to MS SQL Server syntax
const translateQuery = (sql: string): string => {
  let translated = sql;

  // 1. Convert CURRENT_TIMESTAMP to GETDATE()
  translated = translated.replace(/CURRENT_TIMESTAMP/g, 'GETDATE()');

  // 2. Convert LIMIT ? OFFSET ? to OFFSET @p{offset} ROWS FETCH NEXT @p{limit} ROWS ONLY
  // Since SQLite has LIMIT first and OFFSET second, but MS SQL has OFFSET first and FETCH NEXT second,
  // we must swap their parameter indices.
  const limitOffsetRegex = /LIMIT\s+\?\s+OFFSET\s+\?/i;
  if (limitOffsetRegex.test(translated)) {
    const parts = translated.split(limitOffsetRegex);
    const beforePart = parts[0];
    const beforeParamsCount = (beforePart.match(/\?/g) || []).length;
    
    const limitIdx = beforeParamsCount + 1;
    const offsetIdx = beforeParamsCount + 2;
    
    translated = translated.replace(
      limitOffsetRegex, 
      `OFFSET @p${offsetIdx} ROWS FETCH NEXT @p${limitIdx} ROWS ONLY`
    );
  } else if (/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i.test(translated)) {
    const match = translated.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i);
    if (match) {
      translated = translated.replace(
        /LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i, 
        `OFFSET ${match[2]} ROWS FETCH NEXT ${match[1]} ROWS ONLY`
      );
    }
  }

  // 3. Convert remaining parameterized placeholders "?" to MS SQL Server "@p1", "@p2", etc.
  let paramCount = 1;
  let result = '';
  // Loop through and replace only "?" that aren't already mapped
  for (let i = 0; i < translated.length; i++) {
    if (translated[i] === '?') {
      // Find a paramCount index that hasn't been used in OFFSET/FETCH swaps
      // If we swapped limitIdx/offsetIdx, we skip those counts
      const limitOffsetMatch = translated.match(/@p(\d+)/g);
      const usedIndices = limitOffsetMatch ? limitOffsetMatch.map(x => parseInt(x.substring(2), 10)) : [];
      
      while (usedIndices.includes(paramCount)) {
        paramCount++;
      }
      result += `@p${paramCount}`;
      paramCount++;
    } else {
      result += translated[i];
    }
  }
  translated = result;

  return translated;
};

// Helper: Bind parameters with correct MS SQL types
const bindParameters = (request: mssql.Request, params: any[]) => {
  for (let i = 0; i < params.length; i++) {
    const val = params[i];
    const paramName = `p${i + 1}`;
    
    if (Number.isInteger(val)) {
      request.input(paramName, mssql.Int, val);
    } else if (typeof val === 'number') {
      request.input(paramName, mssql.Float, val);
    } else if (typeof val === 'boolean') {
      request.input(paramName, mssql.Bit, val);
    } else {
      request.input(paramName, mssql.VarChar, val);
    }
  }
};

// DB wrapper to run commands and return void
export const dbRun = async (sql: string, params: any[] = []): Promise<void> => {
  const pool = await connectMssql();

  try {
    const translatedSql = translateQuery(sql);

    // If transaction keywords, ignore (handled natively by transaction controllers)
    if (sql.trim().toUpperCase() === 'BEGIN TRANSACTION' || 
        sql.trim().toUpperCase() === 'COMMIT' || 
        sql.trim().toUpperCase() === 'ROLLBACK') {
      return;
    }

    const request = pool.request();
    bindParameters(request, params);

    await request.query(translatedSql);
  } catch (err) {
    console.error(`❌ MS SQL Execute error:`, sql, err);
    throw err;
  }
};

// DB wrapper to return a single row
export const dbGet = async <T>(sql: string, params: any[] = []): Promise<T | undefined> => {
  try {
    const pool = await connectMssql();
    const translatedSql = translateQuery(sql);
    const request = pool.request();

    bindParameters(request, params);

    const result = await request.query(translatedSql);
    return result.recordset[0] as T | undefined;
  } catch (err) {
    console.error(`❌ MS SQL Get error:`, sql, err);
    throw err;
  }
};

// DB wrapper to return all matching rows
export const dbAll = async <T>(sql: string, params: any[] = []): Promise<T[]> => {
  try {
    const pool = await connectMssql();
    const translatedSql = translateQuery(sql);
    const request = pool.request();

    bindParameters(request, params);

    const result = await request.query(translatedSql);
    return result.recordset as T[];
  } catch (err) {
    console.error(`❌ MS SQL All error:`, sql, err);
    throw err;
  }
};

// Initialize database wrapper
export const initializeDatabase = async () => {
  console.log('🔄 Initializing Database with Microsoft SQL Server...');
  await initializeMssqlDatabase();
};

// Export active DB connection pool if callers need it directly
export { connectMssql as db };
